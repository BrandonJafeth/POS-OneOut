// Permisos configurables por IPC (como la pantalla, llamando directo a los comandos): cada comando
// × cada rol × cada política, excepciones, cambios con la sesión abierta, volver a una versión,
// reglas fijas, bloqueo por inactividad y que el bloqueo no pierda trabajo.

use crate::acciones::{self, Destino, Nivel, Politica};
use crate::permisos::Rol;
use crate::politica::{self, Datos, Vigente};
use crate::sesion::Actor;
use crate::tabla_comandos::{llamadas, prueba, Prueba};
use serde_json::{json, Value};
use std::sync::Arc;

const PIN: &str = "246813";

fn texto(r: &Result<Value, Value>) -> String {
    match r {
        Ok(_) => String::new(),
        Err(e) => e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string()),
    }
}

fn negado(r: &Result<Value, Value>) -> bool {
    texto(r).contains("No tiene permiso")
}

/// Cambia la configuración en memoria (como si se hubiera guardado una versión).
fn poner(p: &Prueba, f: impl FnOnce(&mut Datos)) {
    let st = p.st();
    let mut d = st.seg().datos.clone();
    f(&mut d);
    let v = st.seg().version + 1;
    *st.seguridad.write().unwrap() = Arc::new(Vigente { version: v, datos: d, rota_en: None });
}

fn pol(nivel: Nivel) -> Politica {
    Politica { nivel, motivo: nivel == Nivel::Motivo, ..Politica::NO }
}

#[test]
fn cada_comando_cada_rol_cada_politica() {
    let mut fallas = vec![];
    for rol in [Rol::Cajero, Rol::Tecnico] {
        let p = prueba();
        let actor = if rol == Rol::Cajero { p.cajero.clone() } else { p.tec.clone() };
        tauri::async_runtime::block_on(crate::caja::abrir(p.st().pool().unwrap(), &p.dueno, crate::caja::CAJA_1, &crate::caja::tests::conteo(&[(1000, 1)]))).unwrap();
        let base = p.st().seg().datos.clone();
        for (nombre, cmd, args) in llamadas(&p.cajero.id, &p.dueno.id, &p.tec.id) {
            let Some(Destino::Accion(id)) = acciones::destino(cmd) else { continue };
            // Los que cierran la caja o borran usuarios cambian lo que prueban los demás: aparte.
            // Usuarios: fijo para dueño y técnico, y además la jerarquía (quién crea a quién) es fija.
            if matches!(cmd, "caja_cerrar" | "gaveta_cierre") || cmd.starts_with("usuarios_") {
                continue;
            }
            let a = acciones::buscar(id).unwrap();
            for nivel in [Nivel::No, Nivel::Si, Nivel::Motivo, Nivel::Pin] {
                poner(&p, |d| {
                    *d = base.clone();
                    let fila = if rol == Rol::Cajero { &mut d.cajero } else { &mut d.tecnico };
                    fila.insert(id.to_string(), pol(nivel));
                    // El valor del inventario es costo: además pide «ver costos» (Etapa 2).
                    if cmd == "inventario_reporte_valorizado" {
                        fila.insert("inventario.costos".into(), Politica::SI);
                    }
                });
                p.como(Some(&actor));
                // Un nivel que la acción no aplica vale como el más estricto que sí (D4).
                let nivel = a.ajustar(pol(nivel)).nivel;
                // PIN del dueño correcto en los argumentos: los PIN equivocados frenarían las autorizaciones.
                let mut args = serde_json::from_str::<Value>(&args.to_string().replace("\"000000\"", "\"246813\"")).unwrap();
                // Importar se confirma con el PIN PROPIO.
                if cmd == "importacion_aplicar" {
                    args["pin"] = json!(if rol == Rol::Cajero { "2580" } else { "735919" });
                }
                let r = p.llamar(cmd, args.clone());
                let t = texto(&r);
                // Reglas fijas: el técnico nunca tiene lo protegido; el cajero nunca lo no delegable;
                // el técnico tiene fijo lo no delegable.
                let fijo_no = (rol == Rol::Tecnico && a.protegida) || (rol == Rol::Cajero && a.no_delegable);
                let fijo_si = rol == Rol::Tecnico && a.no_delegable;
                let esperado_no = fijo_no || (!fijo_si && nivel == Nivel::No);
                if esperado_no != negado(&r) {
                    fallas.push(format!("{nombre} {rol:?} {nivel:?}: {}", if esperado_no { "debía negarse" } else { "se negó" }));
                    continue;
                }
                if esperado_no || fijo_si || a.propia {
                    continue;
                }
                // Puerta común: «motivo» y «PIN» se piden y, con la autorización de un solo uso, pasa.
                match nivel {
                    Nivel::Motivo => {
                        if !t.starts_with("NECESITA_MOTIVO") {
                            fallas.push(format!("{nombre} {rol:?} motivo: no lo pidió ({t})"));
                            continue;
                        }
                        p.llamar("seguridad_autorizar", json!({"accion": id, "comando": cmd, "motivo": "Prueba de motivo"})).unwrap();
                    }
                    Nivel::Pin => {
                        if !t.starts_with("NECESITA_PIN") {
                            fallas.push(format!("{nombre} {rol:?} PIN: no lo pidió ({t})"));
                            continue;
                        }
                        p.llamar("seguridad_autorizar", json!({"accion": id, "comando": cmd, "pin": PIN})).unwrap();
                    }
                    _ => {
                        if t.starts_with("NECESITA_") {
                            fallas.push(format!("{nombre} {rol:?} sí: pidió algo ({t})"));
                        }
                        continue;
                    }
                }
                let r2 = p.llamar(cmd, args.clone());
                if negado(&r2) || texto(&r2).starts_with("NECESITA_") {
                    fallas.push(format!("{nombre} {rol:?} {nivel:?}: con la autorización no pasó ({})", texto(&r2)));
                }
                // De un solo uso: la siguiente llamada lo pide otra vez.
                let r3 = p.llamar(cmd, args.clone());
                if !texto(&r3).starts_with("NECESITA_") {
                    fallas.push(format!("{nombre} {rol:?} {nivel:?}: la autorización sirvió dos veces"));
                }
            }
        }
    }
    assert!(fallas.is_empty(), "\n{}", fallas.join("\n"));
}

