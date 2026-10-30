// Clientes (Ley 8968). Reglas:
// - Sin consentimiento no se guarda. Obligatorios solo nombre y teléfono (o cédula).
// - El cajero ve nombre, teléfono y cédula; todo lo demás es del dueño. El técnico no entra.
// - No hay borrado lógico: se ANONIMIZA (el id queda para que el historial cuadre).
// - La bitácora guarda ids, acciones y nombres de campos, NUNCA los datos personales.

use crate::bitacora;
use crate::bd::fila_json;
use crate::config;
use crate::sesion::Actor;
use crate::usuarios;
use crate::util::{ahora_iso, e, normalizar, texto, ulid, Res};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::{Row, SqlitePool};

pub const NOMBRE_ANONIMO: &str = "Cliente anonimizado";
const TIPOS_ID: &[&str] = &["fisica", "juridica", "dimex", "nite", "extranjero"];
const MOTIVOS: &[&str] = &["solicitud_titular", "retencion", "otro"];

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Basico {
    pub id: String,
    pub nombre: String,
    pub telefono: Option<String>,
    pub cedula: Option<String>,
}

fn a_basico(f: &sqlx::sqlite::SqliteRow) -> Basico {
    Basico { id: f.get("id"), nombre: f.get("nombre"), telefono: f.get("telefono"), cedula: f.get("cedula") }
}

/// Cliente completo con las claves que espera la pantalla (camelCase).
fn a_cliente(f: &sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": f.get::<String, _>("id"),
        "nombre": f.get::<String, _>("nombre"),
        "telefono": f.get::<Option<String>, _>("telefono"),
        "tipoIdentificacion": f.get::<Option<String>, _>("tipo_identificacion"),
        "cedula": f.get::<Option<String>, _>("cedula"),
        "correo": f.get::<Option<String>, _>("correo"),
        "notas": f.get::<Option<String>, _>("notas"),
        "consentimientoDatos": f.get::<i64, _>("consentimiento_datos") == 1,
        "consentimientoFecha": f.get::<Option<String>, _>("consentimiento_fecha"),
        "consentimientoVersion": f.get::<Option<String>, _>("consentimiento_version"),
        "anonimizadoEn": f.get::<Option<String>, _>("anonimizado_en"),
        "creadoEn": f.get::<String, _>("creado_en"),
        "actualizadoEn": f.get::<String, _>("actualizado_en"),
    })
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Datos {
    pub nombre: String,
    #[serde(default)]
    pub telefono: String,
    pub tipo_identificacion: Option<String>,
    pub cedula: Option<String>,
    pub correo: Option<String>,
    pub notas: Option<String>,
}

struct Limpios {
    nombre: String,
    telefono: Option<String>,
    tipo: Option<String>,
    cedula: Option<String>,
    correo: Option<String>,
    notas: Option<String>,
}

fn opcional(v: Option<&str>, max: usize, campo: &str) -> Res<Option<String>> {
    let s = texto(v.unwrap_or(""), max, campo, false)?;
    Ok((!s.is_empty()).then_some(s))
}

fn validar(d: &Datos) -> Res<Limpios> {
    let nombre = texto(&d.nombre, 120, "nombre", true)?;
    if nombre == NOMBRE_ANONIMO {
        return Err("Ese nombre está reservado".into());
    }
    let telefono = opcional(Some(&d.telefono), 30, "teléfono")?;
    let cedula = opcional(d.cedula.as_deref(), 30, "cédula")?;
    // Teléfono o cédula: el apartado necesita teléfono (contacto); la factura, cédula.
    let digitos = telefono.as_deref().unwrap_or("").chars().filter(|c| c.is_ascii_digit()).count();
    if digitos > 0 && digitos < 8 {
        return Err("El teléfono debe tener al menos 8 dígitos".into());
    }
    if digitos == 0 && cedula.is_none() {
        return Err("Escriba el teléfono o la cédula".into());
    }
    let correo = opcional(d.correo.as_deref(), 120, "correo")?;
    if let Some(c) = &correo {
        let partes: Vec<&str> = c.split('@').collect();
        if partes.len() != 2 || partes[0].is_empty() || !partes[1].contains('.') || partes[1].starts_with('.') || partes[1].ends_with('.') || c.contains(char::is_whitespace) {
            return Err("El correo no parece válido".into());
        }
    }
    let tipo = d.tipo_identificacion.clone().filter(|t| !t.is_empty());
    if tipo.as_deref().is_some_and(|t| !TIPOS_ID.contains(&t)) {
        return Err("Tipo de identificación inválido".into());
    }
    Ok(Limpios { nombre, telefono, tipo, cedula, correo, notas: opcional(d.notas.as_deref(), 500, "notas")? })
}

