// Venta: ventas en espera, cobro, consulta, reimpresión, corrección de pago, anulación y
// pendientes de factura. Todo se valida aquí aunque la pantalla ya lo haya hecho.
//
// Consecutivo sin saltos: el número se toma DENTRO de la transacción del cobro (BEGIN IMMEDIATE),
// así dos cobros a la vez se ponen en fila y un cobro que falla no gasta número.
//
// Turnos: solo se cobra con la caja abierta (turno de hoy) y la venta queda ligada al turno y a
// quien la cobró (y a quien empezó la venta en espera). El turno es de la caja: cualquier usuario
// que pueda usarlo retoma las ventas en espera de otro.
// Una venta cobrada no la cambia el cajero: anular y corregir la forma de pago son del dueño, con
// su PIN y motivo. Si la venta es de un turno CERRADO, queda como ajuste en el turno actual.
// Mientras el turno está abierto, el cajero solo ve sus propios tiquetes (nunca sumas).

use crate::bitacora;
use crate::caja::{self, Turno};
use crate::calculo::{self, Estado, Forma, PagoEntrada};
use crate::config;
use crate::inventario;
use crate::permisos::{puede, sin_permiso, Rol};
use crate::sesion::Actor;
use crate::usuarios;
use crate::util::{ahora_iso, dia_local, e, texto, ulid, Res};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// ─────────── Ventas en espera ───────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Espera {
    pub id: String,
    pub numero: i64,
    /// Quién empezó la venta (cualquiera del turno la puede retomar y cobrar).
    pub usuario_id: String,
    pub usuario: String,
    pub estado: Value,
    pub actualizado_en: String,
}

fn a_espera(f: &sqlx::sqlite::SqliteRow) -> Espera {
    Espera {
        id: f.get("id"),
        numero: f.get("numero"),
        usuario_id: f.get("usuario_id"),
        usuario: f.get("usuario"),
        estado: serde_json::from_str(&f.get::<String, _>("datos")).unwrap_or(json!({})),
        actualizado_en: f.get("actualizado_en"),
    }
}

pub async fn listar_esperas(pool: &SqlitePool, a: &Actor, caja_id: &str) -> Res<Vec<Espera>> {
    a.exigir("venta", "vender")?;
    let filas = sqlx::query(&format!("{SELECT_ESPERA} WHERE e.caja_id = ? AND e.eliminado_en IS NULL ORDER BY e.numero")).bind(caja_id).fetch_all(pool).await.map_err(e)?;
    Ok(filas.iter().map(a_espera).collect())
}

const SELECT_ESPERA: &str = "SELECT e.*, u.nombre AS usuario FROM ventas_espera e JOIN usuarios u ON u.id = e.usuario_id";

fn estado_json(estado: &Estado) -> Res<String> {
    let s = serde_json::to_string(estado).map_err(e)?;
    if s.len() > 200_000 || estado.lineas.len() > 500 {
        return Err("La venta es demasiado grande".into());
    }
    Ok(s)
}

/// Nueva pestaña con el número libre más bajo (calculado dentro del INSERT).
pub async fn crear_espera(pool: &SqlitePool, a: &Actor, caja_id: &str, estado: &Estado) -> Res<Espera> {
    a.exigir("venta", "vender")?;
    let datos = estado_json(estado)?;
    let id = ulid();
    let ahora = ahora_iso();
    let activas = "SELECT numero FROM ventas_espera WHERE caja_id = ?2 AND eliminado_en IS NULL";
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    sqlx::query(&format!(
        "INSERT INTO ventas_espera (id, sucursal_id, caja_id, usuario_id, numero, datos, creado_en, actualizado_en)
         SELECT ?1, c.sucursal_id, c.id, ?3,
           (SELECT MIN(n + 1) FROM (SELECT 0 AS n UNION ALL {activas}) WHERE n + 1 NOT IN ({activas})),
           ?4, ?5, ?5
         FROM cajas c WHERE c.id = ?2"
    ))
    .bind(&id)
    .bind(caja_id)
    .bind(&a.id)
    .bind(&datos)
    .bind(&ahora)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    let f = sqlx::query(&format!("{SELECT_ESPERA} WHERE e.id = ?")).bind(&id).fetch_one(&mut *tx).await.map_err(e)?;
    tx.commit().await.map_err(e)?;
    Ok(a_espera(&f))
}

/// Lo que se quitó de una venta abierta: líneas que ya no están o con menos cantidad (monto quitado).
pub fn lineas_quitadas(antes: &Estado, despues: &Estado) -> Vec<(String, i64, i64)> {
    let mut out = Vec::new();
    for l in &antes.lineas {
        match despues.lineas.iter().find(|x| x.id == l.id) {
            None => out.push((l.descripcion.clone(), l.cantidad, calculo::importe(l))),
            Some(n) if n.cantidad < l.cantidad => {
                let menos = l.cantidad - n.cantidad;
                out.push((l.descripcion.clone(), menos, menos * l.precio_unitario));
            }
            _ => {}
        }
    }
    out
}

/// Se llama en cada cambio de la venta: si se va la luz, queda lo último.
/// Quitar de una venta abierta algo de `caja_quitar_linea_bitacora` colones o más queda en la
/// bitácora (el cajero puede hacerlo, pero el dueño lo ve).
pub async fn guardar_espera(pool: &SqlitePool, a: &Actor, id: &str, estado: &Estado) -> Res<()> {
    a.exigir("venta", "vender")?;
    let datos = estado_json(estado)?;
    let umbral = config::entero(pool, "caja_quitar_linea_bitacora", 5000).await;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let previa = sqlx::query("SELECT numero, datos FROM ventas_espera WHERE id = ? AND eliminado_en IS NULL").bind(id).fetch_optional(&mut *tx).await.map_err(e)?;
    let Some(previa) = previa else {
        return Ok(());
    };
    sqlx::query("UPDATE ventas_espera SET datos = ?, actualizado_en = ? WHERE id = ?").bind(datos).bind(ahora_iso()).bind(id).execute(&mut *tx).await.map_err(e)?;
    if umbral > 0 {
        let antes: Estado = serde_json::from_str(&previa.get::<String, _>("datos")).unwrap_or_default();
        for (descripcion, cantidad, monto) in lineas_quitadas(&antes, estado) {
            if monto >= umbral {
                bitacora::registrar(&mut tx, Some(&a.id), "venta_espera.quitar_linea", "venta_espera", Some(id), &json!({"numero": previa.get::<i64, _>("numero"), "descripcion": descripcion, "cantidad": cantidad, "monto": monto})).await?;
            }
        }
    }
    tx.commit().await.map_err(e)?;
    Ok(())
}

