// Configuración clave → valor JSON, con permiso por clave (lo decide Rust).

use crate::bitacora;
use crate::permisos::{puede, sin_permiso};
use crate::sesion::Actor;
use crate::util::{ahora_iso, e, Res};
use serde_json::{json, Value};
use sqlx::{SqliteConnection, SqlitePool};

/// Lo mismo que valor(), pero con la conexión de una transacción ya abierta.
pub async fn valor_con(c: &mut SqliteConnection, clave: &str) -> Option<Value> {
    let s: Option<String> = sqlx::query_scalar("SELECT valor FROM config WHERE clave = ?").bind(clave).fetch_optional(c).await.ok().flatten();
    s.and_then(|v| serde_json::from_str(&v).ok())
}

pub async fn booleano_con(c: &mut SqliteConnection, clave: &str, defecto: bool) -> bool {
    valor_con(c, clave).await.and_then(|v| v.as_bool()).unwrap_or(defecto)
}

pub async fn entero_con(c: &mut SqliteConnection, clave: &str, defecto: i64) -> i64 {
    valor_con(c, clave).await.and_then(|v| v.as_i64()).unwrap_or(defecto)
}

pub async fn valor(pool: &SqlitePool, clave: &str) -> Option<Value> {
    let s: Option<String> = sqlx::query_scalar("SELECT valor FROM config WHERE clave = ?").bind(clave).fetch_optional(pool).await.ok().flatten();
    s.and_then(|v| serde_json::from_str(&v).ok())
}

pub async fn entero(pool: &SqlitePool, clave: &str, defecto: i64) -> i64 {
    valor(pool, clave).await.and_then(|v| v.as_i64()).unwrap_or(defecto)
}

pub async fn booleano(pool: &SqlitePool, clave: &str, defecto: bool) -> bool {
    valor(pool, clave).await.and_then(|v| v.as_bool()).unwrap_or(defecto)
}

/// Quién puede cambiar cada clave.
fn permiso_de(clave: &str) -> &'static [&'static str] {
    match clave {
        "tema" => &[],                                            // cualquier usuario con sesión
        c if c.starts_with("importacion_") => &["productos.importar"],
        c if c.starts_with("caja_") => &["caja.admin", "config.tecnica"],
        _ => &["config.tecnica"],                                  // todo lo demás: técnico
    }
}

pub async fn guardar(pool: &SqlitePool, a: &Actor, clave: &str, v: &Value) -> Res<()> {
    if clave.is_empty() || clave.len() > 60 || !clave.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
        return Err("La clave solo admite minúsculas, números y _".into());
    }
    let perms = permiso_de(clave);
    if !perms.is_empty() && !perms.iter().any(|p| puede(a.rol, p)) {
        return Err(sin_permiso("cambiar esta configuración"));
    }
    let txt = v.to_string();
    if txt.len() > 20_000 {
        return Err("Valor demasiado grande".into());
    }
    let antes: Option<String> = sqlx::query_scalar("SELECT valor FROM config WHERE clave = ?").bind(clave).fetch_optional(pool).await.map_err(e)?;
    if antes.as_deref() == Some(txt.as_str()) {
        return Ok(());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    sqlx::query("INSERT INTO config (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en")
        .bind(clave)
        .bind(&txt)
        .bind(ahora_iso())
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    let antes_v = antes.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
    bitacora::registrar(&mut tx, Some(&a.id), "config.cambiar", "config", Some(clave), &json!({"antes": antes_v, "despues": v})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usuarios::tests::base_con_usuarios;

    #[tokio::test]
    async fn permisos_por_clave() {
        let (bd, tec, dueno, cajero) = base_con_usuarios().await;
        // El cajero no puede subir su propio tope de descuento.
        assert!(guardar(&bd.pool, &cajero, "descuento_max_pct", &json!({"cajero": 100})).await.unwrap_err().contains("permiso"));
        assert!(guardar(&bd.pool, &cajero, "caja_umbral_diferencia", &json!(999999)).await.is_err());
        // El tema lo cambia cualquiera; los umbrales de caja el dueño; lo técnico el técnico.
        guardar(&bd.pool, &cajero, "tema", &json!("oscuro")).await.unwrap();
        guardar(&bd.pool, &dueno, "caja_umbral_diferencia", &json!(2000)).await.unwrap();
        assert!(guardar(&bd.pool, &dueno, "pin_min_dueno", &json!(4)).await.is_err());
        guardar(&bd.pool, &tec, "escaner_debounce_ms", &json!(250)).await.unwrap();
        // Turno compartido, casillas del Z y "no venta": dueño y técnico, nunca el cajero.
        for clave in ["caja_turno_compartido", "caja_z_detalle_completo", "caja_z_por_departamento", "caja_no_venta_umbral", "caja_quitar_linea_bitacora"] {
            assert!(guardar(&bd.pool, &cajero, clave, &json!(false)).await.unwrap_err().contains("permiso"), "{clave}");
            guardar(&bd.pool, &dueno, clave, &json!(true)).await.unwrap();
            guardar(&bd.pool, &tec, clave, &json!(false)).await.unwrap();
        }
        // Valores que siembra la migración 9.
        assert!(!booleano(&bd.pool, "caja_z_por_departamento", true).await);
        assert_eq!(valor(&bd.pool, "caja_no_venta_motivos").await, Some(json!(["Cambio de billetes", "Devolución", "Otro"])));
        assert_eq!(entero(&bd.pool, "caja_umbral_diferencia", 0).await, 2000);
    }
}
