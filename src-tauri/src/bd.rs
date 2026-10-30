// Base de datos: SOLO Rust la abre y la escribe.
//
// El frontend no recibe acceso a SQL:
//  - bd_leer: una única consulta SELECT, por un pool de solo lectura, y nunca sobre usuarios,
//    clientes ni bitácora (esos datos salen por comandos propios con permisos).
//  - bd_lote: escrituras de catálogo POR NOMBRE (src/db/sentencias.json). El SQL lo pone Rust y
//    el permiso se revisa contra la sesión. Todo el lote va en una transacción BEGIN IMMEDIATE.
// Lo que protege dinero o permisos (ventas, caja, usuarios, clientes, configuración sensible)
// tiene comandos tipados propios en los demás módulos.

use crate::bitacora;
use crate::sesion::Actor;
use crate::util::{e, Res};
use serde::Deserialize;
use serde_json::{Map, Value};
use sqlx::migrate::{Migration, MigrationSource, MigrationType, Migrator};
use sqlx::query::Query;
use sqlx::sqlite::{Sqlite, SqliteArguments, SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Column, Row, SqlitePool, TypeInfo, ValueRef};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

/// Migraciones versionadas. Agregar una = archivo nuevo + versión siguiente (nunca editar una vieja).
/// Mismas versiones y SQL que registraba tauri-plugin-sql en _sqlx_migrations: las bases existentes siguen.
pub const MIGRACIONES: &[(i64, &str, &str)] = &[
    (1, "inicial", include_str!("../../src/db/migraciones/0001_inicial.sql")),
    (2, "datos_personales", include_str!("../../src/db/migraciones/0002_datos_personales.sql")),
    (3, "venta", include_str!("../../src/db/migraciones/0003_venta.sql")),
    (4, "favoritos_iva", include_str!("../../src/db/migraciones/0004_favoritos_iva.sql")),
    (5, "caja_seguridad", include_str!("../../src/db/migraciones/0005_caja_seguridad.sql")),
];

#[derive(Debug)]
struct Lista;

impl MigrationSource<'static> for Lista {
    fn resolve(self) -> futures_core::future::BoxFuture<'static, Result<Vec<Migration>, sqlx::error::BoxDynError>> {
        Box::pin(async move {
            Ok(MIGRACIONES
                .iter()
                .map(|(v, d, sql)| Migration::new(*v, (*d).into(), MigrationType::ReversibleUp, (*sql).into(), false))
                .collect())
        })
    }
}

#[derive(Deserialize, Clone)]
pub struct Sentencia {
    pub sql: String,
    pub permiso: String,
    #[serde(default)]
    pub devuelve: bool,
}

pub struct Bd {
    pub pool: SqlitePool,
    pub lectura: SqlitePool,
    pub dir: Option<PathBuf>,
    pub cifrada: bool,
    registro: HashMap<String, Sentencia>,
}

fn registro() -> HashMap<String, Sentencia> {
    let v: Map<String, Value> = serde_json::from_str(include_str!("../../src/db/sentencias.json")).expect("sentencias.json inválido");
    v.into_iter()
        .filter(|(k, _)| !k.starts_with('_'))
        .map(|(k, s)| (k, serde_json::from_value(s).expect("sentencia inválida")))
        .collect()
}

fn opciones(destino: &str, clave: Option<&[u8; 32]>) -> Res<SqliteConnectOptions> {
    let mut o = SqliteConnectOptions::from_str(destino)
        .map_err(e)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    if let Some(k) = clave {
        // SQLCipher: la clave va como primer PRAGMA de cada conexión (sqlx lo reserva en primer lugar).
        let hex: String = k.iter().map(|b| format!("{b:02x}")).collect();
        o = o.pragma("key", format!("\"x'{hex}'\""));
    }
    Ok(o)
}

/// ¿Es un archivo SQLite sin cifrar? (los cifrados no tienen la cabecera legible)
fn es_texto_plano(ruta: &Path) -> bool {
    std::fs::read(ruta).map(|b| b.starts_with(b"SQLite format 3\0")).unwrap_or(false)
}

