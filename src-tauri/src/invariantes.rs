// Invariantes del negocio probadas con muchos casos generados (auditoría de la versión de prueba).
// Generador propio y determinista (sin dependencias): los mismos casos en cada corrida.

use crate::caja::{abrir, corte, detalle, movimiento, tests::conteo, NuevoMovimiento, Retiro, CAJA_1};
use crate::calculo::{self, Estado, Forma, Linea, PagoEntrada};
use crate::usuarios::tests::base_con_usuarios;
use crate::util::ulid;
use crate::ventas::{anular, cobrar, cobrar_con, crear_espera, listar_esperas};
use sqlx::SqlitePool;

/// LCG de 64 bits: suficiente para generar casos, siempre los mismos.
struct Azar(u64);
impl Azar {
    fn n(&mut self, max: i64) -> i64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) % max.max(1) as u64) as i64
    }
}

const DEP: &str = "00000000000000000000000D01";
const EF: &str = "0000000000000000000000FP01";
const TJ: &str = "0000000000000000000000FP02";
const SP: &str = "0000000000000000000000FP03";
const PIN: &str = "246813";

fn formas() -> Vec<Forma> {
    vec![
        Forma { id: "EF".into(), nombre: "Efectivo".into(), requiere_banco: false, requiere_referencia: false, da_vuelto: true, pide_ultimos4: false },
        Forma { id: "TJ".into(), nombre: "Tarjeta".into(), requiere_banco: false, requiere_referencia: false, da_vuelto: false, pide_ultimos4: false },
    ]
}

fn linea(precio: i64, cantidad: i64, descuento: i64) -> Linea {
    Linea { id: ulid(), producto_id: None, codigo: None, descripcion: "x".into(), departamento_id: DEP.into(), cantidad, precio_unitario: precio, descuento, tasa_iva: 13.0, exento: false }
}

fn pago(f: &str, m: i64) -> PagoEntrada {
    PagoEntrada { forma_pago_id: f.into(), monto: m, banco_id: None, referencia: None, ultimos4: None }
}

#[test]
fn total_y_pagos_en_miles_de_ventas() {
    let mut r = Azar(7);
    for _ in 0..5000 {
        let lineas: Vec<Linea> = (0..1 + r.n(6))
            .map(|_| {
                let (p, c) = (r.n(50_000), 1 + r.n(20));
                linea(p, c, r.n(p * c + 1))
            })
            .collect();
        let e = Estado { lineas, descuento_total: r.n(30_000) - 5_000, ..Default::default() };
        let paso = [1, 5, 10, 25, 50, 100][r.n(6) as usize];
        let t = calculo::totales(&e, paso);
        // Total: nunca negativo, múltiplo del redondeo y a menos de medio paso del neto.
        assert!(t.total >= 0);
        assert_eq!(t.total % paso, 0, "{t:?}");
        assert!(t.descuento >= 0 && t.descuento <= t.subtotal.max(0));
        let neto = t.subtotal - t.descuento;
        assert!((t.total - neto).abs() <= paso / 2 || t.total == 0, "neto {neto} total {}", t.total);
        assert_eq!(t.redondeo, t.total - neto);
        // Pagos: tarjeta hasta el total y efectivo de más; si no hay errores ni falta, se cubre exacto.
        let tj = r.n(t.total + 1);
        let ef = (t.total - tj) + r.n(20_000);
        let entradas: Vec<PagoEntrada> = [(tj, "TJ"), (ef, "EF")].into_iter().filter(|(m, _)| *m > 0).map(|(m, f)| pago(f, m)).collect();
        let rp = calculo::pagos(t.total, &entradas, &formas());
        if !rp.errores.is_empty() {
            continue; // venta de ¢0 con dinero o tarjeta que ya pagaba todo: rechazadas a propósito
        }
        assert_eq!(rp.faltante, 0);
        assert_eq!(rp.aplicados.iter().map(|a| a.aplicado).sum::<i64>(), t.total, "lo aplicado es el total");
        for a in &rp.aplicados {
            let efectivo = a.pago.forma_pago_id == "EF";
            assert!(efectivo || a.vuelto.is_none(), "vuelto solo en efectivo");
            if let (Some(v), Some(rec)) = (a.vuelto, a.recibido) {
                assert!(v >= 0 && v <= rec, "vuelto {v} > recibido {rec}");
            }
        }
    }
}

