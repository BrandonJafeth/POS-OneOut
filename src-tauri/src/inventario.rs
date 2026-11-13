// Inventario: existencia por producto y sucursal, kardex solo-agregar, entradas de mercadería,
// ajustes, conteo físico, consultas y reportes.
//
// Regla: la existencia cambia SOLO con mover(), que agrega un movimiento al kardex dentro de la
// transacción de quien llama; los triggers de la migración 11 revisan que cuadre y copian la
// existencia resultante. Así existencia guardada = suma del kardex, siempre.
// Permisos: todo es del dueño (permiso "inventario"); los reportes además piden "reportes".
// El cajero mueve inventario solo vendiendo y, si la configuración lo deja, ve la existencia
// (nunca el costo). El técnico no tiene acceso.

use crate::bitacora;
use crate::config;
use crate::permisos::puede;
use crate::sesion::Actor;
use crate::usuarios;
use crate::util::{ahora_iso, e, texto, ulid, Res};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::{BTreeMap, HashMap};

/// Prefijo del error de cobro sin existencia: la pantalla pide el PIN del dueño y reintenta.
pub const SIN_EXISTENCIA: &str = "SIN_EXISTENCIA: ";
const MAX_CANTIDAD: i64 = 1_000_000;
const MAX_COSTO: i64 = 100_000_000;
const MAX_LINEAS: usize = 2000;

fn exigir(a: &Actor) -> Res<()> {
    a.exigir("inventario", "manejar el inventario")
}

fn exigir_reportes(a: &Actor) -> Res<()> {
    exigir(a)?;
    a.exigir("reportes", "ver reportes de inventario")
}

pub async fn sucursal_de(c: &mut SqliteConnection, caja_id: &str) -> Res<String> {
    sqlx::query_scalar("SELECT sucursal_id FROM cajas WHERE id = ?").bind(caja_id).fetch_optional(c).await.map_err(e)?.ok_or_else(|| format!("{}Caja no encontrada: {caja_id}", crate::util::TECNICO))
}

pub async fn existencia(c: &mut SqliteConnection, producto_id: &str, sucursal_id: &str) -> Res<i64> {
    let n: Option<i64> = sqlx::query_scalar("SELECT cantidad FROM existencias WHERE producto_id = ? AND sucursal_id = ?")
        .bind(producto_id)
        .bind(sucursal_id)
        .fetch_optional(c)
        .await
        .map_err(e)?;
    Ok(n.unwrap_or(0))
}

/// Un movimiento del kardex.
pub struct Mov<'a> {
    pub producto_id: &'a str,
    pub sucursal_id: &'a str,
    pub tipo: &'a str,
    pub cantidad: i64,
    pub costo: Option<i64>,
    pub motivo: &'a str,
    pub ref_tipo: Option<&'a str>,
    pub ref_id: Option<&'a str>,
    pub usuario_id: &'a str,
    pub turno_id: Option<&'a str>,
    pub fecha: &'a str,
}

/// Agrega el movimiento y devuelve la existencia resultante (el trigger la guarda).
pub async fn mover(c: &mut SqliteConnection, m: &Mov<'_>) -> Res<i64> {
    let nueva = existencia(c, m.producto_id, m.sucursal_id).await? + m.cantidad;
    sqlx::query(
        "INSERT INTO inventario_movimientos (id, producto_id, sucursal_id, tipo, cantidad, existencia, costo_unitario, motivo, referencia_tipo, referencia_id, usuario_id, turno_id, fecha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ulid())
    .bind(m.producto_id)
    .bind(m.sucursal_id)
    .bind(m.tipo)
    .bind(m.cantidad)
    .bind(nueva)
    .bind(m.costo)
    .bind(m.motivo)
    .bind(m.ref_tipo)
    .bind(m.ref_id)
    .bind(m.usuario_id)
    .bind(m.turno_id)
    .bind(m.fecha)
    .execute(&mut *c)
    .await
    .map_err(e)?;
    Ok(nueva)
}

/// Producto vigente: (nombre, controla_inventario).
async fn producto(c: &mut SqliteConnection, id: &str) -> Res<(String, bool)> {
    let f = sqlx::query("SELECT nombre, controla_inventario FROM productos WHERE id = ? AND eliminado_en IS NULL")
        .bind(id)
        .fetch_optional(c)
        .await
        .map_err(e)?
        .ok_or("Producto no encontrado")?;
    Ok((f.get("nombre"), f.get::<i64, _>("controla_inventario") == 1))
}

/// Una entrada, un ajuste o un conteo de un producto sin control lo pone bajo control.
async fn activar_control(c: &mut SqliteConnection, id: &str, fecha: &str) -> Res<()> {
    sqlx::query("UPDATE productos SET controla_inventario = 1, actualizado_en = ? WHERE id = ? AND controla_inventario = 0").bind(fecha).bind(id).execute(c).await.map_err(e)?;
    Ok(())
}

async fn guardar_costo(c: &mut SqliteConnection, id: &str, costo: i64, fecha: &str) -> Res<()> {
    sqlx::query("INSERT INTO producto_costos (producto_id, costo, actualizado_en) VALUES (?, ?, ?) ON CONFLICT (producto_id) DO UPDATE SET costo = excluded.costo, actualizado_en = excluded.actualizado_en")
        .bind(id)
        .bind(costo)
        .bind(fecha)
        .execute(c)
        .await
        .map_err(e)?;
    Ok(())
}

/// 1.000.000 (para mensajes).
fn miles(n: i64) -> String {
    crate::util::colones(n).replace('¢', "")
}

fn rango(n: i64, min: i64, max: i64, que: &str) -> Res<i64> {
    if (min..=max).contains(&n) {
        Ok(n)
    } else {
        Err(format!("{que}: debe ser un número entero de {} a {}", miles(min), miles(max)))
    }
}

// ─────────── Venta y anulación (dentro de la transacción del cobro) ───────────

/// Productos que controlan inventario en estas líneas, con la cantidad total (repetidos sumados).
pub async fn controladas(c: &mut SqliteConnection, lineas: &[(Option<String>, i64)]) -> Res<Vec<(String, String, i64)>> {
    let mut suma: BTreeMap<&str, i64> = BTreeMap::new();
    for (pid, n) in lineas {
        if let Some(p) = pid {
            *suma.entry(p.as_str()).or_default() += n;
        }
    }
    let mut out = vec![];
    for (pid, n) in suma {
        let (nombre, controla) = producto(c, pid).await?;
        if controla {
            out.push((pid.to_string(), nombre, n));
        }
    }
    Ok(out)
}

/// "Nombre (hay N)" de los que no alcanzan.
/// `con_cantidad`: decir cuántas hay (solo si quien vende puede ver existencias).
pub async fn faltantes(c: &mut SqliteConnection, sucursal_id: &str, items: &[(String, String, i64)], con_cantidad: bool) -> Res<Vec<String>> {
    let mut out = vec![];
    for (pid, nombre, n) in items {
        let hay = existencia(c, pid, sucursal_id).await?;
        if hay < *n {
            out.push(if con_cantidad { format!("{nombre} (hay {})", hay.max(0)) } else { nombre.clone() });
        }
    }
    Ok(out)
}

pub async fn descontar_venta(c: &mut SqliteConnection, venta_id: &str, sucursal_id: &str, usuario_id: &str, turno_id: &str, items: &[(String, String, i64)], fecha: &str) -> Res<()> {
    for (pid, _, n) in items {
        mover(c, &Mov { producto_id: pid, sucursal_id, tipo: "venta", cantidad: -n, costo: None, motivo: "", ref_tipo: Some("venta"), ref_id: Some(venta_id), usuario_id, turno_id: Some(turno_id), fecha }).await?;
    }
    Ok(())
}

/// Devuelve lo que la venta sacó (según su kardex, aunque el producto haya cambiado después).
pub async fn devolver_anulacion(c: &mut SqliteConnection, venta_id: &str, usuario_id: &str, turno_id: Option<&str>, fecha: &str) -> Res<()> {
    let filas: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT producto_id, sucursal_id, SUM(cantidad) FROM inventario_movimientos WHERE referencia_tipo = 'venta' AND referencia_id = ? GROUP BY producto_id, sucursal_id",
    )
    .bind(venta_id)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    for (pid, suc, n) in filas.into_iter().filter(|f| f.2 != 0) {
        mover(c, &Mov { producto_id: &pid, sucursal_id: &suc, tipo: "anulacion", cantidad: -n, costo: None, motivo: "Anulación", ref_tipo: Some("venta"), ref_id: Some(venta_id), usuario_id, turno_id, fecha }).await?;
    }
    Ok(())
}

