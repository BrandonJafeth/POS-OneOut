// Pruebas de apartados y crédito. Todas fijan el reloj (semana de prueba: lunes 16 … lunes 23 de
// noviembre de 2026, −06:00) y no dependen de la hora a la que se corren.

use super::*;
use crate::caja::{abrir, cerrar, datos_z, tests::conteo, CAJA_1};
use crate::calculo::{Estado, Linea, PagoEntrada};
use crate::permisos::Rol;
use crate::sesion::Actor;
use crate::usuarios::tests::base_con_usuarios;
use crate::util::{fijar_reloj, ulid};
use crate::ventas::{cobrar, cobrar_con, crear_espera};
use serde_json::{json, Value};
use sqlx::SqlitePool;

const DEP: &str = "00000000000000000000000D01";
const EF: &str = "0000000000000000000000FP01";
const TJ: &str = "0000000000000000000000FP02";
const PIN: &str = "246813";

// ─────────── Reglas puras: los mismos casos que tests/cuentas.test.ts ───────────

fn casos() -> Value {
    serde_json::from_str(include_str!("../../tests/casos/cuentas.json")).unwrap()
}

#[test]
fn reglas_iguales_que_en_la_pantalla() {
    let c = casos();
    let h = caja::leer_horario(Some(&c["horario"]));
    for x in c["abonoMinimo"].as_array().unwrap() {
        assert_eq!(abono_minimo(x["total"].as_i64().unwrap(), x["pct"].as_i64().unwrap()), x["esperado"].as_i64().unwrap(), "{x}");
    }
    for x in c["fechaLimite"].as_array().unwrap() {
        let desde = NaiveDate::parse_from_str(x["desde"].as_str().unwrap(), "%Y-%m-%d").unwrap();
        let r = fecha_limite(desde, x["dias"].as_i64().unwrap(), x["tipo"].as_str().unwrap(), &h);
        assert_eq!(r.to_string(), x["esperado"].as_str().unwrap(), "{x}");
    }
    for x in c["validarAbono"].as_array().unwrap() {
        let r = validar_abono(x["saldo"].as_i64().unwrap(), x["monto"].as_i64().unwrap(), x["minimo"].as_i64());
        assert_eq!(r.is_ok(), x["ok"].as_bool().unwrap(), "{x}");
    }
    for x in c["creditoAlcanza"].as_array().unwrap() {
        assert_eq!(credito_alcanza(x["limite"].as_i64().unwrap(), x["saldo"].as_i64().unwrap(), x["nuevo"].as_i64().unwrap()), x["ok"].as_bool().unwrap(), "{x}");
    }
    for x in c["creditoDisponible"].as_array().unwrap() {
        assert_eq!(credito_disponible(x["limite"].as_i64().unwrap(), x["saldo"].as_i64().unwrap()), x["esperado"].as_i64().unwrap(), "{x}");
    }
}

// ─────────── Ayudas ───────────

fn reloj(iso: &str) {
    fijar_reloj(iso);
}

async fn producto(p: &SqlitePool, precio: i64, existencia: i64) -> String {
    let id = ulid();
    sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio, controla_inventario) VALUES (?, ?, ?, ?, ?, 1)")
        .bind(&id)
        .bind(format!("Retablo {precio}"))
        .bind(format!("retablo {precio} {id}"))
        .bind(DEP)
        .bind(precio)
        .execute(p)
        .await
        .unwrap();
    // Un producto nuevo empieza sin control (migración 12); estos sí controlan inventario.
    sqlx::query("UPDATE productos SET controla_inventario = 1 WHERE id = ?").bind(&id).execute(p).await.unwrap();
    if existencia > 0 {
        let mut c = p.acquire().await.unwrap();
        let sucursal = inventario::sucursal_de(&mut c, CAJA_1).await.unwrap();
        let tec: String = sqlx::query_scalar("SELECT id FROM usuarios LIMIT 1").fetch_one(&mut *c).await.unwrap();
        inventario::mover(
            &mut c,
            &inventario::Mov { producto_id: &id, sucursal_id: &sucursal, tipo: "inicial", cantidad: existencia, costo: None, motivo: "", ref_tipo: None, ref_id: None, usuario_id: &tec, turno_id: None, fecha: &ahora_iso() },
        )
        .await
        .unwrap();
    }
    id
}

async fn cliente(p: &SqlitePool) -> calculo::ClienteBasico {
    let id = ulid();
    sqlx::query("INSERT INTO clientes (id, nombre, nombre_busqueda, telefono, consentimiento_datos, consentimiento_fecha, consentimiento_version) VALUES (?, 'Marta Solís', 'marta solis', '88887777', 1, '2026-11-01', '1')")
        .bind(&id)
        .execute(p)
        .await
        .unwrap();
    calculo::ClienteBasico { id, nombre: "Marta Solís".into(), telefono: Some("88887777".into()), cedula: None }
}

fn linea(pid: &str, precio: i64, cantidad: i64) -> Linea {
    Linea { id: ulid(), producto_id: Some(pid.into()), codigo: None, descripcion: "x".into(), departamento_id: DEP.into(), cantidad, precio_unitario: precio, descuento: 0, descuento_catalogo: 0, tasa_iva: 13.0, exento: false }
}

fn pago(f: &str, m: i64) -> PagoEntrada {
    PagoEntrada { forma_pago_id: f.into(), monto: m, banco_id: None, referencia: None, ultimos4: None, pagador: None }
}

/// Aparta `cantidad` del producto con un abono en efectivo. Devuelve el resultado.
async fn apartar(p: &SqlitePool, a: &Actor, cl: &calculo::ClienteBasico, pid: &str, precio: i64, cantidad: i64, abono: i64) -> ResultadoAbono {
    let est = Estado { lineas: vec![linea(pid, precio, cantidad)], cliente: Some(cl.clone()), ..Default::default() };
    let esp = crear_espera(p, a, CAJA_1, &est).await.unwrap();
    crear_apartado(p, a, CAJA_1, &esp.id, &est, abono, &[pago(EF, abono)], &ulid()).await.unwrap()
}