#[test]
fn la_autorizacion_solo_con_el_pin_de_un_dueno() {
    let p = prueba();
    poner(&p, |d| {
        d.cajero.insert("venta.descartar_espera".into(), pol(Nivel::Pin));
    });
    p.como(Some(&p.cajero));
    assert!(texto(&p.llamar("venta_espera_descartar", json!({"id": "x"}))).starts_with("NECESITA_PIN"));
    // El PIN del cajero no sirve.
    assert!(p.llamar("seguridad_autorizar", json!({"accion": "venta.descartar_espera", "comando": "venta_espera_descartar", "pin": "2580"})).is_err());
    assert!(texto(&p.llamar("venta_espera_descartar", json!({"id": "x"}))).starts_with("NECESITA_PIN"));
    // Una acción que no tiene: ni con PIN.
    assert!(negado(&p.llamar("seguridad_autorizar", json!({"accion": "caja.corte", "comando": "caja_corte", "pin": PIN}))));
    // Queda en la bitácora con la versión y quién autorizó.
    p.llamar("seguridad_autorizar", json!({"accion": "venta.descartar_espera", "comando": "venta_espera_descartar", "pin": PIN})).unwrap();
    let _ = p.llamar("venta_espera_descartar", json!({"id": "x"}));
    let det: String = tauri::async_runtime::block_on(sqlx::query_scalar("SELECT detalle FROM bitacora WHERE accion = 'permiso.autorizado'").fetch_one(p.st().pool().unwrap())).unwrap();
    assert!(det.contains(&p.dueno.id) && det.contains("\"nivel\":\"pin\"") && det.contains("version"), "{det}");
}

