// Reportes de ventas (fase 5, DISENO-FASE5.md). Solo el dueño (permiso `reportes.ventas`).
// - Todo por rango de FECHA DE NEGOCIO (caja_turnos.dia). Solo turnos cerrados; los abiertos van
//   aparte como "en curso" y no suman.
// - Regla "como al cerrar" (VENTA_EN_SU_Z): una venta cuenta en su turno si está completada o si se
//   anuló en OTRO turno (después de cerrar el suyo). Eso es exactamente lo que vio su Z congelado.
//   Cada reporte se compara con el `totales` congelado de cada turno: si no coincide, se avisa.
// - La hora del día usa la hora REAL de la venta. Los abonos son dinero, no ventas.
// - Nada lee la hora del sistema: "hoy" sale del reloj de util (y del turno abierto).

use crate::caja::{ABONO_EN_SU_Z, VENTA_TARDIA};
use crate::desglose;
use crate::sesion::Actor;
use crate::util::{ahora, e, Res};
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::BTreeMap;
#[cfg(test)]
use ts_rs::TS;

/// Una venta cuenta en el Z de su turno: completada, o anulada en otro turno (después del cierre).
pub const VENTA_EN_SU_Z: &str = "(v.estado = 'completada' OR (v.anulada_turno_id IS NOT NULL AND v.anulada_turno_id <> v.turno_id))";

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct Rangos {
    pub hoy: String,
    pub ayer: String,
    pub semana_desde: String,
    pub mes_desde: String,
    pub mes_anterior_desde: String,
    pub mes_anterior_hasta: String,
}

/// Atajos de fechas. "Hoy" es el día de negocio actual: el del turno abierto (una caja tardía del
/// sábado cuenta para el lunes) o, sin turno, la fecha del reloj.
pub async fn rangos(pool: &SqlitePool, a: &Actor) -> Res<Rangos> {
    a.exigir("reportes.ventas", "ver reportes de ventas")?;
    let abierto: Option<String> = sqlx::query_scalar("SELECT dia FROM caja_turnos WHERE estado = 'abierto' AND eliminado_en IS NULL ORDER BY abierto_en DESC LIMIT 1").fetch_optional(pool).await.map_err(e)?;
    let hoy = abierto.and_then(|d| NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok()).unwrap_or_else(|| ahora().date_naive());
    Ok(rangos_desde(hoy))
}

pub fn rangos_desde(hoy: NaiveDate) -> Rangos {
    let dia = chrono::Duration::days(1);
    let mes = hoy.with_day(1).unwrap_or(hoy);
    let fin_anterior = mes - dia;
    Rangos {
        hoy: hoy.to_string(),
        ayer: (hoy - dia).to_string(),
        semana_desde: (hoy - chrono::Duration::days(hoy.weekday().num_days_from_monday() as i64)).to_string(),
        mes_desde: mes.to_string(),
        mes_anterior_desde: fin_anterior.with_day(1).unwrap_or(fin_anterior).to_string(),
        mes_anterior_hasta: fin_anterior.to_string(),
    }
}

/// El período anterior de la misma duración (para comparar).
pub fn periodo_anterior(desde: NaiveDate, hasta: NaiveDate) -> (NaiveDate, NaiveDate) {
    // Un mes completo se compara con el mes anterior completo.
    if desde.day() == 1 && (hasta + chrono::Duration::days(1)).day() == 1 {
        let fin = desde - chrono::Duration::days(1);
        return (fin.with_day(1).unwrap_or(fin), fin);
    }
    let n = (hasta - desde).num_days() + 1;
    (desde - chrono::Duration::days(n), desde - chrono::Duration::days(1))
}