async fn hay(p: &SqlitePool, pid: &str) -> i64 {
    let mut c = p.acquire().await.unwrap();
    let s = inventario::sucursal_de(&mut c, CAJA_1).await.unwrap();
    inventario::existencia(&mut c, pid, &s).await.unwrap()
}

async fn z_cerrado(p: &SqlitePool, dueno: &Actor, turno_id: &str) -> caja::Resumen {
    let (d, _) = datos_z(p, dueno, turno_id).await.unwrap();
    assert!(d.resumen.cuadra, "el Z no cuadra: {:?}", d.resumen.descuadres);
    d.resumen
}

async fn turno_actual(p: &SqlitePool) -> String {
    sqlx::query_scalar("SELECT id FROM caja_turnos WHERE estado = 'abierto'").fetch_one(p).await.unwrap()
}

fn total(n: i64) -> caja::Conteo {
    caja::Conteo { cantidades: Default::default(), total: Some(n) }
}

/// Cierra con el efectivo exacto (sin diferencia) y devuelve el id del turno.
async fn cerrar_exacto(p: &SqlitePool, dueno: &Actor) -> String {
    let t = turno_actual(p).await;
    let esperado = {
        let mut c = p.acquire().await.unwrap();
        let tt = caja::turno(&mut c, &t).await.unwrap().unwrap();
        caja::resumen(&mut c, &tt).await.unwrap().efectivo_esperado
    };
    cerrar(p, dueno, CAJA_1, &total(esperado), "").await.unwrap();
    t
}

// ─────────── Flujo principal ───────────

#[tokio::test]
async fn la_descripcion_se_guarda_limpia_y_se_busca() {
    let (bd, _, _, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, 20000, 1).await;
    let cl = cliente(p).await;
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
    let est = Estado { lineas: vec![linea(&pid, 20000, 1)], cliente: Some(cl), ..Default::default() };
    let esp = crear_espera(p, &luis, CAJA_1, &est).await.unwrap();
    let largo = "x".repeat(201);
    assert!(crear_apartado_con(p, &luis, CAJA_1, &esp.id, &est, 10000, &[pago(EF, 10000)], &ulid(), Some(&largo)).await.is_err());
    crear_apartado_con(p, &luis, CAJA_1, &esp.id, &est, 10000, &[pago(EF, 10000)], &ulid(), Some("  Retablo de   graduada ")).await.unwrap();
    let r = buscar(p, &luis, "retablo").await.unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].descripcion.as_deref(), Some("Retablo de graduada"));
}

#[tokio::test]
async fn apartar_abonar_y_liquidar_en_otro_turno() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, 20000, 1).await;
    let cl = cliente(p).await;
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();

    // Abono mínimo: 50 % de ¢20.000.
    let est = Estado { lineas: vec![linea(&pid, 20000, 1)], cliente: Some(cl.clone()), ..Default::default() };
    let esp = crear_espera(p, &luis, CAJA_1, &est).await.unwrap();
    let err = crear_apartado(p, &luis, CAJA_1, &esp.id, &est, 9000, &[pago(EF, 9000)], &ulid()).await.unwrap_err();
    assert!(err.contains("mínimo"), "{err}");
    let r = crear_apartado(p, &luis, CAJA_1, &esp.id, &est, 10000, &[pago(EF, 20000)], &ulid()).await.unwrap();
    assert_eq!((r.numero.as_str(), r.saldo, r.vuelto, r.estado.as_str()), ("A-0001", 10000, 10000, "abierta"));
    assert!(r.abrir_gaveta);
    // Reservado, no descontado: la existencia sigue igual.
    assert_eq!(hay(p, &pid).await, 1);
    // La espera ya no está: un segundo intento no crea otro apartado.
    assert!(crear_apartado(p, &luis, CAJA_1, &esp.id, &est, 10000, &[pago(EF, 10000)], &ulid()).await.is_err());

    // El precio cambia después de apartar: se respeta el del apartado.
    sqlx::query("UPDATE productos SET precio = 25000 WHERE id = ?").bind(&pid).execute(p).await.unwrap();

    let t1 = cerrar_exacto(p, &ana).await;
    let z1 = z_cerrado(p, &ana, &t1).await;
    assert_eq!((z1.ventas, z1.total_ventas, z1.abonos_total, z1.abonos_efectivo), (0, 0, 10000, 10000));
    assert_eq!((z1.apartados.creados, z1.apartados.monto_creados), (1, 20000));
    assert_eq!(z1.efectivo_esperado, 10000 + 10000);

    // Otro turno, otro día: liquida con tarjeta y se lo lleva.
    reloj("2026-11-17T09:00:00-06:00");
    abrir(p, &luis, CAJA_1, &total(z1.efectivo_esperado)).await.unwrap();
    let r2 = abonar(p, &luis, CAJA_1, &r.cuenta_id, 10000, &[pago(TJ, 10000)], &ulid(), true).await.unwrap();
    assert_eq!((r2.saldo, r2.estado.as_str()), (0, "entregada"));
    let vid = r2.venta_id.clone().unwrap();
    let v = sqlx::query("SELECT total, cuenta_id, (SELECT precio_unitario FROM venta_lineas WHERE venta_id = v.id) AS precio, (SELECT COUNT(*) FROM venta_pagos WHERE venta_id = v.id) AS pagos FROM ventas v WHERE id = ?")
        .bind(&vid)
        .fetch_one(p)
        .await
        .unwrap();
    assert_eq!((v.get::<i64, _>("total"), v.get::<i64, _>("precio"), v.get::<i64, _>("pagos")), (20000, 20000, 0));
    assert_eq!(v.get::<String, _>("cuenta_id"), r.cuenta_id);
    // Ahora sí sale del inventario (kardex "venta" ligado a la venta de liquidación).
    assert_eq!(hay(p, &pid).await, 0);
    let t2 = cerrar_exacto(p, &ana).await;
    let z2 = z_cerrado(p, &ana, &t2).await;
    assert_eq!((z2.ventas, z2.total_ventas, z2.ventas_con_abonos), (1, 20000, 20000));
    assert_eq!((z2.abonos_total, z2.abonos_efectivo), (10000, 0));
    assert_eq!(z2.apartados.liquidados, 1);
    // El desglose reparte la venta como "Abonos de apartado" (Ab).
    assert_eq!(z2.desglose.total, 20000);
    assert_eq!(z2.desglose.departamentos[0].por_forma[0].codigo, "Ab");

    // Cada abono está en exactamente un Z (los congelados).
    let congelados: Vec<String> = sqlx::query_scalar("SELECT totales FROM caja_turnos WHERE estado = 'cerrado'").fetch_all(p).await.unwrap();
    let suma: i64 = congelados.iter().map(|t| serde_json::from_str::<Value>(t).unwrap()["abonosTotal"].as_i64().unwrap_or(0)).sum();
    let abonos: i64 = sqlx::query_scalar("SELECT SUM(monto) FROM abonos").fetch_one(p).await.unwrap();
    assert_eq!(suma, abonos);
}

