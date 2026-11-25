// Auditoría 0.9.4 (AUDITORIA-0.9.4.md): una prueba por cada crítico y alto, escrita ANTES de la
// corrección (reproduce el error), por IPC como la pantalla cuando el camino pasa por la puerta.
// C1 y C2 son además las pruebas de regresión de los dos críticos de la 0.9.3.

use crate::acciones::{AlPasar, Limites, Nivel, Politica};
use crate::permisos::Rol;
use crate::politica::{self, Datos, Vigente};
use crate::tabla_comandos::{prueba, Prueba};
use serde_json::{json, Value};
use std::sync::Arc;

const PIN: &str = "246813";
const DEP: &str = "00000000000000000000000D01";
const EF: &str = "0000000000000000000000FP01";

fn texto(r: &Result<Value, Value>) -> String {
    match r {
        Ok(_) => String::new(),
        Err(e) => e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string()),
    }
}

fn poner(p: &Prueba, f: impl FnOnce(&mut Datos)) {
    let st = p.st();
    let mut d = st.seg().datos.clone();
    f(&mut d);
    let v = st.seg().version + 1;
    *st.seguridad.write().unwrap() = Arc::new(Vigente { version: v, datos: d, rota_en: None });
}

fn bloquear<T>(f: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(f)
}

fn abrir_caja(p: &Prueba) {
    bloquear(crate::caja::abrir(p.st().pool().unwrap(), &p.dueno, crate::caja::CAJA_1, &crate::caja::tests::conteo(&[(1000, 1)]))).unwrap();
}

fn producto(p: &Prueba, precio: i64) -> String {
    let id = crate::util::ulid();
    bloquear(sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, ?, ?, ?, ?)").bind(&id).bind(format!("Artículo {precio}")).bind(format!("articulo {precio} {id}")).bind(DEP).bind(precio).execute(p.st().pool().unwrap())).unwrap();
    id
}

fn linea(pid: Option<&str>, precio: i64, cantidad: i64, descuento: i64) -> Value {
    json!({"id": crate::util::ulid(), "productoId": pid, "descripcion": "Artículo", "departamentoId": DEP, "cantidad": cantidad, "precioUnitario": precio, "descuento": descuento, "tasaIva": 13.0, "exento": false})
}

fn estado(lineas: Vec<Value>) -> Value {
    json!({"lineas": lineas, "descuentoTotal": 0, "requiereFactura": false})
}

fn efectivo(m: i64) -> Value {
    json!([{"formaPagoId": EF, "monto": m}])
}

// ─────────── Críticos ───────────

/// C1 (regresión 0.9.3): «PIN» o «motivo» en una acción que no los puede aplicar valían como «sí».
#[test]
fn c1_un_nivel_que_la_accion_no_aplica_no_vale_como_si() {
    let p = prueba();
    abrir_caja(&p);
    // Ver totales no puede pedir PIN (es un sí/no al mostrar la pantalla): no se guarda…
    p.como(Some(&p.dueno));
    let mut d = p.st().seg().datos.clone();
    d.cajero.insert("caja.ver_totales".into(), Politica::PIN);
    d.ver_totales_confirmado = true;
    let r = p.llamar("seguridad_guardar", json!({"datos": d, "motivo": "", "pin": PIN}));
    assert!(texto(&r).contains("no se puede pedir"), "{r:?}");
    // …y si llega igual (una versión vieja), vale como «no», nunca como «sí».
    assert_eq!(politica::efectiva(&d, &p.cajero.id, Rol::Cajero, "caja.ver_totales").nivel, Nivel::No);
    // «Motivo» en salidas pide el motivo (antes pedía el PIN).
    poner(&p, |d| {
        d.cajero.insert("caja.salida".into(), Politica::MOTIVO);
    });
    p.como(Some(&p.cajero));
    let r = p.llamar("caja_movimiento", json!({"movimiento": {"tipo": "salida", "monto": 100, "categoria": "Gasto menor"}}));
    assert!(texto(&r).starts_with("NECESITA_MOTIVO"), "{r:?}");
    // «Motivo» en descuentos lo pide al cobrar (antes valía como «sí»).
    poner(&p, |d| {
        d.cajero.insert("venta.descuento".into(), Politica::MOTIVO);
    });
    let pid = producto(&p, 1000);
    let e = estado(vec![linea(Some(&pid), 1000, 1, 100)]);
    let esp = p.llamar("venta_espera_crear", json!({"estado": e})).unwrap();
    let r = p.llamar("venta_cobrar", json!({"esperaId": esp["id"], "estado": e, "pagos": efectivo(900)}));
    assert!(texto(&r).starts_with("NECESITA_MOTIVO"), "{r:?}");
}

