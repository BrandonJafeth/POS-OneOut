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
    (6, "sin_50000", include_str!("../../src/db/migraciones/0006_sin_50000.sql")),
    (7, "importacion_web", include_str!("../../src/db/migraciones/0007_importacion_web.sql")),
    (8, "impresoras", include_str!("../../src/db/migraciones/0008_impresoras.sql")),
    (9, "turno_compartido_cierre", include_str!("../../src/db/migraciones/0009_turno_compartido_cierre.sql")),
    (10, "da_vuelto_con_turno", include_str!("../../src/db/migraciones/0010_da_vuelto_con_turno.sql")),
    (11, "inventario", include_str!("../../src/db/migraciones/0011_inventario.sql")),
    (12, "control_por_codigo", include_str!("../../src/db/migraciones/0012_control_por_codigo.sql")),
    (13, "conteo_contado_en", include_str!("../../src/db/migraciones/0013_conteo_contado_en.sql")),
    (14, "descuento_producto", include_str!("../../src/db/migraciones/0014_descuento_producto.sql")),
    (15, "descuento_catalogo_venta", include_str!("../../src/db/migraciones/0015_descuento_catalogo_venta.sql")),
    (16, "telefono_sinpe", include_str!("../../src/db/migraciones/0016_telefono_sinpe.sql")),
    (17, "pagador_sinpe", include_str!("../../src/db/migraciones/0017_pagador_sinpe.sql")),
];

/// El SQL de una migración sin CR. sqlx guarda una suma de cada migración aplicada y se niega a
/// abrir la base si cambia: un build hecho desde un clon con CRLF (git en Windows) no abriría las
/// bases migradas con LF. Normalizado, la suma es la misma venga el archivo como venga.
fn sin_cr(sql: &str) -> std::borrow::Cow<'_, str> {
    if sql.contains('\r') { sql.replace("\r\n", "\n").into() } else { sql.into() }
}

/// Bases migradas cuando un .sql venía en CRLF guardaron la suma del CRLF. Si la guardada es la de
/// la MISMA migración en CRLF, se pasa a la normalizada (sin_cr). Cualquier otra diferencia es un
/// cambio de contenido y sqlx la sigue rechazando.
async fn reparar_sumas(pool: &SqlitePool) -> Res<()> {
    let aplicadas: Vec<(i64, Vec<u8>)> = match sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations").fetch_all(pool).await {
        Ok(f) => f,
        Err(_) => return Ok(()), // base nueva: todavía no hay tabla de migraciones
    };
    let suma = |v: i64, d: &str, sql: String| Migration::new(v, d.to_string().into(), MigrationType::ReversibleUp, sql.into(), false).checksum.into_owned();
    for (v, guardada) in aplicadas {
        let Some((_, d, sql)) = MIGRACIONES.iter().find(|m| m.0 == v) else { continue };
        let lf = sin_cr(sql).into_owned();
        let normal = suma(v, d, lf.clone());
        if guardada != normal && guardada == suma(v, d, lf.replace('\n', "\r\n")) {
            sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?").bind(&normal).bind(v).execute(pool).await.map_err(e)?;
        }
    }
    Ok(())
}

/// Las primeras N migraciones (todas en la app; menos en pruebas, para simular una base vieja).
#[derive(Debug)]
struct Lista(usize);

