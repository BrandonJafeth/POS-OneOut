// Proformas (cotizaciones), DISENO-PROFORMAS.md. Un precio por escrito sin registrar una venta: no mueve
// dinero, no abre la gaveta, no toca ni reserva inventario y no entra al Z ni a las ventas.
// - Numeración propia por caja (P-0012); editar crea la versión siguiente (P-0012-2) y la anterior queda
//   "reemplazada".
// - Se convierte en venta o apartado DENTRO de la transacción del cobro o del apartado (ventas.rs,
//   cuentas.rs): `preparar_conversion` antes, `marcar_convertida` después. Índices únicos en
//   ventas.proforma_id y cuentas.proforma_id: nunca dos veces.
// - Vigente y proforma_precio_al_convertir = "proforma": se cobra al precio de la proforma. Si no (o vencida):
//   precio de hoy. "Vencida" no se guarda: es vigente con vence < hoy (reloj de util).
// - El nombre escrito (sin cliente guardado) vive solo en la proforma y se borra solo N días después de que
//   termine (proforma_retencion_nombre_dias). No va a la bitácora ni a los reportes.

use crate::bitacora;
use crate::calculo::{self, Estado, Linea};
use crate::config;
use crate::cuentas;
use crate::sesion::Actor;
use crate::util::{ahora, ahora_iso, colones, e, texto, ulid, Res};
use crate::ventas;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::HashMap;
#[cfg(test)]
use ts_rs::TS;

// ─────────── Tipos ───────────

