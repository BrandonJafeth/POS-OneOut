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
        "departamentos_color" => &["departamentos", "config.tecnica"],
        // Inventario: solo el dueño (el técnico no tiene acceso a inventario).
        "permitir_vender_sin_existencia" | "venta_mostrar_existencia" => &["inventario"],
        c if c.starts_with("inventario_") => &["inventario"],
        _ => &["config.tecnica"],                                  // todo lo demás: técnico
    }
}

/// Claves que cambian cobros, el efectivo o el cierre: tipo y rango. Un valor de otro tipo no daba
/// error: Rust usaba su valor por defecto y la pantalla el guardado (p. ej. redondeo "5" en texto:
/// la pantalla no redondeaba y una tarjeta por el total mostrado pasaba del total cobrado).
fn validar(clave: &str, v: &Value) -> Res<()> {
    let entero = |min: i64, max: i64| match v.as_i64() {
        Some(n) if (min..=max).contains(&n) => Ok(()),
        _ => Err(format!("«{clave}»: debe ser un número entero de {min} a {max}")),
    };
    let si_no = || if v.is_boolean() { Ok(()) } else { Err(format!("«{clave}»: debe ser true o false")) };
    match clave {
        "redondeo_total" => match v.as_i64() {
            Some(1 | 5 | 10 | 25 | 50 | 100) => Ok(()),
            _ => Err("El redondeo del total debe ser 1, 5, 10, 25, 50 o 100 colones".into()),
        },
        "descuento_max_pct" => match v.as_object() {
            Some(m) if m.values().all(|x| x.as_f64().is_some_and(|p| (0.0..=100.0).contains(&p))) => Ok(()),
            _ => Err("«descuento_max_pct»: un porcentaje de 0 a 100 por rol, p. ej. {\"cajero\": 10}".into()),
        },
        "caja_denominaciones" | "denominaciones_rapidas" => match v.as_array() {
            Some(l) if !l.is_empty() && l.iter().all(|x| x.as_i64().is_some_and(|n| (1..=1_000_000).contains(&n))) => Ok(()),
            _ => Err(format!("«{clave}»: una lista de montos enteros mayores que 0")),
        },
        "caja_umbral_diferencia" | "caja_salida_max_sin_pin" | "caja_quitar_linea_bitacora" => entero(0, 100_000_000),
        "caja_no_venta_umbral" => entero(0, 1000),
        "pin_min_dueno" | "pin_min_cajero" => entero(4, 12),
        "sesion_inactividad_min" => entero(1, 240),
        "permitir_vender_sin_existencia" | "venta_mostrar_existencia" | "importacion_codigos_internos" => si_no(),
        "inventario_motivos_ajuste" => match v.as_array() {
            Some(l) if !l.is_empty() && l.len() <= 30 && l.iter().all(|x| x.as_str().is_some_and(|t| !t.trim().is_empty() && t.chars().count() <= 40)) => Ok(()),
            _ => Err("Motivos de ajuste: una lista de textos cortos".into()),
        },
        // El tiquete no es comprobante fiscal: la leyenda que lo dice no puede quedar vacía.
        "texto_no_factura" => match v.as_str() {
            Some(t) if t.trim().chars().count() >= 10 => Ok(()),
            _ => Err("El aviso «no es factura electrónica» del tiquete no puede quedar vacío".into()),
        },
        "departamentos_color" => match v.as_str() {
            Some("cada_uno" | "ninguno") => Ok(()),
            Some(c) if c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit()) => Ok(()),
            _ => Err("«departamentos_color»: \"cada_uno\", \"ninguno\" o un color como \"#2563eb\"".into()),
        },
        "abrir_gaveta_efectivo" | "imprime_tiquete" | "mostrar_iva" | "caja_turno_compartido" | "caja_z_detalle_completo" | "caja_z_por_departamento" => si_no(),
        _ => Ok(()),
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
    validar(clave, v)?;
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
        for (clave, v1, v2) in [
            ("caja_turno_compartido", json!(true), json!(false)),
            ("caja_z_detalle_completo", json!(true), json!(false)),
            ("caja_z_por_departamento", json!(true), json!(false)),
            ("caja_no_venta_umbral", json!(3), json!(0)),
            ("caja_quitar_linea_bitacora", json!(2000), json!(0)),
        ] {
            assert!(guardar(&bd.pool, &cajero, clave, &v1).await.unwrap_err().contains("permiso"), "{clave}");
            guardar(&bd.pool, &dueno, clave, &v1).await.unwrap();
            guardar(&bd.pool, &tec, clave, &v2).await.unwrap();
        }
        // Valores que siembra la migración 9.
        assert!(!booleano(&bd.pool, "caja_z_por_departamento", true).await);
        assert_eq!(valor(&bd.pool, "caja_no_venta_motivos").await, Some(json!(["Cambio de billetes", "Devolución", "Otro"])));
        assert_eq!(entero(&bd.pool, "caja_umbral_diferencia", 0).await, 2000);
    }

    #[tokio::test]
    async fn valores_que_tocan_dinero_se_validan() {
        let (bd, tec, dueno, _) = base_con_usuarios().await;
        for (clave, malo) in [
            ("redondeo_total", json!(1000)),
            ("redondeo_total", json!("5")),
            ("descuento_max_pct", json!({"cajero": 150})),
            ("caja_umbral_diferencia", json!(-5)),
            ("caja_denominaciones", json!([])),
            ("caja_turno_compartido", json!("si")),
        ] {
            assert!(guardar(&bd.pool, &tec, clave, &malo).await.is_err(), "{clave} = {malo}");
        }
        guardar(&bd.pool, &tec, "redondeo_total", &json!(10)).await.unwrap();
        // Color de los departamentos: el dueño lo elige; el cajero no.
        for bueno in [json!("cada_uno"), json!("ninguno"), json!("#2563EB")] {
            guardar(&bd.pool, &dueno, "departamentos_color", &bueno).await.unwrap();
        }
        assert!(guardar(&bd.pool, &dueno, "departamentos_color", &json!("azul")).await.is_err());
        assert!(guardar(&bd.pool, &tec, "texto_no_factura", &json!("  ")).await.is_err());
        guardar(&bd.pool, &dueno, "caja_salida_max_sin_pin", &json!(30000)).await.unwrap();
        assert_eq!(entero(&bd.pool, "redondeo_total", 5).await, 10);
    }
}