// ─────────── Entradas de mercadería ───────────

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LineaEntrada {
    pub producto_id: String,
    pub cantidad: i64,
    pub costo_unitario: Option<i64>,
    /// Precio de venta nuevo (la pantalla ya pidió confirmación). None = no se cambia.
    #[serde(default)]
    pub precio_nuevo: Option<i64>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entrada {
    pub proveedor_id: Option<String>,
    #[serde(default)]
    pub factura: String,
    pub fecha: String,
    pub lineas: Vec<LineaEntrada>,
    /// Guardar el costo de cada línea como último costo del producto.
    #[serde(default)]
    pub actualizar_costo: bool,
}

fn fecha_valida(f: &str) -> Res<()> {
    let d = chrono::NaiveDate::parse_from_str(f, "%Y-%m-%d").map_err(|_| "La fecha de la factura no es válida".to_string())?;
    if d > chrono::Local::now().date_naive() {
        return Err("La fecha de la factura no puede ser de un día que todavía no llega".into());
    }
    Ok(())
}

pub async fn entrada(pool: &SqlitePool, a: &Actor, caja_id: &str, en: &Entrada) -> Res<String> {
    exigir(a)?;
    if en.lineas.is_empty() {
        return Err("Agregue al menos un producto".into());
    }
    if en.lineas.len() > MAX_LINEAS {
        return Err(format!("Máximo {MAX_LINEAS} líneas por entrada"));
    }
    let factura = texto(&en.factura, 40, "número de factura", false)?;
    fecha_valida(&en.fecha)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let suc = sucursal_de(&mut tx, caja_id).await?;
    let proveedor = en.proveedor_id.as_deref().filter(|s| !s.is_empty());
    if let Some(p) = proveedor {
        let ok: Option<i64> = sqlx::query_scalar("SELECT 1 FROM proveedores WHERE id = ? AND eliminado_en IS NULL").bind(p).fetch_optional(&mut *tx).await.map_err(e)?;
        ok.ok_or("El proveedor ya no existe")?;
    }
    // La misma factura digitada dos veces duplicaría la existencia.
    if !factura.is_empty() {
        let ya: Option<String> = sqlx::query_scalar("SELECT fecha FROM inventario_entradas WHERE sucursal_id = ? AND proveedor_id IS ? AND factura = ? COLLATE NOCASE LIMIT 1")
            .bind(&suc)
            .bind(proveedor)
            .bind(&factura)
            .fetch_optional(&mut *tx)
            .await
            .map_err(e)?;
        if let Some(f) = ya {
            return Err(format!("La factura {factura} de ese proveedor ya se registró (fecha {f}). Si es otra parte de la misma factura, agréguele algo al número, p. ej. «{factura}-2»."));
        }
    }
    let id = ulid();
    let fecha = ahora_iso();
    sqlx::query("INSERT INTO inventario_entradas (id, sucursal_id, proveedor_id, factura, fecha, usuario_id, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&suc)
        .bind(proveedor)
        .bind(&factura)
        .bind(&en.fecha)
        .bind(&a.id)
        .bind(&fecha)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    let mut unidades = 0;
    let mut precios = vec![];
    for (i, l) in en.lineas.iter().enumerate() {
        let n = rango(l.cantidad, 1, MAX_CANTIDAD, &format!("Línea {}: cantidad", i + 1))?;
        let costo = l.costo_unitario.map(|c| rango(c, 0, MAX_COSTO, &format!("Línea {}: costo", i + 1))).transpose()?;
        let (nombre, _) = producto(&mut tx, &l.producto_id).await.map_err(|err| format!("Línea {}: {err}", i + 1))?;
        activar_control(&mut tx, &l.producto_id, &fecha).await?;
        mover(&mut tx, &Mov { producto_id: &l.producto_id, sucursal_id: &suc, tipo: "entrada", cantidad: n, costo, motivo: "Entrada de mercadería", ref_tipo: Some("entrada"), ref_id: Some(&id), usuario_id: &a.id, turno_id: None, fecha: &fecha }).await?;
        if let (true, Some(c)) = (en.actualizar_costo, costo) {
            guardar_costo(&mut tx, &l.producto_id, c, &fecha).await?;
        }
        if let Some(p) = l.precio_nuevo {
            // Un 0 aquí casi siempre es un dedo: dejar un producto gratis se hace en Productos.
            let p = rango(p, 1, MAX_COSTO, &format!("Línea {}: el precio de venta nuevo", i + 1))?;
            let antes: i64 = sqlx::query_scalar("SELECT precio FROM productos WHERE id = ?").bind(&l.producto_id).fetch_one(&mut *tx).await.map_err(e)?;
            if antes != p {
                sqlx::query("UPDATE productos SET precio = ?, actualizado_en = ? WHERE id = ?").bind(p).bind(&fecha).bind(&l.producto_id).execute(&mut *tx).await.map_err(e)?;
                precios.push(json!({"productoId": l.producto_id, "nombre": nombre, "antes": antes, "despues": p}));
            }
        }
        unidades += n;
    }
    bitacora::registrar(
        &mut tx,
        Some(&a.id),
        "inventario.entrada",
        "inventario_entrada",
        Some(&id),
        &json!({"lineas": en.lineas.len(), "unidades": unidades, "proveedorId": proveedor, "factura": factura, "costoActualizado": en.actualizar_costo, "precios": precios}),
    )
    .await?;
    tx.commit().await.map_err(e)?;
    Ok(id)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LineaComprobante {
    pub producto_id: String,
    pub nombre: String,
    pub precio: i64,
    pub codigo_barras: Option<String>,
    pub cantidad: i64,
    pub costo_unitario: Option<i64>,
}

/// Encabezado y líneas de una entrada (comprobante y etiquetas).
pub async fn entrada_obtener(pool: &SqlitePool, a: &Actor, id: &str) -> Res<Value> {
    exigir(a)?;
    let h = sqlx::query("SELECT e.id, e.factura, e.fecha, e.creado_en, p.nombre AS proveedor, u.nombre AS usuario FROM inventario_entradas e LEFT JOIN proveedores p ON p.id = e.proveedor_id JOIN usuarios u ON u.id = e.usuario_id WHERE e.id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(e)?
        .ok_or("Entrada no encontrada")?;
    let lineas: Vec<LineaComprobante> = sqlx::query(
        "SELECT m.producto_id, p.nombre, p.precio, (SELECT c.codigo FROM codigos c WHERE c.producto_id = p.id AND c.tipo = 'barras' ORDER BY c.creado_en LIMIT 1) AS barras, m.cantidad, m.costo_unitario
         FROM inventario_movimientos m JOIN productos p ON p.id = m.producto_id WHERE m.referencia_tipo = 'entrada' AND m.referencia_id = ? ORDER BY m.rowid",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(e)?
    .iter()
    .map(|f| LineaComprobante { producto_id: f.get("producto_id"), nombre: f.get("nombre"), precio: f.get("precio"), codigo_barras: f.get("barras"), cantidad: f.get("cantidad"), costo_unitario: f.get("costo_unitario") })
    .collect();
    Ok(json!({
        "id": h.get::<String, _>("id"), "factura": h.get::<String, _>("factura"), "fecha": h.get::<String, _>("fecha"),
        "creadoEn": h.get::<String, _>("creado_en"), "proveedor": h.get::<Option<String>, _>("proveedor"), "usuario": h.get::<String, _>("usuario"),
        "lineas": lineas,
    }))
}

// ─────────── Ajustes ───────────

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Ajuste {
    pub producto_id: String,
    /// Cantidad nueva (conteo) o diferencia (+/−): una de las dos.
    pub nueva: Option<i64>,
    pub diferencia: Option<i64>,
    pub motivo: String,
    #[serde(default)]
    pub detalle: String,
}

async fn motivo_valido(c: &mut SqliteConnection, motivo: &str, detalle: &str) -> Res<String> {
    let lista: Vec<String> = config::valor_con(c, "inventario_motivos_ajuste").await.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let motivo = motivo.trim();
    if motivo.is_empty() {
        return Err("Elija el motivo del ajuste".into());
    }
    if !lista.iter().any(|m| m == motivo) {
        return Err("Ese motivo no está en la lista de motivos de ajuste".into());
    }
    let detalle = texto(detalle, 200, "detalle", false)?;
    if motivo == "Otro" && detalle.chars().count() < 3 {
        return Err("Con «Otro», escriba el motivo".into());
    }
    Ok(if detalle.is_empty() { motivo.to_string() } else { format!("{motivo}: {detalle}") })
}

pub async fn ajustar(pool: &SqlitePool, a: &Actor, caja_id: &str, aj: &Ajuste, pin: &str) -> Res<i64> {
    exigir(a)?;
    if aj.nueva.is_some() == aj.diferencia.is_some() {
        return Err("Indique la cantidad nueva o la diferencia".into());
    }
    {
        let mut c = pool.acquire().await.map_err(e)?;
        motivo_valido(&mut c, &aj.motivo, &aj.detalle).await?;
    }
    let dueno = usuarios::confirmar_dueno(pool, a, pin, "ajustar inventario").await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let motivo = motivo_valido(&mut tx, &aj.motivo, &aj.detalle).await?;
    let suc = sucursal_de(&mut tx, caja_id).await?;
    let (nombre, _) = producto(&mut tx, &aj.producto_id).await?;
    let actual = existencia(&mut tx, &aj.producto_id, &suc).await?;
    let cantidad = match (aj.nueva, aj.diferencia) {
        (Some(n), _) => rango(n, 0, MAX_CANTIDAD, "La cantidad que hay")? - actual,
        (_, Some(d)) => rango(d, -MAX_CANTIDAD, MAX_CANTIDAD, "La diferencia")?,
        // Ya revisado arriba; sin panic (en release un panic cierra la app).
        _ => return Err("Indique la cantidad nueva o la diferencia".into()),
    };
    if cantidad == 0 {
        return Err("La cantidad es igual a la del sistema: no hay nada que ajustar".into());
    }
    // Un ajuste dice lo que hay de verdad: nunca puede dejar la existencia en negativo.
    if actual + cantidad < 0 {
        return Err(format!("Con ese ajuste quedarían {} unidades. Hay {}: como mucho puede restar {}.", actual + cantidad, actual, actual.max(0)));
    }
    let fecha = ahora_iso();
    activar_control(&mut tx, &aj.producto_id, &fecha).await?;
    let nueva = mover(&mut tx, &Mov { producto_id: &aj.producto_id, sucursal_id: &suc, tipo: "ajuste", cantidad, costo: None, motivo: &motivo, ref_tipo: None, ref_id: None, usuario_id: &a.id, turno_id: None, fecha: &fecha }).await?;
    bitacora::registrar(&mut tx, Some(&a.id), "inventario.ajuste", "producto", Some(&aj.producto_id), &json!({"nombre": nombre, "antes": actual, "despues": nueva, "motivo": motivo, "autorizadoPor": dueno})).await?;
    tx.commit().await.map_err(e)?;
    Ok(nueva)
}

// ─────────── Conteo físico ───────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conteo {
    pub id: String,
    pub departamento_id: Option<String>,
    pub datos: HashMap<String, i64>,
    pub actualizado_en: String,
}

/// El conteo a medias, si hay uno.
pub async fn conteo_abierto(pool: &SqlitePool, a: &Actor) -> Res<Option<Conteo>> {
    exigir(a)?;
    let f = sqlx::query("SELECT id, departamento_id, datos, actualizado_en FROM inventario_conteos WHERE estado = 'abierto' ORDER BY creado_en DESC LIMIT 1").fetch_optional(pool).await.map_err(e)?;
    Ok(f.map(|f| Conteo {
        id: f.get("id"),
        departamento_id: f.get("departamento_id"),
        datos: serde_json::from_str(&f.get::<String, _>("datos")).unwrap_or_default(),
        actualizado_en: f.get("actualizado_en"),
    }))
}

/// Crea (sin id) o guarda el conteo a medias. Devuelve su id.
pub async fn conteo_guardar(pool: &SqlitePool, a: &Actor, caja_id: &str, id: Option<&str>, departamento_id: Option<&str>, datos: &HashMap<String, i64>) -> Res<String> {
    exigir(a)?;
    if datos.len() > 50_000 {
        return Err("Demasiados productos en un conteo".into());
    }
    for n in datos.values() {
        rango(*n, 0, MAX_CANTIDAD, "Cantidad contada")?;
    }
    let ahora = ahora_iso();
    let txt = serde_json::to_string(datos).map_err(e)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let id = match id {
        Some(id) => {
            let f = sqlx::query("SELECT datos, contado_en FROM inventario_conteos WHERE id = ? AND estado = 'abierto'").bind(id).fetch_optional(&mut *tx).await.map_err(e)?.ok_or("Ese conteo ya se aplicó o se descartó")?;
            let antes: HashMap<String, i64> = serde_json::from_str(&f.get::<String, _>("datos")).unwrap_or_default();
            let sellos_antes: HashMap<String, String> = serde_json::from_str(&f.get::<String, _>("contado_en")).unwrap_or_default();
            // La hora de un producto se conserva mientras su cantidad no cambie (el conteo se guarda solo cada rato).
            let sellos: HashMap<&String, &str> = datos.iter().map(|(pid, n)| (pid, sellos_antes.get(pid).filter(|_| antes.get(pid) == Some(n)).map_or(ahora.as_str(), String::as_str))).collect();
            sqlx::query("UPDATE inventario_conteos SET datos = ?, contado_en = ?, actualizado_en = ? WHERE id = ?")
                .bind(&txt)
                .bind(serde_json::to_string(&sellos).map_err(e)?)
                .bind(&ahora)
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(e)?;
            id.to_string()
        }
        None => {
            let otro: Option<String> = sqlx::query_scalar("SELECT id FROM inventario_conteos WHERE estado = 'abierto'").fetch_optional(&mut *tx).await.map_err(e)?;
            if otro.is_some() {
                return Err("Ya hay un conteo a medias: continúelo o descártelo".into());
            }
            let suc = sucursal_de(&mut tx, caja_id).await?;
            let id = ulid();
            let sellos: HashMap<&String, &str> = datos.keys().map(|pid| (pid, ahora.as_str())).collect();
            sqlx::query("INSERT INTO inventario_conteos (id, sucursal_id, departamento_id, datos, contado_en, usuario_id, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(&id)
                .bind(&suc)
                .bind(departamento_id.filter(|s| !s.is_empty()))
                .bind(&txt)
                .bind(serde_json::to_string(&sellos).map_err(e)?)
                .bind(&a.id)
                .bind(&ahora)
                .bind(&ahora)
                .execute(&mut *tx)
                .await
                .map_err(e)?;
            id
        }
    };
    tx.commit().await.map_err(e)?;
    Ok(id)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FilaConteo {
    pub producto_id: String,
    pub nombre: String,
    pub codigos: String,
    pub controla: bool,
    pub sistema: i64,
    pub contado: Option<i64>,
    /// contado − sistema (None si no se contó).
    pub diferencia: Option<i64>,
}

/// Lo que entró (+) o salió (−) de un producto después de `desde`: ventas, entradas, ajustes.
async fn movido_desde(c: &mut SqliteConnection, producto_id: &str, sucursal_id: &str, desde: Option<&String>) -> Res<i64> {
    let Some(desde) = desde else { return Ok(0) }; // conteo anterior a la migración 13: sin hora
    sqlx::query_scalar("SELECT COALESCE(SUM(cantidad), 0) FROM inventario_movimientos WHERE producto_id = ? AND sucursal_id = ? AND fecha > ?")
        .bind(producto_id)
        .bind(sucursal_id)
        .bind(desde)
        .fetch_one(c)
        .await
        .map_err(e)
}

/// Productos del conteo (su departamento, o todos) con lo contado contra el sistema.
/// "Sistema" es lo que había al contar cada producto: lo vendido después no cuenta como diferencia.
pub async fn conteo_diferencias(pool: &SqlitePool, a: &Actor, id: &str) -> Res<Vec<FilaConteo>> {
    exigir(a)?;
    let f = sqlx::query("SELECT sucursal_id, departamento_id, datos, contado_en FROM inventario_conteos WHERE id = ?").bind(id).fetch_optional(pool).await.map_err(e)?.ok_or("Conteo no encontrado")?;
    let suc: String = f.get("sucursal_id");
    let dep: Option<String> = f.get("departamento_id");
    let datos: HashMap<String, i64> = serde_json::from_str(&f.get::<String, _>("datos")).unwrap_or_default();
    let sellos: HashMap<String, String> = serde_json::from_str(&f.get::<String, _>("contado_en")).unwrap_or_default();
    let filas = sqlx::query(
        "SELECT p.id, p.nombre, p.controla_inventario, COALESCE(x.cantidad, 0) AS sistema,
                COALESCE((SELECT group_concat(c.codigo, ' ') FROM codigos c WHERE c.producto_id = p.id), '') AS codigos
         FROM productos p LEFT JOIN existencias x ON x.producto_id = p.id AND x.sucursal_id = ?
         WHERE p.eliminado_en IS NULL AND p.activo = 1 AND (? IS NULL OR p.departamento_id = ?)
         ORDER BY p.nombre_busqueda",
    )
    .bind(&suc)
    .bind(&dep)
    .bind(&dep)
    .fetch_all(pool)
    .await
    .map_err(e)?;
    let mut c = pool.acquire().await.map_err(e)?;
    let mut out = Vec::with_capacity(filas.len());
    for f in &filas {
        let pid: String = f.get("id");
        let contado = datos.get(&pid).copied();
        let despues = if contado.is_some() { movido_desde(&mut c, &pid, &suc, sellos.get(&pid)).await? } else { 0 };
        let sistema = f.get::<i64, _>("sistema") - despues;
        out.push(FilaConteo { nombre: f.get("nombre"), codigos: f.get("codigos"), controla: f.get::<i64, _>("controla_inventario") == 1, sistema, contado, diferencia: contado.map(|n| n - sistema), producto_id: pid });
    }
    Ok(out)
}

/// Aplica todo lo contado como ajustes con motivo "Conteo". Devuelve cuántos productos cambiaron.
pub async fn conteo_aplicar(pool: &SqlitePool, a: &Actor, id: &str, pin: &str) -> Res<i64> {
    exigir(a)?;
    let dueno = usuarios::confirmar_dueno(pool, a, pin, "aplicar conteo de inventario").await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let f = sqlx::query("SELECT sucursal_id, datos, contado_en FROM inventario_conteos WHERE id = ? AND estado = 'abierto'").bind(id).fetch_optional(&mut *tx).await.map_err(e)?.ok_or("Ese conteo ya se aplicó o se descartó")?;
    let suc: String = f.get("sucursal_id");
    let datos: BTreeMap<String, i64> = serde_json::from_str(&f.get::<String, _>("datos")).unwrap_or_default();
    let sellos: HashMap<String, String> = serde_json::from_str(&f.get::<String, _>("contado_en")).unwrap_or_default();
    let fecha = ahora_iso();
    let mut cambios = 0;
    for (pid, contado) in &datos {
        // Un producto borrado después de contarlo se salta.
        if producto(&mut tx, pid).await.is_err() {
            continue;
        }
        // Lo vendido o recibido después de contar este producto sigue valiendo: contado + eso es lo que debe haber ahora.
        let dif = contado + movido_desde(&mut tx, pid, &suc, sellos.get(pid)).await? - existencia(&mut tx, pid, &suc).await?;
        activar_control(&mut tx, pid, &fecha).await?;
        if dif != 0 {
            mover(&mut tx, &Mov { producto_id: pid, sucursal_id: &suc, tipo: "ajuste", cantidad: dif, costo: None, motivo: "Conteo", ref_tipo: Some("conteo"), ref_id: Some(id), usuario_id: &a.id, turno_id: None, fecha: &fecha }).await?;
            cambios += 1;
        }
    }
    sqlx::query("UPDATE inventario_conteos SET estado = 'aplicado', aplicado_en = ?, actualizado_en = ? WHERE id = ?").bind(&fecha).bind(&fecha).bind(id).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "inventario.conteo", "inventario_conteo", Some(id), &json!({"contados": datos.len(), "ajustados": cambios, "autorizadoPor": dueno})).await?;
    tx.commit().await.map_err(e)?;
    Ok(cambios)
}

pub async fn conteo_descartar(pool: &SqlitePool, a: &Actor, id: &str) -> Res<()> {
    exigir(a)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let n = sqlx::query("UPDATE inventario_conteos SET estado = 'descartado', actualizado_en = ? WHERE id = ? AND estado = 'abierto'").bind(ahora_iso()).bind(id).execute(&mut *tx).await.map_err(e)?.rows_affected();
    if n == 0 {
        return Err("Ese conteo ya se aplicó o se descartó".into());
    }
    bitacora::registrar(&mut tx, Some(&a.id), "inventario.conteo_descartado", "inventario_conteo", Some(id), &json!({})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

// ─────────── Inventario inicial desde CSV (todo o nada) ───────────

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilaInicial {
    pub fila: i64,
    /// Código (de barras o interno) o id del producto.
    pub clave: String,
    pub existencia: String,
    #[serde(default)]
    pub costo: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrevistaInicial {
    pub fila: i64,
    pub producto_id: Option<String>,
    pub nombre: String,
    pub actual: i64,
    pub nueva: Option<i64>,
    pub costo: Option<i64>,
    pub error: Option<String>,
}

/// Entero de una celda: "1250", "1.250" o "1,250" (miles, de una hoja de cálculo).
/// "2.5" o "1,25" no: serían decimales y se leerían como 25 o 125.
fn entero(s: &str) -> Option<i64> {
    let t = s.trim().replace(' ', "");
    let (signo, cuerpo) = t.strip_prefix('-').map_or(("", t.as_str()), |r| ("-", r));
    let grupos: Vec<&str> = cuerpo.split(['.', ',']).collect();
    let bien = !grupos[0].is_empty() && grupos[1..].iter().all(|g| g.len() == 3) && grupos.iter().all(|g| g.chars().all(|c| c.is_ascii_digit()));
    if !bien {
        return None;
    }
    format!("{signo}{}", grupos.concat()).parse().ok()
}

/// Revisa (aplicar = false) o aplica (aplicar = true, con PIN, solo si no hay ningún error).
pub async fn inicial(pool: &SqlitePool, a: &Actor, caja_id: &str, filas: &[FilaInicial], aplicar: bool, pin: Option<&str>) -> Res<Vec<PrevistaInicial>> {
    exigir(a)?;
    if filas.is_empty() {
        return Err("El archivo no tiene filas con datos".into());
    }
    if filas.len() > 50_000 {
        return Err("El archivo tiene más de 50.000 filas: divídalo en varios".into());
    }
    let dueno = if aplicar { Some(usuarios::confirmar_dueno(pool, a, pin.unwrap_or(""), "cargar inventario inicial").await?) } else { None };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let suc = sucursal_de(&mut tx, caja_id).await?;
    let mut vistos: HashMap<String, i64> = HashMap::new();
    let mut out = Vec::with_capacity(filas.len());
    for f in filas {
        let clave = f.clave.trim();
        let pid: Option<String> = sqlx::query_scalar(
            "SELECT p.id FROM productos p WHERE p.eliminado_en IS NULL AND (p.id = ?1 OR EXISTS (SELECT 1 FROM codigos c WHERE c.producto_id = p.id AND c.codigo = ?1 COLLATE NOCASE)) LIMIT 1",
        )
        .bind(clave)
        .fetch_optional(&mut *tx)
        .await
        .map_err(e)?;
        let mut p = PrevistaInicial { fila: f.fila, producto_id: pid.clone(), nombre: String::new(), actual: 0, nueva: entero(&f.existencia), costo: None, error: None };
        let costo_txt = f.costo.trim();
        p.costo = if costo_txt.is_empty() { None } else { entero(costo_txt) };
        p.error = match &pid {
            None => Some(format!("No hay ningún producto con el código «{clave}»")),
            Some(id) => {
                let (nombre, _) = producto(&mut tx, id).await?;
                p.nombre = nombre;
                p.actual = existencia(&mut tx, id, &suc).await?;
                if let Some(otra) = vistos.insert(id.clone(), f.fila) {
                    Some(format!("Producto repetido (también en la fila {otra})"))
                } else if !p.nueva.is_some_and(|n| (0..=MAX_CANTIDAD).contains(&n)) {
                    Some(format!("Existencia «{}»: debe ser un número entero, sin decimales, de 0 en adelante", f.existencia.trim()))
                } else if !costo_txt.is_empty() && !p.costo.is_some_and(|c| (0..=MAX_COSTO).contains(&c)) {
                    Some(format!("Costo «{costo_txt}»: debe ser en colones enteros, sin decimales"))
                } else {
                    None
                }
            }
        };
        out.push(p);
    }
    if !aplicar {
        return Ok(out);
    }
    if out.iter().any(|p| p.error.is_some()) {
        return Err("Hay filas con errores: corríjalas en el archivo. No se cargó nada.".into());
    }
    let fecha = ahora_iso();
    let lote = ulid();
    for p in &out {
        let (Some(id), Some(nueva)) = (&p.producto_id, p.nueva) else { continue };
        activar_control(&mut tx, id, &fecha).await?;
        if let Some(c) = p.costo {
            guardar_costo(&mut tx, id, c, &fecha).await?;
        }
        if nueva != p.actual {
            mover(&mut tx, &Mov { producto_id: id, sucursal_id: &suc, tipo: "inicial", cantidad: nueva - p.actual, costo: p.costo, motivo: "Inventario inicial", ref_tipo: Some("importacion"), ref_id: Some(&lote), usuario_id: &a.id, turno_id: None, fecha: &fecha }).await?;
        }
    }
    bitacora::registrar(&mut tx, Some(&a.id), "inventario.inicial", "inventario", Some(&lote), &json!({"filas": out.len(), "autorizadoPor": dueno})).await?;
    tx.commit().await.map_err(e)?;
    Ok(out)
}

// ─────────── Consultas ───────────

/// Estado de un producto según su existencia (mismo orden de gravedad que la pantalla).
const ESTADO_SQL: &str = "CASE WHEN p.controla_inventario = 0 THEN 'sin_control'
     WHEN COALESCE(x.cantidad, 0) < 0 THEN 'negativo'
     WHEN COALESCE(x.cantidad, 0) = 0 THEN 'agotado'
     WHEN p.stock_minimo > 0 AND COALESCE(x.cantidad, 0) <= p.stock_minimo THEN 'bajo_minimo'
     ELSE 'con_existencia' END";

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FilaInventario {
    pub producto_id: String,
    pub nombre: String,
    pub departamento: String,
    pub codigos: String,
    pub controla: bool,
    pub existencia: i64,
    pub minimo: i64,
    pub costo: Option<i64>,
    pub estado: String,
}

const SELECT_INV: &str = "SELECT p.id, p.nombre, d.nombre AS departamento, p.controla_inventario, COALESCE(x.cantidad, 0) AS existencia, p.stock_minimo, k.costo,
       COALESCE((SELECT group_concat(c.codigo, ' ') FROM codigos c WHERE c.producto_id = p.id), '') AS codigos";

fn a_fila(f: &sqlx::sqlite::SqliteRow) -> FilaInventario {
    FilaInventario {
        producto_id: f.get("id"),
        nombre: f.get("nombre"),
        departamento: f.get("departamento"),
        codigos: f.get("codigos"),
        controla: f.get::<i64, _>("controla_inventario") == 1,
        existencia: f.get("existencia"),
        minimo: f.get("stock_minimo"),
        costo: f.get("costo"),
        estado: f.get("estado"),
    }
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Filtro {
    #[serde(default)]
    pub texto: String,
    pub departamento_id: Option<String>,
    /// "", "con_control", "bajo_minimo", "agotados", "negativos", "sin_barras", "sin_costo", "sin_control"
    #[serde(default)]
    pub filtro: String,
    pub limite: Option<i64>,
    pub desplazamiento: Option<i64>,
}

/// Lista de existencias con filtros (dueño). Devuelve (filas, total).
pub async fn lista(pool: &SqlitePool, a: &Actor, caja_id: &str, f: &Filtro) -> Res<(Vec<FilaInventario>, i64)> {
    exigir(a)?;
    let mut c = pool.acquire().await.map_err(e)?;
    let suc = sucursal_de(&mut c, caja_id).await?;
    let mut w = vec!["p.eliminado_en IS NULL".to_string(), "p.activo = 1".to_string()];
    let mut params: Vec<String> = vec![suc];
    if let Some(d) = f.departamento_id.as_deref().filter(|s| !s.is_empty()) {
        w.push("p.departamento_id = ?".into());
        params.push(d.into());
    }
    let palabras: Vec<String> = crate::util::normalizar(&f.texto).split(' ').filter(|s| !s.is_empty()).map(|s| s.replace(['%', '_'], "")).collect();
    if !palabras.is_empty() {
        let por_nombre = palabras.iter().map(|_| "p.nombre_busqueda LIKE ?").collect::<Vec<_>>().join(" AND ");
        w.push(format!("(({por_nombre}) OR EXISTS (SELECT 1 FROM codigos c WHERE c.producto_id = p.id AND c.codigo = ? COLLATE NOCASE))"));
        params.extend(palabras.iter().map(|p| format!("%{p}%")));
        params.push(f.texto.trim().to_string());
    }
    let cond = match f.filtro.as_str() {
        "" => None,
        "bajo_minimo" => Some("p.controla_inventario = 1 AND p.stock_minimo > 0 AND COALESCE(x.cantidad, 0) <= p.stock_minimo"),
        "agotados" => Some("p.controla_inventario = 1 AND COALESCE(x.cantidad, 0) = 0"),
        "negativos" => Some("p.controla_inventario = 1 AND COALESCE(x.cantidad, 0) < 0"),
        "sin_barras" => Some("NOT EXISTS (SELECT 1 FROM codigos c WHERE c.producto_id = p.id AND c.tipo = 'barras')"),
        "sin_costo" => Some("k.costo IS NULL"),
        "sin_control" => Some("p.controla_inventario = 0"),
        "con_control" => Some("p.controla_inventario = 1"),
        _ => return Err(format!("{}Filtro desconocido: {}", crate::util::TECNICO, f.filtro)),
    };
    if let Some(x) = cond {
        w.push(x.into());
    }
    let desde = "FROM productos p JOIN departamentos d ON d.id = p.departamento_id LEFT JOIN existencias x ON x.producto_id = p.id AND x.sucursal_id = ? LEFT JOIN producto_costos k ON k.producto_id = p.id";
    let w = w.join(" AND ");
    let sql_total = format!("SELECT COUNT(*) {desde} WHERE {w}");
    let mut q = sqlx::query_scalar::<_, i64>(&sql_total);
    for p in &params {
        q = q.bind(p);
    }
    let total = q.fetch_one(&mut *c).await.map_err(e)?;
    let sql = format!("{SELECT_INV}, {ESTADO_SQL} AS estado {desde} WHERE {w} ORDER BY p.nombre_busqueda LIMIT ? OFFSET ?");
    let mut q = sqlx::query(&sql);
    for p in &params {
        q = q.bind(p);
    }
    let filas = q.bind(f.limite.unwrap_or(100).clamp(1, 1000)).bind(f.desplazamiento.unwrap_or(0).max(0)).fetch_all(&mut *c).await.map_err(e)?;
    Ok((filas.iter().map(a_fila).collect(), total))
}

/// Estado de inventario de unos productos (columna de la lista de Productos, dueño).
pub async fn estado_de(pool: &SqlitePool, a: &Actor, caja_id: &str, ids: &[String]) -> Res<Vec<FilaInventario>> {
    exigir(a)?;
    if ids.len() > 1000 {
        return Err(format!("{}Demasiados productos: {}", crate::util::TECNICO, ids.len()));
    }
    let mut c = pool.acquire().await.map_err(e)?;
    let suc = sucursal_de(&mut c, caja_id).await?;
    let marcas = vec!["?"; ids.len()].join(",");
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let sql = format!(
        "{SELECT_INV}, {ESTADO_SQL} AS estado FROM productos p JOIN departamentos d ON d.id = p.departamento_id LEFT JOIN existencias x ON x.producto_id = p.id AND x.sucursal_id = ? LEFT JOIN producto_costos k ON k.producto_id = p.id WHERE p.id IN ({marcas})"
    );
    let mut q = sqlx::query(&sql).bind(&suc);
    for id in ids {
        q = q.bind(id);
    }
    Ok(q.fetch_all(&mut *c).await.map_err(e)?.iter().map(a_fila).collect())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExistenciaVenta {
    pub producto_id: String,
    pub existencia: i64,
}

/// Lo único que el cajero puede ver del inventario: cuántas unidades hay (sin costo), y solo si la
/// configuración lo permite (venta_mostrar_existencia). Productos sin control no aparecen.
pub async fn existencia_venta(pool: &SqlitePool, a: &Actor, caja_id: &str, ids: &[String]) -> Res<Vec<ExistenciaVenta>> {
    let dueno = puede(a.rol, "inventario");
    if !dueno && !(puede(a.rol, "venta") && config::booleano(pool, "venta_mostrar_existencia", false).await) {
        return Err(crate::permisos::sin_permiso("ver existencias"));
    }
    if ids.is_empty() {
        return Ok(vec![]);
    }
    if ids.len() > 500 {
        return Err(format!("{}Demasiados productos: {}", crate::util::TECNICO, ids.len()));
    }
    let mut c = pool.acquire().await.map_err(e)?;
    let suc = sucursal_de(&mut c, caja_id).await?;
    let marcas = vec!["?"; ids.len()].join(",");
    let sql = format!("SELECT p.id, COALESCE(x.cantidad, 0) FROM productos p LEFT JOIN existencias x ON x.producto_id = p.id AND x.sucursal_id = ? WHERE p.controla_inventario = 1 AND p.id IN ({marcas})");
    let mut q = sqlx::query_as::<_, (String, i64)>(&sql).bind(&suc);
    for id in ids {
        q = q.bind(id);
    }
    Ok(q.fetch_all(&mut *c).await.map_err(e)?.into_iter().map(|(producto_id, existencia)| ExistenciaVenta { producto_id, existencia }).collect())
}

/// Aviso discreto al dueño: cuántos productos están en o bajo su mínimo (o negativos).
pub async fn alertas(pool: &SqlitePool, a: &Actor, caja_id: &str) -> Res<i64> {
    exigir(a)?;
    let mut c = pool.acquire().await.map_err(e)?;
    let suc = sucursal_de(&mut c, caja_id).await?;
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM productos p LEFT JOIN existencias x ON x.producto_id = p.id AND x.sucursal_id = ?
         WHERE p.eliminado_en IS NULL AND p.activo = 1 AND p.controla_inventario = 1
           AND (COALESCE(x.cantidad, 0) < 0 OR (p.stock_minimo > 0 AND COALESCE(x.cantidad, 0) <= p.stock_minimo))",
    )
    .bind(&suc)
    .fetch_one(&mut *c)
    .await
    .map_err(e)
}

/// Control, mínimo y último costo de un producto (ficha del producto, dueño).
pub async fn producto_guardar(pool: &SqlitePool, a: &Actor, producto_id: &str, controla: bool, minimo: i64, costo: Option<i64>) -> Res<()> {
    exigir(a)?;
    rango(minimo, 0, MAX_CANTIDAD, "Mínimo")?;
    if let Some(c) = costo {
        rango(c, 0, MAX_COSTO, "Costo")?;
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let (nombre, antes_controla) = producto(&mut tx, producto_id).await?;
    let fecha = ahora_iso();
    sqlx::query("UPDATE productos SET controla_inventario = ?, stock_minimo = ?, actualizado_en = ? WHERE id = ?").bind(controla as i64).bind(minimo).bind(&fecha).bind(producto_id).execute(&mut *tx).await.map_err(e)?;
    let antes_costo: Option<i64> = sqlx::query_scalar("SELECT costo FROM producto_costos WHERE producto_id = ?").bind(producto_id).fetch_optional(&mut *tx).await.map_err(e)?;
    match costo {
        Some(c) => guardar_costo(&mut tx, producto_id, c, &fecha).await?,
        None => {
            sqlx::query("DELETE FROM producto_costos WHERE producto_id = ?").bind(producto_id).execute(&mut *tx).await.map_err(e)?;
        }
    }
    bitacora::registrar(&mut tx, Some(&a.id), "inventario.producto", "producto", Some(producto_id), &json!({"nombre": nombre, "controla": [antes_controla, controla], "minimo": minimo, "costo": [antes_costo, costo]})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FilaKardex {
    pub fecha: String,
    pub tipo: String,
    pub cantidad: i64,
    pub existencia: i64,
    pub costo_unitario: Option<i64>,
    pub motivo: String,
    pub referencia: Option<String>,
    pub usuario: String,
    pub producto: String,
}

const SELECT_KARDEX: &str = "SELECT m.fecha, m.tipo, m.cantidad, m.existencia, m.costo_unitario, m.motivo, u.nombre AS usuario, p.nombre AS producto,
       CASE m.referencia_tipo WHEN 'venta' THEN 'Tiquete ' || (SELECT v.numero FROM ventas v WHERE v.id = m.referencia_id)
         WHEN 'entrada' THEN 'Entrada ' || COALESCE(NULLIF((SELECT e.factura FROM inventario_entradas e WHERE e.id = m.referencia_id), ''), 'sin factura')
         WHEN 'conteo' THEN 'Conteo físico' WHEN 'importacion' THEN 'Archivo CSV' END AS referencia
  FROM inventario_movimientos m JOIN usuarios u ON u.id = m.usuario_id JOIN productos p ON p.id = m.producto_id";

fn a_kardex(f: &sqlx::sqlite::SqliteRow) -> FilaKardex {
    FilaKardex {
        fecha: f.get("fecha"),
        tipo: f.get("tipo"),
        cantidad: f.get("cantidad"),
        existencia: f.get("existencia"),
        costo_unitario: f.get("costo_unitario"),
        motivo: f.get("motivo"),
        referencia: f.get("referencia"),
        usuario: f.get("usuario"),
        producto: f.get("producto"),
    }
}

/// Kardex de un producto entre dos fechas ISO (desde incluida, hasta excluida).
pub async fn kardex(pool: &SqlitePool, a: &Actor, producto_id: &str, desde: &str, hasta: &str) -> Res<Vec<FilaKardex>> {
    exigir(a)?;
    let filas = sqlx::query(&format!("{SELECT_KARDEX} WHERE m.producto_id = ? AND m.fecha >= ? AND m.fecha < ? ORDER BY m.rowid DESC LIMIT 5000"))
        .bind(producto_id)
        .bind(desde)
        .bind(hasta)
        .fetch_all(pool)
        .await
        .map_err(e)?;
    Ok(filas.iter().map(a_kardex).collect())
}

// ─────────── Reportes (dueño con permiso de reportes) ───────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FilaBajoMinimo {
    pub producto_id: String,
    pub nombre: String,
    pub departamento: String,
    pub existencia: i64,
    pub minimo: i64,
    /// mínimo × 2 − existencia (la pantalla la deja ajustar antes de exportar).
    pub sugerido: i64,
}

pub async fn reporte_bajo_minimo(pool: &SqlitePool, a: &Actor, caja_id: &str) -> Res<Vec<FilaBajoMinimo>> {
    exigir_reportes(a)?;
    let mut c = pool.acquire().await.map_err(e)?;
    let suc = sucursal_de(&mut c, caja_id).await?;
    let filas: Vec<(String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT p.id, p.nombre, d.nombre, COALESCE(x.cantidad, 0), p.stock_minimo
         FROM productos p JOIN departamentos d ON d.id = p.departamento_id LEFT JOIN existencias x ON x.producto_id = p.id AND x.sucursal_id = ?
         WHERE p.eliminado_en IS NULL AND p.activo = 1 AND p.controla_inventario = 1 AND p.stock_minimo > 0 AND COALESCE(x.cantidad, 0) <= p.stock_minimo
         ORDER BY d.orden, p.nombre_busqueda",
    )
    .bind(&suc)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    Ok(filas
        .into_iter()
        .map(|(producto_id, nombre, departamento, existencia, minimo)| FilaBajoMinimo { producto_id, nombre, departamento, existencia, minimo, sugerido: (minimo * 2 - existencia).max(0) })
        .collect())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Valorizado {
    pub por_departamento: Vec<Value>,
    pub total: i64,
    /// Productos con existencia y sin costo (no entran en el total).
    pub sin_costo: Vec<Value>,
}

/// Existencia × último costo, por departamento. Lo negativo cuenta como 0.
pub async fn reporte_valorizado(pool: &SqlitePool, a: &Actor, caja_id: &str) -> Res<Valorizado> {
    exigir_reportes(a)?;
    let mut c = pool.acquire().await.map_err(e)?;
    let suc = sucursal_de(&mut c, caja_id).await?;
    let base = "FROM productos p JOIN departamentos d ON d.id = p.departamento_id JOIN existencias x ON x.producto_id = p.id AND x.sucursal_id = ?1 LEFT JOIN producto_costos k ON k.producto_id = p.id
                WHERE p.eliminado_en IS NULL AND p.controla_inventario = 1 AND x.cantidad > 0";
    let deps: Vec<(String, i64, i64)> = sqlx::query_as(&format!("SELECT d.nombre, SUM(x.cantidad), SUM(x.cantidad * k.costo) {base} AND k.costo IS NOT NULL GROUP BY d.id ORDER BY d.orden"))
        .bind(&suc)
        .fetch_all(&mut *c)
        .await
        .map_err(e)?;
    let sin: Vec<(String, String, i64)> = sqlx::query_as(&format!("SELECT p.nombre, d.nombre, x.cantidad {base} AND k.costo IS NULL ORDER BY d.orden, p.nombre_busqueda"))
        .bind(&suc)
        .fetch_all(&mut *c)
        .await
        .map_err(e)?;
    Ok(Valorizado {
        total: deps.iter().map(|d| d.2).sum(),
        por_departamento: deps.into_iter().map(|(d, u, v)| json!({"departamento": d, "unidades": u, "valor": v})).collect(),
        sin_costo: sin.into_iter().map(|(n, d, x)| json!({"nombre": n, "departamento": d, "existencia": x})).collect(),
    })
}

/// Movimientos entre dos fechas ISO, de un tipo o de todos.
pub async fn reporte_movimientos(pool: &SqlitePool, a: &Actor, desde: &str, hasta: &str, tipo: Option<&str>) -> Res<Vec<FilaKardex>> {
    exigir_reportes(a)?;
    let filas = sqlx::query(&format!("{SELECT_KARDEX} WHERE m.fecha >= ? AND m.fecha < ? AND (? IS NULL OR m.tipo = ?) ORDER BY m.rowid LIMIT 20000"))
        .bind(desde)
        .bind(hasta)
        .bind(tipo)
        .bind(tipo)
        .fetch_all(pool)
        .await
        .map_err(e)?;
    Ok(filas.iter().map(a_kardex).collect())
}

// ─────────── Proveedores ───────────

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Proveedor {
    #[serde(default)]
    pub id: String,
    pub nombre: String,
    #[serde(default)]
    pub telefono: String,
    #[serde(default)]
    pub notas: String,
}

pub async fn proveedores(pool: &SqlitePool, a: &Actor) -> Res<Vec<Proveedor>> {
    exigir(a)?;
    let f: Vec<(String, String, String, String)> = sqlx::query_as("SELECT id, nombre, telefono, notas FROM proveedores WHERE eliminado_en IS NULL ORDER BY nombre").fetch_all(pool).await.map_err(e)?;
    Ok(f.into_iter().map(|(id, nombre, telefono, notas)| Proveedor { id, nombre, telefono, notas }).collect())
}

pub async fn proveedor_guardar(pool: &SqlitePool, a: &Actor, p: &Proveedor) -> Res<String> {
    exigir(a)?;
    let nombre = texto(&p.nombre, 100, "el nombre", true)?;
    let telefono = texto(&p.telefono, 30, "teléfono", false)?;
    let notas = texto(&p.notas, 300, "notas", false)?;
    let ahora = ahora_iso();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    crate::util::nombre_libre(&mut tx, "proveedores", &nombre, &p.id, "el proveedor").await?;
    let id = if p.id.is_empty() {
        let id = ulid();
        sqlx::query("INSERT INTO proveedores (id, nombre, telefono, notas, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?)").bind(&id).bind(&nombre).bind(&telefono).bind(&notas).bind(&ahora).bind(&ahora).execute(&mut *tx).await.map_err(e)?;
        id
    } else {
        let n = sqlx::query("UPDATE proveedores SET nombre = ?, telefono = ?, notas = ?, actualizado_en = ? WHERE id = ? AND eliminado_en IS NULL").bind(&nombre).bind(&telefono).bind(&notas).bind(&ahora).bind(&p.id).execute(&mut *tx).await.map_err(e)?.rows_affected();
        if n == 0 {
            return Err("Proveedor no encontrado".into());
        }
        p.id.clone()
    };
    // Sin teléfono ni notas en la bitácora: si el proveedor es una persona, son datos personales.
    bitacora::registrar(&mut tx, Some(&a.id), "proveedor.guardar", "proveedor", Some(&id), &json!({})).await?;
    tx.commit().await.map_err(e)?;
    Ok(id)
}

pub async fn proveedor_eliminar(pool: &SqlitePool, a: &Actor, id: &str) -> Res<()> {
    exigir(a)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    // Ley 8968: si es una persona, sus datos de contacto no se guardan más de lo necesario. El nombre
    // queda porque las entradas ya registradas (compras) lo necesitan como respaldo contable.
    let n = sqlx::query("UPDATE proveedores SET telefono = '', notas = '', eliminado_en = ?, actualizado_en = ? WHERE id = ? AND eliminado_en IS NULL")
        .bind(ahora_iso())
        .bind(ahora_iso())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(e)?
        .rows_affected();
    if n == 0 {
        return Err("Ese proveedor ya no existe".into());
    }
    bitacora::registrar(&mut tx, Some(&a.id), "proveedor.eliminar", "proveedor", Some(id), &json!({})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caja::{abrir, tests::conteo, CAJA_1};
    use crate::calculo::{Estado, Linea, PagoEntrada};
    use crate::permisos::Rol;
    use crate::usuarios::tests::base_con_usuarios;
    use crate::ventas::{anular, cobrar, cobrar_con, crear_espera};

    const DEP: &str = "00000000000000000000000D01";
    const SUC: &str = "0000000000000000000000S001";
    const EF: &str = "0000000000000000000000FP01";
    const PIN_DUENO: &str = "246813";

    async fn prod(p: &SqlitePool, nombre: &str, controla: bool) -> String {
        let id = ulid();
        sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, ?, ?, ?, 1000)")
            .bind(&id)
            .bind(nombre)
            .bind(nombre.to_lowercase())
            .bind(DEP)
            .execute(p)
            .await
            .unwrap();
        // Nuevo = sin control (migración 12); aquí se fija a mano lo que pide cada prueba.
        sqlx::query("UPDATE productos SET controla_inventario = ? WHERE id = ?").bind(controla as i64).bind(&id).execute(p).await.unwrap();
        id
    }

    fn linea(pid: Option<&str>, cantidad: i64) -> Linea {
        Linea { id: ulid(), producto_id: pid.map(Into::into), codigo: None, descripcion: "x".into(), departamento_id: DEP.into(), cantidad, precio_unitario: 1000, descuento: 0, descuento_catalogo: 0, tasa_iva: 13.0, exento: false }
    }

    fn est(lineas: Vec<Linea>) -> Estado {
        Estado { lineas, ..Default::default() }
    }

    fn efectivo(e: &Estado) -> Vec<PagoEntrada> {
        vec![PagoEntrada { forma_pago_id: EF.into(), monto: e.lineas.iter().map(|l| l.cantidad * 1000).sum(), banco_id: None, referencia: None, ultimos4: None, pagador: None }]
    }

    async fn hay(p: &SqlitePool, pid: &str) -> i64 {
        existencia(&mut p.acquire().await.unwrap(), pid, SUC).await.unwrap()
    }

    /// La existencia guardada de cada producto es la suma de su kardex (y la última existencia anotada).
    async fn cuadra(p: &SqlitePool) {
        let malos: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM existencias x WHERE x.cantidad <> (SELECT COALESCE(SUM(m.cantidad), 0) FROM inventario_movimientos m WHERE m.producto_id = x.producto_id AND m.sucursal_id = x.sucursal_id)
               OR x.cantidad <> (SELECT m.existencia FROM inventario_movimientos m WHERE m.producto_id = x.producto_id AND m.sucursal_id = x.sucursal_id ORDER BY m.rowid DESC LIMIT 1)",
        )
        .fetch_one(p)
        .await
        .unwrap();
        assert_eq!(malos, 0, "existencia y kardex no cuadran");
    }

    #[tokio::test]
    async fn venta_baja_anulacion_devuelve_espera_servicio_y_precio_libre_no() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let lapiz = prod(p, "Lápiz", true).await;
        let copia = prod(p, "Fotocopia", false).await;
        abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        // Con existencia permitida en negativo (por defecto): queda en −3 y se ve como negativo.
        let e = est(vec![linea(Some(&lapiz), 2), linea(Some(&copia), 10), linea(None, 1), linea(Some(&lapiz), 1)]);
        let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
        // La venta en espera no mueve nada.
        assert_eq!(hay(p, &lapiz).await, 0);
        let v = cobrar(p, &cajero, CAJA_1, &esp.id, &e, &efectivo(&e)).await.unwrap();
        assert_eq!(hay(p, &lapiz).await, -3);
        assert_eq!(hay(p, &copia).await, 0);
        let movs: Vec<(String, i64, String)> = sqlx::query_as("SELECT producto_id, cantidad, tipo FROM inventario_movimientos").fetch_all(p).await.unwrap();
        assert_eq!(movs, vec![(lapiz.clone(), -3, "venta".into())]);
        let (filas, _) = lista(p, &dueno, CAJA_1, &Filtro { filtro: "negativos".into(), ..Default::default() }).await.unwrap();
        assert_eq!(filas.iter().map(|f| (f.producto_id.as_str(), f.estado.as_str())).collect::<Vec<_>>(), vec![(lapiz.as_str(), "negativo")]);
        // Anular devuelve, ligado a la venta original.
        anular(p, &dueno, CAJA_1, &v.venta_id, PIN_DUENO, "Cliente se arrepintió", 0).await.unwrap();
        assert_eq!(hay(p, &lapiz).await, 0);
        let (tipo, refe): (String, String) = sqlx::query_as("SELECT tipo, referencia_id FROM inventario_movimientos ORDER BY rowid DESC LIMIT 1").fetch_one(p).await.unwrap();
        assert_eq!((tipo.as_str(), refe.as_str()), ("anulacion", v.venta_id.as_str()));
        cuadra(p).await;
    }

    #[tokio::test]
    async fn sin_existencia_bloquea_salvo_pin_del_dueno() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        config::guardar(p, &dueno, "permitir_vender_sin_existencia", &json!(false)).await.unwrap();
        let lapiz = prod(p, "Lápiz", true).await;
        abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        let mut c = p.acquire().await.unwrap();
        mover(&mut c, &Mov { producto_id: &lapiz, sucursal_id: SUC, tipo: "entrada", cantidad: 1, costo: None, motivo: "", ref_tipo: None, ref_id: None, usuario_id: &dueno.id, turno_id: None, fecha: &ahora_iso() }).await.unwrap();
        drop(c);
        let e = est(vec![linea(Some(&lapiz), 2)]);
        let esp = crear_espera(p, &cajero, CAJA_1, &e).await.unwrap();
        let err = cobrar(p, &cajero, CAJA_1, &esp.id, &e, &efectivo(&e)).await.unwrap_err();
        // Sin la opción de ver existencias, el cajero no se entera de cuántas hay.
        assert!(err.starts_with(SIN_EXISTENCIA) && err.contains("Lápiz") && !err.contains("hay 1"), "{err}");
        config::guardar(p, &dueno, "venta_mostrar_existencia", &json!(true)).await.unwrap();
        let err = cobrar(p, &cajero, CAJA_1, &esp.id, &e, &efectivo(&e)).await.unwrap_err();
        assert!(err.contains("Lápiz (hay 1)"), "{err}");
        // El aviso previo al cobro dice lo mismo; lo que alcanza no avisa.
        assert_eq!(crate::ventas::faltantes(p, &cajero, CAJA_1, &[(Some(lapiz.clone()), 2)]).await.unwrap(), vec!["Lápiz (hay 1)"]);
        assert!(crate::ventas::faltantes(p, &cajero, CAJA_1, &[(Some(lapiz.clone()), 1)]).await.unwrap().is_empty());
        assert!(cobrar_con(p, &cajero, CAJA_1, &esp.id, &e, &efectivo(&e), Some("000000")).await.is_err());
        assert_eq!(hay(p, &lapiz).await, 1);
        // Lo que sí alcanza se vende sin PIN.
        let uno = est(vec![linea(Some(&lapiz), 1)]);
        let esp1 = crear_espera(p, &cajero, CAJA_1, &uno).await.unwrap();
        cobrar(p, &cajero, CAJA_1, &esp1.id, &uno, &efectivo(&uno)).await.unwrap();
        // El dueño tampoco vende sin existencia "porque sí": también pide PIN (el suyo) y queda anotado.
        let esp_d = crear_espera(p, &dueno, CAJA_1, &e).await.unwrap();
        assert!(cobrar(p, &dueno, CAJA_1, &esp_d.id, &e, &efectivo(&e)).await.unwrap_err().starts_with(SIN_EXISTENCIA));
        cobrar_con(p, &cajero, CAJA_1, &esp.id, &e, &efectivo(&e), Some(PIN_DUENO)).await.unwrap();
        assert_eq!(hay(p, &lapiz).await, -2);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'venta.sin_existencia'").fetch_one(p).await.unwrap();
        assert_eq!(n, 1);
        cuadra(p).await;
    }

    #[tokio::test]
    async fn entrada_suma_costo_opcional_precio_y_kardex() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let lapiz = prod(p, "Lápiz", true).await;
        let regla = prod(p, "Regla", false).await;
        let prov = proveedor_guardar(p, &dueno, &Proveedor { id: String::new(), nombre: "Distribuidora X".into(), telefono: "2222-2222".into(), notas: String::new() }).await.unwrap();
        let en = |actualizar_costo: bool, precio: Option<i64>| Entrada {
            proveedor_id: Some(prov.clone()),
            factura: "F-100".into(),
            fecha: "2026-11-08".into(),
            lineas: vec![
                LineaEntrada { producto_id: lapiz.clone(), cantidad: 10, costo_unitario: Some(400), precio_nuevo: precio },
                LineaEntrada { producto_id: regla.clone(), cantidad: 3, costo_unitario: None, precio_nuevo: None },
            ],
            actualizar_costo,
        };
        assert!(entrada(p, &cajero, CAJA_1, &en(false, None)).await.unwrap_err().contains("permiso"));
        let id = entrada(p, &dueno, CAJA_1, &en(false, None)).await.unwrap();
        assert_eq!((hay(p, &lapiz).await, hay(p, &regla).await), (10, 3));
        let costo: Option<i64> = sqlx::query_scalar("SELECT costo FROM producto_costos WHERE producto_id = ?").bind(&lapiz).fetch_optional(p).await.unwrap();
        assert_eq!(costo, None);
        // Recibir mercadería de un producto sin control lo pone bajo control.
        let c: i64 = sqlx::query_scalar("SELECT controla_inventario FROM productos WHERE id = ?").bind(&regla).fetch_one(p).await.unwrap();
        assert_eq!(c, 1);
        // La misma factura del mismo proveedor no entra dos veces (duplicaría la existencia).
        assert!(entrada(p, &dueno, CAJA_1, &en(true, Some(1200))).await.unwrap_err().contains("ya se registró"));
        entrada(p, &dueno, CAJA_1, &Entrada { factura: "F-101".into(), ..en(true, Some(1200)) }).await.unwrap();
        let (costo, precio): (i64, i64) = sqlx::query_as("SELECT k.costo, p.precio FROM productos p JOIN producto_costos k ON k.producto_id = p.id WHERE p.id = ?").bind(&lapiz).fetch_one(p).await.unwrap();
        assert_eq!((costo, precio, hay(p, &lapiz).await), (400, 1200, 20));
        let comp = entrada_obtener(p, &dueno, &id).await.unwrap();
        assert_eq!(comp["lineas"].as_array().unwrap().len(), 2);
        assert_eq!(comp["proveedor"], "Distribuidora X");
        let k = kardex(p, &dueno, &lapiz, "2000-01-01", "2999-01-01").await.unwrap();
        assert_eq!(k.iter().map(|f| (f.tipo.as_str(), f.cantidad, f.existencia)).collect::<Vec<_>>(), vec![("entrada", 10, 20), ("entrada", 10, 10)]);
        assert!(k[0].referencia.as_deref().unwrap().contains("F-101"));
        // Datos malos: nada se guarda.
        let mut mala = en(false, None);
        mala.lineas[1].cantidad = 0;
        assert!(entrada(p, &dueno, CAJA_1, &mala).await.is_err());
        assert_eq!(hay(p, &lapiz).await, 20);
        cuadra(p).await;
    }

    #[tokio::test]
    async fn ajuste_exige_motivo_y_pin() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let lapiz = prod(p, "Lápiz", true).await;
        let aj = |nueva: Option<i64>, diferencia: Option<i64>, motivo: &str, detalle: &str| Ajuste { producto_id: lapiz.clone(), nueva, diferencia, motivo: motivo.into(), detalle: detalle.into() };
        assert!(ajustar(p, &dueno, CAJA_1, &aj(Some(5), None, "", ""), PIN_DUENO).await.unwrap_err().contains("motivo"));
        assert!(ajustar(p, &dueno, CAJA_1, &aj(Some(5), None, "Porque sí", ""), PIN_DUENO).await.unwrap_err().contains("motivo"));
        assert!(ajustar(p, &dueno, CAJA_1, &aj(Some(5), None, "Otro", ""), PIN_DUENO).await.unwrap_err().contains("Otro"));
        assert!(ajustar(p, &dueno, CAJA_1, &aj(Some(5), None, "Daño", ""), "000000").await.is_err());
        assert!(ajustar(p, &dueno, CAJA_1, &aj(Some(5), Some(1), "Daño", ""), PIN_DUENO).await.is_err());
        assert!(ajustar(p, &cajero, CAJA_1, &aj(Some(5), None, "Daño", ""), PIN_DUENO).await.unwrap_err().contains("permiso"));
        assert_eq!(hay(p, &lapiz).await, 0);
        assert_eq!(ajustar(p, &dueno, CAJA_1, &aj(Some(5), None, "Conteo", ""), PIN_DUENO).await.unwrap(), 5);
        assert_eq!(ajustar(p, &dueno, CAJA_1, &aj(None, Some(-2), "Otro", "Se mojaron"), PIN_DUENO).await.unwrap(), 3);
        let m: String = sqlx::query_scalar("SELECT motivo FROM inventario_movimientos ORDER BY rowid DESC LIMIT 1").fetch_one(p).await.unwrap();
        assert_eq!(m, "Otro: Se mojaron");
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'inventario.ajuste'").fetch_one(p).await.unwrap();
        assert_eq!(n, 2);
        cuadra(p).await;
    }

    #[tokio::test]
    async fn conteo_a_medias_y_aplicar_diferencias() {
        let (bd, _, dueno, _) = base_con_usuarios().await;
        let p = &bd.pool;
        let a1 = prod(p, "Alfa", true).await;
        let b1 = prod(p, "Beta", true).await;
        let c1 = prod(p, "Gama", false).await;
        ajustar(p, &dueno, CAJA_1, &Ajuste { producto_id: a1.clone(), nueva: Some(10), diferencia: None, motivo: "Conteo".into(), detalle: String::new() }, PIN_DUENO).await.unwrap();
        let id = conteo_guardar(p, &dueno, CAJA_1, None, Some(DEP), &HashMap::from([(a1.clone(), 7)])).await.unwrap();
        // Uno a la vez; se retoma y se completa.
        assert!(conteo_guardar(p, &dueno, CAJA_1, None, None, &HashMap::new()).await.is_err());
        let abierto = conteo_abierto(p, &dueno).await.unwrap().unwrap();
        assert_eq!((abierto.id.as_str(), abierto.datos.get(&a1)), (id.as_str(), Some(&7)));
        conteo_guardar(p, &dueno, CAJA_1, Some(&id), None, &HashMap::from([(a1.clone(), 7), (b1.clone(), 4), (c1.clone(), 2)])).await.unwrap();
        let dif = conteo_diferencias(p, &dueno, &id).await.unwrap();
        let d = |pid: &str| dif.iter().find(|f| f.producto_id == pid).map(|f| (f.sistema, f.contado, f.diferencia)).unwrap();
        assert_eq!(d(&a1), (10, Some(7), Some(-3)));
        assert_eq!(d(&b1), (0, Some(4), Some(4)));
        // Salen 2 de Alfa DESPUÉS de contarlo (una venta con la tienda abierta): la diferencia del
        // conteo sigue siendo −3 y al aplicar quedan 7 − 2, no 7.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        ajustar(p, &dueno, CAJA_1, &Ajuste { producto_id: a1.clone(), nueva: None, diferencia: Some(-2), motivo: "Merma".into(), detalle: String::new() }, PIN_DUENO).await.unwrap();
        let dif = conteo_diferencias(p, &dueno, &id).await.unwrap();
        assert_eq!(dif.iter().find(|f| f.producto_id == a1).map(|f| (f.sistema, f.diferencia)), Some((10, Some(-3))));
        assert!(conteo_aplicar(p, &dueno, &id, "000000").await.is_err());
        assert_eq!(conteo_aplicar(p, &dueno, &id, PIN_DUENO).await.unwrap(), 3);
        assert_eq!((hay(p, &a1).await, hay(p, &b1).await, hay(p, &c1).await), (5, 4, 2));
        let motivos: Vec<String> = sqlx::query_scalar("SELECT DISTINCT motivo FROM inventario_movimientos WHERE referencia_id = ?").bind(&id).fetch_all(p).await.unwrap();
        assert_eq!(motivos, vec!["Conteo".to_string()]);
        assert!(conteo_abierto(p, &dueno).await.unwrap().is_none());
        assert!(conteo_aplicar(p, &dueno, &id, PIN_DUENO).await.is_err());
        cuadra(p).await;
    }

    #[tokio::test]
    async fn inventario_inicial_todo_o_nada() {
        let (bd, _, dueno, _) = base_con_usuarios().await;
        let p = &bd.pool;
        let a1 = prod(p, "Alfa", false).await;
        sqlx::query("INSERT INTO codigos (codigo, producto_id, tipo) VALUES ('7401234567895', ?, 'barras')").bind(&a1).execute(p).await.unwrap();
        let b1 = prod(p, "Beta", true).await;
        let fila = |n: i64, clave: &str, ex: &str, costo: &str| FilaInicial { fila: n, clave: clave.into(), existencia: ex.into(), costo: costo.into() };
        let malas = vec![fila(2, "7401234567895", "12", "350"), fila(3, "NOEXISTE", "1", ""), fila(4, &b1, "-1", ""), fila(5, "7401234567895", "1", "")];
        let r = inicial(p, &dueno, CAJA_1, &malas, false, None).await.unwrap();
        assert_eq!(r.iter().filter(|x| x.error.is_some()).count(), 3);
        assert!(inicial(p, &dueno, CAJA_1, &malas, true, Some(PIN_DUENO)).await.is_err());
        assert_eq!(hay(p, &a1).await, 0);
        let buenas = vec![fila(2, "7401234567895", "1.200", "350"), fila(3, &b1, "0", "")];
        assert!(inicial(p, &dueno, CAJA_1, &buenas, true, Some("000000")).await.is_err());
        inicial(p, &dueno, CAJA_1, &buenas, true, Some(PIN_DUENO)).await.unwrap();
        assert_eq!((hay(p, &a1).await, hay(p, &b1).await), (1200, 0));
        let (tipo, costo): (String, i64) = sqlx::query_as("SELECT m.tipo, k.costo FROM inventario_movimientos m JOIN producto_costos k ON k.producto_id = m.producto_id").fetch_one(p).await.unwrap();
        assert_eq!((tipo.as_str(), costo), ("inicial", 350));
        cuadra(p).await;
    }

    #[test]
    fn numeros_del_csv_sin_decimales_disfrazados() {
        assert_eq!(entero("1250"), Some(1250));
        assert_eq!(entero("1.250"), Some(1250));
        assert_eq!(entero("1,250,000"), Some(1_250_000));
        assert_eq!(entero(" 12 "), Some(12));
        assert_eq!(entero("-3"), Some(-3));
        for malo in ["2.5", "1,25", "1.2345", "", "abc", "1..000", ".500"] {
            assert_eq!(entero(malo), None, "{malo}");
        }
    }

    #[tokio::test]
    async fn descartar_y_eliminar_dos_veces_no_inventa_bitacora_y_proveedor_sin_contacto() {
        let (bd, _, dueno, _) = base_con_usuarios().await;
        let p = &bd.pool;
        let id = conteo_guardar(p, &dueno, CAJA_1, None, None, &HashMap::new()).await.unwrap();
        conteo_descartar(p, &dueno, &id).await.unwrap();
        assert!(conteo_descartar(p, &dueno, &id).await.is_err());
        let prov = proveedor_guardar(p, &dueno, &Proveedor { id: String::new(), nombre: "Juan Pérez".into(), telefono: "8888-8888".into(), notas: "vecino".into() }).await.unwrap();
        // El mismo proveedor otra vez (doble clic o escrito distinto): rechazado. Editarlo a sí mismo, no.
        let otra_vez = Proveedor { id: String::new(), nombre: "juan  perez".into(), telefono: String::new(), notas: String::new() };
        assert!(proveedor_guardar(p, &dueno, &otra_vez).await.unwrap_err().contains("Juan Pérez"));
        proveedor_guardar(p, &dueno, &Proveedor { id: prov.clone(), ..otra_vez.clone() }).await.unwrap();
        proveedor_eliminar(p, &dueno, &prov).await.unwrap();
        // Eliminado ya no cuenta: se puede volver a crear.
        proveedor_guardar(p, &dueno, &otra_vez).await.unwrap();
        assert!(proveedor_eliminar(p, &dueno, &prov).await.is_err());
        let (tel, notas): (String, String) = sqlx::query_as("SELECT telefono, notas FROM proveedores WHERE id = ?").bind(&prov).fetch_one(p).await.unwrap();
        assert_eq!((tel.as_str(), notas.as_str()), ("", ""));
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion IN ('inventario.conteo_descartado', 'proveedor.eliminar')").fetch_one(p).await.unwrap();
        assert_eq!(n, 2);
        // Fecha de factura futura y cantidad negativa en un ajuste: rechazadas con mensaje claro.
        let a1 = prod(p, "Alfa", true).await;
        let futura = Entrada { proveedor_id: None, factura: String::new(), fecha: "2999-01-01".into(), lineas: vec![LineaEntrada { producto_id: a1.clone(), cantidad: 1, costo_unitario: None, precio_nuevo: None }], actualizar_costo: false };
        assert!(entrada(p, &dueno, CAJA_1, &futura).await.unwrap_err().contains("todavía no llega"));
        let neg = Ajuste { producto_id: a1.clone(), nueva: Some(-1), diferencia: None, motivo: "Daño".into(), detalle: String::new() };
        assert!(ajustar(p, &dueno, CAJA_1, &neg, PIN_DUENO).await.unwrap_err().contains("de 0 a 1.000.000"));
        // Restar más de lo que hay tampoco: un ajuste nunca deja la existencia en negativo.
        ajustar(p, &dueno, CAJA_1, &Ajuste { producto_id: a1.clone(), nueva: Some(3), diferencia: None, motivo: "Conteo".into(), detalle: String::new() }, PIN_DUENO).await.unwrap();
        let mucho = Ajuste { producto_id: a1.clone(), nueva: None, diferencia: Some(-10), motivo: "Daño".into(), detalle: String::new() };
        assert!(ajustar(p, &dueno, CAJA_1, &mucho, PIN_DUENO).await.unwrap_err().contains("quedarían -7"));
        assert_eq!(hay(p, &a1).await, 3);
    }

    #[tokio::test]
    async fn reportes_bajo_minimo_y_valorizado() {
        let (bd, _, dueno, _) = base_con_usuarios().await;
        let p = &bd.pool;
        let a1 = prod(p, "Alfa", true).await;
        let b1 = prod(p, "Beta", true).await;
        producto_guardar(p, &dueno, &a1, true, 5, Some(300)).await.unwrap();
        producto_guardar(p, &dueno, &b1, true, 0, None).await.unwrap();
        for (pid, n) in [(&a1, 2), (&b1, 4)] {
            ajustar(p, &dueno, CAJA_1, &Ajuste { producto_id: pid.clone(), nueva: Some(n), diferencia: None, motivo: "Conteo".into(), detalle: String::new() }, PIN_DUENO).await.unwrap();
        }
        let sin = prod(p, "Servicio", false).await;
        let (con, _) = lista(p, &dueno, CAJA_1, &Filtro { filtro: "con_control".into(), ..Default::default() }).await.unwrap();
        assert!(con.iter().all(|f| f.controla) && !con.iter().any(|f| f.producto_id == sin));
        let bm = reporte_bajo_minimo(p, &dueno, CAJA_1).await.unwrap();
        assert_eq!(bm.iter().map(|f| (f.producto_id.as_str(), f.sugerido)).collect::<Vec<_>>(), vec![(a1.as_str(), 8)]);
        assert_eq!(alertas(p, &dueno, CAJA_1).await.unwrap(), 1);
        let v = reporte_valorizado(p, &dueno, CAJA_1).await.unwrap();
        assert_eq!(v.total, 600);
        assert_eq!(v.sin_costo.len(), 1);
        assert_eq!(reporte_movimientos(p, &dueno, "2000-01-01", "2999-01-01", Some("ajuste")).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn cajero_no_ve_costos_y_tecnico_no_entra() {
        let (bd, tec, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let a1 = prod(p, "Alfa", true).await;
        producto_guardar(p, &dueno, &a1, true, 1, Some(300)).await.unwrap();
        let ids = vec![a1.clone()];
        for quien in [&cajero, &tec] {
            assert!(lista(p, quien, CAJA_1, &Filtro::default()).await.is_err());
            assert!(estado_de(p, quien, CAJA_1, &ids).await.is_err());
            assert!(alertas(p, quien, CAJA_1).await.is_err());
            assert!(kardex(p, quien, &a1, "2000", "3000").await.is_err());
            assert!(reporte_bajo_minimo(p, quien, CAJA_1).await.is_err());
            assert!(reporte_valorizado(p, quien, CAJA_1).await.is_err());
            assert!(reporte_movimientos(p, quien, "2000", "3000", None).await.is_err());
            assert!(producto_guardar(p, quien, &a1, true, 1, Some(1)).await.is_err());
            assert!(proveedores(p, quien).await.is_err());
            assert!(conteo_abierto(p, quien).await.is_err());
            assert!(inicial(p, quien, CAJA_1, &[FilaInicial { fila: 1, clave: a1.clone(), existencia: "1".into(), costo: String::new() }], false, None).await.is_err());
            assert!(config::guardar(p, quien, "venta_mostrar_existencia", &json!(true)).await.is_err());
            assert!(existencia_venta(p, quien, CAJA_1, &ids).await.is_err());
        }
        // Con la configuración activa, el cajero ve cuántas hay. Nada más (el tipo no lleva costo).
        config::guardar(p, &dueno, "venta_mostrar_existencia", &json!(true)).await.unwrap();
        let v = serde_json::to_value(existencia_venta(p, &cajero, CAJA_1, &ids).await.unwrap()).unwrap();
        assert_eq!(v, json!([{"productoId": a1, "existencia": 0}]));
        assert!(existencia_venta(p, &tec, CAJA_1, &ids).await.is_err());
        // Tampoco por la lectura de catálogo.
        for sql in ["SELECT * FROM producto_costos", "SELECT * FROM existencias", "SELECT * FROM inventario_movimientos", "SELECT * FROM proveedores", "SELECT * FROM inventario_entradas"] {
            assert!(bd.leer(&cajero, sql, &[]).await.is_err(), "{sql}");
        }
        let _ = Rol::Cajero;
    }

    #[tokio::test]
    async fn kardex_no_se_modifica_ni_se_borra_ni_se_descuadra() {
        let (bd, _, dueno, _) = base_con_usuarios().await;
        let p = &bd.pool;
        let a1 = prod(p, "Alfa", true).await;
        ajustar(p, &dueno, CAJA_1, &Ajuste { producto_id: a1.clone(), nueva: Some(5), diferencia: None, motivo: "Conteo".into(), detalle: String::new() }, PIN_DUENO).await.unwrap();
        assert!(sqlx::query("UPDATE inventario_movimientos SET cantidad = 50").execute(p).await.is_err());
        assert!(sqlx::query("DELETE FROM inventario_movimientos").execute(p).await.is_err());
        // Un movimiento con una existencia resultante que no cuadra: rechazado por la base.
        let r = sqlx::query("INSERT INTO inventario_movimientos (id, producto_id, sucursal_id, tipo, cantidad, existencia, usuario_id, fecha) VALUES ('X', ?, ?, 'ajuste', 1, 99, ?, 'x')")
            .bind(&a1)
            .bind(SUC)
            .bind(&dueno.id)
            .execute(p)
            .await;
        assert!(r.is_err());
        cuadra(p).await;
    }

    #[tokio::test]
    async fn producto_nuevo_controla_solo_con_su_primer_codigo_de_barras() {
        let (bd, _, dueno, _) = base_con_usuarios().await;
        let p = &bd.pool;
        let controla = |id: &'static str| async move { sqlx::query_scalar::<_, i64>("SELECT controla_inventario FROM productos WHERE id = ?").bind(id).fetch_one(p).await.unwrap() };
        for id in ["SERV", "LAPIZ"] {
            sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, 'x', 'x', ?, 100)").bind(id).bind(DEP).execute(p).await.unwrap();
        }
        // Servicio con código interno: sin control (el cajero lo vende aunque no haya "existencia").
        sqlx::query("INSERT INTO codigos (codigo, producto_id, tipo) VALUES ('imp01', 'SERV', 'interno')").execute(p).await.unwrap();
        assert_eq!(controla("SERV").await, 0);
        sqlx::query("INSERT INTO codigos (codigo, producto_id, tipo) VALUES ('7401234567895', 'LAPIZ', 'barras')").execute(p).await.unwrap();
        assert_eq!(controla("LAPIZ").await, 1);
        // El dueño lo apaga: un segundo código de barras no lo vuelve a encender.
        producto_guardar(p, &dueno, "LAPIZ", false, 0, None).await.unwrap();
        sqlx::query("INSERT INTO codigos (codigo, producto_id, tipo) VALUES ('7409999999995', 'LAPIZ', 'barras')").execute(p).await.unwrap();
        assert_eq!(controla("LAPIZ").await, 0);
    }

    #[tokio::test]
    async fn migracion_deja_sin_control_lo_que_no_tiene_codigo_de_barras() {
        let dir = std::env::temp_dir().join(format!("pos-prueba-{}", ulid()));
        std::fs::create_dir_all(&dir).unwrap();
        let vieja = crate::bd::crear_vieja(&dir.join("pos.db"), 10).await;
        for (id, cod) in [("P1", Some("7401234567895")), ("P2", None)] {
            sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES (?, 'x', 'x', ?, 1)").bind(id).bind(DEP).execute(&vieja).await.unwrap();
            if let Some(c) = cod {
                sqlx::query("INSERT INTO codigos (codigo, producto_id, tipo) VALUES (?, ?, 'barras')").bind(c).bind(id).execute(&vieja).await.unwrap();
            }
        }
        vieja.close().await;
        let bd = crate::bd::Bd::abrir(&dir, None).await.unwrap();
        let c: Vec<(String, i64)> = sqlx::query_as("SELECT id, controla_inventario FROM productos ORDER BY id").fetch_all(&bd.pool).await.unwrap();
        assert_eq!(c, vec![("P1".into(), 1), ("P2".into(), 0)]);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM existencias").fetch_one(&bd.pool).await.unwrap();
        assert_eq!(n, 0);
        bd.pool.close().await;
        bd.lectura.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
