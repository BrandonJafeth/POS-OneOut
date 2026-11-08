// Respaldo cifrado de la base (contiene datos personales: Ley 8968).
//
// Formatos del archivo .posbak (el lector acepta TODOS; un formato nuevo agrega un lector, no
// reemplaza los anteriores):
//   v1 "POSBAK01" | sal (32) | nonce (12) | datos cifrados + etiqueta            (hasta 0.1.0, migración 10)
//   v2 "POSBAK02" | largo (u16 LE) | cabecera JSON | sal (32) | nonce (12) | datos cifrados + etiqueta
//      cabecera = {"app": versión del programa, "migracion": última migración aplicada}. Va en claro
//      (para rechazar un respaldo más nuevo antes de pedir nada) pero autenticada por GCM como AAD:
//      cambiarla hace fallar el descifrado.
// La clave de 32 bytes (AES-256) sale de la contraseña con Argon2id y la sal aleatoria.
// GCM además autentica: con una contraseña equivocada o un archivo alterado, descifrar falla
// en vez de devolver basura.

use aes_gcm::aead::{Aead, Generate, Key, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::Argon2;
use serde::{Deserialize, Serialize};

const MAGIA_V1: &[u8; 8] = b"POSBAK01";
const MAGIA_V2: &[u8; 8] = b"POSBAK02";
const LARGO_SAL: usize = 32;
const LARGO_NONCE: usize = 12;
pub const CONTRASENA_MINIMA: usize = 8;

/// Con qué versión se hizo el respaldo (v2 en adelante; los v1 no la traen).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Cabecera {
    pub app: String,
    pub migracion: i64,
}

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

/// Escribe siempre el formato más nuevo (v2), con la versión del programa y la migración dada.
pub fn cifrar(datos: &[u8], contrasena: &str, migracion: i64) -> Result<Vec<u8>, String> {
    validar_contrasena(contrasena)?;
    let cab = serde_json::to_vec(&Cabecera { app: env!("CARGO_PKG_VERSION").into(), migracion }).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(MAGIA_V2.len() + 2 + cab.len() + LARGO_SAL + LARGO_NONCE + datos.len() + 16);
    out.extend_from_slice(MAGIA_V2);
    out.extend_from_slice(&(cab.len() as u16).to_le_bytes());
    out.extend_from_slice(&cab);
    // 32 bytes aleatorios del generador del sistema, usados como sal.
    let sal = Key::<Aes256Gcm>::generate();
    let nonce = Nonce::generate();
    let cifrado = Aes256Gcm::new(&clave(contrasena, &sal)?)
        .encrypt(&nonce, Payload { msg: datos, aad: &out })
        .map_err(|_| "No se pudo cifrar el respaldo".to_string())?;
    out.extend_from_slice(&sal);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&cifrado);
    Ok(out)
}

/// Dónde termina la parte en claro (magia + cabecera) según el formato, y la cabecera si hay.
fn partes(archivo: &[u8]) -> Result<(usize, Option<Cabecera>), String> {
    match archivo.get(..8) {
        Some(m) if m == MAGIA_V1 => Ok((8, None)),
        Some(m) if m == MAGIA_V2 => {
            let largo = archivo.get(8..10).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize).ok_or("Respaldo dañado")?;
            let cab = archivo.get(10..10 + largo).ok_or("Respaldo dañado")?;
            let cab: Cabecera = serde_json::from_slice(cab).map_err(|_| "Respaldo dañado".to_string())?;
            Ok((10 + largo, Some(cab)))
        }
        _ => Err("No es un respaldo del POS".into()),
    }
}

/// La cabecera, sin contraseña (None: respaldo v1, de antes de que existiera).
pub fn cabecera(archivo: &[u8]) -> Result<Option<Cabecera>, String> {
    partes(archivo).map(|(_, c)| c)
}