impl MigrationSource<'static> for Lista {
    fn resolve(self) -> futures_core::future::BoxFuture<'static, Result<Vec<Migration>, sqlx::error::BoxDynError>> {
        Box::pin(async move {
            Ok(MIGRACIONES[..self.0]
                .iter()
                .map(|(v, d, sql)| Migration::new(*v, (*d).into(), MigrationType::ReversibleUp, sin_cr(sql).into_owned().into(), false))
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

pub(crate) fn opciones(destino: &str, clave: Option<&[u8; 32]>) -> Res<SqliteConnectOptions> {
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
    pub async fn leer(&self, actor: &Actor, sql: &str, params: &[Value]) -> Res<Vec<Map<String, Value>>> {
        // Las tablas reales del esquema: una tabla nueva (inventario, apartados…) queda fuera sola.
        let tablas: Vec<String> = sqlx::query_scalar("SELECT lower(name) FROM sqlite_master WHERE type IN ('table', 'view')")
            .fetch_all(&self.lectura)
            .await
            .map_err(e)?;
        if let Err(err) = validar_lectura(sql, &tablas) {
            // Nadie usa SQL a mano desde la pantalla: un rechazo es un error de programa o un intento.
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
            let motivo = err.trim_start_matches(crate::util::TECNICO).to_string();
            bitacora::registrar(&mut tx, Some(&actor.id), "lectura.rechazada", "bd", None, &serde_json::json!({"motivo": motivo})).await?;
            tx.commit().await.map_err(e)?;
            return Err(err);
        }
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
            let st = self.registro.get(&op.id).ok_or_else(|| format!("{}Operación desconocida: {}", crate::util::TECNICO, op.id))?;
            actor.exigir(&st.permiso, "hacer este cambio")?;
            let mut q = sqlx::query(&st.sql);
            for p in &op.params {
                q = bind(q, p);
            }
            if st.devuelve {
                let filas = q.fetch_all(&mut *tx).await.map_err(|err| format!("{}Paso {} ({}): {err}", crate::util::TECNICO, i + 1, op.id))?;
                out.push(Value::Array(filas.iter().map(|f| Value::Object(fila_json(f))).collect()));
            } else {
                let r = q.execute(&mut *tx).await.map_err(|err| format!("{}Paso {} ({}): {err}", crate::util::TECNICO, i + 1, op.id))?;
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

/// Antes de crear la clave o abrir la base: ¿qué había en la carpeta? Primera vez (nada) → se
/// crea todo. Si falta solo la base o solo la clave, NO se crea nada nuevo encima: una base vacía
/// taparía los datos (el cliente seguiría trabajando en ella) y una clave nueva dejaría la base
/// huérfana. Se avisa en palabras simples y se ofrece restaurar.
pub fn revisar_instalacion(dir: &Path, cifrado: bool) -> Res<()> {
    let (base, clave) = (dir.join("pos.db").exists(), dir.join("pos.clave").exists());
    if !base && clave {
        return Err(format!(
            "No se encontró la base de datos (pos.db) en {}, pero esta computadora ya tenía el programa instalado. No se creó una base nueva para no tapar sus datos. Si la base se movió, devuélvala a esa carpeta; si no, use «Restaurar desde respaldo».",
            dir.to_string_lossy()
        ));
    }
    if base && !clave && cifrado {
        return Err(format!(
            "Falta la clave de la base (pos.clave) en {}. Sin ella la base no se puede abrir y no se creó una nueva. Si la tiene, devuélvala a esa carpeta; si no, use «Restaurar desde respaldo».",
            dir.to_string_lossy()
        ));
    }
    Ok(())
}

pub fn ultima_migracion() -> i64 {
    MIGRACIONES.last().map(|m| m.0).unwrap_or(0)
}

/// ¿Hay un turno de caja abierto? (sin la tabla o la columna, de una base muy vieja: no)
pub async fn hay_turno_abierto(pool: &SqlitePool) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM caja_turnos WHERE estado = 'abierto' AND eliminado_en IS NULL")
        .fetch_one(pool)
        .await
        .is_ok_and(|n| n > 0)
}

/// Aplica migraciones pendientes. Con `dir` (la base de la app, al arrancar una versión nueva):
/// no actualiza con la caja abierta y antes copia la base a respaldos-automaticos.
/// Sin `dir`: bases en memoria (pruebas y restauración de respaldos).
pub(crate) async fn migrar(pool: &SqlitePool, dir: Option<&Path>, ruta: &Path) -> Res<()> {
    let aplicadas: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    let ultima = ultima_migracion();
    if aplicadas > ultima {
        return Err(format!(
            "Esta base es de una versión más nueva del programa que la instalada ({}). Instale la versión más nueva o restaure la copia de respaldos-automaticos hecha antes de actualizar.",
            env!("CARGO_PKG_VERSION")
        ));
    }
    if let Some(d) = dir {
        if aplicadas > 0 && aplicadas < ultima {
            if hay_turno_abierto(pool).await {
                return Err("Hay una caja abierta. Para actualizar: vuelva a instalar la versión anterior, cierre la caja y luego instale esta versión.".into());
            }
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(pool).await.map_err(e)?;
            let carpeta = d.join("respaldos-automaticos");
            std::fs::create_dir_all(&carpeta).map_err(e)?;
            let marca = chrono::Local::now().format("%Y%m%d-%H%M%S");
            std::fs::copy(ruta, carpeta.join(format!("pos-antes-v{}-{marca}.db", aplicadas + 1))).map_err(e)?;
        }
    }
    reparar_sumas(pool).await?;
    Migrator::new(Lista(MIGRACIONES.len())).await.map_err(e)?.run(pool).await.map_err(e)?;
    bitacora::encadenar_pendientes(pool).await?;
    Ok(())
}

/// Base en disco como la dejaría una versión vieja del programa (solo las primeras `n` migraciones).
#[cfg(test)]
pub async fn crear_vieja(ruta: &Path, n: usize) -> SqlitePool {
    let o = SqliteConnectOptions::new().filename(ruta).create_if_missing(true).journal_mode(SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new().max_connections(1).connect_with(o).await.unwrap();
    Migrator::new(Lista(n)).await.unwrap().run(&pool).await.unwrap();
    pool
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

/// Lo único que la pantalla puede leer con SQL propio: catálogo y configuración pública.
/// Ventas, caja, clientes, usuarios, bitácora, apartados e inventario: solo por comandos tipados.
pub const LECTURA_PERMITIDA: &[&str] = &["productos", "codigos", "departamentos", "formas_pago", "bancos", "config", "negocio", "cajas"];

/// Reglas de la lectura que puede pedir la pantalla:
/// una sola sentencia, que empiece con SELECT o WITH, sin comandos peligrosos y que solo nombre
/// tablas de LECTURA_PERMITIDA (`tablas`: todas las del esquema; cualquier otra se rechaza).
/// Además corre en un pool read_only + query_only, así que aunque esto fallara no podría escribir.
pub fn validar_lectura(sql: &str, tablas: &[String]) -> Res<()> {
    let t = sql.trim().trim_end_matches(';').trim();
    if t.contains(';') {
        return Err(format!("{}Lectura rechazada: una sola consulta", crate::util::TECNICO));
    }
    let palabras: Vec<String> = t
        .to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    match palabras.first().map(String::as_str) {
        Some("select") | Some("with") => {}
        _ => return Err(format!("{}Lectura rechazada: solo SELECT", crate::util::TECNICO)),
    }
    const PROHIBIDAS: &[&str] = &[
        "insert", "update", "delete", "drop", "create", "alter", "replace", "attach", "detach", "pragma", "vacuum", "reindex", "analyze", "load_extension",
        // Columnas que no deben salir aunque la tabla esté permitida.
        "pin_hash", "nombre_tiquete",
    ];
    // Un identificador SQLite siempre contiene su nombre literal (con o sin comillas), así que
    // revisar palabra por palabra alcanza para saber qué tablas nombra la consulta.
    let rechazo = palabras.iter().find(|w| {
        PROHIBIDAS.contains(&w.as_str())
            || w.starts_with("pragma_") // funciones tabla: pragma_table_info('usuarios')
            || w.starts_with("sqlite_")
            || w.starts_with("_sqlx")
            || (tablas.contains(w) && !LECTURA_PERMITIDA.contains(&w.as_str()))
    });
    if let Some(p) = rechazo {
        return Err(format!("{}Lectura rechazada: «{p}» no está permitido desde la pantalla", crate::util::TECNICO));
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

    /// Una base migrada con los .sql en LF tiene que seguir abriendo con un build hecho desde un
    /// clon con CRLF (git en Windows): si no, la actualización se niega a abrir la base del cliente
    /// ("migration N was previously applied but has been modified").
    #[test]
    fn suma_de_las_migraciones_no_depende_de_los_saltos_de_linea() {
        let lf = sin_cr("CREATE TABLE x (a);\nINSERT INTO x VALUES (1);\n");
        let crlf = sin_cr("CREATE TABLE x (a);\r\nINSERT INTO x VALUES (1);\r\n");
        assert_eq!(lf, crlf);
        let m = |sql: &str| Migration::new(1, "x".into(), MigrationType::ReversibleUp, sin_cr(sql).into_owned().into(), false).checksum;
        assert_eq!(m("a;\nb;\n"), m("a;\r\nb;\r\n"));
        // Las migraciones reales: ninguna tiene CR después de normalizar.
        assert!(MIGRACIONES.iter().all(|(_, _, sql)| !sin_cr(sql).contains('\r')));
    }

    /// Bases ya migradas con un .sql en CRLF (la suma guardada es la del CRLF) siguen abriendo:
    /// la suma se pasa a la normalizada. Un cambio de CONTENIDO sigue rechazándose.
    #[tokio::test]
    async fn bases_migradas_con_crlf_siguen_abriendo_y_un_cambio_real_no() {
        let dir = std::env::temp_dir().join(format!("pos-sumas-{}", crate::util::ulid()));
        std::fs::create_dir_all(&dir).unwrap();
        let ruta = dir.join("pos.db");
        let vieja = crear_vieja(&ruta, MIGRACIONES.len()).await;
        let crlf = sin_cr(MIGRACIONES[0].2).replace('\n', "\r\n");
        let suma_crlf = Migration::new(1, "inicial".into(), MigrationType::ReversibleUp, crlf.into(), false).checksum.into_owned();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = 1").bind(&suma_crlf).execute(&vieja).await.unwrap();
        migrar(&vieja, None, Path::new("")).await.unwrap();
        // Contenido distinto (no solo saltos de línea): sigue siendo un error.
        sqlx::query("UPDATE _sqlx_migrations SET checksum = x'00' WHERE version = 2").execute(&vieja).await.unwrap();
        assert!(migrar(&vieja, None, Path::new("")).await.is_err());
        vieja.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn lectura_solo_select_y_solo_catalogo() {
        let bd = Bd::memoria().await.unwrap();
        sqlx::query("INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES ('U', 'x', 'dueno', 'x')").execute(&bd.pool).await.unwrap();
        // Las consultas que hoy hace la pantalla (src/db) siguen pasando.
        for bien in [
            "SELECT * FROM productos WHERE id = ?",
            "SELECT p.*, d.nombre AS departamento, (SELECT group_concat(c.codigo, ' ') FROM codigos c WHERE c.producto_id = p.id) AS lista_codigos FROM productos p JOIN departamentos d ON d.id = p.departamento_id WHERE p.eliminado_en IS NULL LIMIT ? OFFSET ?",
            "SELECT * FROM formas_pago WHERE eliminado_en IS NULL AND activo = 1 ORDER BY orden, nombre",
            "SELECT * FROM bancos WHERE eliminado_en IS NULL",
            "SELECT clave, valor FROM config ORDER BY clave",
            "SELECT * FROM negocio WHERE id = 1",
            "SELECT * FROM cajas WHERE id = ? AND eliminado_en IS NULL",
            "with x as (select 1) select * from x",
        ] {
            let params: Vec<Value> = (0..bien.matches('?').count()).map(|_| Value::from(1)).collect();
            bd.leer(&actor(Rol::Dueno), bien, &params).await.unwrap_or_else(|err| panic!("{bien}: {err}"));
        }
        for malo in [
            "DELETE FROM productos",
            "SELECT 1; DROP TABLE ventas",
            "SELECT * FROM productos; SELECT * FROM usuarios",
            "INSERT INTO productos (id) VALUES ('x')",
            "SELECT pin_hash FROM usuarios",
            "SELECT * FROM clientes",
            "SELECT * FROM \"Clientes\"",
            "SELECT * FROM main.[usuarios]",
            "SELECT * FROM bitacora",
            "SELECT SUM(total) FROM ventas",
            "SELECT * FROM venta_lineas",
            "SELECT * FROM productos p JOIN ventas v ON 1",
            "SELECT datos FROM ventas_espera",
            "SELECT * FROM caja_turnos",
            "SELECT ultimos4 FROM venta_pagos",
            "SELECT pagador FROM venta_pagos",
            "SELECT * FROM cuentas",
            "SELECT * FROM abonos",
            "SELECT * FROM impresoras",
            "SELECT * FROM pragma_table_info('usuarios')",
            "PRAGMA key = 'x'",
            "ATTACH DATABASE 'x' AS y",
            "UPDATE config SET valor = '100' WHERE clave = 'descuento_max_pct'",
            "SELECT * FROM sqlite_master",
            "SELECT * FROM _sqlx_migrations",
        ] {
            for rol in [Rol::Cajero, Rol::Dueno, Rol::Tecnico] {
                assert!(bd.leer(&actor(rol), malo, &[]).await.is_err(), "debió rechazar: {malo}");
            }
        }
        // Cada rechazo queda en la bitácora (sin el SQL completo).
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'lectura.rechazada'").fetch_one(&bd.pool).await.unwrap();
        assert!(n >= 24 * 3, "{n}");
        // Una tabla nueva cualquiera queda fuera sin tocar la lista.
        sqlx::query("CREATE TABLE tabla_nueva (x)").execute(&bd.pool).await.unwrap();
        assert!(bd.leer(&actor(Rol::Dueno), "SELECT * FROM tabla_nueva", &[]).await.is_err());
    }

    #[tokio::test]
    async fn lote_solo_por_nombre_y_con_permiso() {
        let bd = Bd::memoria().await.unwrap();
        sqlx::query("INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES ('U', 'x', 'cajero', 'x')").execute(&bd.pool).await.unwrap();
        // SQL arbitrario: no existe como operación.
        let r = bd.lote(&actor(Rol::Dueno), &[Op { id: "DELETE FROM ventas".into(), params: vec![] }]).await;
        assert!(r.unwrap_err().contains("desconocida"));
        // Un cajero no puede crear productos aunque llame directo.
        let p = serde_json::json!(["P1", "Lápiz", "lapiz", "00000000000000000000000D01", 350, 1, null, 13, 0, 0, "x", "x"]);
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