/// Venta ligada a una proforma (guardada desde esa pestaña o abierta con "Pasar a venta").
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ProformaRef {
    pub id: String,
    pub numero: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ProformaFila {
    pub id: String,
    pub numero: String,
    /// vigente, vencida, convertida, anulada o reemplazada.
    pub estado: String,
    pub cliente_id: Option<String>,
    /// Cliente guardado o nombre escrito (None: sin nombre o ya borrado).
    pub cliente: Option<String>,
    pub fecha: String,
    pub vence: String,
    pub total: i64,
    pub usuario: String,
    /// Venta o apartado al que se convirtió.
    pub convertida_en: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ProformaLinea {
    pub producto_id: Option<String>,
    pub codigo: Option<String>,
    pub descripcion: String,
    pub cantidad: i64,
    pub precio_unitario: i64,
    pub descuento: i64,
    pub total: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ProformaDetalle {
    pub proforma: ProformaFila,
    pub subtotal: i64,
    pub descuento: i64,
    pub condiciones: String,
    pub lineas: Vec<ProformaLinea>,
    pub reimpresiones: i64,
}

/// Lo que se carga en una venta nueva al "Pasar a venta": las líneas con el precio que corresponde y
/// un aviso por cada línea que cambió o no se pudo cargar.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct AbrirProforma {
    #[cfg_attr(test, ts(type = "unknown"))]
    pub estado: Estado,
    pub avisos: Vec<String>,
    pub vencida: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct GrupoProformas {
    pub cantidad: i64,
    pub monto: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ReporteProformas {
    pub emitidas: GrupoProformas,
    pub convertidas: GrupoProformas,
    pub vencidas: GrupoProformas,
    pub anuladas: GrupoProformas,
    pub vigentes: GrupoProformas,
    /// Las versiones reemplazadas no cuentan: cada número cuenta una vez, con su última versión.
    pub filas: Vec<ProformaFila>,
}

// ─────────── Reglas ───────────

pub fn numero(consecutivo: i64, version: i64) -> String {
    if version <= 1 { format!("P-{consecutivo:04}") } else { format!("P-{consecutivo:04}-{version}") }
}

/// Estado que se muestra: una vigente cuyo último día ya pasó está "vencida".
pub fn estado_visible(estado: &str, vence: &str, hoy: NaiveDate) -> &'static str {
    match estado {
        "vigente" if vence < hoy.to_string().as_str() => "vencida",
        "vigente" => "vigente",
        "convertida" => "convertida",
        "anulada" => "anulada",
        _ => "reemplazada",
    }
}

/// Clave de una línea para comparar una venta con su proforma: el producto (o la descripción si es precio
/// libre), la cantidad y el descuento. El precio se revisa aparte (depende de la regla de conversión).
fn clave(l_producto: Option<&str>, descripcion: &str, cantidad: i64, descuento: i64) -> String {
    format!("{}|{cantidad}|{descuento}", l_producto.map(String::from).unwrap_or_else(|| format!("libre:{}", descripcion.trim().to_lowercase())))
}

/// La venta tiene exactamente las líneas (producto, cantidad, descuento) y el descuento al total de la proforma.
pub fn coincide(est: &Estado, lineas: &[(Option<String>, String, i64, i64)], descuento_total: i64) -> bool {
    let mut a: Vec<String> = est.lineas.iter().map(|l| clave(l.producto_id.as_deref(), &l.descripcion, l.cantidad, l.descuento)).collect();
    let mut b: Vec<String> = lineas.iter().map(|(p, d, c, x)| clave(p.as_deref(), d, *c, *x)).collect();
    a.sort();
    b.sort();
    a == b && est.descuento_total == descuento_total
}

// ─────────── Nombre escrito: se borra solo ───────────

/// Borra el nombre escrito de las proformas que terminaron (o vencieron) hace N días o más.
pub async fn limpiar_nombres(c: &mut SqliteConnection) -> Res<u64> {
    let dias = config::entero_con(&mut *c, "proforma_retencion_nombre_dias", 30).await.clamp(0, 3650);
    let limite = (ahora().date_naive() - chrono::Duration::days(dias)).to_string();
    let n = sqlx::query(
        "UPDATE proformas SET nombre = NULL WHERE nombre IS NOT NULL
           AND ((fin_en IS NOT NULL AND substr(fin_en, 1, 10) <= ?1) OR (estado = 'vigente' AND vence < ?1))",
    )
    .bind(&limite)
    .execute(&mut *c)
    .await
    .map_err(e)?
    .rows_affected();
    Ok(n)
}

// ─────────── Crear y versiones ───────────

fn fila_sql() -> &'static str {
    "SELECT p.id, p.numero, p.estado, p.cliente_id, COALESCE(c.nombre, p.nombre) AS cliente, p.fecha, p.vence, p.total, u.nombre AS usuario,
            COALESCE(v.numero, k.numero) AS convertida_en, p.subtotal, p.descuento, p.condiciones, p.reimpresiones
     FROM proformas p JOIN usuarios u ON u.id = p.usuario_id LEFT JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN ventas v ON v.id = p.venta_id LEFT JOIN cuentas k ON k.id = p.cuenta_id"
}

fn a_fila(f: &sqlx::sqlite::SqliteRow, hoy: NaiveDate) -> ProformaFila {
    let estado: String = f.get("estado");
    let vence: String = f.get("vence");
    ProformaFila {
        id: f.get("id"),
        numero: f.get("numero"),
        estado: estado_visible(&estado, &vence, hoy).into(),
        cliente_id: f.get("cliente_id"),
        cliente: f.get("cliente"),
        fecha: f.get("fecha"),
        vence,
        total: f.get("total"),
        usuario: f.get("usuario"),
        convertida_en: f.get("convertida_en"),
    }
}

/// Guarda la venta de la pestaña como proforma. Con `reemplaza` (una proforma vigente), crea su versión
/// siguiente con el mismo número y la anterior queda "reemplazada". No necesita la caja abierta.
pub async fn guardar(pool: &SqlitePool, a: &Actor, caja_id: &str, espera_id: &str, est: &Estado, reemplaza: Option<&str>) -> Res<ProformaDetalle> {
    a.exigir("proformas", "crear proformas")?;
    if est.lineas.is_empty() {
        return Err("La venta no tiene productos".into());
    }
    for l in &est.lineas {
        calculo::validar_linea(l)?;
    }
    let nombre = match est.nombre_tiquete.as_deref() {
        Some(n) => Some(texto(n, 80, "el nombre", false)?).filter(|s| !s.is_empty()),
        None => None,
    };
    let tope = ventas::tope_descuento(pool, a.rol).await;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    if let Some(cl) = &est.cliente {
        cuentas::cliente_con_consentimiento(&mut tx, &cl.id).await?;
    }
    let (lineas, catalogo) = ventas::lineas_de_catalogo(&mut tx, &est.lineas).await?;
    let e2 = Estado { lineas, ..est.clone() };
    // La proforma dice el precio exacto (el redondeo es del efectivo al cobrar).
    let tot = calculo::totales(&e2, 1);
    let autorizado_por = ventas::revisar_tope(&tot, &catalogo, tope, est, espera_id)?;
    if tot.total <= 0 {
        return Err("Una proforma de ¢0 no tiene sentido".into());
    }
    let fecha = ahora_iso();
    let (consecutivo, version) = match reemplaza {
        Some(id) => {
            let f = sqlx::query("SELECT consecutivo, estado, vence FROM proformas WHERE id = ? AND caja_id = ?").bind(id).bind(caja_id).fetch_optional(&mut *tx).await.map_err(e)?.ok_or("Proforma no encontrada")?;
            if estado_visible(&f.get::<String, _>("estado"), &f.get::<String, _>("vence"), ahora().date_naive()) != "vigente" {
                return Err("Solo se hace una versión nueva de una proforma vigente".into());
            }
            let c: i64 = f.get("consecutivo");
            let v: i64 = sqlx::query_scalar("SELECT MAX(version) FROM proformas WHERE caja_id = ? AND consecutivo = ?").bind(caja_id).bind(c).fetch_one(&mut *tx).await.map_err(e)?;
            sqlx::query("UPDATE proformas SET estado = 'reemplazada', fin_en = ?, actualizado_en = ? WHERE id = ? AND estado = 'vigente'").bind(&fecha).bind(&fecha).bind(id).execute(&mut *tx).await.map_err(e)?;
            (c, v + 1)
        }
        None => {
            let c: i64 = sqlx::query_scalar("SELECT proforma_siguiente FROM cajas WHERE id = ?").bind(caja_id).fetch_one(&mut *tx).await.map_err(e)?;
            sqlx::query("UPDATE cajas SET proforma_siguiente = proforma_siguiente + 1, actualizado_en = ? WHERE id = ?").bind(&fecha).bind(caja_id).execute(&mut *tx).await.map_err(e)?;
            (c, 1)
        }
    };
    let num = numero(consecutivo, version);
    let dias = config::entero_con(&mut tx, "proforma_vigencia_dias", 8).await.clamp(1, 365);
    let tipo = config::valor_con(&mut tx, "proforma_vigencia_tipo").await.and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "laborables".into());
    let condiciones = config::valor_con(&mut tx, "proforma_condiciones").await.and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    let h = crate::caja::horario_con(&mut tx).await;
    let hoy = ahora().date_naive();
    // Válida hasta el último día de la vigencia (nunca cae en un día que no se trabaja).
    let vence = cuentas::fecha_limite(hoy, dias, &tipo, &h).to_string();
    let id = ulid();
    let sucursal = crate::inventario::sucursal_de(&mut tx, caja_id).await?;
    sqlx::query(
        "INSERT INTO proformas (id, sucursal_id, caja_id, consecutivo, version, numero, cliente_id, nombre, usuario_id, fecha, dia, vence,
           subtotal, descuento, total, descuento_autorizado_por, condiciones, estado, creado_en, actualizado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'vigente', ?, ?)",
    )
    .bind(&id)
    .bind(&sucursal)
    .bind(caja_id)
    .bind(consecutivo)
    .bind(version)
    .bind(&num)
    .bind(est.cliente.as_ref().map(|c| c.id.clone()))
    .bind(if est.cliente.is_some() { None } else { nombre })
    .bind(&a.id)
    .bind(&fecha)
    .bind(hoy.to_string())
    .bind(&vence)
    .bind(tot.subtotal)
    .bind(tot.descuento)
    .bind(tot.total)
    .bind(&autorizado_por)
    .bind(condiciones.trim())
    .bind(&fecha)
    .bind(&fecha)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    for (i, l) in e2.lineas.iter().enumerate() {
        sqlx::query(
            "INSERT INTO proforma_lineas (id, proforma_id, orden, producto_id, codigo, descripcion, departamento_id, cantidad, precio_unitario, descuento, descuento_catalogo, tasa_iva, exento, total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(ulid())
        .bind(&id)
        .bind(i as i64)
        .bind(&l.producto_id)
        .bind(&l.codigo)
        .bind(&l.descripcion)
        .bind(&l.departamento_id)
        .bind(l.cantidad)
        .bind(l.precio_unitario)
        .bind(l.descuento)
        .bind(l.descuento_catalogo)
        .bind(if l.exento { 0.0 } else { l.tasa_iva })
        .bind(l.exento as i64)
        .bind(calculo::importe(l))
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    }
    bitacora::registrar(&mut tx, Some(&a.id), "proforma.crear", "proforma", Some(&id), &json!({"numero": num, "total": tot.total, "reemplaza": reemplaza})).await?;
    tx.commit().await.map_err(e)?;
    ventas::gastar_token(est);
    obtener(pool, a, &id).await
}

// ─────────── Consultas ───────────

/// Búsqueda por número (P-0012, 12), nombre del cliente o producto. `filtro`: "", vigentes, vencidas,
/// convertidas, anuladas.
pub async fn buscar(pool: &SqlitePool, a: &Actor, q: &str, filtro: &str) -> Res<Vec<ProformaFila>> {
    a.exigir("proformas", "buscar proformas")?;
    let mut c = pool.acquire().await.map_err(e)?;
    limpiar_nombres(&mut c).await?;
    let hoy = ahora().date_naive().to_string();
    let q = q.trim();
    let num: Option<i64> = q.trim_start_matches(['P', 'p']).trim_start_matches('-').split('-').next().and_then(|x| x.parse().ok());
    let like = format!("%{}%", crate::util::normalizar(q));
    let donde = match filtro {
        "vigentes" => "p.estado = 'vigente' AND p.vence >= ?5",
        "vencidas" => "p.estado = 'vigente' AND p.vence < ?5",
        "convertidas" => "p.estado = 'convertida'",
        "anuladas" => "p.estado = 'anulada'",
        _ => "p.estado <> 'reemplazada' AND ?5 = ?5",
    };
    let filas = sqlx::query(&format!(
        "{} WHERE ({donde}) AND (?1 = '' OR p.consecutivo = ?2 OR c.nombre_busqueda LIKE ?3 OR lower(p.nombre) LIKE ?4
           OR EXISTS (SELECT 1 FROM proforma_lineas l WHERE l.proforma_id = p.id AND lower(l.descripcion) LIKE ?4))
         ORDER BY p.fecha DESC LIMIT 200",
        fila_sql()
    ))
    .bind(q)
    .bind(num.unwrap_or(-1))
    .bind(&like)
    .bind(format!("%{}%", q.to_lowercase()))
    .bind(&hoy)
    .fetch_all(&mut *c)
    .await
    .map_err(e)?;
    let d = ahora().date_naive();
    Ok(filas.iter().map(|f| a_fila(f, d)).collect())
}