#[tokio::test]
async fn doble_clic_no_crea_dos_abonos_y_sin_caja_no_se_abona() {
    let (bd, _, _, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, 10000, 0).await;
    let cl = cliente(p).await;
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
    let r = apartar(p, &luis, &cl, &pid, 10000, 1, 5000).await;
    let op = ulid();
    let a1 = abonar(p, &luis, CAJA_1, &r.cuenta_id, 1000, &[pago(EF, 1000)], &op, true).await.unwrap();
    let a2 = abonar(p, &luis, CAJA_1, &r.cuenta_id, 1000, &[pago(EF, 1000)], &op, true).await.unwrap();
    assert_eq!((a1.saldo, a2.saldo, a2.abrir_gaveta), (4000, 4000, false));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM abonos").fetch_one(p).await.unwrap();
    assert_eq!(n, 2);
    // Abono mayor que el saldo: en efectivo es vuelto; con tarjeta, no.
    assert!(abonar(p, &luis, CAJA_1, &r.cuenta_id, 4001, &[pago(EF, 5000)], &ulid(), true).await.unwrap_err().contains("saldo"));
    assert!(abonar(p, &luis, CAJA_1, &r.cuenta_id, 4000, &[pago(TJ, 5000)], &ulid(), true).await.is_err());
    // Rechazado: nada a medias.
    let saldo: i64 = sqlx::query_scalar("SELECT saldo FROM cuentas").fetch_one(p).await.unwrap();
    assert_eq!(saldo, 4000);
    // Mixto: ¢1.000 con tarjeta y ¢5.000 en efectivo para ¢4.000 → vuelto ¢2.000, y queda pagado (sin entregar).
    let m = abonar(p, &luis, CAJA_1, &r.cuenta_id, 4000, &[pago(TJ, 1000), pago(EF, 5000)], &ulid(), false).await.unwrap();
    assert_eq!((m.saldo, m.vuelto, m.estado.as_str()), (0, 2000, "pagada"));
    entregar(p, &luis, &r.cuenta_id).await.unwrap();
    assert!(entregar(p, &luis, &r.cuenta_id).await.is_err());
}

#[tokio::test]
async fn sin_turno_no_hay_abono() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, 10000, 0).await;
    let cl = cliente(p).await;
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
    let r = apartar(p, &luis, &cl, &pid, 10000, 1, 5000).await;
    cerrar_exacto(p, &ana).await;
    assert!(abonar(p, &luis, CAJA_1, &r.cuenta_id, 1000, &[pago(EF, 1000)], &ulid(), true).await.is_err());
}

#[tokio::test]
async fn lo_apartado_no_se_vende_dos_veces() {
    let (bd, _, _, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, 15000, 1).await;
    let cl = cliente(p).await;
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
    apartar(p, &luis, &cl, &pid, 15000, 1, 7500).await;
    // Aunque el negocio vende sin existencia, la única unidad está apartada: pide el PIN del dueño.
    let e = Estado { lineas: vec![linea(&pid, 15000, 1)], ..Default::default() };
    let esp = crear_espera(p, &luis, CAJA_1, &e).await.unwrap();
    let err = cobrar(p, &luis, CAJA_1, &esp.id, &e, &[pago(EF, 15000)]).await.unwrap_err();
    assert!(err.starts_with(inventario::SIN_EXISTENCIA) && err.contains("A-0001"), "{err}");
    cobrar_con(p, &luis, CAJA_1, &esp.id, &e, &[pago(EF, 15000)], Some(PIN)).await.unwrap();
}

#[tokio::test]
async fn caja_tardia_del_sabado_el_abono_cuenta_para_el_lunes() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    let pid = producto(p, 10000, 0).await;
    let cl = cliente(p).await;
    reloj("2026-11-21T09:00:00-06:00");
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
    cerrar_exacto(p, &ana).await;
    // Sábado después del cierre (17:30): la caja cuenta para el lunes 23.
    reloj("2026-11-21T17:45:00-06:00");
    abrir(p, &luis, CAJA_1, &total(10000)).await.unwrap();
    let r = apartar(p, &luis, &cl, &pid, 10000, 1, 5000).await;
    let dia: String = sqlx::query_scalar("SELECT t.dia FROM abonos a JOIN caja_turnos t ON t.id = a.turno_id").fetch_one(p).await.unwrap();
    assert_eq!(dia, "2026-11-23");
    // El plazo cuenta desde el día de negocio (lunes 23) y la fecha real queda en el abono.
    let (limite, fecha): (String, String) = sqlx::query_as("SELECT k.fecha_limite, a.fecha FROM cuentas k JOIN abonos a ON a.cuenta_id = k.id WHERE k.id = ?").bind(&r.cuenta_id).fetch_one(p).await.unwrap();
    assert_eq!(limite, "2026-12-23");
    assert!(fecha.starts_with("2026-11-21T23:45"), "{fecha}");
}

// ─────────── Sin doble conteo ───────────

/// Dinero recibido en un turno por cualquier forma de pago: pagos de ventas + abonos (lo aplicado, sin vuelto).
fn recibido(z: &caja::Resumen) -> i64 {
    z.por_forma.iter().map(|f| f.monto).sum::<i64>() + z.abonos_total
}