async fn producto(p: &SqlitePool, precio: i64) -> String {
    let id = ulid();
    sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, 'Cuaderno', 'cuaderno', ?, ?)").bind(&id).bind(DEP).bind(precio).execute(p).await.unwrap();
    id
}

fn est(pid: &str, precio: i64, cantidad: i64) -> Estado {
    Estado { lineas: vec![Linea { producto_id: Some(pid.into()), ..linea(precio, cantidad, 0) }], ..Default::default() }
}

#[tokio::test]
async fn consecutivo_sin_saltos_ni_repetidos_con_fallas_y_doble_clic() {
    let (bd, _, _, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    let pid = producto(p, 1000).await;
    abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
    let primero: i64 = sqlx::query_scalar("SELECT consecutivo_siguiente FROM cajas WHERE id = ?").bind(CAJA_1).fetch_one(p).await.unwrap();
    let mut r = Azar(11);
    let mut cobradas = 0;
    for _ in 0..40 {
        let e = est(&pid, 1000, 1 + r.n(3));
        let total = e.lineas[0].cantidad * 1000;
        let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
        match r.n(4) {
            0 => assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago(EF, total - 5)]).await.is_err()), // falta dinero
            1 => assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &est(&pid, 1, 1), &[pago(EF, 1)]).await.is_err()), // precio manipulado
            _ => {}
        }
        cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago(EF, total)]).await.unwrap();
        // Doble clic / doble Enter / F12 repetido: la misma espera no cobra dos veces.
        assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago(EF, total)]).await.is_err());
        cobradas += 1;
    }
    let numeros: Vec<i64> = sqlx::query_scalar("SELECT consecutivo FROM ventas ORDER BY consecutivo").fetch_all(p).await.unwrap();
    assert_eq!(numeros, (primero..primero + cobradas).collect::<Vec<_>>(), "sin saltos ni repetidos");
}

