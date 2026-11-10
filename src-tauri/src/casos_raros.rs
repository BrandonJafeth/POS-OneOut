// Casos raros de un punto de venta, contra el código real (base en memoria): negativos, ceros,
// montos absurdos y secuencias que dejan la caja o el inventario en un estado imposible.
use crate::caja::{self, tests::conteo, Conteo, NuevoMovimiento, CAJA_1};
use crate::calculo::{Estado, Linea, PagoEntrada};
use crate::sesion::Actor;
use crate::usuarios::tests::base_con_usuarios;
use crate::util::ulid;
use crate::ventas::{self, CambioPago};
use sqlx::SqlitePool;

const DEP: &str = "00000000000000000000000D01";
const EF: &str = "0000000000000000000000FP01";
const TJ: &str = "0000000000000000000000FP02";
const SP: &str = "0000000000000000000000FP03";
const PIN: &str = "246813";

async fn prod(p: &SqlitePool, precio: i64) -> String {
    let id = ulid();
    sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, 'Cuaderno', 'cuaderno', ?, ?)").bind(&id).bind(DEP).bind(precio).execute(p).await.unwrap();
    id
}

fn linea(pid: Option<&str>, precio: i64, cantidad: i64, descuento: i64) -> Linea {
    Linea { id: ulid(), producto_id: pid.map(Into::into), codigo: None, descripcion: "Cuaderno".into(), departamento_id: DEP.into(), cantidad, precio_unitario: precio, descuento, tasa_iva: 13.0, exento: false }
}

fn est(lineas: Vec<Linea>) -> Estado {
    Estado { lineas, ..Default::default() }
}

fn pago(f: &str, m: i64) -> PagoEntrada {
    PagoEntrada { forma_pago_id: f.into(), monto: m, banco_id: None, referencia: None, ultimos4: None }
}

async fn cobrar(p: &SqlitePool, a: &Actor, e: &Estado, pagos: &[PagoEntrada]) -> Result<ventas::ResultadoCobro, String> {
    let esp = ventas::crear_espera(p, a, CAJA_1, e).await?;
    let r = ventas::cobrar(p, a, CAJA_1, &esp.id, e, pagos).await;
    if r.is_err() {
        ventas::descartar_espera(p, a, &esp.id).await?;
    }
    r
}

async fn esperado(p: &SqlitePool, dueno: &Actor) -> i64 {
    let t = caja::estado(p, dueno, CAJA_1).await.unwrap().turno.unwrap();
    caja::detalle(p, dueno, &t.id).await.unwrap().resumen.efectivo_esperado
}

fn salida(monto: i64) -> NuevoMovimiento {
    NuevoMovimiento { tipo: "salida".into(), monto, categoria: "Gasto menor".into(), nota: String::new() }
}