pub fn descifrar(archivo: &[u8], contrasena: &str) -> Result<Vec<u8>, String> {
    let (claro, _) = partes(archivo)?;
    let cab = claro + LARGO_SAL + LARGO_NONCE;
    if archivo.len() < cab {
        return Err("No es un respaldo del POS".into());
    }
    let sal = &archivo[claro..claro + LARGO_SAL];
    let nonce = Nonce::try_from(&archivo[claro + LARGO_SAL..cab]).map_err(|_| "Respaldo dañado".to_string())?;
    // v1 no tiene AAD; v2 autentica la magia y la cabecera.
    let aad: &[u8] = if claro == MAGIA_V1.len() { &[] } else { &archivo[..claro] };
    Aes256Gcm::new(&clave(contrasena, sal)?)
        .decrypt(&nonce, Payload { msg: &archivo[cab..], aad })
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
        // Una base en modo WAL (bytes 18-19 = 2) no se puede abrir en memoria: se marca como
        // diario clásico (1), que es lo que significa una vez serializada (sin archivo -wal).
        if datos.len() > 19 && datos[18] == 2 && datos[19] == 2 {
            *buf.add(18) = 1;
            *buf.add(19) = 1;
        }
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
    let migracion: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations").fetch_one(&bd.pool).await.map_err(e)?;
    let cifrado = cifrar(&datos, contrasena, migracion)?;
    let destino = carpeta(bd)?.join(format!("respaldo-{}.posbak", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    std::fs::write(&destino, cifrado).map_err(e)?;
    let mut tx = bd.pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "respaldo.crear", "respaldo", None, &json!({"bytes": datos.len()})).await?;
    tx.commit().await.map_err(e)?;
    Ok(destino.to_string_lossy().to_string())
}

/// Cuándo se hizo el último respaldo cifrado (None: nunca). Para avisar al dueño si pasa mucho tiempo.
pub async fn ultimo(bd: &Bd, a: &Actor) -> Res<Option<String>> {
    a.exigir("respaldo", "ver los respaldos")?;
    sqlx::query_scalar("SELECT MAX(fecha) FROM bitacora WHERE accion = 'respaldo.crear'").fetch_one(&bd.pool).await.map_err(e)
}

/// Mensaje para un respaldo de una versión que esta instalación no conoce.
fn mas_nuevo(app: Option<&str>) -> String {
    let de = app.map(|v| format!(" ({v})")).unwrap_or_default();
    format!(
        "Este respaldo se hizo con una versión más nueva del programa{de} que la instalada ({}). Instale esa versión o una más nueva para restaurarlo.",
        env!("CARGO_PKG_VERSION")
    )
}

/// Revisa un respaldo ya descifrado y lo pone al día, todo en memoria: integridad SQLite, versión
/// de esquema conocida, migraciones que le falten (cada una en su transacción) y, al final, otra vez
/// integridad y la cadena de la bitácora. Si algo falla, devuelve el error y nada se escribió.
/// `ancla`: archivo vacío para abrir la conexión. No puede ser "sqlite::memory:": sqlx la abre con
/// la marca de memoria y SQLite la hereda en el ATTACH, así pos.db.nuevo nunca se escribiría al disco.
/// El ancla no recibe datos (sqlite3_deserialize reemplaza "main" en memoria) y se borra al terminar.
async fn revisar(datos: &[u8], ancla: Option<&Path>) -> Res<SqlitePool> {
    if !datos.starts_with(CABECERA_SQLITE) {
        return Err("El respaldo no es una base válida".into());
    }
    let opts = match ancla {
        Some(p) => SqliteConnectOptions::new().filename(p).create_if_missing(true),
        None => SqliteConnectOptions::from_str("sqlite::memory:").map_err(e)?,
    };
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
    if v < 1 {
        return Err("No es un respaldo del POS".into());
    }
    if v > crate::bd::ultima_migracion() {
        return Err(mas_nuevo(None));
    }
    crate::bd::migrar(&pool, None, Path::new(""))
        .await
        // Detalle técnico marcado: la pantalla muestra el texto claro (respaldo_migracion) y el técnico, el detalle.
        .map_err(|err| format!("{}respaldo_migracion: {err}", crate::util::TECNICO))?;
    let r: String = sqlx::query_scalar("PRAGMA integrity_check").fetch_one(&pool).await.map_err(e)?;
    if r != "ok" {
        return Err("El respaldo quedó dañado al ponerlo al día. La base actual no se tocó.".into());
    }
    if !bitacora::verificar(&pool).await?.ok {
        return Err("La bitácora del respaldo fue alterada: no se restaura. La base actual no se tocó.".into());
    }
    Ok(pool)
}

/// Restaura: deja pos.db.nuevo (cifrado) listo; al reiniciar reemplaza la base actual.
/// Solo el dueño, con su PIN en el momento.
pub async fn restaurar(bd: &Bd, a: &Actor, pin: &str, archivo: &[u8], contrasena: &str, clave: Option<&[u8; 32]>) -> Res<()> {
    a.exigir("respaldo", "restaurar respaldos")?;
    if crate::bd::hay_turno_abierto(&bd.pool).await {
        return Err("Cierre la caja antes de restaurar un respaldo.".into());
    }
    if archivo.len() > 2_000_000_000 {
        return Err("Archivo demasiado grande".into());
    }
    let cab = cabecera(archivo)?;
    if let Some(c) = cab.as_ref().filter(|c| c.migracion > crate::bd::ultima_migracion()) {
        return Err(mas_nuevo(Some(&c.app)));
    }
    usuarios::confirmar_dueno(&bd.pool, a, pin, "restaurar respaldo").await?;
    let datos = match descifrar(archivo, contrasena) {
        Ok(d) => d,
        Err(err) => return Err(anotar_fallo(bd, a, &err, cab.as_ref()).await),
    };
    let ancla = bd.dir.as_ref().ok_or("Sin carpeta de datos")?.join("pos.db.revisando");
    let _ = std::fs::remove_file(&ancla);
    let r = restaurar_en(bd, &datos, &ancla, clave).await;
    borrar_ancla(&ancla);
    if let Err(err) = r {
        return Err(anotar_fallo(bd, a, &err, cab.as_ref()).await);
    }
    let mut tx = bd.pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "respaldo.restaurar", "respaldo", None, &json!({"bytes": datos.len(), "cabecera": cab})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

/// Un intento de restaurar que falló (con el PIN del dueño ya dado) queda en la bitácora: quién,
/// cuándo y por qué. Devuelve el mismo error para la pantalla.
async fn anotar_fallo(bd: &Bd, a: &Actor, err: &str, cab: Option<&Cabecera>) -> String {
    if let Ok(mut tx) = bd.pool.begin_with("BEGIN IMMEDIATE").await {
        let motivo = err.trim_start_matches(crate::util::TECNICO);
        if bitacora::registrar(&mut tx, Some(&a.id), "respaldo.restaurar_fallido", "respaldo", None, &json!({"motivo": motivo, "cabecera": cab})).await.is_ok() {
            let _ = tx.commit().await;
        }
    }
    err.to_string()
}

fn borrar_ancla(ancla: &Path) {
    for ext in ["", "-journal", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", ancla.to_string_lossy()));
    }
}

async fn restaurar_en(bd: &Bd, datos: &[u8], ancla: &Path, clave: Option<&[u8; 32]>) -> Res<()> {
    let mem = revisar(datos, Some(ancla)).await?;
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
    Ok(())
}

/// Renombrar con reintentos: en Windows el antivirus suele tener abierto un archivo recién
/// escrito por unos instantes ("os error 32").
fn renombrar(de: impl AsRef<Path>, a: impl AsRef<Path>) -> Res<()> {
    let mut ultimo = None;
    for _ in 0..20 {
        match std::fs::rename(de.as_ref(), a.as_ref()) {
            Ok(()) => return Ok(()),
            Err(err) => {
                ultimo = Some(err);
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }
    }
    Err(e(ultimo.map(|x| x.to_string()).unwrap_or_default()))
}

/// Al arrancar, antes de abrir la base: si hay una restauración pendiente, la activa.
/// La base anterior queda en respaldos-automaticos (cifrada, igual que estaba).
/// Devuelve Some(archivo donde quedó la base anterior) si se aplicó una restauración.
pub fn aplicar_restauracion_pendiente(dir: &Path) -> Res<Option<String>> {
    let nuevo = dir.join("pos.db.nuevo");
    if !nuevo.exists() {
        return Ok(None);
    }
    let actual = dir.join("pos.db");
    let mut guardada = String::new();
    if actual.exists() {
        let carpeta = dir.join("respaldos-automaticos");
        std::fs::create_dir_all(&carpeta).map_err(e)?;
        let archivo = carpeta.join(format!("pos-antes-restaurar-{}.db", chrono::Local::now().format("%Y%m%d-%H%M%S")));
        renombrar(&actual, &archivo)?;
        guardada = archivo.to_string_lossy().to_string();
        // El WAL va con su base (puede tener lo último que se escribió).
        for ext in ["-wal", "-shm"] {
            let de = PathBuf::from(format!("{}{ext}", actual.to_string_lossy()));
            if de.exists() {
                renombrar(&de, format!("{}{ext}", archivo.to_string_lossy()))?;
            }
        }
    }
    renombrar(&nuevo, &actual)?;
    Ok(Some(guardada))
}

/// Lo que la base reemplazada tenía y el respaldo no: numeración de tiquetes y ventas posteriores.
async fn leer_anterior(ruta: &str, clave: Option<&[u8; 32]>, desde: Option<&str>) -> Res<(Vec<(String, i64)>, i64)> {
    let o = crate::bd::opciones(ruta, clave)?.create_if_missing(false);
    let vieja = SqlitePoolOptions::new().max_connections(1).connect_with(o).await.map_err(e)?;
    let cajas: Vec<(String, i64)> = sqlx::query_as("SELECT id, consecutivo_siguiente FROM cajas").fetch_all(&vieja).await.map_err(e)?;
    let fuera: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ventas WHERE fecha > COALESCE(?, '')").bind(desde).fetch_one(&vieja).await.map_err(e)?;
    vieja.close().await;
    Ok((cajas, fuera))
}

/// La base restaurada no trae rastro de que se restauró (eso quedó en la anterior, que se movió).
/// Se anota aquí: dónde quedó la base reemplazada y cuántas ventas suyas no están en el respaldo.
/// Además la numeración de tiquetes sigue desde la más alta de las dos: si volviera a la del
/// respaldo, las ventas nuevas repetirían números ya entregados a clientes.
pub async fn anotar_restauracion(bd: &Bd, base_anterior: &str, clave: Option<&[u8; 32]>) -> Res<()> {
    let ultima_venta: Option<String> = sqlx::query_scalar("SELECT MAX(fecha) FROM ventas").fetch_one(&bd.pool).await.map_err(e)?;
    let anterior = if base_anterior.is_empty() { Ok((vec![], 0)) } else { leer_anterior(base_anterior, clave, ultima_venta.as_deref()).await };
    let mut tx = bd.pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let mut detalle = json!({"baseAnterior": base_anterior, "ultimaVentaDelRespaldo": ultima_venta});
    match &anterior {
        Ok((cajas, fuera)) => {
            for (id, siguiente) in cajas {
                sqlx::query("UPDATE cajas SET consecutivo_siguiente = MAX(consecutivo_siguiente, ?) WHERE id = ?").bind(siguiente).bind(id).execute(&mut *tx).await.map_err(e)?;
            }
            detalle["ventasQueNoEstanEnElRespaldo"] = json!(fuera);
        }
        Err(err) => detalle["noSePudoLeerLaBaseAnterior"] = json!(err),
    }
    bitacora::registrar(&mut tx, None, "respaldo.restaurado", "respaldo", None, &detalle).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn sin_contrasena_no_hay_respaldo() {
        assert!(cifrar(b"datos", "", 1).is_err());
        assert!(cifrar(b"datos", "corta", 1).is_err());
    }

    #[test]
    fn ida_y_vuelta() {
        let datos = b"SQLite format 3\0 ... cliente Ana 8888-8888";
        let c = cifrar(datos, "contrasena-larga", 10).unwrap();
        assert!(c.starts_with(MAGIA_V2));
        assert_eq!(cabecera(&c).unwrap(), Some(Cabecera { app: env!("CARGO_PKG_VERSION").into(), migracion: 10 }));
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
        let archivo = cifrar(&claro, "contrasena-larga", 1).unwrap();
        assert!(!archivo.windows(10).any(|w| w == b"Lapiz azul" || w == "Lápiz az".as_bytes()));
        // Íntegro: se descifra, se carga y tiene el producto.
        let mem = revisar(&descifrar(&archivo, "contrasena-larga").unwrap(), None).await.unwrap();
        let n: String = sqlx::query_scalar("SELECT nombre FROM productos WHERE id = 'P1'").fetch_one(&mem).await.unwrap();
        assert_eq!(n, "Lápiz azul");
        // Un solo byte cambiado en cualquier parte: no se restaura.
        for pos in [20, archivo.len() / 2, archivo.len() - 1] {
            let mut malo = archivo.clone();
            malo[pos] ^= 0x01;
            assert!(descifrar(&malo, "contrasena-larga").is_err(), "byte {pos}");
        }
        // Bytes que no son una base del POS: rechazados aunque se descifren.
        assert!(revisar(b"SQLite format 3\0basura", None).await.is_err());
        assert!(revisar(b"no es sqlite", None).await.is_err());
    }

    #[test]
    fn cabecera_autenticada_y_formato_v1_se_sigue_leyendo() {
        let c = cifrar(b"hola mundo", "contrasena-larga", 10).unwrap();
        // Cambiar la versión escrita en claro (p. ej. para colar un respaldo "viejo") rompe el descifrado.
        let pos = c.windows(3).position(|w| w == b"10}").unwrap();
        let mut malo = c.clone();
        malo[pos] = b'9';
        assert_eq!(cabecera(&malo).unwrap().unwrap().migracion, 90);
        assert!(descifrar(&malo, "contrasena-larga").is_err());
        // v1 (sin cabecera): se lee igual.
        let sal = [3u8; 32];
        let nonce = Nonce::try_from(&[5u8; 12][..]).unwrap();
        let cif = Aes256Gcm::new(&clave("contrasena-larga", &sal).unwrap()).encrypt(&nonce, &b"hola v1"[..]).unwrap();
        let v1 = [&MAGIA_V1[..], &sal, &[5u8; 12], &cif].concat();
        assert_eq!(cabecera(&v1).unwrap(), None);
        assert_eq!(descifrar(&v1, "contrasena-larga").unwrap(), b"hola v1");
    }

    /// PRUEBA PERMANENTE (no se borra): cada respaldo de tests/fixtures, hecho con una versión
    /// anterior, se restaura con esta versión: se pone al día con las migraciones nuevas y conserva
    /// ventas, turnos, clientes y la bitácora íntegra. Cada versión nueva agrega su fixture.
    #[tokio::test]
    async fn respaldos_de_versiones_anteriores_se_restauran() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let mut n = 0;
        for f in std::fs::read_dir(&dir).unwrap() {
            let ruta = f.unwrap().path();
            if ruta.extension().is_none_or(|x| x != "posbak") {
                continue;
            }
            n += 1;
            let archivo = std::fs::read(&ruta).unwrap();
            let datos = descifrar(&archivo, CONTRASENA_FIXTURE).unwrap_or_else(|err| panic!("{ruta:?}: {err}"));
            let mem = revisar(&datos, None).await.unwrap_or_else(|err| panic!("{ruta:?}: {err}"));
            let v: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations").fetch_one(&mem).await.unwrap();
            assert_eq!(v, crate::bd::ultima_migracion(), "{ruta:?}");
            for (sql, esperado) in [
                ("SELECT COUNT(*) FROM ventas WHERE estado = 'completada'", 2),
                ("SELECT SUM(total) FROM ventas", 3000),
                ("SELECT COUNT(*) FROM venta_pagos", 2),
                ("SELECT COUNT(*) FROM caja_turnos WHERE estado = 'cerrado'", 1),
                ("SELECT COUNT(*) FROM clientes WHERE nombre = 'Cliente Prueba'", 1),
                ("SELECT COUNT(*) FROM ventas WHERE cliente_id IS NOT NULL", 1),
            ] {
                let n: i64 = sqlx::query_scalar(sql).fetch_one(&mem).await.unwrap();
                assert_eq!(n, esperado, "{ruta:?}: {sql}");
            }
            let filas: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora").fetch_one(&mem).await.unwrap();
            assert!(filas > 3, "{ruta:?}");
            assert!(bitacora::verificar(&mem).await.unwrap().ok, "{ruta:?}");
            mem.close().await;
        }
        assert!(n >= 1, "faltan los respaldos de tests/fixtures");
    }

    #[tokio::test]
    async fn respaldo_con_esquema_mas_nuevo_se_rechaza() {
        let bd = Bd::memoria().await.unwrap();
        sqlx::query("INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (9999, 'futura', 1, x'00', 0)").execute(&bd.pool).await.unwrap();
        let claro = bytes_en_claro(&bd).await.unwrap();
        assert!(revisar(&claro, None).await.unwrap_err().contains("más nueva"));
    }

    /// Contraseña de los respaldos de tests/fixtures (datos de prueba, no reales).
    pub const CONTRASENA_FIXTURE: &str = "fixture-pruebas-pos";

    /// Base con datos de prueba de todo lo que un respaldo debe conservar: un turno cerrado con
    /// ventas (efectivo y tarjeta), un cliente con consentimiento y la bitácora encadenada.
    pub async fn base_de_prueba() -> Bd {
        use crate::caja::{abrir, cerrar, tests::conteo, CAJA_1};
        use crate::calculo::{Estado, Linea, PagoEntrada};
        let (bd, _, dueno, cajero) = crate::usuarios::tests::base_con_usuarios().await;
        let p = &bd.pool;
        sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES ('PFIX1', 'Cuaderno de prueba', 'cuaderno de prueba', '00000000000000000000000D01', 1000)").execute(p).await.unwrap();
        sqlx::query("INSERT INTO codigos (codigo, producto_id, tipo) VALUES ('7400000000017', 'PFIX1', 'barras')").execute(p).await.unwrap();
        let cli = crate::clientes::crear(p, &dueno, &crate::clientes::Datos { nombre: "Cliente Prueba".into(), telefono: "8000-0000".into(), ..Default::default() }, true, "1").await.unwrap();
        abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
        for (forma, cant) in [("0000000000000000000000FP01", 2), ("0000000000000000000000FP02", 1)] {
            let l = Linea { id: crate::util::ulid(), producto_id: Some("PFIX1".into()), codigo: None, descripcion: "Cuaderno de prueba".into(), departamento_id: "00000000000000000000000D01".into(), cantidad: cant, precio_unitario: 1000, descuento: 0, tasa_iva: 13.0, exento: false };
            let mut e = Estado { lineas: vec![l], ..Default::default() };
            if cant == 1 {
                e.cliente = serde_json::from_value(json!({"id": cli.id, "nombre": "Cliente Prueba"})).ok();
            }
            let esp = crate::ventas::crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
            let pago = PagoEntrada { forma_pago_id: forma.into(), monto: cant * 1000, banco_id: None, referencia: None, ultimos4: None };
            crate::ventas::cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago]).await.unwrap();
        }
        cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 12)]), "").await.unwrap();
        bd
    }

    /// Genera el respaldo de tests/fixtures con la versión instalada. Se corre a mano UNA vez por
    /// versión (cargo test generar_fixture -- --ignored) y el archivo nuevo se agrega: los viejos
    /// nunca se borran (prueba permanente de que una versión nueva restaura respaldos viejos).
    #[tokio::test]
    #[ignore]
    async fn generar_fixture() {
        let bd = base_de_prueba().await;
        let m: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations").fetch_one(&bd.pool).await.unwrap();
        let archivo = cifrar(&bytes_en_claro(&bd).await.unwrap(), CONTRASENA_FIXTURE, m).unwrap();
        let ruta = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../tests/fixtures/respaldo-v{}-m{m}.posbak", env!("CARGO_PKG_VERSION")));
        std::fs::create_dir_all(ruta.parent().unwrap()).unwrap();
        assert!(!ruta.exists(), "ya existe {ruta:?}: los fixtures no se reemplazan");
        std::fs::write(&ruta, archivo).unwrap();
    }

    #[test]
    fn contrasena_equivocada_o_archivo_alterado() {
        let mut c = cifrar(b"hola mundo", "contrasena-larga", 1).unwrap();
        assert!(descifrar(&c, "otra-contrasena").is_err());
        let ultimo = c.len() - 1;
        c[ultimo] ^= 1;
        assert!(descifrar(&c, "contrasena-larga").is_err());
        assert!(descifrar(b"basura", "contrasena-larga").is_err());
    }
}