#[tokio::test]
async fn efectivo_esperado_contra_un_modelo_independiente() {
    let (bd, _, dueno, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    let pid = producto(p, 1000).await;
    let fondo = 20_000;
    let t = abrir(p, &cajero, CAJA_1, &conteo(&[(1000, fondo / 1000)])).await.unwrap();
    let mut esperado = fondo;
    let mut r = Azar(23);
    for i in 0..60 {
        let cant = 1 + r.n(5);
        let total = cant * 1000; // el redondeo (¢5) no cambia montos de mil
        let e = est(&pid, 1000, cant);
        let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
        let (pagos, efectivo_neto) = match r.n(4) {
            0 => {
                let recibido = total + 1000 * r.n(5);
                (vec![pago(EF, recibido)], total) // efectivo con vuelto: entra el total
            }
            1 => (vec![pago(TJ, total)], 0),
            2 => (vec![pago(SP, total)], 0),
            _ if cant > 1 => {
                let tj = 1000 * (1 + r.n(cant - 1)); // tarjeta por una parte (nunca ¢0 ni el total)
                (vec![pago(TJ, tj), pago(EF, total - tj + 2000)], total - tj) // mixto con vuelto
            }
            _ => (vec![pago(EF, total)], total),
        };
        let mut pagos = pagos;
        for x in &mut pagos {
            if x.forma_pago_id == SP {
                x.banco_id = Some("0000000000000000000000BN02".into());
                x.referencia = Some(format!("ref{i}"));
            }
            if x.forma_pago_id == TJ {
                x.ultimos4 = Some("1234".into());
            }
        }
        let v = cobrar(p, &cajero, CAJA_1, &esp.id, &e, &pagos).await.unwrap();
        esperado += efectivo_neto;
        // Anulación con la caja abierta: la venta sale del efectivo esperado.
        if r.n(8) == 0 {
            anular(p, &dueno, CAJA_1, &v.venta_id, PIN, "Cliente devolvió", 0).await.unwrap();
            esperado -= efectivo_neto;
        }
        match r.n(10) {
            0 => {
                let m = 500 + 100 * r.n(30);
                movimiento(p, &cajero, CAJA_1, &NuevoMovimiento { tipo: "entrada".into(), monto: m, categoria: "Ingreso de cambio".into(), nota: String::new() }, None).await.unwrap();
                esperado += m;
            }
            1 if esperado > 3000 => {
                let m = 100 * (1 + r.n(20));
                movimiento(p, &cajero, CAJA_1, &NuevoMovimiento { tipo: "salida".into(), monto: m, categoria: "Gasto menor".into(), nota: String::new() }, None).await.unwrap();
                esperado -= m;
            }
            2 if esperado > 5000 => {
                let m = 1000 * (1 + r.n(3));
                corte(p, &dueno, CAJA_1, Some(&Retiro { monto: m, categoria: "Retiro de dinero".into(), nota: String::new() }), Some(PIN)).await.unwrap();
                esperado -= m;
            }
            _ => {}
        }
        let real = detalle(p, &dueno, &t.id).await.unwrap().resumen.efectivo_esperado;
        assert_eq!(real, esperado, "operación {i}");
    }
    // Cada pago guardó su método, banco y referencia.
    let sinpe_sin_ref: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM venta_pagos WHERE forma_pago_id = ? AND (referencia IS NULL OR banco_id IS NULL)").bind(SP).fetch_one(p).await.unwrap();
    assert_eq!(sinpe_sin_ref, 0);
}

#[tokio::test]
async fn ventas_en_espera_sobreviven_a_cerrar_la_app() {
    let dir = std::env::temp_dir().join(format!("pos-espera-{}", ulid()));
    let bd = crate::bd::Bd::abrir(&dir, None).await.unwrap();
    let t = crate::usuarios::crear_tecnico_inicial(&bd.pool, "735919").await.unwrap();
    let tec = crate::sesion::Actor { id: t.id, rol: crate::permisos::Rol::Tecnico, nombre: "T".into() };
    let c = crate::usuarios::crear(&bd.pool, &tec, "Luis", crate::permisos::Rol::Cajero, "2580").await.unwrap();
    let luis = crate::sesion::Actor { id: c.id, rol: crate::permisos::Rol::Cajero, nombre: "Luis".into() };
    let mut e = Estado::default();
    e.lineas.push(linea(1500, 2, 0));
    let esp = crear_espera(&bd.pool, &luis, CAJA_1, &e).await.unwrap();
    // Se cierra la app (o se va la luz después de guardar).
    bd.pool.close().await;
    bd.lectura.close().await;
    let bd = crate::bd::Bd::abrir(&dir, None).await.unwrap();
    let l = listar_esperas(&bd.pool, &luis, CAJA_1).await.unwrap();
    assert!(l.iter().any(|x| x.id == esp.id && x.estado["lineas"][0]["cantidad"] == 2));
    bd.pool.close().await;
    bd.lectura.close().await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn caja_de_otro_dia_no_vende_hasta_cerrarla() {
    let (bd, _, _, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    let pid = producto(p, 1000).await;
    abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 1)])).await.unwrap();
    sqlx::query("UPDATE caja_turnos SET dia = '2020-01-01'").execute(p).await.unwrap();
    let e = est(&pid, 1000, 1);
    let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
    let err = cobrar_con(p, &cajero, CAJA_1, &esp.id, &e, &[pago(EF, 1000)], None).await.unwrap_err();
    assert!(err.contains("2020-01-01") && err.contains("cerrarla"), "{err}");
}