/// Alta (cajero o dueño). `consentimiento` es la casilla "El cliente fue informado y acepta".
pub async fn crear(pool: &SqlitePool, a: &Actor, d: &Datos, consentimiento: bool, version_aviso: &str) -> Res<Basico> {
    a.exigir("clientes.basico", "registrar clientes")?;
    if !consentimiento {
        return Err("Sin el consentimiento del cliente no se pueden guardar sus datos".into());
    }
    let l = validar(d)?;
    let version = texto(version_aviso, 20, "versión del aviso", true)?;
    let id = ulid();
    let ahora = ahora_iso();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    sqlx::query(
        "INSERT INTO clientes (id, nombre, nombre_busqueda, tipo_identificacion, cedula, telefono, correo, notas,
           consentimiento_datos, consentimiento_fecha, consentimiento_version, creado_en, actualizado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&l.nombre)
    .bind(normalizar(&l.nombre))
    .bind(&l.tipo)
    .bind(&l.cedula)
    .bind(&l.telefono)
    .bind(&l.correo)
    .bind(&l.notas)
    .bind(&ahora)
    .bind(&version)
    .bind(&ahora)
    .bind(&ahora)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "cliente.crear", "cliente", Some(&id), &json!({"consentimientoVersion": version})).await?;
    tx.commit().await.map_err(e)?;
    Ok(Basico { id, nombre: l.nombre, telefono: l.telefono, cedula: l.cedula })
}

/// Para la venta: solo nombre, teléfono y cédula, buscando por nombre, teléfono o cédula.
pub async fn buscar_basico(pool: &SqlitePool, a: &Actor, t: &str, limite: i64) -> Res<Vec<Basico>> {
    a.exigir("clientes.basico", "buscar clientes")?;
    let t = t.trim();
    if t.is_empty() {
        return Ok(vec![]);
    }
    let digitos: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
    let por_numero = digitos.len() >= 3;
    let patron = |s: &str| format!("%{}%", s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let filas = sqlx::query(
        "SELECT id, nombre, telefono, cedula FROM clientes
         WHERE anonimizado_en IS NULL AND (nombre_busqueda LIKE ?1 ESCAPE '\\'
           OR (?2 AND (replace(replace(telefono, '-', ''), ' ', '') LIKE ?3 ESCAPE '\\' OR replace(replace(cedula, '-', ''), ' ', '') LIKE ?3 ESCAPE '\\')))
         ORDER BY nombre_busqueda LIMIT ?4",
    )
    .bind(patron(&normalizar(t)))
    .bind(por_numero)
    .bind(patron(&digitos))
    .bind(limite.clamp(1, 50))
    .fetch_all(pool)
    .await
    .map_err(e)?;
    Ok(filas.iter().map(a_basico).collect())
}

pub async fn basico(pool: &SqlitePool, a: &Actor, id: &str) -> Res<Option<Basico>> {
    a.exigir("clientes.basico", "ver clientes")?;
    let f = sqlx::query("SELECT id, nombre, telefono, cedula FROM clientes WHERE id = ? AND anonimizado_en IS NULL").bind(id).fetch_optional(pool).await.map_err(e)?;
    Ok(f.as_ref().map(a_basico))
}

/// Un dato para pegar en el facturador externo. La bitácora anota QUÉ campo, nunca el valor.
pub async fn dato_para_factura(pool: &SqlitePool, a: &Actor, id: &str, campo: &str) -> Res<Option<String>> {
    a.exigir("clientes.basico", "copiar datos del cliente")?;
    let sql = match campo {
        "nombre" => "SELECT nombre FROM clientes WHERE id = ? AND anonimizado_en IS NULL",
        "cedula" => "SELECT cedula FROM clientes WHERE id = ? AND anonimizado_en IS NULL",
        "correo" => "SELECT correo FROM clientes WHERE id = ? AND anonimizado_en IS NULL",
        _ => return Err("Campo inválido".into()),
    };
    let v: Option<Option<String>> = sqlx::query_scalar(sql).bind(id).fetch_optional(pool).await.map_err(e)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "cliente.copiar", "cliente", Some(id), &json!({"campo": campo})).await?;
    tx.commit().await.map_err(e)?;
    Ok(v.flatten())
}