#[test]
fn todo_comando_tiene_accion_y_lo_desconocido_se_niega() {
    // Cada comando registrado está en el catálogo (o en la lista cerrada de sin sesión).
    let faltan: Vec<String> = crate::tabla_comandos::registrados().into_iter().filter(|c| acciones::destino(c).is_none()).collect();
    assert!(faltan.is_empty(), "comandos sin acción: {faltan:?}");
    // Y no sobra ninguno en el catálogo.
    let reg = crate::tabla_comandos::registrados();
    let sobran: Vec<&str> = acciones::COMANDOS.iter().map(|(c, _)| *c).filter(|c| !reg.iter().any(|r| r == c)).collect();
    assert!(sobran.is_empty(), "en COMANDOS pero no registrados: {sobran:?}");
    // Cada acción del catálogo de COMANDOS existe.
    for (c, d) in acciones::COMANDOS {
        if let Destino::Accion(id) = d {
            assert!(acciones::buscar(id).is_some(), "{c} → {id}");
        }
    }
    // Cada operación de bd_lote tiene una acción que existe.
    let ops: serde_json::Map<String, Value> = serde_json::from_str(include_str!("../../src/db/sentencias.json")).unwrap();
    for (id, op) in ops.iter().filter(|(k, _)| !k.starts_with('_')) {
        let accion = op["permiso"].as_str().unwrap_or("");
        assert!(acciones::buscar(accion).is_some(), "operación {id}: acción «{accion}» no existe");
    }
    // Cada clave de config cae en una acción que existe.
    for clave in ["tema", "caja_x", "inventario_x", "respaldo_x", "apartado_x", "credito_x", "proforma_x", "importacion_x", "otra_cualquiera", "color_fondo"] {
        if let Some(a) = crate::config::accion_de(clave) {
            assert!(acciones::buscar(a).is_some(), "{clave} → {a}");
        }
    }
    // Una acción que no está en el catálogo: nadie la tiene.
    let d = politica::plantilla_normal();
    for rol in [Rol::Cajero, Rol::Dueno, Rol::Tecnico] {
        assert_eq!(politica::efectiva(&d, "x", rol, "accion.nueva").nivel, Nivel::No);
    }
}

#[test]
fn cambio_aplica_de_inmediato_con_pin_si_da_mas_y_se_vuelve_a_una_version() {
    let p = prueba();
    let st = p.st();
    tauri::async_runtime::block_on(crate::caja::abrir(st.pool().unwrap(), &p.dueno, crate::caja::CAJA_1, &crate::caja::tests::conteo(&[(1000, 1)]))).unwrap();
    p.como(Some(&p.cajero));
    assert!(negado(&p.llamar("caja_corte", json!({}))));
    // El dueño le da el corte al cajero: da más permiso → sin PIN no se guarda.
    p.como(Some(&p.dueno));
    let mut d = st.seg().datos.clone();
    d.cajero.insert("caja.corte".into(), Politica::SI);
    let r = p.llamar("seguridad_guardar", json!({"datos": d, "motivo": "Confío en Luis"}));
    assert!(texto(&r).starts_with("NECESITA_PIN"), "{}", texto(&r));
    // Lo que calcula la pantalla antes de pedir el PIN.
    let dif = p.llamar("seguridad_diferencias", json!({"datos": d})).unwrap();
    assert!(dif.to_string().contains("caja.corte"));
    let v2 = p.llamar("seguridad_guardar", json!({"datos": d, "motivo": "Confío en Luis", "pin": PIN})).unwrap();
    assert_eq!(v2, json!(2));
    // El cajero, SIN volver a entrar (misma sesión), ya puede.
    p.como(Some(&p.cajero));
    assert!(!negado(&p.llamar("caja_corte", json!({}))));
    let perms = p.llamar("sesion_permisos", json!({})).unwrap();
    assert_eq!(perms["acciones"]["caja.corte"]["nivel"], "si");
    // Quitarlo (menos permiso): sin PIN, también lo guarda el técnico.
    p.como(Some(&p.tec));
    d.cajero.remove("caja.corte");
    assert_eq!(p.llamar("seguridad_guardar", json!({"datos": d, "motivo": "Ya no"})).unwrap(), json!(3));
    // Historial y volver a la 2 (siempre con PIN): crea la 4 con los datos de la 2.
    p.como(Some(&p.dueno));
    let h = p.llamar("seguridad_historial", json!({})).unwrap();
    assert_eq!(h.as_array().unwrap().len(), 3);
    assert!(texto(&p.llamar("seguridad_volver", json!({"id": 2, "motivo": "x", "pin": ""}))).starts_with("NECESITA_PIN"));
    assert_eq!(p.llamar("seguridad_volver", json!({"id": 2, "motivo": "Se equivocó", "pin": PIN})).unwrap(), json!(4));
    p.como(Some(&p.cajero));
    assert!(!negado(&p.llamar("caja_corte", json!({}))));
    // La bitácora guarda quién, qué cambió y el PIN.
    let det: Vec<String> = tauri::async_runtime::block_on(sqlx::query_scalar("SELECT detalle FROM bitacora WHERE accion = 'seguridad.cambiar' ORDER BY rowid").fetch_all(st.pool().unwrap())).unwrap();
    assert_eq!(det.len(), 3);
    assert!(det[0].contains("cajero:caja.corte") && det[0].contains("pinDueno"), "{}", det[0]);
    // Volver no puede dejar el sistema sin dueño (la fila del dueño es fija): sigue autorizando.
    tauri::async_runtime::block_on(crate::usuarios::autorizar_dueno(st.pool().unwrap(), PIN, "x", &p.cajero.id)).unwrap();
}

