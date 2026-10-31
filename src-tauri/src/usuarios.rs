// Usuarios, PIN y autorizaciones. Toda la lógica de acceso vive aquí.

use crate::bitacora;
use crate::config;
use crate::permisos::{administrables, sin_permiso, Rol};
use crate::pin;
use crate::sesion::Actor;
use crate::util::{ahora_iso, e, normalizar, texto, ulid, Res};
use serde::Serialize;
use serde_json::json;
use sqlx::{Row, SqlitePool};

const INTENTOS_LIBRES: i64 = 4;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Usuario {
    pub id: String,
    pub nombre: String,
    pub rol: Rol,
    pub activo: bool,
    pub debe_cambiar_pin: bool,
    /// true si debe_cambiar_pin se activo por PIN mas corto que el minimo del rol;
    /// false si fue porque otro usuario asigno el PIN. Solo valido justo tras iniciar_sesion.
    #[serde(default)]
    pub pin_corto: bool,
}

fn a_usuario(f: &sqlx::sqlite::SqliteRow) -> Usuario {
    Usuario {
        id: f.get("id"),
        nombre: f.get("nombre"),
        rol: Rol::desde(&f.get::<String, _>("rol")).unwrap_or(Rol::Cajero),
        activo: f.get::<i64, _>("activo") == 1,
        debe_cambiar_pin: f.try_get::<i64, _>("debe_cambiar_pin").unwrap_or(0) == 1,
        pin_corto: false,
    }
}

/// Espera tras `intentos` fallos seguidos: libres hasta 4; luego 30 s, 1 min, 2 min… hasta 15 min.
pub fn espera_tras_fallos(intentos: i64) -> i64 {
    if intentos <= INTENTOS_LIBRES {
        return 0;
    }
    (30_000i64 * 2i64.pow((intentos - INTENTOS_LIBRES - 1).min(10) as u32)).min(15 * 60_000)
}

/// PIN mínimo según el rol (config pin_min_dueno para dueño y técnico, pin_min_cajero para cajero).
pub async fn pin_minimo(pool: &SqlitePool, rol: Rol) -> i64 {
    let (clave, defecto) = if rol == Rol::Cajero { ("pin_min_cajero", 4) } else { ("pin_min_dueno", 6) };
    config::entero(pool, clave, defecto).await.clamp(4, 12)
}

async fn validar_pin(pool: &SqlitePool, rol: Rol, p: &str) -> Res<()> {
    let min = pin_minimo(pool, rol).await;
    if !(p.chars().all(|c| c.is_ascii_digit()) && (min as usize..=12).contains(&p.len())) {
        return Err(format!("El PIN debe tener de {min} a 12 números"));
    }
    if p.chars().all(|c| c == p.chars().next().unwrap_or('0')) {
        return Err("El PIN no puede ser un mismo número repetido".into());
    }
    Ok(())
}

pub async fn listar(pool: &SqlitePool, incluir_tecnico: bool, solo_activos: bool) -> Res<Vec<Usuario>> {
    let sql = format!(
        "SELECT * FROM usuarios WHERE eliminado_en IS NULL {} {} ORDER BY CASE rol WHEN 'tecnico' THEN 0 WHEN 'dueno' THEN 1 ELSE 2 END, nombre",
        if incluir_tecnico { "" } else { "AND rol <> 'tecnico'" },
        if solo_activos { "AND activo = 1" } else { "" }
    );
    Ok(sqlx::query(&sql).fetch_all(pool).await.map_err(e)?.iter().map(a_usuario).collect())
}

async fn obtener(pool: &SqlitePool, id: &str) -> Res<Option<(Usuario, String, i64, Option<String>)>> {
    let f = sqlx::query("SELECT * FROM usuarios WHERE id = ? AND eliminado_en IS NULL").bind(id).fetch_optional(pool).await.map_err(e)?;
    Ok(f.map(|f| (a_usuario(&f), f.get("pin_hash"), f.get("intentos_fallidos"), f.get("bloqueado_hasta"))))
}

pub async fn tecnico_id(pool: &SqlitePool) -> Res<Option<String>> {
    sqlx::query_scalar("SELECT id FROM usuarios WHERE rol = 'tecnico' AND eliminado_en IS NULL LIMIT 1").fetch_optional(pool).await.map_err(e)
}

async fn validar_nombre(pool: &SqlitePool, nombre: &str, excluir: Option<&str>) -> Res<String> {
    let n = texto(nombre, 60, "el nombre", true)?;
    for u in listar(pool, true, false).await? {
        if Some(u.id.as_str()) != excluir && normalizar(&u.nombre) == normalizar(&n) {
            return Err("Ya existe un usuario con ese nombre".into());
        }
    }
    Ok(n)
}

