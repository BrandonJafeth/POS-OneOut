// Totales y pagos de una venta. Es la versión que DECIDE (src/lib/venta/calculo.ts y pagos.ts
// solo muestran lo mismo en pantalla). Todo en colones enteros.
//   importe de línea = cantidad × precio − descuento de línea
//   total = redondear(subtotal − descuento al total, paso);  redondeo = total − neto

use crate::util::Res;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Linea {
    pub id: String,
    pub producto_id: Option<String>,
    pub codigo: Option<String>,
    pub descripcion: String,
    pub departamento_id: String,
    pub cantidad: i64,
    pub precio_unitario: i64,
    pub descuento: i64,
    /// % de descuento del producto cuando se agregó (Rust lo compara con el del catálogo al cobrar).
    #[serde(default)]
    pub descuento_catalogo: i64,
    pub tasa_iva: f64,
    pub exento: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClienteBasico {
    pub id: String,
    pub nombre: String,
    pub telefono: Option<String>,
    pub cedula: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Autorizacion {
    pub dueno_id: String,
    pub pct: f64,
    /// Token de un solo uso que emitió Rust al verificar el PIN (ventas::autorizar_descuento).
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Estado {
    pub lineas: Vec<Linea>,
    pub descuento_total: i64,
    pub cliente: Option<ClienteBasico>,
    pub nombre_tiquete: Option<String>,
    pub requiere_factura: bool,
    pub autorizacion: Option<Autorizacion>,
}

pub fn redondear(n: i64, paso: i64) -> i64 {
    if paso <= 1 {
        return n;
    }
    (((n as f64) / (paso as f64)).round() as i64 * paso).max(0)
}

pub fn bruto(l: &Linea) -> i64 {
    l.cantidad * l.precio_unitario
}

pub fn importe(l: &Linea) -> i64 {
    bruto(l) - l.descuento
}

pub fn iva_incluido(total: i64, tasa: f64, exento: bool) -> i64 {
    if exento || tasa <= 0.0 {
        return 0;
    }
    ((total as f64) * tasa / (100.0 + tasa)).round() as i64
}

pub fn validar_linea(l: &Linea) -> Res<()> {
    let d = &l.descripcion;
    if l.descripcion.trim().is_empty() || l.descripcion.chars().count() > 200 {
        return Err("Descripción de línea inválida".into());
    }
    if !(1..=100_000).contains(&l.cantidad) {
        return Err(format!("\"{d}\": la cantidad debe ser un número entero de 1 a 100.000"));
    }
    if !(0..=100_000_000).contains(&l.precio_unitario) {
        return Err(format!("\"{d}\": precio inválido"));
    }
    if l.descuento < 0 || l.descuento > bruto(l) {
        return Err(format!("\"{d}\": descuento inválido"));
    }
    if !(0.0..=100.0).contains(&l.tasa_iva) {
        return Err(format!("\"{d}\": tasa de IVA inválida"));
    }
    Ok(())
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Totales {
    pub bruto: i64,
    pub descuento_lineas: i64,
    pub subtotal: i64,
    pub descuento: i64,
    pub redondeo: i64,
    pub total: i64,
    pub iva: i64,
    pub pct_descuento: f64,
    pub iva_lineas: Vec<i64>,
}

pub fn totales(e: &Estado, paso: i64) -> Totales {
    let b: i64 = e.lineas.iter().map(bruto).sum();
    let dl: i64 = e.lineas.iter().map(|l| l.descuento).sum();
    let subtotal = b - dl;
    let descuento = e.descuento_total.clamp(0, subtotal.max(0));
    let neto = subtotal - descuento;
    let total = redondear(neto, paso);
    let factor = if subtotal > 0 { neto as f64 / subtotal as f64 } else { 0.0 };
    let iva_lineas: Vec<i64> = e.lineas.iter().map(|l| iva_incluido(((importe(l) as f64) * factor).round() as i64, l.tasa_iva, l.exento)).collect();
    Totales {
        bruto: b,
        descuento_lineas: dl,
        subtotal,
        descuento,
        redondeo: total - neto,
        total,
        iva: iva_lineas.iter().sum(),
        pct_descuento: if b > 0 { ((dl + descuento) as f64 / b as f64) * 100.0 } else { 0.0 },
        iva_lineas,
    }
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PagoEntrada {
    pub forma_pago_id: String,
    pub monto: i64,
    pub banco_id: Option<String>,
    pub referencia: Option<String>,
    pub ultimos4: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Forma {
    pub id: String,
    pub nombre: String,
    pub requiere_banco: bool,
    pub requiere_referencia: bool,
    pub da_vuelto: bool,
    pub pide_ultimos4: bool,
}

#[derive(Debug, Clone)]
pub struct Aplicado {
    pub pago: PagoEntrada,
    pub aplicado: i64,
    pub recibido: Option<i64>,
    pub vuelto: Option<i64>,
}

#[derive(Debug)]
pub struct ResultadoPagos {
    pub faltante: i64,
    pub vuelto: i64,
    pub errores: Vec<String>,
    pub aplicados: Vec<Aplicado>,
}

/// Pago mixto: la suma cubre el total; solo el efectivo da vuelto (y sale del efectivo).
pub fn pagos(total: i64, entradas: &[PagoEntrada], formas: &[Forma]) -> ResultadoPagos {
    let mut errores = Vec::new();
    let forma = |id: &str| formas.iter().find(|f| f.id == id);
    let mut sin_vuelto = 0;
    for p in entradas {
        let Some(f) = forma(&p.forma_pago_id) else {
            errores.push("Forma de pago no disponible".to_string());
            continue;
        };
        if !(1..=1_000_000_000).contains(&p.monto) {
            errores.push(format!("{}: monto inválido", f.nombre));
        }
        if f.requiere_banco && p.banco_id.as_deref().unwrap_or("").is_empty() {
            errores.push(format!("{}: elija el banco", f.nombre));
        }
        if f.requiere_referencia && p.referencia.as_deref().unwrap_or("").trim().is_empty() {
            errores.push(format!("{}: escriba la referencia", f.nombre));
        }
        if p.referencia.as_deref().is_some_and(|r| r.chars().count() > 60 || r.chars().any(char::is_control)) {
            errores.push(format!("{}: referencia inválida", f.nombre));
        }
        if let Some(u) = p.ultimos4.as_deref().filter(|u| !u.is_empty()) {
            if !(f.pide_ultimos4 && u.len() == 4 && u.chars().all(|c| c.is_ascii_digit())) {
                errores.push(format!("{}: los últimos 4 dígitos son 4 números", f.nombre));
            }
        }
        if !f.da_vuelto {
            sin_vuelto += p.monto;
        }
    }
    // Venta de ¢0 (regalo, descuento total): sin dinero. Si no, el efectivo "recibido" abre la
    // gaveta sin venta real (una "no venta" que no quedaría registrada como tal).
    if total == 0 && !entradas.is_empty() {
        errores.push("La venta es de ¢0: no reciba dinero. Borre el monto del pago".into());
    } else if sin_vuelto >= total && entradas.iter().any(|p| forma(&p.forma_pago_id).is_some_and(|f| f.da_vuelto)) {
        // Mismo hueco: tarjeta por todo + "efectivo" que vuelve entero como vuelto abre la gaveta.
        errores.push("La tarjeta, SINPE o transferencia ya pagan todo: quite el efectivo".into());
    }
    if sin_vuelto > total {
        errores.push("Tarjeta, SINPE y transferencia no dan vuelto: no pueden pasar del total".into());
    }
    let pagado: i64 = entradas.iter().map(|p| p.monto.max(0)).sum();
    let faltante = (total - pagado).max(0);
    let vuelto = (pagado - total).max(0);
    let mut por_repartir = vuelto;
    let mut aplicados: Vec<Aplicado> = entradas.iter().map(|p| Aplicado { pago: p.clone(), aplicado: p.monto, recibido: None, vuelto: None }).collect();
    for a in aplicados.iter_mut().rev() {
        if !forma(&a.pago.forma_pago_id).is_some_and(|f| f.da_vuelto) {
            continue;
        }
        let v = por_repartir.min(a.pago.monto);
        a.recibido = Some(a.pago.monto);
        a.vuelto = Some(v);
        a.aplicado = a.pago.monto - v;
        por_repartir -= v;
    }
    if por_repartir > 0 && errores.is_empty() {
        errores.push("El vuelto solo puede salir del efectivo".into());
    }
    aplicados.retain(|a| a.aplicado > 0);
    ResultadoPagos { faltante, vuelto, errores, aplicados }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linea(precio: i64, cantidad: i64, descuento: i64) -> Linea {
        Linea { id: "x".into(), producto_id: None, codigo: None, descripcion: "A".into(), departamento_id: "D".into(), cantidad, precio_unitario: precio, descuento, descuento_catalogo: 0, tasa_iva: 13.0, exento: false }
    }
    fn formas() -> Vec<Forma> {
        vec![
            Forma { id: "EF".into(), nombre: "Efectivo".into(), requiere_banco: false, requiere_referencia: false, da_vuelto: true, pide_ultimos4: false },
            Forma { id: "TJ".into(), nombre: "Tarjeta".into(), requiere_banco: false, requiere_referencia: false, da_vuelto: false, pide_ultimos4: true },
        ]
    }
    fn p(f: &str, m: i64) -> PagoEntrada {
        PagoEntrada { forma_pago_id: f.into(), monto: m, banco_id: None, referencia: None, ultimos4: None }
    }

    #[test]
    fn venta_de_cero_sin_dinero() {
        // Sin pagos: se registra (regalo o descuento total).
        assert!(pagos(0, &[], &formas()).errores.is_empty());
        // Con efectivo "recibido": rechazada (abriría la gaveta sin venta real).
        assert!(pagos(0, &[p("EF", 1000)], &formas()).errores.iter().any(|e| e.contains("¢0")));
        // Tarjeta por el total + efectivo que vuelve entero: no (la gaveta se abriría sin dinero real).
        assert!(pagos(500, &[p("TJ", 500), p("EF", 1000)], &formas()).errores.iter().any(|e| e.contains("quite el efectivo")));
        // Mixto de verdad: sí.
        assert!(pagos(500, &[p("TJ", 300), p("EF", 1000)], &formas()).errores.is_empty());
    }

    #[test]
    fn redondeo_y_totales() {
        assert_eq!([1502, 1503, 1500].map(|x| redondear(x, 5)), [1500, 1505, 1500]);
        let e = Estado { lineas: vec![linea(1001, 2, 0), linea(500, 1, 100)], descuento_total: 200, ..Default::default() };
        let t = totales(&e, 5);
        assert_eq!((t.bruto, t.subtotal, t.descuento, t.total, t.redondeo), (2502, 2402, 200, 2200, -2));
    }

    #[test]
    fn pago_mixto_y_vuelto() {
        let r = pagos(8000, &[p("TJ", 3000), p("EF", 10000)], &formas());
        assert!(r.errores.is_empty() && r.faltante == 0);
        assert_eq!(r.vuelto, 5000);
        assert_eq!(r.aplicados[1].aplicado, 5000);
        assert_eq!(r.aplicados[1].recibido, Some(10000));
        assert!(!pagos(8000, &[p("TJ", 9000)], &formas()).errores.is_empty());
        assert_eq!(pagos(8000, &[p("EF", 5000)], &formas()).faltante, 3000);
    }
}
