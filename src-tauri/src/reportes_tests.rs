// Reportes: suma de reportes = suma de los cierres Z, con reloj fijo. Semana de prueba: lunes 16 …
// lunes 23 de noviembre de 2026 (−06:00); Chaguí: sábado cierra 17:30, domingo no se trabaja.

use super::*;
use crate::caja::{self, abrir, cerrar, Conteo, CAJA_1};
use crate::calculo::{ClienteBasico, Estado, Linea, PagoEntrada};
use crate::cuentas;
use crate::sesion::Actor;
use crate::usuarios::tests::base_con_usuarios;
use crate::util::{fijar_reloj, ulid};
use crate::ventas::{self, anular, cobrar, crear_espera, CambioPago};
use serde_json::Value;

const DEP: &str = "00000000000000000000000D01";
const DEP2: &str = "00000000000000000000000D02";
const EF: &str = "0000000000000000000000FP01";
const TJ: &str = "0000000000000000000000FP02";
const PIN: &str = "246813";

#[test]
fn atajos_de_fechas() {
    let r = rangos_desde(NaiveDate::from_ymd_opt(2026, 11, 19).unwrap()); // jueves
    assert_eq!((r.hoy.as_str(), r.ayer.as_str(), r.semana_desde.as_str()), ("2026-11-19", "2026-11-18", "2026-11-16"));
    assert_eq!((r.mes_desde.as_str(), r.mes_anterior_desde.as_str(), r.mes_anterior_hasta.as_str()), ("2026-11-01", "2026-10-01", "2026-10-31"));
    let r = rangos_desde(NaiveDate::from_ymd_opt(2026, 3, 1).unwrap());
    assert_eq!((r.ayer.as_str(), r.mes_anterior_desde.as_str(), r.mes_anterior_hasta.as_str()), ("2026-02-28", "2026-02-01", "2026-02-28"));
    let d = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
    assert_eq!(periodo_anterior(d("2026-11-01"), d("2026-11-30")), (d("2026-10-01"), d("2026-10-31")));
    assert_eq!(periodo_anterior(d("2026-11-16"), d("2026-11-22")), (d("2026-11-09"), d("2026-11-15")));
    assert_eq!(mismo_periodo_anio_pasado(d("2026-11-19"), d("2026-11-19")), (d("2025-11-19"), d("2025-11-19")));
    assert_eq!(mismo_periodo_anio_pasado(d("2028-02-01"), d("2028-02-29")), (d("2027-02-01"), d("2027-02-28")));
}

fn total(n: i64) -> Conteo {
    Conteo { cantidades: Default::default(), total: Some(n) }
}

async fn producto(p: &SqlitePool, dep: &str, precio: i64) -> String {
    let id = ulid();
    sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(format!("Producto {precio}"))
        .bind(format!("producto {precio} {id}"))
        .bind(dep)
        .bind(precio)
        .execute(p)
        .await
        .unwrap();
    id
}

fn linea(pid: &str, dep: &str, precio: i64, cantidad: i64) -> Linea {
    Linea { id: ulid(), producto_id: Some(pid.into()), codigo: None, descripcion: "x".into(), departamento_id: dep.into(), cantidad, precio_unitario: precio, descuento: 0, descuento_catalogo: 0, tasa_iva: 13.0, exento: false }
}

fn pago(f: &str, m: i64) -> PagoEntrada {
    PagoEntrada { forma_pago_id: f.into(), monto: m, banco_id: None, referencia: None, ultimos4: None, pagador: None }
}

async fn vender(p: &SqlitePool, a: &Actor, lineas: Vec<Linea>, descuento: i64, pagos: &[PagoEntrada]) -> String {
    let e = Estado { lineas, descuento_total: descuento, ..Default::default() };
    let esp = crear_espera(p, a, CAJA_1, &e).await.unwrap();
    cobrar(p, a, CAJA_1, &esp.id, &e, pagos).await.unwrap().venta_id
}

async fn cerrar_exacto(p: &SqlitePool, dueno: &Actor) -> i64 {
    let t: String = sqlx::query_scalar("SELECT id FROM caja_turnos WHERE estado = 'abierto'").fetch_one(p).await.unwrap();
    let mut c = p.acquire().await.unwrap();
    let tt = caja::turno(&mut c, &t).await.unwrap().unwrap();
    let esperado = caja::resumen(&mut c, &tt).await.unwrap().efectivo_esperado;
    drop(c);
    cerrar(p, dueno, CAJA_1, &total(esperado), "").await.unwrap();
    esperado
}