#[test]
fn reglas_fijas_por_ipc() {
    let p = prueba();
    let st = p.st();
    let d = st.seg().datos.clone();
    // El cajero no edita permisos ni el tiempo de bloqueo, aunque llame directo.
    p.como(Some(&p.cajero));
    assert!(negado(&p.llamar("seguridad_guardar", json!({"datos": d, "motivo": ""}))));
    assert!(negado(&p.llamar("seguridad_inactividad", json!({"inactividad": {"general": 5}}))));
    assert!(negado(&p.llamar("seguridad_obtener", json!({}))));
    // Al técnico no se le da nada de clientes ni dinero, ni con el PIN del dueño.
    p.como(Some(&p.tec));
    let mut t = d.clone();
    t.tecnico.insert("clientes.ver_todos".into(), Politica::SI);
    assert!(texto(&p.llamar("seguridad_guardar", json!({"datos": t, "motivo": "", "pin": PIN}))).contains("Ley 8968"));
    let mut t = d.clone();
    t.tecnico.insert("caja.ver_totales".into(), Politica::SI);
    assert!(p.llamar("seguridad_guardar", json!({"datos": t, "motivo": "", "pin": PIN})).is_err());
    // El cajero no puede recibir «editar permisos» ni por excepción.
    let mut t = d.clone();
    t.usuarios.insert(p.cajero.id.clone(), [("seguridad.editar".to_string(), Politica::SI)].into());
    assert!(p.llamar("seguridad_guardar", json!({"datos": t, "motivo": "", "pin": PIN})).is_err());
    // Bloqueo: no se desactiva ni sale del rango; el técnico hasta 15; subir de 10 pide PIN.
    for malo in [json!({"general": 0}), json!({"general": 61}), json!({"general": "nunca"}), json!({"general": 10, "tecnico": 16}), json!({"general": null})] {
        assert!(p.llamar("seguridad_inactividad", json!({"inactividad": malo})).is_err(), "{malo}");
    }
    assert!(texto(&p.llamar("seguridad_inactividad", json!({"inactividad": {"general": 20}}))).starts_with("NECESITA_PIN"));
    p.llamar("seguridad_inactividad", json!({"inactividad": {"general": 5, "tecnico": 3}})).unwrap();
    assert_eq!(st.seg().datos.inactividad.minutos(Rol::Cajero), 5);
    assert_eq!(st.seg().datos.inactividad.minutos(Rol::Tecnico), 3);
    p.llamar("seguridad_inactividad", json!({"inactividad": {"general": 20}, "pin": PIN})).unwrap();
    let b: String = tauri::async_runtime::block_on(sqlx::query_scalar("SELECT detalle FROM bitacora WHERE accion = 'seguridad.inactividad' ORDER BY rowid DESC LIMIT 1").fetch_one(st.pool().unwrap())).unwrap();
    assert!(b.contains("\"antes\"") && b.contains("\"general\":20") && b.contains("pinDueno"), "{b}");
    // El tiempo nuevo ya lo ve la sesión abierta.
    let e = p.llamar("sesion_estado", json!({})).unwrap();
    assert_eq!(e["minutos"], 15, "el técnico, como máximo 15");
    // La bitácora no se apaga ni se edita: no hay comando para eso y los triggers lo impiden.
    assert!(acciones::COMANDOS.iter().all(|(c, _)| !c.starts_with("bitacora_") || matches!(*c, "bitacora_listar" | "bitacora_verificar")));
    let pool = st.pool().unwrap();
    assert!(tauri::async_runtime::block_on(sqlx::query("UPDATE seguridad_versiones SET datos = '{}'").execute(pool)).is_err());
    assert!(tauri::async_runtime::block_on(sqlx::query("DELETE FROM seguridad_versiones").execute(pool)).is_err());
}