/// C2 (regresión 0.9.3): precio libre y quitar líneas con PIN se saltaban al cobrar.
#[test]
fn c2_lo_que_pide_pin_en_la_venta_se_revisa_al_cobrar() {
    let p = prueba();
    abrir_caja(&p);
    poner(&p, |d| {
        d.cajero.insert("venta.precio_libre".into(), Politica::PIN);
        d.cajero.insert("venta.quitar_linea".into(), Politica::PIN);
    });
    p.como(Some(&p.cajero));
    let pid = producto(&p, 2000);
    let con_producto = linea(Some(&pid), 2000, 1, 0);
    let esp = p.llamar("venta_espera_crear", json!({"estado": estado(vec![con_producto.clone()])})).unwrap();
    // F4 → precio libre → pide PIN → Cancelar: la línea queda en pantalla pero no se guardó.
    let libre = linea(None, 500, 1, 0);
    let e = estado(vec![con_producto.clone(), libre.clone()]);
    assert!(texto(&p.llamar("venta_espera_guardar", json!({"id": esp["id"], "estado": e}))).starts_with("NECESITA_PIN"));
    // F12: no se cobra sin el PIN.
    let r = p.llamar("venta_cobrar", json!({"esperaId": esp["id"], "estado": e, "pagos": efectivo(2500)}));
    assert!(texto(&r).starts_with("NECESITA_PIN"), "{r:?}");
    // Tampoco apartando ni guardando como proforma, ni creando la pestaña ya con la línea.
    let r = p.llamar("proforma_guardar", json!({"esperaId": esp["id"], "estado": e}));
    assert!(texto(&r).starts_with("NECESITA_PIN"), "{r:?}");
    let r = p.llamar("venta_espera_crear", json!({"estado": estado(vec![libre.clone()])}));
    assert!(texto(&r).starts_with("NECESITA_PIN"), "{r:?}");
    // Quitar una línea ya guardada (con PIN) y cobrar sin ella: lo pide.
    let otra = linea(Some(&pid), 2000, 1, 0);
    p.llamar("venta_espera_guardar", json!({"id": esp["id"], "estado": estado(vec![con_producto.clone(), otra.clone()])})).unwrap();
    let r = p.llamar("venta_cobrar", json!({"esperaId": esp["id"], "estado": estado(vec![con_producto.clone()]), "pagos": efectivo(2000)}));
    assert!(texto(&r).starts_with("NECESITA_PIN"), "{r:?}");
    // Con el PIN del dueño para ESE cobro, pasa.
    p.llamar("seguridad_autorizar", json!({"accion": "venta.quitar_linea", "pin": PIN, "comando": "venta_cobrar"})).unwrap();
    p.llamar("venta_cobrar", json!({"esperaId": esp["id"], "estado": estado(vec![con_producto]), "pagos": efectivo(2000)})).unwrap();
}

/// C3 (D1): el técnico no crea ni restablece un dueño si ya hay uno con su PIN.
#[test]
fn c3_el_tecnico_no_se_hace_dueno() {
    let p = prueba();
    p.como(Some(&p.tec));
    let r = p.llamar("usuarios_crear", json!({"nombre": "Falso", "rol": "dueno", "pin": "864209"}));
    assert!(r.is_err(), "creó un dueño");
    let r = p.llamar("usuarios_cambiar_pin", json!({"id": p.dueno.id, "pin": "802468"}));
    assert!(r.is_err(), "le cambió el PIN al dueño");
}