pub async fn tiene_correo(pool: &SqlitePool, a: &Actor, id: &str) -> Res<bool> {
    a.exigir("clientes.basico", "ver clientes")?;
    let v: Option<Option<String>> = sqlx::query_scalar("SELECT correo FROM clientes WHERE id = ?").bind(id).fetch_optional(pool).await.map_err(e)?;
    Ok(v.flatten().is_some())
}

/// Lista completa (dueño). Cada consulta queda en bitácora, sin el texto buscado.
pub async fn listar(pool: &SqlitePool, a: &Actor, filtro: &str, incluir_anonimizados: bool) -> Res<Vec<Value>> {
    a.exigir("clientes", "ver la lista de clientes")?;
    let f = filtro.trim();
    let filas = sqlx::query("SELECT * FROM clientes WHERE (?1 OR anonimizado_en IS NULL) AND (?2 = '' OR nombre_busqueda LIKE '%' || ?2 || '%') ORDER BY nombre_busqueda LIMIT 500")
        .bind(incluir_anonimizados)
        .bind(normalizar(f))
        .fetch_all(pool)
        .await
        .map_err(e)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "cliente.listar", "cliente", None, &json!({"resultados": filas.len(), "filtrado": !f.is_empty()})).await?;
    tx.commit().await.map_err(e)?;
    Ok(filas.iter().map(a_cliente).collect())
}

/// Todos los datos de un cliente (derecho de acceso). Queda en bitácora.
pub async fn obtener(pool: &SqlitePool, a: &Actor, id: &str) -> Res<Option<Value>> {
    a.exigir("clientes", "ver los datos del cliente")?;
    let Some(f) = sqlx::query("SELECT * FROM clientes WHERE id = ?").bind(id).fetch_optional(pool).await.map_err(e)? else {
        return Ok(None);
    };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "cliente.ver", "cliente", Some(id), &json!({})).await?;
    tx.commit().await.map_err(e)?;
    Ok(Some(a_cliente(&f)))
}

