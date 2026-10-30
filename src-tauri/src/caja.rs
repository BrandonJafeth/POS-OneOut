// Turnos de caja: apertura con conteo, entradas/salidas, arqueo y cierre, reapertura e historial.
//
// Reglas (las decide Rust, no la pantalla):
// - Un solo turno abierto por caja (además lo garantiza un índice único en la base).
// - Sin turno abierto de HOY no se vende; si quedó abierto uno de un día anterior, primero se cierra.
// - Efectivo esperado = fondo + cobrado en efectivo (ya sin vuelto) + entradas − salidas.
// - Diferencia = contado − esperado. Desde el umbral exige nota y queda para revisión del dueño.
// - Reabrir: solo el dueño, con PIN y motivo, y solo el mismo día.
// - Lo que se corrige de un turno ya cerrado no lo toca: queda como ajuste en el turno actual.

use crate::bitacora;
use crate::config;
use crate::permisos::{puede, sin_permiso, Rol};
use crate::sesion::Actor;
use crate::usuarios;
use crate::util::{ahora_iso, dia_local, e, texto, ulid, Res};
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

const SELECT_TURNO: &str = "SELECT t.*, ua.nombre AS u_apertura, uc.nombre AS u_cierre FROM caja_turnos t
    JOIN usuarios ua ON ua.id = t.usuario_apertura_id LEFT JOIN usuarios uc ON uc.id = t.usuario_cierre_id";

fn json_o_null(s: Option<String>) -> Option<Value> {
    s.and_then(|v| serde_json::from_str(&v).ok())
}

