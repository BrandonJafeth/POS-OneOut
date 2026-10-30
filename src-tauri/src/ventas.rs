// Venta: ventas en espera, cobro, consulta, reimpresión, corrección de pago, anulación y
// pendientes de factura. Todo se valida aquí aunque la pantalla ya lo haya hecho.
//
// Consecutivo sin saltos: el número se toma DENTRO de la transacción del cobro (BEGIN IMMEDIATE),
// así dos cobros a la vez se ponen en fila y un cobro que falla no gasta número.
//
// Turnos: solo se cobra con la caja abierta (turno de hoy) y la venta queda ligada al turno.
// Corregir o anular una venta de un turno CERRADO no cambia ese turno: es un ajuste del dueño
// que queda registrado en el turno actual.

use crate::bitacora;
use crate::caja::{self, Turno};
use crate::calculo::{self, Estado, Forma, PagoEntrada};
use crate::config;
use crate::permisos::{puede, sin_permiso, Rol};
use crate::sesion::Actor;
use crate::usuarios;
use crate::util::{ahora_iso, dia_local, e, texto, ulid, Res};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// ─────────── Ventas en espera ───────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Espera {
    pub id: String,
    pub numero: i64,
    pub usuario_id: String,
    pub estado: Value,
    pub actualizado_en: String,
}

fn a_espera(f: &sqlx::sqlite::SqliteRow) -> Espera {
    Espera {
        id: f.get("id"),
        numero: f.get("numero"),
        usuario_id: f.get("usuario_id"),
        estado: serde_json::from_str(&f.get::<String, _>("datos")).unwrap_or(json!({})),
        actualizado_en: f.get("actualizado_en"),
    }
}

pub async fn listar_esperas(pool: &SqlitePool, a: &Actor, caja_id: &str) -> Res<Vec<Espera>> {
    a.exigir("venta", "vender")?;
    let filas = sqlx::query("SELECT * FROM ventas_espera WHERE caja_id = ? AND eliminado_en IS NULL ORDER BY numero").bind(caja_id).fetch_all(pool).await.map_err(e)?;
    Ok(filas.iter().map(a_espera).collect())
}

fn estado_json(estado: &Estado) -> Res<String> {
    let s = serde_json::to_string(estado).map_err(e)?;
    if s.len() > 200_000 || estado.lineas.len() > 500 {
        return Err("La venta es demasiado grande".into());
    }
    Ok(s)
}

/// Nueva pestaña con el número libre más bajo (calculado dentro del INSERT).
pub async fn crear_espera(pool: &SqlitePool, a: &Actor, caja_id: &str, estado: &Estado) -> Res<Espera> {
    a.exigir("venta", "vender")?;
    let datos = estado_json(estado)?;
    let id = ulid();
    let ahora = ahora_iso();
    let activas = "SELECT numero FROM ventas_espera WHERE caja_id = ?2 AND eliminado_en IS NULL";
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    sqlx::query(&format!(
        "INSERT INTO ventas_espera (id, sucursal_id, caja_id, usuario_id, numero, datos, creado_en, actualizado_en)
         SELECT ?1, c.sucursal_id, c.id, ?3,
           (SELECT MIN(n + 1) FROM (SELECT 0 AS n UNION ALL {activas}) WHERE n + 1 NOT IN ({activas})),
           ?4, ?5, ?5
         FROM cajas c WHERE c.id = ?2"
    ))
    .bind(&id)
    .bind(caja_id)
    .bind(&a.id)
    .bind(&datos)
    .bind(&ahora)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    let f = sqlx::query("SELECT * FROM ventas_espera WHERE id = ?").bind(&id).fetch_one(&mut *tx).await.map_err(e)?;
    tx.commit().await.map_err(e)?;
    Ok(a_espera(&f))
}

/// Se llama en cada cambio de la venta: si se va la luz, queda lo último.
pub async fn guardar_espera(pool: &SqlitePool, a: &Actor, id: &str, estado: &Estado) -> Res<()> {
    a.exigir("venta", "vender")?;
    let datos = estado_json(estado)?;
    sqlx::query("UPDATE ventas_espera SET datos = ?, actualizado_en = ? WHERE id = ? AND eliminado_en IS NULL").bind(datos).bind(ahora_iso()).bind(id).execute(pool).await.map_err(e)?;
    Ok(())
}