/// Rectificación (dueño). En bitácora van solo los NOMBRES de los campos cambiados.
pub async fn editar(pool: &SqlitePool, a: &Actor, id: &str, d: &Datos) -> Res<()> {
    a.exigir("clientes", "corregir datos del cliente")?;
    let l = validar(d)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let f = sqlx::query("SELECT * FROM clientes WHERE id = ?").bind(id).fetch_optional(&mut *tx).await.map_err(e)?.ok_or("Cliente no encontrado")?;
    if f.get::<Option<String>, _>("anonimizado_en").is_some() {
        return Err("El cliente está anonimizado".into());
    }
    let mut campos = Vec::new();
    let pares: [(&str, &str, Option<&String>); 6] = [
        ("nombre", "nombre", Some(&l.nombre)),
        ("telefono", "telefono", l.telefono.as_ref()),
        ("tipoIdentificacion", "tipo_identificacion", l.tipo.as_ref()),
        ("cedula", "cedula", l.cedula.as_ref()),
        ("correo", "correo", l.correo.as_ref()),
        ("notas", "notas", l.notas.as_ref()),
    ];
    for (k, col, v) in pares {
        if f.get::<Option<String>, _>(col).as_ref() != v {
            campos.push(k);
        }
    }
    if campos.is_empty() {
        return Ok(());
    }
    sqlx::query("UPDATE clientes SET nombre = ?, nombre_busqueda = ?, telefono = ?, tipo_identificacion = ?, cedula = ?, correo = ?, notas = ?, actualizado_en = ? WHERE id = ?")
        .bind(&l.nombre)
        .bind(normalizar(&l.nombre))
        .bind(&l.telefono)
        .bind(&l.tipo)
        .bind(&l.cedula)
        .bind(&l.correo)
        .bind(&l.notas)
        .bind(ahora_iso())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "cliente.editar", "cliente", Some(id), &json!({"campos": campos})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

async fn cuentas_de(pool: &SqlitePool, id: &str) -> Res<Vec<Map<String, Value>>> {
    let filas = sqlx::query("SELECT id, tipo, fecha, total, saldo, estado FROM cuentas WHERE cliente_id = ? AND eliminado_en IS NULL ORDER BY fecha").bind(id).fetch_all(pool).await.map_err(e)?;
    Ok(filas.iter().map(fila_json).collect())
}

/// Apartados o créditos abiertos con saldo: mientras existan, no se puede anonimizar.
pub async fn cuentas_con_saldo(pool: &SqlitePool, a: &Actor, id: &str) -> Res<Vec<Map<String, Value>>> {
    a.exigir("clientes", "ver clientes")?;
    Ok(cuentas_de(pool, id).await?.into_iter().filter(|c| c.get("estado").and_then(|v| v.as_str()) == Some("abierta") && c.get("saldo").and_then(|v| v.as_i64()).unwrap_or(0) > 0).collect())
}

/// "Exportar mis datos" (derecho de acceso). Queda en bitácora con el formato.
pub async fn para_exportar(pool: &SqlitePool, a: &Actor, id: &str, formato: &str) -> Res<Value> {
    a.exigir("clientes", "exportar datos de clientes")?;
    if formato != "csv" && formato != "pdf" {
        return Err("Formato inválido".into());
    }
    let f = sqlx::query("SELECT * FROM clientes WHERE id = ?").bind(id).fetch_optional(pool).await.map_err(e)?.ok_or("Cliente no encontrado")?;
    let ventas = sqlx::query("SELECT numero, fecha, total FROM ventas WHERE cliente_id = ? AND eliminado_en IS NULL ORDER BY fecha").bind(id).fetch_all(pool).await.map_err(e)?;
    let cuentas = cuentas_de(pool, id).await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "cliente.exportar", "cliente", Some(id), &json!({"formato": formato})).await?;
    tx.commit().await.map_err(e)?;
    Ok(json!({"cliente": a_cliente(&f), "cuentas": cuentas, "ventas": ventas.iter().map(fila_json).collect::<Vec<_>>()}))
}