fn a_turno(f: &sqlx::sqlite::SqliteRow) -> Turno {
    Turno {
        id: f.get("id"),
        caja_id: f.get("caja_id"),
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

/// El turno donde se puede vender ahora: abierto y de hoy.
pub async fn turno_para_vender(c: &mut SqliteConnection, caja_id: &str) -> Res<Turno> {
    match turno_abierto(c, caja_id).await? {
        None => Err("La caja está cerrada: ábrala para vender".into()),
        Some(t) if t.dia != dia_local() => Err("Quedó abierta la caja de un día anterior: ciérrela antes de vender".into()),
        Some(t) => Ok(t),
    }
}

// ─────────── Conteo por denominaciones ───────────

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Conteo {
    /// denominación (como texto, viene de JSON) → cantidad de billetes/monedas
    pub cantidades: BTreeMap<String, i64>,
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
    let mut total = 0i64;
    let mut limpio = serde_json::Map::new();
    for (k, n) in &c.cantidades {
        let d: i64 = k.parse().map_err(|_| "Denominación inválida".to_string())?;
        if !validas.contains(&d) {
            return Err(format!("¢{d} no es una denominación configurada"));
        }
        if !(0..=100_000).contains(n) {
            return Err("Cantidad inválida en el conteo".into());
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
    pub cierre_ciego: bool,
    pub denominaciones: Vec<i64>,
    pub motivos: Value,
    pub salida_max_sin_pin: i64,
    pub umbral_diferencia: i64,
}

pub async fn estado(pool: &SqlitePool, a: &Actor, caja_id: &str) -> Res<EstadoCaja> {
    a.exigir("caja", "usar la caja")?;
    let t = {
        let mut c = pool.acquire().await.map_err(e)?;
        turno_abierto(&mut c, caja_id).await?
    };
    Ok(EstadoCaja {
        de_otro_dia: t.as_ref().is_some_and(|t| t.dia != dia_local()),
        turno: t,
        cierre_ciego: config::booleano(pool, "caja_cierre_ciego", false).await,
        denominaciones: denominaciones(pool).await,
        motivos: config::valor(pool, "caja_motivos").await.unwrap_or(json!({"salida": [], "entrada": []})),
        salida_max_sin_pin: config::entero(pool, "caja_salida_max_sin_pin", 20000).await,
        umbral_diferencia: config::entero(pool, "caja_umbral_diferencia", 1000).await,
    })
}

pub async fn abrir(pool: &SqlitePool, a: &Actor, caja_id: &str, conteo: &Conteo) -> Res<Turno> {
    a.exigir("caja", "abrir la caja")?;
    let (fondo, detalle) = total_conteo(conteo, &denominaciones(pool).await)?;
    let id = ulid();
    let ahora = ahora_iso();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    if let Some(t) = turno_abierto(&mut tx, caja_id).await? {
        return Err(if t.dia == dia_local() { "La caja ya está abierta".into() } else { "Quedó abierta la caja de un día anterior: ciérrela primero".into() });
    }
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

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
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

pub async fn movimiento(pool: &SqlitePool, a: &Actor, caja_id: &str, m: &NuevoMovimiento, pin_dueno: Option<&str>) -> Res<String> {
    a.exigir("caja", "registrar entradas o salidas")?;
    if m.tipo != "entrada" && m.tipo != "salida" {
        return Err("Tipo de movimiento inválido".into());
    }
    if !(1..=100_000_000).contains(&m.monto) {
        return Err("Monto inválido".into());
    }
    let categoria = texto(&m.categoria, 60, "motivo", true)?;
    let nota = texto(&m.nota, 200, "nota", false)?;
    let motivos = config::valor(pool, "caja_motivos").await.unwrap_or(Value::Null);
    let permitidos: Vec<&str> = motivos.get(&m.tipo).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
    if !permitidos.contains(&categoria.as_str()) {
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
    let t = turno_abierto(&mut tx, caja_id).await?.ok_or("La caja está cerrada")?;
    if m.tipo == "salida" {
        let r = resumen(&mut tx, &t).await?;
        if m.monto > r.efectivo_esperado {
            return Err("No hay tanto efectivo en la caja".into());
        }
    }
    let id = insertar_movimiento(&mut tx, &t, a, &m.tipo, m.monto, &categoria, &nota, autorizado.as_deref()).await?;
    tx.commit().await.map_err(e)?;
    Ok(id)
}

// ─────────── Resumen (lo esperado) ───────────

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PorForma {
    pub forma_pago_id: String,
    pub nombre: String,
    pub tipo: String,
    pub da_vuelto: bool,
    pub pagos: i64,
    pub monto: i64,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
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

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Resumen {
    pub fondo: i64,
    pub ventas: i64,
    pub total_ventas: i64,
    pub descuentos: i64,
    pub anuladas: i64,
    pub total_anuladas: i64,
    pub por_forma: Vec<PorForma>,
    /// Efectivo entregado por los clientes y vuelto dado (informativo: el neto ya está en por_forma).
    pub recibido_efectivo: i64,
    pub vueltos: i64,
    pub ventas_efectivo: i64,
    pub entradas: i64,
    pub salidas: i64,
    pub efectivo_esperado: i64,
    pub movimientos: Vec<Movimiento>,
    pub ajustes: Vec<AjusteResumen>,
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
        descuentos: v.get("desc"),
        anuladas: v.get("na"),
        total_anuladas: v.get("ta"),
        ..Default::default()
    };
    for f in &formas {
        let da_vuelto = f.get::<i64, _>("da_vuelto") == 1;
        let monto: i64 = f.get("monto");
        if da_vuelto {
            r.ventas_efectivo += monto;
            r.recibido_efectivo += f.get::<i64, _>("recibido");
            r.vueltos += f.get::<i64, _>("vuelto");
        }
        r.por_forma.push(PorForma { forma_pago_id: f.get("id"), nombre: f.get("nombre"), tipo: f.get("tipo"), da_vuelto, pagos: f.get("n"), monto });
    }
    let movs = sqlx::query(
        "SELECT m.id, m.tipo, m.monto, m.categoria, m.motivo, m.fecha, u.nombre AS usuario, m.autorizado_por
         FROM caja_movimientos m JOIN usuarios u ON u.id = m.usuario_id WHERE m.turno_id = ? AND m.eliminado_en IS NULL ORDER BY m.fecha, m.id",
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
            autorizado_por: m.get("autorizado_por"),
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
    // Los ajustes no cambian el efectivo de este turno: una devolución en efectivo entra como salida.
    r.efectivo_esperado = r.fondo + r.ventas_efectivo + r.entradas - r.salidas;
    Ok(r)
}

/// ¿Puede este usuario ver lo esperado? En cierre ciego el cajero no lo ve (ni antes ni después).
async fn ve_esperado(pool: &SqlitePool, a: &Actor) -> bool {
    a.rol != Rol::Cajero || !config::booleano(pool, "caja_cierre_ciego", false).await
}

fn ocultar_esperado(r: &mut Resumen) {
    r.efectivo_esperado = 0;
    r.ventas_efectivo = 0;
    r.recibido_efectivo = 0;
    r.vueltos = 0;
    r.por_forma.clear();
    r.total_ventas = 0;
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Detalle {
    pub turno: Turno,
    pub resumen: Resumen,
    /// false en cierre ciego para el cajero: la pantalla no muestra esperado ni diferencia.
    pub ve_esperado: bool,
    pub bitacora_ok: Option<bool>,
}

fn puede_ver(a: &Actor, t: &Turno) -> Res<()> {
    if puede(a.rol, "caja.admin") || (puede(a.rol, "caja") && t.usuario_apertura_id == a.id) {
        Ok(())
    } else {
        Err(sin_permiso("ver este turno"))
    }
}

/// Detalle de un turno. Abierto: se calcula en vivo. Cerrado: lo congelado al cerrar.
pub async fn detalle(pool: &SqlitePool, a: &Actor, turno_id: &str) -> Res<Detalle> {
    a.exigir("caja", "ver la caja")?;
    let mut c = pool.acquire().await.map_err(e)?;
    let mut t = turno(&mut c, turno_id).await?.ok_or("Turno no encontrado")?;
    // El turno abierto lo ve cualquiera con caja (es la caja de hoy); los cerrados, el suyo o el dueño.
    if t.estado == "cerrado" {
        puede_ver(a, &t)?;
    }
    let congelado: Option<String> = sqlx::query_scalar("SELECT totales FROM caja_turnos WHERE id = ?").bind(turno_id).fetch_one(&mut *c).await.map_err(e)?;
    let (mut r, bitacora_ok) = match (t.estado.as_str(), congelado.and_then(|s| serde_json::from_str::<Value>(&s).ok())) {
        ("cerrado", Some(v)) => (resumen_de_json(&v), v.get("bitacoraOk").and_then(|b| b.as_bool())),
        _ => (resumen(&mut c, &t).await?, None),
    };
    drop(c);
    let ve = ve_esperado(pool, a).await;
    if !ve {
        ocultar_esperado(&mut r);
        t.esperado = None;
        t.diferencia = None;
    }
    Ok(Detalle { turno: t, resumen: r, ve_esperado: ve, bitacora_ok })
}

fn resumen_de_json(v: &Value) -> Resumen {
    let n = |k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    let por_forma = v.get("porForma").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let movs = v.get("movimientos").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let ajs = v.get("ajustes").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let s = |o: &Value, k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let i = |o: &Value, k: &str| o.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    Resumen {
        fondo: n("fondo"),
        ventas: n("ventas"),
        total_ventas: n("totalVentas"),
        descuentos: n("descuentos"),
        anuladas: n("anuladas"),
        total_anuladas: n("totalAnuladas"),
        recibido_efectivo: n("recibidoEfectivo"),
        vueltos: n("vueltos"),
        ventas_efectivo: n("ventasEfectivo"),
        entradas: n("entradas"),
        salidas: n("salidas"),
        efectivo_esperado: n("efectivoEsperado"),
        por_forma: por_forma
            .iter()
            .map(|f| PorForma { forma_pago_id: s(f, "formaPagoId"), nombre: s(f, "nombre"), tipo: s(f, "tipo"), da_vuelto: f.get("daVuelto").and_then(|b| b.as_bool()).unwrap_or(false), pagos: i(f, "pagos"), monto: i(f, "monto") })
            .collect(),
        movimientos: movs
            .iter()
            .map(|m| Movimiento { id: s(m, "id"), tipo: s(m, "tipo"), monto: i(m, "monto"), categoria: s(m, "categoria"), motivo: s(m, "motivo"), usuario: s(m, "usuario"), autorizado_por: m.get("autorizadoPor").and_then(|x| x.as_str()).map(String::from), fecha: s(m, "fecha") })
            .collect(),
        ajustes: ajs
            .iter()
            .map(|a| AjusteResumen { id: s(a, "id"), tipo: s(a, "tipo"), venta_numero: s(a, "ventaNumero"), monto: i(a, "monto"), motivo: s(a, "motivo"), antes: a.get("antes").cloned().unwrap_or(Value::Null), despues: a.get("despues").cloned().unwrap_or(Value::Null), usuario: s(a, "usuario"), fecha: s(a, "fecha") })
            .collect(),
    }
}

// ─────────── Cierre ───────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResultadoCierre {
    pub turno_id: String,
    /// None en cierre ciego para el cajero.
    pub diferencia: Option<i64>,
    pub esperado: Option<i64>,
    pub contado: i64,
    pub requiere_revision: bool,
    pub bitacora_ok: bool,
    pub esperas_abiertas: i64,
}

/// Paso previo al cierre: con este conteo, ¿hace falta nota? (no revela lo esperado en cierre ciego).
pub async fn necesita_nota(pool: &SqlitePool, a: &Actor, caja_id: &str, conteo: &Conteo) -> Res<bool> {
    a.exigir("caja", "cerrar la caja")?;
    let (contado, _) = total_conteo(conteo, &denominaciones(pool).await)?;
    let umbral = config::entero(pool, "caja_umbral_diferencia", 1000).await;
    let mut c = pool.acquire().await.map_err(e)?;
    let t = turno_abierto(&mut c, caja_id).await?.ok_or("La caja no está abierta")?;
    let r = resumen(&mut c, &t).await?;
    Ok((contado - r.efectivo_esperado).abs() >= umbral)
}

pub async fn cerrar(pool: &SqlitePool, a: &Actor, caja_id: &str, conteo: &Conteo, nota: &str) -> Res<ResultadoCierre> {
    a.exigir("caja", "cerrar la caja")?;
    let (contado, detalle_conteo) = total_conteo(conteo, &denominaciones(pool).await)?;
    let nota = texto(nota, 500, "nota", false)?;
    let umbral = config::entero(pool, "caja_umbral_diferencia", 1000).await;
    // La bitácora se verifica en cada cierre: si alguien la alteró, queda dicho en el reporte.
    let ver = bitacora::verificar(pool).await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let t = turno_abierto(&mut tx, caja_id).await?.ok_or("La caja no está abierta")?;
    if t.usuario_apertura_id != a.id && !puede(a.rol, "caja.admin") {
        return Err("Solo quien abrió la caja o el dueño la pueden cerrar".into());
    }
    let r = resumen(&mut tx, &t).await?;
    let diferencia = contado - r.efectivo_esperado;
    let requiere_revision = diferencia.abs() >= umbral;
    if requiere_revision && nota.chars().count() < 5 {
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
        &json!({"esperado": r.efectivo_esperado, "contado": contado, "diferencia": diferencia, "ventas": r.ventas, "total": r.total_ventas, "nota": nota, "esperasAbiertas": esperas}),
    )
    .await?;
    if requiere_revision {
        bitacora::registrar(&mut tx, Some(&a.id), "caja.diferencia", "caja_turno", Some(&t.id), &json!({"diferencia": diferencia, "umbral": umbral})).await?;
    }
    if !ver.ok {
        bitacora::registrar(&mut tx, Some(&a.id), "bitacora.alterada", "bitacora", ver.rota_en.as_deref(), &json!({"filas": ver.filas})).await?;
    }
    tx.commit().await.map_err(e)?;
    let ve = ve_esperado(pool, a).await;
    Ok(ResultadoCierre {
        turno_id: t.id,
        diferencia: ve.then_some(diferencia),
        esperado: ve.then_some(r.efectivo_esperado),
        contado,
        requiere_revision,
        bitacora_ok: ver.ok,
        esperas_abiertas: esperas,
    })
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
        return Err("Ese turno no está cerrado".into());
    }
    if t.dia != dia_local() {
        return Err("Solo se puede reabrir un turno del mismo día".into());
    }
    if turno_abierto(&mut tx, &t.caja_id).await?.is_some() {
        return Err("Ya hay otro turno abierto en esta caja".into());
    }
    let antes = json!({"cerradoEn": t.cerrado_en, "esperado": t.esperado, "contado": t.contado, "diferencia": t.diferencia, "conteo": t.conteo_final, "nota": t.nota_cierre});
    sqlx::query(
        "UPDATE caja_turnos SET estado = 'abierto', cerrado_en = NULL, usuario_cierre_id = NULL, monto_esperado = NULL, monto_contado = NULL,
           conteo_final = NULL, diferencia = NULL, totales = NULL, nota_cierre = NULL, diferencia_revisada_por = NULL, actualizado_en = ? WHERE id = ?",
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

/// Reporte Z: la primera impresión es el original; las siguientes salen como COPIA.
pub async fn imprimir_z(pool: &SqlitePool, a: &Actor, turno_id: &str) -> Res<(Detalle, bool)> {
    let d = detalle(pool, a, turno_id).await?;
    if d.turno.estado != "cerrado" {
        return Err("El reporte Z sale al cerrar la caja".into());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let previas: i64 = sqlx::query_scalar("UPDATE caja_turnos SET reimpresiones = reimpresiones + 1 WHERE id = ? RETURNING reimpresiones - 1").bind(turno_id).fetch_one(&mut *tx).await.map_err(e)?;
    if previas > 0 {
        bitacora::registrar(&mut tx, Some(&a.id), "caja.z_reimprimir", "caja_turno", Some(turno_id), &json!({"vez": previas + 1})).await?;
    }
    tx.commit().await.map_err(e)?;
    Ok((d, previas > 0))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TurnoFila {
    #[serde(flatten)]
    pub turno: Turno,
    pub ventas: i64,
    pub total: i64,
    pub pendiente_revision: bool,
}

/// Historial: el dueño ve todos; el cajero solo los suyos. En cierre ciego el cajero no ve diferencias.
pub async fn listar(pool: &SqlitePool, a: &Actor, caja_id: &str, desde: &str, hasta: &str) -> Res<Vec<TurnoFila>> {
    a.exigir("caja", "ver turnos")?;
    let solo_mios = !puede(a.rol, "caja.admin");
    let umbral = config::entero(pool, "caja_umbral_diferencia", 1000).await;
    let ve = ve_esperado(pool, a).await;
    let filas = sqlx::query(&format!(
        "{SELECT_TURNO} WHERE t.caja_id = ? AND t.eliminado_en IS NULL AND t.dia >= ? AND t.dia <= ? AND (? = 0 OR t.usuario_apertura_id = ?) ORDER BY t.abierto_en DESC LIMIT 400"
    ))
    .bind(caja_id)
    .bind(desde)
    .bind(hasta)
    .bind(solo_mios as i64)
    .bind(&a.id)
    .fetch_all(pool)
    .await
    .map_err(e)?;
    let mut out = Vec::new();
    for f in &filas {
        let mut t = a_turno(f);
        let (n, total): (i64, i64) = sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(total), 0) FROM ventas WHERE turno_id = ? AND estado = 'completada' AND eliminado_en IS NULL")
            .bind(&t.id)
            .fetch_one(pool)
            .await
            .map_err(e)?;
        let pendiente = t.revisada_por.is_none() && t.diferencia.is_some_and(|d| d.abs() >= umbral);
        if !ve {
            t.esperado = None;
            t.diferencia = None;
        }
        out.push(TurnoFila { turno: t, ventas: n, total, pendiente_revision: pendiente && !solo_mios });
    }
    Ok(out)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::usuarios::tests::base_con_usuarios;

    pub fn conteo(pares: &[(i64, i64)]) -> Conteo {
        Conteo { cantidades: pares.iter().map(|(d, n)| (d.to_string(), *n)).collect() }
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
        // Solo un turno abierto por caja.
        assert!(abrir(p, &dueno, CAJA_1, &conteo(&[])).await.unwrap_err().contains("abierta"));

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
        // Más de lo que hay: no.
        let mucho = NuevoMovimiento { tipo: "salida".into(), monto: 6000, categoria: "Gasto menor".into(), nota: String::new() };
        assert!(movimiento(p, &cajero, CAJA_1, &mucho, None).await.unwrap_err().contains("efectivo"));

        let d = detalle(p, &cajero, &t.id).await.unwrap();
        assert_eq!(d.resumen.efectivo_esperado, 27000 + 3000 - 25000);

        // Diferencia sobre el umbral: exige nota.
        let mal = conteo(&[(1000, 3)]);
        assert!(necesita_nota(p, &cajero, CAJA_1, &mal).await.unwrap());
        assert!(cerrar(p, &cajero, CAJA_1, &mal, "").await.unwrap_err().contains("NOTA_REQUERIDA"));
        let r = cerrar(p, &cajero, CAJA_1, &mal, "Faltan dos mil, revisar").await.unwrap();
        assert_eq!(r.diferencia, Some(-2000));
        assert!(r.requiere_revision && r.bitacora_ok);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'caja.diferencia'").fetch_one(p).await.unwrap();
        assert_eq!(n, 1);

        // Reabrir: solo el dueño, con PIN y motivo, mismo día.
        assert!(reabrir(p, &cajero, &t.id, "246813", "contó mal").await.unwrap_err().contains("permiso"));
        assert!(reabrir(p, &dueno, &t.id, "000000", "contó mal").await.is_err());
        reabrir(p, &dueno, &t.id, "246813", "Contó mal los billetes").await.unwrap();
        let r = cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 5)]), "").await.unwrap();
        assert_eq!(r.diferencia, Some(0));
        assert!(!r.requiere_revision);

        // Z: original y luego COPIA.
        assert!(!imprimir_z(p, &cajero, &t.id).await.unwrap().1);
        assert!(imprimir_z(p, &cajero, &t.id).await.unwrap().1);
    }

    #[tokio::test]
    async fn cierre_ciego_y_reabrir_otro_dia() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        config::guardar(p, &dueno, "caja_cierre_ciego", &json!(true)).await.unwrap();
        let t = abrir(p, &cajero, CAJA_1, &conteo(&[(5000, 1)])).await.unwrap();
        let d = detalle(p, &cajero, &t.id).await.unwrap();
        assert!(!d.ve_esperado);
        assert_eq!(d.resumen.efectivo_esperado, 0);
        let r = cerrar(p, &cajero, CAJA_1, &conteo(&[(5000, 1)]), "").await.unwrap();
        assert_eq!(r.diferencia, None);
        assert_eq!(detalle(p, &dueno, &t.id).await.unwrap().turno.diferencia, Some(0));
        // Turno de ayer: no se reabre.
        sqlx::query("UPDATE caja_turnos SET dia = '2000-01-01' WHERE id = ?").bind(&t.id).execute(p).await.unwrap();
        assert!(reabrir(p, &dueno, &t.id, "246813", "Quiero reabrir").await.unwrap_err().contains("mismo día"));
        // El cajero solo ve sus turnos en el historial.
        assert_eq!(listar(p, &cajero, CAJA_1, "1999-01-01", "2999-01-01").await.unwrap().len(), 1);
    }
}
