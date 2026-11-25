// Pantalla «Permisos» y bloqueo por inactividad: guardar versiones nuevas de la configuración de
// seguridad (solo agregar), historial, volver a una anterior, autorizaciones de un solo uso y avisos
// al dueño. Las reglas fijas y el esquema los revisa politica::validar; quién puede, la política.

use crate::acciones::{self, CATALOGO};
use crate::bitacora;
use crate::permisos::{sin_permiso, Rol};
use crate::politica::{self, Datos, Inactividad};
use crate::sesion::Actor;
use crate::usuarios;
use crate::util::{e, texto, Res};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccionInfo {
    pub id: &'static str,
    pub area: &'static str,
    pub nombre: &'static str,
    pub sensible: bool,
    pub protegida: bool,
    pub no_delegable: bool,
    pub limites: u8,
    pub dueno: acciones::Politica,
    pub dueno_sigue_cajero: bool,
    pub normal_cajero: acciones::Politica,
    pub normal_tecnico: acciones::Politica,
    /// Niveles que la acción aplica (acciones::N_*): la pantalla ofrece solo esos.
    pub niveles: u8,
    pub monto_o_pin: bool,
}

pub fn catalogo() -> Vec<AccionInfo> {
    CATALOGO
        .iter()
        .map(|a| AccionInfo {
            id: a.id,
            area: a.area,
            nombre: a.nombre,
            sensible: a.sensible,
            protegida: a.protegida,
            no_delegable: a.no_delegable,
            limites: a.limites,
            dueno: a.dueno,
            dueno_sigue_cajero: a.dueno_sigue_cajero,
            normal_cajero: a.normal_cajero,
            normal_tecnico: a.normal_tecnico,
            niveles: a.niveles,
            monto_o_pin: a.monto_o_pin,
        })
        .collect()
}

/// Lo que necesita la pantalla Permisos.
pub async fn obtener(pool: &SqlitePool, a: &Actor) -> Res<Value> {
    a.exigir("seguridad.editar", "ver los permisos")?;
    let cajeros = sqlx::query("SELECT id, nombre FROM usuarios WHERE rol = 'cajero' AND eliminado_en IS NULL ORDER BY nombre").fetch_all(pool).await.map_err(e)?;
    let cajeros: Vec<Value> = cajeros.iter().map(|f| json!({"id": f.get::<String, _>("id"), "nombre": f.get::<String, _>("nombre")})).collect();
    Ok(json!({"version": a.seg.version, "datos": a.seg.datos, "catalogo": catalogo(), "cajeros": cajeros, "rotaEn": a.seg.rota_en}))
}

/// Qué da más permiso la propuesta (si no está vacío, guardar pide el PIN del dueño).
pub fn diferencias(a: &Actor, nueva: &Datos) -> Res<Vec<String>> {
    a.exigir("seguridad.editar", "editar los permisos")?;
    Ok(politica::mas_permisivo(&a.seg.datos, nueva))
}

/// Guarda una versión nueva. Valida esquema y reglas fijas; si da más permiso sobre algo sensible (o
/// sube el bloqueo de 10 min), exige el PIN de un dueño, aunque guarde el técnico o el mismo dueño.
/// `accion`: "seguridad.editar" (pantalla Permisos) o "seguridad.inactividad".
pub async fn guardar(pool: &SqlitePool, a: &Actor, accion: &str, nueva: &Datos, motivo: &str, plantilla: Option<&str>, pin: Option<&str>) -> Res<i64> {
    a.exigir(accion, "cambiar la seguridad")?;
    // Cadena alterada: lo que se agregue después no aplicaría nunca (se usa lo último sano). No se
    // guarda nada y se dice por qué (A1).
    if let Some(r) = a.seg.rota_en {
        return Err(format!("Los permisos guardados fueron alterados fuera del programa (versión {r}): no se puede guardar ningún cambio. Restaure un respaldo de antes de esa fecha o llame al técnico."));
    }
    let motivo = texto(motivo, 300, "motivo", false)?;
    if let Some(p) = plantilla
        && !matches!(p, "estricto" | "normal" | "flexible") {
            return Err("Plantilla desconocida".into());
        }
    let mut c = pool.acquire().await.map_err(e)?;
    let cajeros = politica::cajeros(&mut c).await?;
    drop(c);
    politica::validar(nueva, Some(&cajeros))?;
    let vieja = &a.seg.datos;
    if accion == "seguridad.inactividad" && (Datos { inactividad: vieja.inactividad, ..nueva.clone() }) != *vieja {
        return Err("Desde aquí solo se cambia el tiempo de bloqueo".into());
    }
    let mas = politica::mas_permisivo(vieja, nueva);
    // PIN en los argumentos o la autorización de un solo uso (seguridad_autorizar) de esta acción.
    let token = a.autorizaciones.iter().find(|x| x.accion == accion).and_then(|x| x.autorizo.clone());
    let pin_de = match pin.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => Some(usuarios::autorizar_dueno(pool, p, "cambiar permisos", &a.id).await?),
        None if token.is_some() => token,
        None if !mas.is_empty() => return Err(format!("{}:{accion}:da más permiso", politica::NECESITA_PIN)),
        None => None,
    };
    if *nueva == *vieja {
        return Ok(a.seg.version);
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    // Alguien guardó otra versión mientras tanto: que la vea antes de pisarla.
    let ultima: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(id), 0) FROM seguridad_versiones").fetch_one(&mut *tx).await.map_err(e)?;
    if ultima != a.seg.version {
        return Err("Otra persona cambió los permisos mientras tanto. Cierre y vuelva a abrir esta pantalla.".into());
    }
    let id = politica::agregar(&mut tx, Some(&a.id), pin_de.as_deref(), plantilla, &motivo, nueva).await?;
    let cambios = cambios(vieja, nueva);
    let det = json!({"version": id, "anterior": a.seg.version, "plantilla": plantilla, "motivo": motivo, "masPermiso": mas, "pinDueno": pin_de, "cambios": cambios});
    bitacora::registrar(&mut tx, Some(&a.id), "seguridad.cambiar", "seguridad", Some(&id.to_string()), &det).await?;
    if vieja.inactividad != nueva.inactividad {
        bitacora::registrar(&mut tx, Some(&a.id), "seguridad.inactividad", "seguridad", Some(&id.to_string()), &json!({"antes": vieja.inactividad, "despues": nueva.inactividad, "pinDueno": pin_de})).await?;
    }
    tx.commit().await.map_err(e)?;
    Ok(id)
}

