// Datos del negocio: el dueño edita contacto, aviso y pie; lo legal y el logo, solo el técnico.

use crate::bitacora;
use crate::permisos::{puede, sin_permiso};
use crate::sesion::Actor;
use crate::util::{ahora_iso, e, texto, Res};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::{Row, SqlitePool};

/// campo (frontend) → (columna, permiso, largo máximo)
const CAMPOS: &[(&str, &str, &str, usize)] = &[
    ("nombreComercial", "nombre_comercial", "negocio.legal", 120),
    ("razonSocial", "razon_social", "negocio.legal", 160),
    ("cedula", "cedula", "negocio.legal", 30),
    ("direccion", "direccion", "negocio.legal", 200),
    ("regimen", "regimen", "negocio.legal", 120),
    ("telefono", "telefono", "negocio", 40),
    ("correo", "correo", "negocio", 120),
    ("encabezadoExtra", "encabezado_extra", "negocio", 600),
    ("pieTiquete", "pie_tiquete", "negocio", 600),
    ("responsableTratamiento", "responsable_tratamiento", "negocio", 160),
    ("avisoPrivacidadTexto", "aviso_privacidad_texto", "negocio", 3000),
    ("avisoPrivacidadVersion", "aviso_privacidad_version", "negocio", 20),
];

pub async fn guardar(pool: &SqlitePool, a: &Actor, cambios: &Map<String, Value>) -> Res<()> {
    let f = sqlx::query("SELECT * FROM negocio WHERE id = 1").fetch_one(pool).await.map_err(e)?;
    let mut antes = Map::new();
    let mut despues = Map::new();
    let mut sets: Vec<(&str, String)> = Vec::new();
    for (k, v) in cambios {
        let Some((_, col, perm, max)) = CAMPOS.iter().find(|c| c.0 == k) else { continue };
        let nuevo = texto(v.as_str().unwrap_or(""), *max, k, false)?;
        let actual: String = f.try_get(*col).unwrap_or_default();
        if nuevo == actual {
            continue;
        }
        if !puede(a.rol, perm) {
            return Err(sin_permiso(&format!("cambiar «{k}»")));
        }
        antes.insert(k.clone(), json!(actual));
        despues.insert(k.clone(), json!(nuevo));
        sets.push((col, nuevo));
    }
    // Cambió el aviso y nadie tocó la versión: sube sola (cada cliente queda ligado a lo que leyó).
    if despues.contains_key("avisoPrivacidadTexto") && !despues.contains_key("avisoPrivacidadVersion") {
        let v: String = f.try_get("aviso_privacidad_version").unwrap_or_default();
        if let Ok(n) = v.parse::<i64>() {
            antes.insert("avisoPrivacidadVersion".into(), json!(v));
            despues.insert("avisoPrivacidadVersion".into(), json!((n + 1).to_string()));
            sets.push(("aviso_privacidad_version", (n + 1).to_string()));
        }
    }
    if sets.is_empty() {
        return Ok(());
    }
    // Las columnas salen de la lista fija CAMPOS, nunca del frontend.
    let sql = format!("UPDATE negocio SET {}, actualizado_en = ? WHERE id = 1", sets.iter().map(|(c, _)| format!("{c} = ?")).collect::<Vec<_>>().join(", "));
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let mut q = sqlx::query(&sql);
    for (_, v) in &sets {
        q = q.bind(v.clone());
    }
    q.bind(ahora_iso()).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "negocio.cambiar", "negocio", Some("1"), &json!({"antes": antes, "despues": despues})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Logo {
    pub original: Vec<u8>,
    pub mime: String,
    pub bits: Vec<u8>,
    pub ancho: i64,
    pub alto: i64,
    pub umbral: i64,
}

pub async fn guardar_logo(pool: &SqlitePool, a: &Actor, logo: Option<Logo>) -> Res<()> {
    if !puede(a.rol, "negocio.legal") {
        return Err(sin_permiso("cambiar el logo"));
    }
    if let Some(l) = &logo {
        let bpr = (l.ancho + 7) / 8;
        if !(l.mime == "image/png" || l.mime == "image/jpeg")
            || !(8..=384).contains(&l.ancho)
            || !(1..=2000).contains(&l.alto)
            || l.bits.len() as i64 != bpr * l.alto
            || l.original.len() > 5_000_000
        {
            return Err("Logo inválido".into());
        }
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let q = sqlx::query("UPDATE negocio SET logo_original = ?, logo_mime = ?, logo_bits = ?, logo_ancho = ?, logo_alto = ?, logo_umbral = ?, actualizado_en = ? WHERE id = 1");
    let q = match &logo {
        Some(l) => q.bind(l.original.clone()).bind(l.mime.clone()).bind(l.bits.clone()).bind(l.ancho).bind(l.alto).bind(l.umbral),
        None => q.bind(None::<Vec<u8>>).bind(None::<String>).bind(None::<Vec<u8>>).bind(None::<i64>).bind(None::<i64>).bind(None::<i64>),
    };
    q.bind(ahora_iso()).execute(&mut *tx).await.map_err(e)?;
    let det = match &logo {
        Some(l) => json!({"ancho": l.ancho, "alto": l.alto, "umbral": l.umbral, "bytesOriginal": l.original.len()}),
        None => json!({"quitado": true}),
    };
    bitacora::registrar(&mut tx, Some(&a.id), "negocio.logo", "negocio", Some("1"), &det).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usuarios::tests::base_con_usuarios;

    #[tokio::test]
    async fn dueno_contacto_tecnico_legal() {
        let (bd, tec, dueno, _) = base_con_usuarios().await;
        let mut m = Map::new();
        m.insert("telefono".into(), json!("4080-7942"));
        guardar(&bd.pool, &dueno, &m).await.unwrap();
        let mut legal = Map::new();
        legal.insert("cedula".into(), json!("503210821"));
        assert!(guardar(&bd.pool, &dueno, &legal).await.unwrap_err().contains("permiso"));
        guardar(&bd.pool, &tec, &legal).await.unwrap();
        // Una clave que no existe en la lista no se usa nunca como columna.
        let mut raro = Map::new();
        raro.insert("id = 2, nombre_comercial".into(), json!("x"));
        guardar(&bd.pool, &tec, &raro).await.unwrap();
        let c: String = sqlx::query_scalar("SELECT cedula FROM negocio").fetch_one(&bd.pool).await.unwrap();
        assert_eq!(c, "503210821");
    }
}