/// "Vendido − abonos aplicados − a crédito + abonos recibidos = dinero recibido" (lo que dice el Z arriba).
fn cuadra_vendido_y_recibido(z: &caja::Resumen) {
    assert_eq!(z.total_ventas - z.ventas_con_abonos - z.ventas_a_credito + z.abonos_total, recibido(z), "vendido y recibido no cuadran: {z:?}");
}

/// Pagos de ventas que cuentan en el turno + abonos del turno, leídos directo de las tablas.
async fn pagos_reales(p: &SqlitePool, turno: &str) -> i64 {
    let ventas: i64 = sqlx::query_scalar(&format!(
        "SELECT COALESCE(SUM(vp.monto), 0) FROM venta_pagos vp JOIN ventas v ON v.id = vp.venta_id WHERE v.turno_id = ? AND vp.eliminado_en IS NULL AND {}",
        crate::reportes::VENTA_EN_SU_Z
    ))
    .bind(turno)
    .fetch_one(p)
    .await
    .unwrap();
    let abonos: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(monto), 0) FROM abonos WHERE turno_id = ? AND anulado_en IS NULL").bind(turno).fetch_one(p).await.unwrap();
    ventas + abonos
}

fn sinpe(m: i64) -> PagoEntrada {
    PagoEntrada { forma_pago_id: "0000000000000000000000FP03".into(), monto: m, banco_id: Some("0000000000000000000000BN02".into()), referencia: Some("88112233".into()), ultimos4: None, pagador: Some("Marta Solís".into()) }
}

/// Un apartado de ¢30.000: abono en efectivo el lunes, abono por SINPE el martes y liquidación mixta
/// (efectivo + tarjeta) en la caja tardía del sábado, que cuenta para el lunes 23. Cada colón entra
/// una sola vez: en el Z del turno donde se recibió, en el efectivo esperado y en los reportes.
#[tokio::test]
async fn liquidar_no_cuenta_el_dinero_dos_veces() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    let pid = producto(p, 30000, 1).await;
    let cl = cliente(p).await;

    // Lunes 16: aparta con ¢15.000 en efectivo.
    reloj("2026-11-16T10:00:00-06:00");
    abrir(p, &luis, CAJA_1, &total(10000)).await.unwrap();
    let r = apartar(p, &luis, &cl, &pid, 30000, 1, 15000).await;
    let t1 = cerrar_exacto(p, &ana).await;
    let z1 = z_cerrado(p, &ana, &t1).await;
    assert_eq!((z1.total_ventas, z1.abonos_total, z1.abonos_efectivo, z1.efectivo_esperado), (0, 15000, 15000, 10000 + 15000));
    cuadra_vendido_y_recibido(&z1);
    assert_eq!(recibido(&z1), pagos_reales(p, &t1).await);
    // Reportes: el abono está "a nombre del cliente" mientras el apartado siga abierto.
    let r1 = crate::reportes::ventas(p, &ana, "2026-11-16", "2026-11-16").await.unwrap();
    assert_eq!((r1.apartados_abiertos, r1.abonado_en_apartados, r1.totales.ventas), (1, 15000, 0));

    // Martes 17: abona ¢5.000 por SINPE (no es efectivo).
    reloj("2026-11-17T10:00:00-06:00");
    abrir(p, &luis, CAJA_1, &total(z1.efectivo_esperado)).await.unwrap();
    abonar(p, &luis, CAJA_1, &r.cuenta_id, 5000, &[sinpe(5000)], &ulid(), true).await.unwrap();
    let t2 = cerrar_exacto(p, &ana).await;
    let z2 = z_cerrado(p, &ana, &t2).await;
    assert_eq!((z2.total_ventas, z2.abonos_total, z2.abonos_efectivo, z2.efectivo_esperado), (0, 5000, 0, z1.efectivo_esperado));
    cuadra_vendido_y_recibido(&z2);
    assert_eq!(recibido(&z2), pagos_reales(p, &t2).await);

    // Sábado 21 después del cierre (17:30): la caja cuenta para el lunes 23. Liquida ¢10.000 mixto.
    reloj("2026-11-21T09:00:00-06:00");
    abrir(p, &luis, CAJA_1, &total(z2.efectivo_esperado)).await.unwrap();
    cerrar_exacto(p, &ana).await;
    reloj("2026-11-21T17:45:00-06:00");
    abrir(p, &luis, CAJA_1, &total(z2.efectivo_esperado)).await.unwrap();
    let liq = abonar(p, &luis, CAJA_1, &r.cuenta_id, 10000, &[pago(EF, 5000), pago(TJ, 6000)], &ulid(), true).await.unwrap();
    assert_eq!((liq.saldo, liq.estado.as_str(), liq.vuelto), (0, "entregada", 1000));
    let t3 = cerrar_exacto(p, &ana).await;
    let dia: String = sqlx::query_scalar("SELECT dia FROM caja_turnos WHERE id = ?").bind(&t3).fetch_one(p).await.unwrap();
    assert_eq!(dia, "2026-11-23");

    // La venta de liquidación queda pagada con abonos aplicados: ningún pago propio.
    let vid = liq.venta_id.unwrap();
    let (vtotal, npagos): (i64, i64) = sqlx::query_as("SELECT total, (SELECT COUNT(*) FROM venta_pagos WHERE venta_id = v.id) FROM ventas v WHERE id = ?").bind(&vid).fetch_one(p).await.unwrap();
    assert_eq!((vtotal, npagos), (30000, 0));

    let z3 = z_cerrado(p, &ana, &t3).await;
    // Vendido ¢30.000, pagado con abonos; dinero de hoy: solo los ¢10.000 de la liquidación.
    assert_eq!((z3.ventas, z3.total_ventas, z3.ventas_con_abonos), (1, 30000, 30000));
    assert_eq!(z3.por_forma.iter().map(|f| f.monto).sum::<i64>(), 0);
    assert_eq!((z3.abonos_total, z3.abonos_efectivo), (10000, 4000));
    // El efectivo esperado suma solo el efectivo final recibido en este turno (5.000 − 1.000 de vuelto).
    assert_eq!(z3.efectivo_esperado, z2.efectivo_esperado + 4000);
    cuadra_vendido_y_recibido(&z3);
    assert_eq!(recibido(&z3), pagos_reales(p, &t3).await);

    // En todos los turnos juntos entró exactamente el precio del apartado, ni un colón más.
    assert_eq!(recibido(&z1) + recibido(&z2) + recibido(&z3), 30000);
    // El historial de cierres dice lo mismo por turno: vendido ¢30.000, recibido ¢10.000 el lunes 23.
    let hist = caja::listar(p, &ana, CAJA_1, "2026-11-16", "2026-11-23").await.unwrap();
    let h3 = hist.iter().find(|f| f.turno.id == t3).unwrap();
    assert_eq!((h3.total, h3.recibido), (Some(30000), Some(10000)));
    let h1 = hist.iter().find(|f| f.turno.id == t1).unwrap();
    assert_eq!((h1.total, h1.recibido), (Some(0), Some(15000)));

    // Reportes por forma de pago (lunes 16 a lunes 23): el dinero real suma ¢30.000; la venta
    // aparece aparte como "Pagadas con abonos", que no es dinero.
    let rep = crate::reportes::ventas(p, &ana, "2026-11-16", "2026-11-23").await.unwrap();
    let dinero: i64 = rep.por_forma.iter().filter(|f| f.forma != "Pagadas con abonos").map(|f| f.ventas + f.abonos).sum();
    assert_eq!(dinero, 30000);
    let con_abonos: i64 = rep.por_forma.iter().filter(|f| f.forma == "Pagadas con abonos").map(|f| f.ventas).sum();
    assert_eq!((con_abonos, rep.totales.ventas, rep.totales.abonos), (30000, 30000, 30000));
    let ef = rep.por_forma.iter().find(|f| f.forma == "Efectivo").unwrap();
    assert_eq!((ef.ventas, ef.abonos), (0, 15000 + 4000));
    assert_eq!((rep.apartados_abiertos, rep.abonado_en_apartados), (0, 0));
}

