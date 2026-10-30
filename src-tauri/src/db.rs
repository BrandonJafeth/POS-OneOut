// Base de datos: migraciones y un único comando propio (sql_lote).
//
// Las consultas normales las hace el frontend con tauri-plugin-sql (select / execute).
// Problema: el plugin usa un POOL de varias conexiones, así que mandar "BEGIN", luego
// varias sentencias y luego "COMMIT" desde JavaScript no es seguro: cada llamada puede
// caer en una conexión distinta. sql_lote recibe todas las sentencias juntas y las corre
// dentro de UNA transacción en UNA conexión: o se aplican todas, o ninguna.

use serde::Deserialize;
use serde_json::Value;
use sqlx::sqlite::{Sqlite, SqliteArguments};
use sqlx::query::Query;
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool, Migration, MigrationKind};

/// Archivo de la base. El plugin lo resuelve dentro de la carpeta de configuración de la app
/// (en Windows: %APPDATA%\<identifier>\pos.db), nunca dentro de la carpeta del instalador.
pub const DB_URL: &str = "sqlite:pos.db";

/// Migraciones versionadas. El plugin anota en la tabla _sqlx_migrations cuáles ya corrió,
/// así que agregar una nueva = sumar un elemento con version siguiente (nunca editar una vieja).
pub fn migraciones() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "inicial",
            sql: include_str!("../../src/db/migraciones/0001_inicial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "datos_personales",
            sql: include_str!("../../src/db/migraciones/0002_datos_personales.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "venta",
            sql: include_str!("../../src/db/migraciones/0003_venta.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "favoritos_iva",
            sql: include_str!("../../src/db/migraciones/0004_favoritos_iva.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[derive(Deserialize)]
pub struct Sentencia {
    sql: String,
    #[serde(default)]
    params: Vec<Value>,
}

/// Convierte un valor JSON en parámetro de SQLite.
/// A diferencia del plugin (que manda todo número como REAL), los enteros van como INTEGER,
/// y un arreglo de números 0–255 va como BLOB (así se guarda el logo).
fn bind<'q>(q: Query<'q, Sqlite, SqliteArguments<'q>>, v: &Value) -> Query<'q, Sqlite, SqliteArguments<'q>> {
    match v {
        Value::Null => q.bind(None::<String>),
        Value::Bool(b) => q.bind(*b),
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

/// Ejecuta todas las sentencias en una transacción. Devuelve las filas afectadas por cada una.
/// Si una falla, se deshace todo (el `tx` se descarta sin commit = ROLLBACK).
/// BEGIN IMMEDIATE toma el permiso de escritura al empezar: si llegan dos lotes a la vez
/// (p. ej. dos cobros), el segundo espera a que termine el primero en vez de fallar a medias.
/// Así el consecutivo de la caja nunca se repite ni salta.
#[tauri::command]
pub async fn sql_lote(db: State<'_, DbInstances>, sentencias: Vec<Sentencia>) -> Result<Vec<u64>, String> {
    let instancias = db.0.read().await;
    let pool = match instancias.get(DB_URL) {
        Some(DbPool::Sqlite(pool)) => pool,
        _ => return Err("La base de datos no está cargada".into()),
    };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(|e| e.to_string())?;
    let mut filas = Vec::with_capacity(sentencias.len());
    for (i, s) in sentencias.iter().enumerate() {
        let mut q = sqlx::query(&s.sql);
        for v in &s.params {
            q = bind(q, v);
        }
        let r = q
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Sentencia {} de {}: {e}", i + 1, sentencias.len()))?;
        filas.push(r.rows_affected());
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(filas)
}

/// Respaldo cifrado en "Documentos/Respaldos POS/respaldo-<marca>.posbak". Devuelve la ruta.
/// VACUUM INTO saca una copia coherente de la base aunque la app esté en uso; esa copia sin
/// cifrar vive solo un instante en la carpeta de caché de la app y se borra pase lo que pase.
#[tauri::command]
pub async fn respaldo_crear(
    app: tauri::AppHandle,
    db: State<'_, DbInstances>,
    contrasena: String,
    marca: String,
) -> Result<String, String> {
    use tauri::Manager;
    crate::respaldo::validar_contrasena(&contrasena)?;
    if marca.is_empty() || !marca.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err("Marca de tiempo inválida".into());
    }
    let ruta = |r: Result<std::path::PathBuf, tauri::Error>| r.map_err(|e| e.to_string());
    let destino_dir = ruta(app.path().document_dir())?.join("Respaldos POS");
    let cache = ruta(app.path().app_cache_dir())?;
    std::fs::create_dir_all(&destino_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let temporal = cache.join("respaldo-temporal.db");
    let _ = std::fs::remove_file(&temporal); // VACUUM INTO falla si el archivo ya existe

    let datos = {
        let instancias = db.0.read().await;
        let pool = match instancias.get(DB_URL) {
            Some(DbPool::Sqlite(pool)) => pool,
            _ => return Err("La base de datos no está cargada".into()),
        };
        let r = sqlx::query("VACUUM INTO ?").bind(temporal.to_string_lossy().to_string()).execute(pool).await;
        let leido = r.map_err(|e| e.to_string()).and_then(|_| std::fs::read(&temporal).map_err(|e| e.to_string()));
        let _ = std::fs::remove_file(&temporal);
        leido?
    };
    let cifrado = crate::respaldo::cifrar(&datos, &contrasena)?;
    let destino = destino_dir.join(format!("respaldo-{marca}.posbak"));
    std::fs::write(&destino, cifrado).map_err(|e| e.to_string())?;
    Ok(destino.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Row;

    // Comprueba la migración y los tipos de bind con el SQLite real que trae sqlx
    // (las pruebas de TypeScript usan node:sqlite, que es otra compilación de SQLite).
    #[test]
    fn migracion_y_bind() {
        tauri::async_runtime::block_on(async {
            // Una sola conexión: con :memory: cada conexión sería una base distinta.
            let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
            for m in migraciones() {
                sqlx::raw_sql(m.sql).execute(&pool).await.unwrap();
            }

            let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(&pool).await.unwrap();
            assert_eq!(fk, 1, "sqlx activa foreign_keys por defecto");

            let params: Vec<Value> = serde_json::from_str(r#"["P1", "Lápiz", "lapiz", "00000000000000000000000D01", 350, true]"#).unwrap();
            let mut q = sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio, activo) VALUES (?, ?, ?, ?, ?, ?)");
            for v in &params {
                q = bind(q, v);
            }
            q.execute(&pool).await.unwrap();
            let fila = sqlx::query("SELECT typeof(precio) AS t, precio, activo FROM productos").fetch_one(&pool).await.unwrap();
            assert_eq!(fila.get::<String, _>("t"), "integer");
            assert_eq!(fila.get::<i64, _>("precio"), 350);
            assert_eq!(fila.get::<i64, _>("activo"), 1);

            // Arreglo de bytes → BLOB.
            let logo: Value = serde_json::from_str("[255, 0, 128]").unwrap();
            bind(sqlx::query("UPDATE negocio SET logo_bits = ?"), &logo).execute(&pool).await.unwrap();
            let b: Vec<u8> = sqlx::query_scalar("SELECT logo_bits FROM negocio").fetch_one(&pool).await.unwrap();
            assert_eq!(b, vec![255, 0, 128]);

            // Consecutivo con UPDATE … RETURNING (necesita SQLite ≥ 3.35).
            let n: i64 = sqlx::query_scalar(
                "UPDATE cajas SET consecutivo_siguiente = consecutivo_siguiente + 1 RETURNING consecutivo_siguiente - 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(n, 67791);

            // Código sin distinguir mayúsculas.
            sqlx::query("INSERT INTO codigos (codigo, producto_id, tipo) VALUES ('07toc', 'P1', 'manual')").execute(&pool).await.unwrap();
            assert!(sqlx::query("INSERT INTO codigos (codigo, producto_id, tipo) VALUES ('07TOC', 'P1', 'manual')").execute(&pool).await.is_err());
        });
    }
}
