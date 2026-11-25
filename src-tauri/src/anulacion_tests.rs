// Anulación por el cajero (DISENO-PERMISOS.md §3): opciones A, B y C, cada límite, reglas fijas,
// comprobante, sección del Z, aviso al dueño y bitácora. Reloj fijo (lunes 16 de noviembre de 2026).

use crate::acciones::{AlPasar, Limites, Nivel, Politica};
use crate::caja::{self, abrir, cerrar, detalle, tests::conteo, CAJA_1};
use crate::calculo::{ClienteBasico, Estado, Linea, PagoEntrada};
use crate::politica::{self, NECESITA_PIN};
use crate::sesion::Actor;
use crate::usuarios::tests::base_con_usuarios;
use crate::util::{fijar_reloj, ulid};
use crate::ventas::{anular, cobrar, crear_espera};
use crate::{cuentas, seguridad};
use sqlx::SqlitePool;

const DEP: &str = "00000000000000000000000D01";
const EF: &str = "0000000000000000000000FP01";
const PIN: &str = "246813";

async fn producto(p: &SqlitePool, precio: i64) -> String {
    let id = ulid();
    sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(format!("Cuaderno {precio}"))
        .bind(format!("cuaderno {precio} {id}"))
        .bind(DEP)
        .bind(precio)
        .execute(p)
        .await
        .unwrap();
    id
}

fn est(pid: &str, precio: i64) -> Estado {
    Estado { lineas: vec![Linea { id: ulid(), producto_id: Some(pid.into()), codigo: None, descripcion: "x".into(), departamento_id: DEP.into(), cantidad: 1, precio_unitario: precio, descuento: 0, descuento_catalogo: 0, tasa_iva: 13.0, exento: false }], ..Default::default() }
}

fn pago(m: i64) -> PagoEntrada {
    PagoEntrada { forma_pago_id: EF.into(), monto: m, banco_id: None, referencia: None, ultimos4: None, pagador: None }
}

async fn vender(p: &SqlitePool, a: &Actor, precio: i64) -> String {
    let pid = producto(p, precio).await;
    let e = est(&pid, precio);
    let esp = crear_espera(p, a, CAJA_1, &e).await.unwrap();
    cobrar(p, a, CAJA_1, &esp.id, &e, &[pago(precio)]).await.unwrap().venta_id
}

/// Opción C del cajero: hasta ¢10.000, 2 sin PIN por turno, solo el turno abierto, 30 minutos.
fn opcion_c(a: &Actor) -> Actor {
    politica::con(a, |d| {
        d.cajero.insert(
            "ventas.anular".into(),
            Politica { nivel: Nivel::Motivo, motivo: true, limites: Limites { monto_max: Some(10_000), cantidad_turno: Some(2), solo_turno_abierto: true, ventana_min: Some(30), pct_max: None, al_pasar: AlPasar::Pin } },
        );
    })
}

/// Cierra con el efectivo exacto; devuelve cuánto había.
async fn cerrar_exacto(p: &SqlitePool, dueno: &Actor) -> i64 {
    let t: String = sqlx::query_scalar("SELECT id FROM caja_turnos WHERE estado = 'abierto'").fetch_one(p).await.unwrap();
    let esperado = {
        let mut c = p.acquire().await.unwrap();
        let tt = caja::turno(&mut c, &t).await.unwrap().unwrap();
        caja::resumen(&mut c, &tt).await.unwrap().efectivo_esperado
    };
    cerrar(p, dueno, CAJA_1, &caja::Conteo { cantidades: Default::default(), total: Some(esperado) }, "").await.unwrap();
    esperado
}

fn pide_pin(r: Result<crate::ventas::Anulada, String>, por: &str) {
    let e = r.unwrap_err();
    assert!(e.starts_with(NECESITA_PIN) && e.contains(por), "{e}");
}