impl Bd {
    /// Abre (o crea) la base de la app, la cifra si hace falta y aplica migraciones pendientes.
    pub async fn abrir(dir: &Path, clave: Option<[u8; 32]>) -> Res<Bd> {
        std::fs::create_dir_all(dir).map_err(e)?;
        let ruta = dir.join("pos.db");
        let destino = format!("sqlite:{}", ruta.to_string_lossy());
        if let Some(k) = &clave {
            if ruta.exists() && es_texto_plano(&ruta) {
                cifrar_existente(&ruta, k).await?;
            }
        }
        let opts = opciones(&destino, clave.as_ref())?;
        let pool = SqlitePoolOptions::new().max_connections(4).connect_with(opts.clone()).await.map_err(|err| {
            format!("No se pudo abrir la base de datos ({err}). Si cambió el usuario de Windows, restaure un respaldo.")
        })?;
        let cifrada = clave.is_some() && sqlcipher_activo(&pool).await;
        if clave.is_some() && !cifrada {
            return Err("Esta compilación no trae SQLCipher: la base no se puede cifrar".into());
        }
        integridad(&pool).await?;
        migrar(&pool, Some(dir), &ruta).await?;
        let lectura = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts.read_only(true).pragma("query_only", "ON"))
            .await
            .map_err(e)?;
        Ok(Bd { pool, lectura, dir: Some(dir.to_path_buf()), cifrada, registro: registro() })
    }

    /// Base en memoria con todas las migraciones (pruebas).
    #[cfg(test)]
    pub async fn memoria() -> Res<Bd> {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:").map_err(e)?.foreign_keys(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.map_err(e)?;
        migrar(&pool, None, Path::new("")).await?;
        Ok(Bd { lectura: pool.clone(), pool, dir: None, cifrada: false, registro: registro() })
    }

    /// Una consulta de solo lectura pedida por la pantalla (ver validar_lectura).
    pub async fn leer(&self, sql: &str, params: &[Value]) -> Res<Vec<Map<String, Value>>> {
        validar_lectura(sql)?;
        let mut q = sqlx::query(sql);
        for p in params {
            q = bind(q, p);
        }
        let filas = q.fetch_all(&self.lectura).await.map_err(e)?;
        Ok(filas.iter().map(fila_json).collect())
    }

    /// Escrituras de catálogo por nombre, en una transacción. Devuelve filas afectadas (o filas, si la sentencia devuelve).
    pub async fn lote(&self, actor: &Actor, ops: &[Op]) -> Res<Vec<Value>> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
        let mut out = Vec::with_capacity(ops.len());
        for (i, op) in ops.iter().enumerate() {
            if op.id == "bitacora.registrar" {
                // [usuario (ignorado: se usa el de la sesión), acción, entidad, entidadId, detalle JSON]
                let s = |k: usize| op.params.get(k).and_then(|v| v.as_str()).map(str::to_string);
                let detalle: Value = s(4).and_then(|d| serde_json::from_str(&d).ok()).unwrap_or(Value::Null);
                bitacora::registrar(&mut tx, Some(&actor.id), &s(1).unwrap_or_default(), &s(2).unwrap_or_default(), s(3).as_deref(), &detalle).await?;
                out.push(Value::from(1));
                continue;
            }
            let st = self.registro.get(&op.id).ok_or_else(|| format!("Operación desconocida: {}", op.id))?;
            actor.exigir(&st.permiso, "hacer este cambio")?;
            let mut q = sqlx::query(&st.sql);
            for p in &op.params {
                q = bind(q, p);
            }
            if st.devuelve {
                let filas = q.fetch_all(&mut *tx).await.map_err(|err| format!("Paso {} ({}): {err}", i + 1, op.id))?;
                out.push(Value::Array(filas.iter().map(|f| Value::Object(fila_json(f))).collect()));
            } else {
                let r = q.execute(&mut *tx).await.map_err(|err| format!("Paso {} ({}): {err}", i + 1, op.id))?;
                out.push(Value::from(r.rows_affected()));
            }
        }
        tx.commit().await.map_err(e)?;
        Ok(out)
    }
}