pub async fn descartar_espera(pool: &SqlitePool, a: &Actor, id: &str) -> Res<()> {
    a.exigir("venta", "descartar ventas")?;
    let paso = config::entero(pool, "redondeo_total", 5).await;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let Some(f) = sqlx::query("SELECT * FROM ventas_espera WHERE id = ? AND eliminado_en IS NULL").bind(id).fetch_optional(&mut *tx).await.map_err(e)? else {
        return Ok(());
    };
    let esp = a_espera(&f);
    let est: Estado = serde_json::from_value(esp.estado.clone()).unwrap_or_default();
    let ahora = ahora_iso();
    sqlx::query("UPDATE ventas_espera SET eliminado_en = ?, actualizado_en = ? WHERE id = ?").bind(&ahora).bind(&ahora).bind(id).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "venta_espera.descartar", "venta_espera", Some(id), &json!({"numero": esp.numero, "lineas": est.lineas.len(), "total": calculo::totales(&est, paso).total})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

// ─────────── Autorización de descuento (un solo uso, la emite Rust) ───────────

struct Permiso {
    dueno_id: String,
    pct: f64,
    espera_id: String,
    vence: Instant,
}

fn autorizaciones() -> &'static Mutex<HashMap<String, Permiso>> {
    static A: OnceLock<Mutex<HashMap<String, Permiso>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutorizacionEmitida {
    pub dueno_id: String,
    pub pct: f64,
    pub token: String,
}

/// El dueño pone su PIN para un descuento mayor al tope. Vale para ESA venta, hasta ese %,
/// una sola vez y por 30 minutos. El frontend solo guarda el token, nunca el PIN.
pub async fn autorizar_descuento(pool: &SqlitePool, a: &Actor, espera_id: &str, pct: f64, pin: &str) -> Res<AutorizacionEmitida> {
    a.exigir("venta", "vender")?;
    if !(0.0..=100.0).contains(&pct) {
        return Err("Porcentaje inválido".into());
    }
    let dueno = usuarios::autorizar_dueno(pool, pin, "descuento", &a.id).await?;
    let token = ulid();
    let mut m = autorizaciones().lock().map_err(e)?;
    m.retain(|_, p| p.vence > Instant::now());
    m.insert(token.clone(), Permiso { dueno_id: dueno.clone(), pct, espera_id: espera_id.into(), vence: Instant::now() + Duration::from_secs(1800) });
    Ok(AutorizacionEmitida { dueno_id: dueno, pct, token })
}

fn tomar_autorizacion(token: &str, espera_id: &str, pct: f64) -> Option<String> {
    let mut m = autorizaciones().lock().ok()?;
    let p = m.remove(token)?;
    (p.espera_id == espera_id && p.vence > Instant::now() && pct <= p.pct + 1e-9).then_some(p.dueno_id)
}

// ─────────── Cobro ───────────

pub async fn formas(c: &mut SqliteConnection) -> Res<Vec<Forma>> {
    let filas = sqlx::query("SELECT id, nombre, requiere_banco, requiere_referencia, da_vuelto, pide_ultimos4 FROM formas_pago WHERE activo = 1 AND eliminado_en IS NULL").fetch_all(c).await.map_err(e)?;
    Ok(filas
        .iter()
        .map(|f| Forma {
            id: f.get("id"),
            nombre: f.get("nombre"),
            requiere_banco: f.get::<i64, _>("requiere_banco") == 1,
            requiere_referencia: f.get::<i64, _>("requiere_referencia") == 1,
            da_vuelto: f.get::<i64, _>("da_vuelto") == 1,
            pide_ultimos4: f.get::<i64, _>("pide_ultimos4") == 1,
        })
        .collect())
}

async fn banco_valido(c: &mut SqliteConnection, id: Option<&str>) -> Res<()> {
    if let Some(id) = id.filter(|s| !s.is_empty()) {
        let ok: Option<i64> = sqlx::query_scalar("SELECT 1 FROM bancos WHERE id = ? AND activo = 1 AND eliminado_en IS NULL").bind(id).fetch_optional(c).await.map_err(e)?;
        if ok.is_none() {
            return Err("Banco no disponible".into());
        }
    }
    Ok(())
}

pub async fn tope_descuento(pool: &SqlitePool, rol: Rol) -> f64 {
    config::valor(pool, "descuento_max_pct").await.and_then(|v| v.get(rol.como_str()).and_then(|x| x.as_f64())).unwrap_or(if rol == Rol::Cajero { 10.0 } else { 100.0 })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResultadoCobro {
    pub venta_id: String,
    pub numero: String,
    pub vuelto: i64,
    pub hay_efectivo: bool,
}

pub async fn cobrar(pool: &SqlitePool, a: &Actor, caja_id: &str, espera_id: &str, est: &Estado, pagos: &[PagoEntrada]) -> Res<ResultadoCobro> {
    a.exigir("venta", "vender")?;
    if est.lineas.is_empty() {
        return Err("La venta no tiene productos".into());
    }
    for l in &est.lineas {
        calculo::validar_linea(l)?;
    }
    let paso = config::entero(pool, "redondeo_total", 5).await;
    let tope = tope_descuento(pool, a.rol).await;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let t = caja::turno_para_vender(&mut tx, caja_id).await?;

    // Precio, IVA y departamento de un producto salen de la base, no de la pantalla.
    let mut lineas = est.lineas.clone();
    for l in lineas.iter_mut() {
        if let Some(pid) = l.producto_id.as_deref() {
            let p = sqlx::query("SELECT precio, tasa_iva, exento, departamento_id FROM productos WHERE id = ? AND eliminado_en IS NULL").bind(pid).fetch_optional(&mut *tx).await.map_err(e)?.ok_or_else(|| format!("\"{}\" ya no existe", l.descripcion))?;
            if p.get::<i64, _>("precio") != l.precio_unitario {
                return Err(format!("\"{}\": el precio cambió, vuelva a agregarlo", l.descripcion));
            }
            l.tasa_iva = p.get("tasa_iva");
            l.exento = p.get::<i64, _>("exento") == 1;
            l.departamento_id = p.get("departamento_id");
        } else {
            let ok: Option<i64> = sqlx::query_scalar("SELECT 1 FROM departamentos WHERE id = ? AND eliminado_en IS NULL").bind(&l.departamento_id).fetch_optional(&mut *tx).await.map_err(e)?;
            if ok.is_none() {
                return Err(format!("\"{}\": departamento inválido", l.descripcion));
            }
        }
    }
    let e2 = Estado { lineas, ..est.clone() };
    let tot = calculo::totales(&e2, paso);
    let mut autorizado_por = None;
    if tot.pct_descuento > tope + 1e-9 {
        let token = est.autorizacion.as_ref().and_then(|x| x.token.as_deref()).ok_or("El descuento pasa su tope: necesita el PIN del dueño")?;
        autorizado_por = Some(tomar_autorizacion(token, espera_id, tot.pct_descuento).ok_or("La autorización del descuento no es válida: pida el PIN otra vez")?);
    }
    if est.requiere_factura && est.cliente.is_none() {
        return Err("Para factura electrónica, elija o cree el cliente".into());
    }
    if let Some(cl) = &est.cliente {
        let ok: Option<i64> = sqlx::query_scalar("SELECT 1 FROM clientes WHERE id = ? AND anonimizado_en IS NULL").bind(&cl.id).fetch_optional(&mut *tx).await.map_err(e)?;
        if ok.is_none() {
            return Err("El cliente ya no existe".into());
        }
    }
    let nombre_tiquete = match est.nombre_tiquete.as_deref() {
        Some(n) => Some(texto(n, 80, "nombre en tiquete", false)?).filter(|s| !s.is_empty()),
        None => None,
    };
    let fs = formas(&mut tx).await?;
    let rp = calculo::pagos(tot.total, pagos, &fs);
    if !rp.errores.is_empty() {
        return Err(rp.errores.join(". "));
    }
    if rp.faltante > 0 {
        return Err(format!("Falta pagar {}", rp.faltante));
    }
    for p in pagos {
        banco_valido(&mut tx, p.banco_id.as_deref()).await?;
    }

    let venta_id = ulid();
    let fecha = ahora_iso();
    // El JOIN con la espera activa evita que un doble clic en "Cobrar" cree dos ventas.
    let n = sqlx::query(
        "INSERT INTO ventas (id, sucursal_id, caja_id, turno_id, consecutivo, numero, fecha, dia, usuario_id, cliente_id, nombre_tiquete,
           subtotal, descuento, redondeo, total, iva_total, requiere_factura, descuento_autorizado_por, creado_en, actualizado_en)
         SELECT ?, c.sucursal_id, c.id, ?, c.consecutivo_siguiente, c.prefijo_tiquete || c.consecutivo_siguiente, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM cajas c JOIN ventas_espera e ON e.id = ? AND e.caja_id = c.id AND e.eliminado_en IS NULL
         WHERE c.id = ? AND c.eliminado_en IS NULL",
    )
    .bind(&venta_id)
    .bind(&t.id)
    .bind(&fecha)
    .bind(dia_local())
    .bind(&a.id)
    .bind(est.cliente.as_ref().map(|c| c.id.clone()))
    .bind(&nombre_tiquete)
    .bind(tot.subtotal)
    .bind(tot.descuento)
    .bind(tot.redondeo)
    .bind(tot.total)
    .bind(tot.iva)
    .bind(est.requiere_factura as i64)
    .bind(&autorizado_por)
    .bind(&fecha)
    .bind(&fecha)
    .bind(espera_id)
    .bind(caja_id)
    .execute(&mut *tx)
    .await
    .map_err(e)?
    .rows_affected();
    if n == 0 {
        return Err("Esta venta ya se cobró o se descartó".into());
    }
    sqlx::query("UPDATE cajas SET consecutivo_siguiente = consecutivo_siguiente + 1, actualizado_en = ? WHERE id = ?").bind(&fecha).bind(caja_id).execute(&mut *tx).await.map_err(e)?;
    for (i, l) in e2.lineas.iter().enumerate() {
        sqlx::query(
            "INSERT INTO venta_lineas (id, venta_id, producto_id, codigo, descripcion, departamento_id, cantidad, precio_unitario,
               descuento, total, tasa_iva, iva, orden, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(ulid())
        .bind(&venta_id)
        .bind(&l.producto_id)
        .bind(&l.codigo)
        .bind(&l.descripcion)
        .bind(&l.departamento_id)
        .bind(l.cantidad)
        .bind(l.precio_unitario)
        .bind(l.descuento)
        .bind(calculo::importe(l))
        .bind(if l.exento { 0.0 } else { l.tasa_iva })
        .bind(tot.iva_lineas[i])
        .bind(i as i64)
        .bind(&fecha)
        .bind(&fecha)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    }
    for ap in &rp.aplicados {
        sqlx::query(
            "INSERT INTO venta_pagos (id, venta_id, forma_pago_id, banco_id, monto, recibido, vuelto, referencia, ultimos4, creado_en, actualizado_en)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(ulid())
        .bind(&venta_id)
        .bind(&ap.pago.forma_pago_id)
        .bind(ap.pago.banco_id.as_deref().filter(|s| !s.is_empty()))
        .bind(ap.aplicado)
        .bind(ap.recibido)
        .bind(ap.vuelto)
        .bind(ap.pago.referencia.as_deref().map(str::trim).filter(|s| !s.is_empty()))
        .bind(ap.pago.ultimos4.as_deref().filter(|s| !s.is_empty()))
        .bind(&fecha)
        .bind(&fecha)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    }
    sqlx::query("UPDATE ventas_espera SET eliminado_en = ?, venta_id = ?, datos = ?, actualizado_en = ? WHERE id = ?")
        .bind(&fecha)
        .bind(&venta_id)
        .bind(estado_json(&e2)?)
        .bind(&fecha)
        .bind(espera_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    if let Some(d) = &autorizado_por {
        bitacora::registrar(&mut tx, Some(&a.id), "venta.descuento_autorizado", "venta", Some(&venta_id), &json!({"pct": (tot.pct_descuento * 10.0).round() / 10.0, "autorizadoPor": d})).await?;
    }
    let numero: String = sqlx::query_scalar("SELECT numero FROM ventas WHERE id = ?").bind(&venta_id).fetch_one(&mut *tx).await.map_err(e)?;
    tx.commit().await.map_err(e)?;
    let efectivo: Vec<&str> = fs.iter().filter(|f| f.da_vuelto).map(|f| f.id.as_str()).collect();
    Ok(ResultadoCobro { venta_id, numero, vuelto: rp.vuelto, hay_efectivo: rp.aplicados.iter().any(|x| efectivo.contains(&x.pago.forma_pago_id.as_str())) })
}

// ─────────── Consultas ───────────

fn puede_consultar(a: &Actor) -> Res<()> {
    if puede(a.rol, "venta") || puede(a.rol, "reportes") {
        Ok(())
    } else {
        Err(sin_permiso("ver ventas"))
    }
}

pub async fn obtener(pool: &SqlitePool, a: &Actor, id: &str) -> Res<Option<Value>> {
    puede_consultar(a)?;
    let Some(f) = sqlx::query(
        "SELECT v.*, u.nombre AS cajero, c.nombre AS cliente, t.estado AS turno_estado FROM ventas v
         JOIN usuarios u ON u.id = v.usuario_id LEFT JOIN clientes c ON c.id = v.cliente_id LEFT JOIN caja_turnos t ON t.id = v.turno_id
         WHERE v.id = ? AND v.eliminado_en IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(e)?
    else {
        return Ok(None);
    };
    let lineas = sqlx::query("SELECT * FROM venta_lineas WHERE venta_id = ? AND eliminado_en IS NULL ORDER BY orden").bind(id).fetch_all(pool).await.map_err(e)?;
    let pagos = sqlx::query(
        "SELECT p.*, f.nombre AS forma, f.tipo, b.nombre AS banco FROM venta_pagos p
         JOIN formas_pago f ON f.id = p.forma_pago_id LEFT JOIN bancos b ON b.id = p.banco_id
         WHERE p.venta_id = ? AND p.eliminado_en IS NULL ORDER BY p.creado_en, p.id",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(e)?;
    let fecha: String = f.get("fecha");
    Ok(Some(json!({
        "id": f.get::<String, _>("id"),
        "cajaId": f.get::<String, _>("caja_id"),
        "turnoId": f.get::<Option<String>, _>("turno_id"),
        // Sin turno (ventas anteriores a los turnos) cuenta como cerrado.
        "turnoAbierto": f.get::<Option<String>, _>("turno_estado").as_deref() == Some("abierto"),
        "consecutivo": f.get::<i64, _>("consecutivo"),
        "numero": f.get::<String, _>("numero"),
        "dia": f.get::<Option<String>, _>("dia").unwrap_or_else(|| fecha.chars().take(10).collect()),
        "fecha": fecha,
        "usuarioId": f.get::<String, _>("usuario_id"),
        "cajero": f.get::<String, _>("cajero"),
        "clienteId": f.get::<Option<String>, _>("cliente_id"),
        "cliente": f.get::<Option<String>, _>("cliente"),
        "nombreTiquete": f.get::<Option<String>, _>("nombre_tiquete"),
        "subtotal": f.get::<i64, _>("subtotal"),
        "descuento": f.get::<i64, _>("descuento"),
        "redondeo": f.get::<i64, _>("redondeo"),
        "total": f.get::<i64, _>("total"),
        "ivaTotal": f.get::<Option<i64>, _>("iva_total").unwrap_or(0),
        "estado": f.get::<String, _>("estado"),
        "anuladaMotivo": f.get::<Option<String>, _>("anulada_motivo"),
        "requiereFactura": f.get::<i64, _>("requiere_factura") == 1,
        "facturaEmitida": f.get::<i64, _>("factura_emitida") == 1,
        "facturaReferencia": f.get::<Option<String>, _>("factura_referencia"),
        "reimpresiones": f.get::<i64, _>("reimpresiones"),
        "lineas": lineas.iter().map(|l| json!({
            "id": l.get::<String, _>("id"),
            "productoId": l.get::<Option<String>, _>("producto_id"),
            "codigo": l.get::<Option<String>, _>("codigo"),
            "descripcion": l.get::<String, _>("descripcion"),
            "departamentoId": l.get::<String, _>("departamento_id"),
            "cantidad": l.get::<i64, _>("cantidad"),
            "precioUnitario": l.get::<i64, _>("precio_unitario"),
            "descuento": l.get::<i64, _>("descuento"),
            "total": l.get::<i64, _>("total"),
            "tasaIva": l.get::<f64, _>("tasa_iva"),
            "iva": l.get::<i64, _>("iva"),
        })).collect::<Vec<_>>(),
        "pagos": pagos.iter().map(|p| json!({
            "id": p.get::<String, _>("id"),
            "formaPagoId": p.get::<String, _>("forma_pago_id"),
            "forma": p.get::<String, _>("forma"),
            "tipo": p.get::<String, _>("tipo"),
            "monto": p.get::<i64, _>("monto"),
            "recibido": p.get::<Option<i64>, _>("recibido"),
            "vuelto": p.get::<Option<i64>, _>("vuelto"),
            "bancoId": p.get::<Option<String>, _>("banco_id"),
            "banco": p.get::<Option<String>, _>("banco"),
            "referencia": p.get::<Option<String>, _>("referencia"),
            "ultimos4": p.get::<Option<String>, _>("ultimos4"),
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VentaResumen {
    pub id: String,
    pub numero: String,
    pub fecha: String,
    pub total: i64,
    pub estado: String,
    pub cajero: String,
    pub requiere_factura: bool,
    pub factura_emitida: bool,
    pub formas: String,
    pub turno_abierto: bool,
}

pub async fn listar_dia(pool: &SqlitePool, a: &Actor, caja_id: &str, dia: &str) -> Res<Vec<VentaResumen>> {
    puede_consultar(a)?;
    let filas = sqlx::query(
        "SELECT v.id, v.numero, v.fecha, v.total, v.estado, v.requiere_factura, v.factura_emitida, u.nombre AS cajero, t.estado AS turno_estado,
           (SELECT group_concat(f.nombre, ' + ') FROM venta_pagos p JOIN formas_pago f ON f.id = p.forma_pago_id
            WHERE p.venta_id = v.id AND p.eliminado_en IS NULL) AS formas
         FROM ventas v JOIN usuarios u ON u.id = v.usuario_id LEFT JOIN caja_turnos t ON t.id = v.turno_id
         WHERE v.caja_id = ? AND v.dia = ? AND v.eliminado_en IS NULL ORDER BY v.consecutivo DESC",
    )
    .bind(caja_id)
    .bind(dia)
    .fetch_all(pool)
    .await
    .map_err(e)?;
    Ok(filas
        .iter()
        .map(|f| VentaResumen {
            id: f.get("id"),
            numero: f.get("numero"),
            fecha: f.get("fecha"),
            total: f.get("total"),
            estado: f.get("estado"),
            cajero: f.get("cajero"),
            requiere_factura: f.get::<i64, _>("requiere_factura") == 1,
            factura_emitida: f.get::<i64, _>("factura_emitida") == 1,
            formas: f.get::<Option<String>, _>("formas").unwrap_or_default(),
            turno_abierto: f.get::<Option<String>, _>("turno_estado").as_deref() == Some("abierto"),
        })
        .collect())
}

pub async fn registrar_reimpresion(pool: &SqlitePool, a: &Actor, venta_id: &str) -> Res<()> {
    a.exigir("venta", "reimprimir")?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let n = sqlx::query("UPDATE ventas SET reimpresiones = reimpresiones + 1 WHERE id = ?").bind(venta_id).execute(&mut *tx).await.map_err(e)?.rows_affected();
    if n == 0 {
        return Err("Venta no encontrada".into());
    }
    bitacora::registrar(&mut tx, Some(&a.id), "venta.reimprimir", "venta", Some(venta_id), &json!({})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

pub async fn correcciones_de(pool: &SqlitePool, a: &Actor, venta_id: &str) -> Res<Vec<Value>> {
    puede_consultar(a)?;
    let filas = sqlx::query(
        "SELECT c.fecha, c.motivo, fa.nombre AS antes, fn.nombre AS despues, u.nombre AS usuario, 'turno' AS donde FROM venta_pago_correcciones c
         JOIN venta_pagos p ON p.id = c.venta_pago_id JOIN formas_pago fa ON fa.id = c.forma_pago_anterior_id
         JOIN formas_pago fn ON fn.id = c.forma_pago_nueva_id JOIN usuarios u ON u.id = c.usuario_id
         WHERE p.venta_id = ?1
         UNION ALL
         SELECT a.fecha, a.motivo, json_extract(a.valor_anterior, '$.forma'), json_extract(a.valor_nuevo, '$.forma'), u.nombre, 'ajuste'
         FROM caja_ajustes a JOIN usuarios u ON u.id = a.usuario_id WHERE a.venta_id = ?1 AND a.tipo = 'pago'
         ORDER BY 1",
    )
    .bind(venta_id)
    .fetch_all(pool)
    .await
    .map_err(e)?;
    Ok(filas.iter().map(crate::bd::fila_json).map(Value::Object).collect())
}

// ─────────── Corrección de forma de pago ───────────

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CambioPago {
    pub forma_pago_id: String,
    pub banco_id: Option<String>,
    pub referencia: Option<String>,
    pub ultimos4: Option<String>,
}

/// Turno de la venta: Some(abierto) o None (cerrado, o venta anterior a los turnos).
async fn turno_de_venta(c: &mut SqliteConnection, turno_id: Option<String>) -> Res<Option<Turno>> {
    match turno_id {
        Some(id) => Ok(caja::turno(c, &id).await?.filter(|t| t.estado == "abierto")),
        None => Ok(None),
    }
}

/// Cambia la forma de pago (p. ej. se marcó Tarjeta y era SINPE). El monto no cambia.
/// Turno abierto: se corrige el pago (PIN del dueño si entra o sale efectivo).
/// Turno cerrado: solo el dueño con PIN; queda como ajuste en el turno actual y el pago original no se toca.
pub async fn corregir_pago(pool: &SqlitePool, a: &Actor, caja_id: &str, pago_id: &str, cambio: &CambioPago, motivo: &str, pin_dueno: Option<&str>) -> Res<()> {
    a.exigir("venta", "corregir pagos")?;
    let motivo = texto(motivo, 300, "motivo", true)?;
    if motivo.chars().count() < 5 {
        return Err("Escriba el motivo de la corrección".into());
    }
    let pin = pin_dueno.unwrap_or("");
    // Primero se lee (sin bloquear) para saber si hace falta el PIN; se vuelve a leer dentro de la transacción.
    let mut c = pool.acquire().await.map_err(e)?;
    let (turno_previo, cambia_efectivo) = {
        let p = sqlx::query("SELECT v.turno_id, f.da_vuelto FROM venta_pagos p JOIN ventas v ON v.id = p.venta_id JOIN formas_pago f ON f.id = p.forma_pago_id WHERE p.id = ? AND p.eliminado_en IS NULL")
            .bind(pago_id)
            .fetch_optional(&mut *c)
            .await
            .map_err(e)?
            .ok_or("Pago no encontrado")?;
        let nueva_vuelto: Option<i64> = sqlx::query_scalar("SELECT da_vuelto FROM formas_pago WHERE id = ? AND activo = 1 AND eliminado_en IS NULL").bind(&cambio.forma_pago_id).fetch_optional(&mut *c).await.map_err(e)?;
        (turno_de_venta(&mut c, p.get("turno_id")).await?, nueva_vuelto.is_some_and(|n| n != p.get::<i64, _>("da_vuelto")))
    };
    drop(c);
    let cerrado = turno_previo.is_none();
    let autorizado = if cerrado {
        Some(usuarios::confirmar_dueno(pool, a, pin, "corregir pago de turno cerrado").await?)
    } else if cambia_efectivo {
        if pin.is_empty() {
            return Err("El cambio afecta el efectivo de la caja: necesita el PIN del dueño".into());
        }
        Some(usuarios::autorizar_dueno(pool, pin, "corregir pago con efectivo", &a.id).await?)
    } else {
        None
    };

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let p = sqlx::query(
        "SELECT p.*, v.turno_id, v.estado, f.da_vuelto, f.nombre AS forma FROM venta_pagos p
         JOIN ventas v ON v.id = p.venta_id JOIN formas_pago f ON f.id = p.forma_pago_id WHERE p.id = ? AND p.eliminado_en IS NULL",
    )
    .bind(pago_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(e)?
    .ok_or("Pago no encontrado")?;
    if p.get::<String, _>("estado") != "completada" {
        return Err("La venta está anulada".into());
    }
    let turno_venta = turno_de_venta(&mut tx, p.get("turno_id")).await?;
    if turno_venta.is_none() != cerrado {
        return Err("La caja cambió mientras tanto: intente de nuevo".into());
    }
    let fs = formas(&mut tx).await?;
    let nueva = fs.iter().find(|f| f.id == cambio.forma_pago_id).ok_or("Forma de pago no disponible")?;
    if nueva.requiere_banco && cambio.banco_id.as_deref().unwrap_or("").is_empty() {
        return Err(format!("{}: elija el banco", nueva.nombre));
    }
    banco_valido(&mut tx, cambio.banco_id.as_deref()).await?;
    let referencia = texto(cambio.referencia.as_deref().unwrap_or(""), 60, "referencia", false)?;
    if nueva.requiere_referencia && referencia.is_empty() {
        return Err(format!("{}: escriba la referencia", nueva.nombre));
    }
    if let Some(u) = cambio.ultimos4.as_deref().filter(|u| !u.is_empty()) {
        if u.len() != 4 || !u.chars().all(|c| c.is_ascii_digit()) {
            return Err("Los últimos 4 dígitos son 4 números".into());
        }
    }
    let n_banco = if nueva.requiere_banco { cambio.banco_id.clone().filter(|s| !s.is_empty()) } else { None };
    let n_ref = (!referencia.is_empty()).then_some(referencia);
    let n_u4 = if nueva.pide_ultimos4 { cambio.ultimos4.clone().filter(|s| !s.is_empty()) } else { None };
    let (a_forma, a_banco, a_ref, a_u4): (String, Option<String>, Option<String>, Option<String>) = (p.get("forma_pago_id"), p.get("banco_id"), p.get("referencia"), p.get("ultimos4"));
    if nueva.id == a_forma && n_banco == a_banco && n_ref == a_ref && n_u4 == a_u4 {
        return Err("No hay cambios".into());
    }
    let monto: i64 = p.get("monto");
    let venta_id: String = p.get("venta_id");
    let ahora = ahora_iso();
    let antes = json!({"formaPagoId": a_forma, "forma": p.get::<String, _>("forma"), "banco": a_banco, "referencia": a_ref, "ultimos4": a_u4});
    let despues = json!({"formaPagoId": nueva.id, "forma": nueva.nombre, "banco": n_banco, "referencia": n_ref, "ultimos4": n_u4});

    if let Some(t) = &turno_venta {
        let estaba_efectivo = p.get::<i64, _>("da_vuelto") == 1;
        let id = ulid();
        sqlx::query(
            "INSERT INTO venta_pago_correcciones (id, venta_pago_id, forma_pago_anterior_id, forma_pago_nueva_id, banco_anterior_id, banco_nuevo_id,
               referencia_anterior, referencia_nueva, ultimos4_anterior, ultimos4_nuevo, motivo, usuario_id, autorizado_por, fecha, turno_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(pago_id)
        .bind(&a_forma)
        .bind(&nueva.id)
        .bind(&a_banco)
        .bind(&n_banco)
        .bind(&a_ref)
        .bind(&n_ref)
        .bind(&a_u4)
        .bind(&n_u4)
        .bind(&motivo)
        .bind(&a.id)
        .bind(&autorizado)
        .bind(&ahora)
        .bind(&t.id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
        // Al pasar a efectivo, lo recibido es el monto (sin vuelto); al salir del efectivo se borra recibido/vuelto.
        let (recibido, vuelto) = match (nueva.da_vuelto, estaba_efectivo) {
            (true, true) => (Some(p.get::<Option<i64>, _>("recibido").unwrap_or(monto)), Some(p.get::<Option<i64>, _>("vuelto").unwrap_or(0))),
            (true, false) => (Some(monto), Some(0)),
            _ => (None, None),
        };
        sqlx::query("UPDATE venta_pagos SET forma_pago_id = ?, banco_id = ?, referencia = ?, ultimos4 = ?, recibido = ?, vuelto = ?, actualizado_en = ? WHERE id = ?")
            .bind(&nueva.id)
            .bind(&n_banco)
            .bind(&n_ref)
            .bind(&n_u4)
            .bind(recibido)
            .bind(vuelto)
            .bind(&ahora)
            .bind(pago_id)
            .execute(&mut *tx)
            .await
            .map_err(e)?;
        bitacora::registrar(&mut tx, Some(&a.id), "venta.pago_corregido", "venta", Some(&venta_id), &json!({"pagoId": pago_id, "correccionId": id, "monto": monto, "antes": antes, "despues": despues, "autorizadoPor": autorizado})).await?;
    } else {
        let actual = caja::turno_para_vender(&mut tx, caja_id).await.map_err(|_| "Para ajustar una venta de un turno cerrado, abra la caja de hoy".to_string())?;
        let id = ulid();
        let mut ant = antes.clone();
        ant["pagoId"] = json!(pago_id);
        sqlx::query("INSERT INTO caja_ajustes (id, turno_id, venta_id, tipo, valor_anterior, valor_nuevo, monto, motivo, usuario_id, autorizado_por, fecha) VALUES (?, ?, ?, 'pago', ?, ?, ?, ?, ?, ?, ?)")
            .bind(&id)
            .bind(&actual.id)
            .bind(&venta_id)
            .bind(ant.to_string())
            .bind(despues.to_string())
            .bind(monto)
            .bind(&motivo)
            .bind(&a.id)
            .bind(&autorizado)
            .bind(&ahora)
            .execute(&mut *tx)
            .await
            .map_err(e)?;
        bitacora::registrar(&mut tx, Some(&a.id), "caja.ajuste_pago", "venta", Some(&venta_id), &json!({"ajusteId": id, "turnoId": actual.id, "pagoId": pago_id, "monto": monto, "antes": antes, "despues": despues, "motivo": motivo})).await?;
    }
    tx.commit().await.map_err(e)?;
    Ok(())
}

// ─────────── Anulación ───────────

/// Turno abierto: PIN del dueño y motivo. Turno cerrado (o venta sin turno): solo el dueño, con
/// PIN; queda como ajuste en el turno actual y, si se devolvió efectivo, como salida de caja.
pub async fn anular(pool: &SqlitePool, a: &Actor, caja_id: &str, venta_id: &str, pin: &str, motivo: &str, devolucion_efectivo: i64) -> Res<()> {
    a.exigir("venta", "anular ventas")?;
    let motivo = texto(motivo, 300, "motivo", true)?;
    if motivo.chars().count() < 5 {
        return Err("Escriba el motivo de la anulación".into());
    }
    let turno_id: Option<Option<String>> = sqlx::query_scalar("SELECT turno_id FROM ventas WHERE id = ? AND eliminado_en IS NULL").bind(venta_id).fetch_optional(pool).await.map_err(e)?;
    let turno_id = turno_id.ok_or("Venta no encontrada")?;
    let cerrado = {
        let mut c = pool.acquire().await.map_err(e)?;
        turno_de_venta(&mut c, turno_id).await?.is_none()
    };
    if !cerrado && devolucion_efectivo != 0 {
        return Err("En el turno abierto la anulación ya descuenta el efectivo de la venta".into());
    }
    let dueno = if cerrado { usuarios::confirmar_dueno(pool, a, pin, "anular venta de turno cerrado").await? } else { usuarios::autorizar_dueno(pool, pin, "anular venta", &a.id).await? };

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let v = sqlx::query("SELECT numero, total, estado, turno_id FROM ventas WHERE id = ? AND eliminado_en IS NULL").bind(venta_id).fetch_one(&mut *tx).await.map_err(e)?;
    if v.get::<String, _>("estado") == "anulada" {
        return Err("La venta ya está anulada".into());
    }
    if turno_de_venta(&mut tx, v.get("turno_id")).await?.is_none() != cerrado {
        return Err("La caja cambió mientras tanto: intente de nuevo".into());
    }
    let total: i64 = v.get("total");
    let numero: String = v.get("numero");
    let ahora = ahora_iso();
    sqlx::query("UPDATE ventas SET estado = 'anulada', anulada_por = ?, anulada_motivo = ?, anulada_en = ?, actualizado_en = ? WHERE id = ?")
        .bind(&dueno)
        .bind(&motivo)
        .bind(&ahora)
        .bind(&ahora)
        .bind(venta_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    let mut det = json!({"numero": numero, "total": total, "motivo": motivo, "autorizadoPor": dueno});
    if cerrado {
        let actual = caja::turno_para_vender(&mut tx, caja_id).await.map_err(|_| "Para anular una venta de un turno cerrado, abra la caja de hoy".to_string())?;
        if !(0..=total).contains(&devolucion_efectivo) {
            return Err("La devolución no puede pasar del total de la venta".into());
        }
        if devolucion_efectivo > 0 && devolucion_efectivo > caja::resumen(&mut tx, &actual).await?.efectivo_esperado {
            return Err("No hay tanto efectivo en la caja para devolver".into());
        }
        let id = ulid();
        sqlx::query("INSERT INTO caja_ajustes (id, turno_id, venta_id, tipo, valor_anterior, valor_nuevo, monto, motivo, usuario_id, autorizado_por, fecha) VALUES (?, ?, ?, 'anulacion', ?, ?, ?, ?, ?, ?, ?)")
            .bind(&id)
            .bind(&actual.id)
            .bind(venta_id)
            .bind(json!({"estado": "completada", "turnoId": v.get::<Option<String>, _>("turno_id")}).to_string())
            .bind(json!({"estado": "anulada", "devolucionEfectivo": devolucion_efectivo}).to_string())
            .bind(total)
            .bind(&motivo)
            .bind(&a.id)
            .bind(&dueno)
            .bind(&ahora)
            .execute(&mut *tx)
            .await
            .map_err(e)?;
        if devolucion_efectivo > 0 {
            caja::insertar_movimiento(&mut tx, &actual, a, "salida", devolucion_efectivo, "Devolución", &format!("Anulación tiquete {numero}"), Some(&dueno)).await?;
        }
        det["ajusteId"] = json!(id);
        det["turnoActual"] = json!(actual.id);
        det["devolucionEfectivo"] = json!(devolucion_efectivo);
    }
    bitacora::registrar(&mut tx, Some(&a.id), "venta.anular", "venta", Some(venta_id), &det).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

// ─────────── Factura electrónica externa ───────────

pub async fn pendientes_factura(pool: &SqlitePool, a: &Actor) -> Res<Vec<Value>> {
    a.exigir("facturas", "ver pendientes de factura")?;
    let filas = sqlx::query(
        "SELECT v.id AS ventaId, v.numero, v.fecha, v.total, c.id AS clienteId, c.nombre AS cliente, c.cedula, (c.correo IS NOT NULL) AS tieneCorreo
         FROM ventas v JOIN clientes c ON c.id = v.cliente_id
         WHERE v.requiere_factura = 1 AND v.factura_emitida = 0 AND v.estado = 'completada' AND v.eliminado_en IS NULL ORDER BY v.fecha",
    )
    .fetch_all(pool)
    .await
    .map_err(e)?;
    Ok(filas
        .iter()
        .map(|f| {
            let mut m = crate::bd::fila_json(f);
            m.insert("tieneCorreo".into(), json!(f.get::<i64, _>("tieneCorreo") == 1));
            Value::Object(m)
        })
        .collect())
}

pub async fn marcar_factura(pool: &SqlitePool, a: &Actor, venta_id: &str, referencia: &str) -> Res<()> {
    a.exigir("facturas", "marcar facturas")?;
    let r = texto(referencia, 80, "referencia", true)?;
    let ahora = ahora_iso();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let n = sqlx::query(
        "UPDATE ventas SET factura_emitida = 1, factura_referencia = ?, factura_marcada_por = ?, factura_marcada_en = ?, actualizado_en = ?
         WHERE id = ? AND requiere_factura = 1 AND factura_emitida = 0",
    )
    .bind(&r)
    .bind(&a.id)
    .bind(&ahora)
    .bind(&ahora)
    .bind(venta_id)
    .execute(&mut *tx)
    .await
    .map_err(e)?
    .rows_affected();
    if n == 0 {
        return Err("Esa venta no está pendiente de factura".into());
    }
    bitacora::registrar(&mut tx, Some(&a.id), "venta.factura_emitida", "venta", Some(venta_id), &json!({"referencia": r})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caja::tests::conteo;
    use crate::caja::{abrir, cerrar, detalle, CAJA_1};
    use crate::calculo::{Autorizacion, Linea};
    use crate::usuarios::tests::base_con_usuarios;

    async fn producto(p: &SqlitePool, precio: i64) -> (String, String) {
        let dep: String = sqlx::query_scalar("SELECT id FROM departamentos WHERE eliminado_en IS NULL LIMIT 1").fetch_one(p).await.unwrap();
        let id = ulid();
        sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, 'Cuaderno', 'cuaderno', ?, ?)").bind(&id).bind(&dep).bind(precio).execute(p).await.unwrap();
        (id, dep)
    }

    fn est(pid: &str, dep: &str, precio: i64, cantidad: i64, descuento: i64) -> Estado {
        Estado {
            lineas: vec![Linea { id: "l1".into(), producto_id: Some(pid.into()), codigo: None, descripcion: "Cuaderno".into(), departamento_id: dep.into(), cantidad, precio_unitario: precio, descuento, tasa_iva: 13.0, exento: false }],
            ..Default::default()
        }
    }

    fn pago(f: &str, m: i64) -> PagoEntrada {
        PagoEntrada { forma_pago_id: f.into(), monto: m, banco_id: None, referencia: None, ultimos4: None }
    }
    const EF: &str = "0000000000000000000000FP01";
    const TJ: &str = "0000000000000000000000FP02";
    const SP: &str = "0000000000000000000000FP03";

    #[tokio::test]
    async fn cobro_exige_turno_y_valida_precio_y_descuento() {
        let (bd, tec, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let (pid, dep) = producto(p, 1000).await;
        let e = est(&pid, &dep, 1000, 2, 0);
        let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
        // Sin caja abierta no se vende.
        assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago(EF, 2000)]).await.unwrap_err().contains("cerrada"));
        // El técnico no vende.
        assert!(cobrar(p, &tec, CAJA_1, &esp.id, &e, &[pago(EF, 2000)]).await.unwrap_err().contains("permiso"));
        abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
        // Precio manipulado en la pantalla: rechazado.
        let barato = est(&pid, &dep, 1, 2, 0);
        assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &barato, &[pago(EF, 2)]).await.unwrap_err().contains("precio"));
        // Descuento sobre el tope del cajero (10 %) sin autorización: no. Con un duenoId inventado: tampoco.
        let mut desc = est(&pid, &dep, 1000, 2, 1000);
        assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &desc, &[pago(EF, 1000)]).await.unwrap_err().contains("PIN"));
        desc.autorizacion = Some(Autorizacion { dueno_id: dueno.id.clone(), pct: 50.0, token: Some("inventado".into()) });
        assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &desc, &[pago(EF, 1000)]).await.unwrap_err().contains("autorización"));
        let aut = autorizar_descuento(p, &cajero, &esp.id, 50.0, "246813").await.unwrap();
        desc.autorizacion = Some(Autorizacion { dueno_id: aut.dueno_id, pct: 50.0, token: Some(aut.token) });
        let r = cobrar(p, &cajero, CAJA_1, &esp.id, &desc, &[pago(EF, 5000)]).await.unwrap();
        assert_eq!(r.vuelto, 4000);
        // Doble clic: la espera ya se cobró.
        assert!(cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago(EF, 2000)]).await.is_err());
        let turno: String = sqlx::query_scalar("SELECT turno_id FROM ventas WHERE id = ?").bind(&r.venta_id).fetch_one(p).await.unwrap();
        assert_eq!(detalle(p, &cajero, &turno).await.unwrap().resumen.efectivo_esperado, 10000 + 1000);
    }

    #[tokio::test]
    async fn turno_cerrado_pagos_inmutables_y_ajustes() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let (pid, dep) = producto(p, 5000).await;
        let t1 = abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
        let e = est(&pid, &dep, 5000, 1, 0);
        let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
        let v = cobrar(p, &cajero, CAJA_1, &esp.id, &e, &[pago(TJ, 5000)]).await.unwrap();
        let pago_id: String = sqlx::query_scalar("SELECT id FROM venta_pagos WHERE venta_id = ?").bind(&v.venta_id).fetch_one(p).await.unwrap();
        let sinpe = CambioPago { forma_pago_id: SP.into(), banco_id: None, referencia: Some("12345".into()), ultimos4: None };
        // Turno abierto: el cajero corrige sin PIN (no toca efectivo).
        corregir_pago(p, &cajero, CAJA_1, &pago_id, &sinpe, "Era SINPE, no tarjeta", None).await.unwrap();
        cerrar(p, &cajero, CAJA_1, &conteo(&[(1000, 10)]), "").await.unwrap();

        // Ni directo en la base se puede cambiar un pago de un turno cerrado.
        assert!(sqlx::query("UPDATE venta_pagos SET monto = 1 WHERE id = ?").bind(&pago_id).execute(p).await.unwrap_err().to_string().contains("turno cerrado"));
        assert!(sqlx::query("UPDATE ventas SET total = 1 WHERE id = ?").bind(&v.venta_id).execute(p).await.is_err());

        let tarjeta = CambioPago { forma_pago_id: TJ.into(), banco_id: None, referencia: None, ultimos4: None };
        // Cajero: no puede ajustar un turno cerrado.
        assert!(corregir_pago(p, &cajero, CAJA_1, &pago_id, &tarjeta, "Era tarjeta al final", Some("246813")).await.unwrap_err().contains("permiso"));
        // Dueño sin caja abierta hoy: no hay dónde registrar el ajuste.
        assert!(corregir_pago(p, &dueno, CAJA_1, &pago_id, &tarjeta, "Era tarjeta al final", Some("246813")).await.unwrap_err().contains("abra la caja"));
        let t2 = abrir(p, &dueno, CAJA_1, &conteo(&[(1000, 10)])).await.unwrap();
        corregir_pago(p, &dueno, CAJA_1, &pago_id, &tarjeta, "Era tarjeta al final", Some("246813")).await.unwrap();
        // Anular la venta del turno cerrado devolviendo efectivo: ajuste + salida en el turno actual.
        assert!(anular(p, &cajero, CAJA_1, &v.venta_id, "246813", "Cliente devolvió", 0).await.unwrap_err().contains("permiso"));
        anular(p, &dueno, CAJA_1, &v.venta_id, "246813", "Cliente devolvió", 5000).await.unwrap();
        let d2 = detalle(p, &dueno, &t2.id).await.unwrap();
        assert_eq!(d2.resumen.ajustes.len(), 2);
        assert_eq!(d2.resumen.salidas, 5000);
        assert_eq!(d2.resumen.efectivo_esperado, 5000);
        // El turno cerrado quedó igual.
        let d1 = detalle(p, &dueno, &t1.id).await.unwrap();
        assert_eq!(d1.resumen.total_ventas, 5000);
        assert_eq!(d1.resumen.por_forma[0].nombre, "SINPE Móvil");
    }
}
