// Apartados y crédito (fase 3, DISENO-FASE3.md).
// - Apartado: el cliente deja productos separados con un abono; las unidades quedan RESERVADAS (no
//   salen del kardex). Cuando paga todo se crea una venta normal con las líneas y precios del
//   apartado (sin pagos por lo ya abonado: `ventas.cuenta_id`) y ahí sale del inventario.
// - Crédito: la venta se reconoce al crearla (ventas::cobrar_opc con credito); lo que falta queda
//   en una cuenta y se cobra en abonos.
// - Cada abono es DINERO del turno donde se recibe (su fecha de negocio sale del turno); la venta
//   entra al Z el día que se liquida. Ningún colón se cuenta dos veces.
// Rust decide todo: mínimo, plazo, saldo, límite, estados y permisos, en una transacción.

use crate::bitacora;
use crate::caja::{self, Horario, Turno};
use crate::calculo::{self, Estado, Linea, PagoEntrada};
use crate::config;
use crate::inventario;
use crate::sesion::Actor;
use crate::usuarios;
use crate::util::{ahora, ahora_iso, colones, e, normalizar, texto, ulid, Res};
use crate::ventas::{self, NuevaVenta};
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Row, SqliteConnection, SqlitePool};
#[cfg(test)]
use ts_rs::TS;

pub const APARTADO: &str = "apartado";
pub const CREDITO: &str = "credito";

// ─────────── Reglas (una sola vez; la pantalla las pide con cuentas_reglas) ───────────

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct Reglas {
    pub usa_apartados: bool,
    pub usa_credito: bool,
    /// % del total que se abona al apartar (solo el primer abono).
    pub abono_minimo_pct: i64,
    pub plazo_dias: i64,
    /// "calendario" o "laborables".
    pub plazo_tipo: String,
    /// "devolver" o "retener" (saldo a favor queda diseñado, apagado).
    pub cancelacion: String,
    pub retencion_pct: i64,
    pub condiciones: String,
    /// Crédito: plazo para pagar, cómo se cuentan los días y condiciones impresas. Los límites NO van
    /// aquí (las reglas las ve el cajero): están en OpcionesCredito, solo para el dueño.
    pub credito_plazo_dias: i64,
    pub credito_plazo_tipo: String,
    pub credito_condiciones: String,
}

pub async fn reglas_con(c: &mut SqliteConnection) -> Reglas {
    let txt = |v: Option<serde_json::Value>, defecto: &str| v.and_then(|x| x.as_str().map(String::from)).unwrap_or_else(|| defecto.into());
    Reglas {
        usa_apartados: config::booleano_con(c, "usa_apartados", true).await,
        usa_credito: config::booleano_con(c, "usa_credito", false).await,
        abono_minimo_pct: config::entero_con(c, "abono_minimo_pct", 50).await.clamp(0, 100),
        plazo_dias: config::entero_con(c, "apartado_plazo_dias", 30).await.clamp(1, 365),
        plazo_tipo: txt(config::valor_con(c, "apartado_plazo_tipo").await, "calendario"),
        cancelacion: txt(config::valor_con(c, "apartado_cancelacion").await, "devolver"),
        retencion_pct: config::entero_con(c, "apartado_retencion_pct", 0).await.clamp(0, 100),
        condiciones: txt(config::valor_con(c, "apartado_condiciones").await, ""),
        credito_plazo_dias: config::entero_con(c, "credito_plazo_dias", 30).await.clamp(1, 365),
        credito_plazo_tipo: txt(config::valor_con(c, "credito_plazo_tipo").await, "calendario"),
        credito_condiciones: txt(config::valor_con(c, "credito_condiciones").await, ""),
    }
}

/// Lo que el cliente todavía puede deber: límite menos lo que ya debe en créditos abiertos (nunca negativo).
pub fn credito_disponible(limite: i64, saldo_actual: i64) -> i64 {
    (limite - saldo_actual).max(0)
}

pub async fn reglas(pool: &SqlitePool, a: &Actor) -> Res<Reglas> {
    a.exigir("cuentas.crear", "ver las reglas de apartados")?;
    let mut c = pool.acquire().await.map_err(e)?;
    Ok(reglas_con(&mut c).await)
}

/// Abono mínimo al apartar: el % del total, redondeado hacia arriba (nunca menos de ¢1 si hay total).
pub fn abono_minimo(total: i64, pct: i64) -> i64 {
    if total <= 0 || pct <= 0 {
        return 0;
    }
    (total * pct.min(100) + 99) / 100
}

/// Fecha límite: `dias` después del día de negocio en que se creó. En calendario, si cae en un día
/// que no se trabaja, pasa al próximo laborable; en laborables, cuenta solo días de trabajo.
pub fn fecha_limite(desde: NaiveDate, dias: i64, tipo: &str, h: &Horario) -> NaiveDate {
    let laborable = |d: NaiveDate| h[d.weekday().num_days_from_monday() as usize].is_some();
    if tipo == "laborables" {
        let mut d = desde;
        let mut n = 0;
        // Tope de seguridad: un horario sin días laborables no deja ciclos infinitos.
        for _ in 0..(dias * 7 + 7) {
            if n == dias {
                break;
            }
            d = d.succ_opt().unwrap_or(d);
            if laborable(d) {
                n += 1;
            }
        }
        return d;
    }
    let d = desde + chrono::Duration::days(dias);
    if laborable(d) { d } else { caja::siguiente_laborable(d, h) }
}

/// Un abono: más de 0, no más del saldo y, el primero, al menos el mínimo.
pub fn validar_abono(saldo: i64, monto: i64, minimo: Option<i64>) -> Res<()> {
    if monto <= 0 {
        return Err("Escriba cuánto abona".into());
    }
    if monto > saldo {
        return Err(format!("El abono pasa del saldo ({})", colones(saldo)));
    }
    if let Some(m) = minimo.filter(|m| monto < *m) {
        return Err(format!("El abono mínimo para apartar es {}", colones(m)));
    }
    Ok(())
}

/// ¿Alcanza el crédito? Límite del cliente o, si no tiene, el del negocio. Límite 0 = sin crédito.
pub fn credito_alcanza(limite: i64, saldo_actual: i64, nuevo: i64) -> bool {
    limite > 0 && saldo_actual + nuevo <= limite
}