/// Suma de un campo de los Z congelados de los turnos cuyo día de negocio está en el rango.
async fn suma_z(p: &SqlitePool, desde: &str, hasta: &str, campo: &str) -> i64 {
    let ts: Vec<String> = sqlx::query_scalar("SELECT totales FROM caja_turnos WHERE estado = 'cerrado' AND dia BETWEEN ? AND ?").bind(desde).bind(hasta).fetch_all(p).await.unwrap();
    ts.iter().map(|t| serde_json::from_str::<Value>(t).unwrap()[campo].as_i64().unwrap_or(0)).sum()
}

/// Una semana con: varios turnos en un día, anulación en el mismo turno y en otro día, corrección de
/// pago de un turno cerrado, devolución de efectivo, apartados (abono, liquidación, cancelación) y
/// la caja tardía del sábado que cuenta para el lunes. Para cada rango: reporte = suma de los Z.
#[tokio::test]
async fn suma_de_reportes_igual_a_suma_de_cierres_z() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    let a = producto(p, DEP, 1250).await;
    let b = producto(p, DEP2, 3333).await;
    let cliente_id = ulid();
    sqlx::query("INSERT INTO clientes (id, nombre, nombre_busqueda, telefono, consentimiento_datos) VALUES (?, 'Marta', 'marta', '8888', 1)").bind(&cliente_id).execute(p).await.unwrap();
    let cl = ClienteBasico { id: cliente_id, nombre: "Marta".into(), telefono: None, cedula: None };
    let mut caja_ef = 10_000;

    // Lunes 16: dos turnos (cambio de turno a las 14:00).
    fijar_reloj("2026-11-16T09:00:00-06:00");
    abrir(p, &luis, CAJA_1, &total(caja_ef)).await.unwrap();
    vender(p, &luis, vec![linea(&a, DEP, 1250, 3), linea(&b, DEP2, 3333, 1)], 85, &[pago(EF, 10_000)]).await;
    let anulada_mismo = vender(p, &luis, vec![linea(&a, DEP, 1250, 1)], 0, &[pago(EF, 1250)]).await;
    anular(p, &ana, CAJA_1, &anulada_mismo, PIN, "Se equivocó de producto", 0).await.unwrap();
    let anulada_despues = vender(p, &luis, vec![linea(&b, DEP2, 3333, 2)], 0, &[pago(TJ, 6666)]).await;
    let corregida = vender(p, &luis, vec![linea(&a, DEP, 1250, 2)], 0, &[pago(TJ, 2500)]).await;
    let est = Estado { lineas: vec![linea(&b, DEP2, 3333, 3)], cliente: Some(cl.clone()), ..Default::default() };
    let esp = crear_espera(p, &luis, CAJA_1, &est).await.unwrap();
    let ap = cuentas::crear_apartado(p, &luis, CAJA_1, &esp.id, &est, 5000, &[pago(EF, 5000)], &ulid()).await.unwrap();
    caja_ef = cerrar_exacto(p, &ana).await;
    fijar_reloj("2026-11-16T14:00:00-06:00");
    // Cambio de turno antes de la hora de cierre: cuenta para hoy.
    caja::abrir_eligiendo(p, &luis, CAJA_1, &total(caja_ef), Some("hoy")).await.unwrap();
    vender(p, &luis, vec![linea(&a, DEP, 1250, 7)], 0, &[pago(EF, 8750)]).await;
    caja_ef = cerrar_exacto(p, &ana).await;

    // Martes 17: anula la venta del lunes (devuelve con tarjeta, nada de efectivo), corrige el pago
    // de otra, abona y liquida el apartado; cancela otro con devolución en efectivo.
    fijar_reloj("2026-11-17T09:00:00-06:00");
    abrir(p, &luis, CAJA_1, &total(caja_ef)).await.unwrap();
    anular(p, &ana, CAJA_1, &anulada_despues, PIN, "El cliente lo devolvió", 0).await.unwrap();
    let pago_id: String = sqlx::query_scalar("SELECT id FROM venta_pagos WHERE venta_id = ?").bind(&corregida).fetch_one(p).await.unwrap();
    let cambio: CambioPago = CambioPago { forma_pago_id: EF.into(), banco_id: None, referencia: None, ultimos4: None, pagador: None };
    ventas::corregir_pago(p, &ana, CAJA_1, &pago_id, &cambio, "Era efectivo, no tarjeta", Some(PIN)).await.unwrap();
    cuentas::abonar(p, &luis, CAJA_1, &ap.cuenta_id, 4999, &[pago(TJ, 4999)], &ulid(), true).await.unwrap();
    let est2 = Estado { lineas: vec![linea(&a, DEP, 1250, 4)], cliente: Some(cl.clone()), ..Default::default() };
    let esp2 = crear_espera(p, &luis, CAJA_1, &est2).await.unwrap();
    let ap2 = cuentas::crear_apartado(p, &luis, CAJA_1, &esp2.id, &est2, 2500, &[pago(EF, 2500)], &ulid()).await.unwrap();
    cuentas::cancelar(p, &ana, CAJA_1, &ap2.cuenta_id, PIN, "Ya no lo quiere", 2000, 2000).await.unwrap();
    vender(p, &luis, vec![linea(&b, DEP2, 3333, 1)], 0, &[pago(EF, 3335)]).await;
    caja_ef = cerrar_exacto(p, &ana).await;

    // Sábado 21: caja normal y la tardía (después de las 17:30) que cuenta para el lunes 23.
    fijar_reloj("2026-11-21T09:00:00-06:00");
    abrir(p, &luis, CAJA_1, &total(caja_ef)).await.unwrap();
    vender(p, &luis, vec![linea(&a, DEP, 1250, 1)], 0, &[pago(EF, 1250)]).await;
    caja_ef = cerrar_exacto(p, &ana).await;
    fijar_reloj("2026-11-21T17:45:00-06:00");
    abrir(p, &luis, CAJA_1, &total(caja_ef)).await.unwrap();
    vender(p, &luis, vec![linea(&b, DEP2, 3333, 1), linea(&a, DEP, 1250, 1)], 0, &[pago(EF, 5000)]).await;
    fijar_reloj("2026-11-23T10:00:00-06:00");
    vender(p, &luis, vec![linea(&a, DEP, 1250, 2)], 0, &[pago(TJ, 2500)]).await;
    cerrar_exacto(p, &ana).await;

    for (desde, hasta) in [("2026-11-16", "2026-11-16"), ("2026-11-17", "2026-11-17"), ("2026-11-21", "2026-11-21"), ("2026-11-23", "2026-11-23"), ("2026-11-16", "2026-11-23"), ("2026-11-01", "2026-11-30")] {
        let r = ventas(p, &ana, desde, hasta).await.unwrap();
        let t = &r.totales;
        assert!(r.no_coinciden.is_empty(), "{desde}..{hasta}: {:?}", r.no_coinciden);
        assert_eq!(t.ventas, suma_z(p, desde, hasta, "totalVentas").await, "{desde}..{hasta} ventas");
        assert_eq!(t.tiquetes, suma_z(p, desde, hasta, "ventas").await, "{desde}..{hasta} tiquetes");
        assert_eq!(t.abonos, suma_z(p, desde, hasta, "abonosTotal").await, "{desde}..{hasta} abonos");
        assert_eq!(r.por_dia.iter().map(|d| d.ventas).sum::<i64>(), t.ventas);
        assert_eq!(r.por_departamento.iter().map(|d| d.monto).sum::<i64>(), t.ventas, "{desde}..{hasta} departamentos");
        assert_eq!(r.por_producto.iter().map(|d| d.monto).sum::<i64>(), t.ventas);
        assert_eq!(r.por_forma.iter().map(|f| f.ventas).sum::<i64>(), t.ventas, "{desde}..{hasta} formas (con abonos aplicados)");
        assert_eq!(r.por_forma.iter().map(|f| f.abonos).sum::<i64>(), t.abonos);
        assert_eq!(r.por_hora.iter().map(|h| h.monto).sum::<i64>(), t.ventas);
        assert_eq!(r.por_usuario.iter().map(|u| u.monto).sum::<i64>(), t.ventas);
        assert_eq!(t.neto, t.ventas - t.anulaciones_posteriores);
    }
    // La venta anulada el martes sigue en el lunes (como su Z) y se resta el martes.
    let martes = ventas(p, &ana, "2026-11-17", "2026-11-17").await.unwrap();
    assert_eq!(martes.totales.anulaciones_posteriores, 6666);
    assert_eq!(martes.totales.otros_ingresos, 500); // retenido del apartado cancelado
    assert!(martes.anulaciones.iter().any(|x| x.posterior && x.monto == 6666 && x.dia_venta == "2026-11-16"));
    // El lunes tuvo dos turnos; el total del día no suma fondos.
    let lunes = ventas(p, &ana, "2026-11-16", "2026-11-16").await.unwrap();
    assert_eq!(lunes.por_dia[0].turnos, 2);
    // La caja tardía del sábado cuenta para el lunes 23; su venta del sábado sale "después del cierre"
    // con su hora real (17:45), y "por hora" la cuenta a las 17.
    let lunes23 = ventas(p, &ana, "2026-11-23", "2026-11-23").await.unwrap();
    assert_eq!(lunes23.despues_del_cierre.len(), 1);
    assert!(lunes23.por_hora.iter().any(|h| h.hora == 17));
    let sabado = ventas(p, &ana, "2026-11-21", "2026-11-21").await.unwrap();
    assert_eq!(sabado.totales.ventas, 1250);
    // Comparativo: la semana contra la anterior (vacía).
    let semana = ventas(p, &ana, "2026-11-16", "2026-11-22").await.unwrap();
    assert_eq!((semana.anterior_desde.as_str(), semana.anterior.ventas), ("2026-11-09", 0));
}

