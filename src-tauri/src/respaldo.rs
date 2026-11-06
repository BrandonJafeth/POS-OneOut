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

/// Cuándo se hizo el último respaldo cifrado (None: nunca). Para avisar al dueño si pasa mucho tiempo.
pub async fn ultimo(bd: &Bd, a: &Actor) -> Res<Option<String>> {
    a.exigir("respaldo", "ver los respaldos")?;
    sqlx::query_scalar("SELECT MAX(fecha) FROM bitacora WHERE accion = 'respaldo.crear'").fetch_one(&bd.pool).await.map_err(e)
}

/// Revisa un respaldo ya descifrado: integridad SQLite y versión de esquema conocida.
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
    let ancla = bd.dir.as_ref().ok_or("Sin carpeta de datos")?.join("pos.db.revisando");
    let _ = std::fs::remove_file(&ancla);
    let r = restaurar_en(bd, &datos, &ancla, clave).await;
    borrar_ancla(&ancla);
    r?;
    let mut tx = bd.pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "respaldo.restaurar", "respaldo", None, &json!({"bytes": datos.len()})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
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
    fn contrasena_equivocada_o_archivo_alterado() {
        let mut c = cifrar(b"hola mundo", "contrasena-larga").unwrap();
        assert!(descifrar(&c, "otra-contrasena").is_err());
        let ultimo = c.len() - 1;
        c[ultimo] ^= 1;
        assert!(descifrar(&c, "contrasena-larga").is_err());
        assert!(descifrar(b"basura", "contrasena-larga").is_err());
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