#[tokio::test]
async fn existencia_igual_al_kardex_en_una_base_grande() {
    use crate::inventario::{mover, Mov};
    let (bd, _, dueno, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    let mut ids = vec![];
    for _ in 0..300 {
        let id = producto(p, 500).await;
        sqlx::query("UPDATE productos SET controla_inventario = 1 WHERE id = ?").bind(&id).execute(p).await.unwrap();
        ids.push(id);
    }
    let mut r = Azar(31);
    let mut c = p.acquire().await.unwrap();
    for _ in 0..3000 {
        let id = &ids[r.n(ids.len() as i64) as usize];
        let n = r.n(20) - 8;
        if n == 0 {
            continue;
        }
        mover(&mut c, &Mov { producto_id: id, sucursal_id: "0000000000000000000000S001", tipo: if n > 0 { "entrada" } else { "ajuste" }, cantidad: n, costo: None, motivo: "", ref_tipo: None, ref_id: None, usuario_id: &dueno.id, turno_id: None, fecha: "2026-11-09T00:00:00.000Z" }).await.unwrap();
    }
    drop(c);
    // Y unas ventas y anulaciones por el camino normal.
    abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 1)])).await.unwrap();
    for i in 0..30 {
        let e = est(&ids[i], 500, 1 + r.n(3));
        let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
        let v = cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago(EF, e.lineas[0].cantidad * 500)]).await.unwrap();
        if i % 4 == 0 {
            anular(p, &dueno, CAJA_1, &v.venta_id, PIN, "Prueba de anulación", 0).await.unwrap();
        }
    }
    let malos: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM existencias x WHERE x.cantidad <> (SELECT COALESCE(SUM(m.cantidad), 0) FROM inventario_movimientos m WHERE m.producto_id = x.producto_id AND m.sucursal_id = x.sucursal_id)",
    )
    .fetch_one(p)
    .await
    .unwrap();
    assert_eq!(malos, 0);
    let sin_fila: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT producto_id) FROM inventario_movimientos WHERE producto_id NOT IN (SELECT producto_id FROM existencias)").fetch_one(p).await.unwrap();
    assert_eq!(sin_fila, 0);
}

#[test]
fn reparto_del_z_cuadra_con_pagos_mixtos_y_descuentos() {
    use crate::desglose::{armar, Linea as L, Pago as P, Venta as V};
    let mut r = Azar(41);
    for _ in 0..300 {
        let mut ventas = vec![];
        let mut lineas = vec![];
        let mut pagos = vec![];
        let (mut total_ef, mut total) = (0, 0);
        for v in 0..1 + r.n(15) {
            let id = format!("V{v}");
            let mut bruto = 0;
            for k in 0..1 + r.n(5) {
                let (precio, cant) = (r.n(20_000), 1 + r.n(4));
                let imp = precio * cant - r.n(precio * cant / 3 + 1);
                bruto += imp;
                let dep = r.n(4);
                lineas.push(L { venta_id: id.clone(), producto: format!("P{k}"), clave: format!("P{k}"), departamento_id: format!("D{dep}"), departamento: format!("Dep {dep}"), orden_departamento: dep, cantidad: cant, precio, importe: imp });
            }
            let t = (bruto - r.n(bruto / 4 + 1)).max(0); // descuento al total y redondeo
            let ef = if r.n(2) == 0 { t } else { r.n(t + 1) };
            for (m, efectivo, forma) in [(t - ef, false, "Tarjeta"), (ef, true, "Efectivo")] {
                if m > 0 {
                    pagos.push(P { venta_id: id.clone(), forma: forma.into(), tipo: if efectivo { "efectivo".into() } else { "tarjeta".into() }, orden: efectivo as i64, da_vuelto: efectivo, monto: m });
                }
            }
            ventas.push(V { id, numero: format!("{v}"), total: t });
            total += t;
            total_ef += ef;
        }
        let d = armar(&ventas, &lineas, &pagos);
        assert!(d.ventas_descuadradas.is_empty());
        assert_eq!(d.total, total);
        assert_eq!(d.efectivo, total_ef);
        assert_eq!(d.departamentos.iter().map(|x| x.monto).sum::<i64>(), total);
        for dep in &d.departamentos {
            assert_eq!(dep.filas.iter().map(|f| f.monto).sum::<i64>(), dep.monto, "{}", dep.nombre);
            assert_eq!(dep.filas.iter().map(|f| f.efectivo).sum::<i64>(), dep.efectivo);
            assert_eq!(dep.por_forma.iter().map(|f| f.monto).sum::<i64>(), dep.monto);
            assert!(dep.filas.iter().all(|f| f.efectivo >= 0 && f.efectivo <= f.monto));
        }
    }
}