#[tokio::test]
async fn opcion_c_sin_pin_dentro_de_los_limites_y_pin_al_pasar_cada_uno() {
    let (bd, _, dueno, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    fijar_reloj("2026-11-16T10:00:00-06:00");
    let luis = opcion_c(&luis);
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 20)])).await.unwrap();

    // Chica, con motivo de la lista: sin PIN. Comprobante obligatorio; política C en la bitácora.
    let v1 = vender(p, &luis, 2000).await;
    assert!(anular(p, &luis, CAJA_1, &v1, "", "porque sí", 0).await.unwrap_err().contains("lista"));
    let r = anular(p, &luis, CAJA_1, &v1, "", "Error de digitación", 0).await.unwrap();
    assert!(r.sin_pin && r.comprobante && r.politica == "C" && r.usuario == "Luis" && r.total == 2000, "{r:?}");
    let (por, actor, pol): (String, String, String) = sqlx::query_as("SELECT anulada_por, anulada_actor, anulada_politica FROM ventas WHERE id = ?").bind(&v1).fetch_one(p).await.unwrap();
    assert_eq!((por.as_str(), actor.as_str(), pol.as_str()), (luis.id.as_str(), luis.id.as_str(), "C"));
    let det: String = sqlx::query_scalar("SELECT detalle FROM bitacora WHERE accion = 'venta.anular' ORDER BY rowid DESC LIMIT 1").fetch_one(p).await.unwrap();
    assert!(det.contains("\"politica\":\"C\"") && det.contains("\"sinPin\":true") && det.contains("\"version\""), "{det}");

    // «Otro» lleva texto.
    let v2 = vender(p, &luis, 1500).await;
    assert!(anular(p, &luis, CAJA_1, &v2, "", "Otro", 0).await.is_err());
    anular(p, &luis, CAJA_1, &v2, "", "Otro: cliente pagó con otra tarjeta", 0).await.unwrap();

    // Cantidad por turno: ya van 2 sin PIN.
    let v3 = vender(p, &luis, 1000).await;
    pide_pin(anular(p, &luis, CAJA_1, &v3, "", "Cobro duplicado", 0).await, "ya van 2");
    // Con el PIN del dueño sí; no cuenta como «sin PIN».
    let r = anular(p, &luis, CAJA_1, &v3, PIN, "Cobro duplicado", 0).await.unwrap();
    assert!(!r.sin_pin && r.politica == "C", "{r:?}");

    // Monto: más de ¢10.000 pide PIN (aunque no se haya llegado a la cantidad).
    let luis2 = politica::con(&luis, |d| d.cajero.get_mut("ventas.anular").unwrap().limites.cantidad_turno = None);
    let grande = vender(p, &luis2, 15_000).await;
    pide_pin(anular(p, &luis2, CAJA_1, &grande, "", "Error de digitación", 0).await, "10.000");
    // Un PIN equivocado no pasa.
    assert!(anular(p, &luis2, CAJA_1, &grande, "000000", "Error de digitación", 0).await.is_err());
    anular(p, &luis2, CAJA_1, &grande, PIN, "Error de digitación", 0).await.unwrap();

    // Ventana de tiempo: 31 minutos después de la venta.
    let tarde = vender(p, &luis2, 1000).await;
    fijar_reloj("2026-11-16T10:31:30-06:00");
    pide_pin(anular(p, &luis2, CAJA_1, &tarde, "", "Cliente desistió", 0).await, "30 minutos");

    // Facturada: siempre con PIN.
    let fac = vender(p, &luis2, 1000).await;
    sqlx::query("UPDATE ventas SET requiere_factura = 1, factura_emitida = 1, factura_referencia = 'FE-9' WHERE id = ?").bind(&fac).execute(p).await.unwrap();
    pide_pin(anular(p, &luis2, CAJA_1, &fac, "", "Cliente desistió", 0).await, "factura");

    // «Bloquear» en vez de pedir PIN.
    let luis3 = politica::con(&luis2, |d| d.cajero.get_mut("ventas.anular").unwrap().limites.al_pasar = AlPasar::Bloquear);
    let otra = vender(p, &luis3, 20_000).await;
    assert!(anular(p, &luis3, CAJA_1, &otra, PIN, "Error de digitación", 0).await.unwrap_err().starts_with("No se puede"));

    // Z: sección aparte con las sin PIN (2), con motivo y usuario; las otras siguen en «anuladas».
    let t: String = sqlx::query_scalar("SELECT id FROM caja_turnos WHERE estado = 'abierto'").fetch_one(p).await.unwrap();
    cerrar_exacto(p, &dueno).await;
    let d = detalle(p, &dueno, &t).await.unwrap();
    assert!(d.resumen.cuadra, "{:?}", d.resumen.descuadres);
    assert_eq!(d.resumen.anuladas, 4);
    let s: Vec<(&str, &str, &str)> = d.resumen.anulaciones_sin_pin.iter().map(|x| (x.motivo.as_str(), x.usuario.as_str(), x.numero.as_str())).collect();
    assert_eq!(s.len(), 2, "{s:?}");
    assert!(s.iter().all(|(_, u, _)| *u == "Luis"));
    assert_eq!(s[0].0, "Error de digitación");

    // Aviso al dueño: 2 sin PIN; al marcarlo visto, 0.
    let av = seguridad::avisos(p, &dueno).await.unwrap();
    assert_eq!(av["anulacionesSinPin"], 2);
    seguridad::anulaciones_vistas(p, &dueno).await.unwrap();
    assert_eq!(seguridad::avisos(p, &dueno).await.unwrap()["anulacionesSinPin"], 0);
    assert!(seguridad::anulaciones_vistas(p, &luis).await.is_err());
}

