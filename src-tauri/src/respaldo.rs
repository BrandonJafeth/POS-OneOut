// Respaldo cifrado de la base (contiene datos personales: Ley 8968).
//
// Formato del archivo .posbak:
//   "POSBAK01" (8 bytes) | sal (32) | nonce (12) | datos cifrados + etiqueta (AES-256-GCM)
// La clave de 32 bytes (AES-256) sale de la contraseña con Argon2id y la sal aleatoria.
// GCM además autentica: con una contraseña equivocada o un archivo alterado, descifrar falla
// en vez de devolver basura.

use aes_gcm::aead::{Aead, Generate, Key, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::Argon2;

const MAGIA: &[u8; 8] = b"POSBAK01";
const LARGO_SAL: usize = 32;
const LARGO_NONCE: usize = 12;
pub const CONTRASENA_MINIMA: usize = 8;

fn clave(contrasena: &str, sal: &[u8]) -> Result<Key<Aes256Gcm>, String> {
    let mut k = Key::<Aes256Gcm>::default();
    Argon2::default()
        .hash_password_into(contrasena.as_bytes(), sal, &mut k)
        .map_err(|e| format!("No se pudo derivar la clave: {e}"))?;
    Ok(k)
}

pub fn validar_contrasena(contrasena: &str) -> Result<(), String> {
    if contrasena.chars().count() < CONTRASENA_MINIMA {
        return Err(format!("El respaldo necesita una contraseña de al menos {CONTRASENA_MINIMA} caracteres"));
    }
    Ok(())
}

pub fn cifrar(datos: &[u8], contrasena: &str) -> Result<Vec<u8>, String> {
    validar_contrasena(contrasena)?;
    // 32 bytes aleatorios del generador del sistema, usados como sal.
    let sal = Key::<Aes256Gcm>::generate();
    let nonce = Nonce::generate();
    let cifrado = Aes256Gcm::new(&clave(contrasena, &sal)?)
        .encrypt(&nonce, datos)
        .map_err(|_| "No se pudo cifrar el respaldo".to_string())?;
    let mut out = Vec::with_capacity(MAGIA.len() + LARGO_SAL + LARGO_NONCE + cifrado.len());
    out.extend_from_slice(MAGIA);
    out.extend_from_slice(&sal);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&cifrado);
    Ok(out)
}

pub fn descifrar(archivo: &[u8], contrasena: &str) -> Result<Vec<u8>, String> {
    let cab = MAGIA.len() + LARGO_SAL + LARGO_NONCE;
    if archivo.len() < cab || &archivo[..MAGIA.len()] != MAGIA {
        return Err("No es un respaldo del POS".into());
    }
    let sal = &archivo[MAGIA.len()..MAGIA.len() + LARGO_SAL];
    let nonce = Nonce::try_from(&archivo[MAGIA.len() + LARGO_SAL..cab]).map_err(|_| "Respaldo dañado".to_string())?;
    Aes256Gcm::new(&clave(contrasena, sal)?)
        .decrypt(&nonce, &archivo[cab..])
        .map_err(|_| "Contraseña incorrecta o respaldo dañado".into())
}

// ─────────── Crear y restaurar (nunca hay una copia en claro en el disco) ───────────
//
// Crear: la base se copia a una base EN MEMORIA sin cifrar (sqlcipher_export), se serializa a
// bytes con sqlite3_serialize y se cifra con la contraseña. Recién entonces se escribe el archivo.
// Restaurar: se descifra (GCM rechaza archivos alterados), se carga en memoria, se revisa
// integridad y se exporta CIFRADA a pos.db.nuevo; al reiniciar la app reemplaza a pos.db.

use crate::bd::Bd;
use crate::bitacora;
use crate::sesion::Actor;
use crate::usuarios;
use crate::util::{e, Res};
use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{SqliteConnection, SqlitePool};
use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::str::FromStr;

const CABECERA_SQLITE: &[u8] = b"SQLite format 3\0";

fn hex(k: &[u8; 32]) -> String {
    k.iter().map(|b| format!("{b:02x}")).collect()
}

/// Bytes de un esquema adjunto a la conexión (sqlite3_serialize). Todo en memoria.
async fn serializar(c: &mut SqliteConnection, esquema: &str) -> Res<Vec<u8>> {
    let nombre = CString::new(esquema).map_err(e)?;
    let mut h = c.lock_handle().await.map_err(e)?;
    let db = h.as_raw_handle().as_ptr();
    let mut n: i64 = 0;
    // SAFETY: el handle está bloqueado para este hilo; el puntero devuelto se copia y se libera.
    unsafe {
        let p = libsqlite3_sys::sqlite3_serialize(db, nombre.as_ptr(), &mut n, 0);
        if p.is_null() || n <= 0 {
            return Err("No se pudo leer la base para el respaldo".into());
        }
        let v = std::slice::from_raw_parts(p, n as usize).to_vec();
        libsqlite3_sys::sqlite3_free(p as *mut _);
        Ok(v)
    }
}