/// Cancelado con devolución en efectivo: el abono entró y la devolución sale; nunca es venta.
#[tokio::test]
async fn cancelar_con_devolucion_no_deja_venta_ni_dinero() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, 20000, 1).await;
    let cl = cliente(p).await;
    abrir(p, &luis, CAJA_1, &total(10000)).await.unwrap();
    let r = apartar(p, &luis, &cl, &pid, 20000, 1, 10000).await;
    cancelar(p, &ana, CAJA_1, &r.cuenta_id, PIN, "Ya no lo quiere", 10000, 10000).await.unwrap();
    let t = cerrar_exacto(p, &ana).await;
    let z = z_cerrado(p, &ana, &t).await;
    assert_eq!((z.ventas, z.total_ventas, z.ventas_con_abonos), (0, 0, 0));
    assert_eq!((z.abonos_total, z.apartados.devuelto), (10000, 10000));
    // fondo + abono − devolución
    assert_eq!(z.efectivo_esperado, 10000);
    cuadra_vendido_y_recibido(&z);
    let ventas: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ventas").fetch_one(p).await.unwrap();
    assert_eq!(ventas, 0);
}

// ─────────── Acciones del dueño ───────────

#[tokio::test]
async fn cancelar_devuelve_efectivo_y_retiene_el_resto() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, 20000, 1).await;
    let cl = cliente(p).await;
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
    let r = apartar(p, &luis, &cl, &pid, 20000, 1, 10000).await;
    assert!(cancelar(p, &luis, CAJA_1, &r.cuenta_id, PIN, "Ya no lo quiere", 10000, 10000).await.unwrap_err().contains("permiso"));
    assert!(cancelar(p, &ana, CAJA_1, &r.cuenta_id, PIN, "Ya no lo quiere", 10001, 0).await.is_err());
    cancelar(p, &ana, CAJA_1, &r.cuenta_id, PIN, "Ya no lo quiere", 8000, 8000).await.unwrap();
    let (estado, devuelto, retenido): (String, i64, i64) = sqlx::query_as("SELECT estado, devuelto, retenido FROM cuentas").fetch_one(p).await.unwrap();
    assert_eq!((estado.as_str(), devuelto, retenido), ("cancelada", 8000, 2000));
    // La reserva se libera: ya se puede vender la unidad sin PIN.
    let e = Estado { lineas: vec![linea(&pid, 20000, 1)], ..Default::default() };
    let esp = crear_espera(p, &luis, CAJA_1, &e).await.unwrap();
    cobrar(p, &luis, CAJA_1, &esp.id, &e, &[pago(EF, 20000)]).await.unwrap();
    let t = cerrar_exacto(p, &ana).await;
    let z = z_cerrado(p, &ana, &t).await;
    assert_eq!((z.apartados.cancelados, z.apartados.devuelto, z.apartados.retenido), (1, 8000, 2000));
    // fondo 10.000 + abono 10.000 + venta 20.000 − devolución 8.000
    assert_eq!(z.efectivo_esperado, 32000);
}