#[test]
fn nunca_sin_un_dueno_activo_con_pin() {
    let p = prueba();
    let pool = p.st().pool().unwrap().clone();
    p.como(Some(&p.tec));
    // Único dueño: no se desactiva ni se elimina.
    assert!(texto(&p.llamar("usuarios_editar", json!({"id": p.dueno.id, "activo": false}))).contains("único dueño"));
    assert!(texto(&p.llamar("usuarios_eliminar", json!({"id": p.dueno.id}))).contains("único dueño"));
    // Un segundo dueño que todavía no puso su PIN no cuenta.
    // Otro dueño lo crea un dueño (el técnico ya no: hay un dueño con su PIN).
    p.como(Some(&p.dueno));
    let otro = p.llamar("usuarios_crear", json!({"nombre": "Marco", "rol": "dueno", "pin": "864209"})).unwrap();
    p.como(Some(&p.tec));
    let otro_id = otro["id"].as_str().unwrap().to_string();
    assert!(texto(&p.llamar("usuarios_editar", json!({"id": p.dueno.id, "activo": false}))).contains("único dueño"));
    // No hay forma de cambiar el rol: el argumento se ignora y sigue siendo dueño.
    let _ = p.llamar("usuarios_editar", json!({"id": p.dueno.id, "nombre": "Ana", "rol": "cajero"}));
    let rol: String = tauri::async_runtime::block_on(sqlx::query_scalar("SELECT rol FROM usuarios WHERE id = ?").bind(&p.dueno.id).fetch_one(&pool)).unwrap();
    assert_eq!(rol, "dueno");
    // Ya con su PIN, el primero se puede desactivar; y entonces el segundo es el único.
    tauri::async_runtime::block_on(crate::usuarios::cambiar_pin(&pool, &Actor::nuevo(otro_id.clone(), Rol::Dueno, "Marco"), &otro_id, "864209", None, None)).unwrap();
    p.llamar("usuarios_editar", json!({"id": p.dueno.id, "activo": false})).unwrap();
    assert!(texto(&p.llamar("usuarios_eliminar", json!({"id": otro_id}))).contains("único dueño"));
}