#[derive(Deserialize, Debug)]
pub struct Op {
    pub id: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

async fn sqlcipher_activo(pool: &SqlitePool) -> bool {
    sqlx::query_scalar::<_, String>("PRAGMA cipher_version").fetch_optional(pool).await.ok().flatten().is_some()
}

async fn integridad(pool: &SqlitePool) -> Res<()> {
    let r: String = sqlx::query_scalar("PRAGMA quick_check").fetch_one(pool).await.map_err(e)?;
    if r != "ok" {
        return Err(format!("La base de datos está dañada ({r}). Restaure un respaldo."));
    }
    Ok(())
}

/// Aplica migraciones pendientes; antes, copia la base a respaldos-automaticos.
async fn migrar(pool: &SqlitePool, dir: Option<&Path>, ruta: &Path) -> Res<()> {
    let aplicadas: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    let ultima = MIGRACIONES.last().map(|m| m.0).unwrap_or(0);
    if let Some(d) = dir {
        if aplicadas > 0 && aplicadas < ultima {
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(pool).await.map_err(e)?;
            let carpeta = d.join("respaldos-automaticos");
            std::fs::create_dir_all(&carpeta).map_err(e)?;
            let marca = chrono::Local::now().format("%Y%m%d-%H%M%S");
            std::fs::copy(ruta, carpeta.join(format!("pos-antes-v{}-{marca}.db", aplicadas + 1))).map_err(e)?;
        }
    }
    Migrator::new(Lista).await.map_err(e)?.run(pool).await.map_err(e)?;
    bitacora::encadenar_pendientes(pool).await?;
    Ok(())
}

/// Convierte una base sin cifrar (de versiones anteriores) en una cifrada, con sqlcipher_export.
async fn cifrar_existente(ruta: &Path, clave: &[u8; 32]) -> Res<()> {
    let tmp = ruta.with_extension("cifrando");
    let _ = std::fs::remove_file(&tmp);
    {
        // create_if_missing: el ATTACH hereda los permisos de la conexión y tiene que CREAR el archivo cifrado.
        let opts = SqliteConnectOptions::from_str(&format!("sqlite:{}", ruta.to_string_lossy())).map_err(e)?.create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.map_err(e)?;
        if !sqlcipher_activo(&pool).await {
            return Err("Esta compilación no trae SQLCipher: no se puede cifrar la base".into());
        }
        let hex: String = clave.iter().map(|b| format!("{b:02x}")).collect();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&pool).await.map_err(e)?;
        sqlx::query(&format!("ATTACH DATABASE ? AS cifrada KEY \"x'{hex}'\""))
            .bind(tmp.to_string_lossy().to_string())
            .execute(&pool)
            .await
            .map_err(e)?;
        sqlx::query("SELECT sqlcipher_export('cifrada')").execute(&pool).await.map_err(e)?;
        let v: i64 = sqlx::query_scalar("PRAGMA main.user_version").fetch_one(&pool).await.map_err(e)?;
        sqlx::query(&format!("PRAGMA cifrada.user_version = {v}")).execute(&pool).await.map_err(e)?;
        sqlx::query("DETACH DATABASE cifrada").execute(&pool).await.map_err(e)?;
        pool.close().await;
    }
    // La copia en claro se borra recién cuando la cifrada existe.
    for ext in ["db-wal", "db-shm"] {
        let _ = std::fs::remove_file(ruta.with_extension(ext));
    }
    std::fs::remove_file(ruta).map_err(e)?;
    std::fs::rename(&tmp, ruta).map_err(e)?;
    Ok(())
}

/// Reglas de la lectura que puede pedir la pantalla:
/// una sola sentencia, que empiece con SELECT o WITH, sin tablas sensibles ni comandos peligrosos.
/// Además corre en un pool read_only + query_only, así que aunque esto fallara no podría escribir.
pub fn validar_lectura(sql: &str) -> Res<()> {
    let t = sql.trim().trim_end_matches(';').trim();
    if t.contains(';') {
        return Err("Lectura rechazada: una sola consulta".into());
    }
    let palabras: Vec<String> = t
        .to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    match palabras.first().map(String::as_str) {
        Some("select") | Some("with") => {}
        _ => return Err("Lectura rechazada: solo SELECT".into()),
    }
    const PROHIBIDAS: &[&str] = &[
        "usuarios", "clientes", "bitacora", "pin_hash", "insert", "update", "delete", "drop", "create", "alter", "replace",
        "attach", "detach", "pragma", "vacuum", "load_extension", "sqlite_master", "sqlite_schema", "_sqlx_migrations",
    ];
    if let Some(p) = palabras.iter().find(|w| PROHIBIDAS.contains(&w.as_str())) {
        return Err(format!("Lectura rechazada: «{p}» no está permitido desde la pantalla"));
    }
    Ok(())
}

/// Valor JSON → parámetro SQLite. Enteros como INTEGER; arreglos de bytes como BLOB.
pub fn bind<'q>(q: Query<'q, Sqlite, SqliteArguments<'q>>, v: &Value) -> Query<'q, Sqlite, SqliteArguments<'q>> {
    match v {
        Value::Null => q.bind(None::<String>),
        Value::Bool(b) => q.bind(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => q.bind(i),
            None => q.bind(n.as_f64().unwrap_or_default()),
        },
        Value::String(s) => q.bind(s.clone()),
        Value::Array(a) if a.iter().all(|x| x.as_u64().is_some_and(|n| n <= 255)) => {
            q.bind(a.iter().map(|x| x.as_u64().unwrap_or(0) as u8).collect::<Vec<u8>>())
        }
        otro => q.bind(otro.to_string()),
    }
}

