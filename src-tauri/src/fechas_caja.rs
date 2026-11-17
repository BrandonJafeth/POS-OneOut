// Fecha de negocio de los turnos y cierre Z (auditoría 2026-11-16).
// - La fecha de negocio de un turno se decide una vez al abrir (caja::apertura_para + decidir_dia).
// - Las ventas guardan su fecha real; el día de negocio sale siempre del turno (ventas::DIA_NEGOCIO).
// - El Z va por turno. Se prueba con cientos de turnos generados que siempre cuadra.
// Las pruebas fijan la hora de cierre del negocio (0 = siempre pasada) para no depender del reloj.

use crate::caja::{
    abrir, abrir_eligiendo, caso_apertura, cerrar, corregir_dia, corte, datos_z, decidir_dia, detalle, estado, listar, movimiento, queda_en_gaveta, reabrir, tests::conteo,
    turno_para_vender, Apertura, CasoApertura, NuevoMovimiento, Retiro, CAJA_1, ELEGIR_DIA,
};
use crate::calculo::{self, Estado, Linea, PagoEntrada};
use crate::permisos::Rol;
use crate::sesion::Actor;
use crate::usuarios::{self, tests::base_con_usuarios};
use crate::util::{dia_local, ulid};
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

fn hora() -> u32 {
    chrono::Timelike::hour(&chrono::Local::now())
}

/// Un cierre de madrugada cuenta como de la noche anterior: las pruebas que dependen de "ya se
/// cerró hoy" no aplican entre las 0 y las 5.
fn madrugada() -> bool {
    hora() < 5
}

fn manana() -> String {
    (chrono::Local::now() + chrono::Duration::days(1)).format("%Y-%m-%d").to_string()
}

fn dia_real(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso).unwrap().with_timezone(&chrono::Local).format("%Y-%m-%d").to_string()
}

fn un() -> crate::caja::Conteo {
    conteo(&[(1000, 1)])
}

async fn hora_cierre(p: &SqlitePool, dueno: &Actor, h: i64) {
    crate::config::guardar(p, dueno, "caja_hora_cierre", &json!(h)).await.unwrap();
}

async fn modo(p: &SqlitePool, dueno: &Actor, compartido: bool) {
    crate::config::guardar(p, dueno, "caja_turno_compartido", &json!(compartido)).await.unwrap();
}

async fn caso(p: &SqlitePool, a: &Actor) -> CasoApertura {
    estado(p, a, CAJA_1).await.unwrap().apertura.expect("sin turno abierto").caso
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
    assert_eq!(caso_apertura(false, 21, 18), Primera, "primera caja del día: hoy aunque sea tarde");
    assert_eq!(caso_apertura(true, 18, 18), Tarde);
    assert_eq!(caso_apertura(true, 23, 18), Tarde);
    assert_eq!(caso_apertura(true, 13, 18), Duda);
    // Domingo con cierre a la 1 p. m.: a las 2 ya es tarde.
    assert_eq!(caso_apertura(true, 14, 13), Tarde);
    let ap = |caso| Apertura { caso, hoy: "2026-11-16".into(), manana: "2026-11-17".into() };
    assert_eq!(decidir_dia(&ap(Primera), Some("manana")).unwrap(), ("2026-11-16".to_string(), "primera"));
    assert_eq!(decidir_dia(&ap(Tarde), Some("hoy")).unwrap(), ("2026-11-17".to_string(), "tarde"));
    assert_eq!(decidir_dia(&ap(Duda), Some("hoy")).unwrap(), ("2026-11-16".to_string(), "hoy"));
    assert_eq!(decidir_dia(&ap(Duda), Some("manana")).unwrap(), ("2026-11-17".to_string(), "manana"));
    assert!(decidir_dia(&ap(Duda), None).unwrap_err().starts_with(ELEGIR_DIA));
    assert!(decidir_dia(&ap(Duda), Some("ayer")).unwrap_err().starts_with(ELEGIR_DIA));
}