/// C4 (D2): cambiar el PIN propio pide el actual.
#[test]
fn c4_cambiar_el_pin_propio_pide_el_actual() {
    let p = prueba();
    p.como(Some(&p.dueno));
    assert!(p.llamar("usuarios_cambiar_pin", json!({"id": p.dueno.id, "pin": "135792"})).is_err());
    assert!(p.llamar("usuarios_cambiar_pin", json!({"id": p.dueno.id, "pin": "135792", "actual": "000000"})).is_err());
    p.llamar("usuarios_cambiar_pin", json!({"id": p.dueno.id, "pin": "135792", "actual": PIN})).unwrap();
}

/// C5 (D5): la autorización de descuento vale para ESA venta, su contenido y su monto.
#[test]
fn c5_la_autorizacion_de_descuento_no_sirve_para_otro_carrito() {
    let p = prueba();
    abrir_caja(&p);
    p.como(Some(&p.cajero));
    let barato = producto(&p, 2000);
    let caro = producto(&p, 200_000);
    let l1 = linea(Some(&barato), 2000, 1, 1000);
    let e1 = estado(vec![l1.clone()]);
    let esp = p.llamar("venta_espera_crear", json!({"estado": e1})).unwrap();
    let aut = p.llamar("venta_autorizar_descuento", json!({"esperaId": esp["id"], "estado": e1, "pin": PIN})).unwrap();
    assert_eq!(aut["monto"], 1000, "{aut}");
    // Se agrega algo caro con 50 % después de la autorización: no vale.
    let mut e2 = estado(vec![l1, linea(Some(&caro), 200_000, 1, 100_000)]);
    e2["autorizacion"] = json!({"duenoId": aut["duenoId"], "pct": aut["pct"], "token": aut["token"]});
    let r = p.llamar("venta_cobrar", json!({"esperaId": esp["id"], "estado": e2, "pagos": efectivo(101_000)}));
    assert!(r.is_err(), "cobró ¢101.000 de descuento con la autorización de ¢1.000");
    // Con el mismo contenido, sí (una vez).
    let mut e1b = e1.clone();
    e1b["autorizacion"] = e2["autorizacion"].clone();
    p.llamar("venta_cobrar", json!({"esperaId": esp["id"], "estado": e1b, "pagos": efectivo(1000)})).unwrap();
}

// ─────────── Altos ───────────

/// A1: con la cadena rota, guardar falla con un error claro (antes decía «guardado» y no aplicaba).
#[test]
fn a1_cadena_rota_guardar_falla_claro() {
    let p = prueba();
    let pool = p.st().pool().unwrap().clone();
    bloquear(sqlx::query("INSERT INTO seguridad_versiones (id, creada_en, motivo, datos, hash_anterior, hash) VALUES (2, '2026-01-01', 'x', '{}', 'malo', ?)").bind("0".repeat(64)).execute(&pool)).unwrap();
    bloquear(p.st().recargar_seguridad()).unwrap();
    p.como(Some(&p.dueno));
    let mut d = p.st().seg().datos.clone();
    d.cajero.remove("venta.descartar_espera");
    let r = p.llamar("seguridad_guardar", json!({"datos": d, "motivo": "x"}));
    assert!(texto(&r).contains("alterad"), "{r:?}");
}

/// A2: «0 por turno» en la no venta = siempre PIN.
#[test]
fn a2_cero_por_turno_siempre_pide_pin() {
    let p = prueba();
    abrir_caja(&p);
    poner(&p, |d| {
        d.cajero.insert("caja.no_venta".into(), Politica { limites: Limites { cantidad_turno: Some(0), ..Limites::NINGUNO }, ..Politica::SI });
    });
    p.como(Some(&p.cajero));
    let r = p.llamar("gaveta_no_venta", json!({"motivo": "Cambio de billetes", "nota": ""}));
    assert!(texto(&r).contains("PIN"), "{r:?}");
}

/// A4: la misma entrada de mercadería dos veces (doble clic) queda una sola.
#[test]
fn a4_entrada_de_mercaderia_idempotente() {
    let p = prueba();
    p.como(Some(&p.dueno));
    let pid = producto(&p, 1000);
    let en = json!({"entrada": {"fecha": "2026-01-01", "operacionId": "OP-ENTRADA-1", "lineas": [{"productoId": pid, "cantidad": 5, "costoUnitario": 400}]}});
    let a = p.llamar("inventario_entrada", en.clone()).unwrap();
    let b = p.llamar("inventario_entrada", en).unwrap();
    assert_eq!(a, b);
    let n: i64 = bloquear(sqlx::query_scalar("SELECT COUNT(*) FROM inventario_entradas").fetch_one(p.st().pool().unwrap())).unwrap();
    assert_eq!(n, 1);
}