/// Fila → objeto JSON (BLOB como arreglo de números, igual que el plugin anterior).
pub fn fila_json(f: &sqlx::sqlite::SqliteRow) -> Map<String, Value> {
    let mut m = Map::new();
    for (i, c) in f.columns().iter().enumerate() {
        let v = match f.try_get_raw(i) {
            Ok(raw) if raw.is_null() => Value::Null,
            Ok(raw) => match raw.type_info().name() {
                "INTEGER" | "BOOLEAN" => f.try_get::<i64, _>(i).map(Value::from).unwrap_or(Value::Null),
                "REAL" | "NUMERIC" => f.try_get::<f64, _>(i).map(Value::from).unwrap_or(Value::Null),
                "BLOB" => f.try_get::<Vec<u8>, _>(i).map(|b| Value::Array(b.into_iter().map(Value::from).collect())).unwrap_or(Value::Null),
                _ => f.try_get::<String, _>(i).map(Value::from).unwrap_or(Value::Null),
            },
            Err(_) => Value::Null,
        };
        m.insert(c.name().to_string(), v);
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permisos::Rol;

    fn actor(rol: Rol) -> Actor {
        Actor { id: "U".into(), rol, nombre: "x".into() }
    }

    #[test]
    fn lectura_solo_select_y_sin_tablas_sensibles() {
        assert!(validar_lectura("SELECT * FROM productos WHERE id = ?").is_ok());
        assert!(validar_lectura("with x as (select 1) select * from x").is_ok());
        for malo in [
            "DELETE FROM productos",
            "SELECT 1; DROP TABLE ventas",
            "SELECT pin_hash FROM usuarios",
            "SELECT * FROM clientes",
            "SELECT * FROM bitacora",
            "PRAGMA key = 'x'",
            "ATTACH DATABASE 'x' AS y",
            "UPDATE config SET valor = '100' WHERE clave = 'descuento_max_pct'",
            "SELECT * FROM sqlite_master",
        ] {
            assert!(validar_lectura(malo).is_err(), "debió rechazar: {malo}");
        }
    }

    #[tokio::test]
    async fn lote_solo_por_nombre_y_con_permiso() {
        let bd = Bd::memoria().await.unwrap();
        sqlx::query("INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES ('U', 'x', 'cajero', 'x')").execute(&bd.pool).await.unwrap();
        // SQL arbitrario: no existe como operación.
        let r = bd.lote(&actor(Rol::Dueno), &[Op { id: "DELETE FROM ventas".into(), params: vec![] }]).await;
        assert!(r.unwrap_err().contains("desconocida"));
        // Un cajero no puede crear productos aunque llame directo.
        let p = serde_json::json!(["P1", "Lápiz", "lapiz", "00000000000000000000000D01", 350, 1, null, 13, 0, "x", "x"]);
        let op = Op { id: "producto.crear".into(), params: p.as_array().unwrap().clone() };
        assert!(bd.lote(&actor(Rol::Cajero), std::slice::from_ref(&op)).await.unwrap_err().contains("permiso"));
        // El dueño sí, y la bitácora queda con el usuario de la sesión y encadenada.
        let bit = Op { id: "bitacora.registrar".into(), params: serde_json::json!(["OTRO", "producto.crear", "producto", "P1", "{}"]).as_array().unwrap().clone() };
        bd.lote(&actor(Rol::Dueno), &[op, bit]).await.unwrap();
        let u: String = sqlx::query_scalar("SELECT usuario_id FROM bitacora").fetch_one(&bd.pool).await.unwrap();
        assert_eq!(u, "U");
        assert!(crate::bitacora::verificar(&bd.pool).await.unwrap().ok);
    }

    #[tokio::test]
    async fn bitacora_detecta_fila_alterada_y_no_se_edita_por_sql() {
        let bd = Bd::memoria().await.unwrap();
        let mut c = bd.pool.acquire().await.unwrap();
        for i in 0..3 {
            crate::bitacora::registrar(&mut c, None, "prueba", "x", Some(&i.to_string()), &serde_json::json!({"i": i})).await.unwrap();
        }
        drop(c);
        assert!(crate::bitacora::verificar(&bd.pool).await.unwrap().ok);
        // Los triggers impiden editar y borrar.
        assert!(sqlx::query("UPDATE bitacora SET detalle = '{}'").execute(&bd.pool).await.is_err());
        assert!(sqlx::query("DELETE FROM bitacora").execute(&bd.pool).await.is_err());
        // Quien saltara los triggers (borrándolos con acceso al archivo) igual queda en evidencia.
        sqlx::query("DROP TRIGGER bitacora_sin_update").execute(&bd.pool).await.unwrap();
        sqlx::query("UPDATE bitacora SET detalle = '{\"i\":99}' WHERE entidad_id = '1'").execute(&bd.pool).await.unwrap();
        let v = crate::bitacora::verificar(&bd.pool).await.unwrap();
        assert!(!v.ok);
        assert!(v.rota_en.is_some());
    }
}
