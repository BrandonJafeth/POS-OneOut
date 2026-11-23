// Proformas: no tocan dinero, inventario ni Z; numeración propia; conversión una sola vez con la regla
// de precios; versiones; nombre escrito que se borra solo.
use super::*;
use crate::caja::{abrir, cerrar, datos_z, tests::conteo, CAJA_1};
use crate::calculo::{ClienteBasico, PagoEntrada};
use crate::permisos::Rol;
use crate::usuarios::tests::base_con_usuarios;
use crate::util::fijar_reloj;
use crate::ventas::{cobrar, crear_espera};

const DEP: &str = "00000000000000000000000D01";
const EF: &str = "0000000000000000000000FP01";

async fn producto(p: &SqlitePool, nombre: &str, precio: i64, existencia: i64) -> String {
    let id = ulid();
    sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio, controla_inventario) VALUES (?, ?, ?, ?, ?, 1)")
        .bind(&id)
        .bind(nombre)
        .bind(format!("{} {id}", nombre.to_lowercase()))
        .bind(DEP)
        .bind(precio)
        .execute(p)
        .await
        .unwrap();
    sqlx::query("UPDATE productos SET controla_inventario = 1 WHERE id = ?").bind(&id).execute(p).await.unwrap();
    if existencia > 0 {
        let mut c = p.acquire().await.unwrap();
        let s = crate::inventario::sucursal_de(&mut c, CAJA_1).await.unwrap();
        let tec: String = sqlx::query_scalar("SELECT id FROM usuarios LIMIT 1").fetch_one(&mut *c).await.unwrap();
        crate::inventario::mover(&mut c, &crate::inventario::Mov { producto_id: &id, sucursal_id: &s, tipo: "inicial", cantidad: existencia, costo: None, motivo: "", ref_tipo: None, ref_id: None, usuario_id: &tec, turno_id: None, fecha: &ahora_iso() })
            .await
            .unwrap();
    }
    id
}

async fn hay(p: &SqlitePool, pid: &str) -> i64 {
    let mut c = p.acquire().await.unwrap();
    let s = crate::inventario::sucursal_de(&mut c, CAJA_1).await.unwrap();
    crate::inventario::existencia(&mut c, pid, &s).await.unwrap()
}

fn linea(pid: &str, nombre: &str, precio: i64, cantidad: i64) -> Linea {
    Linea { id: ulid(), producto_id: Some(pid.into()), codigo: None, descripcion: nombre.into(), departamento_id: DEP.into(), cantidad, precio_unitario: precio, descuento: 0, descuento_catalogo: 0, tasa_iva: 13.0, exento: false }
}

fn pago(m: i64) -> PagoEntrada {
    PagoEntrada { forma_pago_id: EF.into(), monto: m, banco_id: None, referencia: None, ultimos4: None, pagador: None }
}

/// Una venta en espera con esas líneas, guardada como proforma.
async fn proforma(p: &SqlitePool, a: &Actor, est: &Estado) -> (String, ProformaDetalle) {
    let esp = crear_espera(p, a, CAJA_1, est).await.unwrap();
    let d = guardar(p, a, CAJA_1, &esp.id, est, None).await.unwrap();
    (esp.id, d)
}

fn ligada(est: &Estado, d: &ProformaDetalle) -> Estado {
    Estado { proforma: Some(ProformaRef { id: d.proforma.id.clone(), numero: d.proforma.numero.clone() }), ..est.clone() }
}

#[tokio::test]
async fn una_proforma_no_toca_dinero_inventario_ni_z_y_tiene_su_propio_consecutivo() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    fijar_reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, "Cuaderno", 1500, 10).await;
    let est = Estado { lineas: vec![linea(&pid, "Cuaderno", 1500, 4)], ..Default::default() };
    // Sin caja abierta se puede cotizar.
    let (_, d1) = proforma(p, &luis, &est).await;
    let (_, d2) = proforma(p, &luis, &est).await;
    assert_eq!((d1.proforma.numero.as_str(), d2.proforma.numero.as_str(), d1.proforma.total), ("P-0001", "P-0002", 6000));
    assert_eq!(d1.proforma.estado, "vigente");
    // Vence en 8 días de trabajo (sin domingos): martes 25.
    assert_eq!(d1.proforma.vence, "2026-11-25");
    assert_eq!(hay(p, &pid).await, 10);
    let ventas: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ventas").fetch_one(p).await.unwrap();
    assert_eq!(ventas, 0);
    // El tiquete sigue su propio consecutivo; el Z no ve las proformas.
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
    let antes: i64 = sqlx::query_scalar("SELECT consecutivo_siguiente FROM cajas").fetch_one(p).await.unwrap();
    proforma(p, &luis, &est).await;
    let despues: i64 = sqlx::query_scalar("SELECT consecutivo_siguiente FROM cajas").fetch_one(p).await.unwrap();
    assert_eq!(antes, despues);
    let t: String = sqlx::query_scalar("SELECT id FROM caja_turnos WHERE estado = 'abierto'").fetch_one(p).await.unwrap();
    cerrar(p, &ana, CAJA_1, &conteo(&[(1000, 5)]), "").await.unwrap();
    let (z, _) = datos_z(p, &ana, &t).await.unwrap();
    assert_eq!((z.resumen.ventas, z.resumen.total_ventas, z.resumen.efectivo_esperado), (0, 0, 5000));
    let rep = crate::reportes::ventas(p, &ana, "2026-11-16", "2026-11-16").await.unwrap();
    assert_eq!(rep.totales.ventas, 0);
    // El técnico no entra.
    let tec = Actor { rol: Rol::Tecnico, ..luis.clone() };
    assert!(buscar(p, &tec, "", "").await.is_err());
}

