// Fecha de negocio de los turnos y cierre Z (auditoría 2026-11-16).
// - La fecha de negocio de un turno se decide una vez al abrir (caja::apertura_en, con días laborables).
// - Las ventas guardan su día real; el día de negocio sale siempre del turno (ventas::DIA_NEGOCIO).
// - El Z va por turno. Se prueba con cientos de turnos generados que siempre cuadra.
// Todas fijan el reloj (util::fijar_reloj): ninguna depende de la hora a la que se corre.
// Semana de prueba (Costa Rica, −06:00): lunes 16 … viernes 20, sábado 21, domingo 22, lunes 23.

use crate::caja::{
    abrir, abrir_eligiendo, apertura_en, cerrar, corregir_dia, corte, datos_z, decidir_dia, detalle, estado, leer_horario, listar, movimiento, nombre_dia, queda_en_gaveta, reabrir,
    tests::conteo, turno_para_vender, CasoApertura, NuevoMovimiento, Retiro, CAJA_1, ELEGIR_DIA, HORARIO_INICIAL, NO_LABORABLE,
};
use crate::calculo::{self, Estado, Linea, PagoEntrada};
use crate::permisos::Rol;
use crate::sesion::Actor;
use crate::usuarios::{self, tests::base_con_usuarios};
use crate::util::{fijar_reloj, ulid};
use crate::ventas::{anular, cobrar, crear_espera, listar_dia, listar_turno};
use serde_json::json;
use sqlx::SqlitePool;

const DEP: &str = "00000000000000000000000D01";
const DEP2: &str = "00000000000000000000000D99";
const EF: &str = "0000000000000000000000FP01";
const TJ: &str = "0000000000000000000000FP02";
const SP: &str = "0000000000000000000000FP03";
const PIN: &str = "246813";

struct Azar(u64);
impl Azar {
    fn n(&mut self, max: i64) -> i64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) % max.max(1) as u64) as i64
    }
}

/// "sab 17:40" → sábado 21 a las 17:40 (−06:00).
fn a(cuando: &str) -> String {
    let (dia, hora) = cuando.split_once(' ').unwrap();
    let d = match dia {
        "lun" => "2026-11-16",
        "mar" => "2026-11-17",
        "mie" => "2026-11-18",
        "vie" => "2026-11-20",
        "sab" => "2026-11-21",
        "dom" => "2026-11-22",
        "lun23" => "2026-11-23",
        "mar24" => "2026-11-24",
        _ => panic!("{dia}"),
    };
    format!("{d}T{hora}:00-06:00")
}

fn reloj(cuando: &str) {
    fijar_reloj(&a(cuando));
}

fn hora(cuando: &str) -> chrono::DateTime<chrono::FixedOffset> {
    chrono::DateTime::parse_from_rfc3339(&a(cuando)).unwrap()
}

/// ISO UTC de un momento de la semana de prueba (para "último cierre").
fn utc(cuando: &str) -> String {
    crate::util::iso(hora(cuando).with_timezone(&chrono::Utc))
}

fn dia_real(iso: &str) -> String {
    crate::util::local_de(iso).unwrap().format("%Y-%m-%d").to_string()
}

fn un() -> crate::caja::Conteo {
    conteo(&[(1000, 1)])
}

async fn modo(p: &SqlitePool, dueno: &Actor, compartido: bool) {
    crate::config::guardar(p, dueno, "caja_turno_compartido", &json!(compartido)).await.unwrap();
}

async fn caso(p: &SqlitePool, a: &Actor) -> CasoApertura {
    estado(p, a, CAJA_1).await.unwrap().apertura.expect("sin turno abierto").caso
}

async fn puede_vender(p: &SqlitePool, a: &Actor) -> bool {
    let mut c = p.acquire().await.unwrap();
    turno_para_vender(&mut c, CAJA_1, a).await.is_ok()
}

async fn bitacora_con(p: &SqlitePool, accion: &str, id: &str, texto: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = ? AND entidad_id = ? AND detalle LIKE ?")
        .bind(accion)
        .bind(id)
        .bind(format!("%{texto}%"))
        .fetch_one(p)
        .await
        .unwrap()
}

async fn producto(p: &SqlitePool, dep: &str, precio: i64, pct: i64) -> String {
    let id = ulid();
    sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio, descuento_pct) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(format!("P{precio}"))
        .bind(format!("p{precio}"))
        .bind(dep)
        .bind(precio)
        .bind(pct)
        .execute(p)
        .await
        .unwrap();
    id
}

fn linea(pid: &str, dep: &str, precio: i64, cantidad: i64, descuento: i64, pct: i64) -> Linea {
    Linea { id: ulid(), producto_id: Some(pid.into()), codigo: None, descripcion: "x".into(), departamento_id: dep.into(), cantidad, precio_unitario: precio, descuento, descuento_catalogo: pct, tasa_iva: 13.0, exento: false }
}

