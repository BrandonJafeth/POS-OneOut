// Turnos de caja: apertura con conteo, entradas/salidas, cortes parciales, arqueo y cierre Z,
// reapertura e historial.
//
// Reglas (las decide Rust, no la pantalla):
// - Un solo turno abierto por caja (además lo garantiza un índice único en la base).
// - El turno es de la CAJA, no de quien lo abrió: con `caja_turno_compartido` (por defecto sí),
//   cualquier cajero o dueño activo vende en el turno abierto sin abrir otro. Cada venta, pago,
//   movimiento, corte y apertura de gaveta guarda quién la hizo. Sin la opción, cada persona usa su
//   propio turno (ni el dueño vende en el de otro; sí puede cerrarlo).
// - Mientras el turno está abierto, el cajero NO recibe totales de ventas por ningún comando
//   (ni el esperado): solo lo de la venta que hace y sus propios tiquetes. Al cerrar ve el Z completo.
// - El conteo del cajero es ciego (por total o por billetes y monedas). Cerrado el turno, el conteo no se edita
//   (trigger en la base); solo el dueño reabre, con PIN y motivo, y solo el mismo día.
// - Efectivo esperado = fondo + efectivo recibido − vueltos + entradas − salidas.
// - Diferencia = contado − esperado. Desde el umbral queda para revisión del dueño.
// - Lo que se corrige de un turno ya cerrado no lo toca: queda como ajuste en el turno actual.

use crate::bitacora;
use crate::config;
use crate::desglose::{self, Desglose};
use crate::escpos;
use crate::estadisticas::{self, Estadisticas};
use crate::impresoras;
use crate::permisos::{puede, sin_permiso, Rol};
use crate::sesion::Actor;
use crate::usuarios;
use crate::util::{ahora_iso, colones, dia_local, e, texto, ulid, Res};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::BTreeMap;

pub const CAJA_1: &str = "0000000000000000000000C001";

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Turno {
    pub id: String,
    pub caja_id: String,
    pub caja: String,
    pub estado: String,
    pub dia: String,
    pub abierto_en: String,
    pub cerrado_en: Option<String>,
    pub usuario_apertura_id: String,
    pub usuario_apertura: String,
    pub usuario_cierre_id: Option<String>,
    pub usuario_cierre: Option<String>,
    pub fondo: i64,
    pub conteo_inicial: Option<Value>,
    pub conteo_final: Option<Value>,
    pub esperado: Option<i64>,
    pub contado: Option<i64>,
    pub diferencia: Option<i64>,
    pub nota_cierre: Option<String>,
    pub revisada_por: Option<String>,
    pub reimpresiones: i64,
}

const SELECT_TURNO: &str = "SELECT t.*, ua.nombre AS u_apertura, uc.nombre AS u_cierre, c.nombre AS caja_nombre FROM caja_turnos t
    JOIN usuarios ua ON ua.id = t.usuario_apertura_id LEFT JOIN usuarios uc ON uc.id = t.usuario_cierre_id JOIN cajas c ON c.id = t.caja_id";

fn json_o_null(s: Option<String>) -> Option<Value> {
    s.and_then(|v| serde_json::from_str(&v).ok())
}

fn a_turno(f: &sqlx::sqlite::SqliteRow) -> Turno {
    Turno {
        id: f.get("id"),
        caja_id: f.get("caja_id"),
        caja: f.get("caja_nombre"),
        estado: f.get("estado"),
        dia: f.get::<Option<String>, _>("dia").unwrap_or_default(),
        abierto_en: f.get("abierto_en"),
        cerrado_en: f.get("cerrado_en"),
        usuario_apertura_id: f.get("usuario_apertura_id"),
        usuario_apertura: f.get("u_apertura"),
        usuario_cierre_id: f.get("usuario_cierre_id"),
        usuario_cierre: f.get("u_cierre"),
        fondo: f.get("monto_inicial"),
        conteo_inicial: json_o_null(f.get("conteo_inicial")),
        conteo_final: json_o_null(f.get("conteo_final")),
        esperado: f.get("monto_esperado"),
        contado: f.get("monto_contado"),
        diferencia: f.get("diferencia"),
        nota_cierre: f.get("nota_cierre"),
        revisada_por: f.get("diferencia_revisada_por"),
        reimpresiones: f.get("reimpresiones"),
    }
}

pub async fn turno(c: &mut SqliteConnection, id: &str) -> Res<Option<Turno>> {
    let f = sqlx::query(&format!("{SELECT_TURNO} WHERE t.id = ? AND t.eliminado_en IS NULL")).bind(id).fetch_optional(c).await.map_err(e)?;
    Ok(f.as_ref().map(a_turno))
}

pub async fn turno_abierto(c: &mut SqliteConnection, caja_id: &str) -> Res<Option<Turno>> {
    let f = sqlx::query(&format!("{SELECT_TURNO} WHERE t.caja_id = ? AND t.estado = 'abierto' AND t.eliminado_en IS NULL"))
        .bind(caja_id)
        .fetch_optional(c)
        .await
        .map_err(e)?;
    Ok(f.as_ref().map(a_turno))
}

/// ¿Otros usuarios pueden usar el turno que abrió otra persona? (config, por defecto sí)
pub async fn compartido(c: &mut SqliteConnection) -> bool {
    config::booleano_con(c, "caja_turno_compartido", true).await
}

/// ¿Puede este usuario operar (vender, mover efectivo, abrir la gaveta sin venta) en este turno?
pub fn puede_operar(a: &Actor, t: &Turno, compartido: bool) -> Res<()> {
    if !puede(a.rol, "caja") {
        return Err(sin_permiso("usar la caja"));
    }
    if t.usuario_apertura_id == a.id || compartido {
        return Ok(());
    }
    Err(format!(
        "La caja la abrió {} a las {}. En este negocio cada persona usa su propio turno: {} la cierra con su conteo y después usted abre el suyo.",
        t.usuario_apertura,
        hora_local(&t.abierto_en),
        t.usuario_apertura
    ))
}

/// Cierra el turno quien lo abrió, cualquiera con permiso de caja si el turno es compartido, o el dueño.
pub fn puede_cerrar(a: &Actor, t: &Turno, compartido: bool) -> Res<()> {
    if puede(a.rol, "caja.admin") {
        return Ok(());
    }
    puede_operar(a, t, compartido).map_err(|_| format!("Esta caja la abrió {}: la cierra {} con su conteo, o el dueño.", t.usuario_apertura, t.usuario_apertura))
}

pub fn hora_local(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso).map(|d| d.with_timezone(&chrono::Local).format("%H:%M").to_string()).unwrap_or_default()
}

/// El turno donde este usuario puede vender ahora: abierto, de hoy y que pueda usar.
pub async fn turno_para_vender(c: &mut SqliteConnection, caja_id: &str, a: &Actor) -> Res<Turno> {
    let comp = compartido(c).await;
    match turno_abierto(c, caja_id).await? {
        None => Err("La caja está cerrada: ábrala para vender".into()),
        Some(t) if t.dia != dia_local() => Err(format!("Quedó abierta la caja del {} ({}): hay que cerrarla con su conteo antes de vender hoy.", t.dia, t.usuario_apertura)),
        Some(t) => {
            puede_operar(a, &t, comp)?;
            Ok(t)
        }
    }
}

/// ¿Ve este usuario los totales de ventas de este turno? El cajero, solo cuando ya cerró.
pub fn ve_totales(a: &Actor, t: &Turno) -> bool {
    a.rol != Rol::Cajero || t.estado == "cerrado"
}

// ─────────── Conteo por denominaciones ───────────

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Conteo {
    /// denominación (como texto, viene de JSON) → cantidad de billetes/monedas
    #[serde(default)]
    pub cantidades: BTreeMap<String, i64>,
    /// Total escrito de una vez, sin detallar billetes y monedas. Se usa si no hay cantidades.
    #[serde(default)]
    pub total: Option<i64>,
}

pub async fn denominaciones(pool: &SqlitePool) -> Vec<i64> {
    config::valor(pool, "caja_denominaciones")
        .await
        .and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_i64()).filter(|n| *n > 0).collect::<Vec<_>>()))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| vec![50000, 20000, 10000, 5000, 2000, 1000, 500, 100, 50, 25, 10, 5])
}

/// Total del conteo, validado contra las denominaciones configuradas. Devuelve (total, JSON limpio).
pub fn total_conteo(c: &Conteo, validas: &[i64]) -> Res<(i64, Value)> {
    if c.cantidades.values().all(|n| *n == 0) {
        if let Some(t) = c.total {
            if !(0..=100_000_000).contains(&t) {
                return Err("El total contado no es válido".into());
            }
            return Ok((t, json!({ "total": t })));
        }
    }
    let mut total = 0i64;
    let mut limpio = serde_json::Map::new();
    for (k, n) in &c.cantidades {
        let d: i64 = k.parse().map_err(|_| "Denominación inválida".to_string())?;
        if !validas.contains(&d) {
            return Err(format!("No se reconoce el billete o la moneda de ¢{d}. Si todavía circula, el administrador lo puede agregar en la configuración."));
        }
        if !(0..=100_000).contains(n) {
            return Err("Revise el conteo: cada cantidad debe ser un número entero, sin decimales.".into());
        }
        if *n > 0 {
            total += d * n;
            limpio.insert(d.to_string(), json!(n));
        }
    }
    Ok((total, Value::Object(limpio)))
}