#[tokio::test]
async fn convertir_respeta_el_precio_de_la_proforma_y_solo_una_vez() {
    let (bd, _, _, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    fijar_reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, "Mochila", 20000, 3).await;
    let est = Estado { lineas: vec![linea(&pid, "Mochila", 20000, 1)], ..Default::default() };
    let (_, d) = proforma(p, &luis, &est).await;
    // El precio sube después de cotizar.
    sqlx::query("UPDATE productos SET precio = 25000 WHERE id = ?").bind(&pid).execute(p).await.unwrap();
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
    let ab = abrir_en_venta(p, &luis, &d.proforma.id).await.unwrap();
    assert!(!ab.vencida && ab.avisos.is_empty());
    assert_eq!(ab.estado.lineas[0].precio_unitario, 20000);
    // Se cobra al precio de la proforma, y queda convertida y ligada.
    let esp = crear_espera(p, &luis, CAJA_1, &ab.estado).await.unwrap();
    let r = cobrar(p, &luis, CAJA_1, &esp.id, &ab.estado, &[pago(20000)]).await.unwrap();
    let total: i64 = sqlx::query_scalar("SELECT total FROM ventas WHERE id = ?").bind(&r.venta_id).fetch_one(p).await.unwrap();
    assert_eq!(total, 20000);
    let x = obtener(p, &luis, &d.proforma.id).await.unwrap();
    assert_eq!((x.proforma.estado.as_str(), x.proforma.convertida_en.is_some()), ("convertida", true));
    assert_eq!(hay(p, &pid).await, 2);
    // Otra pestaña con la misma proforma (reabierta, doble clic): no se convierte otra vez.
    let esp2 = crear_espera(p, &luis, CAJA_1, &ab.estado).await.unwrap();
    let err = cobrar(p, &luis, CAJA_1, &esp2.id, &ab.estado, &[pago(20000)]).await.unwrap_err();
    assert!(err.contains("convertida"), "{err}");
    assert!(abrir_en_venta(p, &luis, &d.proforma.id).await.is_err());
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ventas WHERE proforma_id = ?").bind(&d.proforma.id).fetch_one(p).await.unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn con_precio_actual_o_vencida_se_cobra_el_precio_de_hoy_con_aviso() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    fijar_reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, "Mochila", 20000, 3).await;
    let est = Estado { lineas: vec![linea(&pid, "Mochila", 20000, 1)], ..Default::default() };
    let (_, d) = proforma(p, &luis, &est).await;
    sqlx::query("UPDATE productos SET precio = 25000 WHERE id = ?").bind(&pid).execute(p).await.unwrap();
    // Opción "actual": vigente, pero al precio de hoy, con aviso por línea.
    config::guardar(p, &ana, "proforma_precio_al_convertir", &json!("actual")).await.unwrap();
    let ab = abrir_en_venta(p, &luis, &d.proforma.id).await.unwrap();
    assert_eq!((ab.estado.lineas[0].precio_unitario, ab.avisos.len()), (25000, 1));
    assert!(ab.avisos[0].contains("¢20.000") && ab.avisos[0].contains("¢25.000"), "{:?}", ab.avisos);
    // Con precio de la proforma en esa opción, Rust no lo acepta.
    config::guardar(p, &ana, "proforma_precio_al_convertir", &json!("proforma")).await.unwrap();
    // Vencida: siempre el precio de hoy, aunque la opción sea "proforma".
    fijar_reloj("2026-12-01T10:00:00-06:00");
    let ab = abrir_en_venta(p, &luis, &d.proforma.id).await.unwrap();
    assert!(ab.vencida);
    assert_eq!(ab.estado.lineas[0].precio_unitario, 25000);
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
    let viejo = ligada(&est, &d); // líneas al precio viejo
    let esp = crear_espera(p, &luis, CAJA_1, &viejo).await.unwrap();
    assert!(cobrar(p, &luis, CAJA_1, &esp.id, &viejo, &[pago(20000)]).await.unwrap_err().contains("precio cambió"));
    let esp = crear_espera(p, &luis, CAJA_1, &ab.estado).await.unwrap();
    cobrar(p, &luis, CAJA_1, &esp.id, &ab.estado, &[pago(25000)]).await.unwrap();
    assert_eq!(obtener(p, &luis, &d.proforma.id).await.unwrap().proforma.estado, "convertida");
}