fn pago(f: &str, m: i64) -> PagoEntrada {
    let mut x = PagoEntrada { forma_pago_id: f.into(), monto: m, banco_id: None, referencia: None, ultimos4: None, pagador: None };
    if f == SP {
        x.banco_id = Some("0000000000000000000000BN02".into());
        x.referencia = Some(ulid());
        x.pagador = Some("Ana Mora".into());
    }
    x
}

/// Venta de contado de ¢1.000. Devuelve el id.
async fn vender(p: &SqlitePool, a: &Actor, pid: &str) -> String {
    let e = Estado { lineas: vec![linea(pid, DEP, 1000, 1, 0, 0)], ..Default::default() };
    let esp = crear_espera(p, a, CAJA_1, &e).await.unwrap();
    cobrar(p, a, CAJA_1, &esp.id, &e, &[pago(EF, 1000)]).await.unwrap().venta_id
}

#[test]
fn la_fecha_se_decide_en_un_solo_lugar() {
    use CasoApertura::*;
    let h = HORARIO_INICIAL; // lun–vie 18:30, sáb 17:30, dom no laborable
    let ap = |cuando: &str, cierre: Option<&str>| apertura_en(hora(cuando), cierre.map(utc).as_deref(), &h);
    // Primera caja del día: hoy, aunque sea tarde.
    let x = ap("lun 21:00", None);
    assert_eq!((x.caso, x.hoy.as_str(), x.siguiente.as_str()), (Primera, "2026-11-16", "2026-11-17"));
    // Lunes a viernes: después del cierre y de las 18:30 → el día siguiente; justo a las 18:30 también.
    assert_eq!((ap("lun 19:00", Some("lun 18:40")).caso), Tarde);
    assert_eq!((ap("lun 18:30", Some("lun 18:20")).caso), Tarde);
    assert_eq!((ap("lun 18:29", Some("lun 18:20")).caso), Duda);
    assert_eq!(ap("vie 19:00", Some("vie 18:45")).siguiente, "2026-11-21", "el viernes sigue el sábado");
    // Sábado (17:30): el siguiente día laborable es el lunes 23.
    let x = ap("sab 17:45", Some("sab 17:35"));
    assert_eq!((x.caso, x.siguiente.as_str()), (Tarde, "2026-11-23"));
    let x = ap("sab 16:00", Some("sab 15:00"));
    assert_eq!((x.caso, x.siguiente.as_str()), (Duda, "2026-11-23"));
    // Domingo: no laborable, cuenta para el mismo domingo si se confirma.
    let x = ap("dom 11:00", None);
    assert_eq!((x.caso, x.nombre_hoy.as_str(), x.siguiente.as_str()), (NoLaborable, "domingo", "2026-11-23"));
    // 11:59 p. m. y 12:01 a. m.
    assert_eq!(ap("lun 23:59", Some("lun 19:00")).caso, Tarde);
    assert_eq!(ap("mar 00:01", Some("lun 23:58")).caso, Primera, "el cierre de anoche no es de hoy");
    assert_eq!(ap("mar 00:01", Some("mar 00:00")).caso, Primera, "un cierre de madrugada es de la noche anterior");
    assert_eq!(ap("mar 08:00", Some("mar 04:59")).caso, Primera);
    assert_eq!(ap("mar 08:00", Some("mar 05:00")).caso, Duda);
    // Sábado con su hora propia, distinta a la de entre semana.
    let propia = leer_horario(Some(&json!(["18:30", "18:30", "18:30", "18:30", "18:30", "13:00", null])));
    assert_eq!(apertura_en(hora("sab 14:00"), Some(utc("sab 13:10")).as_deref(), &propia).caso, Tarde);

    // La elección solo cuenta cuando hace falta.
    let d = |cuando: &str, cierre: Option<&str>, el: Option<&str>| decidir_dia(&ap(cuando, cierre), el);
    assert_eq!(d("lun 10:00", None, Some("manana")).unwrap(), ("2026-11-16".to_string(), "primera", false));
    assert_eq!(d("sab 18:00", Some("sab 17:40"), Some("hoy")).unwrap(), ("2026-11-23".to_string(), "tarde", false));
    assert_eq!(d("sab 16:00", Some("sab 15:00"), Some("hoy")).unwrap(), ("2026-11-21".to_string(), "hoy", false));
    assert_eq!(d("sab 16:00", Some("sab 15:00"), Some("manana")).unwrap(), ("2026-11-23".to_string(), "manana", false));
    let err = d("sab 16:00", Some("sab 15:00"), None).unwrap_err();
    assert!(err.starts_with(ELEGIR_DIA) && err.contains("lunes 23"), "{err}");
    let err = d("dom 11:00", None, None).unwrap_err();
    assert!(err.starts_with(NO_LABORABLE) && err.contains("domingo"), "{err}");
    assert_eq!(d("dom 11:00", None, Some("hoy")).unwrap(), ("2026-11-22".to_string(), "primera", true));
    assert_eq!(nombre_dia("2026-11-23"), "lunes 23");
    // Sin ningún día laborable válido (no debería pasar: config lo impide), el día calendario siguiente.
    assert_eq!(leer_horario(Some(&json!("x"))), HORARIO_INICIAL);
}