#[tokio::test]
async fn anular_abono_en_su_turno_y_de_un_turno_cerrado() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, 20000, 0).await;
    let cl = cliente(p).await;
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
    let r = apartar(p, &luis, &cl, &pid, 20000, 1, 10000).await;
    abonar(p, &luis, CAJA_1, &r.cuenta_id, 2000, &[pago(EF, 2000)], &ulid(), true).await.unwrap();
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM abonos ORDER BY fecha").fetch_all(p).await.unwrap();
    // En su turno abierto: sin devolución aparte, sale del esperado.
    assert!(anular_abono(p, &ana, CAJA_1, &ids[1], PIN, "Se registró dos veces", 2000).await.is_err());
    anular_abono(p, &ana, CAJA_1, &ids[1], PIN, "Se registró dos veces", 0).await.unwrap();
    let t1 = cerrar_exacto(p, &ana).await;
    let z1 = z_cerrado(p, &ana, &t1).await;
    assert_eq!((z1.abonos_total, z1.efectivo_esperado), (10000, 20000));
    // De un turno cerrado: el Z viejo no cambia; la devolución sale en la caja de hoy.
    reloj("2026-11-17T09:00:00-06:00");
    abrir(p, &luis, CAJA_1, &total(20000)).await.unwrap();
    anular_abono(p, &ana, CAJA_1, &ids[0], PIN, "Pagó con billete falso", 10000).await.unwrap();
    let saldo: i64 = sqlx::query_scalar("SELECT saldo FROM cuentas").fetch_one(p).await.unwrap();
    assert_eq!(saldo, 20000);
    let viejo: String = sqlx::query_scalar("SELECT totales FROM caja_turnos WHERE id = ?").bind(&t1).fetch_one(p).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&viejo).unwrap()["abonosTotal"], json!(10000));
    let z1b = z_cerrado(p, &ana, &t1).await; // recalculado en vivo: igual al congelado
    assert_eq!(z1b.abonos_total, 10000);
    let t2 = cerrar_exacto(p, &ana).await;
    let z2 = z_cerrado(p, &ana, &t2).await;
    assert_eq!((z2.apartados.abonos_anulados, z2.salidas, z2.efectivo_esperado), (1, 10000, 10000));
}

#[tokio::test]
async fn condonar_liquida_con_descuento() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, 10000, 1).await;
    let cl = cliente(p).await;
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
    let r = apartar(p, &luis, &cl, &pid, 10000, 1, 9000).await;
    ajustar(p, &ana, &r.cuenta_id, -500, PIN, "Error en el precio").await.unwrap();
    assert!(ajustar(p, &ana, &r.cuenta_id, -500, PIN, "Error en el precio").await.unwrap_err().contains("Condonar"));
    let vid = condonar(p, &ana, CAJA_1, &r.cuenta_id, PIN, "Cliente frecuente", true).await.unwrap().unwrap();
    let (total, desc): (i64, i64) = sqlx::query_as("SELECT total, descuento FROM ventas WHERE id = ?").bind(&vid).fetch_one(p).await.unwrap();
    assert_eq!((total, desc), (9000, 500));
    let t = cerrar_exacto(p, &ana).await;
    let z = z_cerrado(p, &ana, &t).await;
    assert_eq!((z.total_ventas, z.ventas_con_abonos, z.apartados.condonado), (9000, 9000, 500));
    prorrogar(p, &ana, &r.cuenta_id, "2026-12-30", "Viaje", PIN).await.unwrap_err(); // ya entregada
}

// ─────────── Crédito ───────────

#[tokio::test]
async fn venta_a_credito_con_limite_y_abonos() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, 30000, 5).await;
    let cl = cliente(p).await;
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
    let est = Estado { lineas: vec![linea(&pid, 30000, 1)], cliente: Some(cl.clone()), ..Default::default() };
    let esp = crear_espera(p, &luis, CAJA_1, &est).await.unwrap();
    // El negocio no vende a crédito (Chaguí).
    let err = ventas::cobrar_opc(p, &luis, CAJA_1, &esp.id, &est, &[], None, true).await.unwrap_err();
    assert!(err.contains("no vende a crédito"), "{err}");
    sqlx::query("UPDATE config SET valor = 'true' WHERE clave = 'usa_credito'").execute(p).await.unwrap();
    // Sin límite: no alcanza. El cajero no sabe el límite.
    assert!(ventas::cobrar_opc(p, &luis, CAJA_1, &esp.id, &est, &[pago(EF, 10000)], None, true).await.unwrap_err().contains("no alcanza"));
    assert!(fijar_limite(p, &luis, &cl.id, Some(50000), PIN).await.unwrap_err().contains("permiso"));
    // Límite propio sin ninguna cuenta de crédito antes.
    fijar_limite(p, &ana, &cl.id, Some(25000), PIN).await.unwrap();
    // El cajero ve cuánto crédito le queda, no el límite ni lo que debe.
    assert_eq!(credito_disponible_cliente(p, &luis, &cl.id).await.unwrap(), 25000);
    let r = ventas::cobrar_opc(p, &luis, CAJA_1, &esp.id, &est, &[pago(EF, 10000)], None, true).await.unwrap();
    assert!(r.cuenta_id.is_some(), "la venta a crédito dice su cuenta (para imprimir el comprobante)");
    assert_eq!(credito_disponible_cliente(p, &luis, &cl.id).await.unwrap(), 5000);
    let k = sqlx::query("SELECT id, numero, saldo, estado FROM cuentas WHERE venta_id = ?").bind(&r.venta_id).fetch_one(p).await.unwrap();
    assert_eq!((k.get::<String, _>("numero").as_str(), k.get::<i64, _>("saldo")), ("C-0001", 20000));
    // La venta sale hoy (y del inventario).
    assert_eq!(hay(p, &pid).await, 4);
    let cuenta: String = k.get("id");
    abonar(p, &luis, CAJA_1, &cuenta, 5000, &[pago(EF, 5000)], &ulid(), false).await.unwrap();
    let t = cerrar_exacto(p, &ana).await;
    let z = z_cerrado(p, &ana, &t).await;
    assert_eq!((z.total_ventas, z.ventas_a_credito, z.abonos_total, z.apartados.creditos), (30000, 20000, 5000, 1));
    assert_eq!(z.efectivo_esperado, 10000 + 10000 + 5000);
    // El bitácora no guarda el límite.
    let det: String = sqlx::query_scalar("SELECT detalle FROM bitacora WHERE accion = 'credito.limite'").fetch_one(p).await.unwrap();
    assert!(!det.contains("25000"), "{det}");
}