/// Restaurar en disco (sin cifrar: corre en cualquier compilación): caja abierta, versión más nueva,
/// archivo alterado. Y el arranque de una versión nueva sobre una base vieja.
#[cfg(test)]
mod tests_restaurar {
    use super::*;
    use crate::caja::{abrir, cerrar, tests::conteo, CAJA_1};
    use crate::permisos::Rol;

    #[tokio::test]
    async fn no_restaura_con_caja_abierta_ni_respaldo_mas_nuevo_ni_alterado() {
        let dir = std::env::temp_dir().join(format!("pos-prueba-{}", crate::util::ulid()));
        let bd = Bd::abrir(&dir, None).await.unwrap();
        let t = usuarios::crear_tecnico_inicial(&bd.pool, "735919").await.unwrap();
        let tec = Actor { id: t.id, rol: Rol::Tecnico, nombre: "T".into() };
        let d = usuarios::crear(&bd.pool, &tec, "Ana", Rol::Dueno, "246813").await.unwrap();
        let dueno = Actor { id: d.id.clone(), rol: Rol::Dueno, nombre: "Ana".into() };
        usuarios::cambiar_pin(&bd.pool, &dueno, &d.id, "246813").await.unwrap();
        let ruta = crear(&bd, &dueno, "contrasena-larga").await.unwrap();
        let archivo = std::fs::read(&ruta).unwrap();
        assert_eq!(cabecera(&archivo).unwrap().unwrap().migracion, crate::bd::ultima_migracion());

        // Caja abierta: no.
        abrir(&bd.pool, &dueno, CAJA_1, &conteo(&[(1000, 1)])).await.unwrap();
        assert!(restaurar(&bd, &dueno, "246813", &archivo, "contrasena-larga", None).await.unwrap_err().contains("Cierre la caja"));
        cerrar(&bd.pool, &dueno, CAJA_1, &conteo(&[(1000, 1)]), "").await.unwrap();

        // Hecho con una versión más nueva: rechazo claro, antes de pedir nada más.
        let futuro = cifrar(&bytes_en_claro(&bd).await.unwrap(), "contrasena-larga", crate::bd::ultima_migracion() + 1).unwrap();
        assert!(restaurar(&bd, &dueno, "246813", &futuro, "contrasena-larga", None).await.unwrap_err().contains("más nueva"));

        // Alterado: falla y la base actual sigue igual (no hay pos.db.nuevo).
        let mut malo = archivo.clone();
        let medio = malo.len() / 2;
        malo[medio] ^= 1;
        assert!(restaurar(&bd, &dueno, "246813", &malo, "contrasena-larga", None).await.is_err());
        assert!(!dir.join("pos.db.nuevo").exists());

        restaurar(&bd, &dueno, "246813", &archivo, "contrasena-larga", None).await.unwrap();
        assert!(dir.join("pos.db.nuevo").exists());
        bd.pool.close().await;
        bd.lectura.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn actualizar_exige_caja_cerrada_y_respalda_antes() {
        let dir = std::env::temp_dir().join(format!("pos-prueba-{}", crate::util::ulid()));
        std::fs::create_dir_all(&dir).unwrap();
        let vieja = crate::bd::crear_vieja(&dir.join("pos.db"), crate::bd::MIGRACIONES.len() - 1).await;
        sqlx::query("PRAGMA foreign_keys = OFF").execute(&vieja).await.unwrap();
        sqlx::query("INSERT INTO caja_turnos (id, sucursal_id, caja_id, usuario_apertura_id, abierto_en, estado) VALUES ('T', 'S', 'C', 'U', '2026-01-01', 'abierto')").execute(&vieja).await.unwrap();
        vieja.close().await;
        let automaticos = dir.join("respaldos-automaticos");

        let err = Bd::abrir(&dir, None).await.err().expect("no debió actualizar");
        assert!(err.contains("caja abierta"), "{err}");
        assert!(!automaticos.exists());

        let vieja = crate::bd::crear_vieja(&dir.join("pos.db"), crate::bd::MIGRACIONES.len() - 1).await;
        sqlx::query("UPDATE caja_turnos SET estado = 'cerrado'").execute(&vieja).await.unwrap();
        vieja.close().await;
        let bd = Bd::abrir(&dir, None).await.unwrap();
        assert_eq!(std::fs::read_dir(&automaticos).unwrap().count(), 1);
        bd.pool.close().await;
        bd.lectura.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// De punta a punta con archivos reales y SQLCipher: base vieja en claro → cifrada; respaldo →
/// restauración (archivo nuevo también cifrado); respaldo alterado o clave equivocada → rechazo.
#[cfg(all(test, feature = "cifrado"))]
mod tests_disco {
    use super::*;
    use crate::permisos::Rol;

    async fn cerrar(bd: Bd) {
        bd.pool.close().await;
        bd.lectura.close().await;
    }

    fn en_claro(p: &Path) -> bool {
        std::fs::read(p).map(|b| b.starts_with(CABECERA_SQLITE)).unwrap_or(false)
    }

    #[tokio::test]
    async fn base_vieja_se_cifra_y_el_respaldo_restaura_cifrado() {
        let dir = std::env::temp_dir().join(format!("pos-prueba-{}", crate::util::ulid()));
        let clave = [7u8; 32];
        // 1. Una base de una versión anterior, sin cifrar, con datos.
        let bd = Bd::abrir(&dir, None).await.unwrap();
        sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES ('P1', 'Lápiz', 'lapiz', '00000000000000000000000D01', 350)").execute(&bd.pool).await.unwrap();
        cerrar(bd).await;
        assert!(en_claro(&dir.join("pos.db")));

        // 2. Al abrir con clave se convierte: el archivo ya no es legible y los datos siguen.
        let bd = Bd::abrir(&dir, Some(clave)).await.unwrap();
        assert!(bd.cifrada);
        assert!(!en_claro(&dir.join("pos.db")));
        let n: String = sqlx::query_scalar("SELECT nombre FROM productos WHERE id = 'P1'").fetch_one(&bd.pool).await.unwrap();
        assert_eq!(n, "Lápiz");

        // 3. Respaldo y restauración: el archivo restaurado también queda cifrado.
        let t = usuarios::crear_tecnico_inicial(&bd.pool, "735919").await.unwrap();
        let tec = Actor { id: t.id, rol: Rol::Tecnico, nombre: "T".into() };
        let d = usuarios::crear(&bd.pool, &tec, "Ana", Rol::Dueno, "246813").await.unwrap();
        let dueno = Actor { id: d.id.clone(), rol: Rol::Dueno, nombre: "Ana".into() };
        usuarios::cambiar_pin(&bd.pool, &dueno, &d.id, "246813").await.unwrap();
        let ruta = crear(&bd, &dueno, "contrasena-larga").await.unwrap();
        let archivo = std::fs::read(&ruta).unwrap();
        // Después del respaldo se siguieron emitiendo tiquetes (1000 más).
        let en_respaldo: i64 = sqlx::query_scalar("SELECT MIN(consecutivo_siguiente) FROM cajas").fetch_one(&bd.pool).await.unwrap();
        sqlx::query("UPDATE cajas SET consecutivo_siguiente = consecutivo_siguiente + 1000").execute(&bd.pool).await.unwrap();
        assert!(!archivo.windows(5).any(|w| w == &"Lápiz".as_bytes()[..5]));
        let mut malo = archivo.clone();
        let medio = malo.len() / 2;
        malo[medio] ^= 1;
        assert!(restaurar(&bd, &dueno, "246813", &malo, "contrasena-larga", Some(&clave)).await.is_err());
        assert!(restaurar(&bd, &dueno, "000000", &archivo, "contrasena-larga", Some(&clave)).await.is_err());
        assert!(!dir.join("pos.db.nuevo").exists());
        restaurar(&bd, &dueno, "246813", &archivo, "contrasena-larga", Some(&clave)).await.unwrap();
        assert!(dir.join("pos.db.nuevo").exists());
        assert!(!en_claro(&dir.join("pos.db.nuevo")));
        cerrar(bd).await;

        // 4. Al reiniciar se activa la restauración y abre con la misma clave.
        let anterior = aplicar_restauracion_pendiente(&dir).unwrap().expect("se aplicó");
        assert!(anterior.contains("pos-antes-restaurar-") && Path::new(&anterior).exists());
        let bd = Bd::abrir(&dir, Some(clave)).await.unwrap();
        // La base restaurada dice que lo es y dónde quedó la reemplazada.
        anotar_restauracion(&bd, &anterior, Some(&clave)).await.unwrap();
        let d: String = sqlx::query_scalar("SELECT detalle FROM bitacora WHERE accion = 'respaldo.restaurado'").fetch_one(&bd.pool).await.unwrap();
        assert!(d.contains("pos-antes-restaurar-") && d.contains("ventasQueNoEstanEnElRespaldo"), "{d}");
        // La numeración no vuelve atrás: no se repiten tiquetes ya entregados.
        let sig: i64 = sqlx::query_scalar("SELECT MIN(consecutivo_siguiente) FROM cajas").fetch_one(&bd.pool).await.unwrap();
        assert_eq!(sig, en_respaldo + 1000);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM productos WHERE id = 'P1'").fetch_one(&bd.pool).await.unwrap();
        assert_eq!(n, 1);
        cerrar(bd).await;

        // 5. Con otra clave (otro usuario de Windows / otra máquina) no abre.
        assert!(Bd::abrir(&dir, Some([9u8; 32])).await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