// ─────────── Tipos ───────────

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct Totales {
    pub tiquetes: i64,
    pub ventas: i64,
    pub descuentos: i64,
    /// Ventas anuladas después de cerrar su turno, en el día del turno donde se anularon.
    pub anulaciones_posteriores: i64,
    /// ventas − anulaciones posteriores.
    pub neto: i64,
    pub abonos: i64,
    pub otros_ingresos: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct PorDia {
    pub dia: String,
    pub turnos: i64,
    pub tiquetes: i64,
    pub ventas: i64,
    pub descuentos: i64,
    pub anulaciones_posteriores: i64,
    pub abonos: i64,
    pub neto: i64,
    pub despues_del_cierre: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct Fila {
    pub clave: String,
    pub nombre: String,
    pub cantidad: i64,
    pub monto: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct PorUsuario {
    pub usuario: String,
    pub tiquetes: i64,
    pub monto: i64,
    pub descuentos: i64,
    pub anuladas: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct PorForma {
    pub forma: String,
    pub ventas: i64,
    pub abonos: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct PorHora {
    pub hora: i64,
    pub tiquetes: i64,
    pub monto: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct Anulacion {
    pub fecha: String,
    pub dia_venta: String,
    pub numero: String,
    pub usuario: String,
    pub motivo: String,
    pub monto: i64,
    /// En su mismo turno (no sumó nunca) o después (se resta el día que se anuló).
    pub posterior: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct Tardia {
    pub fecha: String,
    pub dia: String,
    pub numero: String,
    pub usuario: String,
    pub monto: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct Diferencia {
    pub turno_id: String,
    pub dia: String,
    pub abrio: String,
    pub cerro: String,
    pub apertura: Option<i64>,
    pub cierre: Option<i64>,
    pub nota: Option<String>,
    pub revisada: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct PorCobrar {
    pub numero: String,
    pub tipo: String,
    pub cliente: String,
    pub fecha_limite: Option<String>,
    pub saldo: i64,
    /// Días desde la fecha límite al final del rango (0 = al día).
    pub dias_atraso: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct Utilidad {
    pub producto: String,
    pub cantidad: i64,
    pub venta: i64,
    pub costo: i64,
    pub utilidad: i64,
    /// Parte del costo tomado del costo actual (ventas de antes de guardar el costo por venta).
    pub aproximado: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct EnCurso {
    pub turno_id: String,
    pub dia: String,
    pub abrio: String,
    pub abierto_en: String,
    pub tiquetes: i64,
    pub ventas: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct Reporte {
    pub desde: String,
    pub hasta: String,
    pub anterior_desde: String,
    pub anterior_hasta: String,
    pub turnos: i64,
    pub totales: Totales,
    pub anterior: Totales,
    pub por_dia: Vec<PorDia>,
    pub por_departamento: Vec<Fila>,
    pub por_producto: Vec<Fila>,
    /// Activos que controlan inventario y no se vendieron en el rango.
    pub sin_ventas: i64,
    pub por_usuario: Vec<PorUsuario>,
    pub por_forma: Vec<PorForma>,
    pub por_hora: Vec<PorHora>,
    pub anulaciones: Vec<Anulacion>,
    pub descuentos_autorizados: i64,
    pub descuentos_catalogo: i64,
    pub despues_del_cierre: Vec<Tardia>,
    pub diferencias: Vec<Diferencia>,
    pub por_cobrar: Vec<PorCobrar>,
    pub utilidad: Vec<Utilidad>,
    /// Productos vendidos sin costo: no entran en la utilidad.
    pub sin_costo: Vec<String>,
    pub en_curso: Vec<EnCurso>,
    /// Turnos cuyo total en vivo no coincide con su Z congelado (no debería pasar nunca).
    pub no_coinciden: Vec<String>,
}

// ─────────── Cálculo ───────────

fn fecha(s: &str) -> Res<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| format!("Fecha inválida: {s}"))
}

/// Ventas que cuentan, en turnos cerrados del rango. `{}` se reemplaza por columnas extra.
fn ventas_sql(cols: &str) -> String {
    format!(
        "SELECT {cols} FROM ventas v JOIN caja_turnos t ON t.id = v.turno_id
         WHERE t.estado = 'cerrado' AND t.eliminado_en IS NULL AND t.dia BETWEEN ?1 AND ?2 AND v.eliminado_en IS NULL AND {VENTA_EN_SU_Z}"
    )
}

async fn totales(c: &mut SqliteConnection, desde: &str, hasta: &str) -> Res<Totales> {
    let f = sqlx::query(&ventas_sql("COUNT(*) AS n, COALESCE(SUM(v.total), 0) AS total, COALESCE(SUM(v.descuento), 0) AS d"))
        .bind(desde)
        .bind(hasta)
        .fetch_one(&mut *c)
        .await
        .map_err(e)?;
    let lineas: i64 = sqlx::query_scalar(&format!(
        "SELECT COALESCE(SUM(l.descuento), 0) FROM venta_lineas l JOIN ({}) x ON x.id = l.venta_id WHERE l.eliminado_en IS NULL",
        ventas_sql("v.id")
    ))
    .bind(desde)
    .bind(hasta)
    .fetch_one(&mut *c)
    .await
    .map_err(e)?;
    let posteriores: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(v.total), 0) FROM ventas v JOIN caja_turnos ta ON ta.id = v.anulada_turno_id
         WHERE v.estado = 'anulada' AND v.anulada_turno_id <> v.turno_id AND ta.estado = 'cerrado' AND ta.dia BETWEEN ?1 AND ?2",
    )
    .bind(desde)
    .bind(hasta)
    .fetch_one(&mut *c)
    .await
    .map_err(e)?;
    let abonos: i64 = sqlx::query_scalar(&format!(
        "SELECT COALESCE(SUM(a.monto), 0) FROM abonos a JOIN caja_turnos t ON t.id = a.turno_id WHERE t.estado = 'cerrado' AND t.dia BETWEEN ?1 AND ?2 AND {ABONO_EN_SU_Z}"
    ))
    .bind(desde)
    .bind(hasta)
    .fetch_one(&mut *c)
    .await
    .map_err(e)?;
    let retenido: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(k.retenido), 0) FROM cuenta_eventos ev JOIN cuentas k ON k.id = ev.cuenta_id JOIN caja_turnos t ON t.id = ev.turno_id
         WHERE ev.tipo = 'cancelada' AND t.estado = 'cerrado' AND t.dia BETWEEN ?1 AND ?2",
    )
    .bind(desde)
    .bind(hasta)
    .fetch_one(&mut *c)
    .await
    .map_err(e)?;
    let ventas: i64 = f.get("total");
    Ok(Totales { tiquetes: f.get("n"), ventas, descuentos: f.get::<i64, _>("d") + lineas, anulaciones_posteriores: posteriores, neto: ventas - posteriores, abonos, otros_ingresos: retenido })
}

pub async fn ventas(pool: &SqlitePool, a: &Actor, desde: &str, hasta: &str) -> Res<Reporte> {
    a.exigir("reportes.ventas", "ver reportes de ventas")?;
    let (d0, d1) = (fecha(desde)?, fecha(hasta)?);
    if d1 < d0 || (d1 - d0).num_days() > 366 {
        return Err("El rango va de 1 día a 1 año".into());
    }
    let (p0, p1) = periodo_anterior(d0, d1);
    let mut c = pool.acquire().await.map_err(e)?;
    let mut r = Reporte { desde: desde.into(), hasta: hasta.into(), anterior_desde: p0.to_string(), anterior_hasta: p1.to_string(), ..Default::default() };
    r.totales = totales(&mut c, desde, hasta).await?;
    r.anterior = totales(&mut c, &r.anterior_desde, &r.anterior_hasta).await?;

    // Turnos cerrados del rango: control contra su Z congelado (misma regla) y diferencias de caja.
    let turnos = sqlx::query(
        "SELECT t.id, t.dia, t.totales, t.diferencia, t.diferencia_apertura, t.nota_cierre, t.diferencia_revisada_por, ua.nombre AS abrio, COALESCE(uc.nombre, '') AS cerro,
           (SELECT COALESCE(SUM(v.total), 0) FROM ventas v WHERE v.turno_id = t.id AND v.eliminado_en IS NULL AND (v.estado = 'completada' OR (v.anulada_turno_id IS NOT NULL AND v.anulada_turno_id <> v.turno_id))) AS vivo
         FROM caja_turnos t JOIN usuarios ua ON ua.id = t.usuario_apertura_id LEFT JOIN usuarios uc ON uc.id = t.usuario_cierre_id
         WHERE t.estado = 'cerrado' AND t.eliminado_en IS NULL AND t.dia BETWEEN ?1 AND ?2 ORDER BY t.dia, t.abierto_en",
    )
    .bind(desde)
    .bind(hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    r.turnos = turnos.len() as i64;
    for t in &turnos {
        let congelado = t.get::<Option<String>, _>("totales").and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v["totalVentas"].as_i64());
        if congelado.is_some_and(|z| z != t.get::<i64, _>("vivo")) {
            r.no_coinciden.push(format!("{} ({})", t.get::<String, _>("dia"), t.get::<String, _>("abrio")));
        }
        let (ap, ci): (Option<i64>, Option<i64>) = (t.get("diferencia_apertura"), t.get("diferencia"));
        if ap.unwrap_or(0) != 0 || ci.unwrap_or(0) != 0 {
            r.diferencias.push(Diferencia {
                turno_id: t.get("id"),
                dia: t.get("dia"),
                abrio: t.get("abrio"),
                cerro: t.get("cerro"),
                apertura: ap,
                cierre: ci,
                nota: t.get("nota_cierre"),
                revisada: t.get::<Option<String>, _>("diferencia_revisada_por").is_some(),
            });
        }
    }

    // Por día de negocio.
    let mut dias: BTreeMap<String, PorDia> = BTreeMap::new();
    let por_dia_sql = ventas_sql(&format!(
        "t.dia, COUNT(DISTINCT t.id) AS turnos, COUNT(*) AS n, SUM(v.total) AS total, SUM(v.descuento + (SELECT COALESCE(SUM(l.descuento), 0) FROM venta_lineas l WHERE l.venta_id = v.id)) AS d,
         SUM(CASE WHEN {VENTA_TARDIA} THEN 1 ELSE 0 END) AS tardias"
    )) + " GROUP BY t.dia";
    for f in sqlx::query(&por_dia_sql)
    .bind(desde)
    .bind(hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    {
        let dia: String = f.get("dia");
        let x = dias.entry(dia.clone()).or_insert_with(|| PorDia { dia, ..Default::default() });
        (x.turnos, x.tiquetes, x.ventas, x.descuentos, x.despues_del_cierre) = (f.get("turnos"), f.get("n"), f.get("total"), f.get("d"), f.get("tardias"));
    }
    for f in sqlx::query(
        "SELECT ta.dia, SUM(v.total) AS m FROM ventas v JOIN caja_turnos ta ON ta.id = v.anulada_turno_id
         WHERE v.estado = 'anulada' AND v.anulada_turno_id <> v.turno_id AND ta.estado = 'cerrado' AND ta.dia BETWEEN ?1 AND ?2 GROUP BY ta.dia",
    )
    .bind(desde)
    .bind(hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    {
        let dia: String = f.get("dia");
        dias.entry(dia.clone()).or_insert_with(|| PorDia { dia, ..Default::default() }).anulaciones_posteriores = f.get("m");
    }
    for f in sqlx::query(&format!(
        "SELECT t.dia, SUM(a.monto) AS m FROM abonos a JOIN caja_turnos t ON t.id = a.turno_id WHERE t.estado = 'cerrado' AND t.dia BETWEEN ?1 AND ?2 AND {ABONO_EN_SU_Z} GROUP BY t.dia"
    ))
    .bind(desde)
    .bind(hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    {
        let dia: String = f.get("dia");
        dias.entry(dia.clone()).or_insert_with(|| PorDia { dia, ..Default::default() }).abonos = f.get("m");
    }
    r.por_dia = dias
        .into_values()
        .map(|mut d| {
            d.neto = d.ventas - d.anulaciones_posteriores;
            d
        })
        .collect();

    // Departamentos y productos: el mismo reparto exacto que el Z (descuento al total y redondeo).
    let ids: Vec<(String, String, i64)> = sqlx::query_as(&ventas_sql("v.id, v.numero, v.total")).bind(desde).bind(hasta).fetch_all(&mut *c).await.map_err(e)?;
    let ventas_d: Vec<desglose::Venta> = ids.iter().map(|(id, numero, total)| desglose::Venta { id: id.clone(), numero: numero.clone(), total: *total }).collect();
    let lineas: Vec<desglose::Linea> = sqlx::query(&format!(
        "SELECT l.venta_id, l.producto_id, l.descripcion, l.departamento_id, d.nombre AS dep, d.orden AS dep_orden, l.cantidad, l.precio_unitario, l.total
         FROM venta_lineas l JOIN ({}) x ON x.id = l.venta_id JOIN departamentos d ON d.id = l.departamento_id WHERE l.eliminado_en IS NULL",
        ventas_sql("v.id")
    ))
    .bind(desde)
    .bind(hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    .iter()
    .map(|f| {
        let producto: String = f.get("descripcion");
        desglose::Linea {
            venta_id: f.get("venta_id"),
            clave: f.get::<Option<String>, _>("producto_id").unwrap_or_else(|| format!("libre:{}", producto.to_lowercase())),
            producto,
            departamento_id: f.get("departamento_id"),
            departamento: f.get("dep"),
            orden_departamento: f.get("dep_orden"),
            cantidad: f.get("cantidad"),
            precio: f.get("precio_unitario"),
            importe: f.get("total"),
        }
    })
    .collect();
    // Para repartir solo hacen falta los montos de la venta (una "forma" con el total).
    let pagos: Vec<desglose::Pago> = ventas_d.iter().map(|v| desglose::Pago { venta_id: v.id.clone(), forma: "-".into(), tipo: "-".into(), orden: 0, da_vuelto: false, monto: v.total }).collect();
    let dg = desglose::armar(&ventas_d, &lineas, &pagos);
    r.por_departamento = dg.departamentos.iter().map(|d| Fila { clave: d.departamento_id.clone(), nombre: d.nombre.clone(), cantidad: d.cantidad, monto: d.monto }).collect();
    let mut prods: BTreeMap<String, Fila> = BTreeMap::new();
    for d in &dg.departamentos {
        for f in &d.filas {
            let x = prods.entry(f.producto.to_lowercase()).or_insert_with(|| Fila { clave: f.producto.to_lowercase(), nombre: f.producto.clone(), ..Default::default() });
            x.cantidad += f.cantidad;
            x.monto += f.monto;
        }
    }
    r.por_producto = prods.into_values().collect();
    r.por_producto.sort_by(|a, b| b.monto.cmp(&a.monto).then(a.nombre.cmp(&b.nombre)));
    r.sin_ventas = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM productos p WHERE p.activo = 1 AND p.eliminado_en IS NULL AND p.controla_inventario = 1
           AND NOT EXISTS (SELECT 1 FROM venta_lineas l JOIN ({}) x ON x.id = l.venta_id WHERE l.producto_id = p.id)",
        ventas_sql("v.id")
    ))
    .bind(desde)
    .bind(hasta)
    .fetch_one(&mut *c)
    .await
    .map_err(e)?;

    // Utilidad bruta: costo guardado en la venta; si no hay (ventas viejas), el costo actual (aproximado).
    let mut util_map: BTreeMap<String, Utilidad> = BTreeMap::new();
    let mut sin_costo = std::collections::BTreeSet::new();
    for f in sqlx::query(&format!(
        "SELECT l.descripcion, l.cantidad, l.total, l.costo_unitario, pc.costo AS actual FROM venta_lineas l JOIN ({}) x ON x.id = l.venta_id
         LEFT JOIN producto_costos pc ON pc.producto_id = l.producto_id WHERE l.eliminado_en IS NULL",
        ventas_sql("v.id")
    ))
    .bind(desde)
    .bind(hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    {
        let nombre: String = f.get("descripcion");
        let (guardado, actual): (Option<i64>, Option<i64>) = (f.get("costo_unitario"), f.get("actual"));
        let Some(costo) = guardado.or(actual) else {
            sin_costo.insert(nombre);
            continue;
        };
        let cant: i64 = f.get("cantidad");
        let x = util_map.entry(nombre.to_lowercase()).or_insert_with(|| Utilidad { producto: nombre.clone(), ..Default::default() });
        x.cantidad += cant;
        x.venta += f.get::<i64, _>("total");
        x.costo += costo * cant;
        x.aproximado |= guardado.is_none();
    }
    r.utilidad = util_map
        .into_values()
        .map(|mut u| {
            u.utilidad = u.venta - u.costo;
            u
        })
        .collect();
    r.utilidad.sort_by(|a, b| b.utilidad.cmp(&a.utilidad));
    r.sin_costo = sin_costo.into_iter().collect();

    // Por usuario (quien cobró).
    r.por_usuario = sqlx::query(&format!(
        "SELECT u.nombre, COUNT(*) AS n, SUM(v.total) AS m,
           SUM(v.descuento + (SELECT COALESCE(SUM(l.descuento - l.descuento_catalogo), 0) FROM venta_lineas l WHERE l.venta_id = v.id)) AS d,
           SUM(CASE WHEN v.estado = 'anulada' THEN 1 ELSE 0 END) AS an
         FROM ventas v JOIN caja_turnos t ON t.id = v.turno_id JOIN usuarios u ON u.id = v.usuario_id
         WHERE t.estado = 'cerrado' AND t.eliminado_en IS NULL AND t.dia BETWEEN ?1 AND ?2 AND v.eliminado_en IS NULL AND {VENTA_EN_SU_Z}
         GROUP BY u.id ORDER BY m DESC"
    ))
    .bind(desde)
    .bind(hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    .iter()
    .map(|f| PorUsuario { usuario: f.get("nombre"), tiquetes: f.get("n"), monto: f.get("m"), descuentos: f.get("d"), anuladas: f.get("an") })
    .collect();

    // Por forma de pago: ventas (lo cobrado en la venta) y abonos (dinero de apartados y crédito).
    let mut formas: BTreeMap<(i64, String), PorForma> = BTreeMap::new();
    for f in sqlx::query(&format!(
        "SELECT fp.orden, fp.nombre, SUM(p.monto) AS m FROM venta_pagos p JOIN ({}) x ON x.id = p.venta_id JOIN formas_pago fp ON fp.id = p.forma_pago_id WHERE p.eliminado_en IS NULL GROUP BY fp.id",
        ventas_sql("v.id")
    ))
    .bind(desde)
    .bind(hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    {
        let n: String = f.get("nombre");
        formas.entry((f.get("orden"), n.clone())).or_insert_with(|| PorForma { forma: n, ..Default::default() }).ventas = f.get("m");
    }
    for f in sqlx::query(&format!(
        "SELECT fp.orden, fp.nombre, SUM(a.monto) AS m FROM abonos a JOIN caja_turnos t ON t.id = a.turno_id JOIN formas_pago fp ON fp.id = a.forma_pago_id
         WHERE t.estado = 'cerrado' AND t.dia BETWEEN ?1 AND ?2 AND {ABONO_EN_SU_Z} GROUP BY fp.id"
    ))
    .bind(desde)
    .bind(hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    {
        let n: String = f.get("nombre");
        formas.entry((f.get("orden"), n.clone())).or_insert_with(|| PorForma { forma: n, ..Default::default() }).abonos = f.get("m");
    }
    // Lo que no entró por una forma hoy (apartados liquidados y a crédito), para que la tabla sume.
    let resto: Vec<(String, i64)> = sqlx::query_as(&format!(
        "SELECT k.tipo, SUM(x.total - COALESCE((SELECT SUM(p.monto) FROM venta_pagos p WHERE p.venta_id = x.id AND p.eliminado_en IS NULL), 0))
         FROM ({}) x JOIN cuentas k ON k.id = x.cuenta_id GROUP BY k.tipo",
        ventas_sql("v.id, v.total, v.cuenta_id")
    ))
    .bind(desde)
    .bind(hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    for (tipo, m) in resto {
        let n = if tipo == "credito" { "A crédito (por cobrar)" } else { "Pagadas con abonos" };
        formas.entry((1000, n.into())).or_insert_with(|| PorForma { forma: n.into(), ..Default::default() }).ventas = m;
    }
    r.por_forma = formas.into_values().collect();

    // Por hora REAL del cobro (en el huso del reloj de la app, no el del sistema).
    let huso = *ahora().offset();
    let mut horas: BTreeMap<i64, PorHora> = BTreeMap::new();
    for (f, total) in sqlx::query_as::<_, (String, i64)>(&ventas_sql("v.fecha, v.total")).bind(desde).bind(hasta).fetch_all(&mut *c).await.map_err(e)? {
        if let Ok(d) = chrono::DateTime::parse_from_rfc3339(&f) {
            let h = chrono::Timelike::hour(&d.with_timezone(&huso)) as i64;
            let x = horas.entry(h).or_insert_with(|| PorHora { hora: h, ..Default::default() });
            x.tiquetes += 1;
            x.monto += total;
        }
    }
    r.por_hora = horas.into_values().collect();

    // Anulaciones: del mismo turno (no sumaron) y posteriores (se restan el día que se anularon).
    r.anulaciones = sqlx::query(
        "SELECT v.anulada_en, COALESCE(t.dia, v.dia) AS dia_venta, v.numero, COALESCE(u.nombre, '') AS usuario, COALESCE(v.anulada_motivo, '') AS motivo, v.total,
           (v.anulada_turno_id IS NOT NULL AND v.anulada_turno_id <> v.turno_id) AS posterior
         FROM ventas v LEFT JOIN caja_turnos t ON t.id = v.turno_id LEFT JOIN caja_turnos ta ON ta.id = COALESCE(v.anulada_turno_id, v.turno_id) LEFT JOIN usuarios u ON u.id = v.anulada_por
         WHERE v.estado = 'anulada' AND ta.estado = 'cerrado' AND ta.dia BETWEEN ?1 AND ?2 ORDER BY v.anulada_en",
    )
    .bind(desde)
    .bind(hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    .iter()
    .map(|f| Anulacion {
        fecha: f.get::<Option<String>, _>("anulada_en").unwrap_or_default(),
        dia_venta: f.get("dia_venta"),
        numero: f.get("numero"),
        usuario: f.get("usuario"),
        motivo: f.get("motivo"),
        monto: f.get("total"),
        posterior: f.get::<i64, _>("posterior") == 1,
    })
    .collect();
    let (aut, cat): (i64, i64) = sqlx::query_as(&format!(
        "SELECT COALESCE(SUM(CASE WHEN x.descuento_autorizado_por IS NOT NULL THEN 1 ELSE 0 END), 0),
                COALESCE((SELECT SUM(l.descuento_catalogo) FROM venta_lineas l JOIN ({}) y ON y.id = l.venta_id), 0)
         FROM ({}) x",
        ventas_sql("v.id"),
        ventas_sql("v.id, v.descuento_autorizado_por")
    ))
    .bind(desde)
    .bind(hasta)
    .fetch_one(&mut *c)
    .await
    .map_err(e)?;
    (r.descuentos_autorizados, r.descuentos_catalogo) = (aut, cat);

    r.despues_del_cierre = sqlx::query(&format!(
        "SELECT v.fecha, t.dia, v.numero, u.nombre AS usuario, v.total
         FROM ventas v JOIN caja_turnos t ON t.id = v.turno_id JOIN usuarios u ON u.id = v.usuario_id
         WHERE t.estado = 'cerrado' AND t.eliminado_en IS NULL AND t.dia BETWEEN ?1 AND ?2 AND v.eliminado_en IS NULL AND {VENTA_EN_SU_Z} AND {VENTA_TARDIA}
         ORDER BY v.fecha"
    ))
    .bind(desde)
    .bind(hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    .iter()
    .map(|f| Tardia { fecha: f.get("fecha"), dia: f.get("dia"), numero: f.get("numero"), usuario: f.get("usuario"), monto: f.get("total") })
    .collect();

    // Cuentas por cobrar al final del rango, con su atraso.
    r.por_cobrar = sqlx::query(
        "SELECT k.numero, k.tipo, c.nombre, k.fecha_limite, k.saldo FROM cuentas k JOIN clientes c ON c.id = k.cliente_id
         WHERE k.estado = 'abierta' AND k.saldo > 0 AND k.eliminado_en IS NULL ORDER BY k.fecha_limite",
    )
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    .iter()
    .map(|f| {
        let limite: Option<String> = f.get("fecha_limite");
        let atraso = limite.as_deref().and_then(|l| NaiveDate::parse_from_str(l, "%Y-%m-%d").ok()).map(|l| (d1 - l).num_days().max(0)).unwrap_or(0);
        PorCobrar { numero: f.get::<Option<String>, _>("numero").unwrap_or_default(), tipo: f.get("tipo"), cliente: f.get("nombre"), fecha_limite: limite, saldo: f.get("saldo"), dias_atraso: atraso }
    })
    .collect();

    // Turnos abiertos: aparte, "en curso" (no suman al rango).
    r.en_curso = sqlx::query(
        "SELECT t.id, t.dia, t.abierto_en, ua.nombre AS abrio,
           (SELECT COUNT(*) FROM ventas v WHERE v.turno_id = t.id AND v.estado = 'completada') AS n,
           (SELECT COALESCE(SUM(v.total), 0) FROM ventas v WHERE v.turno_id = t.id AND v.estado = 'completada') AS m
         FROM caja_turnos t JOIN usuarios ua ON ua.id = t.usuario_apertura_id WHERE t.estado = 'abierto' AND t.eliminado_en IS NULL",
    )
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    .iter()
    .map(|f| EnCurso { turno_id: f.get("id"), dia: f.get("dia"), abrio: f.get("abrio"), abierto_en: f.get("abierto_en"), tiquetes: f.get("n"), ventas: f.get("m") })
    .collect();
    Ok(r)
}

#[cfg(test)]
#[path = "reportes_tests.rs"]
mod tests;