/// Primer arranque: el técnico se crea a sí mismo (solo si no existe).
pub async fn crear_tecnico_inicial(pool: &SqlitePool, p: &str) -> Res<Usuario> {
    if tecnico_id(pool).await?.is_some() {
        return Err("El usuario técnico ya existe".into());
    }
    validar_pin(pool, Rol::Tecnico, p).await?;
    let id = ulid();
    let hash = pin::hash(p)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    sqlx::query("INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES (?, 'Técnico', 'tecnico', ?)").bind(&id).bind(&hash).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&id), "usuario.crear", "usuario", Some(&id), &json!({"rol": "tecnico", "primerArranque": true})).await?;
    tx.commit().await.map_err(e)?;
    Ok(obtener(pool, &id).await?.ok_or("Usuario no encontrado")?.0)
}

pub async fn crear(pool: &SqlitePool, a: &Actor, nombre: &str, rol: Rol, p: &str) -> Res<Usuario> {
    a.exigir("usuarios", "crear usuarios")?;
    if !administrables(a.rol).contains(&rol) {
        return Err(sin_permiso("crear ese tipo de usuario"));
    }
    let n = validar_nombre(pool, nombre, None).await?;
    validar_pin(pool, rol, p).await?;
    let id = ulid();
    let hash = pin::hash(p)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    // Lo creó otra persona: debe cambiar el PIN la primera vez que entre.
    sqlx::query("INSERT INTO usuarios (id, nombre, rol, pin_hash, debe_cambiar_pin) VALUES (?, ?, ?, ?, 1)")
        .bind(&id)
        .bind(&n)
        .bind(rol.como_str())
        .bind(&hash)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "usuario.crear", "usuario", Some(&id), &json!({"nombre": n, "rol": rol})).await?;
    tx.commit().await.map_err(e)?;
    Ok(obtener(pool, &id).await?.ok_or("Usuario no encontrado")?.0)
}

async fn administrable(pool: &SqlitePool, a: &Actor, id: &str) -> Res<Usuario> {
    let u = obtener(pool, id).await?.ok_or("Usuario no encontrado")?.0;
    if u.id != a.id && !administrables(a.rol).contains(&u.rol) {
        return Err(sin_permiso("administrar ese usuario"));
    }
    Ok(u)
}