/// Opciones del dueño (con PIN), plazo en días de trabajo, estado de cuenta con varias cuentas,
/// ajuste hacia arriba sin condonado negativo, reportes con la fila "A crédito" y prorrogar con PIN.
#[tokio::test]
async fn credito_completo_opciones_estado_de_cuenta_y_reportes() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("2026-11-16T10:00:00-06:00"); // lunes
    let pid = producto(p, 30000, 5).await;
    let cl = cliente(p).await;
    sqlx::query("UPDATE config SET valor = 'true' WHERE clave = 'usa_credito'").execute(p).await.unwrap();
    let op = OpcionesCredito { limite_defecto: 100000, plazo_dias: 10, plazo_tipo: "laborables".into(), condiciones: "Pague antes de la fecha.".into() };
    assert!(guardar_opciones_credito(p, &luis, &op, PIN).await.unwrap_err().contains("permiso"));
    assert!(guardar_opciones_credito(p, &ana, &op, "000000").await.is_err());
    assert!(guardar_opciones_credito(p, &ana, &OpcionesCredito { plazo_tipo: "semanas".into(), ..op.clone() }, PIN).await.is_err());
    guardar_opciones_credito(p, &ana, &op, PIN).await.unwrap();
    assert_eq!(opciones_credito(p, &ana).await.unwrap(), op);
    assert_eq!(reglas(p, &luis).await.unwrap().credito_condiciones, "Pague antes de la fecha.");

    abrir(p, &luis, CAJA_1, &total(10000)).await.unwrap();
    // Sin límite propio: usa el del negocio (¢100.000).
    assert_eq!(credito_disponible_cliente(p, &luis, &cl.id).await.unwrap(), 100000);
    let est = Estado { lineas: vec![linea(&pid, 30000, 1)], cliente: Some(cl.clone()), ..Default::default() };
    let esp = crear_espera(p, &luis, CAJA_1, &est).await.unwrap();
    let r = ventas::cobrar_opc(p, &luis, CAJA_1, &esp.id, &est, &[pago(EF, 10000)], None, true).await.unwrap();
    let cid = r.cuenta_id.unwrap();
    // 10 días de trabajo desde el lunes 16 (sin domingos): viernes 27.
    let d = obtener(p, &ana, &cid).await.unwrap();
    assert_eq!((d.cuenta.fecha_limite.as_deref(), d.venta_total), (Some("2026-11-27"), Some(30000)));
    abonar(p, &luis, CAJA_1, &cid, 5000, &[pago(EF, 5000)], &ulid(), false).await.unwrap();
    // Ajuste hacia arriba: sube lo que se debe; lo condonado no queda negativo y lo abonado no cambia.
    ajustar(p, &ana, &cid, 1000, PIN, "Faltó cobrar una bolsa").await.unwrap();
    let d = obtener(p, &ana, &cid).await.unwrap();
    assert_eq!((d.cuenta.saldo, d.condonado, d.cuenta.abonado), (16000, 0, 5000));
    // Un apartado abierto del mismo cliente.
    let ap = apartar(p, &luis, &cl, &pid, 30000, 1, 15000).await;

    // Estado de cuenta: las dos cuentas, sus abonos y lo que debe en total.
    assert!(estado_cuenta(p, &luis, &cl.id).await.unwrap_err().contains("permiso"));
    let ec = estado_cuenta(p, &ana, &cl.id).await.unwrap();
    assert_eq!(ec.cuentas.len(), 2);
    assert_eq!(ec.total_adeudado, 16000 + 15000);
    assert!(ec.cuentas.iter().all(|c| !c.abonos.is_empty()));
    assert_eq!(limite_cliente(p, &ana, &cl.id).await.unwrap(), None);

    // Prorrogar pide el PIN del dueño.
    assert!(prorrogar(p, &ana, &ap.cuenta_id, "2026-12-30", "Viaje de la familia", "000000").await.is_err());
    prorrogar(p, &ana, &ap.cuenta_id, "2026-12-30", "Viaje de la familia", PIN).await.unwrap();

    // Reportes: la fila "A crédito (por cobrar)" entra y las formas suman lo vendido.
    let t = cerrar_exacto(p, &ana).await;
    let z = z_cerrado(p, &ana, &t).await;
    cuadra_vendido_y_recibido(&z);
    let rep = crate::reportes::ventas(p, &ana, "2026-11-16", "2026-11-16").await.unwrap();
    let fila = |n: &str| rep.por_forma.iter().find(|f| f.forma == n).map(|f| f.ventas).unwrap_or(0);
    assert_eq!(fila("A crédito (por cobrar)"), 20000);
    assert_eq!(rep.por_forma.iter().map(|f| f.ventas).sum::<i64>(), rep.totales.ventas);
    assert_eq!(rep.totales.ventas, 30000);

    // Condonar un apartado con la caja cerrada: mensaje claro.
    assert_eq!(condonar(p, &ana, CAJA_1, &ap.cuenta_id, PIN, "Cliente frecuente", true).await.unwrap_err(), CONDONAR_SIN_CAJA);
}

// ─────────── Permisos y Ley 8968 ───────────

#[tokio::test]
async fn permisos_y_cliente_con_saldo_no_se_anonimiza() {
    let (bd, tec, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, 10000, 0).await;
    let cl = cliente(p).await;
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
    let r = apartar(p, &luis, &cl, &pid, 10000, 1, 5000).await;
    // El cajero busca y ve la cuenta que atiende, sin el historial del dueño.
    assert_eq!(buscar(p, &luis, "marta").await.unwrap().len(), 1);
    assert_eq!(buscar(p, &luis, "A-1").await.unwrap().len(), 1);
    assert!(obtener(p, &luis, &r.cuenta_id).await.unwrap().eventos.is_empty());
    assert!(!obtener(p, &ana, &r.cuenta_id).await.unwrap().eventos.is_empty());
    assert!(listar(p, &luis, "abiertas").await.unwrap_err().contains("permiso"));
    assert_eq!(listar(p, &ana, "abiertas").await.unwrap().len(), 1);
    // El técnico no entra a nada de esto (datos de clientes).
    let tec = Actor { rol: Rol::Tecnico, ..tec };
    assert!(buscar(p, &tec, "").await.is_err());
    assert!(reglas(p, &tec).await.is_err());
    // Vencido: el 17 de diciembre ya pasó la fecha límite (16 de diciembre).
    reloj("2026-12-17T10:00:00-06:00");
    assert_eq!(vencidas(p, &ana).await.unwrap(), 1);
    assert!(listar(p, &ana, "vencidas").await.unwrap()[0].vencida);
    let err = crate::clientes::anonimizar(p, &ana, &cl.id, PIN, crate::clientes::MOTIVOS[0]).await.unwrap_err();
    assert!(err.contains("saldo"), "{err}");
}