/// Corte de luz de verdad: OTRO proceso empieza un cobro (venta escrita, consecutivo sumado) y se
/// mata con abort() antes de confirmar. Al reabrir: base íntegra, nada a medias, el número sigue.
#[tokio::test]
async fn corte_de_luz_a_mitad_de_un_cobro() {
    if let Ok(dir) = std::env::var("POS_PRUEBA_CORTE") {
        // ── Proceso hijo: escribe a medias y "se va la luz".
        let bd = crate::bd::Bd::abrir(std::path::Path::new(&dir), None).await.unwrap();
        let mut tx = bd.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query("UPDATE cajas SET consecutivo_siguiente = consecutivo_siguiente + 1 WHERE id = ?").bind(CAJA_1).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO ventas (id, sucursal_id, caja_id, consecutivo, numero, fecha, usuario_id, subtotal, total) SELECT 'MEDIAS', sucursal_id, id, 1, '1', 'x', (SELECT id FROM usuarios LIMIT 1), 1000, 1000 FROM cajas WHERE id = ?")
            .bind(CAJA_1)
            .execute(&mut *tx)
            .await
            .unwrap();
        std::process::abort();
    }
    let dir = std::env::temp_dir().join(format!("pos-corte-{}", ulid()));
    let bd = crate::bd::Bd::abrir(&dir, None).await.unwrap();
    let t = crate::usuarios::crear_tecnico_inicial(&bd.pool, "735919").await.unwrap();
    let tec = crate::sesion::Actor { id: t.id, rol: crate::permisos::Rol::Tecnico, nombre: "T".into() };
    let c = crate::usuarios::crear(&bd.pool, &tec, "Luis", crate::permisos::Rol::Cajero, "2580").await.unwrap();
    let luis = crate::sesion::Actor { id: c.id, rol: crate::permisos::Rol::Cajero, nombre: "Luis".into() };
    let pid = producto(&bd.pool, 1000).await;
    abrir(&bd.pool, &luis, CAJA_1, &conteo(&[(1000, 1)])).await.unwrap();
    let antes: i64 = sqlx::query_scalar("SELECT consecutivo_siguiente FROM cajas WHERE id = ?").bind(CAJA_1).fetch_one(&bd.pool).await.unwrap();
    bd.pool.close().await;
    bd.lectura.close().await;

    let hijo = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "invariantes::corte_de_luz_a_mitad_de_un_cobro", "--nocapture"])
        .env("POS_PRUEBA_CORTE", &dir)
        .output()
        .unwrap();
    assert!(!hijo.status.success(), "el hijo debía morir a mitad del cobro");

    let bd = crate::bd::Bd::abrir(&dir, None).await.unwrap(); // abre (y revisa integridad)
    let p = &bd.pool;
    let ventas: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ventas").fetch_one(p).await.unwrap();
    let despues: i64 = sqlx::query_scalar("SELECT consecutivo_siguiente FROM cajas WHERE id = ?").bind(CAJA_1).fetch_one(p).await.unwrap();
    assert_eq!((ventas, despues), (0, antes), "nada a medias y el número no se gastó");
    // Y se sigue vendiendo con el número que tocaba.
    let e = est(&pid, 1000, 1);
    let esp = crear_espera(p, &luis, CAJA_1, &e).await.unwrap();
    cobrar(p, &luis, CAJA_1, &esp.id, &e, &[pago(EF, 1000)]).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT consecutivo FROM ventas").fetch_one(p).await.unwrap();
    assert_eq!(n, antes);
    bd.pool.close().await;
    bd.lectura.close().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// Restauración cortada a la mitad: el archivo a medias NO reemplaza la base al reiniciar.
#[test]
fn restauracion_a_medias_no_reemplaza_la_base() {
    let dir = std::env::temp_dir().join(format!("pos-medias-{}", ulid()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("pos.db"), b"la buena").unwrap();
    // Lo que deja un corte mientras se exportaba el respaldo.
    std::fs::write(dir.join("pos.db.nuevo.parcial"), b"medio archi").unwrap();
    assert!(crate::respaldo::aplicar_restauracion_pendiente(&dir).unwrap().is_none());
    assert_eq!(std::fs::read(dir.join("pos.db")).unwrap(), b"la buena");
    assert!(!dir.join("pos.db.nuevo.parcial").exists(), "el resto a medias se limpia");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Reloj de Windows atrasado DESPUÉS de abrir la caja: ni cobrar ni cerrar con una hora anterior a
/// lo último registrado (la venta quedaría mal fechada en el Z y en Ventas del día).
#[tokio::test]
async fn reloj_atrasado_frena_cobro_y_cierre() {
    let (bd, _, _, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    let pid = producto(p, 1000).await;
    abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 1)])).await.unwrap();
    let e = est(&pid, 1000, 1);
    let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
    cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago(EF, 1000)]).await.unwrap();
    // La última venta quedó "en el futuro" respecto del reloj actual: el reloj se atrasó.
    sqlx::query("UPDATE ventas SET fecha = '2999-01-01T00:00:00.000Z'").execute(p).await.unwrap();
    let esp2 = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
    let err = cobrar(p, &cajero, CAJA_1, &esp2.id, &e, &[pago(EF, 1000)]).await.unwrap_err();
    assert!(err.contains("hora de la computadora"), "{err}");
    let err = crate::caja::cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 2)]), "").await.unwrap_err();
    assert!(err.contains("hora de la computadora"), "{err}");
}

