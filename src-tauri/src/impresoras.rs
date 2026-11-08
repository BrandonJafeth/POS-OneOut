// Impresoras configurables: cada una con su conexión (Windows, serial o USB), ancho, code page,
// cortador y gaveta; y a cuál va cada documento (tiquete, cierre y reportes, comprobantes de
// movimiento, etiquetas). Las administran el dueño y el técnico (permiso "impresoras").
//
// Reglas (las decide Rust):
// - El destino se elige de lo que detecta el sistema operativo; no se aceptan rutas escritas a mano.
// - Todo lo que se imprime pasa antes por escpos::validar (lista blanca, sin pulso de gaveta).
// - La gaveta está en UNA sola impresora (índice único) y solo se abre con gaveta.rs.
// - Si una impresora no responde, el error se dice en palabras simples y lo demás sigue
//   (la venta ya quedó guardada antes de imprimir).

use crate::bitacora;
use crate::escpos;
use crate::printer;
use crate::sesion::Actor;
use crate::util::{ahora_iso, e, texto, ulid, Res};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Row, SqliteConnection, SqlitePool};

pub const DOCUMENTOS: &[&str] = &["tiquete", "cierre", "movimiento", "etiqueta"];
const BAUDIOS: &[i64] = &[2400, 4800, 9600, 19200, 38400, 57600, 115200];