pub async fn editar(pool: &SqlitePool, a: &Actor, id: &str, nombre: Option<&str>, activo: Option<bool>) -> Res<()> {
    let u = administrable(pool, a, id).await?;
    if activo == Some(false) && u.id == a.id {
        return Err("No puede desactivarse a sí mismo".into());
    }
    let n = match nombre {
        Some(x) => validar_nombre(pool, x, Some(id)).await?,
        None => u.nombre.clone(),
    };
    let act = activo.unwrap_or(u.activo);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    sqlx::query("UPDATE usuarios SET nombre = ?, activo = ?, actualizado_en = ? WHERE id = ?").bind(&n).bind(act as i64).bind(ahora_iso()).bind(id).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "usuario.editar", "usuario", Some(id), &json!({"antes": {"nombre": u.nombre, "activo": u.activo}, "despues": {"nombre": n, "activo": act}})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

pub async fn cambiar_pin(pool: &SqlitePool, a: &Actor, id: &str, p: &str) -> Res<()> {
    let u = administrable(pool, a, id).await?;
    validar_pin(pool, u.rol, p).await?;
    let hash = pin::hash(p)?;
    // Si lo cambia otra persona, el dueño de la cuenta debe cambiarlo de nuevo al entrar.
    let debe = (u.id != a.id) as i64;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    sqlx::query("UPDATE usuarios SET pin_hash = ?, intentos_fallidos = 0, bloqueado_hasta = NULL, debe_cambiar_pin = ?, actualizado_en = ? WHERE id = ?")
        .bind(&hash)
        .bind(debe)
        .bind(ahora_iso())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "usuario.pin", "usuario", Some(id), &json!({})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

pub async fn eliminar(pool: &SqlitePool, a: &Actor, id: &str) -> Res<()> {
    let u = administrable(pool, a, id).await?;
    if u.id == a.id {
        return Err("No puede eliminarse a sí mismo".into());
    }
    let ahora = ahora_iso();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    sqlx::query("UPDATE usuarios SET eliminado_en = ?, activo = 0, actualizado_en = ? WHERE id = ?").bind(&ahora).bind(&ahora).bind(id).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "usuario.eliminar", "usuario", Some(id), &json!({"nombre": u.nombre, "rol": u.rol})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "resultado")]
pub enum Login {
    Ok { usuario: Usuario },
    /// Sin decir si el usuario existe: siempre "PIN incorrecto" o "espere".
    Rechazado { espera_ms: i64, intentos: i64 },
}

/// Entrada con PIN, con bloqueo progresivo guardado en la base (no se reinicia cerrando la app).
pub async fn iniciar_sesion(pool: &SqlitePool, id: &str, p: &str, ahora_ms: i64) -> Res<Login> {
    let Some((u, hash, intentos, hasta)) = obtener(pool, id).await? else {
        return Ok(Login::Rechazado { espera_ms: 0, intentos: 0 });
    };
    if !u.activo {
        return Ok(Login::Rechazado { espera_ms: 0, intentos: 0 });
    }
    let hasta_ms = hasta.as_deref().and_then(|h| chrono::DateTime::parse_from_rfc3339(h).ok()).map(|d| d.timestamp_millis()).unwrap_or(0);
    if hasta_ms > ahora_ms {
        return Ok(Login::Rechazado { espera_ms: hasta_ms - ahora_ms, intentos });
    }
    if pin::verificar(p, &hash) {
        // PIN más corto que el mínimo actual del rol: debe cambiarlo ya.
        let corto = (p.len() as i64) < pin_minimo(pool, u.rol).await;
        sqlx::query("UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, debe_cambiar_pin = CASE WHEN ? THEN 1 ELSE debe_cambiar_pin END WHERE id = ?")
            .bind(corto as i64)
            .bind(id)
            .execute(pool)
            .await
            .map_err(e)?;
        let mut usuario = obtener(pool, id).await?.ok_or("Usuario no encontrado")?.0;
        usuario.pin_corto = corto; // para que el frontend explique el motivo
        return Ok(Login::Ok { usuario });
    }
    let n = intentos + 1;
    let espera = espera_tras_fallos(n);
    let hasta = (espera > 0).then(|| {
        chrono::DateTime::from_timestamp_millis(ahora_ms + espera).map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()).unwrap_or_default()
    });
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    sqlx::query("UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = ? WHERE id = ?").bind(n).bind(&hasta).bind(id).execute(&mut *tx).await.map_err(e)?;
    let accion = if espera > 0 { "login.bloqueado" } else { "login.fallido" };
    bitacora::registrar(&mut tx, Some(id), accion, "usuario", Some(id), &json!({"intentos": n, "esperaMs": espera})).await?;
    tx.commit().await.map_err(e)?;
    Ok(Login::Rechazado { espera_ms: espera, intentos: n })
}