// ─────────── Estado y apertura ───────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EstadoCaja {
    pub turno: Option<Turno>,
    /// Hay un turno abierto de un día anterior: hay que cerrarlo antes de vender.
    pub de_otro_dia: bool,
    /// El turno abierto lo pueden usar otros usuarios (config caja_turno_compartido).
    pub compartido: bool,
    /// Este usuario puede vender y mover efectivo en el turno abierto.
    pub puede_usar: bool,
    pub puede_cerrar: bool,
    pub denominaciones: Vec<i64>,
    pub motivos: Value,
    pub salida_max_sin_pin: i64,
    pub umbral_diferencia: i64,
    pub no_venta_motivos: Vec<String>,
    pub no_venta_umbral: i64,
    /// Aperturas de gaveta sin venta en el turno abierto (cantidad; no es dinero).
    pub no_ventas: i64,
    /// Valores por defecto de las casillas del cierre Z.
    pub z_detalle_completo: bool,
    pub z_por_departamento: bool,
}

pub async fn motivos_no_venta(pool: &SqlitePool) -> Vec<String> {
    config::valor(pool, "caja_no_venta_motivos")
        .await
        .and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>()))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| vec!["Cambio de billetes".into(), "Devolución".into(), "Otro".into()])
}

pub async fn estado(pool: &SqlitePool, a: &Actor, caja_id: &str) -> Res<EstadoCaja> {
    a.exigir("caja", "usar la caja")?;
    let (t, comp, no_ventas) = {
        let mut c = pool.acquire().await.map_err(e)?;
        let t = turno_abierto(&mut c, caja_id).await?;
        let comp = compartido(&mut c).await;
        let n: i64 = match &t {
            Some(t) => sqlx::query_scalar("SELECT COUNT(*) FROM gaveta_aperturas WHERE turno_id = ?").bind(&t.id).fetch_one(&mut *c).await.map_err(e)?,
            None => 0,
        };
        (t, comp, n)
    };
    Ok(EstadoCaja {
        de_otro_dia: t.as_ref().is_some_and(|t| t.dia != dia_local()),
        puede_usar: t.as_ref().is_some_and(|t| puede_operar(a, t, comp).is_ok()),
        puede_cerrar: t.as_ref().is_some_and(|t| puede_cerrar(a, t, comp).is_ok()),
        turno: t,
        compartido: comp,
        denominaciones: denominaciones(pool).await,
        motivos: config::valor(pool, "caja_motivos").await.unwrap_or(json!({"salida": [], "entrada": []})),
        salida_max_sin_pin: config::entero(pool, "caja_salida_max_sin_pin", 20000).await,
        umbral_diferencia: config::entero(pool, "caja_umbral_diferencia", 1000).await,
        no_venta_motivos: motivos_no_venta(pool).await,
        no_venta_umbral: config::entero(pool, "caja_no_venta_umbral", 5).await,
        no_ventas,
        z_detalle_completo: config::booleano(pool, "caja_z_detalle_completo", false).await,
        z_por_departamento: config::booleano(pool, "caja_z_por_departamento", false).await,
    })
}

/// Reloj atrasado: el día de la caja, las horas del Z y las fechas de las ventas saldrían mal. Se
/// nota contra lo último registrado (con 10 minutos de margen). Al abrir, cobrar y cerrar.
pub async fn reloj_atrasado(c: &mut SqliteConnection, para: &str) -> Res<()> {
    let ultimo: Option<String> = sqlx::query_scalar(
        "SELECT MAX(f) FROM (SELECT MAX(fecha) AS f FROM ventas UNION ALL SELECT MAX(COALESCE(cerrado_en, abierto_en)) FROM caja_turnos)",
    )
    .fetch_one(&mut *c)
    .await
    .map_err(e)?;
    let margen = (chrono::Utc::now() + chrono::Duration::minutes(10)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    // Salida para el técnico: si el reloj estuvo ADELANTADO y ya se corrigió, lo registrado con fecha
    // futura bloquearía la caja hasta que llegue ese día. La clave «reloj_ignorar_hasta» acepta lo
    // registrado hasta esa fecha.
    let ignorar = config::valor_con(c, "reloj_ignorar_hasta").await.and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    if let Some(u) = ultimo.filter(|u| *u > margen && *u > ignorar) {
        return Err(format!(
            "La fecha u hora de la computadora está atrasada: lo último registrado es del {}. Corrija la fecha y la hora de Windows antes de {para}. Si Windows ya tiene la fecha correcta, el técnico lo autoriza en Configuración técnica → Claves: reloj_ignorar_hasta = \"{u}\".",
            chrono::DateTime::parse_from_rfc3339(&u).map(|d| d.with_timezone(&chrono::Local).format("%d/%m/%Y %H:%M").to_string()).unwrap_or(u.clone())
        ));
    }
    Ok(())
}

pub async fn abrir(pool: &SqlitePool, a: &Actor, caja_id: &str, conteo: &Conteo) -> Res<Turno> {
    a.exigir("caja", "abrir la caja")?;
    let (fondo, detalle) = total_conteo(conteo, &denominaciones(pool).await)?;
    let id = ulid();
    let ahora = ahora_iso();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    if let Some(t) = turno_abierto(&mut tx, caja_id).await? {
        let comp = compartido(&mut tx).await;
        return Err(if t.dia != dia_local() {
            format!("Quedó abierta la caja del {} ({}): ciérrela primero con su conteo.", t.dia, t.usuario_apertura)
        } else if t.usuario_apertura_id == a.id {
            "Su caja ya está abierta.".into()
        } else if comp {
            format!("La caja ya está abierta (la abrió {} a las {}). Puede vender en ese mismo turno.", t.usuario_apertura, hora_local(&t.abierto_en))
        } else {
            format!("La caja ya la tiene abierta {}. Debe cerrarla con su conteo antes de abrir la suya.", t.usuario_apertura)
        });
    }
    reloj_atrasado(&mut tx, "abrir la caja").await?;
    sqlx::query(
        "INSERT INTO caja_turnos (id, sucursal_id, caja_id, usuario_apertura_id, abierto_en, monto_inicial, estado, dia, conteo_inicial, creado_en, actualizado_en)
         SELECT ?, sucursal_id, id, ?, ?, ?, 'abierto', ?, ?, ?, ? FROM cajas WHERE id = ? AND eliminado_en IS NULL",
    )
    .bind(&id)
    .bind(&a.id)
    .bind(&ahora)
    .bind(fondo)
    .bind(dia_local())
    .bind(detalle.to_string())
    .bind(&ahora)
    .bind(&ahora)
    .bind(caja_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| if e(&err).contains("UNIQUE") { "La caja ya está abierta".to_string() } else { e(err) })?;
    bitacora::registrar(&mut tx, Some(&a.id), "caja.abrir", "caja_turno", Some(&id), &json!({"fondo": fondo, "conteo": detalle})).await?;
    let t = turno(&mut tx, &id).await?.ok_or("La caja no existe")?;
    tx.commit().await.map_err(e)?;
    Ok(t)
}

// ─────────── Movimientos de efectivo ───────────

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NuevoMovimiento {
    pub tipo: String,
    pub monto: i64,
    pub categoria: String,
    #[serde(default)]
    pub nota: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Movimiento {
    pub id: String,
    pub tipo: String,
    pub monto: i64,
    pub categoria: String,
    pub motivo: String,
    pub usuario: String,
    pub autorizado_por: Option<String>,
    pub fecha: String,
}

/// Inserta un movimiento en el turno (dentro de la transacción de quien llama).
#[allow(clippy::too_many_arguments)]
pub async fn insertar_movimiento(c: &mut SqliteConnection, t: &Turno, a: &Actor, tipo: &str, monto: i64, categoria: &str, nota: &str, autorizado_por: Option<&str>) -> Res<String> {
    let id = ulid();
    let ahora = ahora_iso();
    sqlx::query(
        "INSERT INTO caja_movimientos (id, sucursal_id, caja_id, turno_id, tipo, monto, motivo, categoria, usuario_id, autorizado_por, fecha, creado_en, actualizado_en)
         SELECT ?, sucursal_id, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM cajas WHERE id = ?",
    )
    .bind(&id)
    .bind(&t.id)
    .bind(tipo)
    .bind(monto)
    .bind(nota)
    .bind(categoria)
    .bind(&a.id)
    .bind(autorizado_por)
    .bind(&ahora)
    .bind(&ahora)
    .bind(&ahora)
    .bind(&t.caja_id)
    .execute(&mut *c)
    .await
    .map_err(e)?;
    bitacora::registrar(c, Some(&a.id), &format!("caja.{tipo}"), "caja_movimiento", Some(&id), &json!({"turnoId": t.id, "monto": monto, "categoria": categoria, "nota": nota, "autorizadoPor": autorizado_por})).await?;
    Ok(id)
}

fn motivo_permitido(motivos: &Value, tipo: &str, categoria: &str) -> bool {
    motivos.get(tipo).and_then(|v| v.as_array()).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(categoria)))
}