/// Nombres de lo que cambió (para la bitácora: qué cambió, sin copiar todo el JSON).
fn cambios(v: &Datos, n: &Datos) -> Vec<String> {
    let mut out = vec![];
    for a in CATALOGO {
        if v.cajero.get(a.id) != n.cajero.get(a.id) {
            out.push(format!("cajero:{}", a.id));
        }
        if v.tecnico.get(a.id) != n.tecnico.get(a.id) {
            out.push(format!("tecnico:{}", a.id));
        }
    }
    for u in v.usuarios.keys().chain(n.usuarios.keys()) {
        if v.usuarios.get(u) != n.usuarios.get(u) {
            out.push(format!("usuario:{u}"));
        }
    }
    if v.motivos_anulacion != n.motivos_anulacion {
        out.push("motivos_anulacion".into());
    }
    if v.umbral_aviso_anulaciones != n.umbral_aviso_anulaciones {
        out.push("umbral_aviso_anulaciones".into());
    }
    if v.comprobante_anulacion_ab != n.comprobante_anulacion_ab {
        out.push("comprobante_anulacion_ab".into());
    }
    if v.ver_totales_confirmado != n.ver_totales_confirmado {
        out.push("ver_totales_confirmado".into());
    }
    if v.inactividad != n.inactividad {
        out.push("inactividad".into());
    }
    out.sort();
    out.dedup();
    out
}