#[tokio::test]
async fn entradas_absurdas_al_cobrar() {
    let (bd, _, dueno, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    let pid = prod(p, 1000).await;
    let gratis = prod(p, 0).await;
    caja::abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
    let uno = || est(vec![linea(Some(&pid), 1000, 1, 0)]);
    let malo = |r: Result<ventas::ResultadoCobro, String>, que: &str| assert!(r.is_err(), "debía rechazarse: {que} → {r:?}");

    malo(cobrar(p, &cajero, &est(vec![linea(Some(&pid), 1000, 0, 0)]), &[]).await, "cantidad 0");
    malo(cobrar(p, &cajero, &est(vec![linea(Some(&pid), 1000, -3, 0)]), &[pago(EF, 1000)]).await, "cantidad negativa");
    malo(cobrar(p, &cajero, &est(vec![linea(Some(&pid), 1000, 1, -500)]), &[pago(EF, 1500)]).await, "descuento negativo (recargo)");
    malo(cobrar(p, &cajero, &est(vec![linea(Some(&pid), 1000, 1, 1001)]), &[]).await, "descuento mayor que la línea");
    malo(cobrar(p, &cajero, &est(vec![linea(Some(&pid), -1000, 1, 0)]), &[]).await, "precio negativo");
    malo(cobrar(p, &cajero, &est(vec![linea(None, -1000, 1, 0)]), &[]).await, "precio libre negativo");
    malo(cobrar(p, &cajero, &est(vec![]), &[]).await, "venta sin líneas");
    malo(cobrar(p, &cajero, &uno(), &[]).await, "sin pagos");
    malo(cobrar(p, &cajero, &uno(), &[pago(EF, 0)]).await, "pago de 0");
    malo(cobrar(p, &cajero, &uno(), &[pago(EF, -1000)]).await, "pago negativo");
    malo(cobrar(p, &cajero, &uno(), &[pago(EF, 2000), pago(TJ, -1000)]).await, "pago negativo que compensa");
    malo(cobrar(p, &cajero, &uno(), &[pago(TJ, 1500)]).await, "tarjeta con vuelto");
    malo(cobrar(p, &cajero, &uno(), &[pago(TJ, 1000), pago(EF, 5000)]).await, "efectivo de más para abrir la gaveta");
    malo(cobrar(p, &cajero, &uno(), &[pago("no-existe", 1000)]).await, "forma de pago inventada");
    malo(cobrar(p, &cajero, &uno(), &[pago(SP, 1000)]).await, "SINPE sin referencia");
    malo(cobrar(p, &cajero, &uno(), &[PagoEntrada { banco_id: Some("no-existe".into()), ..pago(EF, 1000) }]).await, "banco inventado");
    malo(cobrar(p, &cajero, &uno(), &[pago(EF, i64::MAX)]).await, "recibido gigante");
    let mut e = uno();
    e.descuento_total = i64::MAX;
    malo(cobrar(p, &cajero, &e, &[]).await, "descuento total gigante sin PIN");
    e.descuento_total = -5000;
    assert_eq!(cobrar(p, &cajero, &e, &[pago(EF, 1000)]).await.map(|r| r.vuelto), Ok(0), "descuento total negativo no recarga");
    // Producto de ¢0: se registra sin dinero, y con dinero se rechaza.
    let cero = est(vec![linea(Some(&gratis), 0, 2, 0)]);
    malo(cobrar(p, &cajero, &cero, &[pago(EF, 1000)]).await, "dinero en venta de ¢0");
    assert!(cobrar(p, &cajero, &cero, &[]).await.is_ok());
    // Dos efectivos: el vuelto sale completo y la caja solo sube por el total.
    let antes = esperado(p, &dueno).await;
    assert_eq!(cobrar(p, &cajero, &uno(), &[pago(EF, 300), pago(EF, 5000)]).await.map(|r| r.vuelto), Ok(4300));
    assert_eq!(esperado(p, &dueno).await, antes + 1000);
}

#[tokio::test]
async fn el_efectivo_esperado_nunca_queda_negativo() {
    let (bd, _, dueno, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    let pid = prod(p, 5000).await;
    caja::abrir(p, &cajero, CAJA_1, &Conteo { total: Some(0), ..Default::default() }).await.unwrap();
    let v = cobrar(p, &cajero, &est(vec![linea(Some(&pid), 5000, 1, 0)]), &[pago(EF, 5000)]).await.unwrap();
    // Sale de la caja todo lo que entró por esa venta…
    caja::movimiento(p, &cajero, CAJA_1, &salida(5000), None).await.unwrap();
    assert_eq!(esperado(p, &dueno).await, 0);
    // …y después se anula la venta (devolver ¢5.000 que ya no están) o se pasa a tarjeta.
    let pago_id: String = sqlx::query_scalar("SELECT id FROM venta_pagos WHERE venta_id = ?").bind(&v.venta_id).fetch_one(p).await.unwrap();
    let a_tarjeta = CambioPago { forma_pago_id: TJ.into(), banco_id: None, referencia: None, ultimos4: None };
    assert!(ventas::corregir_pago(p, &dueno, CAJA_1, &pago_id, &a_tarjeta, "era tarjeta", Some(PIN)).await.unwrap_err().contains("ya no queda ese efectivo"));
    assert!(ventas::anular(p, &dueno, CAJA_1, &v.venta_id, PIN, "cliente devolvió", 0).await.unwrap_err().contains("ya no queda ese efectivo"));
    assert_eq!(esperado(p, &dueno).await, 0);
    // Nada quedó a medias: la venta sigue completa y en efectivo.
    let (estado, forma): (String, String) = sqlx::query_as("SELECT v.estado, p.forma_pago_id FROM ventas v JOIN venta_pagos p ON p.venta_id = v.id WHERE v.id = ?").bind(&v.venta_id).fetch_one(p).await.unwrap();
    assert_eq!((estado.as_str(), forma.as_str()), ("completada", EF));
    // Con el efectivo de vuelta en la caja, sí.
    caja::movimiento(p, &cajero, CAJA_1, &NuevoMovimiento { tipo: "entrada".into(), monto: 5000, categoria: "Otro ingreso".into(), nota: String::new() }, None).await.unwrap();
    ventas::anular(p, &dueno, CAJA_1, &v.venta_id, PIN, "cliente devolvió", 0).await.unwrap();
    assert_eq!(esperado(p, &dueno).await, 0);
}

#[tokio::test]
async fn cierre_con_conteos_raros() {
    let (bd, _, dueno, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    caja::abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
    assert!(caja::cerrar(p, &cajero, CAJA_1, &Conteo { total: Some(-1), ..Default::default() }, "").await.is_err());
    assert!(caja::cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, -5)]), "").await.is_err());
    assert!(caja::cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 1_000_000_000)]), "").await.is_err());
    assert!(caja::movimiento(p, &cajero, CAJA_1, &salida(5001), None).await.is_err(), "salida mayor al efectivo");
    assert!(caja::movimiento(p, &cajero, CAJA_1, &salida(0), None).await.is_err());
    assert!(caja::movimiento(p, &cajero, CAJA_1, &salida(-100), None).await.is_err());
    // Conteo vacío: cierra en ¢0 (la pantalla lo muestra y pide confirmar) y queda marcado para revisión.
    let vacio = caja::cerrar(p, &cajero, CAJA_1, &Conteo::default(), "").await.unwrap();
    assert_eq!((vacio.contado, vacio.diferencia, vacio.requiere_revision), (0, Some(-5000), true));
    let _ = dueno;
}

#[tokio::test]
async fn descartar_una_venta_en_espera_con_productos() {
    let (bd, _, _, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    let pid = prod(p, 1000).await;
    let esp = ventas::crear_espera(p, &cajero, CAJA_1, &est(vec![linea(Some(&pid), 1000, 2, 0)])).await.unwrap();
    ventas::descartar_espera(p, &cajero, &esp.id).await.unwrap();
    assert!(ventas::listar_esperas(p, &cajero, CAJA_1).await.unwrap().is_empty());
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'venta_espera.descartar'").fetch_one(p).await.unwrap();
    assert_eq!(n, 1);
}