pub async fn movimiento(pool: &SqlitePool, a: &Actor, caja_id: &str, m: &NuevoMovimiento, pin_dueno: Option<&str>) -> Res<String> {
    a.exigir("caja", "registrar entradas o salidas")?;
    if m.tipo != "entrada" && m.tipo != "salida" {
        return Err("Tipo de movimiento inválido".into());
    }
    if !(1..=100_000_000).contains(&m.monto) {
        return Err("Escriba un monto mayor que cero, en colones y sin decimales.".into());
    }
    let categoria = texto(&m.categoria, 60, "motivo", true)?;
    let nota = texto(&m.nota, 200, "nota", false)?;
    let motivos = config::valor(pool, "caja_motivos").await.unwrap_or(Value::Null);
    if !motivo_permitido(&motivos, &m.tipo, &categoria) {
        return Err("Elija un motivo de la lista".into());
    }
    let tope = config::entero(pool, "caja_salida_max_sin_pin", 20000).await;
    // Salida grande: PIN del dueño en el momento (también si el que la hace es el dueño).
    let autorizado = if m.tipo == "salida" && m.monto > tope {
        let p = pin_dueno.filter(|p| !p.is_empty()).ok_or("Esta salida pasa el tope: necesita el PIN del dueño")?;
        Some(usuarios::autorizar_dueno(pool, p, "salida de caja", &a.id).await?)
    } else {
        None
    };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let t = turno_abierto(&mut tx, caja_id).await?.ok_or("La caja está cerrada: ábrala primero.")?;
    let comp = compartido(&mut tx).await;
    puede_operar(a, &t, comp)?;
    if m.tipo == "salida" {
        let r = resumen(&mut tx, &t).await?;
        if m.monto > r.efectivo_esperado {
            drop(tx);
            // El cajero no ve lo esperado: el rechazo queda en la bitácora para que el dueño lo vea.
            if a.rol == Rol::Cajero {
                let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
                bitacora::registrar(&mut tx, Some(&a.id), "caja.salida_rechazada", "caja_turno", Some(&t.id), &json!({"monto": m.monto, "categoria": categoria})).await?;
                tx.commit().await.map_err(e)?;
            }
            return Err("No hay tanto efectivo en la caja".into());
        }
    }
    let id = insertar_movimiento(&mut tx, &t, a, &m.tipo, m.monto, &categoria, &nota, autorizado.as_deref()).await?;
    tx.commit().await.map_err(e)?;
    Ok(id)
}