pub async fn descartar_espera(pool: &SqlitePool, a: &Actor, id: &str) -> Res<()> {
    a.exigir("venta", "descartar ventas")?;
    let paso = config::entero(pool, "redondeo_total", 5).await;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let Some(f) = sqlx::query("SELECT * FROM ventas_espera WHERE id = ? AND eliminado_en IS NULL").bind(id).fetch_optional(&mut *tx).await.map_err(e)? else {
        return Ok(());
    };
    let esp = a_espera(&f);
    let est: Estado = serde_json::from_value(esp.estado.clone()).unwrap_or_default();
    let ahora = ahora_iso();
    sqlx::query("UPDATE ventas_espera SET eliminado_en = ?, actualizado_en = ? WHERE id = ?").bind(&ahora).bind(&ahora).bind(id).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "venta_espera.descartar", "venta_espera", Some(id), &json!({"numero": esp.numero, "lineas": est.lineas.len(), "total": calculo::totales(&est, paso).total})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

// ─────────── Autorización de descuento (un solo uso, la emite Rust) ───────────

struct Permiso {
    dueno_id: String,
    pct: f64,
    espera_id: String,
    vence: Instant,
}

fn autorizaciones() -> &'static Mutex<HashMap<String, Permiso>> {
    static A: OnceLock<Mutex<HashMap<String, Permiso>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutorizacionEmitida {
    pub dueno_id: String,
    pub pct: f64,
    pub token: String,
}

/// El dueño pone su PIN para un descuento mayor al tope. Vale para ESA venta, hasta ese %,
/// una sola vez y por 30 minutos. El frontend solo guarda el token, nunca el PIN.
pub async fn autorizar_descuento(pool: &SqlitePool, a: &Actor, espera_id: &str, pct: f64, pin: &str) -> Res<AutorizacionEmitida> {
    a.exigir("venta", "vender")?;
    if !(0.0..=100.0).contains(&pct) {
        return Err("Porcentaje inválido".into());
    }
    let dueno = usuarios::autorizar_dueno(pool, pin, "descuento", &a.id).await?;
    let token = ulid();
    let mut m = autorizaciones().lock().map_err(e)?;
    m.retain(|_, p| p.vence > Instant::now());
    m.insert(token.clone(), Permiso { dueno_id: dueno.clone(), pct, espera_id: espera_id.into(), vence: Instant::now() + Duration::from_secs(1800) });
    Ok(AutorizacionEmitida { dueno_id: dueno, pct, token })
}

/// Revisa la autorización sin gastarla: si el cobro falla después (un pago mal escrito, etc.)
/// el dueño no tiene que volver a poner el PIN.
fn ver_autorizacion(token: &str, espera_id: &str, pct: f64) -> Option<String> {
    let m = autorizaciones().lock().ok()?;
    let p = m.get(token)?;
    (p.espera_id == espera_id && p.vence > Instant::now() && pct <= p.pct + 1e-9).then(|| p.dueno_id.clone())
}

/// Se gasta recién cuando la venta quedó guardada (un solo uso).
fn gastar_autorizacion(token: &str) {
    if let Ok(mut m) = autorizaciones().lock() {
        m.remove(token);
    }
}

// ─────────── Cobro ───────────

pub async fn formas(c: &mut SqliteConnection) -> Res<Vec<Forma>> {
    let filas = sqlx::query("SELECT id, nombre, requiere_banco, requiere_referencia, da_vuelto, pide_ultimos4 FROM formas_pago WHERE activo = 1 AND eliminado_en IS NULL").fetch_all(c).await.map_err(e)?;
    Ok(filas
        .iter()
        .map(|f| Forma {
            id: f.get("id"),
            nombre: f.get("nombre"),
            requiere_banco: f.get::<i64, _>("requiere_banco") == 1,
            requiere_referencia: f.get::<i64, _>("requiere_referencia") == 1,
            da_vuelto: f.get::<i64, _>("da_vuelto") == 1,
            pide_ultimos4: f.get::<i64, _>("pide_ultimos4") == 1,
        })
        .collect())
}

async fn banco_valido(c: &mut SqliteConnection, id: Option<&str>) -> Res<()> {
    if let Some(id) = id.filter(|s| !s.is_empty()) {
        let ok: Option<i64> = sqlx::query_scalar("SELECT 1 FROM bancos WHERE id = ? AND activo = 1 AND eliminado_en IS NULL").bind(id).fetch_optional(c).await.map_err(e)?;
        if ok.is_none() {
            return Err("Ese banco ya no está en la lista. Elija otro.".into());
        }
    }
    Ok(())
}

pub async fn tope_descuento(pool: &SqlitePool, rol: Rol) -> f64 {
    config::valor(pool, "descuento_max_pct").await.and_then(|v| v.get(rol.como_str()).and_then(|x| x.as_f64())).unwrap_or(if rol == Rol::Cajero { 10.0 } else { 100.0 })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResultadoCobro {
    pub venta_id: String,
    pub numero: String,
    pub vuelto: i64,
    pub hay_efectivo: bool,
    /// Hay efectivo y la caja abre la gaveta con las ventas (config abrir_gaveta_efectivo):
    /// la pantalla pide abrirla (gaveta_venta) después de imprimir.
    pub abrir_gaveta: bool,
}

#[cfg(test)]
pub async fn cobrar(pool: &SqlitePool, a: &Actor, caja_id: &str, espera_id: &str, est: &Estado, pagos: &[PagoEntrada]) -> Res<ResultadoCobro> {
    cobrar_con(pool, a, caja_id, espera_id, est, pagos, None).await
}

/// `pin_existencia`: PIN del dueño para vender sin existencia cuando la configuración no lo permite
/// (la pantalla lo pide al recibir el error SIN_EXISTENCIA y reintenta).
pub async fn cobrar_con(pool: &SqlitePool, a: &Actor, caja_id: &str, espera_id: &str, est: &Estado, pagos: &[PagoEntrada], pin_existencia: Option<&str>) -> Res<ResultadoCobro> {
    a.exigir("venta", "vender")?;
    if est.lineas.is_empty() {
        return Err("La venta no tiene productos".into());
    }
    for l in &est.lineas {
        calculo::validar_linea(l)?;
    }
    let paso = config::entero(pool, "redondeo_total", 5).await;
    let tope = tope_descuento(pool, a.rol).await;
    let gaveta = config::booleano(pool, "abrir_gaveta_efectivo", true).await;
    // El PIN se revisa antes de la transacción (la verificación escribe intentos fallidos).
    let sin_existencia_por = match pin_existencia.filter(|p| !p.is_empty()) {
        Some(pin) => Some(usuarios::autorizar_dueno(pool, pin, "vender sin existencia", &a.id).await?),
        None => None,
    };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let t = caja::turno_para_vender(&mut tx, caja_id, a).await?;
    caja::reloj_atrasado(&mut tx, "cobrar").await?;

    // Precio, IVA y departamento de un producto salen de la base, no de la pantalla.
    let mut lineas = est.lineas.clone();
    for l in lineas.iter_mut() {
        if let Some(pid) = l.producto_id.as_deref() {
            let p = sqlx::query("SELECT nombre, precio, tasa_iva, exento, departamento_id, activo FROM productos WHERE id = ? AND eliminado_en IS NULL")
                .bind(pid)
                .fetch_optional(&mut *tx)
                .await
                .map_err(e)?
                .ok_or_else(|| format!("\"{}\" ya no existe en el catálogo: quítelo de la venta", l.descripcion))?;
            if p.get::<i64, _>("activo") != 1 {
                return Err(format!("\"{}\" está desactivado y ya no se vende: quítelo de la venta", l.descripcion));
            }
            if p.get::<i64, _>("precio") != l.precio_unitario {
                return Err(format!("\"{}\": el precio cambió, vuelva a agregarlo", l.descripcion));
            }
            l.descripcion = p.get("nombre");
            l.tasa_iva = p.get("tasa_iva");
            l.exento = p.get::<i64, _>("exento") == 1;
            l.departamento_id = p.get("departamento_id");
        } else {
            let ok: Option<i64> = sqlx::query_scalar("SELECT 1 FROM departamentos WHERE id = ? AND eliminado_en IS NULL").bind(&l.departamento_id).fetch_optional(&mut *tx).await.map_err(e)?;
            if ok.is_none() {
                return Err(format!("\"{}\": departamento inválido", l.descripcion));
            }
        }
    }
    let e2 = Estado { lineas, ..est.clone() };
    // Inventario: precio libre (sin producto) y servicios (sin control) no mueven existencia.
    let sucursal = inventario::sucursal_de(&mut tx, caja_id).await?;
    let controladas = inventario::controladas(&mut tx, &e2.lineas.iter().map(|l| (l.producto_id.clone(), l.cantidad)).collect::<Vec<_>>()).await?;
    let mut sin_existencia = vec![];
    if !config::booleano_con(&mut tx, "permitir_vender_sin_existencia", true).await {
        let ve_cantidad = puede(a.rol, "inventario") || config::booleano_con(&mut tx, "venta_mostrar_existencia", false).await;
        sin_existencia = inventario::faltantes(&mut tx, &sucursal, &controladas, ve_cantidad).await?;
        if !sin_existencia.is_empty() && sin_existencia_por.is_none() {
            return Err(format!("{}No hay existencia de: {}. Para vender igual, pida el PIN del dueño.", inventario::SIN_EXISTENCIA, sin_existencia.join(", ")));
        }
    }
    let tot = calculo::totales(&e2, paso);
    let mut autorizado_por = None;
    if tot.pct_descuento > tope + 1e-9 {
        let token = est.autorizacion.as_ref().and_then(|x| x.token.as_deref()).ok_or("El descuento pasa su tope: necesita el PIN del dueño")?;
        autorizado_por = Some(ver_autorizacion(token, espera_id, tot.pct_descuento).ok_or("La autorización del descuento venció o no corresponde a esta venta: pida el PIN del dueño otra vez")?);
    }
    if est.requiere_factura && est.cliente.is_none() {
        return Err("Para factura electrónica, elija o cree el cliente".into());
    }
    if let Some(cl) = &est.cliente {
        let ok: Option<i64> = sqlx::query_scalar("SELECT 1 FROM clientes WHERE id = ? AND anonimizado_en IS NULL").bind(&cl.id).fetch_optional(&mut *tx).await.map_err(e)?;
        if ok.is_none() {
            return Err("El cliente ya no existe".into());
        }
    }
    let nombre_tiquete = match est.nombre_tiquete.as_deref() {
        Some(n) => Some(texto(n, 80, "nombre en tiquete", false)?).filter(|s| !s.is_empty()),
        None => None,
    };
    let fs = formas(&mut tx).await?;
    let rp = calculo::pagos(tot.total, pagos, &fs);
    if !rp.errores.is_empty() {
        return Err(rp.errores.join(". "));
    }
    if rp.faltante > 0 {
        return Err(format!("Todavía faltan {} por pagar.", crate::util::colones(rp.faltante)));
    }
    for p in pagos {
        banco_valido(&mut tx, p.banco_id.as_deref()).await?;
    }

    let venta_id = ulid();
    let fecha = ahora_iso();
    // El JOIN con la espera activa evita que un doble clic en "Cobrar" cree dos ventas.
    let n = sqlx::query(
        "INSERT INTO ventas (id, sucursal_id, caja_id, turno_id, consecutivo, numero, fecha, dia, usuario_id, cliente_id, nombre_tiquete,
           subtotal, descuento, redondeo, total, iva_total, requiere_factura, descuento_autorizado_por, creado_en, actualizado_en, espera_creada_por)
         SELECT ?, c.sucursal_id, c.id, ?, c.consecutivo_siguiente, c.prefijo_tiquete || c.consecutivo_siguiente, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, e.usuario_id
         FROM cajas c JOIN ventas_espera e ON e.id = ? AND e.caja_id = c.id AND e.eliminado_en IS NULL
         WHERE c.id = ? AND c.eliminado_en IS NULL",
    )
    .bind(&venta_id)
    .bind(&t.id)
    .bind(&fecha)
    .bind(dia_local())
    .bind(&a.id)
    .bind(est.cliente.as_ref().map(|c| c.id.clone()))
    .bind(&nombre_tiquete)
    .bind(tot.subtotal)
    .bind(tot.descuento)
    .bind(tot.redondeo)
    .bind(tot.total)
    .bind(tot.iva)
    .bind(est.requiere_factura as i64)
    .bind(&autorizado_por)
    .bind(&fecha)
    .bind(&fecha)
    .bind(espera_id)
    .bind(caja_id)
    .execute(&mut *tx)
    .await
    .map_err(e)?
    .rows_affected();
    if n == 0 {
        return Err("Esta venta ya se cobró o se descartó".into());
    }
    sqlx::query("UPDATE cajas SET consecutivo_siguiente = consecutivo_siguiente + 1, actualizado_en = ? WHERE id = ?").bind(&fecha).bind(caja_id).execute(&mut *tx).await.map_err(e)?;
    for (i, l) in e2.lineas.iter().enumerate() {
        sqlx::query(
            "INSERT INTO venta_lineas (id, venta_id, producto_id, codigo, descripcion, departamento_id, cantidad, precio_unitario,
               descuento, total, tasa_iva, iva, orden, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(ulid())
        .bind(&venta_id)
        .bind(&l.producto_id)
        .bind(&l.codigo)
        .bind(&l.descripcion)
        .bind(&l.departamento_id)
        .bind(l.cantidad)
        .bind(l.precio_unitario)
        .bind(l.descuento)
        .bind(calculo::importe(l))
        .bind(if l.exento { 0.0 } else { l.tasa_iva })
        .bind(tot.iva_lineas[i])
        .bind(i as i64)
        .bind(&fecha)
        .bind(&fecha)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    }
    for ap in &rp.aplicados {
        sqlx::query(
            "INSERT INTO venta_pagos (id, venta_id, forma_pago_id, banco_id, monto, recibido, vuelto, referencia, ultimos4, creado_en, actualizado_en, usuario_id, turno_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(ulid())
        .bind(&venta_id)
        .bind(&ap.pago.forma_pago_id)
        .bind(ap.pago.banco_id.as_deref().filter(|s| !s.is_empty()))
        .bind(ap.aplicado)
        .bind(ap.recibido)
        .bind(ap.vuelto)
        .bind(ap.pago.referencia.as_deref().map(str::trim).filter(|s| !s.is_empty()))
        .bind(ap.pago.ultimos4.as_deref().filter(|s| !s.is_empty()))
        .bind(&fecha)
        .bind(&fecha)
        .bind(&a.id)
        .bind(&t.id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    }
    sqlx::query("UPDATE ventas_espera SET eliminado_en = ?, venta_id = ?, datos = ?, actualizado_en = ? WHERE id = ?")
        .bind(&fecha)
        .bind(&venta_id)
        .bind(estado_json(&e2)?)
        .bind(&fecha)
        .bind(espera_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    inventario::descontar_venta(&mut tx, &venta_id, &sucursal, &a.id, &t.id, &controladas, &fecha).await?;
    if !sin_existencia.is_empty() {
        bitacora::registrar(&mut tx, Some(&a.id), "venta.sin_existencia", "venta", Some(&venta_id), &json!({"productos": sin_existencia, "autorizadoPor": sin_existencia_por})).await?;
    }
    if let Some(d) = &autorizado_por {
        bitacora::registrar(&mut tx, Some(&a.id), "venta.descuento_autorizado", "venta", Some(&venta_id), &json!({"pct": (tot.pct_descuento * 10.0).round() / 10.0, "autorizadoPor": d})).await?;
    }
    let numero: String = sqlx::query_scalar("SELECT numero FROM ventas WHERE id = ?").bind(&venta_id).fetch_one(&mut *tx).await.map_err(e)?;
    tx.commit().await.map_err(e)?;
    if autorizado_por.is_some() {
        if let Some(t) = est.autorizacion.as_ref().and_then(|x| x.token.as_deref()) {
            gastar_autorizacion(t);
        }
    }
    let efectivo: Vec<&str> = fs.iter().filter(|f| f.da_vuelto).map(|f| f.id.as_str()).collect();
    let hay_efectivo = rp.aplicados.iter().any(|x| efectivo.contains(&x.pago.forma_pago_id.as_str()));
    Ok(ResultadoCobro { venta_id, numero, vuelto: rp.vuelto, hay_efectivo, abrir_gaveta: hay_efectivo && gaveta })
}

// ─────────── Consultas ───────────

/// Solo quien vende (cajero y dueño). El técnico tiene "reportes" para la bitácora, pero una venta
/// lleva el nombre del cliente y el impreso en el tiquete: Ley 8968, el técnico no los ve.
fn puede_consultar(a: &Actor) -> Res<()> {
    if puede(a.rol, "venta") {
        Ok(())
    } else {
        Err(sin_permiso("ver ventas"))
    }
}

/// El cajero, mientras el turno de la venta está abierto, solo ve los tiquetes que él emitió.
fn puede_ver_venta(a: &Actor, turno_abierto: bool, usuario_id: &str) -> Res<()> {
    if a.rol == Rol::Cajero && turno_abierto && usuario_id != a.id {
        return Err(sin_permiso("ver tiquetes de otra persona mientras el turno está abierto"));
    }
    Ok(())
}

pub async fn obtener(pool: &SqlitePool, a: &Actor, id: &str) -> Res<Option<Value>> {
    puede_consultar(a)?;
    let Some(f) = sqlx::query(
        "SELECT v.*, u.nombre AS cajero, c.nombre AS cliente, t.estado AS turno_estado, t.usuario_apertura_id AS turno_usuario_id,
           ue.nombre AS espera_creada, ua.nombre AS anulada_por_nombre FROM ventas v
         JOIN usuarios u ON u.id = v.usuario_id LEFT JOIN clientes c ON c.id = v.cliente_id LEFT JOIN caja_turnos t ON t.id = v.turno_id
         LEFT JOIN usuarios ue ON ue.id = v.espera_creada_por LEFT JOIN usuarios ua ON ua.id = v.anulada_por
         WHERE v.id = ? AND v.eliminado_en IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(e)?
    else {
        return Ok(None);
    };
    puede_ver_venta(a, f.get::<Option<String>, _>("turno_estado").as_deref() == Some("abierto"), &f.get::<String, _>("usuario_id"))?;
    let lineas = sqlx::query("SELECT * FROM venta_lineas WHERE venta_id = ? AND eliminado_en IS NULL ORDER BY orden").bind(id).fetch_all(pool).await.map_err(e)?;
    let pagos = sqlx::query(
        "SELECT p.*, f.nombre AS forma, f.tipo, COALESCE(NULLIF(b.abreviatura, ''), b.nombre) AS banco FROM venta_pagos p
         JOIN formas_pago f ON f.id = p.forma_pago_id LEFT JOIN bancos b ON b.id = p.banco_id
         WHERE p.venta_id = ? AND p.eliminado_en IS NULL ORDER BY p.creado_en, p.id",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(e)?;
    let fecha: String = f.get("fecha");
    Ok(Some(json!({
        "id": f.get::<String, _>("id"),
        "cajaId": f.get::<String, _>("caja_id"),
        "turnoId": f.get::<Option<String>, _>("turno_id"),
        // Sin turno (ventas anteriores a los turnos) cuenta como cerrado.
        "turnoAbierto": f.get::<Option<String>, _>("turno_estado").as_deref() == Some("abierto"),
        // Quién abrió el turno de la venta: solo esa persona (o el dueño) la corrige o anula mientras siga abierto.
        "turnoUsuarioId": f.get::<Option<String>, _>("turno_usuario_id"),
        "consecutivo": f.get::<i64, _>("consecutivo"),
        "numero": f.get::<String, _>("numero"),
        "dia": f.get::<Option<String>, _>("dia").unwrap_or_else(|| fecha.chars().take(10).collect()),
        "fecha": fecha,
        "usuarioId": f.get::<String, _>("usuario_id"),
        "cajero": f.get::<String, _>("cajero"),
        // Quién empezó la venta en espera (si fue otra persona, la retomó quien cobró).
        "esperaCreadaPor": f.get::<Option<String>, _>("espera_creada"),
        "anuladaPor": f.get::<Option<String>, _>("anulada_por_nombre"),
        "clienteId": f.get::<Option<String>, _>("cliente_id"),
        "cliente": f.get::<Option<String>, _>("cliente"),
        "nombreTiquete": f.get::<Option<String>, _>("nombre_tiquete"),
        "subtotal": f.get::<i64, _>("subtotal"),
        "descuento": f.get::<i64, _>("descuento"),
        "redondeo": f.get::<i64, _>("redondeo"),
        "total": f.get::<i64, _>("total"),
        "ivaTotal": f.get::<Option<i64>, _>("iva_total").unwrap_or(0),
        "estado": f.get::<String, _>("estado"),
        "anuladaMotivo": f.get::<Option<String>, _>("anulada_motivo"),
        "requiereFactura": f.get::<i64, _>("requiere_factura") == 1,
        "facturaEmitida": f.get::<i64, _>("factura_emitida") == 1,
        "facturaReferencia": f.get::<Option<String>, _>("factura_referencia"),
        "reimpresiones": f.get::<i64, _>("reimpresiones"),
        "impreso": f.get::<Option<String>, _>("impreso_en").is_some(),
        "lineas": lineas.iter().map(|l| json!({
            "id": l.get::<String, _>("id"),
            "productoId": l.get::<Option<String>, _>("producto_id"),
            "codigo": l.get::<Option<String>, _>("codigo"),
            "descripcion": l.get::<String, _>("descripcion"),
            "departamentoId": l.get::<String, _>("departamento_id"),
            "cantidad": l.get::<i64, _>("cantidad"),
            "precioUnitario": l.get::<i64, _>("precio_unitario"),
            "descuento": l.get::<i64, _>("descuento"),
            "total": l.get::<i64, _>("total"),
            "tasaIva": l.get::<f64, _>("tasa_iva"),
            "iva": l.get::<i64, _>("iva"),
        })).collect::<Vec<_>>(),
        "pagos": pagos.iter().map(|p| json!({
            "id": p.get::<String, _>("id"),
            "formaPagoId": p.get::<String, _>("forma_pago_id"),
            "forma": p.get::<String, _>("forma"),
            "tipo": p.get::<String, _>("tipo"),
            "monto": p.get::<i64, _>("monto"),
            "recibido": p.get::<Option<i64>, _>("recibido"),
            "vuelto": p.get::<Option<i64>, _>("vuelto"),
            "bancoId": p.get::<Option<String>, _>("banco_id"),
            "banco": p.get::<Option<String>, _>("banco"),
            "referencia": p.get::<Option<String>, _>("referencia"),
            "ultimos4": p.get::<Option<String>, _>("ultimos4"),
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VentaResumen {
    pub id: String,
    pub numero: String,
    pub fecha: String,
    pub total: i64,
    pub estado: String,
    pub cajero: String,
    pub requiere_factura: bool,
    pub factura_emitida: bool,
    pub formas: String,
    pub turno_abierto: bool,
    /// Descripciones de las líneas ("Tijera · Cuaderno"), para buscar "la venta de la tijera".
    pub productos: String,
    pub articulos: i64,
}

/// Ventas del día. El cajero ve las de turnos cerrados y, del turno abierto, solo las suyas.
pub async fn listar_dia(pool: &SqlitePool, a: &Actor, caja_id: &str, dia: &str) -> Res<Vec<VentaResumen>> {
    puede_consultar(a)?;
    let solo_mias = a.rol == Rol::Cajero;
    let filas = sqlx::query(
        "SELECT v.id, v.numero, v.fecha, v.total, v.estado, v.requiere_factura, v.factura_emitida, u.nombre AS cajero, t.estado AS turno_estado,
           (SELECT group_concat(f.nombre, ' + ') FROM venta_pagos p JOIN formas_pago f ON f.id = p.forma_pago_id
            WHERE p.venta_id = v.id AND p.eliminado_en IS NULL) AS formas,
           (SELECT group_concat(l.descripcion, ' · ') FROM venta_lineas l WHERE l.venta_id = v.id AND l.eliminado_en IS NULL) AS productos,
           (SELECT COALESCE(SUM(l.cantidad), 0) FROM venta_lineas l WHERE l.venta_id = v.id AND l.eliminado_en IS NULL) AS articulos
         FROM ventas v JOIN usuarios u ON u.id = v.usuario_id LEFT JOIN caja_turnos t ON t.id = v.turno_id
         WHERE v.caja_id = ? AND v.dia = ? AND v.eliminado_en IS NULL
           AND (? = 0 OR COALESCE(t.estado, 'cerrado') = 'cerrado' OR v.usuario_id = ?)
         ORDER BY v.consecutivo DESC",
    )
    .bind(caja_id)
    .bind(dia)
    .bind(solo_mias as i64)
    .bind(&a.id)
    .fetch_all(pool)
    .await
    .map_err(e)?;
    Ok(filas
        .iter()
        .map(|f| VentaResumen {
            id: f.get("id"),
            numero: f.get("numero"),
            fecha: f.get("fecha"),
            total: f.get("total"),
            estado: f.get("estado"),
            cajero: f.get("cajero"),
            requiere_factura: f.get::<i64, _>("requiere_factura") == 1,
            factura_emitida: f.get::<i64, _>("factura_emitida") == 1,
            formas: f.get::<Option<String>, _>("formas").unwrap_or_default(),
            turno_abierto: f.get::<Option<String>, _>("turno_estado").as_deref() == Some("abierto"),
            productos: f.get::<Option<String>, _>("productos").unwrap_or_default(),
            articulos: f.get("articulos"),
        })
        .collect())
}

/// Imprime el tiquete de una venta en la impresora de tiquetes. El original sale una sola vez (si
/// falló la impresión, se puede reintentar); después, solo como COPIA (Rust revisa la marca) y
/// queda en la bitácora. Devuelve true si fue una copia.
pub async fn imprimir_tiquete(pool: &SqlitePool, a: &Actor, venta_id: &str, datos: &[u8]) -> Res<bool> {
    a.exigir("venta", "imprimir tiquetes")?;
    crate::escpos::validar(datos)?;
    let copia = crate::escpos::tiene_marca_copia(datos);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let v = sqlx::query("SELECT v.caja_id, v.usuario_id, v.impreso_en, t.estado AS turno_estado FROM ventas v LEFT JOIN caja_turnos t ON t.id = v.turno_id WHERE v.id = ? AND v.eliminado_en IS NULL")
        .bind(venta_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(e)?
        .ok_or("Venta no encontrada")?;
    puede_ver_venta(a, v.get::<Option<String>, _>("turno_estado").as_deref() == Some("abierto"), &v.get::<String, _>("usuario_id"))?;
    if !copia && v.get::<Option<String>, _>("impreso_en").is_some() {
        return Err("Ese tiquete ya se imprimió: la reimpresión sale como COPIA.".into());
    }
    crate::impresoras::enviar_con(&mut tx, &v.get::<String, _>("caja_id"), "tiquete", datos).await?;
    if copia {
        sqlx::query("UPDATE ventas SET reimpresiones = reimpresiones + 1 WHERE id = ?").bind(venta_id).execute(&mut *tx).await.map_err(e)?;
        bitacora::registrar(&mut tx, Some(&a.id), "venta.reimprimir", "venta", Some(venta_id), &json!({})).await?;
    } else {
        sqlx::query("UPDATE ventas SET impreso_en = ? WHERE id = ?").bind(ahora_iso()).bind(venta_id).execute(&mut *tx).await.map_err(e)?;
    }
    tx.commit().await.map_err(e)?;
    Ok(copia)
}

pub async fn correcciones_de(pool: &SqlitePool, a: &Actor, venta_id: &str) -> Res<Vec<Value>> {
    puede_consultar(a)?;
    let filas = sqlx::query(
        "SELECT c.fecha, c.motivo, fa.nombre AS antes, fn.nombre AS despues, u.nombre AS usuario, 'turno' AS donde FROM venta_pago_correcciones c
         JOIN venta_pagos p ON p.id = c.venta_pago_id JOIN formas_pago fa ON fa.id = c.forma_pago_anterior_id
         JOIN formas_pago fn ON fn.id = c.forma_pago_nueva_id JOIN usuarios u ON u.id = c.usuario_id
         WHERE p.venta_id = ?1
         UNION ALL
         SELECT a.fecha, a.motivo, json_extract(a.valor_anterior, '$.forma'), json_extract(a.valor_nuevo, '$.forma'), u.nombre, 'ajuste'
         FROM caja_ajustes a JOIN usuarios u ON u.id = a.usuario_id WHERE a.venta_id = ?1 AND a.tipo = 'pago'
         ORDER BY 1",
    )
    .bind(venta_id)
    .fetch_all(pool)
    .await
    .map_err(e)?;
    Ok(filas.iter().map(crate::bd::fila_json).map(Value::Object).collect())
}

// ─────────── Corrección de forma de pago ───────────

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CambioPago {
    pub forma_pago_id: String,
    pub banco_id: Option<String>,
    pub referencia: Option<String>,
    pub ultimos4: Option<String>,
}

/// Caja donde queda un ajuste posterior al cierre: la abierta de hoy (el dueño puede usar la de un cajero).
async fn turno_para_ajuste(c: &mut SqliteConnection, caja_id: &str) -> Res<Turno> {
    match caja::turno_abierto(c, caja_id).await? {
        None => Err("Esa venta es de una caja ya cerrada: el ajuste queda en la caja de hoy, así que primero ábrala.".into()),
        Some(t) if t.dia != dia_local() => Err(format!("Quedó abierta la caja del {}: ciérrela y abra la de hoy para registrar el ajuste.", t.dia)),
        Some(t) => Ok(t),
    }
}

/// Turno de la venta: Some(abierto) o None (cerrado, o venta anterior a los turnos).
async fn turno_de_venta(c: &mut SqliteConnection, turno_id: Option<String>) -> Res<Option<Turno>> {
    match turno_id {
        Some(id) => Ok(caja::turno(c, &id).await?.filter(|t| t.estado == "abierto")),
        None => Ok(None),
    }
}

/// Cambia la forma de pago (p. ej. se marcó Tarjeta y era SINPE). El monto no cambia.
/// Solo el dueño, con su PIN y motivo (el cajero no cambia una venta cobrada).
/// Turno abierto: se corrige el pago. Turno cerrado: queda como ajuste en el turno actual y el
/// pago original no se toca.
pub async fn corregir_pago(pool: &SqlitePool, a: &Actor, caja_id: &str, pago_id: &str, cambio: &CambioPago, motivo: &str, pin_dueno: Option<&str>) -> Res<()> {
    if a.rol != Rol::Dueno {
        return Err(sin_permiso("cambiar la forma de pago de una venta cobrada (solo el dueño)"));
    }
    let motivo = texto(motivo, 300, "motivo", true)?;
    if motivo.chars().count() < 5 {
        return Err("Escriba el motivo de la corrección".into());
    }
    let cerrado = {
        let mut c = pool.acquire().await.map_err(e)?;
        let tid: Option<String> = sqlx::query_scalar("SELECT v.turno_id FROM venta_pagos p JOIN ventas v ON v.id = p.venta_id WHERE p.id = ? AND p.eliminado_en IS NULL")
            .bind(pago_id)
            .fetch_optional(&mut *c)
            .await
            .map_err(e)?
            .ok_or("Ese pago ya no existe. Vuelva a abrir la venta.")?;
        turno_de_venta(&mut c, tid).await?.is_none()
    };
    let autorizado = Some(usuarios::confirmar_dueno(pool, a, pin_dueno.unwrap_or(""), "corregir forma de pago").await?);

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let p = sqlx::query(
        "SELECT p.*, v.turno_id, v.estado, f.da_vuelto, f.nombre AS forma FROM venta_pagos p
         JOIN ventas v ON v.id = p.venta_id JOIN formas_pago f ON f.id = p.forma_pago_id WHERE p.id = ? AND p.eliminado_en IS NULL",
    )
    .bind(pago_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(e)?
    .ok_or("Ese pago ya no existe. Vuelva a abrir la venta.")?;
    if p.get::<String, _>("estado") != "completada" {
        return Err("Esa venta está anulada: ya no se le puede cambiar la forma de pago.".into());
    }
    let turno_venta = turno_de_venta(&mut tx, p.get("turno_id")).await?;
    if turno_venta.is_none() != cerrado {
        return Err("Alguien abrió o cerró la caja mientras tanto. Cierre esta ventana y vuelva a intentarlo.".into());
    }
    let fs = formas(&mut tx).await?;
    let nueva = fs.iter().find(|f| f.id == cambio.forma_pago_id).ok_or("Forma de pago no disponible")?;
    if nueva.requiere_banco && cambio.banco_id.as_deref().unwrap_or("").is_empty() {
        return Err(format!("{}: elija el banco", nueva.nombre));
    }
    banco_valido(&mut tx, cambio.banco_id.as_deref()).await?;
    let referencia = texto(cambio.referencia.as_deref().unwrap_or(""), 60, "referencia", false)?;
    if nueva.requiere_referencia && referencia.is_empty() {
        return Err(format!("{}: escriba la referencia", nueva.nombre));
    }
    if let Some(u) = cambio.ultimos4.as_deref().filter(|u| !u.is_empty()) {
        if u.len() != 4 || !u.chars().all(|c| c.is_ascii_digit()) {
            return Err("Los últimos 4 dígitos son 4 números".into());
        }
    }
    let n_banco = if nueva.requiere_banco { cambio.banco_id.clone().filter(|s| !s.is_empty()) } else { None };
    let n_ref = (!referencia.is_empty()).then_some(referencia);
    let n_u4 = if nueva.pide_ultimos4 { cambio.ultimos4.clone().filter(|s| !s.is_empty()) } else { None };
    let (a_forma, a_banco, a_ref, a_u4): (String, Option<String>, Option<String>, Option<String>) = (p.get("forma_pago_id"), p.get("banco_id"), p.get("referencia"), p.get("ultimos4"));
    if nueva.id == a_forma && n_banco == a_banco && n_ref == a_ref && n_u4 == a_u4 {
        return Err("No cambió nada: ese pago ya está registrado con esa forma de pago (y el mismo banco, referencia y últimos 4). Elija otra forma o cambie algún dato.".into());
    }
    let monto: i64 = p.get("monto");
    let venta_id: String = p.get("venta_id");
    let ahora = ahora_iso();
    let antes = json!({"formaPagoId": a_forma, "forma": p.get::<String, _>("forma"), "banco": a_banco, "referencia": a_ref, "ultimos4": a_u4});
    let despues = json!({"formaPagoId": nueva.id, "forma": nueva.nombre, "banco": n_banco, "referencia": n_ref, "ultimos4": n_u4});

    if let Some(t) = &turno_venta {
        let estaba_efectivo = p.get::<i64, _>("da_vuelto") == 1;
        let id = ulid();
        sqlx::query(
            "INSERT INTO venta_pago_correcciones (id, venta_pago_id, forma_pago_anterior_id, forma_pago_nueva_id, banco_anterior_id, banco_nuevo_id,
               referencia_anterior, referencia_nueva, ultimos4_anterior, ultimos4_nuevo, motivo, usuario_id, autorizado_por, fecha, turno_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(pago_id)
        .bind(&a_forma)
        .bind(&nueva.id)
        .bind(&a_banco)
        .bind(&n_banco)
        .bind(&a_ref)
        .bind(&n_ref)
        .bind(&a_u4)
        .bind(&n_u4)
        .bind(&motivo)
        .bind(&a.id)
        .bind(&autorizado)
        .bind(&ahora)
        .bind(&t.id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
        // Al pasar a efectivo, lo recibido es el monto (sin vuelto); al salir del efectivo se borra recibido/vuelto.
        let (recibido, vuelto) = match (nueva.da_vuelto, estaba_efectivo) {
            (true, true) => (Some(p.get::<Option<i64>, _>("recibido").unwrap_or(monto)), Some(p.get::<Option<i64>, _>("vuelto").unwrap_or(0))),
            (true, false) => (Some(monto), Some(0)),
            _ => (None, None),
        };
        sqlx::query("UPDATE venta_pagos SET forma_pago_id = ?, banco_id = ?, referencia = ?, ultimos4 = ?, recibido = ?, vuelto = ?, actualizado_en = ? WHERE id = ?")
            .bind(&nueva.id)
            .bind(&n_banco)
            .bind(&n_ref)
            .bind(&n_u4)
            .bind(recibido)
            .bind(vuelto)
            .bind(&ahora)
            .bind(pago_id)
            .execute(&mut *tx)
            .await
            .map_err(e)?;
        bitacora::registrar(&mut tx, Some(&a.id), "venta.pago_corregido", "venta", Some(&venta_id), &json!({"pagoId": pago_id, "correccionId": id, "monto": monto, "antes": antes, "despues": despues, "autorizadoPor": autorizado})).await?;
    } else {
        let actual = turno_para_ajuste(&mut tx, caja_id).await?;
        let id = ulid();
        let mut ant = antes.clone();
        ant["pagoId"] = json!(pago_id);
        sqlx::query("INSERT INTO caja_ajustes (id, turno_id, venta_id, tipo, valor_anterior, valor_nuevo, monto, motivo, usuario_id, autorizado_por, fecha) VALUES (?, ?, ?, 'pago', ?, ?, ?, ?, ?, ?, ?)")
            .bind(&id)
            .bind(&actual.id)
            .bind(&venta_id)
            .bind(ant.to_string())
            .bind(despues.to_string())
            .bind(monto)
            .bind(&motivo)
            .bind(&a.id)
            .bind(&autorizado)
            .bind(&ahora)
            .execute(&mut *tx)
            .await
            .map_err(e)?;
        bitacora::registrar(&mut tx, Some(&a.id), "caja.ajuste_pago", "venta", Some(&venta_id), &json!({"ajusteId": id, "turnoId": actual.id, "pagoId": pago_id, "monto": monto, "antes": antes, "despues": despues, "motivo": motivo})).await?;
    }
    tx.commit().await.map_err(e)?;
    Ok(())
}

// ─────────── Anulación ───────────

/// Turno abierto: PIN del dueño y motivo. Turno cerrado (o venta sin turno): solo el dueño, con
/// PIN; queda como ajuste en el turno actual y, si se devolvió efectivo, como salida de caja.
pub async fn anular(pool: &SqlitePool, a: &Actor, caja_id: &str, venta_id: &str, pin: &str, motivo: &str, devolucion_efectivo: i64) -> Res<()> {
    if a.rol != Rol::Dueno {
        return Err(sin_permiso("anular ventas (solo el dueño)"));
    }
    let motivo = texto(motivo, 300, "motivo", true)?;
    if motivo.chars().count() < 5 {
        return Err("Escriba el motivo de la anulación".into());
    }
    let turno_id: Option<Option<String>> = sqlx::query_scalar("SELECT turno_id FROM ventas WHERE id = ? AND eliminado_en IS NULL").bind(venta_id).fetch_optional(pool).await.map_err(e)?;
    let turno_id = turno_id.ok_or("Venta no encontrada")?;
    let (cerrado, turno_venta) = {
        let mut c = pool.acquire().await.map_err(e)?;
        let t = turno_de_venta(&mut c, turno_id).await?;
        (t.is_none(), t.map(|t| t.id))
    };
    if !cerrado && devolucion_efectivo != 0 {
        return Err("En el turno abierto la anulación ya descuenta el efectivo de la venta".into());
    }
    let dueno = usuarios::confirmar_dueno(pool, a, pin, "anular venta").await?;

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let v = sqlx::query("SELECT numero, total, estado, turno_id, factura_emitida, factura_referencia FROM ventas WHERE id = ? AND eliminado_en IS NULL").bind(venta_id).fetch_one(&mut *tx).await.map_err(e)?;
    if v.get::<String, _>("estado") == "anulada" {
        return Err("La venta ya está anulada".into());
    }
    if turno_de_venta(&mut tx, v.get("turno_id")).await?.is_none() != cerrado {
        return Err("Alguien abrió o cerró la caja mientras tanto. Cierre esta ventana y vuelva a intentarlo.".into());
    }
    let total: i64 = v.get("total");
    let numero: String = v.get("numero");
    let ahora = ahora_iso();
    // Turno en que se anuló: el de la venta si sigue abierto; si no, la caja de hoy.
    let actual = if cerrado { Some(turno_para_ajuste(&mut tx, caja_id).await?) } else { None };
    sqlx::query("UPDATE ventas SET estado = 'anulada', anulada_por = ?, anulada_motivo = ?, anulada_en = ?, anulada_turno_id = ?, actualizado_en = ? WHERE id = ?")
        .bind(&dueno)
        .bind(&motivo)
        .bind(&ahora)
        .bind(actual.as_ref().map(|t| t.id.clone()).or(turno_venta))
        .bind(&ahora)
        .bind(venta_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    let mut det = json!({"numero": numero, "total": total, "motivo": motivo, "autorizadoPor": dueno});
    // Con factura electrónica hecha, falta la nota de crédito en el otro sistema: queda anotado.
    if v.get::<i64, _>("factura_emitida") == 1 {
        det["facturaEmitida"] = json!(v.get::<Option<String>, _>("factura_referencia"));
    }
    // Devuelve al inventario lo que la venta sacó, ligado a la venta original.
    let turno_anulacion = actual.as_ref().map(|t| t.id.clone()).or(v.get::<Option<String>, _>("turno_id"));
    inventario::devolver_anulacion(&mut tx, venta_id, &a.id, turno_anulacion.as_deref(), &ahora).await?;
    if let Some(actual) = actual {
        if !(0..=total).contains(&devolucion_efectivo) {
            return Err("La devolución no puede pasar del total de la venta".into());
        }
        if devolucion_efectivo > 0 && devolucion_efectivo > caja::resumen(&mut tx, &actual).await?.efectivo_esperado {
            return Err("No hay tanto efectivo en la caja para devolver".into());
        }
        let id = ulid();
        sqlx::query("INSERT INTO caja_ajustes (id, turno_id, venta_id, tipo, valor_anterior, valor_nuevo, monto, motivo, usuario_id, autorizado_por, fecha) VALUES (?, ?, ?, 'anulacion', ?, ?, ?, ?, ?, ?, ?)")
            .bind(&id)
            .bind(&actual.id)
            .bind(venta_id)
            .bind(json!({"estado": "completada", "turnoId": v.get::<Option<String>, _>("turno_id")}).to_string())
            .bind(json!({"estado": "anulada", "devolucionEfectivo": devolucion_efectivo}).to_string())
            .bind(total)
            .bind(&motivo)
            .bind(&a.id)
            .bind(&dueno)
            .bind(&ahora)
            .execute(&mut *tx)
            .await
            .map_err(e)?;
        if devolucion_efectivo > 0 {
            caja::insertar_movimiento(&mut tx, &actual, a, "salida", devolucion_efectivo, "Devolución", &format!("Anulación tiquete {numero}"), Some(&dueno)).await?;
        }
        det["ajusteId"] = json!(id);
        det["turnoActual"] = json!(actual.id);
        det["devolucionEfectivo"] = json!(devolucion_efectivo);
    }
    bitacora::registrar(&mut tx, Some(&a.id), "venta.anular", "venta", Some(venta_id), &det).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

// ─────────── Factura electrónica externa ───────────

/// Ventas que piden factura electrónica. El cajero, del turno abierto, solo ve las suyas.
pub async fn pendientes_factura(pool: &SqlitePool, a: &Actor) -> Res<Vec<Value>> {
    a.exigir("facturas", "ver pendientes de factura")?;
    let filas = sqlx::query(
        "SELECT v.id AS ventaId, v.numero, v.fecha, v.total, c.id AS clienteId, c.nombre AS cliente, c.cedula, (c.correo IS NOT NULL) AS tieneCorreo
         FROM ventas v JOIN clientes c ON c.id = v.cliente_id LEFT JOIN caja_turnos t ON t.id = v.turno_id
         WHERE v.requiere_factura = 1 AND v.factura_emitida = 0 AND v.estado = 'completada' AND v.eliminado_en IS NULL
           AND (? = 0 OR COALESCE(t.estado, 'cerrado') = 'cerrado' OR v.usuario_id = ?)
         ORDER BY v.fecha",
    )
    .bind((a.rol == Rol::Cajero) as i64)
    .bind(&a.id)
    .fetch_all(pool)
    .await
    .map_err(e)?;
    Ok(filas
        .iter()
        .map(|f| {
            let mut m = crate::bd::fila_json(f);
            m.insert("tieneCorreo".into(), json!(f.get::<i64, _>("tieneCorreo") == 1));
            Value::Object(m)
        })
        .collect())
}

/// El cliente vuelve y pide factura de una venta ya cobrada: queda en "Pendientes de factura"
/// con el cliente elegido (Hacienda lo necesita). No cambia montos ni pagos.
pub async fn pedir_factura(pool: &SqlitePool, a: &Actor, venta_id: &str, cliente_id: &str) -> Res<()> {
    a.exigir("facturas", "pedir facturas")?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let cliente: Option<i64> = sqlx::query_scalar("SELECT 1 FROM clientes WHERE id = ? AND anonimizado_en IS NULL")
        .bind(cliente_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(e)?;
    if cliente.is_none() {
        return Err("Elija un cliente registrado".into());
    }
    let n = sqlx::query(
        "UPDATE ventas SET requiere_factura = 1, cliente_id = ?, actualizado_en = ?
         WHERE id = ? AND estado = 'completada' AND factura_emitida = 0 AND requiere_factura = 0 AND eliminado_en IS NULL",
    )
    .bind(cliente_id)
    .bind(ahora_iso())
    .bind(venta_id)
    .execute(&mut *tx)
    .await
    .map_err(e)?
    .rows_affected();
    if n == 0 {
        return Err("Esa venta ya pidió factura, está anulada o ya tiene factura".into());
    }
    bitacora::registrar(&mut tx, Some(&a.id), "venta.pedir_factura", "venta", Some(venta_id), &json!({"cliente": cliente_id})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

pub async fn marcar_factura(pool: &SqlitePool, a: &Actor, venta_id: &str, referencia: &str) -> Res<()> {
    a.exigir("facturas", "marcar facturas")?;
    let r = texto(referencia, 80, "referencia", true)?;
    let ahora = ahora_iso();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let n = sqlx::query(
        "UPDATE ventas SET factura_emitida = 1, factura_referencia = ?, factura_marcada_por = ?, factura_marcada_en = ?, actualizado_en = ?
         WHERE id = ? AND requiere_factura = 1 AND factura_emitida = 0 AND estado = 'completada'",
    )
    .bind(&r)
    .bind(&a.id)
    .bind(&ahora)
    .bind(&ahora)
    .bind(venta_id)
    .execute(&mut *tx)
    .await
    .map_err(e)?
    .rows_affected();
    if n == 0 {
        return Err("Esa venta no está pendiente de factura (quizás ya se marcó o se anuló)".into());
    }
    bitacora::registrar(&mut tx, Some(&a.id), "venta.factura_emitida", "venta", Some(venta_id), &json!({"referencia": r})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caja::tests::conteo;
    use crate::caja::{abrir, cerrar, datos_z, detalle, imprimir_z, listar, CAJA_1};
    use crate::calculo::{Autorizacion, Linea};
    use crate::impresoras::tests::dos_impresoras;
    use crate::printer::simulada;
    use crate::usuarios::tests::base_con_usuarios;

    const LIBRERIA: &str = "00000000000000000000000D01";
    const FOTOCOPIAS: &str = "00000000000000000000000D07";

    async fn producto_en(p: &SqlitePool, nombre: &str, dep: &str, precio: i64) -> String {
        let id = ulid();
        sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, ?, ?, ?, ?)").bind(&id).bind(nombre).bind(nombre.to_lowercase()).bind(dep).bind(precio).execute(p).await.unwrap();
        id
    }

    async fn producto(p: &SqlitePool, precio: i64) -> (String, String) {
        (producto_en(p, "Cuaderno", LIBRERIA, precio).await, LIBRERIA.to_string())
    }

    fn linea(pid: &str, nombre: &str, dep: &str, precio: i64, cantidad: i64, descuento: i64) -> Linea {
        Linea { id: ulid(), producto_id: Some(pid.into()), codigo: None, descripcion: nombre.into(), departamento_id: dep.into(), cantidad, precio_unitario: precio, descuento, tasa_iva: 13.0, exento: false }
    }

    fn est(pid: &str, dep: &str, precio: i64, cantidad: i64, descuento: i64) -> Estado {
        Estado { lineas: vec![linea(pid, "Cuaderno", dep, precio, cantidad, descuento)], ..Default::default() }
    }

    fn pago(f: &str, m: i64) -> PagoEntrada {
        PagoEntrada { forma_pago_id: f.into(), monto: m, banco_id: None, referencia: None, ultimos4: None }
    }
    const EF: &str = "0000000000000000000000FP01";
    const TJ: &str = "0000000000000000000000FP02";
    const SP: &str = "0000000000000000000000FP03";
    const BCR: &str = "0000000000000000000000BN02";

    /// Crea la venta en espera y la cobra.
    async fn vender(p: &SqlitePool, a: &Actor, e: &Estado, pagos: &[PagoEntrada]) -> ResultadoCobro {
        let esp = crear_espera(p, a, CAJA_1, e).await.unwrap();
        cobrar(p, a, CAJA_1, &esp.id, e, pagos).await.unwrap()
    }

    #[tokio::test]
    async fn factura_anulacion_y_anonimizar_sin_perder_datos_fiscales() {
        let (bd, _, dueno, luis) = base_con_usuarios().await;
        let p = &bd.pool;
        let (pid, dep) = producto(p, 1000).await;
        abrir(p, &luis, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        let cli = crate::clientes::crear(p, &dueno, &crate::clientes::Datos { nombre: "Ana Mora".into(), telefono: "8000-0000".into(), ..Default::default() }, true, "1").await.unwrap();
        let mut e = est(&pid, &dep, 1000, 1, 0);
        e.cliente = Some(crate::calculo::ClienteBasico { id: cli.id.clone(), nombre: "Ana Mora".into(), telefono: None, cedula: None });
        e.nombre_tiquete = Some("Ana Mora".into());
        e.requiere_factura = true;
        let v = vender(p, &luis, &e, &[pago(EF, 1000)]).await;
        // Con la factura pendiente no se anonimiza (Hacienda necesita los datos).
        assert!(crate::clientes::anonimizar(p, &dueno, &cli.id, "246813", "solicitud_titular").await.unwrap_err().contains("pendiente(s) de factura"));
        marcar_factura(p, &dueno, &v.venta_id, "FE-001").await.unwrap();
        // Anular con factura hecha: queda anotada (falta la nota de crédito afuera).
        anular(p, &dueno, CAJA_1, &v.venta_id, "246813", "Cliente devolvió todo", 0).await.unwrap();
        let d: String = sqlx::query_scalar("SELECT detalle FROM bitacora WHERE accion = 'venta.anular'").fetch_one(p).await.unwrap();
        assert!(d.contains("FE-001"), "{d}");
        // Una venta anulada no se puede marcar como facturada.
        let mut e2 = e.clone();
        e2.nombre_tiquete = None;
        let v2 = vender(p, &luis, &e2, &[pago(EF, 1000)]).await;
        anular(p, &dueno, CAJA_1, &v2.venta_id, "246813", "Error de digitación", 0).await.unwrap();
        assert!(marcar_factura(p, &dueno, &v2.venta_id, "FE-002").await.unwrap_err().contains("anuló"));
        // Ahora sí se anonimiza, y el nombre impreso en sus tiquetes también se borra.
        crate::clientes::anonimizar(p, &dueno, &cli.id, "246813", "solicitud_titular").await.unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ventas WHERE nombre_tiquete IS NOT NULL").fetch_one(p).await.unwrap();
        assert_eq!(n, 0);
        let datos: Vec<String> = sqlx::query_scalar("SELECT datos FROM ventas_espera").fetch_all(p).await.unwrap();
        assert!(datos.iter().all(|x| !x.contains("Ana Mora")), "{datos:?}");
    }

    #[test]
    fn cantidad_fuera_de_rango_con_mensaje_claro() {
        let mut l = linea("P", "Lápiz", "D", 100, 100_001, 0);
        assert!(crate::calculo::validar_linea(&l).unwrap_err().contains("de 1 a 100.000"));
        l.cantidad = 0;
        assert!(crate::calculo::validar_linea(&l).unwrap_err().contains("de 1 a 100.000"));
    }

    #[tokio::test]
    async fn cobro_exige_turno_y_valida_precio_y_descuento() {
        let (bd, tec, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let (pid, dep) = producto(p, 1000).await;
        let e = est(&pid, &dep, 1000, 2, 0);
        let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
        // Sin caja abierta no se vende.
        assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago(EF, 2000)]).await.unwrap_err().contains("cerrada"));
        // El técnico no vende.
        assert!(cobrar(p, &tec, CAJA_1, &esp.id, &e, &[pago(EF, 2000)]).await.unwrap_err().contains("permiso"));
        abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
        // Precio manipulado en la pantalla: rechazado.
        let barato = est(&pid, &dep, 1, 2, 0);
        assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &barato, &[pago(EF, 2)]).await.unwrap_err().contains("precio"));
        // Descuento sobre el tope del cajero (10 %) sin autorización: no. Con un token inventado: tampoco.
        let mut desc = est(&pid, &dep, 1000, 2, 1000);
        assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &desc, &[pago(EF, 1000)]).await.unwrap_err().contains("PIN"));
        desc.autorizacion = Some(Autorizacion { dueno_id: dueno.id.clone(), pct: 50.0, token: Some("inventado".into()) });
        assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &desc, &[pago(EF, 1000)]).await.unwrap_err().contains("autorización"));
        let aut = autorizar_descuento(p, &cajero, &esp.id, 50.0, "246813").await.unwrap();
        desc.autorizacion = Some(Autorizacion { dueno_id: aut.dueno_id, pct: 50.0, token: Some(aut.token) });
        // Un cobro que falla (falta dinero) no gasta la autorización.
        assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &desc, &[pago(EF, 10)]).await.unwrap_err().contains("faltan"));
        let r = cobrar(p, &cajero, CAJA_1, &esp.id, &desc, &[pago(EF, 5000)]).await.unwrap();
        assert_eq!(r.vuelto, 4000);
        assert!(r.hay_efectivo && r.abrir_gaveta);
        // Doble clic: la espera ya se cobró.
        assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago(EF, 2000)]).await.is_err());
        let turno: String = sqlx::query_scalar("SELECT turno_id FROM ventas WHERE id = ?").bind(&r.venta_id).fetch_one(p).await.unwrap();
        // fondo + recibido − vuelto
        assert_eq!(detalle(p, &dueno, &turno).await.unwrap().resumen.efectivo_esperado, 10000 + 5000 - 4000);
    }

    #[tokio::test]
    async fn turno_compartido_cada_venta_con_su_usuario() {
        let (bd, _, dueno, luis) = base_con_usuarios().await;
        let p = &bd.pool;
        let (pid, dep) = producto(p, 1000).await;
        // El dueño abre; Luis entra y vende en ese mismo turno, sin abrir otro.
        let t = abrir(p, &dueno, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        assert!(crate::caja::estado(p, &luis, CAJA_1).await.unwrap().puede_usar);
        let v1 = vender(p, &dueno, &est(&pid, &dep, 1000, 1, 0), &[pago(EF, 1000)]).await;
        let v2 = vender(p, &luis, &est(&pid, &dep, 1000, 2, 0), &[pago(TJ, 2000)]).await;
        // Venta en espera que empezó el dueño y cobra Luis: queda quién la creó y quién la cobró.
        let mut e = est(&pid, &dep, 1000, 3, 0);
        e.lineas[0].descripcion = "Nombre inventado".into();
        let esp = crear_espera(p, &dueno, CAJA_1, &e).await.unwrap();
        let l = listar_esperas(p, &luis, CAJA_1).await.unwrap();
        assert_eq!(l.iter().find(|x| x.id == esp.id).unwrap().usuario, "Ana");
        let v3 = cobrar(p, &luis, CAJA_1, &esp.id, &e, &[pago(EF, 3000)]).await.unwrap();
        let (u, creo, tid): (String, String, String) = sqlx::query_as("SELECT usuario_id, espera_creada_por, turno_id FROM ventas WHERE id = ?").bind(&v3.venta_id).fetch_one(p).await.unwrap();
        assert_eq!((u.as_str(), creo.as_str(), tid.as_str()), (luis.id.as_str(), dueno.id.as_str(), t.id.as_str()));
        // El nombre del tiquete sale del catálogo, no de la pantalla.
        let d: String = sqlx::query_scalar("SELECT descripcion FROM venta_lineas WHERE venta_id = ?").bind(&v3.venta_id).fetch_one(p).await.unwrap();
        assert_eq!(d, "Cuaderno");
        // Cada pago guarda su usuario y su turno.
        for (v, quien) in [(&v1, &dueno), (&v2, &luis)] {
            let (pu, pt): (String, String) = sqlx::query_as("SELECT usuario_id, turno_id FROM venta_pagos WHERE venta_id = ?").bind(&v.venta_id).fetch_one(p).await.unwrap();
            assert_eq!((pu.as_str(), pt.as_str()), (quien.id.as_str(), t.id.as_str()));
        }
        // Luis cierra el turno que abrió Ana (tiene permiso de cierre): queda quién abrió y quién cerró.
        cerrar(p, &luis, CAJA_1, &conteo(&[(1000, 9)]), "").await.unwrap();
        let d = detalle(p, &luis, &t.id).await.unwrap();
        assert_eq!((d.turno.usuario_apertura.as_str(), d.turno.usuario_cierre.as_deref()), ("Ana", Some("Luis")));
        // El Z dice qué vendió cada uno.
        let pu = &d.resumen.por_usuario;
        assert_eq!(pu.iter().find(|x| x.usuario == "Luis").map(|x| (x.ventas, x.total)), Some((2, 5000)));
        assert_eq!(pu.iter().find(|x| x.usuario == "Ana").map(|x| (x.ventas, x.total)), Some((1, 1000)));
        // Producto desactivado: no se vende.
        abrir(p, &luis, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        sqlx::query("UPDATE productos SET activo = 0 WHERE id = ?").bind(&pid).execute(p).await.unwrap();
        let e2 = est(&pid, &dep, 1000, 1, 0);
        let esp2 = crear_espera(p, &luis, CAJA_1, &e2).await.unwrap();
        assert!(cobrar(p, &luis, CAJA_1, &esp2.id, &e2, &[pago(EF, 1000)]).await.unwrap_err().contains("desactivado"));
    }

    #[tokio::test]
    async fn sin_turno_compartido_otro_no_vende() {
        let (bd, tec, dueno, luis) = base_con_usuarios().await;
        let p = &bd.pool;
        crate::config::guardar(p, &dueno, "caja_turno_compartido", &json!(false)).await.unwrap();
        let m = usuarios::crear(p, &tec, "María", Rol::Cajero, "1357").await.unwrap();
        let maria = Actor { id: m.id, rol: Rol::Cajero, nombre: "María".into() };
        let (pid, dep) = producto(p, 1000).await;
        abrir(p, &luis, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        let e = est(&pid, &dep, 1000, 1, 0);
        let esp = crear_espera(p, &maria, CAJA_1, &e).await.unwrap();
        assert!(cobrar(p, &maria, CAJA_1, &esp.id, &e, &[pago(EF, 1000)]).await.unwrap_err().contains("Luis"));
        assert!(cobrar(p, &dueno, CAJA_1, &esp.id, &e, &[pago(EF, 1000)]).await.unwrap_err().contains("Luis"));
        cobrar(p, &luis, CAJA_1, &esp.id, &e, &[pago(EF, 1000)]).await.unwrap();
    }

    #[tokio::test]
    async fn cajero_no_recibe_totales_del_turno_abierto() {
        let (bd, _, dueno, luis) = base_con_usuarios().await;
        let p = &bd.pool;
        let (pid, dep) = producto(p, 1000).await;
        let t = abrir(p, &dueno, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        let del_dueno = vender(p, &dueno, &est(&pid, &dep, 1000, 7, 0), &[pago(TJ, 7000)]).await;
        let mia = vender(p, &luis, &est(&pid, &dep, 1000, 2, 0), &[pago(EF, 2000)]).await;
        // Caja: ningún total, ni cantidad, ni formas, ni esperado, ni pagos electrónicos.
        let d = detalle(p, &luis, &t.id).await.unwrap();
        assert!(!d.ve_totales);
        let r = &d.resumen;
        assert_eq!((r.ventas, r.total_ventas, r.efectivo_esperado, r.ventas_efectivo, r.recibido_efectivo), (0, 0, 0, 0, 0));
        assert!(r.por_forma.is_empty() && r.por_usuario.is_empty() && r.pagos_electronicos.is_empty() && r.desglose.departamentos.is_empty());
        let txt = serde_json::to_string(&d).unwrap();
        assert!(!txt.contains("9000") && !txt.contains("7000"), "{txt}");
        // Mis turnos: sin ventas ni total del turno abierto.
        let fila = listar(p, &luis, CAJA_1, "2000-01-01", "2999-12-31").await.unwrap();
        assert_eq!((fila[0].ventas, fila[0].total), (None, None));
        // Ventas del día: solo sus propios tiquetes; el tiquete de otro, ni por id.
        let dia = listar_dia(p, &luis, CAJA_1, &dia_local()).await.unwrap();
        assert_eq!(dia.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec![mia.venta_id.as_str()]);
        assert!(obtener(p, &luis, &del_dueno.venta_id).await.unwrap_err().contains("permiso"));
        assert!(obtener(p, &luis, &mia.venta_id).await.unwrap().is_some());
        // Tampoco en "Facturas pendientes" ve los tiquetes de otro del turno abierto.
        let cli = crate::clientes::crear(p, &dueno, &crate::clientes::Datos { nombre: "Ana Mora".into(), telefono: "8000-0000".into(), ..Default::default() }, true, "1").await.unwrap();
        pedir_factura(p, &dueno, &del_dueno.venta_id, &cli.id).await.unwrap();
        assert!(pendientes_factura(p, &luis).await.unwrap().is_empty());
        assert_eq!(pendientes_factura(p, &dueno).await.unwrap().len(), 1);
        // Ni el Z (el turno sigue abierto), ni un corte.
        assert!(datos_z(p, &luis, &t.id).await.is_err());
        assert!(crate::caja::corte(p, &luis, CAJA_1, None, None).await.unwrap_err().contains("permiso"));
        // Ni pidiéndolo directo con SQL desde la pantalla.
        for sql in ["SELECT SUM(total) FROM ventas", "SELECT * FROM venta_lineas", "SELECT * FROM caja_turnos", "SELECT monto FROM venta_pagos", "SELECT * FROM caja_cortes"] {
            assert!(bd.leer(&luis, sql, &[]).await.is_err(), "{sql}");
        }
        // El dueño sí ve todo.
        assert_eq!(detalle(p, &dueno, &t.id).await.unwrap().resumen.total_ventas, 9000);
        // Cerrado el turno, el cajero ve el resultado completo.
        cerrar(p, &luis, CAJA_1, &conteo(&[(1000, 7)]), "").await.unwrap();
        let d = detalle(p, &luis, &t.id).await.unwrap();
        assert!(d.ve_totales);
        assert_eq!((d.resumen.total_ventas, d.turno.diferencia), (9000, Some(0)));
        assert_eq!(listar(p, &luis, CAJA_1, "2000-01-01", "2999-12-31").await.unwrap()[0].total, Some(9000));
        assert_eq!(listar_dia(p, &luis, CAJA_1, &dia_local()).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn solo_el_dueno_anula_o_cambia_el_pago() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let (pid, dep) = producto(p, 5000).await;
        abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
        let v = vender(p, &cajero, &est(&pid, &dep, 5000, 1, 0), &[pago(TJ, 5000)]).await;
        let pago_id: String = sqlx::query_scalar("SELECT id FROM venta_pagos WHERE venta_id = ?").bind(&v.venta_id).fetch_one(p).await.unwrap();
        let sinpe = CambioPago { forma_pago_id: SP.into(), banco_id: None, referencia: Some("12345".into()), ultimos4: None };
        // El cajero no cambia el pago ni anula, ni con el PIN del dueño.
        assert!(corregir_pago(p, &cajero, CAJA_1, &pago_id, &sinpe, "Era SINPE, no tarjeta", Some("246813")).await.unwrap_err().contains("permiso"));
        assert!(anular(p, &cajero, CAJA_1, &v.venta_id, "246813", "Se equivocó", 0).await.unwrap_err().contains("permiso"));
        // El dueño sí, con su PIN y motivo.
        assert!(corregir_pago(p, &dueno, CAJA_1, &pago_id, &sinpe, "Era SINPE, no tarjeta", None).await.is_err());
        corregir_pago(p, &dueno, CAJA_1, &pago_id, &sinpe, "Era SINPE, no tarjeta", Some("246813")).await.unwrap();
        assert!(anular(p, &dueno, CAJA_1, &v.venta_id, "000000", "Se equivocó", 0).await.is_err());
        anular(p, &dueno, CAJA_1, &v.venta_id, "246813", "Se equivocó de producto", 0).await.unwrap();
        // Anulada, no borrada; con quién y en qué turno.
        let (estado, por, turno): (String, String, Option<String>) = sqlx::query_as("SELECT estado, anulada_por, anulada_turno_id FROM ventas WHERE id = ?").bind(&v.venta_id).fetch_one(p).await.unwrap();
        assert_eq!((estado.as_str(), por.as_str()), ("anulada", dueno.id.as_str()));
        assert!(turno.is_some());
        let r = cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 10)]), "").await.unwrap();
        let d = detalle(p, &dueno, &r.turno_id).await.unwrap();
        assert_eq!((d.resumen.anuladas, d.resumen.total_anuladas, d.resumen.total_ventas), (1, 5000, 0));
    }

    #[tokio::test]
    async fn turno_cerrado_pagos_inmutables_y_ajustes() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let (pid, dep) = producto(p, 5000).await;
        let t1 = abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
        let v = vender(p, &cajero, &est(&pid, &dep, 5000, 1, 0), &[pago(TJ, 5000)]).await;
        let pago_id: String = sqlx::query_scalar("SELECT id FROM venta_pagos WHERE venta_id = ?").bind(&v.venta_id).fetch_one(p).await.unwrap();
        let sinpe = CambioPago { forma_pago_id: SP.into(), banco_id: None, referencia: Some("12345".into()), ultimos4: None };
        corregir_pago(p, &dueno, CAJA_1, &pago_id, &sinpe, "Era SINPE, no tarjeta", Some("246813")).await.unwrap();
        cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 10)]), "").await.unwrap();

        // Ni directo en la base se puede cambiar un pago de un turno cerrado.
        assert!(sqlx::query("UPDATE venta_pagos SET monto = 1 WHERE id = ?").bind(&pago_id).execute(p).await.unwrap_err().to_string().contains("turno cerrado"));
        assert!(sqlx::query("UPDATE ventas SET total = 1 WHERE id = ?").bind(&v.venta_id).execute(p).await.is_err());

        let tarjeta = CambioPago { forma_pago_id: TJ.into(), banco_id: None, referencia: None, ultimos4: None };
        // Dueño sin caja abierta hoy: no hay dónde registrar el ajuste.
        assert!(corregir_pago(p, &dueno, CAJA_1, &pago_id, &tarjeta, "Era tarjeta al final", Some("246813")).await.unwrap_err().contains("primero ábrala"));
        let t2 = abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
        corregir_pago(p, &dueno, CAJA_1, &pago_id, &tarjeta, "Era tarjeta al final", Some("246813")).await.unwrap();
        // Anular la venta del turno cerrado devolviendo efectivo: ajuste + salida en el turno actual.
        anular(p, &dueno, CAJA_1, &v.venta_id, "246813", "Cliente devolvió", 5000).await.unwrap();
        let d2 = detalle(p, &dueno, &t2.id).await.unwrap();
        assert_eq!(d2.resumen.ajustes.len(), 2);
        assert_eq!(d2.resumen.salidas, 5000);
        assert_eq!(d2.resumen.efectivo_esperado, 5000);
        // El turno cerrado quedó igual.
        let d1 = detalle(p, &dueno, &t1.id).await.unwrap();
        assert_eq!(d1.resumen.total_ventas, 5000);
        assert_eq!(d1.resumen.por_forma[0].nombre, "SINPE Móvil");
        assert_eq!(d1.resumen.pagos_electronicos.len(), 1);
        assert_eq!(d1.resumen.pagos_electronicos[0].referencia.as_deref(), Some("12345"));
    }

    #[tokio::test]
    async fn z_cuadra_por_departamento_y_efectivo_esperado() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let (tiq, _) = dos_impresoras(p, &dueno, "ZC").await;
        let cuaderno = producto_en(p, "Cuaderno", LIBRERIA, 1500).await;
        let color = producto_en(p, "IMPRESIONES A COLOR", FOTOCOPIAS, 200).await;
        let t = abrir(p, &cajero, CAJA_1, &conteo(&[(10000, 1)])).await.unwrap();
        // 42 impresiones por SINPE; 1 en efectivo; venta mixta con descuento al total y redondeo.
        vender(p, &cajero, &Estado { lineas: vec![linea(&color, "IMPRESIONES A COLOR", FOTOCOPIAS, 200, 42, 0)], ..Default::default() }, &[PagoEntrada { referencia: Some("69898".into()), ..pago(SP, 8400) }]).await;
        vender(p, &cajero, &Estado { lineas: vec![linea(&color, "IMPRESIONES A COLOR", FOTOCOPIAS, 200, 1, 0)], ..Default::default() }, &[pago(EF, 1000)]).await;
        let mixta = Estado { lineas: vec![linea(&cuaderno, "Cuaderno", LIBRERIA, 1500, 1, 0), linea(&color, "IMPRESIONES A COLOR", FOTOCOPIAS, 200, 3, 0)], descuento_total: 103, ..Default::default() };
        // 2100 − 103 = 1997 → redondeo a 1995.
        let v = vender(p, &cajero, &mixta, &[PagoEntrada { banco_id: Some(BCR.into()), referencia: Some("777".into()), ..pago(SP, 1000) }, pago(EF, 2000)]).await;
        assert_eq!(v.vuelto, 1005);
        let entrada = crate::caja::NuevoMovimiento { tipo: "entrada".into(), monto: 3000, categoria: "Ingreso de cambio".into(), nota: String::new() };
        crate::caja::movimiento(p, &cajero, CAJA_1, &entrada, None).await.unwrap();
        let salida = crate::caja::NuevoMovimiento { tipo: "salida".into(), monto: 500, categoria: "Gasto menor".into(), nota: String::new() };
        crate::caja::movimiento(p, &cajero, CAJA_1, &salida, None).await.unwrap();
        let r = detalle(p, &dueno, &t.id).await.unwrap().resumen;
        assert!(r.cuadra, "{:?}", r.descuadres);
        // Efectivo esperado = fondo + recibido + entradas − salidas − vueltos.
        assert_eq!(r.recibido_efectivo, 1000 + 2000);
        assert_eq!(r.vueltos, 800 + 1005);
        assert_eq!(r.efectivo_esperado, 10000 + r.recibido_efectivo + 3000 - 500 - r.vueltos);
        assert_eq!(r.total_ventas, 8400 + 200 + 1995);
        // Departamentos y detalle suman el total; su efectivo, el efectivo de las ventas.
        let deps: i64 = r.desglose.departamentos.iter().map(|d| d.monto).sum();
        let filas: i64 = r.desglose.departamentos.iter().flat_map(|d| &d.filas).map(|f| f.monto).sum();
        let ef: i64 = r.desglose.departamentos.iter().map(|d| d.efectivo).sum();
        assert_eq!((deps, filas, ef), (r.total_ventas, r.total_ventas, r.ventas_efectivo));
        assert_eq!(r.por_forma.iter().map(|f| f.monto).sum::<i64>(), r.total_ventas);
        let foto = r.desglose.departamentos.iter().find(|d| d.nombre == "Fotocopias").unwrap();
        assert!(foto.filas.iter().any(|f| f.codigo == "De" && f.cantidad == 42 && f.monto == 8400));
        assert!(foto.filas.iter().any(|f| f.codigo == "Mx" && f.cantidad == 3));
        // El SINPE con banco sale en el detalle electrónico con su abreviatura.
        assert!(r.pagos_electronicos.iter().any(|x| x.banco.as_deref() == Some("BCR") && x.referencia.as_deref() == Some("777")));
        // Cierra, y el Z congelado cuadra igual. Se imprime una vez como original; la copia pide PIN y marca.
        cerrar(p, &cajero, CAJA_1, &conteo(&[(10000, 1), (2000, 1), (100, 7)]), "").await.unwrap();
        let (d, copia) = datos_z(p, &cajero, &t.id).await.unwrap();
        assert!(!copia && d.resumen.cuadra && d.resumen.con_desglose);
        assert_eq!(d.resumen.desglose.departamentos.iter().map(|x| x.monto).sum::<i64>(), d.resumen.total_ventas);
        assert!(!imprimir_z(p, &cajero, &t.id, &[b"Z\n".to_vec(), b"Depto\n".to_vec()], None).await.unwrap());
        assert_eq!(simulada::trabajos(&tiq).last().unwrap(), &b"Z\nDepto\n".to_vec());
        assert!(imprimir_z(p, &cajero, &t.id, &[b"Z\n".to_vec()], Some("246813")).await.unwrap_err().contains("COPIA"));
        assert!(imprimir_z(p, &cajero, &t.id, &[b"*** COPIA ***\n".to_vec()], None).await.unwrap_err().contains("PIN"));
        assert!(imprimir_z(p, &cajero, &t.id, &[b"*** COPIA ***\n".to_vec()], Some("246813")).await.unwrap());
        // Si algo no cuadra (aquí, alterando lo congelado en la base), el Z no se imprime.
        let mut tot: Value = serde_json::from_str(&sqlx::query_scalar::<_, String>("SELECT totales FROM caja_turnos WHERE id = ?").bind(&t.id).fetch_one(p).await.unwrap()).unwrap();
        tot["totalVentas"] = json!(1);
        sqlx::query("DROP TRIGGER caja_turnos_conteo_bloqueado").execute(p).await.unwrap();
        sqlx::query("UPDATE caja_turnos SET totales = ? WHERE id = ?").bind(tot.to_string()).bind(&t.id).execute(p).await.unwrap();
        let err = imprimir_z(p, &dueno, &t.id, &[b"*** COPIA ***\n".to_vec()], Some("246813")).await.unwrap_err();
        assert!(err.contains("no cuadran"), "{err}");
    }

    #[tokio::test]
    async fn dos_impresoras_y_la_venta_no_se_pierde() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let (tiq, etq) = dos_impresoras(p, &dueno, "VEN").await;
        let (pid, dep) = producto(p, 1000).await;
        abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        // La impresora de tiquetes está apagada: el cobro igual queda guardado.
        simulada::apagar(&tiq, true);
        let v = vender(p, &cajero, &est(&pid, &dep, 1000, 1, 0), &[pago(EF, 1000)]).await;
        let err = imprimir_tiquete(p, &cajero, &v.venta_id, b"Tiquete\n").await.unwrap_err();
        assert!(err.contains("no respondió"), "{err}");
        assert!(obtener(p, &cajero, &v.venta_id).await.unwrap().is_some());
        // La etiqueta va a la otra impresora y sale aunque la de tiquetes esté apagada.
        crate::impresoras::enviar(p, CAJA_1, "etiqueta", b"Etiqueta\n").await.unwrap();
        assert_eq!(simulada::trabajos(&etq).len(), 1);
        // Se enciende: el original sale (una vez) y solo a la de tiquetes.
        simulada::apagar(&tiq, false);
        assert!(!imprimir_tiquete(p, &cajero, &v.venta_id, b"Tiquete\n").await.unwrap());
        assert!(imprimir_tiquete(p, &cajero, &v.venta_id, b"Tiquete\n").await.unwrap_err().contains("COPIA"));
        assert!(imprimir_tiquete(p, &cajero, &v.venta_id, b"*** COPIA ***\n").await.unwrap());
        assert_eq!(simulada::trabajos(&tiq).len(), 2);
        assert_eq!(simulada::trabajos(&etq).len(), 1);
        // Un tiquete no puede traer el pulso de la gaveta.
        assert!(imprimir_tiquete(p, &cajero, &v.venta_id, &[b'x', 0x1b, b'p', 0, 25, 250]).await.is_err());
        // Gaveta por venta: solo con efectivo y una sola vez.
        crate::gaveta::por_venta(p, &cajero, &v.venta_id).await.unwrap();
        assert!(crate::gaveta::por_venta(p, &cajero, &v.venta_id).await.unwrap_err().contains("ya se abrió"));
        let tarjeta = vender(p, &cajero, &est(&pid, &dep, 1000, 1, 0), &[pago(TJ, 1000)]).await;
        assert!(!tarjeta.abrir_gaveta);
        assert!(crate::gaveta::por_venta(p, &cajero, &tarjeta.venta_id).await.unwrap_err().contains("efectivo"));
    }

    #[tokio::test]
    async fn quitar_lineas_caras_queda_en_bitacora() {
        let (bd, _, _, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let barato = producto_en(p, "Lápiz", LIBRERIA, 300).await;
        let caro = producto_en(p, "Calculadora", LIBRERIA, 12000).await;
        let mut e = Estado { lineas: vec![linea(&barato, "Lápiz", LIBRERIA, 300, 1, 0), linea(&caro, "Calculadora", LIBRERIA, 12000, 2, 0)], ..Default::default() };
        let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
        // Quitar el lápiz (¢300) no se anota; bajar una calculadora (¢12.000) sí.
        e.lineas.remove(0);
        guardar_espera(p, &cajero, &esp.id, &e).await.unwrap();
        e.lineas[0].cantidad = 1;
        guardar_espera(p, &cajero, &esp.id, &e).await.unwrap();
        let filas: Vec<String> = sqlx::query_scalar("SELECT detalle FROM bitacora WHERE accion = 'venta_espera.quitar_linea'").fetch_all(p).await.unwrap();
        assert_eq!(filas.len(), 1);
        assert!(filas[0].contains("Calculadora") && filas[0].contains("12000"));
    }

    #[tokio::test]
    async fn z_con_control_por_usuario_horas_y_mas_vendidos() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
        let lapiz = producto_en(p, "Lápiz", LIBRERIA, 300).await;
        let caro = producto_en(p, "Calculadora", LIBRERIA, 12000).await;
        // Cajero: quita una calculadora antes de cobrar (¢12.000, queda anotado) y da ¢100 de descuento.
        let mut e = Estado { lineas: vec![linea(&caro, "Calculadora", LIBRERIA, 12000, 2, 0), linea(&lapiz, "Lápiz", LIBRERIA, 300, 3, 0)], ..Default::default() };
        let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
        e.lineas[0].cantidad = 1;
        e.lineas[1].descuento = 90;
        guardar_espera(p, &cajero, &esp.id, &e).await.unwrap();
        cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago(EF, 12810)]).await.unwrap();
        // Dueño: una venta simple (precio escrito a mano) y otra con lápices.
        let libre = Linea { producto_id: None, ..linea("x", "Regalo", LIBRERIA, 2500, 1, 0) };
        vender(p, &dueno, &Estado { lineas: vec![libre], ..Default::default() }, &[pago(EF, 2500)]).await;
        vender(p, &dueno, &est(&lapiz, LIBRERIA, 300, 1, 0), &[pago(TJ, 300)]).await;

        let t = caja::turno_abierto(&mut p.acquire().await.unwrap(), CAJA_1).await.unwrap().unwrap();
        let x = detalle(p, &dueno, &t.id).await.unwrap().resumen.estadisticas;
        let k = |u: &str| x.control.iter().find(|c| c.usuario == u).cloned().unwrap_or_default();
        assert_eq!((k("Luis").descuentos, k("Luis").lineas_quitadas, k("Luis").monto_quitado, k("Luis").precio_libre), (90, 1, 12000, 0));
        assert_eq!((k("Ana").precio_libre, k("Ana").monto_precio_libre, k("Ana").descuentos), (1, 2500, 0));
        assert_eq!(x.por_hora.iter().map(|h| h.ventas).sum::<i64>(), 3);
        assert_eq!(x.tiquete_promedio, (12810 + 2500 + 300) / 3);
        assert_eq!((x.hoy.ventas, x.hoy.total, x.semana_anterior.ventas), (3, 15610, 0));
        // Más vendidos: por cantidad, solo del catálogo (la venta simple ya sale en Control).
        assert_eq!(x.top_productos.iter().map(|t| (t.producto.as_str(), t.cantidad)).collect::<Vec<_>>(), [("Lápiz", 4), ("Calculadora", 1)]);
        // Con el turno abierto, el cajero no recibe nada de esto.
        assert_eq!(detalle(p, &cajero, &t.id).await.unwrap().resumen.estadisticas, Default::default());

        // Supervisor del Z: abierto, los dueños activos; al cerrar un dueño, ese dueño.
        let tec = Actor { id: crate::usuarios::tecnico_id(p).await.unwrap().unwrap(), rol: Rol::Tecnico, nombre: "T".into() };
        crate::usuarios::crear(p, &tec, "Bea", Rol::Dueno, "864209").await.unwrap();
        assert_eq!(detalle(p, &dueno, &t.id).await.unwrap().resumen.supervisor, "Ana / Bea");
        let esperado = detalle(p, &dueno, &t.id).await.unwrap().resumen.efectivo_esperado;
        cerrar(p, &dueno, CAJA_1, &crate::caja::Conteo { total: Some(esperado), ..Default::default() }, "").await.unwrap();
        assert_eq!(detalle(p, &dueno, &t.id).await.unwrap().resumen.supervisor, "Ana");
    }

    #[tokio::test]
    async fn pedir_factura_una_vez_y_no_en_anuladas() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let (pid, dep) = producto(p, 1000).await;
        abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        let e = est(&pid, &dep, 1000, 1, 0);
        let v = vender(p, &cajero, &e, &[pago(EF, 1000)]).await.venta_id;
        let cli = crate::clientes::crear(p, &cajero, &crate::clientes::Datos { nombre: "Ana Mora".into(), telefono: "8000-0000".into(), ..Default::default() }, true, "1").await.unwrap();
        assert!(pedir_factura(p, &cajero, &v, "NO-EXISTE").await.unwrap_err().contains("cliente"));
        pedir_factura(p, &cajero, &v, &cli.id).await.unwrap();
        let (req, c): (i64, Option<String>) = sqlx::query_as("SELECT requiere_factura, cliente_id FROM ventas WHERE id = ?").bind(&v).fetch_one(p).await.unwrap();
        assert_eq!((req, c.as_deref()), (1, Some(cli.id.as_str())));
        // Dos veces no; y una venta anulada tampoco.
        assert!(pedir_factura(p, &cajero, &v, &cli.id).await.is_err());
        let v2 = vender(p, &cajero, &e, &[pago(EF, 1000)]).await.venta_id;
        anular(p, &dueno, CAJA_1, &v2, "246813", "Se equivocó", 0).await.unwrap();
        assert!(pedir_factura(p, &cajero, &v2, &cli.id).await.is_err());
    }
}