#[test]
fn bloqueada_no_corre_ningun_comando_y_al_volver_sigue_todo() {
    let p = prueba();
    let st = p.st();
    let pool = st.pool().unwrap().clone();
    tauri::async_runtime::block_on(crate::caja::abrir(&pool, &p.dueno, crate::caja::CAJA_1, &crate::caja::tests::conteo(&[(1000, 1)]))).unwrap();
    // Trabajo a medias de la dueña: venta en espera, proforma y conteo de inventario.
    p.como(Some(&p.dueno));
    let pid = crate::util::ulid();
    tauri::async_runtime::block_on(sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, 'Lápiz', 'lapiz', '00000000000000000000000D01', 300)").bind(&pid).execute(&pool)).unwrap();
    let est = json!({"lineas": [{"id": crate::util::ulid(), "productoId": pid, "descripcion": "Lápiz", "departamentoId": "00000000000000000000000D01", "cantidad": 2, "precioUnitario": 300, "descuento": 0, "tasaIva": 13.0, "exento": false}], "descuentoTotal": 0, "requiereFactura": false});
    let esp = p.llamar("venta_espera_crear", json!({"estado": est})).unwrap();
    let esp_id = esp["id"].as_str().unwrap().to_string();
    let esp2 = p.llamar("venta_espera_crear", json!({"estado": est})).unwrap();
    let prof = p.llamar("proforma_guardar", json!({"esperaId": esp2["id"], "estado": est})).unwrap();
    p.llamar("inventario_conteo_guardar", json!({"datos": {pid.clone(): 7}})).unwrap();

    // Vence el tiempo: ningún comando corre, ni llamado directo.
    tauri::async_runtime::block_on(st.sesion.forzar_bloqueo());
    for (nombre, cmd, args) in llamadas(&p.cajero.id, &p.dueno.id, &p.tec.id) {
        if matches!(acciones::destino(cmd), Some(Destino::SinSesion)) {
            continue;
        }
        let t = texto(&p.llamar(cmd, args));
        assert!(t.contains("SESION_BLOQUEADA"), "{nombre}: {t}");
    }
    assert_eq!(p.llamar("sesion_estado", json!({})).unwrap()["bloqueada"], true);
    assert!(p.llamar("sesion_actual", json!({})).unwrap().is_null());

    // La misma dueña vuelve con su PIN: sigue donde estaba.
    let r = p.llamar("sesion_iniciar", json!({"usuarioId": p.dueno.id, "pin": PIN})).unwrap();
    assert_eq!(r["continua"], true);
    let esperas = p.llamar("venta_esperas", json!({})).unwrap();
    assert!(esperas.to_string().contains(&esp_id), "la venta en espera sigue");
    assert!(p.llamar("proforma_obtener", json!({"id": prof["proforma"]["id"]})).is_ok(), "la proforma sigue");
    assert!(p.llamar("inventario_conteo_abierto", json!({})).unwrap().to_string().contains("7"), "el conteo a medias sigue");

    // Bloqueo otra vez y entra OTRO usuario (el cajero, con su PIN propio): sesión nueva, solo lo de su rol.
    tauri::async_runtime::block_on(crate::usuarios::cambiar_pin(&pool, &p.cajero, &p.cajero.id, "2580", None, None)).unwrap();
    tauri::async_runtime::block_on(st.sesion.forzar_bloqueo());
    let r = p.llamar("sesion_iniciar", json!({"usuarioId": p.cajero.id, "pin": "2580"})).unwrap();
    assert_eq!(r["continua"], false);
    assert!(negado(&p.llamar("inventario_conteo_abierto", json!({}))));
    assert!(negado(&p.llamar("reporte_ventas", json!({"desde": "2026-01-01", "hasta": "2026-01-31"}))));
    // Nada se perdió: la dueña lo encuentra al volver.
    p.como(Some(&p.dueno));
    assert!(p.llamar("inventario_conteo_abierto", json!({})).unwrap().to_string().contains("7"));
}

