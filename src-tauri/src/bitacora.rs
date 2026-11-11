// Bitácora solo-añadir con cadena de hashes.
//
// hash = SHA-256(hash anterior + campos de la fila). Si alguien edita o borra una fila directo
// en el archivo, verificar() encuentra el primer eslabón roto. Los triggers de la migración 5
// impiden UPDATE/DELETE y exigen que cada fila nueva traiga hash (o sea, que venga de aquí).

use crate::util::{ahora_iso, e, ulid, Res};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection, SqlitePool};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[allow(clippy::too_many_arguments)]
fn hash_fila(prev: &str, id: &str, fecha: &str, usuario: &str, accion: &str, entidad: &str, entidad_id: &str, detalle: &str) -> String {
    let mut h = Sha256::new();
    for parte in [prev, id, fecha, usuario, accion, entidad, entidad_id, detalle] {
        h.update(parte.as_bytes());
        h.update([0x1f]); // separador: "ab"+"c" ≠ "a"+"bc"
    }
    hex(&h.finalize())
}

async fn ultimo_hash(c: &mut SqliteConnection) -> Res<String> {
    let h: Option<Option<String>> = sqlx::query_scalar("SELECT hash FROM bitacora WHERE hash IS NOT NULL ORDER BY rowid DESC LIMIT 1")
        .fetch_optional(&mut *c)
        .await
        .map_err(e)?;
    Ok(h.flatten().unwrap_or_default())
}

/// Escribe una entrada dentro de la transacción del cambio que registra.
pub async fn registrar(
    c: &mut SqliteConnection,
    usuario_id: Option<&str>,
    accion: &str,
    entidad: &str,
    entidad_id: Option<&str>,
    detalle: &Value,
) -> Res<()> {
    if accion.is_empty() || accion.len() > 60 || entidad.len() > 60 {
        return Err("Entrada de bitácora inválida".into());
    }
    let prev = ultimo_hash(c).await?;
    let id = ulid();
    let fecha = ahora_iso();
    let det = detalle.to_string();
    let h = hash_fila(&prev, &id, &fecha, usuario_id.unwrap_or(""), accion, entidad, entidad_id.unwrap_or(""), &det);
    sqlx::query(
        "INSERT INTO bitacora (id, fecha, usuario_id, accion, entidad, entidad_id, detalle, hash, hash_anterior) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&fecha)
    .bind(usuario_id)
    .bind(accion)
    .bind(entidad)
    .bind(entidad_id)
    .bind(&det)
    .bind(&h)
    .bind(&prev)
    .execute(&mut *c)
    .await
    .map_err(e)?;
    Ok(())
}

/// Encadena una sola vez las filas anteriores a la migración 5 (las que no tienen hash).
pub async fn encadenar_pendientes(pool: &SqlitePool) -> Res<usize> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let filas = sqlx::query("SELECT rowid AS r, id, fecha, usuario_id, accion, entidad, entidad_id, detalle FROM bitacora WHERE hash IS NULL ORDER BY rowid")
        .fetch_all(&mut *tx)
        .await
        .map_err(e)?;
    if filas.is_empty() {
        return Ok(0);
    }
    let mut prev = ultimo_hash(&mut tx).await?;
    for f in &filas {
        let s = |k: &str| f.try_get::<Option<String>, _>(k).ok().flatten().unwrap_or_default();
        let h = hash_fila(&prev, &s("id"), &s("fecha"), &s("usuario_id"), &s("accion"), &s("entidad"), &s("entidad_id"), &s("detalle"));
        sqlx::query("UPDATE bitacora SET hash = ?, hash_anterior = ? WHERE rowid = ?")
            .bind(&h)
            .bind(&prev)
            .bind(f.get::<i64, _>("r"))
            .execute(&mut *tx)
            .await
            .map_err(e)?;
        prev = h;
    }
    tx.commit().await.map_err(e)?;
    Ok(filas.len())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Verificacion {
    pub ok: bool,
    pub filas: usize,
    /// id de la primera fila cuyo hash no coincide (alterada, borrada o insertada a mano).
    pub rota_en: Option<String>,
}

pub async fn verificar(pool: &SqlitePool) -> Res<Verificacion> {
    let filas = sqlx::query("SELECT id, fecha, usuario_id, accion, entidad, entidad_id, detalle, hash, hash_anterior FROM bitacora ORDER BY rowid")
        .fetch_all(pool)
        .await
        .map_err(e)?;
    let mut prev = String::new();
    for f in &filas {
        let s = |k: &str| f.try_get::<Option<String>, _>(k).ok().flatten().unwrap_or_default();
        let esperado = hash_fila(&prev, &s("id"), &s("fecha"), &s("usuario_id"), &s("accion"), &s("entidad"), &s("entidad_id"), &s("detalle"));
        if s("hash_anterior") != prev || s("hash") != esperado {
            return Ok(Verificacion { ok: false, filas: filas.len(), rota_en: Some(s("id")) });
        }
        prev = esperado;
    }
    Ok(Verificacion { ok: true, filas: filas.len(), rota_en: None })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entrada {
    pub id: String,
    pub fecha: String,
    pub usuario_id: Option<String>,
    pub usuario: Option<String>,
    pub accion: String,
    pub entidad: String,
    pub entidad_id: Option<String>,
    pub detalle: Value,
}

/// `desde`/`hasta`: instantes ISO (UTC) que arma la pantalla con el inicio del día local; `hasta`
/// no se incluye. Así "el 11 de noviembre" son las 24 h de ese día en la hora de la caja.
pub async fn listar(pool: &SqlitePool, limite: i64, entidad: Option<&str>, desde: Option<&str>, hasta: Option<&str>) -> Res<Vec<Entrada>> {
    let mut filtros = vec![];
    if entidad.is_some() {
        filtros.push("b.entidad = ?");
    }
    if desde.is_some() {
        filtros.push("b.fecha >= ?");
    }
    if hasta.is_some() {
        filtros.push("b.fecha < ?");
    }
    let sql = format!(
        "SELECT b.*, u.nombre AS usuario FROM bitacora b LEFT JOIN usuarios u ON u.id = b.usuario_id {} ORDER BY b.rowid DESC LIMIT ?",
        if filtros.is_empty() { String::new() } else { format!("WHERE {}", filtros.join(" AND ")) }
    );
    let mut q = sqlx::query(&sql);
    for v in [entidad, desde, hasta].into_iter().flatten() {
        q = q.bind(v);
    }
    let filas = q.bind(limite.clamp(1, 1000)).fetch_all(pool).await.map_err(e)?;
    Ok(filas
        .iter()
        .map(|f| Entrada {
            id: f.get("id"),
            fecha: f.get("fecha"),
            usuario_id: f.get("usuario_id"),
            usuario: f.get("usuario"),
            accion: f.get("accion"),
            entidad: f.get("entidad"),
            entidad_id: f.get("entidad_id"),
            detalle: serde_json::from_str(&f.get::<String, _>("detalle")).unwrap_or(Value::Null),
        })
        .collect())
}
