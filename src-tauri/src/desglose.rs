// Desglose del cierre Z: ventas por departamento y por producto, con su forma de pago y la parte
// en efectivo. Todo en colones enteros y con reparto exacto, para que los totales por departamento
// y el detalle sumen EXACTAMENTE el total general (y el efectivo, el efectivo cobrado).
//
// Por cada venta:
//  1. El total (ya con descuento al total y redondeo) se reparte entre sus líneas en proporción a
//     su importe (método del mayor resto): la suma de las líneas es el total de la venta.
//  2. Cada pago se reparte entre las líneas en proporción a lo que a cada línea le falta cubrir;
//     el último toma el resto. Así cada línea queda cubierta exacto y cada pago también.
// Una venta pagada con una sola forma lleva su código (Co, Ta, De…); con varias, "Mx" (mixto), y la
// columna de efectivo dice cuánto de esa línea entró en efectivo.

use crate::util::{e, Res};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeMap;

/// Reparte `total` en partes enteras proporcionales a `pesos` (≥ 0) que suman exactamente `total`.
pub fn repartir(total: i64, pesos: &[i64]) -> Vec<i64> {
    let n = pesos.len();
    if n == 0 {
        return Vec::new();
    }
    let suma: i64 = pesos.iter().map(|p| (*p).max(0)).sum();
    if suma == 0 {
        let mut v = vec![0; n];
        v[0] = total;
        return v;
    }
    // peso × total en i128: en i64 se desborda con montos de miles de millones y, en la versión
    // final, da la vuelta sin avisar (el reparto saldría mal en vez de fallar).
    let prod = |p: i64| (p.max(0) as i128) * (total as i128);
    let mut partes: Vec<i64> = pesos.iter().map(|&p| prod(p).div_euclid(suma as i128) as i64).collect();
    let mut resto = total - partes.iter().sum::<i64>();
    // Mayor resto primero (a igual resto, la primera línea).
    let mut orden: Vec<usize> = (0..n).collect();
    orden.sort_by_key(|&i| std::cmp::Reverse(prod(pesos[i]).rem_euclid(suma as i128)));
    let mut k = 0;
    while resto > 0 {
        partes[orden[k % n]] += 1;
        resto -= 1;
        k += 1;
    }
    partes
}

/// Código corto de la forma de pago, como en el cierre del sistema anterior.
pub fn codigo_corto(tipo: &str, nombre: &str) -> String {
    match tipo {
        "efectivo" => "Co".into(),
        "tarjeta" => "Ta".into(),
        "sinpe" | "transferencia" => "De".into(),
        _ => {
            let mut c = nombre.chars().filter(|c| c.is_alphanumeric());
            let a: String = c.next().map(|x| x.to_uppercase().collect()).unwrap_or_else(|| "O".into());
            let b: String = c.next().map(|x| x.to_lowercase().collect()).unwrap_or_default();
            a + &b
        }
    }
}