#[tokio::test]
async fn opcion_c_turno_cerrado_apartado_y_credito_con_abonos() {
    let (bd, _, dueno, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    fijar_reloj("2026-11-16T10:00:00-06:00");
    let luis = politica::con(&opcion_c(&luis), |d| d.cajero.get_mut("ventas.anular").unwrap().limites = Limites { monto_max: Some(100_000), ..Limites::NINGUNO });
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 20)])).await.unwrap();
    let vieja = vender(p, &luis, 1000).await;
    // Apartado liquidado: la venta no se anula aquí (ni con PIN).
    let cl = ClienteBasico { id: ulid(), nombre: "Marta Solís".into(), telefono: Some("88887777".into()), cedula: None };
    sqlx::query("INSERT INTO clientes (id, nombre, nombre_busqueda, telefono, consentimiento_datos, consentimiento_fecha, consentimiento_version) VALUES (?, 'Marta Solís', 'marta solis', '88887777', 1, '2026-11-01', '1')").bind(&cl.id).execute(p).await.unwrap();
    let pid = producto(p, 4000).await;
    let e = Estado { cliente: Some(cl), ..est(&pid, 4000) };
    let esp = crear_espera(p, &luis, CAJA_1, &e).await.unwrap();
    let ap = cuentas::crear_apartado(p, &luis, CAJA_1, &esp.id, &e, 2000, &[pago(2000)], &ulid()).await.unwrap();
    let liq = cuentas::abonar(p, &luis, CAJA_1, &ap.cuenta_id, 2000, &[pago(2000)], &ulid(), true).await.unwrap();
    let venta_apartado = liq.venta_id.unwrap();
    for pin in ["", PIN] {
        assert!(anular(p, &luis, CAJA_1, &venta_apartado, pin, "Error de digitación", 0).await.unwrap_err().contains("Apartados"));
    }
    // Turno cerrado: con PIN siempre.
    let quedan = cerrar_exacto(p, &dueno).await;
    fijar_reloj("2026-11-16T10:20:00-06:00");
    abrir(p, &luis, CAJA_1, &caja::Conteo { cantidades: Default::default(), total: Some(quedan) }).await.unwrap();
    pide_pin(anular(p, &luis, CAJA_1, &vieja, "", "Error de digitación", 0).await, "turno cerrado");
    // …y devolver más dinero del permitido también lo pediría (el turno cerrado ya lo pide).
    let r = anular(p, &luis, CAJA_1, &vieja, PIN, "Error de digitación", 0).await.unwrap();
    assert!(!r.sin_pin);
}

#[tokio::test]
async fn opciones_a_y_b_y_el_comprobante_opcional() {
    let (bd, tec, dueno, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    fijar_reloj("2026-11-16T10:00:00-06:00");
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 20)])).await.unwrap();
    // A (Normal): el cajero no anula, ni con el PIN del dueño; el dueño sí, con su PIN.
    let v = vender(p, &luis, 1000).await;
    assert!(anular(p, &luis, CAJA_1, &v, PIN, "Error de digitación", 0).await.unwrap_err().contains("permiso"));
    pide_pin(anular(p, &dueno, CAJA_1, &v, "", "Error de digitación", 0).await, "");
    let r = anular(p, &dueno, CAJA_1, &v, PIN, "Cualquier motivo del dueño", 0).await.unwrap();
    assert!(r.politica == "A" && !r.sin_pin && !r.comprobante, "{r:?}");
    // B: el cajero con PIN del dueño (y motivo de la lista).
    let b = politica::con(&luis, |d| {
        d.cajero.insert("ventas.anular".into(), Politica::PIN_MOTIVO);
    });
    let v = vender(p, &b, 1000).await;
    pide_pin(anular(p, &b, CAJA_1, &v, "", "Error de digitación", 0).await, "");
    let r = anular(p, &b, CAJA_1, &v, PIN, "Error de digitación", 0).await.unwrap();
    assert!(r.politica == "B" && !r.comprobante, "{r:?}");
    // Con la opción encendida, A y B también imprimen comprobante.
    let b2 = politica::con(&b, |d| d.comprobante_anulacion_ab = true);
    let v = vender(p, &b2, 1000).await;
    assert!(anular(p, &b2, CAJA_1, &v, PIN, "Cobro duplicado", 0).await.unwrap().comprobante);
    // Excepción por usuario: solo Fabricio anula sin PIN.
    let fab = crate::usuarios::crear(p, &tec, "Fabricio", crate::permisos::Rol::Cajero, "1593").await.unwrap();
    let fabricio = politica::con(&Actor::nuevo(fab.id.clone(), crate::permisos::Rol::Cajero, "Fabricio"), |d| {
        d.usuarios.insert(fab.id.clone(), [("ventas.anular".to_string(), Politica::MOTIVO)].into());
    });
    let ana_cajera = politica::con(&luis, |d| {
        d.usuarios.insert(fab.id.clone(), [("ventas.anular".to_string(), Politica::MOTIVO)].into());
    });
    let v = vender(p, &fabricio, 1000).await;
    assert!(anular(p, &ana_cajera, CAJA_1, &v, "", "Error de digitación", 0).await.unwrap_err().contains("permiso"));
    assert!(anular(p, &fabricio, CAJA_1, &v, "", "Error de digitación", 0).await.unwrap().sin_pin);
    assert!(!fabricio.puede("caja.corte"), "la excepción es solo para esa acción");
}