#[tokio::test]
async fn caja_tardia_del_sabado_cuenta_para_el_lunes() {
    for comp in [true, false] {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        modo(p, &dueno, comp).await;
        let pid = producto(p, DEP, 1000, 0).await;
        reloj("sab 08:00");
        assert_eq!(abrir(p, &cajero, CAJA_1, &un()).await.unwrap().dia, "2026-11-21");
        let de_sabado = vender(p, &cajero, &pid).await;
        reloj("sab 17:40");
        cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 2)]), "").await.unwrap();
        // Cliente tardío: avisa que cuenta para el lunes 23, sin preguntar.
        reloj("sab 17:50");
        let ap = estado(p, &cajero, CAJA_1).await.unwrap().apertura.unwrap();
        assert_eq!((ap.caso, ap.siguiente.as_str()), (CasoApertura::Tarde, "2026-11-23"));
        let t = abrir_eligiendo(p, &cajero, CAJA_1, &un(), None).await.unwrap();
        assert_eq!((t.dia.as_str(), t.apertura_caso.as_deref()), ("2026-11-23", Some("tarde")), "{comp}");
        assert_eq!(bitacora_con(p, "caja.abrir", &t.id, "\"caso\":\"tarde\"").await, 1, "queda en la bitácora aunque no se venda");
        let tardia = vender(p, &cajero, &pid).await;
        // Domingo y lunes: no es caja olvidada; se sigue usando el lunes.
        for cuando in ["dom 10:00", "lun23 09:00"] {
            reloj(cuando);
            let e = estado(p, &cajero, CAJA_1).await.unwrap();
            assert!(!e.de_otro_dia && e.puede_usar && puede_vender(p, &cajero).await, "{cuando} ({comp})");
        }
        let del_lunes = vender(p, &cajero, &pid).await;
        // Ventas del día: la tardía es del lunes (con su día real, sábado); nunca del sábado.
        let lunes = listar_dia(p, &cajero, CAJA_1, "2026-11-23").await.unwrap();
        let fila = lunes.iter().find(|v| v.id == tardia).expect("en el lunes");
        assert_eq!((fila.dia_negocio.as_str(), dia_real(&fila.fecha)), ("2026-11-23", "2026-11-21".to_string()));
        assert!(lunes.iter().any(|v| v.id == del_lunes));
        let sabado = listar_dia(p, &cajero, CAJA_1, "2026-11-21").await.unwrap();
        assert!(sabado.iter().any(|v| v.id == de_sabado) && !sabado.iter().any(|v| v.id == tardia));
        // Tiquetes del turno: por turno, no por fecha real.
        let mut del_turno: Vec<String> = listar_turno(p, &cajero, &t.id).await.unwrap().into_iter().map(|v| v.id).collect();
        del_turno.sort();
        let mut esperados = vec![tardia.clone(), del_lunes.clone()];
        esperados.sort();
        assert_eq!(del_turno, esperados);
        // Z: "Ventas después del cierre" solo la del sábado; el historial la marca.
        let r = detalle(p, &dueno, &t.id).await.unwrap().resumen;
        assert_eq!(r.despues_del_cierre.iter().map(|v| (v.usuario.as_str(), v.total)).collect::<Vec<_>>(), [("Luis", 1000)]);
        let fila = listar(p, &dueno, CAJA_1, "2026-11-21", "2026-11-23").await.unwrap().into_iter().find(|f| f.turno.id == t.id).unwrap();
        assert_eq!(fila.ventas_despues_del_cierre, 1);
        // Se cierra el lunes; reimprimir el Z da lo mismo.
        reloj("lun23 18:40");
        cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 3)]), "").await.unwrap();
        let z1 = serde_json::to_value(datos_z(p, &dueno, &t.id).await.unwrap().0.resumen).unwrap();
        let z2 = serde_json::to_value(datos_z(p, &dueno, &t.id).await.unwrap().0.resumen).unwrap();
        assert_eq!(z1, z2);
        assert_eq!(z1["despuesDelCierre"].as_array().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn caso_dudoso_el_sabado_pregunta_hoy_o_el_lunes() {
    for comp in [true, false] {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        modo(p, &dueno, comp).await;
        reloj("sab 09:00");
        abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
        reloj("sab 15:00");
        cerrar(p, &cajero, CAJA_1, &un(), "").await.unwrap();
        reloj("sab 15:10");
        let ap = estado(p, &cajero, CAJA_1).await.unwrap().apertura.unwrap();
        assert_eq!((ap.caso, ap.siguiente.as_str()), (CasoApertura::Duda, "2026-11-23"));
        let err = abrir_eligiendo(p, &cajero, CAJA_1, &un(), None).await.unwrap_err();
        assert!(err.starts_with(ELEGIR_DIA) && err.contains("lunes 23"), "{err}");
        let t = abrir_eligiendo(p, &cajero, CAJA_1, &un(), Some("hoy")).await.unwrap();
        assert_eq!((t.dia.as_str(), t.apertura_caso.as_deref()), ("2026-11-21", Some("hoy")));
        assert_eq!(bitacora_con(p, "caja.abrir", &t.id, "\"caso\":\"hoy\"").await, 1);
        reloj("sab 16:00");
        cerrar(p, &cajero, CAJA_1, &un(), "").await.unwrap();
        reloj("sab 16:10");
        let t = abrir_eligiendo(p, &cajero, CAJA_1, &un(), Some("manana")).await.unwrap();
        assert_eq!((t.dia.as_str(), t.apertura_caso.as_deref()), ("2026-11-23", Some("manana")), "{comp}");
    }
}

#[tokio::test]
async fn domingo_no_laborable_se_confirma_y_cuenta_para_el_domingo() {
    for comp in [true, false] {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        modo(p, &dueno, comp).await;
        reloj("dom 11:00");
        assert_eq!(caso(p, &cajero).await, CasoApertura::NoLaborable);
        let err = abrir_eligiendo(p, &cajero, CAJA_1, &un(), None).await.unwrap_err();
        assert!(err.starts_with(NO_LABORABLE) && err.contains("domingo"), "{err}");
        let t = abrir_eligiendo(p, &cajero, CAJA_1, &un(), Some("hoy")).await.unwrap();
        assert_eq!((t.dia.as_str(), t.no_laborable), ("2026-11-22", true), "{comp}");
        assert_eq!(bitacora_con(p, "caja.abrir", &t.id, "\"noLaborable\":true").await, 1);
        assert!(puede_vender(p, &cajero).await);
    }
}

#[tokio::test]
async fn caja_olvidada_del_viernes_se_detecta_el_lunes() {
    for comp in [true, false] {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        modo(p, &dueno, comp).await;
        reloj("vie 08:00");
        let t = abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
        assert_eq!(t.dia, "2026-11-20");
        for cuando in ["sab 09:00", "lun23 08:00"] {
            reloj(cuando);
            let e = estado(p, &cajero, CAJA_1).await.unwrap();
            assert!(e.de_otro_dia && !puede_vender(p, &cajero).await, "{cuando} ({comp})");
            assert!(abrir(p, &cajero, CAJA_1, &un()).await.unwrap_err().contains("Quedó abierta"));
        }
        // 11:59 p. m. y 12:01 a. m.: la caja del día se vende hasta medianoche; pasada, es olvidada.
        reloj("vie 23:59");
        assert!(puede_vender(p, &cajero).await);
    }
    let (bd, _, _, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("lun 23:59");
    abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
    assert!(puede_vender(p, &cajero).await);
    reloj("mar 00:01");
    assert!(!puede_vender(p, &cajero).await && estado(p, &cajero, CAJA_1).await.unwrap().de_otro_dia);
}

#[tokio::test]
async fn caja_tardia_entre_semana_cuenta_para_el_dia_siguiente() {
    for comp in [true, false] {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        modo(p, &dueno, comp).await;
        reloj("mar 08:00");
        abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
        reloj("mar 18:40");
        cerrar(p, &cajero, CAJA_1, &un(), "").await.unwrap();
        reloj("mar 18:45");
        let t = abrir_eligiendo(p, &cajero, CAJA_1, &un(), None).await.unwrap();
        assert_eq!((t.dia.as_str(), t.apertura_caso.as_deref()), ("2026-11-18", Some("tarde")), "{comp}");
        // A las 11:59 p. m. y a las 12:01 a. m. se sigue vendiendo en ella.
        for cuando in ["mar 23:59", "mie 00:01"] {
            reloj(cuando);
            assert!(puede_vender(p, &cajero).await, "{cuando}");
        }
    }
}

#[tokio::test]
async fn cambiar_dias_u_horas_no_mueve_turnos_existentes() {
    for comp in [true, false] {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        modo(p, &dueno, comp).await;
        reloj("sab 08:00");
        let cerrado = abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
        reloj("sab 17:40");
        cerrar(p, &cajero, CAJA_1, &un(), "").await.unwrap();
        reloj("sab 17:50");
        let abierto = abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
        assert_eq!(abierto.dia, "2026-11-23");
        // Ahora el sábado cierra a las 20:00 y el domingo se trabaja.
        crate::config::guardar(p, &dueno, "caja_horario", &json!(["18:30", "18:30", "18:30", "18:30", "18:30", "20:00", "12:00"])).await.unwrap();
        assert_eq!(detalle(p, &dueno, &abierto.id).await.unwrap().turno.dia, "2026-11-23");
        assert_eq!(detalle(p, &dueno, &cerrado.id).await.unwrap().turno.dia, "2026-11-21");
        reloj("dom 10:00");
        assert!(!estado(p, &cajero, CAJA_1).await.unwrap().de_otro_dia, "{comp}");
        // Con el horario nuevo, lo que se abra de aquí en adelante sí lo usa.
        reloj("lun23 08:00");
        cerrar(p, &cajero, CAJA_1, &un(), "").await.unwrap();
        reloj("lun23 08:10");
        assert_eq!(caso(p, &cajero).await, CasoApertura::Duda);
    }
}

#[tokio::test]
async fn conteo_de_apertura_contra_lo_que_quedo() {
    for comp in [true, false] {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        modo(p, &dueno, comp).await;
        reloj("lun 19:00"); // después de la hora de cierre: las reaperturas son tardías, sin preguntar
        // Primera apertura de la caja: sin comparación.
        let t1 = abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
        assert_eq!((t1.apertura_esperada, t1.diferencia_apertura, t1.apertura_cuadra), (None, None, None));
        // El conteo de apertura no se edita, ni por la base.
        for sql in ["UPDATE caja_turnos SET monto_inicial = 1 WHERE id = ?", "UPDATE caja_turnos SET conteo_inicial = '{}' WHERE id = ?"] {
            assert!(sqlx::query(sql).bind(&t1.id).execute(p).await.unwrap_err().to_string().contains("apertura"), "{sql}");
        }
        assert!(queda_en_gaveta(p, &cajero, &t1.id, 0).await.is_err(), "con la caja abierta no");
        cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 30)]), "").await.unwrap();
        assert!(queda_en_gaveta(p, &cajero, &t1.id, 40_000).await.is_err(), "más de lo contado");
        queda_en_gaveta(p, &cajero, &t1.id, 20_000).await.unwrap();
        assert!(queda_en_gaveta(p, &cajero, &t1.id, 10_000).await.is_err(), "una sola vez");
        assert!(sqlx::query("UPDATE caja_turnos SET queda_en_gaveta = 5 WHERE id = ?").bind(&t1.id).execute(p).await.is_err());
        assert_eq!(bitacora_con(p, "caja.queda", &t1.id, "\"retiro\":10000").await, 1, "retiro de cierre = contado − queda");

        // Faltan ¢1.000: el cajero solo sabe que no cuadra; el dueño ve el monto.
        let t2 = abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 19)])).await.unwrap();
        assert_eq!((t2.apertura_esperada, t2.diferencia_apertura, t2.apertura_cuadra), (None, None, Some(false)));
        let d = detalle(p, &dueno, &t2.id).await.unwrap().turno;
        assert_eq!((d.apertura_esperada, d.diferencia_apertura), (Some(20_000), Some(-1000)));
        assert_eq!(detalle(p, &cajero, &t2.id).await.unwrap().turno.diferencia_apertura, None);
        assert_eq!(bitacora_con(p, "caja.diferencia_apertura", &t2.id, "-1000").await, 1);
        let fila = listar(p, &dueno, CAJA_1, "2000-01-01", "2999-01-01").await.unwrap().into_iter().find(|f| f.turno.id == t2.id).unwrap();
        assert_eq!(fila.turno.diferencia_apertura, Some(-1000), "marcado en el historial del dueño");
        cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 19)]), "").await.unwrap();
        queda_en_gaveta(p, &cajero, &t2.id, 19_000).await.unwrap();

        // Cuadra.
        let t3 = abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 19)])).await.unwrap();
        assert_eq!(t3.apertura_cuadra, Some(true));
        assert_eq!(bitacora_con(p, "caja.diferencia_apertura", &t3.id, "").await, 0);
        // Reabrir (dueño) deja lo que queda en blanco para anotarlo otra vez.
        cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 19)]), "").await.unwrap();
        queda_en_gaveta(p, &cajero, &t3.id, 19_000).await.unwrap();
        reabrir(p, &dueno, &t3.id, PIN, "Contó mal los billetes").await.unwrap();
        assert_eq!(detalle(p, &dueno, &t3.id).await.unwrap().turno.queda_en_gaveta, None);
    }
}

