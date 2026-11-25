// Pruebas basadas en propiedades (proptest): cientos de casos al azar por propiedad. Si una falla,
// proptest reduce el caso al más chico que la rompe y lo imprime.

use crate::acciones::{AlPasar, Limites, Nivel, Politica, CATALOGO};
use crate::calculo::{pagos, totales, Estado, Forma, Linea, PagoEntrada};
use crate::caja::{siguiente_laborable, Horario};
use crate::cuentas::{abono_minimo, fecha_limite, validar_abono};
use crate::desglose::{armar, repartir};
use crate::permisos::Rol;
use crate::politica::{efectiva, mas_permisivo, plantilla_normal, politica_mas_permisiva, Datos};
use chrono::{Datelike, NaiveDate};
use proptest::prelude::*;
use std::collections::BTreeMap;

fn linea(precio: i64, cantidad: i64, descuento: i64) -> Linea {
    Linea { id: "x".into(), producto_id: None, codigo: None, descripcion: "A".into(), departamento_id: "D".into(), cantidad, precio_unitario: precio, descuento, descuento_catalogo: 0, tasa_iva: 13.0, exento: false }
}

fn una_linea() -> impl Strategy<Value = Linea> {
    (0i64..=200_000, 1i64..=50, 0u32..=100).prop_map(|(p, c, pct)| {
        let b = p * c;
        linea(p, c, b * i64::from(pct) / 100)
    })
}