pub const MIXTO: &str = "Mx";

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FormaMonto {
    pub forma: String,
    pub codigo: String,
    pub monto: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Fila {
    /// Co, Ta, De… o Mx (venta con varias formas de pago).
    pub codigo: String,
    pub producto: String,
    pub cantidad: i64,
    pub precio: i64,
    pub monto: i64,
    pub efectivo: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Departamento {
    pub departamento_id: String,
    pub nombre: String,
    pub cantidad: i64,
    pub monto: i64,
    pub efectivo: i64,
    pub por_forma: Vec<FormaMonto>,
    pub filas: Vec<Fila>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Desglose {
    pub departamentos: Vec<Departamento>,
    pub cantidad: i64,
    pub total: i64,
    pub efectivo: i64,
    /// Ventas cuyos pagos no suman su total (no debería pasar nunca; si pasa, el Z no se imprime).
    pub ventas_descuadradas: Vec<String>,
}

pub struct Linea {
    pub venta_id: String,
    pub producto: String,
    pub clave: String,
    pub departamento_id: String,
    pub departamento: String,
    pub orden_departamento: i64,
    pub cantidad: i64,
    pub precio: i64,
    pub importe: i64,
}

pub struct Pago {
    pub venta_id: String,
    pub forma: String,
    pub tipo: String,
    pub orden: i64,
    pub da_vuelto: bool,
    pub monto: i64,
}

pub struct Venta {
    pub id: String,
    pub numero: String,
    pub total: i64,
}

/// Arma el desglose (función pura: se prueba sin base).
pub fn armar(ventas: &[Venta], lineas: &[Linea], pagos: &[Pago]) -> Desglose {
    // Clave de departamento: (orden, nombre, id) para que salgan en el orden configurado.
    type ClaveDep = (i64, String, String);
    type ClaveFila = (String, i64, String); // producto, precio, código
    type Acumulado = (Departamento, BTreeMap<ClaveFila, Fila>, BTreeMap<(i64, String), FormaMonto>);
    let mut deps: BTreeMap<ClaveDep, Acumulado> = BTreeMap::new();
    let mut out = Desglose::default();
    for v in ventas {
        let ls: Vec<&Linea> = lineas.iter().filter(|l| l.venta_id == v.id).collect();
        let mut ps: Vec<&Pago> = pagos.iter().filter(|p| p.venta_id == v.id && p.monto > 0).collect();
        // El efectivo al final: recibe los restos del reparto.
        ps.sort_by_key(|p| p.da_vuelto);
        if ls.is_empty() {
            continue;
        }
        if ps.iter().map(|p| p.monto).sum::<i64>() != v.total {
            out.ventas_descuadradas.push(v.numero.clone());
        }
        let neto = repartir(v.total, &ls.iter().map(|l| l.importe).collect::<Vec<_>>());
        // Matriz línea × pago.
        let mut falta = neto.clone();
        let mut matriz = vec![vec![0i64; ps.len()]; ls.len()];
        for (j, p) in ps.iter().enumerate() {
            let parte = if j + 1 == ps.len() { falta.clone() } else { repartir(p.monto, &falta) };
            for i in 0..ls.len() {
                matriz[i][j] = parte[i];
                falta[i] -= parte[i];
            }
        }
        let mut formas_distintas: Vec<&str> = ps.iter().map(|p| p.forma.as_str()).collect();
        formas_distintas.sort();
        formas_distintas.dedup();
        let codigo_venta = match (formas_distintas.len(), ps.first()) {
            (1, Some(p)) => codigo_corto(&p.tipo, &p.forma),
            (0, _) => "--".into(),
            _ => MIXTO.into(),
        };
        for (i, l) in ls.iter().enumerate() {
            let efectivo: i64 = ps.iter().enumerate().filter(|(_, p)| p.da_vuelto).map(|(j, _)| matriz[i][j]).sum();
            let (d, filas, formas) = deps.entry((l.orden_departamento, l.departamento.clone(), l.departamento_id.clone())).or_insert_with(|| {
                (Departamento { departamento_id: l.departamento_id.clone(), nombre: l.departamento.clone(), ..Default::default() }, BTreeMap::new(), BTreeMap::new())
            });
            d.cantidad += l.cantidad;
            d.monto += neto[i];
            d.efectivo += efectivo;
            let f = filas.entry((l.clave.clone(), l.precio, codigo_venta.clone())).or_insert_with(|| Fila { codigo: codigo_venta.clone(), producto: l.producto.clone(), precio: l.precio, ..Default::default() });
            f.cantidad += l.cantidad;
            f.monto += neto[i];
            f.efectivo += efectivo;
            for (j, p) in ps.iter().enumerate() {
                let fm = formas.entry((p.orden, p.forma.clone())).or_insert_with(|| FormaMonto { forma: p.forma.clone(), codigo: codigo_corto(&p.tipo, &p.forma), monto: 0 });
                fm.monto += matriz[i][j];
            }
            out.cantidad += l.cantidad;
            out.total += neto[i];
            out.efectivo += efectivo;
        }
    }
    for (_, (mut d, filas, formas)) in deps {
        let mut f: Vec<Fila> = filas.into_values().collect();
        f.sort_by(|a, b| a.producto.to_lowercase().cmp(&b.producto.to_lowercase()).then(a.precio.cmp(&b.precio)).then(a.codigo.cmp(&b.codigo)));
        d.filas = f;
        d.por_forma = formas.into_values().filter(|x| x.monto != 0).collect();
        out.departamentos.push(d);
    }
    out
}

/// Desglose de las ventas completadas de un turno.
pub async fn calcular(c: &mut SqliteConnection, turno_id: &str) -> Res<Desglose> {
    let ventas: Vec<Venta> = sqlx::query("SELECT id, numero, total FROM ventas WHERE turno_id = ? AND estado = 'completada' AND eliminado_en IS NULL ORDER BY consecutivo")
        .bind(turno_id)
        .fetch_all(&mut *c)
        .await
        .map_err(e)?
        .iter()
        .map(|f| Venta { id: f.get("id"), numero: f.get("numero"), total: f.get("total") })
        .collect();
    let lineas: Vec<Linea> = sqlx::query(
        "SELECT l.venta_id, l.producto_id, l.descripcion, l.departamento_id, d.nombre AS dep, d.orden AS dep_orden, l.cantidad, l.precio_unitario, l.total
         FROM venta_lineas l JOIN ventas v ON v.id = l.venta_id JOIN departamentos d ON d.id = l.departamento_id
         WHERE v.turno_id = ? AND v.estado = 'completada' AND v.eliminado_en IS NULL AND l.eliminado_en IS NULL ORDER BY v.consecutivo, l.orden",
    )
    .bind(turno_id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    .iter()
    .map(|f| {
        let producto: String = f.get("descripcion");
        Linea {
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
    let pagos: Vec<Pago> = sqlx::query(
        "SELECT p.venta_id, f.nombre, f.tipo, f.orden, f.da_vuelto, p.monto FROM venta_pagos p
         JOIN ventas v ON v.id = p.venta_id JOIN formas_pago f ON f.id = p.forma_pago_id
         WHERE v.turno_id = ? AND v.estado = 'completada' AND v.eliminado_en IS NULL AND p.eliminado_en IS NULL ORDER BY v.consecutivo, p.creado_en, p.id",
    )
    .bind(turno_id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?
    .iter()
    .map(|f| Pago { venta_id: f.get("venta_id"), forma: f.get("nombre"), tipo: f.get("tipo"), orden: f.get("orden"), da_vuelto: f.get::<i64, _>("da_vuelto") == 1, monto: f.get("monto") })
    .collect();
    Ok(armar(&ventas, &lineas, &pagos))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repartir_montos_enormes_sin_desbordar() {
        let total = 5_000_000_000_000; // ¢5 billones: peso × total pasa de i64
        let p = repartir(total, &[3_000_000_000_000, 2_000_000_000_000]);
        assert_eq!(p, vec![3_000_000_000_000, 2_000_000_000_000]);
        assert_eq!(repartir(10, &[1, 1, 1]).iter().sum::<i64>(), 10);
    }

    #[test]
    fn repartir_suma_exacto() {
        assert_eq!(repartir(100, &[1, 1, 1]), vec![34, 33, 33]);
        assert_eq!(repartir(1000, &[0, 0]), vec![1000, 0]);
        assert_eq!(repartir(0, &[5, 7]), vec![0, 0]);
        for (t, p) in [(9995, vec![3333, 3333, 3334]), (7, vec![1, 2, 3, 4]), (1_000_003, vec![17, 1, 999])] {
            let r = repartir(t, &p);
            assert_eq!(r.iter().sum::<i64>(), t);
            assert!(r.iter().all(|x| *x >= 0));
        }
    }

    fn l(v: &str, prod: &str, dep: &str, ord: i64, cant: i64, precio: i64, importe: i64) -> Linea {
        Linea { venta_id: v.into(), producto: prod.into(), clave: prod.into(), departamento_id: dep.into(), departamento: dep.into(), orden_departamento: ord, cantidad: cant, precio, importe }
    }
    fn p(v: &str, forma: &str, tipo: &str, efectivo: bool, monto: i64) -> Pago {
        Pago { venta_id: v.into(), forma: forma.into(), tipo: tipo.into(), orden: if efectivo { 1 } else { 2 }, da_vuelto: efectivo, monto }
    }

    #[test]
    fn departamentos_y_detalle_suman_el_total() {
        // V1: 42 impresiones a ¢200 por SINPE. V2: lo mismo pero 1 en efectivo (se agrupa aparte).
        // V3: cuaderno + 3 impresiones con descuento al total y redondeo, pagado mitad tarjeta, mitad efectivo.
        let ventas = vec![Venta { id: "V1".into(), numero: "1".into(), total: 8400 }, Venta { id: "V2".into(), numero: "2".into(), total: 200 }, Venta { id: "V3".into(), numero: "3".into(), total: 1995 }];
        let lineas = vec![
            l("V1", "IMPRESIONES A COLOR", "Fotocopias", 7, 42, 200, 8400),
            l("V2", "IMPRESIONES A COLOR", "Fotocopias", 7, 1, 200, 200),
            l("V3", "Cuaderno", "Librería", 1, 1, 1500, 1500),
            l("V3", "IMPRESIONES A COLOR", "Fotocopias", 7, 3, 200, 600),
        ];
        let pagos = vec![p("V1", "SINPE Móvil", "sinpe", false, 8400), p("V2", "Efectivo", "efectivo", true, 200), p("V3", "Tarjeta", "tarjeta", false, 1000), p("V3", "Efectivo", "efectivo", true, 995)];
        let d = armar(&ventas, &lineas, &pagos);
        assert!(d.ventas_descuadradas.is_empty());
        assert_eq!(d.total, 8400 + 200 + 1995);
        assert_eq!(d.efectivo, 200 + 995);
        assert_eq!(d.departamentos.iter().map(|x| x.monto).sum::<i64>(), d.total);
        assert_eq!(d.departamentos.iter().flat_map(|x| &x.filas).map(|f| f.monto).sum::<i64>(), d.total);
        assert_eq!(d.departamentos.iter().flat_map(|x| &x.filas).map(|f| f.efectivo).sum::<i64>(), d.efectivo);
        for dep in &d.departamentos {
            assert_eq!(dep.por_forma.iter().map(|f| f.monto).sum::<i64>(), dep.monto);
            assert_eq!(dep.filas.iter().map(|f| f.monto).sum::<i64>(), dep.monto);
        }
        // Librería va primero (orden 1). Fotocopias: SINPE x42, efectivo x1, mixto x3.
        assert_eq!(d.departamentos[0].nombre, "Librería");
        let foto = &d.departamentos[1];
        let fila = |c: &str| foto.filas.iter().find(|f| f.codigo == c).unwrap().clone();
        assert_eq!((fila("De").cantidad, fila("De").monto, fila("De").efectivo), (42, 8400, 0));
        assert_eq!((fila("Co").cantidad, fila("Co").efectivo), (1, 200));
        assert_eq!(fila("Mx").cantidad, 3);
        assert_eq!(foto.cantidad, 46);
    }

    #[test]
    fn pagos_que_no_suman_se_marcan() {
        let d = armar(&[Venta { id: "V".into(), numero: "9".into(), total: 500 }], &[l("V", "A", "D", 1, 1, 500, 500)], &[p("V", "Efectivo", "efectivo", true, 400)]);
        assert_eq!(d.ventas_descuadradas, vec!["9".to_string()]);
    }
}