// ─────────── Resumen (lo esperado y el desglose del Z) ───────────

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PorForma {
    pub forma_pago_id: String,
    pub nombre: String,
    pub tipo: String,
    pub codigo: String,
    pub da_vuelto: bool,
    pub pagos: i64,
    pub monto: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AjusteResumen {
    pub id: String,
    pub tipo: String,
    pub venta_numero: String,
    pub monto: i64,
    pub motivo: String,
    pub antes: Value,
    pub despues: Value,
    pub usuario: String,
    pub fecha: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PorUsuario {
    pub usuario: String,
    pub ventas: i64,
    pub total: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PagoElectronico {
    pub fecha: String,
    pub venta_numero: String,
    pub forma: String,
    pub tipo: String,
    pub monto: i64,
    pub ultimos4: Option<String>,
    pub banco: Option<String>,
    pub referencia: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NoVenta {
    pub fecha: String,
    pub usuario: String,
    /// "no_venta" (con motivo de la lista) u "dueno" (orden del dueño con PIN).
    pub causa: String,
    pub motivo: String,
    pub nota: Option<String>,
    pub autorizado_por: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CorteResumen {
    pub id: String,
    pub fecha: String,
    pub usuario: String,
    pub ventas: i64,
    pub total: i64,
    pub efectivo_esperado: i64,
    pub retiro: i64,
}

fn si() -> bool {
    true
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Resumen {
    pub fondo: i64,
    pub ventas: i64,
    pub total_ventas: i64,
    pub descuentos: i64,
    pub anuladas: i64,
    pub total_anuladas: i64,
    pub por_forma: Vec<PorForma>,
    /// Efectivo entregado por los clientes y vuelto dado.
    pub recibido_efectivo: i64,
    pub vueltos: i64,
    /// Efectivo neto de las ventas (recibido − vueltos).
    pub ventas_efectivo: i64,
    pub entradas: i64,
    pub salidas: i64,
    pub efectivo_esperado: i64,
    pub movimientos: Vec<Movimiento>,
    pub ajustes: Vec<AjusteResumen>,
    /// Cada pago con tarjeta, SINPE o transferencia, para revisarlo contra el datáfono y los comprobantes.
    pub pagos_electronicos: Vec<PagoElectronico>,
    /// Ventas de cada usuario en el turno (tiquetes y monto). El efectivo y la diferencia son de la caja.
    pub por_usuario: Vec<PorUsuario>,
    /// Aperturas de gaveta sin venta (con motivo) y órdenes del dueño.
    pub no_ventas: Vec<NoVenta>,
    pub no_venta_umbral: i64,
    pub cortes: Vec<CorteResumen>,
    /// Ventas por departamento y producto (reparto exacto).
    pub desglose: Desglose,
    /// false en cierres viejos (antes de la migración 9): no traen desglose.
    pub con_desglose: bool,
    /// Los totales por departamento, el detalle, las formas de pago y el efectivo cuadran entre sí.
    #[serde(default = "si")]
    pub cuadra: bool,
    pub descuadres: Vec<String>,
    /// Control por usuario, ventas por hora, promedio, semana anterior y más vendidos (solo informa).
    pub estadisticas: Estadisticas,
    /// Quién firma como supervisor en el Z: el dueño que cerró o, si cerró un cajero, los dueños activos.
    pub supervisor: String,
}

/// Una diferencia de caja pide nota y revisión si NO es cero y llega al umbral
/// (con umbral 0, cualquier diferencia; un cierre que cuadra nunca).
pub fn fuera_de_umbral(diferencia: i64, umbral: i64) -> bool {
    diferencia != 0 && diferencia.abs() >= umbral
}

/// Revisa que todo cuadre (si no, el Z no se imprime con números inconsistentes).
fn revisar_cuadre(r: &mut Resumen) {
    let mut d = Vec::new();
    let formas: i64 = r.por_forma.iter().map(|f| f.monto).sum();
    if formas != r.total_ventas {
        d.push(format!("formas de pago {} ≠ ventas {}", colones(formas), colones(r.total_ventas)));
    }
    if r.con_desglose {
        let deps: i64 = r.desglose.departamentos.iter().map(|x| x.monto).sum();
        let filas: i64 = r.desglose.departamentos.iter().flat_map(|x| &x.filas).map(|f| f.monto).sum();
        if deps != r.total_ventas {
            d.push(format!("departamentos {} ≠ ventas {}", colones(deps), colones(r.total_ventas)));
        }
        if filas != r.total_ventas {
            d.push(format!("detalle {} ≠ ventas {}", colones(filas), colones(r.total_ventas)));
        }
        if r.desglose.efectivo != r.ventas_efectivo {
            d.push(format!("efectivo por departamento {} ≠ efectivo cobrado {}", colones(r.desglose.efectivo), colones(r.ventas_efectivo)));
        }
        if !r.desglose.ventas_descuadradas.is_empty() {
            d.push(format!("pagos que no suman el total en los tiquetes {}", r.desglose.ventas_descuadradas.join(", ")));
        }
    }
    if r.efectivo_esperado != r.fondo + r.recibido_efectivo - r.vueltos + r.entradas - r.salidas {
        d.push("efectivo esperado".into());
    }
    r.cuadra = d.is_empty();
    r.descuadres = d;
}

pub async fn resumen(c: &mut SqliteConnection, t: &Turno) -> Res<Resumen> {
    let v = sqlx::query(
        "SELECT
           COALESCE(SUM(CASE WHEN estado = 'completada' THEN 1 END), 0) AS n,
           COALESCE(SUM(CASE WHEN estado = 'completada' THEN total END), 0) AS total,
           COALESCE(SUM(CASE WHEN estado = 'completada' THEN descuento END), 0) AS desc,
           COALESCE(SUM(CASE WHEN estado = 'anulada' THEN 1 END), 0) AS na,
           COALESCE(SUM(CASE WHEN estado = 'anulada' THEN total END), 0) AS ta
         FROM ventas WHERE turno_id = ? AND eliminado_en IS NULL",
    )
    .bind(&t.id)
    .fetch_one(&mut *c)
    .await
    .map_err(e)?;
    // Descuentos de línea también son descuentos dados.
    let desc_lineas: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(l.descuento), 0) FROM venta_lineas l JOIN ventas v ON v.id = l.venta_id WHERE v.turno_id = ? AND v.estado = 'completada' AND v.eliminado_en IS NULL AND l.eliminado_en IS NULL",
    )
    .bind(&t.id)
    .fetch_one(&mut *c)
    .await
    .map_err(e)?;
    let formas = sqlx::query(
        "SELECT f.id, f.nombre, f.tipo, f.da_vuelto, COUNT(p.id) AS n, COALESCE(SUM(p.monto), 0) AS monto,
                COALESCE(SUM(p.recibido), 0) AS recibido, COALESCE(SUM(p.vuelto), 0) AS vuelto
         FROM venta_pagos p JOIN ventas v ON v.id = p.venta_id JOIN formas_pago f ON f.id = p.forma_pago_id
         WHERE v.turno_id = ? AND v.estado = 'completada' AND v.eliminado_en IS NULL AND p.eliminado_en IS NULL
         GROUP BY f.id ORDER BY f.orden, f.nombre",
    )
    .bind(&t.id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    let mut r = Resumen {
        fondo: t.fondo,
        ventas: v.get("n"),
        total_ventas: v.get("total"),
        descuentos: v.get::<i64, _>("desc") + desc_lineas,
        anuladas: v.get("na"),
        total_anuladas: v.get("ta"),
        no_venta_umbral: config::entero_con(c, "caja_no_venta_umbral", 5).await,
        con_desglose: true,
        ..Default::default()
    };
    for f in &formas {
        let da_vuelto = f.get::<i64, _>("da_vuelto") == 1;
        let monto: i64 = f.get("monto");
        if da_vuelto {
            r.ventas_efectivo += monto;
            // Un pago corregido a efectivo no trae recibido: cuenta lo aplicado.
            r.recibido_efectivo += f.get::<i64, _>("recibido").max(0);
            r.vueltos += f.get::<i64, _>("vuelto");
        }
        let (nombre, tipo): (String, String) = (f.get("nombre"), f.get("tipo"));
        r.por_forma.push(PorForma { forma_pago_id: f.get("id"), codigo: desglose::codigo_corto(&tipo, &nombre), nombre, tipo, da_vuelto, pagos: f.get("n"), monto });
    }
    // Pagos de efectivo sin "recibido" (corregidos a efectivo): lo recibido es el monto.
    let sin_recibido: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(p.monto), 0) FROM venta_pagos p JOIN ventas v ON v.id = p.venta_id JOIN formas_pago f ON f.id = p.forma_pago_id
         WHERE v.turno_id = ? AND v.estado = 'completada' AND v.eliminado_en IS NULL AND p.eliminado_en IS NULL AND f.da_vuelto = 1 AND p.recibido IS NULL",
    )
    .bind(&t.id)
    .fetch_one(&mut *c)
    .await
    .map_err(e)?;
    r.recibido_efectivo += sin_recibido;
    let movs = sqlx::query(
        "SELECT m.id, m.tipo, m.monto, m.categoria, m.motivo, m.fecha, u.nombre AS usuario, ua.nombre AS autorizado
         FROM caja_movimientos m JOIN usuarios u ON u.id = m.usuario_id LEFT JOIN usuarios ua ON ua.id = m.autorizado_por
         WHERE m.turno_id = ? AND m.eliminado_en IS NULL ORDER BY m.fecha, m.id",
    )
    .bind(&t.id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    for m in &movs {
        let mv = Movimiento {
            id: m.get("id"),
            tipo: m.get("tipo"),
            monto: m.get("monto"),
            categoria: m.get("categoria"),
            motivo: m.get("motivo"),
            usuario: m.get("usuario"),
            autorizado_por: m.get("autorizado"),
            fecha: m.get("fecha"),
        };
        if mv.tipo == "entrada" {
            r.entradas += mv.monto;
        } else {
            r.salidas += mv.monto;
        }
        r.movimientos.push(mv);
    }
    let ajs = sqlx::query(
        "SELECT a.id, a.tipo, a.monto, a.motivo, a.valor_anterior, a.valor_nuevo, a.fecha, v.numero, u.nombre AS usuario
         FROM caja_ajustes a JOIN ventas v ON v.id = a.venta_id JOIN usuarios u ON u.id = a.usuario_id WHERE a.turno_id = ? ORDER BY a.fecha, a.id",
    )
    .bind(&t.id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    r.ajustes = ajs
        .iter()
        .map(|a| AjusteResumen {
            id: a.get("id"),
            tipo: a.get("tipo"),
            venta_numero: a.get("numero"),
            monto: a.get("monto"),
            motivo: a.get("motivo"),
            antes: json_o_null(a.get("valor_anterior")).unwrap_or(Value::Null),
            despues: json_o_null(a.get("valor_nuevo")).unwrap_or(Value::Null),
            usuario: a.get("usuario"),
            fecha: a.get("fecha"),
        })
        .collect();
    let pe = sqlx::query(
        "SELECT v.fecha, v.numero, f.nombre AS forma, f.tipo, p.monto, p.ultimos4, COALESCE(NULLIF(b.abreviatura, ''), b.nombre) AS banco, p.referencia
         FROM venta_pagos p JOIN ventas v ON v.id = p.venta_id JOIN formas_pago f ON f.id = p.forma_pago_id
         LEFT JOIN bancos b ON b.id = p.banco_id
         WHERE v.turno_id = ? AND v.estado = 'completada' AND v.eliminado_en IS NULL AND p.eliminado_en IS NULL AND f.da_vuelto = 0
         ORDER BY f.orden, f.nombre, v.fecha",
    )
    .bind(&t.id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    r.pagos_electronicos = pe
        .iter()
        .map(|p| PagoElectronico {
            fecha: p.get("fecha"),
            venta_numero: p.get("numero"),
            forma: p.get("forma"),
            tipo: p.get("tipo"),
            monto: p.get("monto"),
            ultimos4: p.get("ultimos4"),
            banco: p.get("banco"),
            referencia: p.get("referencia"),
        })
        .collect();
    let pu = sqlx::query(
        "SELECT u.nombre, COUNT(*) AS n, COALESCE(SUM(v.total), 0) AS total FROM ventas v JOIN usuarios u ON u.id = v.usuario_id
         WHERE v.turno_id = ? AND v.estado = 'completada' AND v.eliminado_en IS NULL GROUP BY u.id ORDER BY total DESC, u.nombre",
    )
    .bind(&t.id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    r.por_usuario = pu.iter().map(|f| PorUsuario { usuario: f.get("nombre"), ventas: f.get("n"), total: f.get("total") }).collect();
    let nv = sqlx::query(
        "SELECT g.fecha, u.nombre AS usuario, g.causa, g.motivo, g.nota, ua.nombre AS autorizado FROM gaveta_aperturas g
         JOIN usuarios u ON u.id = g.usuario_id LEFT JOIN usuarios ua ON ua.id = g.autorizado_por WHERE g.turno_id = ? ORDER BY g.fecha, g.id",
    )
    .bind(&t.id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    r.no_ventas = nv
        .iter()
        .map(|f| NoVenta { fecha: f.get("fecha"), usuario: f.get("usuario"), causa: f.get("causa"), motivo: f.get("motivo"), nota: f.get("nota"), autorizado_por: f.get("autorizado") })
        .collect();
    let cs = sqlx::query(
        "SELECT k.id, k.fecha, u.nombre AS usuario, k.ventas, k.total, k.efectivo_esperado, k.retiro FROM caja_cortes k JOIN usuarios u ON u.id = k.usuario_id
         WHERE k.turno_id = ? ORDER BY k.fecha, k.id",
    )
    .bind(&t.id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    r.cortes = cs
        .iter()
        .map(|f| CorteResumen { id: f.get("id"), fecha: f.get("fecha"), usuario: f.get("usuario"), ventas: f.get("ventas"), total: f.get("total"), efectivo_esperado: f.get("efectivo_esperado"), retiro: f.get("retiro") })
        .collect();
    r.desglose = desglose::calcular(c, &t.id).await?;
    r.estadisticas = estadisticas::calcular(c, t).await?;
    r.supervisor = sqlx::query_scalar("SELECT COALESCE(group_concat(nombre, ' / '), '') FROM (SELECT nombre FROM usuarios WHERE rol = 'dueno' AND activo = 1 AND eliminado_en IS NULL ORDER BY nombre)")
        .fetch_one(&mut *c)
        .await
        .map_err(e)?;
    // Los ajustes no cambian el efectivo de este turno: una devolución en efectivo entra como salida.
    r.efectivo_esperado = r.fondo + r.recibido_efectivo - r.vueltos + r.entradas - r.salidas;
    revisar_cuadre(&mut r);
    Ok(r)
}

/// Lo único del turno abierto que recibe el cajero: fondo, sus movimientos de efectivo y las
/// aperturas sin venta. Ningún total de ventas (ni cantidad, ni formas de pago, ni esperado).
fn sin_totales(r: &Resumen) -> Resumen {
    Resumen {
        fondo: r.fondo,
        entradas: r.entradas,
        salidas: r.salidas,
        movimientos: r.movimientos.clone(),
        no_ventas: r.no_ventas.clone(),
        no_venta_umbral: r.no_venta_umbral,
        cuadra: true,
        ..Default::default()
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Detalle {
    pub turno: Turno,
    pub resumen: Resumen,
    /// false para el cajero con el turno abierto: no se muestra ningún total de ventas.
    pub ve_totales: bool,
    pub bitacora_ok: Option<bool>,
}

/// ¿Puede ver este turno? El dueño, todos. El cajero: el abierto que puede usar, y los cerrados en
/// los que participó (lo abrió, lo cerró, vendió o movió efectivo).
async fn puede_ver(c: &mut SqliteConnection, a: &Actor, t: &Turno) -> Res<()> {
    if puede(a.rol, "caja.admin") {
        return Ok(());
    }
    if !puede(a.rol, "caja") {
        return Err(sin_permiso("ver este turno"));
    }
    if t.estado == "abierto" {
        let comp = compartido(c).await;
        return puede_operar(a, t, comp).map_err(|_| sin_permiso("ver este turno"));
    }
    if t.usuario_apertura_id == a.id || t.usuario_cierre_id.as_deref() == Some(a.id.as_str()) {
        return Ok(());
    }
    let participo: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM ventas WHERE turno_id = ?1 AND usuario_id = ?2) + (SELECT COUNT(*) FROM caja_movimientos WHERE turno_id = ?1 AND usuario_id = ?2)",
    )
    .bind(&t.id)
    .bind(&a.id)
    .fetch_one(&mut *c)
    .await
    .map_err(e)?;
    if participo > 0 {
        Ok(())
    } else {
        Err(sin_permiso("ver este turno"))
    }
}

/// Detalle de un turno. Abierto: se calcula en vivo. Cerrado: lo congelado al cerrar.
pub async fn detalle(pool: &SqlitePool, a: &Actor, turno_id: &str) -> Res<Detalle> {
    a.exigir("caja", "ver la caja")?;
    let mut c = pool.acquire().await.map_err(e)?;
    let t = turno(&mut c, turno_id).await?.ok_or("Turno no encontrado")?;
    puede_ver(&mut c, a, &t).await?;
    let congelado: Option<String> = sqlx::query_scalar("SELECT totales FROM caja_turnos WHERE id = ?").bind(turno_id).fetch_one(&mut *c).await.map_err(e)?;
    let (r, bitacora_ok) = match (t.estado.as_str(), congelado.and_then(|s| serde_json::from_str::<Value>(&s).ok())) {
        ("cerrado", Some(v)) => {
            let ok = v.get("bitacoraOk").and_then(|b| b.as_bool());
            let mut r: Resumen = serde_json::from_value(v).map_err(e)?;
            if r.con_desglose {
                // Se vuelve a revisar lo congelado: si alguien lo alteró, no se imprime.
                revisar_cuadre(&mut r);
            } else {
                // Cierre de antes de la migración 9: no trae desglose que revisar.
                r.cuadra = true;
            }
            (r, ok)
        }
        _ => (resumen(&mut c, &t).await?, None),
    };
    let ve = ve_totales(a, &t);
    Ok(Detalle { resumen: if ve { r } else { sin_totales(&r) }, turno: t, ve_totales: ve, bitacora_ok })
}

// ─────────── Cierre ───────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResultadoCierre {
    pub turno_id: String,
    pub diferencia: Option<i64>,
    pub esperado: Option<i64>,
    pub contado: i64,
    pub requiere_revision: bool,
    pub bitacora_ok: bool,
    pub esperas_abiertas: i64,
}

/// Paso previo al cierre del dueño: con este conteo, ¿hace falta nota? Al cajero nunca se le
/// pregunta antes (su conteo es ciego): puede agregar la nota después de ver el resultado.
pub async fn necesita_nota(pool: &SqlitePool, a: &Actor, caja_id: &str, conteo: &Conteo) -> Res<bool> {
    a.exigir("caja", "cerrar la caja")?;
    let (contado, _) = total_conteo(conteo, &denominaciones(pool).await)?;
    let umbral = config::entero(pool, "caja_umbral_diferencia", 1000).await;
    let mut c = pool.acquire().await.map_err(e)?;
    let t = turno_abierto(&mut c, caja_id).await?.ok_or("La caja no está abierta")?;
    let comp = compartido(&mut c).await;
    puede_cerrar(a, &t, comp)?;
    if a.rol == Rol::Cajero {
        return Ok(false);
    }
    let r = resumen(&mut c, &t).await?;
    Ok(fuera_de_umbral(contado - r.efectivo_esperado, umbral))
}

pub async fn cerrar(pool: &SqlitePool, a: &Actor, caja_id: &str, conteo: &Conteo, nota: &str) -> Res<ResultadoCierre> {
    a.exigir("caja", "cerrar la caja")?;
    let (contado, detalle_conteo) = total_conteo(conteo, &denominaciones(pool).await)?;
    let nota = texto(nota, 500, "nota", false)?;
    let umbral = config::entero(pool, "caja_umbral_diferencia", 1000).await;
    let ciego = a.rol == Rol::Cajero;
    // La bitácora se verifica en cada cierre: si alguien la alteró, queda dicho en el reporte.
    let ver = bitacora::verificar(pool).await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    reloj_atrasado(&mut tx, "cerrar la caja").await?;
    let t = turno_abierto(&mut tx, caja_id).await?.ok_or("La caja no está abierta")?;
    let comp = compartido(&mut tx).await;
    puede_cerrar(a, &t, comp)?;
    let mut r = resumen(&mut tx, &t).await?;
    if a.rol == Rol::Dueno {
        r.supervisor = a.nombre.clone();
    }
    let diferencia = contado - r.efectivo_esperado;
    let requiere_revision = fuera_de_umbral(diferencia, umbral);
    if requiere_revision && !ciego && nota.chars().count() < 5 {
        return Err("NOTA_REQUERIDA: el conteo no coincide; escriba qué pasó".into());
    }
    let esperas: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ventas_espera WHERE caja_id = ? AND eliminado_en IS NULL").bind(caja_id).fetch_one(&mut *tx).await.map_err(e)?;
    let mut totales = serde_json::to_value(&r).map_err(e)?;
    totales["bitacoraOk"] = json!(ver.ok);
    totales["contado"] = json!(contado);
    totales["diferencia"] = json!(diferencia);
    let ahora = ahora_iso();
    sqlx::query(
        "UPDATE caja_turnos SET estado = 'cerrado', cerrado_en = ?, usuario_cierre_id = ?, monto_esperado = ?, monto_contado = ?, conteo_final = ?,
           diferencia = ?, totales = ?, nota_cierre = ?, diferencia_revisada_por = NULL, actualizado_en = ? WHERE id = ?",
    )
    .bind(&ahora)
    .bind(&a.id)
    .bind(r.efectivo_esperado)
    .bind(contado)
    .bind(detalle_conteo.to_string())
    .bind(diferencia)
    .bind(totales.to_string())
    .bind((!nota.is_empty()).then_some(&nota))
    .bind(&ahora)
    .bind(&t.id)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    bitacora::registrar(
        &mut tx,
        Some(&a.id),
        "caja.cerrar",
        "caja_turno",
        Some(&t.id),
        &json!({"esperado": r.efectivo_esperado, "contado": contado, "diferencia": diferencia, "ventas": r.ventas, "total": r.total_ventas, "nota": nota, "esperasAbiertas": esperas, "abrio": t.usuario_apertura_id, "cuadra": r.cuadra}),
    )
    .await?;
    if requiere_revision {
        bitacora::registrar(&mut tx, Some(&a.id), "caja.diferencia", "caja_turno", Some(&t.id), &json!({"diferencia": diferencia, "umbral": umbral})).await?;
    }
    if !ver.ok {
        bitacora::registrar(&mut tx, Some(&a.id), "bitacora.alterada", "bitacora", ver.rota_en.as_deref(), &json!({"filas": ver.filas})).await?;
    }
    tx.commit().await.map_err(e)?;
    // Ya cerrado: el conteo quedó bloqueado y todos ven el resultado completo.
    Ok(ResultadoCierre { turno_id: t.id, diferencia: Some(diferencia), esperado: Some(r.efectivo_esperado), contado, requiere_revision, bitacora_ok: ver.ok, esperas_abiertas: esperas })
}

/// Nota del cierre escrita DESPUÉS de cerrar (el cajero contó a ciegas y ve el faltante al final).
/// Solo una vez, solo quien cerró (o el dueño) y solo si no tenía nota. No toca el conteo.
pub async fn nota_cierre(pool: &SqlitePool, a: &Actor, turno_id: &str, nota: &str) -> Res<()> {
    a.exigir("caja", "anotar el cierre")?;
    let nota = texto(nota, 500, "nota", true)?;
    if nota.chars().count() < 5 {
        return Err("Escriba qué pasó (al menos 5 letras)".into());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let t = turno(&mut tx, turno_id).await?.ok_or("Turno no encontrado")?;
    if t.estado != "cerrado" || t.nota_cierre.is_some() {
        return Err("Ese cierre ya tiene nota".into());
    }
    if t.usuario_cierre_id.as_deref() != Some(a.id.as_str()) && !puede(a.rol, "caja.admin") {
        return Err(sin_permiso("anotar el cierre de otra persona"));
    }
    sqlx::query("UPDATE caja_turnos SET nota_cierre = ?, actualizado_en = ? WHERE id = ? AND nota_cierre IS NULL").bind(&nota).bind(ahora_iso()).bind(turno_id).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "caja.nota_cierre", "caja_turno", Some(turno_id), &json!({"nota": nota})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

/// Reabre un turno cerrado HOY (p. ej. se contó mal). Dueño, con PIN y motivo.
pub async fn reabrir(pool: &SqlitePool, a: &Actor, turno_id: &str, pin: &str, motivo: &str) -> Res<()> {
    let motivo = texto(motivo, 300, "motivo", true)?;
    if motivo.chars().count() < 5 {
        return Err("Escriba el motivo para reabrir".into());
    }
    let dueno = usuarios::confirmar_dueno(pool, a, pin, "reabrir caja").await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let t = turno(&mut tx, turno_id).await?.ok_or("Turno no encontrado")?;
    if t.estado != "cerrado" {
        return Err("Esa caja ya está abierta: no hace falta reabrirla.".into());
    }
    if t.dia != dia_local() {
        return Err("Solo se puede reabrir la caja del mismo día. Lo de días anteriores se corrige con un ajuste del dueño en la caja de hoy.".into());
    }
    if turno_abierto(&mut tx, &t.caja_id).await?.is_some() {
        return Err("Ya hay otra caja abierta hoy. Ciérrela primero y después reabra esta.".into());
    }
    let posteriores: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM caja_turnos WHERE caja_id = ? AND abierto_en > ? AND eliminado_en IS NULL")
        .bind(&t.caja_id)
        .bind(&t.abierto_en)
        .fetch_one(&mut *tx)
        .await
        .map_err(e)?;
    if posteriores > 0 {
        return Err("Después de esta caja ya se abrió otra: reabrirla mezclaría las ventas de los dos turnos. Corrija lo que haga falta con un ajuste en la caja actual.".into());
    }
    let antes = json!({"cerradoEn": t.cerrado_en, "cerro": t.usuario_cierre_id, "esperado": t.esperado, "contado": t.contado, "diferencia": t.diferencia, "conteo": t.conteo_final, "nota": t.nota_cierre});
    sqlx::query(
        "UPDATE caja_turnos SET estado = 'abierto', cerrado_en = NULL, usuario_cierre_id = NULL, monto_esperado = NULL, monto_contado = NULL,
           conteo_final = NULL, diferencia = NULL, totales = NULL, nota_cierre = NULL, diferencia_revisada_por = NULL, reimpresiones = 0,
           actualizado_en = ? WHERE id = ?",
    )
    .bind(ahora_iso())
    .bind(turno_id)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "caja.reabrir", "caja_turno", Some(turno_id), &json!({"motivo": motivo, "autorizadoPor": dueno, "cierreAnterior": antes})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

pub async fn marcar_revisada(pool: &SqlitePool, a: &Actor, turno_id: &str) -> Res<()> {
    a.exigir("caja.admin", "revisar diferencias")?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let n = sqlx::query("UPDATE caja_turnos SET diferencia_revisada_por = ?, actualizado_en = ? WHERE id = ? AND estado = 'cerrado' AND diferencia_revisada_por IS NULL")
        .bind(&a.id)
        .bind(ahora_iso())
        .bind(turno_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?
        .rows_affected();
    if n == 0 {
        return Err("Ese turno no tiene una diferencia por revisar".into());
    }
    bitacora::registrar(&mut tx, Some(&a.id), "caja.diferencia_revisada", "caja_turno", Some(turno_id), &json!({})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

// ─────────── Reporte Z ───────────

/// Datos del Z de un turno cerrado y si la próxima impresión es COPIA (la primera es el original).
pub async fn datos_z(pool: &SqlitePool, a: &Actor, turno_id: &str) -> Res<(Detalle, bool)> {
    let d = detalle(pool, a, turno_id).await?;
    if d.turno.estado != "cerrado" {
        return Err("El reporte Z sale al cerrar la caja".into());
    }
    let copia = d.turno.reimpresiones > 0;
    Ok((d, copia))
}

/// Imprime el Z (y, si se eligió, un tiquete por departamento) en la impresora de cierres.
/// El original sale una vez; las siguientes son COPIA: llevan la marca y piden el PIN del dueño.
/// Si los totales no cuadran, no se imprime.
pub async fn imprimir_z(pool: &SqlitePool, a: &Actor, turno_id: &str, documentos: &[Vec<u8>], pin: Option<&str>) -> Res<bool> {
    let (d, copia) = datos_z(pool, a, turno_id).await?;
    if !d.resumen.cuadra {
        return Err(format!("Los totales del cierre no cuadran ({}). No se imprimió para no dar números inconsistentes: avise al técnico.", d.resumen.descuadres.join("; ")));
    }
    if documentos.is_empty() || documentos.len() > 60 {
        return Err("No hay nada que imprimir".into());
    }
    let mut bytes = Vec::new();
    for doc in documentos {
        escpos::validar(doc)?;
        if copia && !escpos::tiene_marca_copia(doc) {
            return Err("La reimpresión del cierre debe salir marcada como COPIA".into());
        }
        bytes.extend_from_slice(doc);
    }
    let autorizado = if copia {
        let p = pin.filter(|p| !p.is_empty()).ok_or("Reimprimir el cierre (COPIA) necesita el PIN del dueño")?;
        Some(usuarios::autorizar_dueno(pool, p, "reimprimir cierre", &a.id).await?)
    } else {
        None
    };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let previas: i64 = sqlx::query_scalar("SELECT reimpresiones FROM caja_turnos WHERE id = ?").bind(turno_id).fetch_one(&mut *tx).await.map_err(e)?;
    if (previas > 0) != copia {
        return Err("El cierre se imprimió desde otra pantalla mientras tanto. Vuelva a intentarlo.".into());
    }
    let impresora = impresoras::enviar_con(&mut tx, &d.turno.caja_id, "cierre", &bytes).await?;
    sqlx::query("UPDATE caja_turnos SET reimpresiones = reimpresiones + 1 WHERE id = ?").bind(turno_id).execute(&mut *tx).await.map_err(e)?;
    let accion = if copia { "caja.z_reimprimir" } else { "caja.z_imprimir" };
    bitacora::registrar(&mut tx, Some(&a.id), accion, "caja_turno", Some(turno_id), &json!({"vez": previas + 1, "documentos": documentos.len(), "impresora": impresora, "autorizadoPor": autorizado})).await?;
    tx.commit().await.map_err(e)?;
    Ok(copia)
}

// ─────────── Cortes parciales ───────────

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Retiro {
    pub monto: i64,
    pub categoria: String,
    #[serde(default)]
    pub nota: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Corte {
    pub id: String,
    pub fecha: String,
    pub usuario: String,
    pub turno: Turno,
    /// Acumulado del turno al momento del corte (antes del retiro).
    pub resumen: Resumen,
    pub retiro: i64,
    pub efectivo_despues: i64,
}

/// Corte: el dueño ve (e imprime) el acumulado del turno por forma de pago sin cerrarlo. Si quiere,
/// retira efectivo (salida con motivo y su PIN). Queda en la bitácora y en el Z final.
pub async fn corte(pool: &SqlitePool, a: &Actor, caja_id: &str, retiro: Option<&Retiro>, pin: Option<&str>) -> Res<Corte> {
    a.exigir("caja.admin", "hacer cortes de caja")?;
    let mut ret: Option<(Retiro, String)> = None;
    if let Some(r) = retiro.filter(|r| r.monto != 0) {
        if !(1..=100_000_000).contains(&r.monto) {
            return Err("Escriba el monto del retiro en colones, sin decimales.".into());
        }
        let categoria = texto(&r.categoria, 60, "motivo", true)?;
        let nota = texto(&r.nota, 200, "nota", false)?;
        let motivos = config::valor(pool, "caja_motivos").await.unwrap_or(Value::Null);
        if !motivo_permitido(&motivos, "salida", &categoria) {
            return Err("Elija un motivo de la lista".into());
        }
        let dueno = usuarios::confirmar_dueno(pool, a, pin.unwrap_or(""), "retiro de efectivo en corte").await?;
        ret = Some((Retiro { monto: r.monto, categoria, nota }, dueno));
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let t = turno_abierto(&mut tx, caja_id).await?.ok_or("La caja está cerrada: no hay turno para el corte.")?;
    let r = resumen(&mut tx, &t).await?;
    let id = ulid();
    let ahora = ahora_iso();
    let mut retiro_monto = 0;
    let mut mov_id = None;
    if let Some((x, dueno)) = &ret {
        if x.monto > r.efectivo_esperado {
            return Err(format!("No hay tanto efectivo en la caja (esperado {}).", colones(r.efectivo_esperado)));
        }
        mov_id = Some(insertar_movimiento(&mut tx, &t, a, "salida", x.monto, &x.categoria, &if x.nota.is_empty() { "Retiro en corte".to_string() } else { x.nota.clone() }, Some(dueno)).await?);
        retiro_monto = x.monto;
    }
    let por_forma = json!(r.por_forma.iter().map(|f| json!({"forma": f.nombre, "codigo": f.codigo, "pagos": f.pagos, "monto": f.monto})).collect::<Vec<_>>());
    sqlx::query(
        "INSERT INTO caja_cortes (id, sucursal_id, caja_id, turno_id, usuario_id, fecha, ventas, total, efectivo_esperado, totales, retiro, retiro_movimiento_id, creado_en)
         SELECT ?, sucursal_id, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM cajas WHERE id = ?",
    )
    .bind(&id)
    .bind(&t.id)
    .bind(&a.id)
    .bind(&ahora)
    .bind(r.ventas)
    .bind(r.total_ventas)
    .bind(r.efectivo_esperado)
    .bind(por_forma.to_string())
    .bind(retiro_monto)
    .bind(&mov_id)
    .bind(&ahora)
    .bind(&t.caja_id)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "caja.corte", "caja_turno", Some(&t.id), &json!({"corteId": id, "ventas": r.ventas, "total": r.total_ventas, "esperado": r.efectivo_esperado, "retiro": retiro_monto})).await?;
    tx.commit().await.map_err(e)?;
    Ok(Corte { id, fecha: ahora, usuario: a.nombre.clone(), efectivo_despues: r.efectivo_esperado - retiro_monto, turno: t, resumen: r, retiro: retiro_monto })
}

// ─────────── Historial ───────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TurnoFila {
    #[serde(flatten)]
    pub turno: Turno,
    /// None para el cajero mientras el turno está abierto.
    pub ventas: Option<i64>,
    pub total: Option<i64>,
    pub pendiente_revision: bool,
    pub no_ventas: i64,
    /// Más aperturas sin venta que el umbral configurado.
    pub alerta_no_ventas: bool,
}

/// Historial: el dueño ve todos; el cajero, el abierto que usa y los cerrados en que participó.
/// Al cajero no le llegan las ventas ni el total del turno abierto.
pub async fn listar(pool: &SqlitePool, a: &Actor, caja_id: &str, desde: &str, hasta: &str) -> Res<Vec<TurnoFila>> {
    a.exigir("caja", "ver turnos")?;
    let admin = puede(a.rol, "caja.admin");
    let umbral = config::entero(pool, "caja_umbral_diferencia", 1000).await;
    let umbral_nv = config::entero(pool, "caja_no_venta_umbral", 5).await;
    let mut c = pool.acquire().await.map_err(e)?;
    let comp = compartido(&mut c).await;
    let filas = sqlx::query(&format!(
        "{SELECT_TURNO} WHERE t.caja_id = ?1 AND t.eliminado_en IS NULL AND t.dia >= ?2 AND t.dia <= ?3
           AND (?4 = 1 OR t.estado = 'abierto' OR t.usuario_apertura_id = ?5 OR t.usuario_cierre_id = ?5
                OR EXISTS (SELECT 1 FROM ventas v WHERE v.turno_id = t.id AND v.usuario_id = ?5)
                OR EXISTS (SELECT 1 FROM caja_movimientos m WHERE m.turno_id = t.id AND m.usuario_id = ?5))
         ORDER BY t.abierto_en DESC LIMIT 400"
    ))
    .bind(caja_id)
    .bind(desde)
    .bind(hasta)
    .bind(admin as i64)
    .bind(&a.id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    let mut out = Vec::new();
    for f in &filas {
        let t = a_turno(f);
        if t.estado == "abierto" && !admin && puede_operar(a, &t, comp).is_err() {
            continue;
        }
        let (n, total): (i64, i64) = sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(total), 0) FROM ventas WHERE turno_id = ? AND estado = 'completada' AND eliminado_en IS NULL")
            .bind(&t.id)
            .fetch_one(&mut *c)
            .await
            .map_err(e)?;
        let nv: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM gaveta_aperturas WHERE turno_id = ?").bind(&t.id).fetch_one(&mut *c).await.map_err(e)?;
        let pendiente = t.revisada_por.is_none() && t.diferencia.is_some_and(|d| fuera_de_umbral(d, umbral));
        let ve = ve_totales(a, &t);
        out.push(TurnoFila { ventas: ve.then_some(n), total: ve.then_some(total), pendiente_revision: pendiente && admin, no_ventas: nv, alerta_no_ventas: umbral_nv > 0 && nv >= umbral_nv, turno: t });
    }
    Ok(out)
}

/// Primer número de tiquete de la caja (para seguir después del último del sistema anterior).
/// Solo dueño o técnico, solo antes de la primera venta de la caja, y queda en la bitácora.
pub async fn fijar_consecutivo(pool: &SqlitePool, a: &Actor, caja_id: &str, numero: i64) -> Res<()> {
    if !puede(a.rol, "caja.admin") && !puede(a.rol, "config.tecnica") {
        return Err(sin_permiso("cambiar el número de tiquete"));
    }
    if !(1..=999_999_999).contains(&numero) {
        return Err("El número de tiquete va de 1 a 999.999.999".into());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let ventas: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ventas WHERE caja_id = ?").bind(caja_id).fetch_one(&mut *tx).await.map_err(e)?;
    if ventas > 0 {
        return Err("La caja ya tiene ventas: el número de tiquete solo se fija antes de la primera venta (si no, se repetirían o saltarían números ya entregados).".into());
    }
    let antes: i64 = sqlx::query_scalar("SELECT consecutivo_siguiente FROM cajas WHERE id = ?").bind(caja_id).fetch_optional(&mut *tx).await.map_err(e)?.ok_or("Caja no encontrada")?;
    sqlx::query("UPDATE cajas SET consecutivo_siguiente = ?, actualizado_en = ? WHERE id = ?").bind(numero).bind(ahora_iso()).bind(caja_id).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "caja.consecutivo", "caja", Some(caja_id), &json!({"antes": antes, "despues": numero})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::usuarios::tests::base_con_usuarios;

    pub fn conteo(pares: &[(i64, i64)]) -> Conteo {
        Conteo { cantidades: pares.iter().map(|(d, n)| (d.to_string(), *n)).collect(), total: None }
    }

    #[tokio::test]
    async fn abrir_movimientos_y_cerrar() {
        let (bd, tec, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        // El técnico no toca la caja.
        assert!(abrir(p, &tec, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap_err().contains("permiso"));
        // Denominación que no existe: rechazada.
        assert!(abrir(p, &cajero, CAJA_1, &conteo(&[(3000, 1)])).await.is_err());
        let t = abrir(p, &cajero, CAJA_1, &conteo(&[(10000, 2), (1000, 5), (500, 4)])).await.unwrap();
        assert_eq!(t.fondo, 27000);
        // Solo un turno abierto por caja (el dueño puede usar ese mismo).
        assert!(abrir(p, &dueno, CAJA_1, &conteo(&[])).await.unwrap_err().contains("mismo turno"));

        let entrada = NuevoMovimiento { tipo: "entrada".into(), monto: 3000, categoria: "Ingreso de cambio".into(), nota: String::new() };
        movimiento(p, &cajero, CAJA_1, &entrada, None).await.unwrap();
        // Motivo fuera de la lista: no.
        let raro = NuevoMovimiento { tipo: "salida".into(), monto: 100, categoria: "Lo que sea".into(), nota: String::new() };
        assert!(movimiento(p, &cajero, CAJA_1, &raro, None).await.is_err());
        // Salida sobre el tope: PIN del dueño (el del cajero no sirve).
        let grande = NuevoMovimiento { tipo: "salida".into(), monto: 25000, categoria: "Retiro de dinero".into(), nota: String::new() };
        assert!(movimiento(p, &cajero, CAJA_1, &grande, None).await.unwrap_err().contains("PIN"));
        assert!(movimiento(p, &cajero, CAJA_1, &grande, Some("2580")).await.is_err());
        movimiento(p, &cajero, CAJA_1, &grande, Some("246813")).await.unwrap();
        // Más de lo que hay: no, y como el cajero no ve lo esperado, el intento queda en la bitácora.
        let mucho = NuevoMovimiento { tipo: "salida".into(), monto: 6000, categoria: "Gasto menor".into(), nota: String::new() };
        assert!(movimiento(p, &cajero, CAJA_1, &mucho, None).await.unwrap_err().contains("efectivo"));
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'caja.salida_rechazada'").fetch_one(p).await.unwrap();
        assert_eq!(n, 1);

        assert_eq!(detalle(p, &dueno, &t.id).await.unwrap().resumen.efectivo_esperado, 27000 + 3000 - 25000);

        // El cajero cuenta a ciegas: no ve lo esperado ni antes de confirmar.
        let mal = conteo(&[(1000, 3)]);
        assert!(!necesita_nota(p, &cajero, CAJA_1, &mal).await.unwrap());
        let r = cerrar(p, &cajero, CAJA_1, &mal, "").await.unwrap();
        // Cerrado: ve el resultado completo y la diferencia queda para revisión.
        assert_eq!(r.diferencia, Some(-2000));
        assert!(r.requiere_revision && r.bitacora_ok);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'caja.diferencia'").fetch_one(p).await.unwrap();
        assert_eq!(n, 1);
        // Puede anotar qué pasó después de ver el resultado (una vez).
        nota_cierre(p, &cajero, &t.id, "Se dio mal un vuelto").await.unwrap();
        assert!(nota_cierre(p, &cajero, &t.id, "Otra nota más").await.is_err());

        // Reabrir: solo el dueño, con PIN y motivo, mismo día.
        assert!(reabrir(p, &cajero, &t.id, "246813", "contó mal").await.unwrap_err().contains("permiso"));
        assert!(reabrir(p, &dueno, &t.id, "000000", "contó mal").await.is_err());
        reabrir(p, &dueno, &t.id, "246813", "Contó mal los billetes").await.unwrap();
        // Si ya lo contó antes, escribe el total de una vez (sin volver a contar billete por billete).
        let r = cerrar(p, &cajero, CAJA_1, &Conteo { cantidades: Default::default(), total: Some(5000) }, "").await.unwrap();
        assert_eq!(r.diferencia, Some(0));
        assert!(!r.requiere_revision);
        // Z del cierre nuevo: el primero sale como original; los siguientes, COPIA.
        assert!(!datos_z(p, &cajero, &t.id).await.unwrap().1);
    }

    #[tokio::test]
    async fn conteo_bloqueado_despues_de_cerrar() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let t = abrir(p, &cajero, CAJA_1, &conteo(&[(5000, 1)])).await.unwrap();
        cerrar(p, &cajero, CAJA_1, &conteo(&[(5000, 1)]), "").await.unwrap();
        // Ni por la base se cambia el conteo de un turno cerrado.
        for sql in ["UPDATE caja_turnos SET monto_contado = 9999 WHERE id = ?", "UPDATE caja_turnos SET conteo_final = '{}' WHERE id = ?", "UPDATE caja_turnos SET diferencia = 0 WHERE id = ?"] {
            assert!(sqlx::query(sql).bind(&t.id).execute(p).await.unwrap_err().to_string().contains("conteo"), "{sql}");
        }
        // Cerrar otra vez (volver a contar) tampoco: ya no hay turno abierto.
        assert!(cerrar(p, &cajero, CAJA_1, &conteo(&[(5000, 2)]), "").await.is_err());
        // Solo reabrir (dueño, PIN, motivo) deja contar de nuevo.
        reabrir(p, &dueno, &t.id, "246813", "Contó mal los billetes").await.unwrap();
        assert_eq!(cerrar(p, &cajero, CAJA_1, &conteo(&[(5000, 1)]), "").await.unwrap().contado, 5000);
        // Turno de ayer: no se reabre.
        sqlx::query("UPDATE caja_turnos SET dia = '2000-01-01' WHERE id = ?").bind(&t.id).execute(p).await.unwrap();
        assert!(reabrir(p, &dueno, &t.id, "246813", "Quiero reabrir").await.unwrap_err().contains("mismo día"));
    }

    #[test]
    fn umbral_cero_no_marca_un_cierre_que_cuadra() {
        assert!(!fuera_de_umbral(0, 0));
        assert!(fuera_de_umbral(-5, 0));
        assert!(!fuera_de_umbral(-999, 1000));
        assert!(fuera_de_umbral(1000, 1000));
    }

    #[tokio::test]
    async fn no_abre_con_el_reloj_atrasado() {
        let (bd, _, _, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let t = abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 1)])).await.unwrap();
        cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 1)]), "").await.unwrap();
        // Lo último registrado quedó "en el futuro": el reloj se atrasó después.
        sqlx::query("UPDATE caja_turnos SET cerrado_en = '2999-01-01T00:00:00.000Z' WHERE id = ?").bind(&t.id).execute(p).await.unwrap();
        assert!(abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 1)])).await.unwrap_err().contains("atrasada"));
    }

    #[tokio::test]
    async fn da_vuelto_no_cambia_con_la_caja_abierta() {
        let (bd, _, _, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let cambiar = |v: i64| sqlx::query("UPDATE formas_pago SET da_vuelto = ? WHERE id = '0000000000000000000000FP01'").bind(v).execute(p);
        abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 1)])).await.unwrap();
        // Abierta: quitarle "da vuelto" a Efectivo movería el esperado de lo ya cobrado.
        assert!(cambiar(0).await.unwrap_err().to_string().contains("Cierre la caja"));
        // Otros cambios de la forma sí pasan.
        sqlx::query("UPDATE formas_pago SET orden = 9 WHERE id = '0000000000000000000000FP01'").execute(p).await.unwrap();
        cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 1)]), "").await.unwrap();
        cambiar(0).await.unwrap();
    }

    #[tokio::test]
    async fn turno_por_persona_si_no_es_compartido() {
        let (bd, tec, dueno, luis) = base_con_usuarios().await;
        let p = &bd.pool;
        config::guardar(p, &dueno, "caja_turno_compartido", &json!(false)).await.unwrap();
        let m = usuarios::crear(p, &tec, "María", Rol::Cajero, "1357").await.unwrap();
        let maria = Actor { id: m.id, rol: Rol::Cajero, nombre: "María".into() };
        let t1 = abrir(p, &luis, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        // María no abre encima, no mueve efectivo, no cierra ni ve el turno de Luis. El dueño tampoco opera en él.
        assert!(abrir(p, &maria, CAJA_1, &conteo(&[])).await.unwrap_err().contains("Luis"));
        let entrada = NuevoMovimiento { tipo: "entrada".into(), monto: 3000, categoria: "Ingreso de cambio".into(), nota: String::new() };
        assert!(movimiento(p, &maria, CAJA_1, &entrada, None).await.unwrap_err().contains("Luis"));
        assert!(movimiento(p, &dueno, CAJA_1, &entrada, None).await.unwrap_err().contains("Luis"));
        assert!(cerrar(p, &maria, CAJA_1, &conteo(&[(1000, 5)]), "").await.unwrap_err().contains("Luis"));
        assert!(detalle(p, &maria, &t1.id).await.unwrap_err().contains("permiso"));
        let e = estado(p, &maria, CAJA_1).await.unwrap();
        assert!(!e.puede_usar && !e.compartido);
        // Cambio de turno: Luis cierra con su conteo, María abre el suyo.
        assert_eq!(cerrar(p, &luis, CAJA_1, &conteo(&[(1000, 5)]), "").await.unwrap().diferencia, Some(0));
        let t2 = abrir(p, &maria, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        // El dueño sí puede cerrar el turno de otro (p. ej. si se fue sin cerrar).
        cerrar(p, &dueno, CAJA_1, &conteo(&[(1000, 5)]), "").await.unwrap();
        // Ya hubo un turno después del de Luis: reabrirlo mezclaría ventas. El último sí.
        assert!(reabrir(p, &dueno, &t1.id, "246813", "Contó mal los billetes").await.unwrap_err().contains("Después"));
        reabrir(p, &dueno, &t2.id, "246813", "Contó mal los billetes").await.unwrap();
    }

    #[tokio::test]
    async fn corte_parcial_con_retiro() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let t = abrir(p, &cajero, CAJA_1, &conteo(&[(10000, 3)])).await.unwrap();
        // El cajero no hace cortes.
        assert!(corte(p, &cajero, CAJA_1, None, None).await.unwrap_err().contains("permiso"));
        let c1 = corte(p, &dueno, CAJA_1, None, None).await.unwrap();
        assert_eq!((c1.retiro, c1.efectivo_despues), (0, 30000));
        let retiro = Retiro { monto: 20000, categoria: "Retiro de dinero".into(), nota: String::new() };
        // Retiro sin PIN o con PIN malo: no.
        assert!(corte(p, &dueno, CAJA_1, Some(&retiro), None).await.is_err());
        assert!(corte(p, &dueno, CAJA_1, Some(&retiro), Some("000000")).await.is_err());
        let c2 = corte(p, &dueno, CAJA_1, Some(&retiro), Some("246813")).await.unwrap();
        assert_eq!(c2.efectivo_despues, 10000);
        let d = detalle(p, &dueno, &t.id).await.unwrap();
        assert_eq!(d.resumen.cortes.len(), 2);
        assert_eq!(d.resumen.salidas, 20000);
        assert_eq!(d.resumen.movimientos[0].autorizado_por.as_deref(), Some("Ana"));
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'caja.corte'").fetch_one(p).await.unwrap();
        assert_eq!(n, 2);
    }
}