const PASOS: [i64; 6] = [1, 5, 10, 25, 50, 100];

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, .. ProptestConfig::default() })]

    /// Totales: nunca negativos, el descuento no pasa del subtotal y el redondeo es al paso más cercano.
    #[test]
    fn totales_de_venta(lineas in prop::collection::vec(una_linea(), 0..15), desc in 0i64..=5_000_000, ip in 0usize..6) {
        let paso = PASOS[ip];
        let e = Estado { lineas, descuento_total: desc, ..Default::default() };
        let t = totales(&e, paso);
        prop_assert!(t.total >= 0);
        prop_assert!(t.descuento >= 0 && t.descuento <= t.subtotal.max(0));
        prop_assert_eq!(t.subtotal, t.bruto - t.descuento_lineas);
        let neto = t.subtotal - t.descuento;
        prop_assert_eq!(t.redondeo, t.total - neto);
        if paso > 1 {
            prop_assert_eq!(t.total % paso, 0);
            prop_assert!(2 * t.redondeo.abs() <= paso, "redondeo {} con paso {}", t.redondeo, paso);
        } else {
            prop_assert_eq!(t.total, neto);
        }
        prop_assert!((0.0..=100.0 + 1e-9).contains(&t.pct_descuento));
        prop_assert!(t.iva >= 0 && t.iva <= t.total.max(neto));
    }

    /// Pago mixto: si se acepta, cubre el total exacto; el vuelto sale solo del efectivo, nunca
    /// negativo ni mayor que el efectivo recibido.
    #[test]
    fn pago_mixto_y_vuelto(total in 0i64..=500_000, ef in prop::collection::vec(1i64..=600_000, 0..3), tj in prop::collection::vec(1i64..=600_000, 0..3)) {
        let formas = vec![
            Forma { id: "EF".into(), nombre: "Efectivo".into(), requiere_banco: false, requiere_referencia: false, da_vuelto: true, pide_ultimos4: false, pide_pagador: false },
            Forma { id: "TJ".into(), nombre: "Tarjeta".into(), requiere_banco: false, requiere_referencia: false, da_vuelto: false, pide_ultimos4: false, pide_pagador: false },
        ];
        let p = |f: &str, m: i64| PagoEntrada { forma_pago_id: f.into(), monto: m, banco_id: None, referencia: None, ultimos4: None, pagador: None };
        let entradas: Vec<PagoEntrada> = tj.iter().map(|m| p("TJ", *m)).chain(ef.iter().map(|m| p("EF", *m))).collect();
        let r = pagos(total, &entradas, &formas);
        let recibido_ef: i64 = ef.iter().sum();
        prop_assert!(r.vuelto >= 0);
        if r.errores.is_empty() && r.faltante == 0 {
            let aplicado: i64 = r.aplicados.iter().map(|a| a.aplicado).sum();
            prop_assert_eq!(aplicado, total);
            prop_assert!(r.vuelto <= recibido_ef);
            for a in &r.aplicados {
                let v = a.vuelto.unwrap_or(0);
                prop_assert!(v >= 0 && v <= a.recibido.unwrap_or(0));
                prop_assert!(a.aplicado > 0);
            }
            // Tarjeta nunca da vuelto.
            prop_assert!(r.aplicados.iter().filter(|a| a.pago.forma_pago_id == "TJ").all(|a| a.vuelto.is_none()));
        }
        // Tarjeta por más del total: siempre se rechaza.
        if tj.iter().sum::<i64>() > total {
            prop_assert!(!r.errores.is_empty());
        }
    }

    /// Reparto entero proporcional: suma exacta y cada parte a menos de 1 colón de su parte exacta.
    #[test]
    fn reparto_exacto(total in -1_000_000i64..=10_000_000, pesos in prop::collection::vec(0i64..=1_000_000, 1..12)) {
        let partes = repartir(total, &pesos);
        prop_assert_eq!(partes.len(), pesos.len());
        prop_assert_eq!(partes.iter().sum::<i64>(), total);
        let suma: i64 = pesos.iter().sum();
        if suma > 0 {
            for (p, w) in partes.iter().zip(&pesos) {
                let exacta = (*w as f64) * (total as f64) / (suma as f64);
                prop_assert!((*p as f64 - exacta).abs() < 1.0 + 1e-6, "parte {} exacta {}", p, exacta);
            }
        }
    }

    /// Z por departamento: con pagos que suman el total de cada venta, los departamentos, el detalle
    /// y las formas de pago suman exactamente lo vendido, y no hay ventas descuadradas.
    #[test]
    fn z_por_departamento_cuadra(ventas in prop::collection::vec((prop::collection::vec((0usize..4, 1i64..=20, 0i64..=50_000), 1..6), prop::collection::vec((0usize..3, 1i64..=100), 1..4)), 1..15)) {
        let deps = ["D1", "D2", "D3", "D4"];
        let formas = [("Efectivo", true), ("Tarjeta", false), ("SINPE", false)];
        let (mut vs, mut ls, mut ps) = (vec![], vec![], vec![]);
        for (n, (lineas, pesos_pago)) in ventas.iter().enumerate() {
            let id = format!("V{n}");
            let mut total = 0;
            for (d, c, precio) in lineas {
                let importe = c * precio;
                total += importe;
                ls.push(crate::desglose::Linea { venta_id: id.clone(), producto: format!("P{d}"), clave: format!("P{d}"), departamento_id: deps[*d].into(), departamento: deps[*d].into(), orden_departamento: *d as i64, cantidad: *c, precio: *precio, importe });
            }
            let montos = repartir(total, &pesos_pago.iter().map(|(_, w)| *w).collect::<Vec<_>>());
            for (j, ((f, _), m)) in pesos_pago.iter().zip(montos).enumerate() {
                ps.push(crate::desglose::Pago { venta_id: id.clone(), forma: formas[*f].0.into(), tipo: formas[*f].0.to_lowercase(), orden: *f as i64, da_vuelto: formas[*f].1, monto: m });
                let _ = j;
            }
            vs.push(crate::desglose::Venta { id, numero: format!("{n}"), total });
        }
        let total: i64 = vs.iter().map(|v| v.total).sum();
        let d = armar(&vs, &ls, &ps);
        prop_assert!(d.ventas_descuadradas.is_empty(), "{:?}", d.ventas_descuadradas);
        prop_assert_eq!(d.total, total);
        prop_assert_eq!(d.departamentos.iter().map(|x| x.monto).sum::<i64>(), total);
        for x in &d.departamentos {
            prop_assert_eq!(x.filas.iter().map(|f| f.monto).sum::<i64>(), x.monto);
            prop_assert_eq!(x.por_forma.iter().map(|f| f.monto).sum::<i64>(), x.monto);
        }
        let efectivo: i64 = ps.iter().filter(|p| p.da_vuelto).map(|p| p.monto).sum();
        prop_assert_eq!(d.efectivo, efectivo);
    }

    /// Abonos: el mínimo es el % redondeado hacia arriba (nunca más del total); un abono válido no
    /// deja saldo negativo.
    #[test]
    fn abonos_y_saldos(total in 0i64..=10_000_000, pct in 0i64..=150, saldo in 0i64..=10_000_000, monto in -10i64..=10_000_010) {
        let m = abono_minimo(total, pct);
        prop_assert!(m >= 0 && m <= total);
        if total > 0 && pct > 0 {
            prop_assert!(m * 100 >= total * pct.min(100));
            prop_assert!((m - 1) * 100 < total * pct.min(100));
        }
        if validar_abono(saldo, monto, None).is_ok() {
            prop_assert!(monto > 0 && saldo - monto >= 0);
        }
    }

    /// Días laborables: el siguiente laborable es posterior, laborable y no salta ninguno; la fecha
    /// límite «laborables» cuenta exactamente esos días.
    #[test]
    fn fechas_con_dias_laborables(dias_trabajo in prop::collection::vec(any::<bool>(), 7), anio in 2024i32..2030, dia_del_anio in 1u32..=365, n in 1i64..=60) {
        let h: Horario = std::array::from_fn(|i| dias_trabajo[i].then_some(1080));
        prop_assume!(h.iter().any(|x| x.is_some()));
        let lab = |d: NaiveDate| h[d.weekday().num_days_from_monday() as usize].is_some();
        let desde = NaiveDate::from_yo_opt(anio, dia_del_anio).unwrap_or(NaiveDate::MIN);
        prop_assume!(desde != NaiveDate::MIN);
        let s = siguiente_laborable(desde, &h);
        prop_assert!(s > desde && lab(s));
        let mut d = desde.succ_opt().unwrap();
        while d < s {
            prop_assert!(!lab(d));
            d = d.succ_opt().unwrap();
        }
        let f = fecha_limite(desde, n, "laborables", &h);
        let mut cuenta = 0;
        let mut d = desde.succ_opt().unwrap();
        while d <= f {
            if lab(d) { cuenta += 1; }
            d = d.succ_opt().unwrap();
        }
        prop_assert_eq!(cuenta, n);
        prop_assert!(lab(f));
        let c = fecha_limite(desde, n, "calendario", &h);
        prop_assert!(c >= desde + chrono::Duration::days(n) && lab(c));
    }

    /// Política efectiva: reglas fijas siempre; la excepción gana solo para su usuario y su acción;
    /// lo desconocido se niega.
    #[test]
    fn politica_efectiva(cambios in prop::collection::vec((0usize..CATALOGO.len(), 0u8..4, any::<bool>()), 0..30), excepciones in prop::collection::vec((0usize..CATALOGO.len(), 0u8..4), 0..10)) {
        let nivel = |k: u8| [Nivel::No, Nivel::Pin, Nivel::Motivo, Nivel::Si][k as usize];
        let mut d: Datos = plantilla_normal();
        for (i, k, tecnico) in &cambios {
            let fila = if *tecnico { &mut d.tecnico } else { &mut d.cajero };
            fila.insert(CATALOGO[*i].id.into(), Politica { nivel: nivel(*k), ..Politica::NO });
        }
        let mut ex = BTreeMap::new();
        for (i, k) in &excepciones {
            ex.insert(CATALOGO[*i].id.to_string(), Politica { nivel: nivel(*k), ..Politica::NO });
        }
        d.usuarios.insert("fab".into(), ex.clone());
        for a in CATALOGO {
            let t = efectiva(&d, "t", Rol::Tecnico, a.id);
            if a.protegida { prop_assert_eq!(t.nivel, Nivel::No, "{}", a.id); }
            if a.no_delegable {
                prop_assert_eq!(efectiva(&d, "fab", Rol::Cajero, a.id).nivel, Nivel::No);
                prop_assert_eq!(t, a.normal_tecnico);
            }
            let otro = efectiva(&d, "ana", Rol::Cajero, a.id);
            let fab = efectiva(&d, "fab", Rol::Cajero, a.id);
            if !a.no_delegable {
                // Lo configurado, bajado al nivel más estricto que la acción aplica (D4); nunca más permiso.
                let conf = d.cajero.get(a.id).copied().unwrap_or(Politica::NO);
                prop_assert_eq!(otro, a.ajustar(conf));
                prop_assert!(otro.nivel <= conf.nivel);
                prop_assert!(a.admite(&otro).is_ok());
                prop_assert_eq!(fab, a.ajustar(ex.get(a.id).copied().unwrap_or(conf)));
            }
            // La fila del dueño no depende de lo que se configure (salvo el tope del negocio, y con su
            // PIN siempre puede: A6).
            let du = efectiva(&d, "x", Rol::Dueno, a.id);
            if a.dueno_sigue_cajero { prop_assert!(du.nivel >= Nivel::Pin && du.limites.al_pasar == AlPasar::Pin); } else { prop_assert_eq!(du, a.dueno); }
        }
        prop_assert_eq!(efectiva(&d, "fab", Rol::Cajero, "accion.que.no.existe").nivel, Nivel::No);
    }

    /// «Da más permiso» (pide PIN del dueño): aflojar nunca pasa sin PIN y nada es más permisivo que sí mismo.
    #[test]
    fn mas_permisivo_detecta_aflojar(i in 0usize..CATALOGO.len(), a in 0u8..4, b in 0u8..4, m1 in proptest::option::of(0i64..100_000), m2 in proptest::option::of(0i64..100_000)) {
        let nivel = |k: u8| [Nivel::No, Nivel::Pin, Nivel::Motivo, Nivel::Si][k as usize];
        let lim = |m: Option<i64>| Limites { monto_max: m, al_pasar: AlPasar::Pin, ..Limites::NINGUNO };
        let p1 = Politica { nivel: nivel(a), motivo: false, limites: lim(m1) };
        let p2 = Politica { nivel: nivel(b), motivo: false, limites: lim(m2) };
        prop_assert!(!politica_mas_permisiva(&p1, &p1));
        if nivel(b) > nivel(a) { prop_assert!(politica_mas_permisiva(&p1, &p2)); }
        if nivel(b) < nivel(a) { prop_assert!(!politica_mas_permisiva(&p1, &p2)); }
        let acc = &CATALOGO[i];
        let mut v = plantilla_normal();
        let mut n = v.clone();
        v.cajero.insert(acc.id.into(), p1);
        n.cajero.insert(acc.id.into(), p2);
        let mas = mas_permisivo(&v, &n);
        if acc.sensible && politica_mas_permisiva(&p1, &p2) && !acc.no_delegable {
            prop_assert!(mas.iter().any(|x| x.starts_with(acc.id)), "{} {:?} → {:?}", acc.id, p1, p2);
        }
        prop_assert!(mas_permisivo(&v, &v).is_empty());
    }
}