#[tokio::test]
async fn solo_el_dueno_y_turnos_abiertos_aparte() {
    let (bd, tec, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    fijar_reloj("2026-11-18T09:00:00-06:00");
    assert!(ventas(p, &luis, "2026-11-18", "2026-11-18").await.unwrap_err().contains("permiso"));
    assert!(ventas(p, &tec, "2026-11-18", "2026-11-18").await.unwrap_err().contains("permiso"));
    assert!(rangos(p, &tec).await.is_err());
    let pid = producto(p, DEP, 1000).await;
    abrir(p, &luis, CAJA_1, &total(5000)).await.unwrap();
    vender(p, &luis, vec![linea(&pid, DEP, 1000, 1)], 0, &[pago(EF, 1000)]).await;
    let r = ventas(p, &ana, "2026-11-18", "2026-11-18").await.unwrap();
    assert_eq!((r.totales.ventas, r.en_curso.len(), r.en_curso[0].ventas), (0, 1, 1000));
    assert_eq!(rangos(p, &ana).await.unwrap().hoy, "2026-11-18");
    assert!(ventas(p, &ana, "2026-11-18", "2026-11-01").await.is_err());
}

/// 50.000 ventas en la base; un reporte de un mes (unas 4.000) en menos de 2 s.
#[tokio::test]
async fn reporte_de_un_mes_rapido_con_50000_ventas() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    let mut tx = p.begin().await.unwrap();
    let (sucursal, caja): (String, String) = sqlx::query_as("SELECT sucursal_id, id FROM cajas LIMIT 1").fetch_one(&mut *tx).await.unwrap();
    let pid = ulid();
    sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, 'P', 'p', ?, 1000)").bind(&pid).bind(DEP).execute(&mut *tx).await.unwrap();
    let dia0 = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
    let mut n = 0;
    for d in 0..400 {
        let dia = (dia0 + chrono::Duration::days(d)).to_string();
        let t = ulid();
        sqlx::query("INSERT INTO caja_turnos (id, sucursal_id, caja_id, usuario_apertura_id, abierto_en, monto_inicial, estado, dia) VALUES (?, ?, ?, ?, ?, 0, 'abierto', ?)")
            .bind(&t)
            .bind(&sucursal)
            .bind(&caja)
            .bind(&luis.id)
            .bind(format!("{dia}T15:00:00.000Z"))
            .bind(&dia)
            .execute(&mut *tx)
            .await
            .unwrap();
        for k in 0..125 {
            n += 1;
            let v = ulid();
            let fecha = format!("{dia}T{:02}:{:02}:00.000Z", 14 + k % 10, k % 60);
            sqlx::query("INSERT INTO ventas (id, sucursal_id, caja_id, turno_id, consecutivo, numero, fecha, dia, usuario_id, subtotal, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1000, 1000)")
                .bind(&v)
                .bind(&sucursal)
                .bind(&caja)
                .bind(&t)
                .bind(n)
                .bind(n.to_string())
                .bind(&fecha)
                .bind(&dia)
                .bind(&luis.id)
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query("INSERT INTO venta_lineas (id, venta_id, producto_id, descripcion, departamento_id, cantidad, precio_unitario, total) VALUES (?, ?, ?, 'P', ?, 1, 1000, 1000)")
                .bind(ulid())
                .bind(&v)
                .bind(&pid)
                .bind(DEP)
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query("INSERT INTO venta_pagos (id, venta_id, forma_pago_id, monto) VALUES (?, ?, ?, 1000)").bind(ulid()).bind(&v).bind(EF).execute(&mut *tx).await.unwrap();
        }
        sqlx::query("UPDATE caja_turnos SET estado = 'cerrado', cerrado_en = ? WHERE id = ?").bind(format!("{dia}T23:00:00.000Z")).bind(&t).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    assert_eq!(n, 50_000);
    let ini = std::time::Instant::now();
    let r = ventas(p, &ana, "2025-06-01", "2025-06-30").await.unwrap();
    let ms = ini.elapsed().as_millis();
    assert_eq!(r.totales.tiquetes, 30 * 125);
    assert!(ms < 2000, "reporte de un mes: {ms} ms");
}