// ─────────── Invariantes del Z con apartados (al azar, contra un modelo independiente) ───────────

struct Azar(u64);
impl Azar {
    fn n(&mut self, max: i64) -> i64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) % max.max(1) as u64) as i64
    }
}

/// Muchos turnos con apartados, abonos (efectivo, tarjeta, mixtos), liquidaciones, cancelaciones con
/// devolución, abonos anulados y ventas. En cada cierre: el Z cuadra y su efectivo esperado es el del
/// modelo (llevado aparte, sin la fórmula del Z). Al final: cada abono está en exactamente un Z.
#[tokio::test]
async fn el_z_cuadra_con_apartados_en_muchos_turnos() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    let mut az = Azar(20261119);
    let cl = cliente(p).await;
    let mut caja_modelo = 50_000i64; // fondo inicial
    for dia in 0..12 {
        reloj(&format!("2026-12-{:02}T09:00:00-06:00", 1 + dia));
        abrir(p, &luis, CAJA_1, &total(caja_modelo)).await.unwrap();
        let t = turno_actual(p).await;
        for _ in 0..10 {
            match az.n(6) {
                0 | 1 => {
                    let precio = 1000 * (5 + az.n(40));
                    let pid = producto(p, precio, 0).await;
                    let min = abono_minimo(precio, 50);
                    let abono = min + az.n(precio - min);
                    let est = Estado { lineas: vec![linea(&pid, precio, 1)], cliente: Some(cl.clone()), ..Default::default() };
                    let esp = crear_espera(p, &luis, CAJA_1, &est).await.unwrap();
                    let (pagos, efectivo) = if az.n(2) == 0 { (vec![pago(EF, abono + 1000 * az.n(3))], abono) } else { (vec![pago(TJ, abono)], 0) };
                    crear_apartado(p, &luis, CAJA_1, &esp.id, &est, abono, &pagos, &ulid()).await.unwrap();
                    caja_modelo += efectivo;
                }
                2 | 3 => {
                    let abiertas = buscar(p, &luis, "").await.unwrap().into_iter().filter(|k| k.estado == "abierta").collect::<Vec<_>>();
                    if abiertas.is_empty() {
                        continue;
                    }
                    let k = &abiertas[az.n(abiertas.len() as i64) as usize];
                    let monto = if az.n(3) == 0 { k.saldo } else { 1 + az.n(k.saldo) };
                    let tarjeta = az.n(monto.min(3000) + 1).min(monto - 1).max(0);
                    let (pagos, efectivo) = match az.n(3) {
                        0 => (vec![pago(EF, monto + 500)], monto),
                        1 if monto > 1 && tarjeta > 0 => (vec![pago(TJ, tarjeta), pago(EF, monto - tarjeta + 200)], monto - tarjeta),
                        _ => (vec![pago(TJ, monto)], 0),
                    };
                    abonar(p, &luis, CAJA_1, &k.id, monto, &pagos, &ulid(), az.n(2) == 0).await.unwrap();
                    caja_modelo += efectivo;
                }
                4 => {
                    let abiertas = listar(p, &ana, "abiertas").await.unwrap();
                    if let Some(k) = abiertas.first() {
                        let devuelto = k.abonado - az.n(k.abonado / 2 + 1);
                        let en_efectivo = devuelto.min(caja_modelo).min(az.n(devuelto + 1));
                        cancelar(p, &ana, CAJA_1, &k.id, PIN, "Ya no lo quiere", devuelto, en_efectivo).await.unwrap();
                        caja_modelo -= en_efectivo;
                    }
                }
                _ => {
                    // Anular un abono de este turno de una cuenta abierta (sale del efectivo si fue efectivo).
                    let f: Option<(String, i64, i64)> = sqlx::query_as(
                        "SELECT a.id, a.monto, f.da_vuelto FROM abonos a JOIN formas_pago f ON f.id = a.forma_pago_id JOIN cuentas k ON k.id = a.cuenta_id
                         WHERE a.turno_id = ? AND a.anulado_en IS NULL AND k.estado = 'abierta' ORDER BY a.fecha LIMIT 1",
                    )
                    .bind(&t)
                    .fetch_optional(p)
                    .await
                    .unwrap();
                    if let Some((id, monto, ef)) = f {
                        if ef == 0 || monto <= caja_modelo {
                            anular_abono(p, &ana, CAJA_1, &id, PIN, "Se registró mal", 0).await.unwrap();
                            caja_modelo -= if ef == 1 { monto } else { 0 };
                        }
                    }
                }
            }
        }
        let z = {
            let mut c = p.acquire().await.unwrap();
            let tt = caja::turno(&mut c, &t).await.unwrap().unwrap();
            caja::resumen(&mut c, &tt).await.unwrap()
        };
        assert!(z.cuadra, "día {dia}: {:?}", z.descuadres);
        assert_eq!(z.efectivo_esperado, caja_modelo, "día {dia}: efectivo esperado contra el modelo");
        cerrar(p, &ana, CAJA_1, &total(caja_modelo), "").await.unwrap();
        z_cerrado(p, &ana, &t).await;
    }
    // Cada abono vigente (o anulado en otro turno) está en exactamente un Z congelado.
    let congelados: Vec<String> = sqlx::query_scalar("SELECT totales FROM caja_turnos WHERE estado = 'cerrado'").fetch_all(p).await.unwrap();
    let en_z: i64 = congelados.iter().map(|t| serde_json::from_str::<Value>(t).unwrap()["abonosTotal"].as_i64().unwrap()).sum();
    let reales: i64 = sqlx::query_scalar(&format!("SELECT COALESCE(SUM(a.monto), 0) FROM abonos a WHERE {}", caja::ABONO_EN_SU_Z)).fetch_one(p).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM abonos").fetch_one(p).await.unwrap();
    assert!(n > 20, "la prueba tiene que mover abonos de verdad ({n})");
    assert_eq!(en_z, reales);
}