#[tokio::test]
async fn hora_de_cierre_general_y_por_dia() {
    let (bd, _, dueno, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    // Sin cierre hoy siempre es la primera, con cualquier hora.
    assert_eq!(caso(p, &cajero).await, CasoApertura::Primera);
    // Hora propia del día de hoy (0) gana a la general (23).
    let hoy = chrono::Datelike::weekday(&chrono::Local::now()).num_days_from_monday() as usize;
    let mut dias = vec![json!(null); 7];
    dias[hoy] = json!(0);
    hora_cierre(p, &dueno, 23).await;
    crate::config::guardar(p, &dueno, "caja_hora_cierre_dia", &json!(dias)).await.unwrap();
    if madrugada() {
        return;
    }
    abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
    cerrar(p, &cajero, CAJA_1, &un(), "").await.unwrap();
    assert_eq!(caso(p, &cajero).await, CasoApertura::Tarde);
    // Sin hora propia, la general (23): antes de las 11 p. m. pregunta.
    crate::config::guardar(p, &dueno, "caja_hora_cierre_dia", &json!(vec![json!(null); 7])).await.unwrap();
    if hora() < 23 {
        assert_eq!(caso(p, &cajero).await, CasoApertura::Duda);
    }
}

#[tokio::test]
async fn primera_tarde_y_duda_en_los_dos_modos() {
    if madrugada() {
        return;
    }
    for comp in [true, false] {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        modo(p, &dueno, comp).await;
        hora_cierre(p, &dueno, 0).await;
        let hoy = dia_local();
        assert_eq!(caso(p, &cajero).await, CasoApertura::Primera);
        let t = abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
        assert_eq!((t.dia.as_str(), t.apertura_caso.as_deref()), (hoy.as_str(), Some("primera")), "{comp}");
        // Un solo turno abierto por caja, en los dos modos (ni el dueño abre otro).
        assert!(abrir(p, &dueno, CAJA_1, &un()).await.is_err());
        assert!(abrir(p, &cajero, CAJA_1, &un()).await.is_err());
        cerrar(p, &cajero, CAJA_1, &un(), "").await.unwrap();

        // Cliente después del cierre (y de la hora de cierre): mañana, sin preguntar.
        assert_eq!(caso(p, &cajero).await, CasoApertura::Tarde);
        let t = abrir_eligiendo(p, &cajero, CAJA_1, &un(), Some("hoy")).await.unwrap();
        assert_eq!((t.dia.clone(), t.apertura_caso.as_deref()), (manana(), Some("tarde")), "la elección no cuenta si no hay duda");
        let e = estado(p, &cajero, CAJA_1).await.unwrap();
        assert!(!e.de_otro_dia && e.puede_usar, "no es caja olvidada ({comp})");
        // La apertura tardía queda en la bitácora aunque no se venda nada.
        assert_eq!(bitacora_con(p, "caja.abrir", &t.id, "\"caso\":\"tarde\"").await, 1);
        cerrar(p, &cajero, CAJA_1, &un(), "").await.unwrap();

        // Antes de la hora de cierre: hay que elegir (cambio de turno o cierre temprano).
        if hora() < 23 {
            hora_cierre(p, &dueno, 23).await;
            assert_eq!(caso(p, &cajero).await, CasoApertura::Duda);
            assert!(abrir(p, &cajero, CAJA_1, &un()).await.unwrap_err().starts_with(ELEGIR_DIA));
            let t = abrir_eligiendo(p, &cajero, CAJA_1, &un(), Some("hoy")).await.unwrap();
            assert_eq!((t.dia.as_str(), t.apertura_caso.as_deref()), (hoy.as_str(), Some("hoy")));
            assert_eq!(bitacora_con(p, "caja.abrir", &t.id, "\"caso\":\"hoy\"").await, 1);
            cerrar(p, &cajero, CAJA_1, &un(), "").await.unwrap();
            let t = abrir_eligiendo(p, &cajero, CAJA_1, &un(), Some("manana")).await.unwrap();
            assert_eq!((t.dia.clone(), t.apertura_caso.as_deref()), (manana(), Some("manana")));
            // Cambiar la hora de cierre no mueve turnos ya abiertos.
            hora_cierre(p, &dueno, 0).await;
            assert_eq!(detalle(p, &dueno, &t.id).await.unwrap().turno.dia, manana());
        }
    }
}

#[tokio::test]
async fn venta_despues_del_cierre_queda_para_manana() {
    if madrugada() {
        return;
    }
    for comp in [true, false] {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        modo(p, &dueno, comp).await;
        hora_cierre(p, &dueno, 0).await;
        let (hoy, man) = (dia_local(), manana());
        let pid = producto(p, DEP, 1000, 0).await;
        abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
        let de_hoy = vender(p, &cajero, &pid).await;
        cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 2)]), "").await.unwrap();

        let t = abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
        let tardia = vender(p, &cajero, &pid).await;
        // Ventas del día: la tardía es de mañana, nunca de hoy. La fecha real es la de hoy.
        let l_man = listar_dia(p, &cajero, CAJA_1, &man).await.unwrap();
        let fila = l_man.iter().find(|v| v.id == tardia).expect("en el día de mañana");
        assert_eq!((fila.dia_negocio.as_str(), dia_real(&fila.fecha)), (man.as_str(), hoy.clone()));
        let l_hoy = listar_dia(p, &cajero, CAJA_1, &hoy).await.unwrap();
        assert!(l_hoy.iter().any(|v| v.id == de_hoy) && !l_hoy.iter().any(|v| v.id == tardia), "{comp}");
        // La lista de tiquetes del turno va por turno, no por fecha real.
        assert_eq!(listar_turno(p, &cajero, &t.id).await.unwrap().iter().map(|v| v.id.clone()).collect::<Vec<_>>(), [tardia.clone()]);
        // Z: sección "Ventas después del cierre" con hora real y usuario; el historial la marca.
        let r = detalle(p, &dueno, &t.id).await.unwrap().resumen;
        assert_eq!(r.despues_del_cierre.iter().map(|v| (v.usuario.as_str(), v.total)).collect::<Vec<_>>(), [("Luis", 1000)]);
        assert_eq!(dia_real(&r.despues_del_cierre[0].fecha), hoy);
        let filas = listar(p, &dueno, CAJA_1, &hoy, &hoy).await.unwrap();
        assert_eq!(filas.iter().find(|f| f.turno.id == t.id).unwrap().ventas_despues_del_cierre, 1, "se ve en el historial hasta hoy");
        // Cerrado: el Z congelado la trae y reimprimir da lo mismo.
        cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 2)]), "").await.unwrap();
        let z1 = serde_json::to_value(datos_z(p, &dueno, &t.id).await.unwrap().0.resumen).unwrap();
        let z2 = serde_json::to_value(datos_z(p, &dueno, &t.id).await.unwrap().0.resumen).unwrap();
        assert_eq!(z1, z2);
        assert_eq!(z1["despuesDelCierre"].as_array().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn conteo_de_apertura_contra_lo_que_quedo() {
    for comp in [true, false] {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        modo(p, &dueno, comp).await;
        hora_cierre(p, &dueno, 0).await;
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
    hora_cierre(p, &dueno, 0).await;
    let hoy = dia_local();
    let t = abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
    let otro = if t.dia == hoy { manana() } else { hoy.clone() };
    assert!(corregir_dia(p, &cajero, &t.id, &otro, "2580", "Se eligió mal").await.unwrap_err().contains("permiso"));
    assert!(corregir_dia(p, &dueno, &t.id, &otro, "000000", "Se eligió mal").await.is_err());
    assert!(corregir_dia(p, &dueno, &t.id, &otro, PIN, "x").await.is_err(), "motivo");
    assert!(corregir_dia(p, &dueno, &t.id, "2020-01-01", PIN, "Se eligió mal").await.is_err(), "solo hoy o mañana");
    corregir_dia(p, &dueno, &t.id, &otro, PIN, "Se eligió mal").await.unwrap();
    assert_eq!(detalle(p, &dueno, &t.id).await.unwrap().turno.dia, otro);
    assert_eq!(bitacora_con(p, "caja.corregir_dia", &t.id, "Se eligió mal").await, 1);
    // Cerrado hoy: todavía se puede. Cerrado otro día: no.
    cerrar(p, &cajero, CAJA_1, &un(), "").await.unwrap();
    corregir_dia(p, &dueno, &t.id, &t.dia, PIN, "Vuelve al día original").await.unwrap();
    sqlx::query("UPDATE caja_turnos SET cerrado_en = '2020-01-01T12:00:00.000Z' WHERE id = ?").bind(&t.id).execute(p).await.unwrap();
    assert!(corregir_dia(p, &dueno, &t.id, &manana(), PIN, "Muy tarde ya").await.unwrap_err().contains("cerrada hoy"));
}

#[tokio::test]
async fn otro_cajero_cierra_el_turno_tardio_y_abre_el_suyo() {
    let (bd, tec, dueno, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    modo(p, &dueno, false).await;
    hora_cierre(p, &dueno, 0).await;
    let m = usuarios::crear(p, &tec, "Marta", Rol::Cajero, "3691").await.unwrap();
    let marta = Actor { id: m.id, rol: Rol::Cajero, nombre: "Marta".into() };
    let t = abrir(p, &luis, CAJA_1, &un()).await.unwrap();
    // El mismo día, Marta no usa ni cierra el turno de Luis.
    let e = estado(p, &marta, CAJA_1).await.unwrap();
    assert!(!e.puede_usar && !e.puede_cerrar && !e.cierra_por_otro);
    assert!(cerrar(p, &marta, CAJA_1, &un(), "").await.is_err());
    // Quedó abierto desde ayer: Marta lo cierra con su conteo ciego, en nombre de Luis.
    let ayer = (chrono::Utc::now() - chrono::Duration::days(1)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    sqlx::query("UPDATE caja_turnos SET abierto_en = ? WHERE id = ?").bind(&ayer).bind(&t.id).execute(p).await.unwrap();
    let e = estado(p, &marta, CAJA_1).await.unwrap();
    assert!(e.cierra_por_otro && !e.puede_usar);
    cerrar(p, &marta, CAJA_1, &un(), "").await.unwrap();
    assert_eq!(bitacora_con(p, "caja.cerrar", &t.id, "\"enNombreDe\":\"Luis\"").await, 1);
    let d = detalle(p, &dueno, &t.id).await.unwrap().turno;
    assert_eq!(d.usuario_cierre_id.as_deref(), Some(marta.id.as_str()));
    let suyo = abrir(p, &marta, CAJA_1, &un()).await.unwrap();
    assert_eq!(suyo.usuario_apertura_id, marta.id);
}

#[tokio::test]
async fn caja_olvidada_solo_si_es_de_un_dia_anterior() {
    for comp in [true, false] {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        modo(p, &dueno, comp).await;
        let t = abrir(p, &cajero, CAJA_1, &un()).await.unwrap();
        for (dia, vende) in [(manana(), true), (dia_local(), true), ("2020-01-01".to_string(), false)] {
            sqlx::query("UPDATE caja_turnos SET dia = ? WHERE id = ?").bind(&dia).bind(&t.id).execute(p).await.unwrap();
            let mut c = p.acquire().await.unwrap();
            assert_eq!(turno_para_vender(&mut c, CAJA_1, &cajero).await.is_ok(), vende, "{dia}");
            drop(c);
            assert_eq!(estado(p, &cajero, CAJA_1).await.unwrap().de_otro_dia, !vende, "{dia}");
        }
    }
}

/// Cientos de turnos con ventas de todo tipo: el Z siempre cuadra y cada cosa está en un solo Z.
#[tokio::test]
async fn el_z_cuadra_en_cientos_de_turnos() {
    let (bd, tec, dueno, luis) = base_con_usuarios().await;
    let p = &bd.pool;
    hora_cierre(p, &dueno, 0).await;
    crate::config::guardar(p, &dueno, "caja_no_venta_umbral", &json!(0)).await.unwrap();
    crate::impresoras::tests::dos_impresoras(p, &dueno, "ZFECHAS").await; // gaveta simulada para la "no venta"
    sqlx::query("INSERT INTO departamentos (id, codigo, nombre, orden) VALUES (?, '99', 'Regalos', 9)").bind(DEP2).execute(p).await.unwrap();
    let m = usuarios::crear(p, &tec, "Marta", Rol::Cajero, "3691").await.unwrap();
    let marta = Actor { id: m.id, rol: Rol::Cajero, nombre: "Marta".into() };
    // Precios que no son múltiplos de 5 (redondeo) y uno con 10 % fijo de producto.
    let prods = [(producto(p, DEP, 1235, 0).await, DEP, 1235, 0), (producto(p, DEP2, 2500, 10).await, DEP2, 2500, 10), (producto(p, DEP2, 780, 0).await, DEP2, 780, 0)];
    let mut r = Azar(97);
    let mut anteriores: Vec<(String, i64)> = vec![]; // (venta, efectivo) de turnos ya cerrados
    let mut turnos = vec![];
    for k in 0..150 {
        let comp = k % 3 != 0;
        modo(p, &dueno, comp).await;
        let quien = if k % 2 == 0 { &luis } else { &marta };
        let fondo = 1000 * (5 + r.n(20));
        let t = abrir_eligiendo(p, quien, CAJA_1, &conteo(&[(1000, fondo / 1000)]), Some("hoy")).await.unwrap();
        turnos.push(t.id.clone());
        let mut esperado = fondo;
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
            } else {
                esperado += efectivo;
                total_ventas += total;
                del_turno.push((v.venta_id, total, efectivo));
            }
        }
        // Anulación de una venta de un turno anterior, con devolución en efectivo (sale como salida).
        if r.n(4) == 0 {
            if let Some((vid, ef)) = anteriores.pop() {
                let dev = ef.min(esperado);
                anular(p, &dueno, CAJA_1, &vid, PIN, "Devolución de otro día", dev).await.unwrap();
                esperado -= dev;
            }
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
        if r.n(2) == 0 {
            queda_en_gaveta(p, quien, &t.id, contado / 2).await.unwrap();
        }
        let (d, _) = datos_z(p, &dueno, &t.id).await.unwrap();
        let z = &d.resumen;
        assert!(z.cuadra, "turno {k}: {:?}", z.descuadres);
        assert_eq!(z.total_ventas, total_ventas, "turno {k}");
        assert_eq!(z.ventas as usize, del_turno.len(), "turno {k}");
        assert_eq!(z.por_forma.iter().map(|f| f.monto).sum::<i64>(), total_ventas, "formas, turno {k}");
        assert_eq!(z.por_usuario.iter().map(|u| u.total).sum::<i64>(), total_ventas, "usuarios, turno {k}");
        assert_eq!(z.desglose.departamentos.iter().map(|x| x.monto).sum::<i64>(), total_ventas, "departamentos, turno {k}");
        assert_eq!(z.desglose.departamentos.iter().flat_map(|x| &x.filas).map(|f| f.monto).sum::<i64>(), total_ventas, "detalle, turno {k}");
        assert_eq!(z.efectivo_esperado, z.fondo + z.recibido_efectivo - z.vueltos + z.entradas - z.salidas);
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