#[tokio::test]
async fn una_venta_cambiada_no_se_liga_sin_decidir_y_descartar_la_deja_vigente() {
    let (bd, _, _, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    fijar_reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, "Lápiz", 500, 50).await;
    let est = Estado { lineas: vec![linea(&pid, "Lápiz", 500, 10)], ..Default::default() };
    let (esp_id, d) = proforma(p, &luis, &est).await;
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
    // La pestaña sigue abierta y ligada; se cambia la cantidad.
    let cambiada = Estado { lineas: vec![linea(&pid, "Lápiz", 500, 12)], ..ligada(&est, &d) };
    let err = cobrar(p, &luis, CAJA_1, &esp_id, &cambiada, &[pago(6000)]).await.unwrap_err();
    assert!(err.starts_with(NO_COINCIDE) && err.contains("P-0001"), "{err}");
    // Opción 1: versión nueva (P-0001-2) y cobrar ligada a ella.
    let v2 = guardar(p, &luis, CAJA_1, &esp_id, &cambiada, Some(&d.proforma.id)).await.unwrap();
    assert_eq!(v2.proforma.numero, "P-0001-2");
    assert_eq!(obtener(p, &luis, &d.proforma.id).await.unwrap().proforma.estado, "reemplazada");
    let con_v2 = ligada(&cambiada, &v2);
    cobrar(p, &luis, CAJA_1, &esp_id, &con_v2, &[pago(6000)]).await.unwrap();
    assert_eq!(obtener(p, &luis, &v2.proforma.id).await.unwrap().proforma.estado, "convertida");
    // Una reemplazada no se pasa a venta.
    assert!(abrir_en_venta(p, &luis, &d.proforma.id).await.is_err());
    // Opción 2: cobrar sin ligar; y descartar la pestaña deja la proforma vigente.
    let (_, d3) = proforma(p, &luis, &est).await;
    let sin_ligar = Estado { lineas: vec![linea(&pid, "Lápiz", 500, 3)], ..Default::default() };
    let esp = crear_espera(p, &luis, CAJA_1, &sin_ligar).await.unwrap();
    cobrar(p, &luis, CAJA_1, &esp.id, &sin_ligar, &[pago(1500)]).await.unwrap();
    assert_eq!(obtener(p, &luis, &d3.proforma.id).await.unwrap().proforma.estado, "vigente");
    // Cobrar sin cambios la convierte (también desde la misma pestaña que la guardó).
    let esp = crear_espera(p, &luis, CAJA_1, &ligada(&est, &d3)).await.unwrap();
    cobrar(p, &luis, CAJA_1, &esp.id, &ligada(&est, &d3), &[pago(5000)]).await.unwrap();
    assert_eq!(obtener(p, &luis, &d3.proforma.id).await.unwrap().proforma.estado, "convertida");
}

#[tokio::test]
async fn apartar_tambien_la_convierte() {
    let (bd, _, _, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    fijar_reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, "Retablo", 20000, 2).await;
    let cid = ulid();
    sqlx::query("INSERT INTO clientes (id, nombre, nombre_busqueda, telefono, consentimiento_datos, consentimiento_fecha, consentimiento_version) VALUES (?, 'Marta Solís', 'marta solis', '88887777', 1, '2026-11-01', '1')")
        .bind(&cid)
        .execute(p)
        .await
        .unwrap();
    let cl = ClienteBasico { id: cid, nombre: "Marta Solís".into(), telefono: None, cedula: None };
    let est = Estado { lineas: vec![linea(&pid, "Retablo", 20000, 1)], cliente: Some(cl), ..Default::default() };
    let (esp, d) = proforma(p, &luis, &est).await;
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
    let r = cuentas::crear_apartado(p, &luis, CAJA_1, &esp, &ligada(&est, &d), 10000, &[pago(10000)], &ulid()).await.unwrap();
    let x = obtener(p, &luis, &d.proforma.id).await.unwrap();
    assert_eq!((x.proforma.estado.as_str(), x.proforma.convertida_en.as_deref()), ("convertida", Some(r.numero.as_str())));
}