/// Autorización del dueño EN EL MOMENTO (nunca se guarda): PIN de cualquier dueño activo.
/// Cada fallo queda en bitácora; con 5 fallos en un minuto se frena.
pub async fn autorizar_dueno(pool: &SqlitePool, p: &str, contexto: &str, actor_id: &str) -> Res<String> {
    let desde = chrono::Utc::now() - chrono::Duration::seconds(60);
    let recientes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'autorizacion.fallida' AND fecha >= ?")
        .bind(desde.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .fetch_one(pool)
        .await
        .map_err(e)?;
    if recientes >= 5 {
        return Err("Demasiados PIN incorrectos. Espere un minuto.".into());
    }
    let duenos = sqlx::query("SELECT id, pin_hash FROM usuarios WHERE rol = 'dueno' AND activo = 1 AND eliminado_en IS NULL").fetch_all(pool).await.map_err(e)?;
    for d in &duenos {
        if pin::verificar(p, &d.get::<String, _>("pin_hash")) {
            return Ok(d.get("id"));
        }
    }
    // Toda escritura en bitácora va en BEGIN IMMEDIATE: así la cadena de hashes no se bifurca.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(actor_id), "autorizacion.fallida", "usuario", None, &json!({"contexto": contexto})).await?;
    tx.commit().await.map_err(e)?;
    Err("PIN del dueño incorrecto".into())
}

/// Para acciones solo del dueño: además de ser dueño, confirma con su PIN cada vez.
pub async fn confirmar_dueno(pool: &SqlitePool, a: &Actor, p: &str, contexto: &str) -> Res<String> {
    if a.rol != Rol::Dueno {
        return Err(sin_permiso(contexto));
    }
    autorizar_dueno(pool, p, contexto, &a.id).await
}

/// Para acciones grandes del dueño o el técnico (importar el catálogo): el usuario de la sesión
/// vuelve a escribir SU PIN. Mismo freno que autorizar_dueno: cada fallo a la bitácora, 5 por minuto.
pub async fn confirmar_propio(pool: &SqlitePool, a: &Actor, p: &str, contexto: &str) -> Res<()> {
    if a.rol == Rol::Cajero {
        return Err(sin_permiso(contexto));
    }
    let desde = chrono::Utc::now() - chrono::Duration::seconds(60);
    let recientes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'autorizacion.fallida' AND fecha >= ?")
        .bind(desde.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .fetch_one(pool)
        .await
        .map_err(e)?;
    if recientes >= 5 {
        return Err("Demasiados PIN incorrectos. Espere un minuto.".into());
    }
    let hash: Option<String> = sqlx::query_scalar("SELECT pin_hash FROM usuarios WHERE id = ? AND activo = 1 AND eliminado_en IS NULL")
        .bind(&a.id)
        .fetch_optional(pool)
        .await
        .map_err(e)?;
    if hash.is_some_and(|h| pin::verificar(p, &h)) {
        return Ok(());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "autorizacion.fallida", "usuario", Some(&a.id), &json!({"contexto": contexto})).await?;
    tx.commit().await.map_err(e)?;
    Err("PIN incorrecto".into())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::bd::Bd;

    pub async fn base_con_usuarios() -> (Bd, Actor, Actor, Actor) {
        let bd = Bd::memoria().await.unwrap();
        let t = crear_tecnico_inicial(&bd.pool, "735919").await.unwrap();
        let tec = Actor { id: t.id, rol: Rol::Tecnico, nombre: "Técnico".into() };
        let d = crear(&bd.pool, &tec, "Ana", Rol::Dueno, "246813").await.unwrap();
        let c = crear(&bd.pool, &tec, "Luis", Rol::Cajero, "2580").await.unwrap();
        (
            bd,
            tec,
            Actor { id: d.id, rol: Rol::Dueno, nombre: "Ana".into() },
            Actor { id: c.id, rol: Rol::Cajero, nombre: "Luis".into() },
        )
    }

    #[tokio::test]
    async fn pin_minimo_y_cambio_obligatorio() {
        let (bd, tec, dueno, _) = base_con_usuarios().await;
        // Dueño y técnico: mínimo 6. Repetidos no.
        assert!(crear(&bd.pool, &tec, "Otro", Rol::Dueno, "1234").await.unwrap_err().contains("6"));
        assert!(crear(&bd.pool, &tec, "Otro", Rol::Dueno, "111111").await.unwrap_err().contains("repetido"));
        // Creado por otro → debe cambiar PIN; cambiándolo él mismo, ya no.
        let Login::Ok { usuario } = iniciar_sesion(&bd.pool, &dueno.id, "246813", 0).await.unwrap() else { panic!() };
        assert!(usuario.debe_cambiar_pin);
        cambiar_pin(&bd.pool, &dueno, &dueno.id, "975318").await.unwrap();
        let Login::Ok { usuario } = iniciar_sesion(&bd.pool, &dueno.id, "975318", 0).await.unwrap() else { panic!() };
        assert!(!usuario.debe_cambiar_pin);
    }

    #[tokio::test]
    async fn bloqueo_progresivo_y_bitacora() {
        let (bd, tec, _, _) = base_con_usuarios().await;
        let t0 = 1_800_000_000_000;
        for _ in 0..4 {
            assert!(matches!(iniciar_sesion(&bd.pool, &tec.id, "000000", t0).await.unwrap(), Login::Rechazado { espera_ms: 0, .. }));
        }
        assert!(matches!(iniciar_sesion(&bd.pool, &tec.id, "000000", t0).await.unwrap(), Login::Rechazado { espera_ms: 30_000, .. }));
        // Bloqueado: ni el PIN correcto entra hasta que pase la espera.
        assert!(matches!(iniciar_sesion(&bd.pool, &tec.id, "735919", t0 + 10_000).await.unwrap(), Login::Rechazado { .. }));
        assert!(matches!(iniciar_sesion(&bd.pool, &tec.id, "735919", t0 + 31_000).await.unwrap(), Login::Ok { .. }));
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion IN ('login.fallido','login.bloqueado')").fetch_one(&bd.pool).await.unwrap();
        assert_eq!(n, 5);
        // Un id inexistente responde igual que un PIN incorrecto (no revela si existe).
        assert!(matches!(iniciar_sesion(&bd.pool, "NO-EXISTE", "123456", t0).await.unwrap(), Login::Rechazado { .. }));
    }

    #[tokio::test]
    async fn cajero_no_administra_usuarios() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        assert!(crear(&bd.pool, &cajero, "X", Rol::Cajero, "8642").await.unwrap_err().contains("permiso"));
        assert!(eliminar(&bd.pool, &cajero, &dueno.id).await.unwrap_err().contains("permiso"));
        assert!(confirmar_dueno(&bd.pool, &cajero, "246813", "reabrir").await.unwrap_err().contains("permiso"));
    }
}
