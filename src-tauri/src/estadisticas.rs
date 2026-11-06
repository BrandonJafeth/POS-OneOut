// Lectura del día para el Z: control por usuario (precio libre, descuentos, líneas quitadas antes de
// cobrar), ventas por hora, tiquete promedio, comparación con el mismo día de la semana anterior y
// los productos más vendidos. Solo informa: no entra en el cuadre ni en el efectivo esperado.
// Va dentro del Resumen, así que el cajero no lo recibe con el turno abierto (caja::sin_totales).

use crate::caja::Turno;
use crate::config;
use crate::util::{ahora_iso, e, Res};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Control {
    pub usuario: String,
    /// Líneas de "Venta simple" (precio escrito a mano, sin producto del catálogo).
    pub precio_libre: i64,
    pub monto_precio_libre: i64,
    /// Descuentos de línea y al total que dio.
    pub descuentos: i64,
    /// Líneas quitadas de una venta antes de cobrarla (solo las de ¢umbral o más quedan anotadas).
    pub lineas_quitadas: i64,
    pub monto_quitado: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PorHora {
    /// Hora local, 0–23.
    pub hora: i64,
    pub ventas: i64,
    pub total: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TopProducto {
    pub producto: String,
    pub cantidad: i64,
    pub monto: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Dia {
    pub dia: String,
    pub ventas: i64,
    pub total: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Estadisticas {
    pub control: Vec<Control>,
    /// Desde qué monto una línea quitada queda anotada (config caja_quitar_linea_bitacora).
    pub umbral_quitar: i64,
    pub por_hora: Vec<PorHora>,
    pub tiquete_promedio: i64,
    /// Toda la caja hoy y el mismo día de la semana anterior, los dos hasta la misma hora.
    pub hoy: Dia,
    pub semana_anterior: Dia,
    pub top_productos: Vec<TopProducto>,
}

const VENTAS_DEL_TURNO: &str = "v.turno_id = ? AND v.estado = 'completada' AND v.eliminado_en IS NULL";

pub async fn calcular(c: &mut SqliteConnection, t: &Turno) -> Res<Estadisticas> {
    let hasta = t.cerrado_en.clone().unwrap_or_else(ahora_iso);
    let mut x = Estadisticas { umbral_quitar: config::entero_con(c, "caja_quitar_linea_bitacora", 5000).await, ..Default::default() };

    // ── Control por usuario: tres consultas sumadas por nombre.
    let mut control: BTreeMap<String, Control> = BTreeMap::new();
    let libres = sqlx::query(&format!(
        "SELECT u.nombre, COUNT(*) AS n, COALESCE(SUM(l.total), 0) AS monto FROM venta_lineas l JOIN ventas v ON v.id = l.venta_id JOIN usuarios u ON u.id = v.usuario_id
         WHERE {VENTAS_DEL_TURNO} AND l.eliminado_en IS NULL AND l.producto_id IS NULL GROUP BY u.id"
    ))
    .bind(&t.id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    for f in &libres {
        let k = control.entry(f.get("nombre")).or_default();
        k.precio_libre = f.get("n");
        k.monto_precio_libre = f.get("monto");
    }
    let descuentos = sqlx::query(&format!(
        "SELECT u.nombre, COALESCE(SUM(v.descuento), 0) + COALESCE(SUM((SELECT SUM(l.descuento) FROM venta_lineas l WHERE l.venta_id = v.id AND l.eliminado_en IS NULL)), 0) AS d
         FROM ventas v JOIN usuarios u ON u.id = v.usuario_id WHERE {VENTAS_DEL_TURNO} GROUP BY u.id"
    ))
    .bind(&t.id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    for f in &descuentos {
        let d: i64 = f.get("d");
        if d > 0 {
            control.entry(f.get("nombre")).or_default().descuentos = d;
        }
    }
    // ventas::guardar_espera anota cada línea quitada de ¢umbral o más; aquí, las de esta caja en el turno.
    let quitadas = sqlx::query(
        "SELECT u.nombre, COUNT(*) AS n, COALESCE(SUM(CAST(json_extract(b.detalle, '$.monto') AS INTEGER)), 0) AS monto
         FROM bitacora b JOIN usuarios u ON u.id = b.usuario_id JOIN ventas_espera e ON e.id = b.entidad_id
         WHERE b.accion = 'venta_espera.quitar_linea' AND e.caja_id = ? AND b.fecha >= ? AND b.fecha <= ? GROUP BY u.id",
    )
    .bind(&t.caja_id)
    .bind(&t.abierto_en)
    .bind(&hasta)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    for f in &quitadas {
        let k = control.entry(f.get("nombre")).or_default();
        k.lineas_quitadas = f.get("n");
        k.monto_quitado = f.get("monto");
    }
    x.control = control.into_iter().map(|(usuario, k)| Control { usuario, ..k }).collect();

    // ── Ventas por hora (hora de la computadora, igual que el día de la caja).
    let horas = sqlx::query(&format!(
        "SELECT CAST(strftime('%H', v.fecha, 'localtime') AS INTEGER) AS h, COUNT(*) AS n, COALESCE(SUM(v.total), 0) AS total
         FROM ventas v WHERE {VENTAS_DEL_TURNO} GROUP BY h ORDER BY h"
    ))
    .bind(&t.id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    x.por_hora = horas.iter().map(|f| PorHora { hora: f.get("h"), ventas: f.get("n"), total: f.get("total") }).collect();
    let (n, total) = x.por_hora.iter().fold((0, 0), |(n, s), h| (n + h.ventas, s + h.total));
    x.tiquete_promedio = if n > 0 { (total as f64 / n as f64).round() as i64 } else { 0 };

    // ── Hoy contra el mismo día de la semana anterior, los dos hasta la misma hora.
    let atras = |iso: &str| chrono::DateTime::parse_from_rfc3339(iso).map(|d| (d - chrono::Duration::days(7)).with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
    let dia_atras = chrono::NaiveDate::parse_from_str(&t.dia, "%Y-%m-%d").map(|d| (d - chrono::Duration::days(7)).to_string());
    if let (Ok(hasta_atras), Ok(dia_atras)) = (atras(&hasta), dia_atras) {
        x.hoy = dia(c, &t.caja_id, &t.dia, &hasta).await?;
        x.semana_anterior = dia(c, &t.caja_id, &dia_atras, &hasta_atras).await?;
    }

    // ── Los 10 más vendidos (por cantidad) del catálogo; la venta simple ya sale en Control.
    let top = sqlx::query(&format!(
        "SELECT MAX(l.descripcion) AS p, SUM(l.cantidad) AS n, SUM(l.total) AS monto FROM venta_lineas l JOIN ventas v ON v.id = l.venta_id
         WHERE {VENTAS_DEL_TURNO} AND l.eliminado_en IS NULL AND l.producto_id IS NOT NULL GROUP BY l.producto_id ORDER BY n DESC, monto DESC, p LIMIT 10"
    ))
    .bind(&t.id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    x.top_productos = top.iter().map(|f| TopProducto { producto: f.get("p"), cantidad: f.get("n"), monto: f.get("monto") }).collect();
    Ok(x)
}

async fn dia(c: &mut SqliteConnection, caja_id: &str, dia: &str, hasta: &str) -> Res<Dia> {
    let f = sqlx::query("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM ventas WHERE caja_id = ? AND dia = ? AND fecha <= ? AND estado = 'completada' AND eliminado_en IS NULL")
        .bind(caja_id)
        .bind(dia)
        .bind(hasta)
        .fetch_one(&mut *c)
        .await
        .map_err(e)?;
    Ok(Dia { dia: dia.into(), ventas: f.get("n"), total: f.get("total") })
}