/// Carga bytes de una base SQLite como "main" de una conexión en memoria (sqlite3_deserialize).
async fn deserializar(c: &mut SqliteConnection, datos: &[u8]) -> Res<()> {
    let nombre = CString::new("main").map_err(e)?;
    let mut h = c.lock_handle().await.map_err(e)?;
    let db = h.as_raw_handle().as_ptr();
    // SAFETY: SQLite toma el búfer (pedido con sqlite3_malloc64) y lo libera al cerrar.
    unsafe {
        let buf = libsqlite3_sys::sqlite3_malloc64(datos.len() as u64) as *mut u8;
        if buf.is_null() {
            return Err("Sin memoria para restaurar".into());
        }
        std::ptr::copy_nonoverlapping(datos.as_ptr(), buf, datos.len());
        let flags = libsqlite3_sys::SQLITE_DESERIALIZE_FREEONCLOSE | libsqlite3_sys::SQLITE_DESERIALIZE_RESIZEABLE;
        let rc = libsqlite3_sys::sqlite3_deserialize(db, nombre.as_ptr(), buf, datos.len() as i64, datos.len() as i64, flags);
        if rc != libsqlite3_sys::SQLITE_OK {
            return Err("El respaldo no es una base válida".into());
        }
    }
    Ok(())
}

/// La base completa como bytes SQLite sin cifrar, solo en memoria.
pub async fn bytes_en_claro(bd: &Bd) -> Res<Vec<u8>> {
    let mut c = bd.pool.acquire().await.map_err(e)?;
    if !bd.cifrada {
        return serializar(&mut c, "main").await;
    }
    sqlx::query("ATTACH DATABASE ':memory:' AS plano KEY ''").execute(&mut *c).await.map_err(e)?;
    let r = async {
        sqlx::query("SELECT sqlcipher_export('plano')").execute(&mut *c).await.map_err(e)?;
        serializar(&mut c, "plano").await
    }
    .await;
    let _ = sqlx::query("DETACH DATABASE plano").execute(&mut *c).await;
    r
}

fn carpeta(bd: &Bd) -> Res<PathBuf> {
    let d = bd.dir.as_ref().ok_or("Sin carpeta de datos")?.join("respaldos");
    std::fs::create_dir_all(&d).map_err(e)?;
    Ok(d)
}