#[tokio::test]
async fn dueno_corrige_el_dia_con_pin() {
    let (bd, _, dueno, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("sab 08:00");
    abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
    reloj("sab 17:40");
    cerrar(p, &cajero, CAJA_1, &un(), "").await.unwrap();
    reloj("sab 17:50");
    let t = abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
    assert_eq!(t.dia, "2026-11-23");
    assert!(corregir_dia(p, &cajero, &t.id, "2026-11-21", "2580", "Se eligió mal").await.unwrap_err().contains("permiso"));
    assert!(corregir_dia(p, &dueno, &t.id, "2026-11-21", "000000", "Se eligió mal").await.is_err());
    assert!(corregir_dia(p, &dueno, &t.id, "2026-11-21", PIN, "x").await.is_err(), "motivo");
    assert!(corregir_dia(p, &dueno, &t.id, "2026-11-22", PIN, "Se eligió mal").await.unwrap_err().contains("lunes 23"), "solo hoy o el próximo laborable");
    corregir_dia(p, &dueno, &t.id, "2026-11-21", PIN, "Se eligió mal").await.unwrap();
    assert_eq!(detalle(p, &dueno, &t.id).await.unwrap().turno.dia, "2026-11-21");
    assert_eq!(bitacora_con(p, "caja.corregir_dia", &t.id, "Se eligió mal").await, 1);
    // Cerrado hoy: todavía se puede. Cerrado otro día: no.
    reloj("sab 18:30");
    cerrar(p, &cajero, CAJA_1, &un(), "").await.unwrap();
    corregir_dia(p, &dueno, &t.id, "2026-11-23", PIN, "Vuelve al lunes").await.unwrap();
    reloj("lun23 09:00");
    assert!(corregir_dia(p, &dueno, &t.id, "2026-11-23", PIN, "Muy tarde ya").await.unwrap_err().contains("cerrada hoy"));
}

#[tokio::test]
async fn otro_cajero_cierra_el_turno_tardio_y_abre_el_suyo() {
    let (bd, tec, dueno, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    modo(p, &dueno, false).await;
    let m = usuarios::crear(p, &tec, "Marta", Rol::Cajero, "3691").await.unwrap();
    let marta = Actor::nuevo(m.id, Rol::Cajero, "Marta");
    reloj("vie 08:00");
    abrir(p, &luis, CAJA_1, &un()).await.unwrap();
    reloj("vie 18:40");
    cerrar(p, &luis, CAJA_1, &un(), "").await.unwrap();
    reloj("vie 18:50");
    let t = abrir(p, &luis, CAJA_1, &un()).await.unwrap();
    assert_eq!(t.dia, "2026-11-21", "tardía del viernes: el sábado");
    // El mismo día, Marta no usa ni cierra el turno de Luis.
    let e = estado(p, &marta, CAJA_1).await.unwrap();
    assert!(!e.puede_usar && !e.puede_cerrar && !e.cierra_por_otro);
    assert!(cerrar(p, &marta, CAJA_1, &un(), "").await.is_err());
    // El sábado, Marta lo cierra con su conteo ciego, en nombre de Luis, y abre el suyo.
    reloj("sab 08:00");
    let e = estado(p, &marta, CAJA_1).await.unwrap();
    assert!(e.cierra_por_otro && !e.puede_usar && !e.de_otro_dia);
    cerrar(p, &marta, CAJA_1, &un(), "").await.unwrap();
    assert_eq!(bitacora_con(p, "caja.cerrar", &t.id, "\"enNombreDe\":\"Luis\"").await, 1);
    assert_eq!(detalle(p, &dueno, &t.id).await.unwrap().turno.usuario_cierre_id.as_deref(), Some(marta.id.as_str()));
    reloj("sab 08:05");
    let suyo = abrir(p, &marta, CAJA_1, &un()).await.unwrap();
    assert_eq!((suyo.usuario_apertura_id.as_str(), suyo.dia.as_str()), (marta.id.as_str(), "2026-11-21"));
}

#[tokio::test]
async fn un_solo_turno_abierto_en_los_dos_modos() {
    for comp in [true, false] {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        modo(p, &dueno, comp).await;
        reloj("lun 10:00");
        abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
        assert!(abrir(p, &dueno, CAJA_1, &un()).await.is_err(), "{comp}");
        assert!(abrir(p, &cajero, CAJA_1, &un()).await.is_err(), "{comp}");
    }
}

/// Cientos de turnos con ventas de todo tipo: el Z siempre cuadra y cada cosa está en un solo Z.
#[tokio::test]
async fn el_z_cuadra_en_cientos_de_turnos() {
    let (bd, tec, dueno, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    reloj("lun 19:00"); // después de la hora de cierre: cada reapertura es tardía, sin preguntar
    crate::config::guardar(p, &dueno, "caja_no_venta_umbral", &json!(0)).await.unwrap();
    crate::impresoras::tests::dos_impresoras(p, &dueno, "ZFECHAS").await; // gaveta simulada para la "no venta"
    sqlx::query("INSERT INTO departamentos (id, codigo, nombre, orden) VALUES (?, '99', 'Regalos', 9)").bind(DEP2).execute(p).await.unwrap();
    let m = usuarios::crear(p, &tec, "Marta", Rol::Cajero, "3691").await.unwrap();
    let marta = Actor::nuevo(m.id, Rol::Cajero, "Marta");
    // Precios que no son múltiplos de 5 (redondeo) y uno con 10 % fijo de producto.
    let prods = [(producto(p, DEP, 1235, 0).await, DEP, 1235, 0), (producto(p, DEP2, 2500, 10).await, DEP2, 2500, 10), (producto(p, DEP2, 780, 0).await, DEP2, 780, 0)];
    let mut r = Azar(97);
    let mut anteriores: Vec<(String, i64)> = vec![]; // (venta, efectivo) de turnos ya cerrados
    let mut turnos = vec![];
    let mut quedo: Option<i64> = None; // lo anotado al cerrar el turno anterior
    for k in 0..150 {
        let comp = k % 3 != 0;
        modo(p, &dueno, comp).await;
        let quien = if k % 2 == 0 { &luis } else { &marta };
        let fondo = 1000 * (5 + r.n(20));
        let t = abrir_eligiendo(p, quien, CAJA_1, &conteo(&[(1000, fondo / 1000)]), Some("hoy")).await.unwrap();
        turnos.push(t.id.clone());
        // Diferencia de apertura: fondo contado contra lo que quedó en el cierre anterior.
        let ap = detalle(p, &dueno, &t.id).await.unwrap().turno;
        assert_eq!((ap.apertura_esperada, ap.diferencia_apertura), (quedo, quedo.map(|q| fondo - q)), "turno {k}: apertura");
        let mut esperado = fondo;
        let mut anuladas = 0;
        let mut total_ventas = 0;
        let mut del_turno: Vec<(String, i64, i64)> = vec![];
        for _ in 0..1 + r.n(8) {
            // En turno compartido también vende el dueño.
            let vendedor = if comp && r.n(3) == 0 { &dueno } else { quien };
            let lineas: Vec<Linea> = (0..1 + r.n(3))
                .map(|_| {
                    let (pid, dep, precio, pct) = &prods[r.n(3) as usize];
                    let cant = 1 + r.n(3);
                    let catalogo = precio * cant * pct / 100;
                    let extra = r.n(precio * cant / 20 + 1); // hasta 5 % de descuento de línea
                    linea(pid, dep, *precio, cant, catalogo + extra, *pct)
                })
                .collect();
            let mut e = Estado { lineas, ..Default::default() };
            e.descuento_total = r.n(calculo::totales(&e, 1).total / 25 + 1); // hasta 4 % al total
            let (t5, t1) = (calculo::totales(&e, 5).total, calculo::totales(&e, 1).total);
            let (pagos, total, efectivo) = match r.n(4) {
                0 => (vec![pago(EF, t5 + 1000 * r.n(3))], t5, t5),
                1 => (vec![pago(TJ, t1)], t1, 0),
                2 => (vec![pago(SP, t1)], t1, 0),
                _ if t5 > 10 => {
                    let tj = 5 + r.n(t5 - 10);
                    (vec![pago(TJ, tj), pago(EF, t5 - tj + 500)], t5, t5 - tj)
                }
                _ => (vec![pago(EF, t5)], t5, t5),
            };
            if total == 0 {
                continue;
            }
            let esp = crear_espera(p, vendedor, CAJA_1, &e).await.unwrap();
            let v = cobrar(p, vendedor, CAJA_1, &esp.id, &e, &pagos).await.unwrap_or_else(|err| panic!("turno {k}: {err} {e:?} {pagos:?}"));
            // Anulación en el mismo turno: sale de las ventas y del efectivo.
            if r.n(10) == 0 {
                anular(p, &dueno, CAJA_1, &v.venta_id, PIN, "Cliente devolvió", 0).await.unwrap();
                anuladas += 1;
            } else {
                esperado += efectivo;
                total_ventas += total;
                del_turno.push((v.venta_id, total, efectivo));
            }
        }
        // Anulación de una venta de un turno anterior, con devolución en efectivo (sale como salida).
        if r.n(4) == 0
            && let Some((vid, ef)) = anteriores.pop() {
                let dev = ef.min(esperado);
                anular(p, &dueno, CAJA_1, &vid, PIN, "Devolución de otro día", dev).await.unwrap();
                esperado -= dev;
            }
        match r.n(5) {
            0 => {
                let m = 500 + 100 * r.n(30);
                movimiento(p, quien, CAJA_1, &NuevoMovimiento { tipo: "entrada".into(), monto: m, categoria: "Ingreso de cambio".into(), nota: String::new() }, None).await.unwrap();
                esperado += m;
            }
            1 if esperado > 2000 => {
                let m = 100 * (1 + r.n((esperado / 100 - 1).min(100)));
                movimiento(p, quien, CAJA_1, &NuevoMovimiento { tipo: "salida".into(), monto: m, categoria: "Gasto menor".into(), nota: String::new() }, None).await.unwrap();
                esperado -= m;
            }
            2 if comp && esperado > 3000 => {
                let m = 1000 * (1 + r.n(2));
                corte(p, &dueno, CAJA_1, Some(&Retiro { monto: m, categoria: "Retiro de dinero".into(), nota: String::new() }), Some(PIN)).await.unwrap();
                esperado -= m;
            }
            3 => crate::gaveta::no_venta(p, quien, CAJA_1, "Cambio de billetes", "", None).await.unwrap(),
            _ => {}
        }
        // Cierre: el cajero cuenta a ciegas (a veces con diferencia).
        let contado = (esperado + 1000 * (r.n(3) - 1)).max(0);
        let cierre = cerrar(p, quien, CAJA_1, &crate::caja::Conteo { total: Some(contado), ..Default::default() }, "").await.unwrap();
        assert_eq!(cierre.esperado, Some(esperado), "turno {k}: efectivo esperado contra el modelo");
        quedo = None;
        if r.n(2) == 0 {
            queda_en_gaveta(p, quien, &t.id, contado / 2).await.unwrap();
            quedo = Some(contado / 2);
        }
        let (d, _) = datos_z(p, &dueno, &t.id).await.unwrap();
        let z = &d.resumen;
        assert!(z.cuadra, "turno {k}: {:?}", z.descuadres);
        assert_eq!(z.total_ventas, total_ventas, "turno {k}");
        assert_eq!(z.ventas as usize, del_turno.len(), "turno {k}");
        assert_eq!(z.anuladas, anuladas, "turno {k}: anuladas");
        assert_eq!(z.por_forma.iter().map(|f| f.monto).sum::<i64>(), total_ventas, "formas, turno {k}");
        assert_eq!(z.por_usuario.iter().map(|u| u.total).sum::<i64>(), total_ventas, "usuarios, turno {k}");
        assert_eq!(z.desglose.departamentos.iter().map(|x| x.monto).sum::<i64>(), total_ventas, "departamentos, turno {k}");
        assert_eq!(z.desglose.departamentos.iter().flat_map(|x| &x.filas).map(|f| f.monto).sum::<i64>(), total_ventas, "detalle, turno {k}");
        assert_eq!(z.efectivo_esperado, z.fondo + z.recibido_efectivo - z.vueltos + z.entradas - z.salidas);
        assert_eq!(z.ventas_efectivo, del_turno.iter().map(|(_, _, ef)| ef).sum::<i64>(), "turno {k}: efectivo cobrado");
        // Reimprimir da exactamente lo mismo.
        let otra = serde_json::to_value(&datos_z(p, &dueno, &t.id).await.unwrap().0.resumen).unwrap();
        assert_eq!(serde_json::to_value(z).unwrap(), otra, "turno {k}");
        anteriores.extend(del_turno.into_iter().map(|(v, _, ef)| (v, ef)));
    }
    // Cada venta, pago, movimiento y apertura de gaveta está en exactamente un turno, y existe.
    for (tabla, col) in [("ventas", "turno_id"), ("venta_pagos", "turno_id"), ("caja_movimientos", "turno_id"), ("gaveta_aperturas", "turno_id")] {
        let huerfanos: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {tabla} x WHERE x.{col} IS NULL OR x.{col} NOT IN (SELECT id FROM caja_turnos)")).fetch_one(p).await.unwrap();
        assert_eq!(huerfanos, 0, "{tabla}");
    }
    let por_turno: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(n), 0) FROM (SELECT COUNT(*) AS n FROM ventas GROUP BY turno_id)").fetch_one(p).await.unwrap();
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ventas").fetch_one(p).await.unwrap();
    assert_eq!(por_turno, total);
    assert_eq!(turnos.len(), 150);
}

#[tokio::test]
async fn base_nueva_trae_el_horario_de_chagui() {
    let (bd, _, _, _) = base_con_usuarios().await;
    let v = crate::config::valor(&bd.pool, "caja_horario").await;
    assert_eq!(v, Some(json!(["18:30", "18:30", "18:30", "18:30", "18:30", "17:30", null])));
    assert_eq!(leer_horario(v.as_ref()), HORARIO_INICIAL);
}