// ─────────── Tipos ───────────

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CuentaFila {
    pub id: String,
    pub numero: String,
    pub tipo: String,
    pub estado: String,
    pub cliente_id: String,
    pub cliente: String,
    pub telefono: Option<String>,
    pub fecha: String,
    pub fecha_limite: Option<String>,
    /// Qué se apartó, en palabras del cajero (opcional).
    pub descripcion: Option<String>,
    pub total: i64,
    pub saldo: i64,
    pub abonado: i64,
    pub vencida: bool,
    pub dias_atraso: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CuentaLinea {
    pub producto_id: Option<String>,
    pub descripcion: String,
    pub cantidad: i64,
    pub precio_unitario: i64,
    pub descuento: i64,
    pub total: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct AbonoFila {
    pub id: String,
    pub fecha: String,
    pub forma: String,
    pub monto: i64,
    pub recibido: Option<i64>,
    pub vuelto: Option<i64>,
    pub referencia: Option<String>,
    pub usuario: String,
    pub anulado: bool,
    pub operacion_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct EventoFila {
    pub fecha: String,
    pub tipo: String,
    pub monto: i64,
    pub usuario: String,
    pub motivo: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CuentaDetalle {
    pub cuenta: CuentaFila,
    pub subtotal: i64,
    pub descuento: i64,
    pub redondeo: i64,
    pub condonado: i64,
    pub devuelto: i64,
    pub retenido: i64,
    /// Total de la venta ligada (crédito: la venta a crédito; apartado: la liquidación).
    pub venta_total: Option<i64>,
    pub venta_id: Option<String>,
    pub venta_numero: Option<String>,
    pub usuario: String,
    pub lineas: Vec<CuentaLinea>,
    pub abonos: Vec<AbonoFila>,
    /// Solo el dueño recibe el historial completo (ajustes, condonaciones, motivos).
    pub eventos: Vec<EventoFila>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ResultadoAbono {
    pub cuenta_id: String,
    pub numero: String,
    pub estado: String,
    pub saldo: i64,
    pub abonado_ahora: i64,
    pub vuelto: i64,
    pub hay_efectivo: bool,
    pub abrir_gaveta: bool,
    /// La venta que se creó al liquidar (apartado pagado completo).
    pub venta_id: Option<String>,
    pub venta_numero: Option<String>,
}

// ─────────── Ayudas internas ───────────

fn numero(tipo: &str, n: i64) -> String {
    format!("{}-{n:04}", if tipo == CREDITO { "C" } else { "A" })
}

pub(crate) async fn cliente_con_consentimiento(c: &mut SqliteConnection, id: &str) -> Res<()> {
    let ok: Option<i64> = sqlx::query_scalar("SELECT 1 FROM clientes WHERE id = ? AND anonimizado_en IS NULL AND consentimiento_datos = 1").bind(id).fetch_optional(&mut *c).await.map_err(e)?;
    ok.map(|_| ()).ok_or_else(|| "El cliente no tiene el consentimiento para guardar sus datos: créelo de nuevo con la casilla del aviso".into())
}

async fn siguiente_numero(c: &mut SqliteConnection, caja_id: &str, tipo: &str, fecha: &str) -> Res<(i64, String)> {
    let n: i64 = sqlx::query_scalar("SELECT cuenta_siguiente FROM cajas WHERE id = ?").bind(caja_id).fetch_one(&mut *c).await.map_err(e)?;
    sqlx::query("UPDATE cajas SET cuenta_siguiente = cuenta_siguiente + 1, actualizado_en = ? WHERE id = ?").bind(fecha).bind(caja_id).execute(&mut *c).await.map_err(e)?;
    Ok((n, numero(tipo, n)))
}

#[allow(clippy::too_many_arguments)]
async fn evento(c: &mut SqliteConnection, cuenta_id: &str, tipo: &str, monto: i64, turno_id: Option<&str>, abono_id: Option<&str>, a: &Actor, autorizado_por: Option<&str>, motivo: Option<&str>, fecha: &str) -> Res<()> {
    sqlx::query("INSERT INTO cuenta_eventos (id, cuenta_id, tipo, monto, turno_id, abono_id, usuario_id, autorizado_por, motivo, fecha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(ulid())
        .bind(cuenta_id)
        .bind(tipo)
        .bind(monto)
        .bind(turno_id)
        .bind(abono_id)
        .bind(&a.id)
        .bind(autorizado_por)
        .bind(motivo)
        .bind(fecha)
        .execute(&mut *c)
        .await
        .map_err(e)?;
    Ok(())
}

async fn insertar_lineas(c: &mut SqliteConnection, cuenta_id: &str, lineas: &[Linea], catalogo: &[i64], fecha: &str) -> Res<()> {
    for (i, l) in lineas.iter().enumerate() {
        sqlx::query(
            "INSERT INTO cuenta_lineas (id, cuenta_id, producto_id, codigo, descripcion, departamento_id, cantidad, precio_unitario, descuento,
               descuento_catalogo, descuento_catalogo_pct, tasa_iva, exento, total, orden, creado_en, actualizado_en)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(ulid())
        .bind(cuenta_id)
        .bind(&l.producto_id)
        .bind(&l.codigo)
        .bind(&l.descripcion)
        .bind(&l.departamento_id)
        .bind(l.cantidad)
        .bind(l.precio_unitario)
        .bind(l.descuento)
        .bind(catalogo.get(i).copied().unwrap_or(0))
        .bind(l.descuento_catalogo)
        .bind(if l.exento { 0.0 } else { l.tasa_iva })
        .bind(l.exento as i64)
        .bind(calculo::importe(l))
        .bind(i as i64)
        .bind(fecha)
        .bind(fecha)
        .execute(&mut *c)
        .await
        .map_err(e)?;
    }
    Ok(())
}

/// Inserta un abono por cada forma aplicada (pago mixto = varias filas con la misma operación).
/// Devuelve (id del primero, total aplicado, vuelto, hubo efectivo).
#[allow(clippy::too_many_arguments)]
async fn insertar_abonos(c: &mut SqliteConnection, cuenta_id: &str, t: &Turno, a: &Actor, rp: &calculo::ResultadoPagos, fs: &[calculo::Forma], operacion_id: &str, fecha: &str) -> Res<(String, i64, bool)> {
    let mut primero = String::new();
    let mut total = 0;
    let mut efectivo = false;
    let sucursal = inventario::sucursal_de(&mut *c, &t.caja_id).await?;
    for ap in &rp.aplicados {
        let id = ulid();
        if primero.is_empty() {
            primero = id.clone();
        }
        efectivo |= fs.iter().any(|f| f.id == ap.pago.forma_pago_id && f.da_vuelto);
        sqlx::query(
            "INSERT INTO abonos (id, cuenta_id, sucursal_id, caja_id, turno_id, fecha, usuario_id, forma_pago_id, banco_id, monto, referencia,
               recibido, vuelto, ultimos4, pagador, operacion_id, creado_en, actualizado_en)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(cuenta_id)
        .bind(&sucursal)
        .bind(&t.caja_id)
        .bind(&t.id)
        .bind(fecha)
        .bind(&a.id)
        .bind(&ap.pago.forma_pago_id)
        .bind(ap.pago.banco_id.as_deref().filter(|s| !s.is_empty()))
        .bind(ap.aplicado)
        .bind(ap.pago.referencia.as_deref().map(str::trim).filter(|s| !s.is_empty()))
        .bind(ap.recibido)
        .bind(ap.vuelto)
        .bind(ap.pago.ultimos4.as_deref().filter(|s| !s.is_empty()))
        .bind(calculo::validar_pagador(true, ap.pago.pagador.as_deref()).ok().flatten())
        .bind(operacion_id)
        .bind(fecha)
        .bind(fecha)
        .execute(&mut *c)
        .await
        .map_err(e)?;
        evento(c, cuenta_id, "abono", ap.aplicado, Some(&t.id), Some(&id), a, None, None, fecha).await?;
        total += ap.aplicado;
    }
    Ok((primero, total, efectivo))
}

fn operacion_valida(op: &str) -> Res<()> {
    if op.is_empty() || op.len() > 40 || !op.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Operación inválida".into());
    }
    Ok(())
}

/// Lo que ya se registró con esta operación (doble clic, reintento tras un corte): mismo resultado, sin otro abono.
async fn ya_registrado(pool: &SqlitePool, operacion_id: &str) -> Res<Option<ResultadoAbono>> {
    let f = sqlx::query(
        "SELECT k.id, k.numero, k.estado, k.saldo, k.venta_id, v.numero AS vnum, SUM(a.monto) AS monto, SUM(COALESCE(a.vuelto, 0)) AS vuelto
         FROM abonos a JOIN cuentas k ON k.id = a.cuenta_id LEFT JOIN ventas v ON v.id = k.venta_id WHERE a.operacion_id = ? GROUP BY k.id",
    )
    .bind(operacion_id)
    .fetch_optional(pool)
    .await
    .map_err(e)?;
    Ok(f.map(|f| ResultadoAbono {
        cuenta_id: f.get("id"),
        numero: f.get("numero"),
        estado: f.get("estado"),
        saldo: f.get("saldo"),
        abonado_ahora: f.get("monto"),
        vuelto: f.get("vuelto"),
        venta_id: f.get("venta_id"),
        venta_numero: f.get("vnum"),
        // Ya se abrió (o no) la primera vez: no se vuelve a abrir la gaveta.
        hay_efectivo: false,
        abrir_gaveta: false,
    }))
}

/// Unidades apartadas (apartados abiertos) de un producto: no se venden sin el PIN del dueño.
pub async fn reservado(c: &mut SqliteConnection, producto_id: &str) -> Res<i64> {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(l.cantidad), 0) FROM cuenta_lineas l JOIN cuentas k ON k.id = l.cuenta_id
         WHERE l.producto_id = ? AND k.tipo = 'apartado' AND k.estado = 'abierta' AND k.eliminado_en IS NULL AND l.eliminado_en IS NULL",
    )
    .bind(producto_id)
    .fetch_one(&mut *c)
    .await
    .map_err(e)
}

/// Productos de una venta que se comerían unidades apartadas: "Nombre (A-0012)".
pub async fn choques_con_apartados(c: &mut SqliteConnection, sucursal_id: &str, items: &[(String, String, i64)]) -> Res<Vec<String>> {
    let mut out = vec![];
    for (pid, nombre, n) in items {
        let r = reservado(c, pid).await?;
        if r == 0 {
            continue;
        }
        let hay = inventario::existencia(c, pid, sucursal_id).await?;
        if hay - r < *n {
            let nums: Vec<String> = sqlx::query_scalar(
                "SELECT DISTINCT k.numero FROM cuenta_lineas l JOIN cuentas k ON k.id = l.cuenta_id
                 WHERE l.producto_id = ? AND k.tipo = 'apartado' AND k.estado = 'abierta' ORDER BY k.numero LIMIT 3",
            )
            .bind(pid)
            .fetch_all(&mut *c)
            .await
            .map_err(e)?;
            out.push(format!("{nombre} ({})", nums.join(", ")));
        }
    }
    Ok(out)
}

// ─────────── Crear un apartado (la venta en espera se convierte en apartado) ───────────

/// `monto`: lo que abona hoy (lo aplicado, sin el vuelto). `pagos`: cómo lo paga (igual que el cobro).
#[allow(clippy::too_many_arguments)]
#[cfg(test)] // solo las pruebas apartan sin descripción; la app usa `crear_apartado_con`
pub async fn crear_apartado(pool: &SqlitePool, a: &Actor, caja_id: &str, espera_id: &str, est: &Estado, monto: i64, pagos: &[PagoEntrada], operacion_id: &str) -> Res<ResultadoAbono> {
    crear_apartado_con(pool, a, caja_id, espera_id, est, monto, pagos, operacion_id, None).await
}

/// Igual que `crear_apartado`, con la descripción de lo que se aparta (opcional, hasta 200 letras).
#[allow(clippy::too_many_arguments)]
pub async fn crear_apartado_con(
    pool: &SqlitePool,
    a: &Actor,
    caja_id: &str,
    espera_id: &str,
    est: &Estado,
    monto: i64,
    pagos: &[PagoEntrada],
    operacion_id: &str,
    descripcion: Option<&str>,
) -> Res<ResultadoAbono> {
    a.exigir("cuentas.crear", "crear apartados")?;
    let descripcion = descripcion.map(|d| d.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|d| !d.is_empty());
    if descripcion.as_ref().is_some_and(|d| d.chars().count() > 200) {
        return Err("La descripción del apartado es muy larga (máximo 200 letras)".into());
    }
    operacion_valida(operacion_id)?;
    if let Some(r) = ya_registrado(pool, operacion_id).await? {
        return Ok(r);
    }
    if est.lineas.is_empty() {
        return Err("La venta no tiene productos".into());
    }
    for l in &est.lineas {
        calculo::validar_linea(l)?;
    }
    let paso = config::entero(pool, "redondeo_total", 5).await;
    ventas::revisar_precio_libre(a, est)?;
    let gaveta = config::booleano(pool, "abrir_gaveta_efectivo", true).await;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let rg = reglas_con(&mut tx).await;
    if !rg.usa_apartados {
        return Err("Este negocio no usa apartados".into());
    }
    let cliente = est.cliente.as_ref().ok_or("Para apartar, elija el cliente")?;
    cliente_con_consentimiento(&mut tx, &cliente.id).await?;
    let t = caja::turno_para_vender(&mut tx, caja_id, a).await?;
    caja::reloj_atrasado(&mut tx, "apartar").await?;
    ventas::revisar_cambios(&mut tx, a, espera_id, est).await?;
    // Apartar una venta ligada a una proforma también la convierte (en esta transacción).
    let conv = crate::proformas::preparar_conversion(&mut tx, est).await?;
    if conv.is_some() {
        a.exigir("proformas.convertir", "pasar proformas a venta")?;
    }
    let (lineas, catalogo) = ventas::lineas_de_catalogo_con(&mut tx, &est.lineas, conv.as_ref().map(|c| &c.permitidos).unwrap_or(&Default::default())).await?;
    let e2 = Estado { lineas, ..est.clone() };
    // Sin existencia libre (descontando lo ya apartado) solo se aparta si el negocio vende sin existencia.
    let sucursal = inventario::sucursal_de(&mut tx, caja_id).await?;
    let controladas = inventario::controladas(&mut tx, &e2.lineas.iter().map(|l| (l.producto_id.clone(), l.cantidad)).collect::<Vec<_>>()).await?;
    if a.politica("venta.sin_existencia").nivel != crate::acciones::Nivel::Si {
        let mut sin = vec![];
        for (pid, nombre, n) in &controladas {
            if inventario::existencia(&mut tx, pid, &sucursal).await? - reservado(&mut tx, pid).await? < *n {
                sin.push(nombre.clone());
            }
        }
        if !sin.is_empty() {
            return Err(format!("No hay unidades libres de: {}", sin.join(", ")));
        }
    }
    // El total del apartado se redondea como en efectivo: así cualquier abono en efectivo cierra exacto.
    let tot = calculo::totales(&e2, paso);
    let autorizado_por = match conv.as_ref().and_then(|c| c.autorizado_por.clone()) {
        Some(d) => Some(d),
        None => ventas::revisar_tope(a, &tot, &catalogo, est, espera_id)?,
    };
    if tot.total <= 0 {
        return Err("Un apartado de ¢0 no tiene sentido: regístrelo como venta".into());
    }
    validar_abono(tot.total, monto, Some(abono_minimo(tot.total, rg.abono_minimo_pct)))?;
    if monto == tot.total {
        return Err("Si paga todo hoy, cóbrelo como venta normal (F12)".into());
    }
    let fs = ventas::formas(&mut tx).await?;
    let rp = calculo::pagos(monto, pagos, &fs);
    if !rp.errores.is_empty() {
        return Err(rp.errores.join(". "));
    }
    if rp.faltante > 0 {
        return Err(format!("Faltan {} para completar el abono.", colones(rp.faltante)));
    }
    let repetidas = ventas::revisar_pagos(&mut tx, pagos).await?;
    let fecha = ahora_iso();
    // La espera activa evita crear dos apartados con un doble clic.
    let n = sqlx::query("UPDATE ventas_espera SET eliminado_en = ?, actualizado_en = ? WHERE id = ? AND caja_id = ? AND eliminado_en IS NULL")
        .bind(&fecha)
        .bind(&fecha)
        .bind(espera_id)
        .bind(caja_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?
        .rows_affected();
    if n == 0 {
        return Err("Esta venta ya se cobró o se apartó".into());
    }
    let h = caja::horario_con(&mut tx).await;
    let desde = NaiveDate::parse_from_str(&t.dia, "%Y-%m-%d").map_err(e)?;
    let limite = fecha_limite(desde, rg.plazo_dias, &rg.plazo_tipo, &h).to_string();
    let (consecutivo, num) = siguiente_numero(&mut tx, caja_id, APARTADO, &fecha).await?;
    let cuenta_id = ulid();
    let saldo = tot.total - monto;
    sqlx::query(
        "INSERT INTO cuentas (id, sucursal_id, caja_id, tipo, cliente_id, usuario_id, fecha, total, saldo, estado, numero, consecutivo, turno_id, fecha_limite,
           subtotal, descuento, redondeo, descuento_autorizado_por, requiere_factura, espera_id, creado_en, actualizado_en, descripcion)
         VALUES (?, ?, ?, 'apartado', ?, ?, ?, ?, ?, 'abierta', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&cuenta_id)
    .bind(&sucursal)
    .bind(caja_id)
    .bind(&cliente.id)
    .bind(&a.id)
    .bind(&fecha)
    .bind(tot.total)
    .bind(saldo)
    .bind(&num)
    .bind(consecutivo)
    .bind(&t.id)
    .bind(&limite)
    .bind(tot.subtotal)
    .bind(tot.descuento)
    .bind(tot.redondeo)
    .bind(&autorizado_por)
    .bind(est.requiere_factura as i64)
    .bind(espera_id)
    .bind(&fecha)
    .bind(&fecha)
    .bind(&descripcion)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    insertar_lineas(&mut tx, &cuenta_id, &e2.lineas, &catalogo, &fecha).await?;
    if let Some(c) = &conv {
        crate::proformas::marcar_convertida(&mut tx, a, c, None, Some(&cuenta_id)).await?;
    }
    evento(&mut tx, &cuenta_id, "creada", tot.total, Some(&t.id), None, a, autorizado_por.as_deref(), None, &fecha).await?;
    let (_, abonado, efectivo) = insertar_abonos(&mut tx, &cuenta_id, &t, a, &rp, &fs, operacion_id, &fecha).await?;
    bitacora::registrar(&mut tx, Some(&a.id), "cuenta.crear", "cuenta", Some(&cuenta_id), &json!({"tipo": APARTADO, "numero": num, "total": tot.total, "abono": abonado})).await?;
    if !repetidas.is_empty() {
        bitacora::registrar(&mut tx, Some(&a.id), "venta.referencia_repetida", "cuenta", Some(&cuenta_id), &json!({"pagos": repetidas})).await?;
    }
    tx.commit().await.map_err(e)?;
    if autorizado_por.is_some() {
        ventas::gastar_token(est);
    }
    Ok(ResultadoAbono { cuenta_id, numero: num, estado: "abierta".into(), saldo, abonado_ahora: abonado, vuelto: rp.vuelto, hay_efectivo: efectivo, abrir_gaveta: efectivo && gaveta, venta_id: None, venta_numero: None })
}

// ─────────── Abonar, liquidar y entregar ───────────

/// Abono a un apartado o crédito abierto. Si deja el saldo en 0: el apartado se liquida (se crea la
/// venta y sale del inventario; `entregar` = se lleva los productos ahora) y el crédito queda pagado.
#[allow(clippy::too_many_arguments)]
pub async fn abonar(pool: &SqlitePool, a: &Actor, caja_id: &str, cuenta_id: &str, monto: i64, pagos: &[PagoEntrada], operacion_id: &str, entregar: bool) -> Res<ResultadoAbono> {
    a.exigir("cuentas.abonar", "recibir abonos")?;
    operacion_valida(operacion_id)?;
    if let Some(r) = ya_registrado(pool, operacion_id).await? {
        return Ok(r);
    }
    let gaveta = config::booleano(pool, "abrir_gaveta_efectivo", true).await;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let t = caja::turno_para_vender(&mut tx, caja_id, a).await?;
    caja::reloj_atrasado(&mut tx, "recibir el abono").await?;
    let k = sqlx::query("SELECT numero, tipo, estado, saldo FROM cuentas WHERE id = ? AND eliminado_en IS NULL").bind(cuenta_id).fetch_optional(&mut *tx).await.map_err(e)?.ok_or("Apartado no encontrado")?;
    let (num, tipo, estado, saldo): (String, String, String, i64) = (k.get("numero"), k.get("tipo"), k.get("estado"), k.get("saldo"));
    if estado != "abierta" {
        return Err(format!("{num} ya está {}", texto_estado(&estado)));
    }
    validar_abono(saldo, monto, None)?;
    let fs = ventas::formas(&mut tx).await?;
    let rp = calculo::pagos(monto, pagos, &fs);
    if !rp.errores.is_empty() {
        return Err(rp.errores.join(". "));
    }
    if rp.faltante > 0 {
        return Err(format!("Faltan {} para completar el abono.", colones(rp.faltante)));
    }
    let repetidas = ventas::revisar_pagos(&mut tx, pagos).await?;
    let fecha = ahora_iso();
    let (_, abonado, efectivo) = insertar_abonos(&mut tx, cuenta_id, &t, a, &rp, &fs, operacion_id, &fecha).await?;
    let nuevo = saldo - abonado;
    sqlx::query("UPDATE cuentas SET saldo = ?, actualizado_en = ? WHERE id = ?").bind(nuevo).bind(&fecha).bind(cuenta_id).execute(&mut *tx).await.map_err(e)?;
    let mut r = ResultadoAbono { cuenta_id: cuenta_id.into(), numero: num.clone(), estado: "abierta".into(), saldo: nuevo, abonado_ahora: abonado, vuelto: rp.vuelto, hay_efectivo: efectivo, abrir_gaveta: efectivo && gaveta, venta_id: None, venta_numero: None };
    if nuevo == 0 {
        if tipo == APARTADO {
            let (vid, vnum) = liquidar(&mut tx, a, &t, cuenta_id, &fecha).await?;
            r.estado = if entregar { "entregada".into() } else { "pagada".into() };
            sqlx::query("UPDATE cuentas SET estado = ?, venta_id = ?, fecha_entrega = ? WHERE id = ?")
                .bind(&r.estado)
                .bind(&vid)
                .bind(entregar.then_some(&fecha))
                .bind(cuenta_id)
                .execute(&mut *tx)
                .await
                .map_err(e)?;
            evento(&mut tx, cuenta_id, "liquidada", 0, Some(&t.id), None, a, None, None, &fecha).await?;
            if entregar {
                evento(&mut tx, cuenta_id, "entregada", 0, Some(&t.id), None, a, None, None, &fecha).await?;
            }
            r.venta_id = Some(vid);
            r.venta_numero = Some(vnum);
        } else {
            r.estado = "pagada".into();
            sqlx::query("UPDATE cuentas SET estado = 'pagada' WHERE id = ?").bind(cuenta_id).execute(&mut *tx).await.map_err(e)?;
        }
    }
    bitacora::registrar(&mut tx, Some(&a.id), "cuenta.abono", "cuenta", Some(cuenta_id), &json!({"numero": num, "monto": abonado, "saldo": nuevo})).await?;
    if !repetidas.is_empty() {
        bitacora::registrar(&mut tx, Some(&a.id), "venta.referencia_repetida", "cuenta", Some(cuenta_id), &json!({"pagos": repetidas})).await?;
    }
    tx.commit().await.map_err(e)?;
    Ok(r)
}

fn texto_estado(estado: &str) -> &'static str {
    match estado {
        "pagada" => "pagado",
        "entregada" => "entregado",
        "cancelada" => "cancelado",
        _ => "abierto",
    }
}

/// Apartado pagado: crea la venta con SUS líneas y precios (no los del catálogo de hoy), sin pagos
/// (todo vino en abonos), y saca las unidades del inventario. El descuento incluye lo condonado.
async fn liquidar(tx: &mut SqliteConnection, a: &Actor, t: &Turno, cuenta_id: &str, fecha: &str) -> Res<(String, String)> {
    let k = sqlx::query("SELECT caja_id, cliente_id, descuento, redondeo, total, condonado, requiere_factura, descuento_autorizado_por, sucursal_id FROM cuentas WHERE id = ?")
        .bind(cuenta_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(e)?;
    let filas = sqlx::query("SELECT producto_id, codigo, descripcion, departamento_id, cantidad, precio_unitario, descuento, descuento_catalogo, descuento_catalogo_pct, tasa_iva, exento FROM cuenta_lineas WHERE cuenta_id = ? AND eliminado_en IS NULL ORDER BY orden")
        .bind(cuenta_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(e)?;
    let lineas: Vec<Linea> = filas
        .iter()
        .map(|f| Linea {
            id: ulid(),
            producto_id: f.get("producto_id"),
            codigo: f.get("codigo"),
            descripcion: f.get("descripcion"),
            departamento_id: f.get::<Option<String>, _>("departamento_id").unwrap_or_default(),
            cantidad: f.get("cantidad"),
            precio_unitario: f.get("precio_unitario"),
            descuento: f.get("descuento"),
            descuento_catalogo: f.get("descuento_catalogo_pct"),
            tasa_iva: f.get("tasa_iva"),
            exento: f.get::<i64, _>("exento") == 1,
        })
        .collect();
    let catalogo: Vec<i64> = filas.iter().map(|f| f.get("descuento_catalogo")).collect();
    let condonado: i64 = k.get("condonado");
    let est = Estado { lineas: lineas.clone(), descuento_total: k.get::<i64, _>("descuento") + condonado, ..Default::default() };
    let mut tot = calculo::totales(&est, 1);
    // El total es el del apartado (con su redondeo) menos lo condonado.
    tot.redondeo = k.get("redondeo");
    tot.total = k.get::<i64, _>("total") - condonado;
    let caja_id: String = k.get("caja_id");
    let cliente: String = k.get("cliente_id");
    let (vid, vnum) = ventas::insertar_venta(
        &mut *tx,
        &NuevaVenta {
            caja_id: &caja_id,
            turno_id: &t.id,
            usuario_id: &a.id,
            cliente_id: Some(&cliente),
            nombre_tiquete: None,
            tot: &tot,
            lineas: &lineas,
            catalogo: &catalogo,
            requiere_factura: k.get::<i64, _>("requiere_factura") == 1,
            autorizado_por: k.get::<Option<String>, _>("descuento_autorizado_por").as_deref(),
            espera_creada_por: None,
            cuenta_id: Some(cuenta_id),
            aplicados: &[],
            fecha,
        },
    )
    .await?;
    // Producto que ya no existe en el catálogo: no hay kardex que mover (se entrega igual).
    let vivas: Vec<(Option<String>, i64)> = {
        let mut v = vec![];
        for l in &lineas {
            let existe: Option<i64> = match &l.producto_id {
                Some(p) => sqlx::query_scalar("SELECT 1 FROM productos WHERE id = ?").bind(p).fetch_optional(&mut *tx).await.map_err(e)?,
                None => None,
            };
            v.push((existe.and(l.producto_id.clone()), l.cantidad));
        }
        v
    };
    let controladas = inventario::controladas(&mut *tx, &vivas).await?;
    let sucursal: String = k.get("sucursal_id");
    inventario::descontar_venta(&mut *tx, &vid, &sucursal, &a.id, &t.id, &controladas, fecha).await?;
    Ok((vid, vnum))
}

/// Apartado pagado sin entregar (pagó todo y retira otro día): solo cambia el estado.
pub async fn entregar(pool: &SqlitePool, a: &Actor, cuenta_id: &str) -> Res<()> {
    a.exigir("cuentas.abonar", "entregar apartados")?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let fecha = ahora_iso();
    let n = sqlx::query("UPDATE cuentas SET estado = 'entregada', fecha_entrega = ?, actualizado_en = ? WHERE id = ? AND tipo = 'apartado' AND estado = 'pagada'")
        .bind(&fecha)
        .bind(&fecha)
        .bind(cuenta_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?
        .rows_affected();
    if n == 0 {
        return Err("Solo se entrega un apartado pagado que no se ha entregado".into());
    }
    evento(&mut tx, cuenta_id, "entregada", 0, None, None, a, None, None, &fecha).await?;
    bitacora::registrar(&mut tx, Some(&a.id), "cuenta.entregar", "cuenta", Some(cuenta_id), &json!({})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

// ─────────── Crédito ───────────

/// Límite de crédito de un cliente (el suyo o el del negocio) y lo que ya debe.
async fn limite_y_saldo(c: &mut SqliteConnection, cliente_id: &str) -> Res<(i64, i64)> {
    let propio: Option<Option<i64>> = sqlx::query_scalar("SELECT limite_credito FROM clientes WHERE id = ?").bind(cliente_id).fetch_optional(&mut *c).await.map_err(e)?;
    let limite = match propio.flatten() {
        Some(l) => l,
        None => config::entero_con(c, "credito_limite_defecto", 0).await,
    };
    let saldo: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(saldo), 0) FROM cuentas WHERE cliente_id = ? AND tipo = 'credito' AND estado = 'abierta' AND eliminado_en IS NULL")
        .bind(cliente_id)
        .fetch_one(&mut *c)
        .await
        .map_err(e)?;
    Ok((limite, saldo))
}

/// Crédito disponible del cliente, para avisarlo ANTES de cobrar. El cajero ve solo esto: ni el
/// límite ni lo que debe en otras cuentas (Ley 8968). Rust vuelve a revisar al cobrar.
pub async fn credito_disponible_cliente(pool: &SqlitePool, a: &Actor, cliente_id: &str) -> Res<i64> {
    a.exigir("credito.vender", "vender a crédito")?;
    let mut c = pool.acquire().await.map_err(e)?;
    let (limite, saldo) = limite_y_saldo(&mut c, cliente_id).await?;
    Ok(credito_disponible(limite, saldo))
}

/// Dentro del cobro a crédito (ventas::cobrar_opc): abre la cuenta por lo que queda por cobrar.
/// Devuelve el id de la cuenta (para imprimir su comprobante).
#[allow(clippy::too_many_arguments)]
pub async fn abrir_credito(tx: &mut SqliteConnection, a: &Actor, t: &Turno, venta_id: &str, cliente_id: &str, lineas: &[Linea], catalogo: &[i64], por_cobrar: i64, fecha: &str) -> Res<String> {
    cliente_con_consentimiento(&mut *tx, cliente_id).await?;
    let (limite, saldo) = limite_y_saldo(&mut *tx, cliente_id).await?;
    if !credito_alcanza(limite, saldo, por_cobrar) {
        return Err("El crédito de este cliente no alcanza. Pida al dueño que revise su límite.".into());
    }
    let rg = reglas_con(&mut *tx).await;
    let h = caja::horario_con(&mut *tx).await;
    let desde = NaiveDate::parse_from_str(&t.dia, "%Y-%m-%d").map_err(e)?;
    // Misma regla que el apartado: en días de trabajo, o calendario sin caer en un día que no se trabaja.
    let limite_fecha = fecha_limite(desde, rg.credito_plazo_dias, &rg.credito_plazo_tipo, &h).to_string();
    let (consecutivo, num) = siguiente_numero(&mut *tx, &t.caja_id, CREDITO, fecha).await?;
    let id = ulid();
    let sucursal = inventario::sucursal_de(&mut *tx, &t.caja_id).await?;
    sqlx::query(
        "INSERT INTO cuentas (id, sucursal_id, caja_id, tipo, cliente_id, usuario_id, fecha, total, saldo, estado, numero, consecutivo, turno_id, fecha_limite, venta_id, creado_en, actualizado_en)
         VALUES (?, ?, ?, 'credito', ?, ?, ?, ?, ?, 'abierta', ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&sucursal)
    .bind(&t.caja_id)
    .bind(cliente_id)
    .bind(&a.id)
    .bind(fecha)
    .bind(por_cobrar)
    .bind(por_cobrar)
    .bind(&num)
    .bind(consecutivo)
    .bind(&t.id)
    .bind(&limite_fecha)
    .bind(venta_id)
    .bind(fecha)
    .bind(fecha)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    sqlx::query("UPDATE ventas SET cuenta_id = ? WHERE id = ?").bind(&id).bind(venta_id).execute(&mut *tx).await.map_err(e)?;
    insertar_lineas(&mut *tx, &id, lineas, catalogo, fecha).await?;
    evento(&mut *tx, &id, "creada", por_cobrar, Some(&t.id), None, a, None, None, fecha).await?;
    bitacora::registrar(&mut *tx, Some(&a.id), "cuenta.crear", "cuenta", Some(&id), &json!({"tipo": CREDITO, "numero": num, "venta": venta_id, "porCobrar": por_cobrar})).await?;
    Ok(id)
}

/// Opciones del crédito del negocio (solo el dueño las ve y las cambia).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct OpcionesCredito {
    /// Límite de quien no tiene uno propio. 0 = solo venden a crédito los clientes con límite propio.
    pub limite_defecto: i64,
    pub plazo_dias: i64,
    /// "calendario" o "laborables".
    pub plazo_tipo: String,
    pub condiciones: String,
}

pub async fn opciones_credito(pool: &SqlitePool, a: &Actor) -> Res<OpcionesCredito> {
    a.exigir("credito.limite", "ver las opciones de crédito")?;
    let mut c = pool.acquire().await.map_err(e)?;
    let rg = reglas_con(&mut c).await;
    Ok(OpcionesCredito {
        limite_defecto: config::entero_con(&mut c, "credito_limite_defecto", 0).await,
        plazo_dias: rg.credito_plazo_dias,
        plazo_tipo: rg.credito_plazo_tipo,
        condiciones: rg.credito_condiciones,
    })
}

/// Guarda las opciones del crédito con el PIN del dueño. Se valida todo antes de escribir nada.
pub async fn guardar_opciones_credito(pool: &SqlitePool, a: &Actor, o: &OpcionesCredito, pin: &str) -> Res<()> {
    a.exigir("credito.limite", "cambiar las opciones de crédito")?;
    let valores = [
        ("credito_limite_defecto", json!(o.limite_defecto)),
        ("credito_plazo_dias", json!(o.plazo_dias)),
        ("credito_plazo_tipo", json!(o.plazo_tipo)),
        ("credito_condiciones", json!(o.condiciones.trim())),
    ];
    for (k, v) in &valores {
        config::validar(k, v)?;
    }
    usuarios::confirmar_dueno(pool, a, "credito.limite", pin, "opciones de crédito").await?;
    for (k, v) in &valores {
        config::escribir(pool, a, k, v).await?;
    }
    Ok(())
}

/// Límite propio de un cliente (None = usa el del negocio). Solo el dueño.
pub async fn limite_cliente(pool: &SqlitePool, a: &Actor, cliente_id: &str) -> Res<Option<i64>> {
    a.exigir("credito.limite", "ver el límite de crédito")?;
    let l: Option<Option<i64>> = sqlx::query_scalar("SELECT limite_credito FROM clientes WHERE id = ?").bind(cliente_id).fetch_optional(pool).await.map_err(e)?;
    l.ok_or_else(|| "Cliente no encontrado".to_string())
}

/// Estado de cuenta de un cliente: sus créditos (abiertos y pagados) y sus apartados abiertos, con
/// abonos, y lo que debe en total. Solo el dueño.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct EstadoCuenta {
    pub cliente: String,
    pub cuentas: Vec<CuentaDetalle>,
    /// Suma de los saldos de las cuentas abiertas.
    pub total_adeudado: i64,
}

pub async fn estado_cuenta(pool: &SqlitePool, a: &Actor, cliente_id: &str) -> Res<EstadoCuenta> {
    a.exigir("cuentas.ver_todas", "ver el estado de cuenta")?;
    let cliente: String = sqlx::query_scalar("SELECT nombre FROM clientes WHERE id = ?").bind(cliente_id).fetch_optional(pool).await.map_err(e)?.ok_or("Cliente no encontrado")?;
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM cuentas WHERE cliente_id = ? AND eliminado_en IS NULL
           AND ((tipo = 'credito' AND estado IN ('abierta', 'pagada')) OR (tipo = 'apartado' AND estado = 'abierta'))
         ORDER BY fecha",
    )
    .bind(cliente_id)
    .fetch_all(pool)
    .await
    .map_err(e)?;
    let mut cuentas = Vec::with_capacity(ids.len());
    for id in &ids {
        cuentas.push(obtener(pool, a, id).await?);
    }
    let total_adeudado = cuentas.iter().filter(|d| d.cuenta.estado == "abierta").map(|d| d.cuenta.saldo).sum();
    Ok(EstadoCuenta { cliente, cuentas, total_adeudado })
}

/// Límite de crédito de un cliente (solo el dueño, con PIN). La bitácora no guarda el monto.
pub async fn fijar_limite(pool: &SqlitePool, a: &Actor, cliente_id: &str, limite: Option<i64>, pin: &str) -> Res<()> {
    a.exigir("credito.limite", "cambiar el límite de crédito")?;
    if limite.is_some_and(|l| !(0..=100_000_000).contains(&l)) {
        return Err("Límite inválido".into());
    }
    let dueno = usuarios::confirmar_dueno(pool, a, "credito.limite", pin, "límite de crédito").await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let n = sqlx::query("UPDATE clientes SET limite_credito = ?, actualizado_en = ? WHERE id = ? AND anonimizado_en IS NULL").bind(limite).bind(ahora_iso()).bind(cliente_id).execute(&mut *tx).await.map_err(e)?.rows_affected();
    if n == 0 {
        return Err("Cliente no encontrado".into());
    }
    bitacora::registrar(&mut tx, Some(&a.id), "credito.limite", "cliente", Some(cliente_id), &json!({"autorizadoPor": dueno})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

// ─────────── Acciones del dueño ───────────

fn motivo_valido(m: &str) -> Res<String> {
    let m = texto(m, 300, "motivo", true)?;
    if m.chars().count() < 5 {
        return Err("Escriba el motivo".into());
    }
    Ok(m)
}

/// Cancela un apartado abierto. `devuelto`: lo que se le devuelve al cliente (el resto queda
/// retenido); `en_efectivo`: la parte de lo devuelto que sale de la gaveta del turno abierto.
#[allow(clippy::too_many_arguments)]
/// Cancelar, condonar y anular un abono: política con su monto (Etapa 2). El dueño, con su PIN; el
/// cajero, sin PIN solo hasta el monto máximo que le pongan (sin monto, solo con PIN: Accion::admite).
/// Devuelve quién autorizó (el dueño que puso el PIN o el mismo usuario).
fn autorizar_monto(a: &Actor, accion: &str, pin_de: Option<String>, motivo: &str, monto: i64) -> Res<String> {
    let ap = crate::politica::aplicar(a, accion, &crate::politica::Contexto { monto: Some(monto), motivo: Some(motivo.to_string()), pin_de, ..Default::default() })?;
    Ok(ap.autorizo.unwrap_or_else(|| a.id.clone()))
}

/// El PIN del dueño, si vino (se revisa antes que nada, como antes de la Etapa 2).
async fn pin_si_vino(pool: &SqlitePool, a: &Actor, pin: &str, contexto: &str) -> Res<Option<String>> {
    match pin.trim() {
        "" => Ok(None),
        p => Ok(Some(usuarios::autorizar_dueno(pool, p, contexto, &a.id).await?)),
    }
}

pub async fn cancelar(pool: &SqlitePool, a: &Actor, caja_id: &str, cuenta_id: &str, pin: &str, motivo: &str, devuelto: i64, en_efectivo: i64) -> Res<()> {
    a.exigir("cuentas.cancelar", "cancelar apartados")?;
    let motivo = motivo_valido(motivo)?;
    let pin_de = pin_si_vino(pool, a, pin, "cancelar apartado").await?;
    let dueno = autorizar_monto(a, "cuentas.cancelar", pin_de, &motivo, devuelto)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let k = sqlx::query("SELECT numero, tipo, estado, total, saldo, condonado FROM cuentas WHERE id = ?").bind(cuenta_id).fetch_optional(&mut *tx).await.map_err(e)?.ok_or("Apartado no encontrado")?;
    if k.get::<String, _>("tipo") != APARTADO || k.get::<String, _>("estado") != "abierta" {
        return Err("Solo se cancela un apartado abierto".into());
    }
    let abonado = k.get::<i64, _>("total") - k.get::<i64, _>("saldo") - k.get::<i64, _>("condonado");
    if !(0..=abonado).contains(&devuelto) || !(0..=devuelto).contains(&en_efectivo) {
        return Err(format!("Lo devuelto va de ¢0 a lo abonado ({})", colones(abonado)));
    }
    let fecha = ahora_iso();
    let actual = if en_efectivo > 0 {
        let t = caja::turno_para_vender(&mut tx, caja_id, a).await.map_err(|_| "Para devolver efectivo, la caja tiene que estar abierta".to_string())?;
        if en_efectivo > caja::resumen(&mut tx, &t).await?.efectivo_esperado {
            return Err("No hay tanto efectivo en la caja para devolver".into());
        }
        let numero: String = k.get("numero");
        caja::insertar_movimiento(&mut tx, &t, a, "salida", en_efectivo, "Devolución apartado", &format!("Cancelación {numero}"), Some(&dueno)).await?;
        Some(t.id)
    } else {
        caja::turno_abierto(&mut tx, caja_id).await?.map(|t| t.id)
    };
    sqlx::query("UPDATE cuentas SET estado = 'cancelada', cancelada_en = ?, cancelada_por = ?, cancelada_motivo = ?, devuelto = ?, retenido = ?, actualizado_en = ? WHERE id = ?")
        .bind(&fecha)
        .bind(&dueno)
        .bind(&motivo)
        .bind(devuelto)
        .bind(abonado - devuelto)
        .bind(&fecha)
        .bind(cuenta_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    evento(&mut tx, cuenta_id, "cancelada", devuelto, actual.as_deref(), None, a, Some(&dueno), Some(&motivo), &fecha).await?;
    bitacora::registrar(&mut tx, Some(&a.id), "cuenta.cancelar", "cuenta", Some(cuenta_id), &json!({"devuelto": devuelto, "efectivo": en_efectivo, "retenido": abonado - devuelto, "motivo": motivo, "autorizadoPor": dueno})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

/// Anula un abono de una cuenta abierta. En su turno abierto, sale del efectivo esperado (como una
/// venta anulada). De un turno cerrado, el Z viejo no cambia y lo devuelto en efectivo sale hoy.
#[allow(clippy::too_many_arguments)]
pub async fn anular_abono(pool: &SqlitePool, a: &Actor, caja_id: &str, abono_id: &str, pin: &str, motivo: &str, devolucion_efectivo: i64) -> Res<()> {
    a.exigir("cuentas.anular_abono", "anular abonos")?;
    let motivo = motivo_valido(motivo)?;
    let pin_de = pin_si_vino(pool, a, pin, "anular abono").await?;
    let monto: i64 = sqlx::query_scalar("SELECT monto FROM abonos WHERE id = ?").bind(abono_id).fetch_optional(pool).await.map_err(e)?.ok_or("Abono no encontrado")?;
    let dueno = autorizar_monto(a, "cuentas.anular_abono", pin_de, &motivo, monto)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let f = sqlx::query("SELECT a.cuenta_id, a.monto, a.turno_id, a.anulado_en, k.estado, t.estado AS testado FROM abonos a JOIN cuentas k ON k.id = a.cuenta_id LEFT JOIN caja_turnos t ON t.id = a.turno_id WHERE a.id = ?")
        .bind(abono_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(e)?
        .ok_or("Abono no encontrado")?;
    if f.get::<Option<String>, _>("anulado_en").is_some() {
        return Err("Ese abono ya está anulado".into());
    }
    if f.get::<String, _>("estado") != "abierta" {
        return Err("La cuenta ya se liquidó o se canceló: el abono no se anula".into());
    }
    let cuenta_id: String = f.get("cuenta_id");
    let monto: i64 = f.get("monto");
    let turno_abono: Option<String> = f.get("turno_id");
    let abierto = f.get::<Option<String>, _>("testado").as_deref() == Some("abierto");
    if abierto && devolucion_efectivo != 0 {
        return Err("En el turno abierto la anulación ya descuenta el efectivo del abono".into());
    }
    let fecha = ahora_iso();
    let actual = if abierto {
        turno_abono.clone()
    } else {
        caja::turno_abierto(&mut tx, caja_id).await?.map(|t| t.id)
    };
    sqlx::query("UPDATE abonos SET anulado_en = ?, anulado_por = ?, anulado_motivo = ?, anulado_turno_id = ?, actualizado_en = ? WHERE id = ?")
        .bind(&fecha)
        .bind(&dueno)
        .bind(&motivo)
        .bind(&actual)
        .bind(&fecha)
        .bind(abono_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    sqlx::query("UPDATE cuentas SET saldo = saldo + ?, actualizado_en = ? WHERE id = ?").bind(monto).bind(&fecha).bind(&cuenta_id).execute(&mut *tx).await.map_err(e)?;
    if abierto {
        if let Some(t) = caja::turno(&mut tx, turno_abono.as_deref().unwrap_or_default()).await? {
            if caja::resumen(&mut tx, &t).await?.efectivo_esperado < 0 {
                return Err(ventas::SIN_EFECTIVO.into());
            }
        }
    } else if devolucion_efectivo > 0 {
        if !(0..=monto).contains(&devolucion_efectivo) {
            return Err("La devolución no puede pasar del abono".into());
        }
        let t = caja::turno_para_vender(&mut tx, caja_id, a).await.map_err(|_| "Para devolver efectivo, la caja tiene que estar abierta".to_string())?;
        if devolucion_efectivo > caja::resumen(&mut tx, &t).await?.efectivo_esperado {
            return Err("No hay tanto efectivo en la caja para devolver".into());
        }
        caja::insertar_movimiento(&mut tx, &t, a, "salida", devolucion_efectivo, "Devolución apartado", "Abono anulado", Some(&dueno)).await?;
    }
    evento(&mut tx, &cuenta_id, "abono_anulado", monto, actual.as_deref(), Some(abono_id), a, Some(&dueno), Some(&motivo), &fecha).await?;
    bitacora::registrar(&mut tx, Some(&a.id), "cuenta.abono_anular", "cuenta", Some(&cuenta_id), &json!({"abono": abono_id, "monto": monto, "devolucion": devolucion_efectivo, "motivo": motivo, "autorizadoPor": dueno})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

pub const CONDONAR_SIN_CAJA: &str = "Para condonar, abra la caja primero (se registra una venta)";

/// Perdona el saldo. Un apartado queda liquidado (la venta lleva lo condonado como descuento: pide la
/// caja abierta); un crédito queda pagado (la venta ya se había registrado).
#[allow(clippy::too_many_arguments)]
pub async fn condonar(pool: &SqlitePool, a: &Actor, caja_id: &str, cuenta_id: &str, pin: &str, motivo: &str, entregar: bool) -> Res<Option<String>> {
    a.exigir("cuentas.condonar", "condonar saldos")?;
    let motivo = motivo_valido(motivo)?;
    let pin_de = pin_si_vino(pool, a, pin, "condonar saldo").await?;
    let antes: i64 = sqlx::query_scalar("SELECT saldo FROM cuentas WHERE id = ?").bind(cuenta_id).fetch_optional(pool).await.map_err(e)?.ok_or("Cuenta no encontrada")?;
    let dueno = autorizar_monto(a, "cuentas.condonar", pin_de, &motivo, antes)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let k = sqlx::query("SELECT tipo, estado, saldo FROM cuentas WHERE id = ?").bind(cuenta_id).fetch_optional(&mut *tx).await.map_err(e)?.ok_or("Cuenta no encontrada")?;
    let saldo: i64 = k.get("saldo");
    if saldo != antes {
        return Err("El saldo cambió mientras tanto (entró un abono). Vuelva a intentarlo.".into());
    }
    if k.get::<String, _>("estado") != "abierta" || saldo == 0 {
        return Err("No hay saldo pendiente que condonar".into());
    }
    let fecha = ahora_iso();
    sqlx::query("UPDATE cuentas SET condonado = condonado + ?, saldo = 0, actualizado_en = ? WHERE id = ?").bind(saldo).bind(&fecha).bind(cuenta_id).execute(&mut *tx).await.map_err(e)?;
    let mut venta = None;
    if k.get::<String, _>("tipo") == APARTADO {
        // Liquidar registra una venta: necesita una caja abierta. Se dice claro qué hacer.
        let t = caja::turno_para_vender(&mut tx, caja_id, a).await.map_err(|_| CONDONAR_SIN_CAJA.to_string())?;
        evento(&mut tx, cuenta_id, "condonacion", saldo, Some(&t.id), None, a, Some(&dueno), Some(&motivo), &fecha).await?;
        let (vid, _) = liquidar(&mut tx, a, &t, cuenta_id, &fecha).await?;
        let estado = if entregar { "entregada" } else { "pagada" };
        sqlx::query("UPDATE cuentas SET estado = ?, venta_id = ?, fecha_entrega = ? WHERE id = ?").bind(estado).bind(&vid).bind(entregar.then_some(&fecha)).bind(cuenta_id).execute(&mut *tx).await.map_err(e)?;
        evento(&mut tx, cuenta_id, "liquidada", 0, Some(&t.id), None, a, None, None, &fecha).await?;
        venta = Some(vid);
    } else {
        let actual = caja::turno_abierto(&mut tx, caja_id).await?.map(|t| t.id);
        evento(&mut tx, cuenta_id, "condonacion", saldo, actual.as_deref(), None, a, Some(&dueno), Some(&motivo), &fecha).await?;
        sqlx::query("UPDATE cuentas SET estado = 'pagada' WHERE id = ?").bind(cuenta_id).execute(&mut *tx).await.map_err(e)?;
    }
    bitacora::registrar(&mut tx, Some(&a.id), "cuenta.condonar", "cuenta", Some(cuenta_id), &json!({"monto": saldo, "motivo": motivo, "autorizadoPor": dueno})).await?;
    tx.commit().await.map_err(e)?;
    Ok(venta)
}

/// Corrige el total (error al apartar: una línea de más, un precio mal puesto). El saldo sube o baja
/// lo mismo y no puede quedar en 0 ni negativo (para eso está condonar).
pub async fn ajustar(pool: &SqlitePool, a: &Actor, cuenta_id: &str, cambio: i64, pin: &str, motivo: &str) -> Res<()> {
    a.exigir("cuentas.ajustar", "ajustar saldos")?;
    let motivo = motivo_valido(motivo)?;
    if cambio == 0 || cambio.abs() > 100_000_000 {
        return Err("Escriba cuánto sube o baja el saldo".into());
    }
    let dueno = usuarios::confirmar_dueno(pool, a, "cuentas.ajustar", pin, "ajustar saldo").await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let k = sqlx::query("SELECT estado, saldo, tipo FROM cuentas WHERE id = ?").bind(cuenta_id).fetch_optional(&mut *tx).await.map_err(e)?.ok_or("Cuenta no encontrada")?;
    if k.get::<String, _>("estado") != "abierta" {
        return Err("Solo se ajusta una cuenta abierta".into());
    }
    if k.get::<i64, _>("saldo") + cambio <= 0 {
        return Err("El saldo quedaría en 0 o menos: use Condonar".into());
    }
    let fecha = ahora_iso();
    // Apartado y crédito: cambian el total de la cuenta (lo que se debía) y el saldo por igual. Lo
    // condonado no se toca (solo lo cambia Condonar); el ajuste queda como su propio evento.
    sqlx::query("UPDATE cuentas SET total = total + ?1, saldo = saldo + ?1, actualizado_en = ?2 WHERE id = ?3")
        .bind(cambio)
        .bind(&fecha)
        .bind(cuenta_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    evento(&mut tx, cuenta_id, "ajuste", cambio, None, None, a, Some(&dueno), Some(&motivo), &fecha).await?;
    bitacora::registrar(&mut tx, Some(&a.id), "cuenta.ajustar", "cuenta", Some(cuenta_id), &json!({"cambio": cambio, "motivo": motivo, "autorizadoPor": dueno})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

/// Nueva fecha límite: cambia lo prometido al cliente, así que pide PIN del dueño y motivo.
pub async fn prorrogar(pool: &SqlitePool, a: &Actor, cuenta_id: &str, fecha_limite: &str, motivo: &str, pin: &str) -> Res<()> {
    a.exigir("cuentas.prorrogar", "prorrogar apartados")?;
    let motivo = motivo_valido(motivo)?;
    let nueva = NaiveDate::parse_from_str(fecha_limite, "%Y-%m-%d").map_err(|_| "Fecha inválida".to_string())?;
    if nueva < ahora().date_naive() {
        return Err("La nueva fecha ya pasó".into());
    }
    let dueno = usuarios::confirmar_dueno(pool, a, "cuentas.prorrogar", pin, "prorrogar").await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let fecha = ahora_iso();
    let n = sqlx::query("UPDATE cuentas SET fecha_limite = ?, actualizado_en = ? WHERE id = ? AND estado = 'abierta'").bind(nueva.to_string()).bind(&fecha).bind(cuenta_id).execute(&mut *tx).await.map_err(e)?.rows_affected();
    if n == 0 {
        return Err("Solo se prorroga una cuenta abierta".into());
    }
    evento(&mut tx, cuenta_id, "prorroga", 0, None, None, a, Some(&dueno), Some(&format!("{motivo} (hasta {nueva})")), &fecha).await?;
    bitacora::registrar(&mut tx, Some(&a.id), "cuenta.prorrogar", "cuenta", Some(cuenta_id), &json!({"hasta": nueva.to_string(), "motivo": motivo, "autorizadoPor": dueno})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

// ─────────── Consultas ───────────

const SELECT_FILA: &str = "SELECT k.id, k.numero, k.tipo, k.estado, k.cliente_id, c.nombre AS cliente, c.telefono, k.fecha, k.fecha_limite, k.descripcion, k.total, k.saldo, k.condonado
  FROM cuentas k JOIN clientes c ON c.id = k.cliente_id";

fn a_fila(f: &sqlx::sqlite::SqliteRow, hoy: NaiveDate) -> CuentaFila {
    let limite: Option<String> = f.get("fecha_limite");
    let estado: String = f.get("estado");
    let atraso = limite.as_deref().and_then(|l| NaiveDate::parse_from_str(l, "%Y-%m-%d").ok()).map(|l| (hoy - l).num_days()).unwrap_or(0);
    let total: i64 = f.get("total");
    let saldo: i64 = f.get("saldo");
    CuentaFila {
        id: f.get("id"),
        numero: f.get::<Option<String>, _>("numero").unwrap_or_default(),
        tipo: f.get("tipo"),
        vencida: estado == "abierta" && atraso > 0,
        dias_atraso: if estado == "abierta" { atraso.max(0) } else { 0 },
        estado,
        cliente_id: f.get("cliente_id"),
        cliente: f.get("cliente"),
        telefono: f.get("telefono"),
        fecha: f.get("fecha"),
        fecha_limite: limite,
        descripcion: f.get("descripcion"),
        abonado: total - saldo - f.get::<i64, _>("condonado"),
        total,
        saldo,
    }
}

/// Búsqueda del cajero (F10): abiertas y pagadas sin entregar, por número del apartado, teléfono
/// (8 dígitos) o al menos 3 letras del nombre o de la descripción (D3). Sin cédula ni lista vacía: el
/// cajero no recorre los clientes. Quien no ve todas las cuentas recibe el teléfono tapado.
pub async fn buscar(pool: &SqlitePool, a: &Actor, q: &str) -> Res<Vec<CuentaFila>> {
    a.exigir("cuentas.crear", "buscar apartados")?;
    let q = q.trim();
    let hoy = ahora().date_naive();
    let digitos: String = q.chars().filter(char::is_ascii_digit).collect();
    let solo_numero = q.trim_start_matches(['A', 'a', 'C', 'c']).trim_start_matches('-');
    let num: Option<i64> = solo_numero.parse().ok().filter(|_| solo_numero.len() <= 7);
    let telefono = (digitos.len() >= 8 && q.chars().all(|c| c.is_ascii_digit() || " -+()".contains(c))).then(|| digitos[digitos.len() - 8..].to_string());
    let letras = q.chars().filter(|c| c.is_alphabetic()).count();
    if num.is_none() && telefono.is_none() && letras < 3 {
        return Err("Escriba el número del apartado, el teléfono o al menos 3 letras del nombre.".into());
    }
    // «!» escapa los comodines: un «%» o «_» escrito se busca tal cual (no lista todo).
    let like = if letras >= 3 { format!("%{}%", normalizar(q).replace('!', "!!").replace('%', "!%").replace('_', "!_")) } else { String::new() };
    let filas = sqlx::query(&format!(
        "{SELECT_FILA} WHERE k.eliminado_en IS NULL AND k.estado IN ('abierta', 'pagada') AND (k.tipo = 'credito' OR k.estado = 'abierta' OR k.fecha_entrega IS NULL)
           AND (k.consecutivo = ?1
             OR (?2 <> '' AND substr(replace(replace(replace(replace(c.telefono, '-', ''), ' ', ''), '+', ''), '(', ''), -8) = ?2)
             OR (?3 <> '' AND (c.nombre_busqueda LIKE ?3 ESCAPE '!' OR k.descripcion LIKE ?3 ESCAPE '!')))
         ORDER BY k.fecha DESC LIMIT 50"
    ))
    .bind(num.unwrap_or(-1))
    .bind(telefono.unwrap_or_default())
    .bind(&like)
    .fetch_all(pool)
    .await
    .map_err(e)?;
    let completo = a.puede("cuentas.ver_todas");
    Ok(filas
        .iter()
        .map(|f| {
            let mut x = a_fila(f, hoy);
            if !completo {
                x.telefono = x.telefono.map(|t| format!("••••{}", t.chars().rev().filter(char::is_ascii_digit).take(4).collect::<Vec<_>>().into_iter().rev().collect::<String>()));
            }
            x
        })
        .collect())
}

/// Lista del dueño: "abiertas", "vencidas", "pagadas" (sin entregar), "cerradas" o "credito".
pub async fn listar(pool: &SqlitePool, a: &Actor, filtro: &str) -> Res<Vec<CuentaFila>> {
    a.exigir("cuentas.ver_todas", "ver todos los apartados")?;
    let hoy = ahora().date_naive();
    let donde = match filtro {
        "abiertas" => "k.tipo = 'apartado' AND k.estado = 'abierta'",
        "vencidas" => "k.estado = 'abierta' AND k.fecha_limite < ?1",
        "pagadas" => "k.tipo = 'apartado' AND k.estado = 'pagada'",
        "cerradas" => "k.tipo = 'apartado' AND k.estado IN ('entregada', 'cancelada')",
        "credito" => "k.tipo = 'credito'",
        _ => return Err("Filtro inválido".into()),
    };
    let filas = sqlx::query(&format!("{SELECT_FILA} WHERE k.eliminado_en IS NULL AND {donde} ORDER BY k.fecha_limite, k.fecha LIMIT 2000"))
        .bind(hoy.to_string())
        .fetch_all(pool)
        .await
        .map_err(e)?;
    Ok(filas.iter().map(|f| a_fila(f, hoy)).collect())
}

/// Cuántas cuentas abiertas vencieron (aviso del menú del dueño).
pub async fn vencidas(pool: &SqlitePool, a: &Actor) -> Res<i64> {
    a.exigir("cuentas.ver_todas", "ver apartados vencidos")?;
    sqlx::query_scalar("SELECT COUNT(*) FROM cuentas WHERE estado = 'abierta' AND fecha_limite < ? AND eliminado_en IS NULL")
        .bind(ahora().date_naive().to_string())
        .fetch_one(pool)
        .await
        .map_err(e)
}

pub async fn obtener(pool: &SqlitePool, a: &Actor, id: &str) -> Res<CuentaDetalle> {
    a.exigir("cuentas.crear", "ver apartados")?;
    let hoy = ahora().date_naive();
    let f = sqlx::query(&format!("{SELECT_FILA} WHERE k.id = ?")).bind(id).fetch_optional(pool).await.map_err(e)?.ok_or("Apartado no encontrado")?;
    let x = sqlx::query("SELECT k.subtotal, k.descuento, k.redondeo, k.condonado, k.devuelto, k.retenido, k.venta_id, v.numero AS vnum, v.total AS vtotal, u.nombre AS usuario FROM cuentas k JOIN usuarios u ON u.id = k.usuario_id LEFT JOIN ventas v ON v.id = k.venta_id WHERE k.id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(e)?;
    let lineas = sqlx::query("SELECT producto_id, descripcion, cantidad, precio_unitario, descuento, total FROM cuenta_lineas WHERE cuenta_id = ? AND eliminado_en IS NULL ORDER BY orden")
        .bind(id)
        .fetch_all(pool)
        .await
        .map_err(e)?
        .iter()
        .map(|l| CuentaLinea { producto_id: l.get("producto_id"), descripcion: l.get("descripcion"), cantidad: l.get("cantidad"), precio_unitario: l.get("precio_unitario"), descuento: l.get("descuento"), total: l.get("total") })
        .collect();
    let abonos = sqlx::query(
        "SELECT a.id, a.fecha, f.nombre AS forma, a.monto, a.recibido, a.vuelto, a.referencia, u.nombre AS usuario, a.anulado_en, a.operacion_id
         FROM abonos a JOIN formas_pago f ON f.id = a.forma_pago_id JOIN usuarios u ON u.id = a.usuario_id WHERE a.cuenta_id = ? ORDER BY a.fecha, a.id",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(e)?
    .iter()
    .map(|b| AbonoFila {
        id: b.get("id"),
        fecha: b.get("fecha"),
        forma: b.get("forma"),
        monto: b.get("monto"),
        recibido: b.get("recibido"),
        vuelto: b.get("vuelto"),
        referencia: b.get("referencia"),
        usuario: b.get("usuario"),
        anulado: b.get::<Option<String>, _>("anulado_en").is_some(),
        operacion_id: b.get("operacion_id"),
    })
    .collect();
    let eventos = if a.puede("cuentas.ver_todas") {
        sqlx::query("SELECT e.fecha, e.tipo, e.monto, u.nombre AS usuario, e.motivo FROM cuenta_eventos e JOIN usuarios u ON u.id = e.usuario_id WHERE e.cuenta_id = ? ORDER BY e.fecha, e.id")
            .bind(id)
            .fetch_all(pool)
            .await
            .map_err(e)?
            .iter()
            .map(|v| EventoFila { fecha: v.get("fecha"), tipo: v.get("tipo"), monto: v.get("monto"), usuario: v.get("usuario"), motivo: v.get("motivo") })
            .collect()
    } else {
        vec![]
    };
    Ok(CuentaDetalle {
        cuenta: a_fila(&f, hoy),
        subtotal: x.get("subtotal"),
        descuento: x.get("descuento"),
        redondeo: x.get("redondeo"),
        condonado: x.get("condonado"),
        devuelto: x.get("devuelto"),
        retenido: x.get("retenido"),
        venta_total: x.get("vtotal"),
        venta_id: x.get("venta_id"),
        venta_numero: x.get("vnum"),
        usuario: x.get("usuario"),
        lineas,
        abonos,
        eventos,
    })
}

/// Imprime un comprobante (apartado, abono, cancelación). Una reimpresión lleva la marca COPIA,
/// suma a `reimpresiones` y queda en la bitácora.
pub async fn imprimir(pool: &SqlitePool, a: &Actor, cuenta_id: &str, datos: &[u8]) -> Res<bool> {
    a.exigir("cuentas.crear", "imprimir comprobantes")?;
    crate::escpos::validar(datos)?;
    let copia = crate::escpos::tiene_marca_copia(datos);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let caja_id: String = sqlx::query_scalar("SELECT caja_id FROM cuentas WHERE id = ?").bind(cuenta_id).fetch_optional(&mut *tx).await.map_err(e)?.ok_or("Apartado no encontrado")?;
    crate::impresoras::enviar_con(&mut tx, &caja_id, "tiquete", datos).await?;
    if copia {
        sqlx::query("UPDATE cuentas SET reimpresiones = reimpresiones + 1 WHERE id = ?").bind(cuenta_id).execute(&mut *tx).await.map_err(e)?;
        bitacora::registrar(&mut tx, Some(&a.id), "cuenta.reimprimir", "cuenta", Some(cuenta_id), &json!({})).await?;
    }
    tx.commit().await.map_err(e)?;
    Ok(copia)
}

#[cfg(test)]
#[path = "cuentas_tests.rs"]
mod tests;