/// Casos espejo con la pantalla (tests/casos/permisos.json): la política Normal efectiva de cada
/// rol, el tope de descuento y los minutos de bloqueo. Rust los calcula y escribe; la prueba de TS
/// los lee y compara con lo suyo. Si cambian, esta prueba falla una vez (para que se vea el cambio).
#[test]
fn casos_espejo_con_la_pantalla() {
    use crate::acciones::{AlPasar, Limites};
    use crate::politica::Inactividad;
    let d = crate::politica::plantilla_normal();
    let mut normal = serde_json::Map::new();
    for rol in [Rol::Cajero, Rol::Dueno, Rol::Tecnico] {
        let m: serde_json::Map<String, Value> = acciones::CATALOGO.iter().map(|a| (a.id.to_string(), json!(politica::efectiva(&d, "u", rol, a.id)))).collect();
        normal.insert(rol.como_str().into(), Value::Object(m));
    }
    let actor = |p: Politica| politica::con(&Actor::nuevo("u", Rol::Cajero, "U"), |d| {
        d.cajero.insert("venta.descuento".into(), p);
    });
    let topes: Vec<Value> = [
        Politica::NO,
        Politica::PIN,
        Politica::SI,
        Politica { limites: Limites { pct_max: Some(15.0), ..Limites::NINGUNO }, ..Politica::SI },
        Politica { limites: Limites { pct_max: Some(5.0), al_pasar: AlPasar::Bloquear, ..Limites::NINGUNO }, ..Politica::SI },
    ]
    .into_iter()
    .map(|p| {
        let t = crate::ventas::tope_descuento(&actor(p));
        json!({"politica": p, "pct": t.pct, "bloquear": t.bloquear})
    })
    .collect();
    let inact: Vec<Value> = [
        Inactividad::default(),
        Inactividad { general: 30, ..Default::default() },
        Inactividad { general: 30, cajero: Some(5), dueno: Some(60), tecnico: Some(12) },
        Inactividad { general: 1, ..Default::default() },
    ]
    .into_iter()
    .map(|i| json!({"inactividad": i, "cajero": i.minutos(Rol::Cajero), "dueno": i.minutos(Rol::Dueno), "tecnico": i.minutos(Rol::Tecnico)}))
    .collect();
    let catalogo: Vec<&str> = acciones::CATALOGO.iter().map(|a| a.id).collect();
    let txt = serde_json::to_string_pretty(&json!({"catalogo": catalogo, "normal": normal, "topes": topes, "inactividad": inact})).unwrap() + "
";
    let ruta = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/casos/permisos.json");
    if std::fs::read_to_string(ruta).ok().as_deref() != Some(txt.as_str()) {
        std::fs::write(ruta, &txt).unwrap();
        panic!("tests/casos/permisos.json actualizado: revíselo y súbalo");
    }
}