/// Uso de años: 2.000 productos y 50.000 ventas (250 turnos). Buscar en la venta (el mismo SQL que
/// manda la pantalla por bd_leer) en menos de 100 ms; el Z de un turno en menos de 3 s.
#[tokio::test]
async fn rapido_con_50000_ventas_y_2000_productos() {
    let (bd, _, dueno, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    let mut tx = p.begin().await.unwrap();
    for i in 0..2000 {
        let nombre = format!("Cuaderno modelo {i} rayado");
        sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, ?, ?, ?, 1000)").bind(format!("P{i}")).bind(&nombre).bind(nombre.to_lowercase()).bind(DEP).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO codigos (codigo, producto_id, tipo) VALUES (?, ?, 'barras')").bind(format!("740{i:010}")).bind(format!("P{i}")).execute(&mut *tx).await.unwrap();
    }
    let turnos = 250;
    for t in 0..turnos {
        let tid = format!("T{t}");
        let estado = if t + 1 == turnos { "abierto" } else { "cerrado" };
        sqlx::query("INSERT INTO caja_turnos (id, sucursal_id, caja_id, usuario_apertura_id, abierto_en, monto_inicial, estado, dia) SELECT ?, sucursal_id, id, ?, '2026-01-01T12:00:00.000Z', 0, ?, '2026-01-01' FROM cajas WHERE id = ?")
            .bind(&tid).bind(&cajero.id).bind(estado).bind(CAJA_1).execute(&mut *tx).await.unwrap();
        for k in 0..200 {
            let n = t * 200 + k;
            let vid = format!("V{n}");
            sqlx::query("INSERT INTO ventas (id, sucursal_id, caja_id, turno_id, consecutivo, numero, fecha, dia, usuario_id, subtotal, total) SELECT ?, sucursal_id, id, ?, ?, ?, '2026-01-01T12:00:00.000Z', '2026-01-01', ?, 2000, 2000 FROM cajas WHERE id = ?")
                .bind(&vid).bind(&tid).bind(n + 1).bind((n + 1).to_string()).bind(&cajero.id).bind(CAJA_1).execute(&mut *tx).await.unwrap();
            sqlx::query("INSERT INTO venta_lineas (id, venta_id, producto_id, descripcion, departamento_id, cantidad, precio_unitario, total) VALUES (?, ?, ?, 'Cuaderno', ?, 2, 1000, 2000)")
                .bind(format!("L{n}")).bind(&vid).bind(format!("P{}", n % 2000)).bind(DEP).execute(&mut *tx).await.unwrap();
            sqlx::query("INSERT INTO venta_pagos (id, venta_id, forma_pago_id, monto, recibido, vuelto, usuario_id, turno_id) VALUES (?, ?, ?, 2000, 2000, 0, ?, ?)")
                .bind(format!("G{n}")).bind(&vid).bind(EF).bind(&cajero.id).bind(&tid).execute(&mut *tx).await.unwrap();
        }
    }
    sqlx::query("UPDATE cajas SET consecutivo_siguiente = 50001").execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();

    // Búsqueda de la venta: lo que arma src/db/productos.ts (buscarProductos) por bd_leer.
    let sql = r"SELECT p.*, d.nombre AS departamento, (SELECT group_concat(c.codigo, ' ') FROM codigos c WHERE c.producto_id = p.id) AS lista_codigos
               FROM productos p JOIN departamentos d ON d.id = p.departamento_id
               WHERE p.eliminado_en IS NULL AND p.activo = 1 AND ((p.nombre_busqueda LIKE ? ESCAPE '\' AND p.nombre_busqueda LIKE ? ESCAPE '\') OR EXISTS (SELECT 1 FROM codigos c WHERE c.producto_id = p.id AND c.codigo LIKE ? ESCAPE '\'))
               ORDER BY EXISTS (SELECT 1 FROM codigos c WHERE c.producto_id = p.id AND c.codigo = ?) DESC, p.nombre_busqueda LIMIT 60 OFFSET 0";
    let params = [serde_json::json!("%cuaderno%"), serde_json::json!("%199%"), serde_json::json!("cuaderno 199%"), serde_json::json!("cuaderno 199")];
    let antes = std::time::Instant::now();
    for _ in 0..10 {
        bd.leer(&cajero, sql, &params).await.unwrap();
    }
    let busqueda = antes.elapsed() / 10;
    let antes = std::time::Instant::now();
    let d = detalle(p, &dueno, "T0").await.unwrap();
    let z = antes.elapsed();
    assert_eq!(d.resumen.total_ventas, 400_000);
    eprintln!("búsqueda {busqueda:?}, Z {z:?}");
    assert!(busqueda < std::time::Duration::from_millis(100), "búsqueda lenta: {busqueda:?}");
    assert!(z < std::time::Duration::from_secs(3), "Z lento: {z:?}");
}

/// Dueño que olvidó el PIN y quedó bloqueado: el técnico se lo restablece con SU sesión, queda en la
/// bitácora y el dueño entra obligado a cambiarlo. No hay clave maestra.
#[tokio::test]
async fn dueno_bloqueado_lo_recupera_el_tecnico() {
    use crate::usuarios::{cambiar_pin, iniciar_sesion, Login};
    let (bd, tec, dueno, _) = base_con_usuarios().await;
    let p = &bd.pool;
    let ahora = chrono::Utc::now().timestamp_millis();
    for i in 0..8 {
        let _ = iniciar_sesion(p, &dueno.id, "000000", ahora + i).await.unwrap();
    }
    assert!(matches!(iniciar_sesion(p, &dueno.id, PIN, ahora + 10).await.unwrap(), Login::Rechazado { .. }), "bloqueado");
    cambiar_pin(p, &tec, &dueno.id, "802468").await.unwrap();
    match iniciar_sesion(p, &dueno.id, "802468", ahora + 20).await.unwrap() {
        Login::Ok { usuario } => assert!(usuario.debe_cambiar_pin, "debe cambiarlo al entrar"),
        otro => panic!("no entró: {otro:?}"),
    }
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'usuario.pin' AND usuario_id = ? AND entidad_id = ?").bind(&tec.id).bind(&dueno.id).fetch_one(p).await.unwrap();
    assert_eq!(n, 1);
}

/// Consecutivo inicial: para seguir después del último tiquete del sistema anterior. Solo antes de
/// la primera venta de la caja, solo dueño o técnico, y queda en la bitácora.
#[tokio::test]
async fn consecutivo_inicial_solo_antes_de_la_primera_venta() {
    use crate::caja::fijar_consecutivo;
    let (bd, tec, dueno, cajero) = base_con_usuarios().await;
    let p = &bd.pool;
    assert!(fijar_consecutivo(p, &cajero, CAJA_1, 90001).await.unwrap_err().contains("permiso"));
    assert!(fijar_consecutivo(p, &tec, CAJA_1, 0).await.is_err());
    fijar_consecutivo(p, &tec, CAJA_1, 90001).await.unwrap();
    let pid = producto(p, 1000).await;
    abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 1)])).await.unwrap();
    let e = est(&pid, 1000, 1);
    let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
    let v = cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago(EF, 1000)]).await.unwrap();
    assert_eq!(v.numero, "90001");
    // Ya hubo una venta: cambiarlo repetiría o saltaría números de tiquetes entregados.
    assert!(fijar_consecutivo(p, &dueno, CAJA_1, 1).await.unwrap_err().contains("primera venta"));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'caja.consecutivo'").fetch_one(p).await.unwrap();
    assert_eq!(n, 1);
}