#[tokio::test]
async fn anular_es_del_dueno_y_el_nombre_escrito_se_borra_solo() {
    let (bd, _, ana, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    fijar_reloj("2026-11-16T10:00:00-06:00");
    let pid = producto(p, "Flores", 15000, 0).await;
    let est = Estado { lineas: vec![linea(&pid, "Flores", 15000, 1)], nombre_tiquete: Some("Pedro Vargas".into()), ..Default::default() };
    let (_, d) = proforma(p, &luis, &est).await;
    assert_eq!(d.proforma.cliente.as_deref(), Some("Pedro Vargas"));
    assert_eq!(buscar(p, &luis, "pedro", "").await.unwrap().len(), 1);
    assert!(anular(p, &luis, &d.proforma.id, "El cliente desistió").await.unwrap_err().contains("permiso"));
    anular(p, &ana, &d.proforma.id, "El cliente desistió").await.unwrap();
    assert!(abrir_en_venta(p, &luis, &d.proforma.id).await.is_err());
    // El nombre no va a la bitácora ni al reporte.
    let bit: Vec<String> = sqlx::query_scalar("SELECT detalle FROM bitacora WHERE entidad = 'proforma'").fetch_all(p).await.unwrap();
    assert!(bit.iter().all(|x| !x.contains("Pedro")), "{bit:?}");
    let rep = reporte(p, &ana, "2026-11-16", "2026-11-16").await.unwrap();
    assert_eq!((rep.emitidas.cantidad, rep.anuladas.cantidad, rep.filas[0].cliente.clone()), (1, 1, None));
    // 29 días después todavía se reimprime con el nombre; a los 30, ya no.
    fijar_reloj("2026-12-15T10:00:00-06:00");
    assert_eq!(obtener(p, &luis, &d.proforma.id).await.unwrap().proforma.cliente.as_deref(), Some("Pedro Vargas"));
    fijar_reloj("2026-12-16T10:00:00-06:00");
    assert_eq!(obtener(p, &luis, &d.proforma.id).await.unwrap().proforma.cliente, None);
    let queda: Option<String> = sqlx::query_scalar("SELECT nombre FROM proformas").fetch_one(p).await.unwrap();
    assert_eq!(queda, None);
}

/// Las mismas reglas que la pantalla (tests/proformas.test.ts), con los mismos casos.
#[test]
fn reglas_iguales_que_en_la_pantalla() {
    let c: serde_json::Value = serde_json::from_str(include_str!("../../tests/casos/proformas.json")).unwrap();
    let lineas = |v: &serde_json::Value| -> Vec<(Option<String>, String, i64, i64)> {
        v.as_array().unwrap().iter().map(|l| (l[0].as_str().map(String::from), l[1].as_str().unwrap().into(), l[2].as_i64().unwrap(), l[3].as_i64().unwrap())).collect()
    };
    for x in c["coincide"].as_array().unwrap() {
        let est = Estado {
            lineas: lineas(&x["venta"]).into_iter().map(|(p, d, n, desc)| Linea { producto_id: p, descripcion: d, cantidad: n, descuento: desc, ..linea("x", "x", 1, 1) }).collect(),
            descuento_total: x["ventaDesc"].as_i64().unwrap(),
            ..Default::default()
        };
        assert_eq!(coincide(&est, &lineas(&x["proforma"]), x["proformaDesc"].as_i64().unwrap()), x["ok"].as_bool().unwrap(), "{}", x["nombre"]);
    }
    for x in c["numero"].as_array().unwrap() {
        assert_eq!(numero(x["consecutivo"].as_i64().unwrap(), x["version"].as_i64().unwrap()), x["esperado"].as_str().unwrap());
    }
}

#[test]
fn numeros_y_estados() {
    assert_eq!((numero(12, 1), numero(12, 2)), ("P-0012".to_string(), "P-0012-2".to_string()));
    let hoy = NaiveDate::from_ymd_opt(2026, 11, 20).unwrap();
    assert_eq!(estado_visible("vigente", "2026-11-20", hoy), "vigente");
    assert_eq!(estado_visible("vigente", "2026-11-19", hoy), "vencida");
    assert_eq!(estado_visible("convertida", "2026-11-19", hoy), "convertida");
}