pub fn nombre_documento(d: &str) -> &'static str {
    match d {
        "tiquete" => "tiquetes de venta",
        "cierre" => "cierres y reportes",
        "movimiento" => "comprobantes de movimiento",
        "etiqueta" => "etiquetas",
        _ => "este documento",
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Impresora {
    pub id: String,
    pub nombre: String,
    pub conexion: String,
    pub destino: String,
    pub ancho_mm: i64,
    pub columnas: i64,
    pub code_page: i64,
    pub sin_modo_chino: bool,
    pub barras: String,
    pub cortador: bool,
    pub gaveta: bool,
    pub baudios: i64,
    /// Documentos asignados a esta impresora.
    pub documentos: Vec<String>,
}

fn a_impresora(f: &sqlx::sqlite::SqliteRow) -> Impresora {
    Impresora {
        id: f.get("id"),
        nombre: f.get("nombre"),
        conexion: f.get("conexion"),
        destino: f.get("destino"),
        ancho_mm: f.get("ancho_mm"),
        columnas: f.get("columnas"),
        code_page: f.get("code_page"),
        sin_modo_chino: f.get::<i64, _>("sin_modo_chino") == 1,
        barras: f.get("barras"),
        cortador: f.get::<i64, _>("cortador") == 1,
        gaveta: f.get::<i64, _>("gaveta") == 1,
        baudios: f.get("baudios"),
        documentos: f.get::<Option<String>, _>("documentos").map(|s| s.split(',').map(String::from).collect()).unwrap_or_default(),
    }
}

const SELECT: &str = "SELECT i.*, (SELECT group_concat(d.documento) FROM impresora_destinos d WHERE d.impresora_id = i.id AND d.caja_id = i.caja_id) AS documentos
    FROM impresoras i";

pub async fn listar(pool: &SqlitePool, a: &Actor, caja_id: &str) -> Res<Vec<Impresora>> {
    a.exigir("impresoras", "ver las impresoras")?;
    let filas = sqlx::query(&format!("{SELECT} WHERE i.caja_id = ? AND i.eliminado_en IS NULL ORDER BY i.nombre")).bind(caja_id).fetch_all(pool).await.map_err(e)?;
    Ok(filas.iter().map(a_impresora).collect())
}

/// Lo que detecta el sistema (impresoras de Windows, puertos COM, impresoras USB).
pub fn detectar(a: &Actor) -> Res<printer::Detectadas> {
    a.exigir("impresoras", "buscar impresoras")?;
    Ok(printer::detectar())
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Datos {
    #[serde(default)]
    pub id: Option<String>,
    pub nombre: String,
    pub conexion: String,
    pub destino: String,
    pub ancho_mm: i64,
    pub columnas: i64,
    pub code_page: i64,
    pub sin_modo_chino: bool,
    pub barras: String,
    pub cortador: bool,
    pub gaveta: bool,
    #[serde(default = "baudios_defecto")]
    pub baudios: i64,
}

fn baudios_defecto() -> i64 {
    9600
}

pub async fn guardar(pool: &SqlitePool, a: &Actor, caja_id: &str, d: &Datos) -> Res<String> {
    a.exigir("impresoras", "configurar impresoras")?;
    let nombre = texto(&d.nombre, 40, "el nombre de la impresora", true)?;
    if !["windows", "serial", "usb"].contains(&d.conexion.as_str()) {
        return Err("Elija el tipo de conexión".into());
    }
    if ![58, 80].contains(&d.ancho_mm) {
        return Err("El ancho es 58 u 80 mm".into());
    }
    if !(24..=64).contains(&d.columnas) {
        return Err("Las columnas van de 24 a 64 (32 en 58 mm, 48 en 80 mm)".into());
    }
    if !(0..=255).contains(&d.code_page) {
        return Err("Code page inválido".into());
    }
    if d.barras != "A" && d.barras != "B" {
        return Err("Formato de código de barras inválido".into());
    }
    if !BAUDIOS.contains(&d.baudios) {
        return Err("Velocidad del puerto serial inválida".into());
    }
    let anterior = match &d.id {
        Some(id) => Some(
            sqlx::query("SELECT conexion, destino FROM impresoras WHERE id = ? AND caja_id = ? AND eliminado_en IS NULL")
                .bind(id)
                .bind(caja_id)
                .fetch_optional(pool)
                .await
                .map_err(e)?
                .ok_or("Esa impresora ya no existe")?,
        ),
        None => None,
    };
    // Solo destinos que el sistema detecta. Si se edita sin cambiar el destino, se acepta aunque
    // la impresora esté desconectada en este momento (para poder cambiarle otros ajustes).
    let mismo = anterior.as_ref().is_some_and(|f| f.get::<String, _>("conexion") == d.conexion && f.get::<String, _>("destino") == d.destino);
    if !mismo && !printer::detectar().contains(&d.conexion, &d.destino) {
        return Err("Elija la impresora de la lista que detecta la computadora. Si no aparece, revise que esté conectada y encendida, y pulse «Buscar de nuevo».".into());
    }
    let id = d.id.clone().unwrap_or_else(ulid);
    let ahora = ahora_iso();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    if d.gaveta {
        // Una sola gaveta: si se marca en esta, deja de estar en la otra.
        sqlx::query("UPDATE impresoras SET gaveta = 0, actualizado_en = ? WHERE caja_id = ? AND id <> ? AND gaveta = 1").bind(&ahora).bind(caja_id).bind(&id).execute(&mut *tx).await.map_err(e)?;
    }
    sqlx::query(
        "INSERT INTO impresoras (id, sucursal_id, caja_id, nombre, conexion, destino, ancho_mm, columnas, code_page, sin_modo_chino, barras, cortador, gaveta, baudios, creado_en, actualizado_en)
         SELECT ?1, c.sucursal_id, c.id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14 FROM cajas c WHERE c.id = ?2
         ON CONFLICT (id) DO UPDATE SET nombre = excluded.nombre, conexion = excluded.conexion, destino = excluded.destino, ancho_mm = excluded.ancho_mm,
           columnas = excluded.columnas, code_page = excluded.code_page, sin_modo_chino = excluded.sin_modo_chino, barras = excluded.barras,
           cortador = excluded.cortador, gaveta = excluded.gaveta, baudios = excluded.baudios, actualizado_en = excluded.actualizado_en",
    )
    .bind(&id)
    .bind(caja_id)
    .bind(&nombre)
    .bind(&d.conexion)
    .bind(&d.destino)
    .bind(d.ancho_mm)
    .bind(d.columnas)
    .bind(d.code_page)
    .bind(d.sin_modo_chino as i64)
    .bind(&d.barras)
    .bind(d.cortador as i64)
    .bind(d.gaveta as i64)
    .bind(d.baudios)
    .bind(&ahora)
    .execute(&mut *tx)
    .await
    .map_err(|err| if e(&err).contains("UNIQUE") { "Ya hay otra impresora con ese nombre".to_string() } else { e(err) })?;
    bitacora::registrar(&mut tx, Some(&a.id), "impresora.guardar", "impresora", Some(&id), &json!({"nombre": nombre, "conexion": d.conexion, "anchoMm": d.ancho_mm, "columnas": d.columnas, "gaveta": d.gaveta, "nueva": anterior.is_none()})).await?;
    tx.commit().await.map_err(e)?;
    Ok(id)
}

pub async fn eliminar(pool: &SqlitePool, a: &Actor, id: &str) -> Res<()> {
    a.exigir("impresoras", "quitar impresoras")?;
    let ahora = ahora_iso();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let n = sqlx::query("UPDATE impresoras SET eliminado_en = ?, gaveta = 0, actualizado_en = ? WHERE id = ? AND eliminado_en IS NULL").bind(&ahora).bind(&ahora).bind(id).execute(&mut *tx).await.map_err(e)?.rows_affected();
    if n == 0 {
        return Err("Esa impresora ya no existe".into());
    }
    sqlx::query("DELETE FROM impresora_destinos WHERE impresora_id = ?").bind(id).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "impresora.eliminar", "impresora", Some(id), &json!({})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

/// Asigna (o quita, con None) la impresora de un documento.
pub async fn asignar(pool: &SqlitePool, a: &Actor, caja_id: &str, documento: &str, impresora_id: Option<&str>) -> Res<()> {
    a.exigir("impresoras", "asignar impresoras")?;
    if !DOCUMENTOS.contains(&documento) {
        return Err("Documento desconocido".into());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    match impresora_id.filter(|s| !s.is_empty()) {
        Some(id) => {
            let ok: Option<i64> = sqlx::query_scalar("SELECT 1 FROM impresoras WHERE id = ? AND caja_id = ? AND eliminado_en IS NULL").bind(id).bind(caja_id).fetch_optional(&mut *tx).await.map_err(e)?;
            if ok.is_none() {
                return Err("Esa impresora ya no existe".into());
            }
            sqlx::query(
                "INSERT INTO impresora_destinos (caja_id, documento, impresora_id, actualizado_en) VALUES (?, ?, ?, ?)
                 ON CONFLICT (caja_id, documento) DO UPDATE SET impresora_id = excluded.impresora_id, actualizado_en = excluded.actualizado_en",
            )
            .bind(caja_id)
            .bind(documento)
            .bind(id)
            .bind(ahora_iso())
            .execute(&mut *tx)
            .await
            .map_err(e)?;
        }
        None => {
            sqlx::query("DELETE FROM impresora_destinos WHERE caja_id = ? AND documento = ?").bind(caja_id).bind(documento).execute(&mut *tx).await.map_err(e)?;
        }
    }
    bitacora::registrar(&mut tx, Some(&a.id), "impresora.asignar", "impresora", impresora_id, &json!({"documento": documento})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

/// Lo que la pantalla necesita para armar un documento con el formato de su impresora
/// (sin el destino: eso solo lo usa Rust). None = no hay impresora asignada.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Ajustes {
    pub impresora_id: String,
    pub nombre: String,
    pub ancho_mm: i64,
    pub columnas: i64,
    pub code_page: i64,
    pub sin_modo_chino: bool,
    pub barras: String,
    pub cortador: bool,
}

async fn fila_documento(c: &mut SqliteConnection, caja_id: &str, documento: &str) -> Res<Option<Impresora>> {
    let f = sqlx::query(&format!("{SELECT} JOIN impresora_destinos x ON x.impresora_id = i.id AND x.caja_id = i.caja_id WHERE i.caja_id = ? AND x.documento = ? AND i.eliminado_en IS NULL"))
        .bind(caja_id)
        .bind(documento)
        .fetch_optional(c)
        .await
        .map_err(e)?;
    Ok(f.as_ref().map(a_impresora))
}

pub async fn ajustes(pool: &SqlitePool, caja_id: &str, documento: &str) -> Res<Option<Ajustes>> {
    if !DOCUMENTOS.contains(&documento) {
        return Err("Documento desconocido".into());
    }
    let mut c = pool.acquire().await.map_err(e)?;
    Ok(fila_documento(&mut c, caja_id, documento).await?.map(|i| Ajustes {
        impresora_id: i.id,
        nombre: i.nombre,
        ancho_mm: i.ancho_mm,
        columnas: i.columnas,
        code_page: i.code_page,
        sin_modo_chino: i.sin_modo_chino,
        barras: i.barras,
        cortador: i.cortador,
    }))
}

/// Marca del error de una impresora que no contestó a tiempo (el trabajo pudo salir igual, tarde).
pub const SIN_RESPUESTA: &str = "no contestó a tiempo";
#[cfg(not(test))]
const LIMITE_IMPRESION: std::time::Duration = std::time::Duration::from_secs(10);
#[cfg(test)]
const LIMITE_IMPRESION: std::time::Duration = std::time::Duration::from_millis(300);

/// Corre el envío en otro hilo y espera como mucho LIMITE_IMPRESION. Se imprime dentro de una
/// transacción: sin límite, una impresora USB trabada (sin papel, colgada) dejaba la base tomada y
/// ningún cobro podía guardarse. shortcut: el hilo trabado queda esperando al driver; se libera al reiniciar.
fn con_limite(i: &Impresora, datos: &[u8]) -> Res<()> {
    let (conexion, destino, baudios, datos) = (i.conexion.clone(), i.destino.clone(), i.baudios as u32, datos.to_vec());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(printer::enviar(&conexion, &destino, baudios, &datos));
    });
    rx.recv_timeout(LIMITE_IMPRESION).unwrap_or_else(|_| Err(SIN_RESPUESTA.into()))
}

/// Manda bytes YA validados a una impresora. Error en palabras simples (con detalle opcional).
fn mandar(i: &Impresora, datos: &[u8], con_detalle: bool) -> Res<()> {
    if !printer::detectar().contains(&i.conexion, &i.destino) {
        return Err(format!("No se encuentra la impresora «{}». Revise que esté conectada y encendida.", i.nombre));
    }
    con_limite(i, datos).map_err(|err| {
        if err == SIN_RESPUESTA {
            return format!("La impresora «{}» {SIN_RESPUESTA}. Revise que tenga papel y esté bien conectada; puede que el trabajo salga con atraso.", i.nombre);
        }
        let base = format!("La impresora «{}» no respondió. Revise que esté encendida, con papel y bien conectada.", i.nombre);
        if con_detalle {
            format!("{base} Detalle: {err}")
        } else {
            base
        }
    })
}

/// Imprime un documento en la impresora asignada (dentro de la transacción de quien llama, si hay).
pub async fn enviar_con(c: &mut SqliteConnection, caja_id: &str, documento: &str, datos: &[u8]) -> Res<String> {
    escpos::validar(datos)?;
    let i = fila_documento(c, caja_id, documento)
        .await?
        .ok_or_else(|| format!("No hay impresora para {}. El dueño o el técnico la asigna en Administración → Impresoras.", nombre_documento(documento)))?;
    mandar(&i, datos, false)?;
    Ok(i.nombre)
}

pub async fn enviar(pool: &SqlitePool, caja_id: &str, documento: &str, datos: &[u8]) -> Res<String> {
    let mut c = pool.acquire().await.map_err(e)?;
    enviar_con(&mut c, caja_id, documento, datos).await
}

/// "Imprimir prueba" de una impresora (aunque no tenga documentos asignados).
pub async fn probar(pool: &SqlitePool, a: &Actor, id: &str, datos: &[u8]) -> Res<()> {
    a.exigir("impresoras", "probar impresoras")?;
    escpos::validar(datos)?;
    let f = sqlx::query(&format!("{SELECT} WHERE i.id = ? AND i.eliminado_en IS NULL")).bind(id).fetch_optional(pool).await.map_err(e)?.ok_or("Esa impresora ya no existe")?;
    mandar(&a_impresora(&f), datos, true)
}

/// Pulso a la gaveta, en la impresora que la tiene. Solo lo llama gaveta.rs.
pub async fn pulso_gaveta(c: &mut SqliteConnection, caja_id: &str) -> Res<()> {
    let f = sqlx::query(&format!("{SELECT} WHERE i.caja_id = ? AND i.gaveta = 1 AND i.eliminado_en IS NULL"))
        .bind(caja_id)
        .fetch_optional(&mut *c)
        .await
        .map_err(e)?
        .ok_or("No hay gaveta configurada. El dueño o el técnico la marca en la impresora de tiquetes (Administración → Impresoras).")?;
    let i = a_impresora(&f);
    mandar(&i, &escpos::pulso_gaveta(), false).map_err(|m| format!("La gaveta no abrió. {m}"))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::caja::CAJA_1;
    use crate::usuarios::tests::base_con_usuarios;

    pub fn datos(nombre: &str, destino: &str, gaveta: bool) -> Datos {
        Datos { id: None, nombre: nombre.into(), conexion: "windows".into(), destino: destino.into(), ancho_mm: 58, columnas: 32, code_page: 19, sin_modo_chino: true, barras: "B".into(), cortador: false, gaveta, baudios: 9600 }
    }

    /// Dos impresoras: tiquetes (con gaveta) y etiquetas. Devuelve sus destinos simulados.
    pub async fn dos_impresoras(p: &SqlitePool, dueno: &Actor, prefijo: &str) -> (String, String) {
        let (a, b) = (format!("{prefijo}-TIQ"), format!("{prefijo}-ETQ"));
        printer::simulada::instalar("windows", &a);
        printer::simulada::instalar("windows", &b);
        let ia = guardar(p, dueno, CAJA_1, &datos(&format!("Tiquetes {prefijo}"), &a, true)).await.unwrap();
        let ib = guardar(p, dueno, CAJA_1, &datos(&format!("Etiquetas {prefijo}"), &b, false)).await.unwrap();
        for d in ["tiquete", "cierre", "movimiento"] {
            asignar(p, dueno, CAJA_1, d, Some(&ia)).await.unwrap();
        }
        asignar(p, dueno, CAJA_1, "etiqueta", Some(&ib)).await.unwrap();
        (a, b)
    }

    #[tokio::test]
    async fn impresora_trabada_no_traba_la_caja_y_la_gaveta_queda_registrada() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let (a, _) = dos_impresoras(p, &dueno, "TRABA").await;
        crate::caja::abrir(p, &cajero, CAJA_1, &crate::caja::tests::conteo(&[(1000, 5)])).await.unwrap();
        printer::simulada::trabar(&a, true);
        // El envío vuelve a tiempo con un mensaje claro, sin esperar al driver.
        let antes = std::time::Instant::now();
        let err = enviar(p, CAJA_1, "tiquete", b"Hola\n").await.unwrap_err();
        assert!(err.contains(SIN_RESPUESTA) && err.contains("papel"), "{err}");
        assert!(antes.elapsed() < std::time::Duration::from_secs(1));
        // La gaveta no confirmó pero pudo abrirse: la apertura queda registrada (nunca sin rastro).
        let err = crate::gaveta::no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "").await.unwrap_err();
        assert!(err.contains("quedó registrado"), "{err}");
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM gaveta_aperturas").fetch_one(p).await.unwrap();
        assert_eq!(n, 1);
        // Mientras tanto la base sigue libre: se puede escribir.
        crate::ventas::crear_espera(p, &cajero, CAJA_1, &Default::default()).await.unwrap();
        // Impresora apagada (no recibió nada): la apertura NO se registra.
        printer::simulada::trabar(&a, false);
        printer::simulada::apagar(&a, true);
        assert!(crate::gaveta::no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "").await.is_err());
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM gaveta_aperturas").fetch_one(p).await.unwrap();
        assert_eq!(n, 1);
        printer::simulada::apagar(&a, false);
    }

    #[tokio::test]
    async fn cada_documento_a_su_impresora_y_solo_destinos_detectados() {
        let (bd, tec, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        // El cajero no configura impresoras.
        assert!(guardar(p, &cajero, CAJA_1, &datos("X", "NADA", false)).await.unwrap_err().contains("permiso"));
        // Una ruta escrita a mano (no detectada) no se acepta.
        assert!(guardar(p, &tec, CAJA_1, &datos("Red", r"\\otra-pc\cola", false)).await.unwrap_err().contains("lista"));
        let (a, b) = dos_impresoras(p, &dueno, "IMP1").await;
        enviar(p, CAJA_1, "tiquete", b"Tiquete\n").await.unwrap();
        enviar(p, CAJA_1, "etiqueta", b"Etiqueta\n").await.unwrap();
        assert_eq!(printer::simulada::trabajos(&a), vec![b"Tiquete\n".to_vec()]);
        assert_eq!(printer::simulada::trabajos(&b), vec![b"Etiqueta\n".to_vec()]);
        // Nada con pulso de gaveta pasa por la impresión.
        assert!(enviar(p, CAJA_1, "tiquete", &[0x1b, b'p', 0, 25, 250]).await.unwrap_err().contains("no permitido"));
        // Una sola gaveta: marcarla en la de etiquetas la quita de la de tiquetes.
        let l = listar(p, &dueno, CAJA_1).await.unwrap();
        let etq = l.iter().find(|i| i.destino == b).unwrap();
        guardar(p, &dueno, CAJA_1, &Datos { id: Some(etq.id.clone()), gaveta: true, ..datos(&etq.nombre, &b, true) }).await.unwrap();
        let l = listar(p, &dueno, CAJA_1).await.unwrap();
        assert_eq!(l.iter().filter(|i| i.gaveta).count(), 1);
        assert!(l.iter().find(|i| i.destino == b).unwrap().gaveta);
        // Apagada: error simple, sin trabar nada.
        printer::simulada::apagar(&a, true);
        let err = enviar(p, CAJA_1, "tiquete", b"x\n").await.unwrap_err();
        assert!(err.contains("no respondió") && !err.contains("1801"), "{err}");
        // Sin impresora asignada: se dice dónde se asigna.
        asignar(p, &dueno, CAJA_1, "movimiento", None).await.unwrap();
        assert!(enviar(p, CAJA_1, "movimiento", b"x\n").await.unwrap_err().contains("Impresoras"));
        let _ = tec;
    }
}