/// Las tablas de SEGURIDAD.md («Acciones y política Normal por rol» y «Comando → acción») salen del
/// catálogo: si cambia una acción, un nivel o un comando, esta prueba falla. Para regenerarlas:
/// `tools/tablas-seguridad.ps1` (POS_GENERAR_SEGURIDAD=1 cargo test seguridad_md).
#[test]
fn seguridad_md_igual_al_catalogo() {
    use crate::acciones::{N_CON_PIN, N_TODOS};
    let d = politica::plantilla_normal();
    let miles = |n: i64| {
        let s = n.to_string();
        s.chars().enumerate().fold(String::new(), |mut o, (i, c)| {
            if i > 0 && (s.len() - i).is_multiple_of(3) {
                o.push('.');
            }
            o.push(c);
            o
        })
    };
    let niv = |p: Politica| -> String {
        if p.nivel == Nivel::No {
            return "—".into();
        }
        let mut t = match p.nivel {
            Nivel::Si => "✔",
            Nivel::Motivo => "motivo",
            _ => "PIN",
        }
        .to_string();
        let l = p.limites;
        let mut extra = vec![];
        if let Some(m) = l.monto_max {
            extra.push(format!("≤ ¢{}", miles(m)));
        }
        if let Some(x) = l.pct_max {
            extra.push(format!("≤ {x} %"));
        }
        if let Some(c) = l.cantidad_turno {
            extra.push(format!("{c}/turno"));
        }
        if l.solo_turno_abierto {
            extra.push("turno abierto".into());
        }
        if let Some(v) = l.ventana_min {
            extra.push(format!("{v} min"));
        }
        if !extra.is_empty() {
            t += &format!(" ({}, al pasar: {})", extra.join(", "), if l.al_pasar == crate::acciones::AlPasar::Pin { "PIN" } else { "no" });
        }
        t
    };
    let mut o = vec![
        "#### Acciones y política Normal por rol (plantilla «Normal» = 0.9.2)".to_string(),
        String::new(),
        "🔒 = protegida (el técnico nunca). «fija» = no se cambia desde la pantalla. «Niveles»: los que la acción aplica de verdad (la pantalla ofrece solo esos y Rust rechaza otros, D4). Fuente: `acciones.rs` (lo calcula Rust).".into(),
        String::new(),
        "| Área | Acción | id | Niveles | Cajero | Dueño | Técnico |".into(),
        "|---|---|---|---|:---:|:---:|:---:|".into(),
    ];
    for a in acciones::CATALOGO {
        let marca = format!("{}{}", if a.protegida { " 🔒" } else { "" }, if a.no_delegable { " (fija)" } else { "" });
        let niveles = match a.niveles {
            N_TODOS if a.monto_o_pin => "no · sí · motivo · PIN (sin monto máximo: solo PIN)",
            N_TODOS => "no · sí · motivo · PIN",
            N_CON_PIN => "no · siempre con PIN",
            _ => "no · sí",
        };
        let mut dueno = niv(politica::efectiva(&d, "u", Rol::Dueno, a.id));
        if a.dueno_sigue_cajero {
            dueno += " (tope del negocio = el del cajero)";
        }
        o.push(format!("| {} | {}{marca} | `{}` | {niveles} | {} | {dueno} | {} |", a.area, a.nombre, a.id, niv(politica::efectiva(&d, "u", Rol::Cajero, a.id)), niv(politica::efectiva(&d, "u", Rol::Tecnico, a.id))));
    }
    o.extend([
        String::new(),
        "#### Comando → acción".into(),
        String::new(),
        "Fuente: `acciones::COMANDOS`. La prueba `todo_comando_tiene_accion_y_lo_desconocido_se_niega` falla si un comando registrado no está aquí. «Según argumento»: la acción sale de la clave de configuración (`config::accion_de`), la operación (`sentencias.json`), el documento (`imprimir`), los campos (`negocio_guardar`), el usuario destino (`usuarios_*`: además la jerarquía fija) o el movimiento (`caja_movimiento`: entrada o salida).".into(),
        String::new(),
        "| Comando | Acción |".into(),
        "|---|---|".into(),
    ]);
    for (c, dst) in acciones::COMANDOS {
        let t = match dst {
            Destino::SinSesion => "sin sesión".to_string(),
            Destino::CualquierSesion => "cualquier sesión".into(),
            Destino::SegunArgumento => "según argumento".into(),
            Destino::Accion(a) => format!("`{a}`"),
        };
        o.push(format!("| `{c}` | {t} |"));
    }
    let tablas = o.join("\n") + "\n\n";
    let ruta = concat!(env!("CARGO_MANIFEST_DIR"), "/../SEGURIDAD.md");
    let md = std::fs::read_to_string(ruta).unwrap().replace("\r\n", "\n");
    let (ini, fin) = ("<!-- tablas:inicio (las genera permisos_tests::seguridad_md_igual_al_catalogo; no editar a mano) -->\n", "<!-- tablas:fin -->");
    let i = md.find(ini).expect("falta la marca de inicio en SEGURIDAD.md") + ini.len();
    let j = md.find(fin).expect("falta la marca de fin en SEGURIDAD.md");
    if md[i..j] == tablas {
        return;
    }
    if std::env::var("POS_GENERAR_SEGURIDAD").as_deref() == Ok("1") {
        std::fs::write(ruta, format!("{}{tablas}{}", &md[..i], &md[j..])).unwrap();
        return;
    }
    panic!("Las tablas de SEGURIDAD.md no coinciden con el catálogo: corra tools/tablas-seguridad.ps1 y revise el cambio.");
}