/// Crea el respaldo cifrado en la carpeta de la app. Devuelve la ruta.
pub async fn crear(bd: &Bd, a: &Actor, contrasena: &str) -> Res<String> {
    a.exigir("respaldo", "hacer respaldos")?;
    validar_contrasena(contrasena)?;
    let datos = bytes_en_claro(bd).await?;
    let cifrado = cifrar(&datos, contrasena)?;
    let destino = carpeta(bd)?.join(format!("respaldo-{}.posbak", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    std::fs::write(&destino, cifrado).map_err(e)?;
    let mut tx = bd.pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "respaldo.crear", "respaldo", None, &json!({"bytes": datos.len()})).await?;
    tx.commit().await.map_err(e)?;
    Ok(destino.to_string_lossy().to_string())
}

/// Revisa un respaldo ya descifrado: integridad SQLite y versión de esquema conocida.
async fn revisar(datos: &[u8]) -> Res<SqlitePool> {
    if !datos.starts_with(CABECERA_SQLITE) {
        return Err("El respaldo no es una base válida".into());
    }
    // create_if_missing: el ATTACH/VACUUM INTO del final crea pos.db.nuevo con los permisos de esta conexión.
    let opts = SqliteConnectOptions::from_str("sqlite::memory:").map_err(e)?.create_if_missing(true);
    let pool = SqlitePoolOptions::new().max_connections(1).min_connections(1).idle_timeout(None).max_lifetime(None).connect_with(opts).await.map_err(e)?;
    {
        let mut c = pool.acquire().await.map_err(e)?;
        deserializar(&mut c, datos).await?;
    }
    let r: String = sqlx::query_scalar("PRAGMA integrity_check").fetch_one(&pool).await.map_err(|_| "El respaldo está dañado".to_string())?;
    if r != "ok" {
        return Err("El respaldo está dañado".into());
    }
    let v: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations").fetch_one(&pool).await.map_err(|_| "No es un respaldo del POS".to_string())?;
    if v < 1 || v > crate::bd::MIGRACIONES.last().map(|m| m.0).unwrap_or(0) {
        return Err("El respaldo es de una versión más nueva del programa".into());
    }
    Ok(pool)
}

/// Restaura: deja pos.db.nuevo (cifrado) listo; al reiniciar reemplaza la base actual.
/// Solo el dueño, con su PIN en el momento.
pub async fn restaurar(bd: &Bd, a: &Actor, pin: &str, archivo: &[u8], contrasena: &str, clave: Option<&[u8; 32]>) -> Res<()> {
    a.exigir("respaldo", "restaurar respaldos")?;
    usuarios::confirmar_dueno(&bd.pool, a, pin, "restaurar respaldo").await?;
    if archivo.len() > 2_000_000_000 {
        return Err("Archivo demasiado grande".into());
    }
    let datos = descifrar(archivo, contrasena)?;
    let mem = revisar(&datos).await?;
    let dir = bd.dir.as_ref().ok_or("Sin carpeta de datos")?;
    let nuevo = dir.join("pos.db.nuevo");
    let _ = std::fs::remove_file(&nuevo);
    let destino = nuevo.to_string_lossy().to_string();
    match (bd.cifrada, clave) {
        (true, Some(k)) => {
            sqlx::query(&format!("ATTACH DATABASE ? AS cifrada KEY \"x'{}'\"", hex(k))).bind(&destino).execute(&mem).await.map_err(e)?;
            sqlx::query("SELECT sqlcipher_export('cifrada')").execute(&mem).await.map_err(e)?;
            sqlx::query("DETACH DATABASE cifrada").execute(&mem).await.map_err(e)?;
        }
        (false, _) => {
            // Compilación sin SQLCipher (solo desarrollo): la base de la app tampoco está cifrada.
            sqlx::query("VACUUM INTO ?").bind(&destino).execute(&mem).await.map_err(e)?;
        }
        (true, None) => return Err("Falta la clave de la base".into()),
    }
    mem.close().await;
    let mut tx = bd.pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "respaldo.restaurar", "respaldo", None, &json!({"bytes": datos.len()})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

/// Al arrancar, antes de abrir la base: si hay una restauración pendiente, la activa.
/// La base anterior queda en respaldos-automaticos (cifrada, igual que estaba).
pub fn aplicar_restauracion_pendiente(dir: &Path) -> Res<bool> {
    let nuevo = dir.join("pos.db.nuevo");
    if !nuevo.exists() {
        return Ok(false);
    }
    let actual = dir.join("pos.db");
    if actual.exists() {
        let carpeta = dir.join("respaldos-automaticos");
        std::fs::create_dir_all(&carpeta).map_err(e)?;
        let archivo = carpeta.join(format!("pos-antes-restaurar-{}.db", chrono::Local::now().format("%Y%m%d-%H%M%S")));
        std::fs::rename(&actual, &archivo).map_err(e)?;
        // El WAL va con su base (puede tener lo último que se escribió).
        for ext in ["-wal", "-shm"] {
            let de = PathBuf::from(format!("{}{ext}", actual.to_string_lossy()));
            if de.exists() {
                std::fs::rename(&de, format!("{}{ext}", archivo.to_string_lossy())).map_err(e)?;
            }
        }
    }
    std::fs::rename(&nuevo, &actual).map_err(e)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_contrasena_no_hay_respaldo() {
        assert!(cifrar(b"datos", "").is_err());
        assert!(cifrar(b"datos", "corta").is_err());
    }

    #[test]
    fn ida_y_vuelta() {
        let datos = b"SQLite format 3\0 ... cliente Ana 8888-8888";
        let c = cifrar(datos, "contrasena-larga").unwrap();
        assert!(c.starts_with(MAGIA));
        // El contenido no aparece en claro dentro del archivo.
        assert!(!c.windows(4).any(|w| w == b"8888"));
        assert_eq!(descifrar(&c, "contrasena-larga").unwrap(), datos);
    }

    #[tokio::test]
    async fn respaldo_real_ida_y_vuelta_y_alterado_no_restaura() {
        let bd = Bd::memoria().await.unwrap();
        sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES ('P1', 'Lápiz azul', 'lapiz azul', '00000000000000000000000D01', 350)").execute(&bd.pool).await.unwrap();
        let claro = bytes_en_claro(&bd).await.unwrap();
        assert!(claro.starts_with(CABECERA_SQLITE));
        let archivo = cifrar(&claro, "contrasena-larga").unwrap();
        assert!(!archivo.windows(10).any(|w| w == b"Lapiz azul" || w == "Lápiz az".as_bytes()));
        // Íntegro: se descifra, se carga y tiene el producto.
        let mem = revisar(&descifrar(&archivo, "contrasena-larga").unwrap()).await.unwrap();
        let n: String = sqlx::query_scalar("SELECT nombre FROM productos WHERE id = 'P1'").fetch_one(&mem).await.unwrap();
        assert_eq!(n, "Lápiz azul");
        // Un solo byte cambiado en cualquier parte: no se restaura.
        for pos in [20, archivo.len() / 2, archivo.len() - 1] {
            let mut malo = archivo.clone();
            malo[pos] ^= 0x01;
            assert!(descifrar(&malo, "contrasena-larga").is_err(), "byte {pos}");
        }
        // Bytes que no son una base del POS: rechazados aunque se descifren.
        assert!(revisar(b"SQLite format 3\0basura").await.is_err());
        assert!(revisar(b"no es sqlite").await.is_err());
    }

    #[test]
    fn contrasena_equivocada_o_archivo_alterado() {
        let mut c = cifrar(b"hola mundo", "contrasena-larga").unwrap();
        assert!(descifrar(&c, "otra-contrasena").is_err());
        let ultimo = c.len() - 1;
        c[ultimo] ^= 1;
        assert!(descifrar(&c, "contrasena-larga").is_err());
        assert!(descifrar(b"basura", "contrasena-larga").is_err());
    }
}