pub async fn obtener(pool: &SqlitePool, a: &Actor, id: &str) -> Res<ProformaDetalle> {
    a.exigir("proformas", "ver proformas")?;
    let mut c = pool.acquire().await.map_err(e)?;
    limpiar_nombres(&mut c).await?;
    let f = sqlx::query(&format!("{} WHERE p.id = ?", fila_sql())).bind(id).fetch_optional(&mut *c).await.map_err(e)?.ok_or("Proforma no encontrada")?;
    let lineas = sqlx::query("SELECT producto_id, codigo, descripcion, cantidad, precio_unitario, descuento, total FROM proforma_lineas WHERE proforma_id = ? ORDER BY orden")
        .bind(id)
        .fetch_all(&mut *c)
        .await
        .map_err(e)?
        .iter()
        .map(|l| ProformaLinea {
            producto_id: l.get("producto_id"),
            codigo: l.get("codigo"),
            descripcion: l.get("descripcion"),
            cantidad: l.get("cantidad"),
            precio_unitario: l.get("precio_unitario"),
            descuento: l.get("descuento"),
            total: l.get("total"),
        })
        .collect();
    Ok(ProformaDetalle { proforma: a_fila(&f, ahora().date_naive()), subtotal: f.get("subtotal"), descuento: f.get("descuento"), condiciones: f.get("condiciones"), lineas, reimpresiones: f.get("reimpresiones") })
}