/// Anonimiza de verdad: borra nombre, teléfono, correo, cédula, tipo y notas (también las notas
/// de sus apartados). El id, ventas y abonos quedan con sus montos. Solo el dueño, con PIN y motivo.
pub async fn anonimizar(pool: &SqlitePool, a: &Actor, id: &str, pin: &str, motivo: &str) -> Res<()> {
    a.exigir("clientes", "anonimizar clientes")?;
    if !MOTIVOS.contains(&motivo) {
        return Err("Elija el motivo".into());
    }
    let anon: Option<Option<String>> = sqlx::query_scalar("SELECT anonimizado_en FROM clientes WHERE id = ?").bind(id).fetch_optional(pool).await.map_err(e)?;
    match anon {
        None => return Err("Cliente no encontrado".into()),
        Some(Some(_)) => return Err("El cliente ya está anonimizado".into()),
        _ => {}
    }
    usuarios::confirmar_dueno(pool, a, pin, "anonimizar cliente").await?;
    let pendientes = cuentas_con_saldo(pool, a, id).await?.len();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    if pendientes > 0 {
        bitacora::registrar(&mut tx, Some(&a.id), "cliente.anonimizar_rechazado", "cliente", Some(id), &json!({"razon": "saldo", "cuentas": pendientes})).await?;
        tx.commit().await.map_err(e)?;
        return Err(format!("No se puede anonimizar: tiene {pendientes} apartado(s) o crédito(s) con saldo pendiente. Primero liquídelos o cancélelos."));
    }
    let ahora = ahora_iso();
    sqlx::query("UPDATE clientes SET nombre = ?, nombre_busqueda = ?, telefono = NULL, correo = NULL, cedula = NULL, notas = NULL, tipo_identificacion = NULL, anonimizado_en = ?, actualizado_en = ? WHERE id = ?")
        .bind(NOMBRE_ANONIMO)
        .bind(normalizar(NOMBRE_ANONIMO))
        .bind(&ahora)
        .bind(&ahora)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    sqlx::query("UPDATE cuentas SET notas = '', actualizado_en = ? WHERE cliente_id = ?").bind(&ahora).bind(id).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "cliente.anonimizar", "cliente", Some(id), &json!({"motivo": motivo})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

/// Clientes sin saldos ni movimientos en los últimos meses de retención. Solo SUGIERE.
pub async fn sugerencias_retencion(pool: &SqlitePool, a: &Actor) -> Res<Vec<Basico>> {
    a.exigir("clientes", "ver clientes")?;
    let meses = config::entero(pool, "retencion_clientes_meses", 36).await.clamp(1, 240) as u32;
    let limite = chrono::Utc::now().checked_sub_months(chrono::Months::new(meses)).unwrap_or_else(chrono::Utc::now);
    let filas = sqlx::query(
        "SELECT id, nombre, telefono, cedula FROM (
           SELECT c.id, c.nombre, c.telefono, c.cedula, max(
             c.actualizado_en,
             COALESCE((SELECT max(v.fecha) FROM ventas v WHERE v.cliente_id = c.id), ''),
             COALESCE((SELECT max(k.fecha) FROM cuentas k WHERE k.cliente_id = c.id), ''),
             COALESCE((SELECT max(b.fecha) FROM abonos b JOIN cuentas k ON k.id = b.cuenta_id WHERE k.cliente_id = c.id), '')
           ) AS ultimo
           FROM clientes c
           WHERE c.anonimizado_en IS NULL
             AND NOT EXISTS (SELECT 1 FROM cuentas k WHERE k.cliente_id = c.id AND k.eliminado_en IS NULL AND k.estado = 'abierta' AND k.saldo > 0)
         ) WHERE ultimo < ? ORDER BY ultimo",
    )
    .bind(limite.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
    .fetch_all(pool)
    .await
    .map_err(e)?;
    Ok(filas.iter().map(a_basico).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usuarios::tests::base_con_usuarios;

    fn datos() -> Datos {
        Datos { nombre: "María Rojas".into(), telefono: "8888-1234".into(), cedula: Some("1-1111-1111".into()), correo: Some("maria@correo.cr".into()), ..Default::default() }
    }

    #[tokio::test]
    async fn consentimiento_permisos_y_bitacora_sin_datos() {
        let (bd, tec, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        assert!(crear(p, &cajero, &datos(), false, "1").await.unwrap_err().contains("consentimiento"));
        assert!(crear(p, &tec, &datos(), true, "1").await.unwrap_err().contains("permiso"));
        let c = crear(p, &cajero, &datos(), true, "1").await.unwrap();
        assert_eq!(buscar_basico(p, &cajero, "8888", 10).await.unwrap().len(), 1);
        // "%" no es comodín para el que busca.
        assert!(buscar_basico(p, &cajero, "%", 10).await.unwrap().is_empty());
        assert!(listar(p, &cajero, "", false).await.unwrap_err().contains("permiso"));
        assert_eq!(listar(p, &dueno, "maria", false).await.unwrap().len(), 1);
        let det: Vec<String> = sqlx::query_scalar("SELECT detalle FROM bitacora").fetch_all(p).await.unwrap();
        assert!(det.iter().all(|d| !d.contains("8888") && !d.contains("María") && !d.contains("maria")));
        // Anonimizar: dueño con PIN.
        assert!(anonimizar(p, &dueno, &c.id, "000000", "otro").await.is_err());
        anonimizar(p, &dueno, &c.id, "246813", "solicitud_titular").await.unwrap();
        let n: Option<String> = sqlx::query_scalar("SELECT telefono FROM clientes WHERE id = ?").bind(&c.id).fetch_one(p).await.unwrap();
        assert!(n.is_none());
    }
}