#[tokio::test]
async fn precio_libre_y_quitar_lineas_segun_la_politica() {
    let (bd, _, _, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    fijar_reloj("2026-11-16T10:00:00-06:00");
    abrir(p, &luis, CAJA_1, &conteo(&[(1000, 20)])).await.unwrap();
    let pid = producto(p, 6000).await;
    let libre = Linea { id: ulid(), producto_id: None, codigo: None, descripcion: "Servicio".into(), departamento_id: DEP.into(), cantidad: 1, precio_unitario: 500, descuento: 0, descuento_catalogo: 0, tasa_iva: 13.0, exento: false };
    // Sin precio libre: no se agrega ni se cobra.
    let sin = politica::con(&luis, |d| {
        d.cajero.remove("venta.precio_libre");
    });
    let esp = crear_espera(p, &sin, CAJA_1, &est(&pid, 6000)).await.unwrap();
    let mut con_libre = est(&pid, 6000);
    con_libre.lineas.push(libre.clone());
    assert!(crate::ventas::guardar_espera(p, &sin, &esp.id, &con_libre).await.unwrap_err().contains("permiso"));
    assert!(cobrar(p, &sin, CAJA_1, &esp.id, &con_libre, &[pago(6500)]).await.unwrap_err().contains("permiso"));
    // Con PIN: lo pide; con la autorización (de un solo uso) pasa.
    let con_pin = politica::con(&luis, |d| {
        d.cajero.insert("venta.precio_libre".into(), Politica::PIN);
    });
    assert!(crate::ventas::guardar_espera(p, &con_pin, &esp.id, &con_libre).await.unwrap_err().starts_with(NECESITA_PIN));
    let dueno_id: String = sqlx::query_scalar("SELECT id FROM usuarios WHERE rol = 'dueno'").fetch_one(p).await.unwrap();
    let autorizado = Actor {
        autorizaciones: vec![crate::sesion::Autorizacion { accion: "venta.precio_libre".into(), comando: String::new(), autorizo: Some(dueno_id), motivo: None, vence: crate::util::ahora() + chrono::Duration::minutes(1) }],
        ..con_pin.clone()
    };
    crate::ventas::guardar_espera(p, &autorizado, &esp.id, &con_libre).await.unwrap();
    // Quitar líneas: hasta ¢5.000 sin PIN; la de ¢6.000 lo pide (o no deja, con «bloquear»).
    let lim = politica::con(&luis, |d| {
        d.cajero.insert("venta.quitar_linea".into(), Politica { nivel: Nivel::Si, motivo: false, limites: Limites { monto_max: Some(5000), ..Limites::NINGUNO } });
    });
    let solo_libre = Estado { lineas: vec![libre.clone()], ..Default::default() };
    let e = crate::ventas::guardar_espera(p, &lim, &esp.id, &solo_libre).await.unwrap_err();
    assert!(e.starts_with(NECESITA_PIN) && e.contains("5.000"), "{e}");
    let bloq = politica::con(&lim, |d| d.cajero.get_mut("venta.quitar_linea").unwrap().limites.al_pasar = AlPasar::Bloquear);
    assert!(crate::ventas::guardar_espera(p, &bloq, &esp.id, &solo_libre).await.unwrap_err().starts_with("No se puede"));
    // Quitar la de ¢500 sí.
    let solo_producto = Estado { lineas: vec![con_libre.lineas[0].clone()], ..Default::default() };
    crate::ventas::guardar_espera(p, &lim, &esp.id, &solo_producto).await.unwrap();
}