/// Solo el tiempo de bloqueo (Configuración técnica).
pub async fn inactividad(pool: &SqlitePool, a: &Actor, i: &Inactividad, pin: Option<&str>) -> Res<i64> {
    politica::validar_inactividad(i)?;
    let nueva = Datos { inactividad: *i, ..a.seg.datos.clone() };
    guardar(pool, a, "seguridad.inactividad", &nueva, "Tiempo de bloqueo", None, pin).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionFila {
    pub id: i64,
    pub creada_en: String,
    pub creada_por: Option<String>,
    pub pin_dueno: bool,
    pub plantilla: Option<String>,
    pub motivo: String,
}

pub async fn historial(pool: &SqlitePool, a: &Actor) -> Res<Vec<VersionFila>> {
    a.exigir("seguridad.editar", "ver el historial de permisos")?;
    let filas = sqlx::query("SELECT v.id, v.creada_en, u.nombre, v.pin_dueno_de, v.plantilla, v.motivo FROM seguridad_versiones v LEFT JOIN usuarios u ON u.id = v.creada_por ORDER BY v.id DESC LIMIT 500")
        .fetch_all(pool)
        .await
        .map_err(e)?;
    Ok(filas
        .iter()
        .map(|f| VersionFila { id: f.get("id"), creada_en: f.get("creada_en"), creada_por: f.get("nombre"), pin_dueno: f.get::<Option<String>, _>("pin_dueno_de").is_some(), plantilla: f.get("plantilla"), motivo: f.get("motivo") })
        .collect())
}

/// Los datos de una versión de la cadena sana (las de después de un eslabón roto no se leen).
pub async fn version(pool: &SqlitePool, a: &Actor, id: i64) -> Res<Datos> {
    a.exigir("seguridad.editar", "ver el historial de permisos")?;
    if a.seg.rota_en.is_some_and(|r| id >= r) {
        return Err("Esa versión está después de un cambio alterado: no se puede usar".into());
    }
    let datos: Option<String> = sqlx::query_scalar("SELECT datos FROM seguridad_versiones WHERE id = ?").bind(id).fetch_optional(pool).await.map_err(e)?;
    let mut d: Datos = serde_json::from_str(&datos.ok_or("Versión no encontrada")?).map_err(|_| "Esa versión no se puede leer".to_string())?;
    politica::sin_desconocidas(&mut d);
    politica::validar(&d, None).map_err(|err| format!("Esa versión no se puede usar con este programa: {err}"))?;
    Ok(d)
}

/// Volver a una versión anterior: crea una NUEVA con sus datos (el historial no se reescribe).
/// Siempre con el PIN del dueño. Las excepciones de usuarios que ya no son cajeros se quitan.
pub async fn volver(pool: &SqlitePool, a: &Actor, id: i64, motivo: &str, pin: &str) -> Res<i64> {
    let mut d = version(pool, a, id).await?;
    let token = a.autorizaciones.iter().find(|x| x.accion == "seguridad.editar").and_then(|x| x.autorizo.clone());
    if pin.trim().is_empty() && token.is_none() {
        return Err(format!("{}:seguridad.editar:volver a una versión", politica::NECESITA_PIN));
    }
    let mut c = pool.acquire().await.map_err(e)?;
    let cajeros = politica::cajeros(&mut c).await?;
    drop(c);
    d.usuarios.retain(|u, _| cajeros.contains(u));
    let motivo = format!("Vuelve a la versión {id}. {}", motivo.trim());
    // Volver siempre lleva el PIN de un dueño, aunque no dé más permiso.
    let pin_de = match pin.trim() {
        "" => token,
        p => Some(usuarios::autorizar_dueno(pool, p, "volver a una versión de permisos", &a.id).await?),
    };
    let a2 = Actor { autorizaciones: vec![crate::sesion::Autorizacion { accion: "seguridad.editar".into(), comando: "seguridad_volver".into(), autorizo: pin_de, motivo: None, vence: crate::util::ahora() + chrono::Duration::minutes(1) }], ..a.clone() };
    guardar(pool, &a2, "seguridad.editar", &d, &motivo, None, None).await
}

/// Autorización de un solo uso para una acción con «PIN» o «motivo» (la usa el siguiente comando).
pub async fn autorizar(pool: &SqlitePool, a: &Actor, accion: &str, pin: Option<&str>, motivo: Option<&str>) -> Res<(Option<String>, Option<String>)> {
    let ac = acciones::buscar(accion).ok_or("Acción desconocida")?;
    if a.politica(accion).nivel == acciones::Nivel::No {
        return Err(sin_permiso(&ac.nombre.to_lowercase()));
    }
    let autorizo = match pin.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => Some(usuarios::autorizar_dueno(pool, p, ac.nombre, &a.id).await?),
        None => None,
    };
    let motivo = match motivo.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) if m.chars().count() >= 3 => Some(texto(m, 300, "motivo", true)?),
        Some(_) => return Err("Escriba el motivo".into()),
        None => None,
    };
    Ok((autorizo, motivo))
}

/// Avisos para el dueño al entrar: anulaciones sin PIN desde la última vez que las vio y si la
/// cadena de permisos estaba alterada.
pub async fn avisos(pool: &SqlitePool, a: &Actor) -> Res<Value> {
    if a.rol != Rol::Dueno {
        return Ok(json!({"anulacionesSinPin": 0, "seguridadAlterada": false, "umbral": a.seg.datos.umbral_aviso_anulaciones}));
    }
    let desde: Option<String> = sqlx::query_scalar("SELECT MAX(fecha) FROM bitacora WHERE accion = 'aviso.anulaciones_visto'").fetch_one(pool).await.map_err(e)?;
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ventas WHERE anulada_politica = 'C' AND anulada_por = anulada_actor AND anulada_en > ?")
        .bind(desde.unwrap_or_default())
        .fetch_one(pool)
        .await
        .map_err(e)?;
    Ok(json!({"anulacionesSinPin": n, "seguridadAlterada": a.seg.rota_en.is_some(), "umbral": a.seg.datos.umbral_aviso_anulaciones}))
}

pub async fn anulaciones_vistas(pool: &SqlitePool, a: &Actor) -> Res<()> {
    if a.rol != Rol::Dueno {
        return Err(sin_permiso("marcar el aviso"));
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "aviso.anulaciones_visto", "aviso", None, &json!({})).await?;
    tx.commit().await.map_err(e)
}