/// A5 (D3): F10 no lista todos los apartados ni deja adivinar cédulas.
#[test]
fn a5_buscar_cuentas_pide_un_dato() {
    let p = prueba();
    p.como(Some(&p.cajero));
    for q in ["", "ab", "%", "1-0"] {
        let r = p.llamar("cuenta_buscar", json!({"texto": q}));
        assert!(r.is_err() || r.as_ref().unwrap().as_array().is_some_and(Vec::is_empty), "{q}: {r:?}");
        assert!(r.is_err() || q == "%", "{q}: debía pedir un dato");
    }
}

/// A6: el dueño nunca queda frenado por el «no deja» del cajero: con su PIN pasa.
#[test]
fn a6_el_dueno_no_queda_bloqueado_por_la_politica_del_cajero() {
    let mut d = politica::plantilla_normal();
    d.cajero.insert("caja.salida".into(), Politica { limites: Limites { monto_max: Some(1000), al_pasar: AlPasar::Bloquear, ..Limites::NINGUNO }, ..Politica::SI });
    assert_eq!(politica::efectiva(&d, "d", Rol::Dueno, "caja.salida").limites.al_pasar, AlPasar::Pin);
}

// ─────────── Medios ───────────

/// M3: por bd_lote la pantalla solo anota en la bitácora lo de sus cambios de catálogo.
#[test]
fn m3_la_pantalla_no_escribe_cualquier_cosa_en_la_bitacora() {
    let p = prueba();
    p.como(Some(&p.dueno));
    for accion in ["aviso.anulaciones_visto", "permiso.autorizado", "seguridad.cambiar", "respaldo.usb_confirmado"] {
        let r = p.llamar("bd_lote", json!({"ops": [{"id": "bitacora.registrar", "params": [null, accion, "x", null, "{}"]}]}));
        assert!(texto(&r).contains("No tiene permiso"), "{accion}: {r:?}");
    }
    p.llamar("bd_lote", json!({"ops": [{"id": "bitacora.registrar", "params": [null, "producto.precio", "producto", null, "{}"]}]})).unwrap();
}

/// M1: la autorización de un solo uso es del comando que la pidió (otro comando no la gasta).
#[test]
fn m1_la_autorizacion_es_del_comando_que_la_pidio() {
    let p = prueba();
    abrir_caja(&p);
    poner(&p, |d| {
        d.cajero.insert("venta.descartar_espera".into(), Politica::PIN);
    });
    p.como(Some(&p.cajero));
    let esp = p.llamar("venta_espera_crear", json!({"estado": estado(vec![])})).unwrap();
    p.llamar("seguridad_autorizar", json!({"accion": "venta.descartar_espera", "pin": PIN, "comando": "venta_espera_descartar"})).unwrap();
    // Un comando del medio (la pantalla consulta faltantes) no la gasta.
    p.llamar("venta_faltantes", json!({"lineas": []})).unwrap();
    p.llamar("venta_espera_descartar", json!({"id": esp["id"]})).unwrap();
    // Y no sirve dos veces.
    assert!(texto(&p.llamar("venta_espera_descartar", json!({"id": esp["id"]}))).starts_with("NECESITA_PIN"));
}

/// M6: si el reloj de Windows se atrasa, la sesión se bloquea (no queda abierta hasta alcanzar la hora).
#[test]
fn m6_reloj_hacia_atras_bloquea() {
    let s = crate::sesion::Sesion::default();
    let seg = politica::normal();
    crate::util::fijar_reloj("2026-11-24T10:00:00-06:00");
    bloquear(s.iniciar(crate::sesion::Actor::nuevo("c", Rol::Cajero, "Luis")));
    crate::util::fijar_reloj("2026-11-24T08:00:00-06:00");
    assert!(bloquear(s.estado(&seg)).unwrap().bloqueada);
}