/// Imprime la proforma (impresora de tiquetes). La reimpresión lleva COPIA, se cuenta y queda en la bitácora.
pub async fn imprimir(pool: &SqlitePool, a: &Actor, id: &str, datos: &[u8]) -> Res<bool> {
    a.exigir("proformas", "imprimir proformas")?;
    crate::escpos::validar(datos)?;
    let copia = crate::escpos::tiene_marca_copia(datos);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let caja_id: String = sqlx::query_scalar("SELECT caja_id FROM proformas WHERE id = ?").bind(id).fetch_optional(&mut *tx).await.map_err(e)?.ok_or("Proforma no encontrada")?;
    crate::impresoras::enviar_con(&mut tx, &caja_id, "tiquete", datos).await?;
    if copia {
        sqlx::query("UPDATE proformas SET reimpresiones = reimpresiones + 1 WHERE id = ?").bind(id).execute(&mut *tx).await.map_err(e)?;
        bitacora::registrar(&mut tx, Some(&a.id), "proforma.reimprimir", "proforma", Some(id), &json!({})).await?;
    }
    tx.commit().await.map_err(e)?;
    Ok(copia)
}

/// Anula una proforma vigente o vencida (dueño, con motivo, sin PIN: no mueve dinero).
pub async fn anular(pool: &SqlitePool, a: &Actor, id: &str, motivo: &str) -> Res<()> {
    a.exigir("proformas.anular", "anular proformas")?;
    let motivo = texto(motivo, 300, "motivo", true)?;
    if motivo.chars().count() < 5 {
        return Err("Escriba el motivo".into());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let fecha = ahora_iso();
    let n = sqlx::query("UPDATE proformas SET estado = 'anulada', fin_en = ?, anulada_por = ?, anulada_motivo = ?, actualizado_en = ? WHERE id = ? AND estado = 'vigente'")
        .bind(&fecha)
        .bind(&a.id)
        .bind(&motivo)
        .bind(&fecha)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(e)?
        .rows_affected();
    if n == 0 {
        return Err("Solo se anula una proforma vigente o vencida (no convertida)".into());
    }
    let numero: String = sqlx::query_scalar("SELECT numero FROM proformas WHERE id = ?").bind(id).fetch_one(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "proforma.anular", "proforma", Some(id), &json!({"numero": numero, "motivo": motivo})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

// ─────────── Pasar a venta ───────────

/// ¿Se cobra al precio de la proforma? Solo vigente y con la opción "proforma" (por defecto).
async fn usa_precio_proforma(c: &mut SqliteConnection, vence: &str) -> bool {
    let vigente = vence >= ahora().date_naive().to_string().as_str();
    let modo = config::valor_con(&mut *c, "proforma_precio_al_convertir").await.and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "proforma".into());
    vigente && modo == "proforma"
}

/// Arma la venta nueva de una proforma: sus líneas con el precio que toca y un aviso por línea que cambió
/// o que ya no se vende. Queda ligada a la proforma; se convierte recién al cobrar o apartar.
pub async fn abrir_en_venta(pool: &SqlitePool, a: &Actor, id: &str) -> Res<AbrirProforma> {
    a.exigir("proformas", "pasar proformas a venta")?;
    let d = obtener(pool, a, id).await?;
    let p = &d.proforma;
    if !matches!(p.estado.as_str(), "vigente" | "vencida") {
        return Err(format!("{} está {}: no se pasa a venta", p.numero, p.estado));
    }
    let mut c = pool.acquire().await.map_err(e)?;
    let de_proforma = usa_precio_proforma(&mut c, &p.vence).await;
    let mut avisos = vec![];
    let mut lineas = vec![];
    let filas = sqlx::query("SELECT producto_id, codigo, descripcion, departamento_id, cantidad, precio_unitario, descuento, descuento_catalogo, tasa_iva, exento FROM proforma_lineas WHERE proforma_id = ? ORDER BY orden")
        .bind(id)
        .fetch_all(&mut *c)
        .await
        .map_err(e)?;
    for f in &filas {
        let descripcion: String = f.get("descripcion");
        let producto: Option<String> = f.get("producto_id");
        let mut l = Linea {
            id: ulid(),
            producto_id: producto.clone(),
            codigo: f.get("codigo"),
            descripcion: descripcion.clone(),
            departamento_id: f.get("departamento_id"),
            cantidad: f.get("cantidad"),
            precio_unitario: f.get("precio_unitario"),
            descuento: f.get("descuento"),
            descuento_catalogo: f.get("descuento_catalogo"),
            tasa_iva: f.get("tasa_iva"),
            exento: f.get::<i64, _>("exento") == 1,
        };
        if let Some(pid) = &producto {
            let hoy = sqlx::query("SELECT precio, activo, descuento_pct, tasa_iva, exento FROM productos WHERE id = ? AND eliminado_en IS NULL").bind(pid).fetch_optional(&mut *c).await.map_err(e)?;
            let Some(hoy) = hoy.filter(|x| x.get::<i64, _>("activo") == 1) else {
                avisos.push(format!("{descripcion}: ya no se vende, no se cargó."));
                continue;
            };
            if !de_proforma {
                let precio: i64 = hoy.get("precio");
                if precio != l.precio_unitario {
                    avisos.push(format!("{descripcion}: {} → {}", colones(l.precio_unitario), colones(precio)));
                }
                l.precio_unitario = precio;
                l.descuento_catalogo = hoy.get("descuento_pct");
                l.tasa_iva = hoy.get("tasa_iva");
                l.exento = hoy.get::<i64, _>("exento") == 1;
                l.descuento = l.descuento.min(calculo::bruto(&l));
            }
        }
        lineas.push(l);
    }
    let cliente = match &p.cliente_id {
        Some(cid) => sqlx::query("SELECT id, nombre, telefono, cedula FROM clientes WHERE id = ? AND anonimizado_en IS NULL")
            .bind(cid)
            .fetch_optional(&mut *c)
            .await
            .map_err(e)?
            .map(|f| calculo::ClienteBasico { id: f.get("id"), nombre: f.get("nombre"), telefono: f.get("telefono"), cedula: f.get("cedula") }),
        None => None,
    };
    let vencida = p.estado == "vencida";
    let estado = Estado {
        lineas,
        descuento_total: d.descuento,
        nombre_tiquete: if cliente.is_none() { p.cliente.clone() } else { None },
        cliente,
        proforma: Some(ProformaRef { id: p.id.clone(), numero: p.numero.clone() }),
        ..Default::default()
    };
    Ok(AbrirProforma { estado, avisos, vencida })
}

/// Lo que el cobro o el apartado necesita de la proforma ligada: qué precios acepta en vez del catálogo
/// y si vale el descuento autorizado en la proforma.
pub struct Conversion {
    pub proforma_id: String,
    pub permitidos: HashMap<String, (i64, i64)>,
    pub autorizado_por: Option<String>,
}

/// Dentro de la transacción del cobro o del apartado: la proforma tiene que estar vigente (o vencida) y la
/// venta coincidir con ella. Si no, error claro (la pantalla ofrece guardar versión nueva o cobrar sin ligar).
pub async fn preparar_conversion(tx: &mut SqliteConnection, est: &Estado) -> Res<Option<Conversion>> {
    let Some(pf) = &est.proforma else { return Ok(None) };
    let f = sqlx::query("SELECT estado, vence, descuento, descuento_autorizado_por, numero FROM proformas WHERE id = ?").bind(&pf.id).fetch_optional(&mut *tx).await.map_err(e)?.ok_or("Proforma no encontrada")?;
    let estado: String = f.get("estado");
    let numero: String = f.get("numero");
    if estado != "vigente" {
        return Err(format!("{numero} ya está {}: cobre sin ligarla a la proforma", if estado == "convertida" { "convertida" } else { estado.as_str() }));
    }
    let lineas: Vec<(Option<String>, String, i64, i64, i64, i64)> =
        sqlx::query_as("SELECT producto_id, descripcion, cantidad, descuento, precio_unitario, descuento_catalogo FROM proforma_lineas WHERE proforma_id = ?").bind(&pf.id).fetch_all(&mut *tx).await.map_err(e)?;
    let claves: Vec<(Option<String>, String, i64, i64)> = lineas.iter().map(|(p, d, c, x, _, _)| (p.clone(), d.clone(), *c, *x)).collect();
    if !coincide(est, &claves, f.get("descuento")) {
        return Err(format!("{NO_COINCIDE}{numero}"));
    }
    let vence: String = f.get("vence");
    let (permitidos, autorizado_por) = if usa_precio_proforma(&mut *tx, &vence).await {
        (lineas.iter().filter_map(|(p, _, _, _, precio, pct)| p.clone().map(|p| (p, (*precio, *pct)))).collect(), f.get("descuento_autorizado_por"))
    } else {
        (HashMap::new(), None)
    };
    Ok(Some(Conversion { proforma_id: pf.id.clone(), permitidos, autorizado_por }))
}

/// Prefijo del error de una venta que ya no es igual a su proforma (la pantalla pregunta qué hacer).
pub const NO_COINCIDE: &str = "La venta ya no coincide con la proforma ";

/// Marca la proforma como convertida y liga la venta o el apartado. Una sola vez (estado e índice único).
pub async fn marcar_convertida(tx: &mut SqliteConnection, a: &Actor, c: &Conversion, venta_id: Option<&str>, cuenta_id: Option<&str>) -> Res<()> {
    let fecha = ahora_iso();
    let n = sqlx::query("UPDATE proformas SET estado = 'convertida', fin_en = ?, venta_id = ?, cuenta_id = ?, actualizado_en = ? WHERE id = ? AND estado = 'vigente'")
        .bind(&fecha)
        .bind(venta_id)
        .bind(cuenta_id)
        .bind(&fecha)
        .bind(&c.proforma_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?
        .rows_affected();
    if n == 0 {
        return Err("Esta proforma ya se convirtió".into());
    }
    if let Some(v) = venta_id {
        sqlx::query("UPDATE ventas SET proforma_id = ? WHERE id = ?").bind(&c.proforma_id).bind(v).execute(&mut *tx).await.map_err(|err| if e(&err).contains("UNIQUE") { "Esta proforma ya se convirtió".to_string() } else { e(err) })?;
    }
    if let Some(k) = cuenta_id {
        sqlx::query("UPDATE cuentas SET proforma_id = ? WHERE id = ?").bind(&c.proforma_id).bind(k).execute(&mut *tx).await.map_err(|err| if e(&err).contains("UNIQUE") { "Esta proforma ya se convirtió".to_string() } else { e(err) })?;
    }
    bitacora::registrar(&mut *tx, Some(&a.id), "proforma.convertir", "proforma", Some(&c.proforma_id), &json!({"venta": venta_id, "cuenta": cuenta_id})).await?;
    Ok(())
}

// ─────────── Reporte del dueño ───────────

/// Por fecha de EMISIÓN (no hay turno). Cada número cuenta una vez, con su versión vigente o final.
pub async fn reporte(pool: &SqlitePool, a: &Actor, desde: &str, hasta: &str) -> Res<ReporteProformas> {
    a.exigir("proformas.admin", "ver el reporte de proformas")?;
    let hoy = ahora().date_naive();
    let filas = sqlx::query(&format!("{} WHERE p.estado <> 'reemplazada' AND p.dia BETWEEN ? AND ? ORDER BY p.fecha", fila_sql()))
        .bind(desde)
        .bind(hasta)
        .fetch_all(pool)
        .await
        .map_err(e)?;
    let mut r = ReporteProformas::default();
    for f in &filas {
        let x = a_fila(f, hoy);
        let g = match x.estado.as_str() {
            "convertida" => &mut r.convertidas,
            "vencida" => &mut r.vencidas,
            "anulada" => &mut r.anuladas,
            _ => &mut r.vigentes,
        };
        g.cantidad += 1;
        g.monto += x.total;
        r.emitidas.cantidad += 1;
        r.emitidas.monto += x.total;
        // Ley 8968: el reporte no lleva el nombre escrito (solo el de un cliente guardado).
        let mut x = x;
        if x.cliente_id.is_none() {
            x.cliente = None;
        }
        r.filas.push(x);
    }
    Ok(r)
}

#[cfg(test)]
#[path = "proformas_tests.rs"]
mod tests;
