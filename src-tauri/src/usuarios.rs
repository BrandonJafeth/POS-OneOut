// Usuarios, PIN y autorizaciones. Toda la lógica de acceso vive aquí.

use crate::bitacora;
use crate::config;
use crate::permisos::{administrables, sin_permiso, Rol};
use crate::pin;
use crate::sesion::Actor;
use crate::util::{ahora_iso, e, texto, ulid, Res};
use serde::Serialize;
use serde_json::json;
use sqlx::{Row, SqlitePool};

const INTENTOS_LIBRES: i64 = 4;

/// Una verificación de PIN a la vez: el conteo de fallos se lee y se escribe sin que otra llamada
/// en paralelo cuele intentos gratis (leer → Argon2 → escribir no es atómico por sí solo).
static PIN_EN_CURSO: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    /// Código de recuperación del dueño: solo en la respuesta que lo crea (se muestra una vez).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codigo_recuperacion: Option<String>,
    /// Le restablecieron el PIN (con el código): la pantalla se lo dice al entrar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin_restablecido_en: Option<String>,
}

fn a_usuario(f: &sqlx::sqlite::SqliteRow) -> Usuario {
    Usuario {
        id: f.get("id"),
        nombre: f.get("nombre"),
        rol: Rol::desde(&f.get::<String, _>("rol")).unwrap_or(Rol::Cajero),
        activo: f.get::<i64, _>("activo") == 1,
        debe_cambiar_pin: f.try_get::<i64, _>("debe_cambiar_pin").unwrap_or(0) == 1,
        pin_corto: false,
        codigo_recuperacion: None,
        pin_restablecido_en: f.try_get("pin_restablecido_en").ok().flatten(),
    }
}

// ─────────── Código de recuperación del dueño (D1) ───────────

/// Sin 0/O, 1/I/L: se lee y se copia a mano sin confundir.
const ALFABETO: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/// 4 grupos de 5 (≈ 99 bits). Se imprime y se guarda en un sobre; aquí queda solo su hash.
pub fn codigo_nuevo() -> Res<String> {
    let mut out = String::with_capacity(23);
    let mut n = 0;
    while n < 20 {
        let mut b = [0u8; 32];
        getrandom::getrandom(&mut b).map_err(|err| format!("Windows no dio números al azar: {err}"))?;
        // Sin sesgo: solo bytes por debajo del múltiplo de 31 más alto.
        for x in b.into_iter().filter(|x| (*x as usize) < 248) {
            if n == 20 {
                break;
            }
            if n > 0 && n % 5 == 0 {
                out.push('-');
            }
            out.push(ALFABETO[x as usize % ALFABETO.len()] as char);
            n += 1;
        }
    }
    Ok(out)
}

/// Como se compara: mayúsculas, sin espacios ni guiones.
fn normalizar_codigo(c: &str) -> String {
    c.chars().filter(|x| x.is_ascii_alphanumeric()).map(|x| x.to_ascii_uppercase()).collect()
}

/// Pone un código nuevo al dueño (el anterior deja de servir) y lo devuelve para mostrarlo una vez.
async fn poner_codigo(c: &mut sqlx::SqliteConnection, id: &str) -> Res<String> {
    let codigo = codigo_nuevo()?;
    let hash = pin::hash(&normalizar_codigo(&codigo))?;
    sqlx::query("UPDATE usuarios SET recuperacion_hash = ? WHERE id = ?").bind(hash).bind(id).execute(c).await.map_err(e)?;
    Ok(codigo)
}

/// ¿Hay algún dueño activo con su propio PIN? Si no, es la instalación: el técnico crea o restablece.
async fn hay_dueno_con_pin(pool: &SqlitePool) -> Res<bool> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM usuarios WHERE rol = 'dueno' AND activo = 1 AND debe_cambiar_pin = 0 AND eliminado_en IS NULL").fetch_one(pool).await.map_err(e)?;
    Ok(n > 0)
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

/// Nombre limpio; que no se repita lo revisa nombre_libre dentro de la transacción.
fn validar_nombre(nombre: &str) -> Res<String> {
    texto(nombre, 60, "el nombre", true)
}

/// Primer arranque: el técnico se crea a sí mismo (solo si no existe).
pub async fn crear_tecnico_inicial(pool: &SqlitePool, p: &str) -> Res<Usuario> {
    validar_pin(pool, Rol::Tecnico, p).await?;
    let id = ulid();
    let hash = pin::hash(p)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    // Dentro de la transacción: dos llamadas a la vez no crean dos técnicos (B8).
    let ya: Option<i64> = sqlx::query_scalar("SELECT 1 FROM usuarios WHERE rol = 'tecnico' AND eliminado_en IS NULL LIMIT 1").fetch_optional(&mut *tx).await.map_err(e)?;
    if ya.is_some() {
        return Err("El usuario técnico ya existe".into());
    }
    sqlx::query("INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES (?, 'Técnico', 'tecnico', ?)").bind(&id).bind(&hash).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&id), "usuario.crear", "usuario", Some(&id), &json!({"rol": "tecnico", "primerArranque": true})).await?;
    tx.commit().await.map_err(e)?;
    Ok(obtener(pool, &id).await?.ok_or("Usuario no encontrado")?.0)
}

pub async fn crear(pool: &SqlitePool, a: &Actor, nombre: &str, rol: Rol, p: &str) -> Res<Usuario> {
    a.exigir("usuarios.administrar", "crear usuarios")?;
    if !administrables(a.rol).contains(&rol) {
        return Err(sin_permiso("crear ese tipo de usuario"));
    }
    let n = validar_nombre(nombre)?;
    validar_pin(pool, rol, p).await?;
    // D1: el técnico crea un dueño solo en la instalación (ningún dueño tiene su PIN todavía).
    if rol == Rol::Dueno && a.rol == Rol::Tecnico && hay_dueno_con_pin(pool).await? {
        return Err(sin_permiso("crear otro dueño: ya hay uno con su PIN y es él quien lo crea en Usuarios"));
    }
    let id = ulid();
    let hash = pin::hash(p)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    crate::util::nombre_libre(&mut tx, "usuarios", &n, "", "el usuario").await?;
    // Lo creó otra persona: debe cambiar el PIN la primera vez que entre.
    sqlx::query("INSERT INTO usuarios (id, nombre, rol, pin_hash, debe_cambiar_pin) VALUES (?, ?, ?, ?, 1)")
        .bind(&id)
        .bind(&n)
        .bind(rol.como_str())
        .bind(&hash)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    let codigo = if rol == Rol::Dueno { Some(poner_codigo(&mut tx, &id).await?) } else { None };
    bitacora::registrar(&mut tx, Some(&a.id), "usuario.crear", "usuario", Some(&id), &json!({"nombre": n, "rol": rol})).await?;
    tx.commit().await.map_err(e)?;
    let mut u = obtener(pool, &id).await?.ok_or("Usuario no encontrado")?.0;
    u.codigo_recuperacion = codigo;
    Ok(u)
}

/// Sin un dueño activo con su propio PIN nadie anula, autoriza descuentos, reabre la caja, restaura
/// respaldos ni confirma permisos. Un dueño con el cambio de PIN pendiente no autoriza nada todavía
/// (autorizar_dueno lo excluye): no cuenta como el que queda.
async fn no_quedar_sin_dueno(c: &mut sqlx::SqliteConnection, u: &Usuario) -> Res<()> {
    if u.rol != Rol::Dueno || !u.activo {
        return Ok(());
    }
    let otros: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM usuarios WHERE rol = 'dueno' AND activo = 1 AND debe_cambiar_pin = 0 AND eliminado_en IS NULL AND id <> ?").bind(&u.id).fetch_one(c).await.map_err(e)?;
    if otros == 0 {
        return Err(format!("{} es el único dueño activo que puede autorizar: cree otro dueño (y que entre una vez para cambiar su clave) antes. Sin dueño nadie puede anular ventas, autorizar descuentos ni reabrir la caja.", u.nombre));
    }
    Ok(())
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
    // El cajero no se cambia el nombre (saldría otro nombre en los cierres y reportes: B9).
    if u.id == a.id && a.rol == Rol::Cajero && nombre.is_some_and(|n| n.trim() != u.nombre) {
        return Err(sin_permiso("cambiarse el nombre"));
    }
    if activo == Some(false) && u.id == a.id {
        return Err("No puede desactivarse a sí mismo".into());
    }
    let n = match nombre {
        Some(x) => validar_nombre(x)?,
        None => u.nombre.clone(),
    };
    let act = activo.unwrap_or(u.activo);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    crate::util::nombre_libre(&mut tx, "usuarios", &n, id, "el usuario").await?;
    if !act {
        no_quedar_sin_dueno(&mut tx, &u).await?;
    }
    sqlx::query("UPDATE usuarios SET nombre = ?, activo = ?, actualizado_en = ? WHERE id = ?").bind(&n).bind(act as i64).bind(ahora_iso()).bind(id).execute(&mut *tx).await.map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "usuario.editar", "usuario", Some(id), &json!({"antes": {"nombre": u.nombre, "activo": u.activo}, "despues": {"nombre": n, "activo": act}})).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

/// Cambiar un PIN. El propio pide el actual (D2), salvo el cambio obligatorio (primer ingreso o
/// restablecido). El de otro dueño solo con su código de recuperación (D1), quien sea que lo use, o en
/// la instalación (ningún dueño con su PIN todavía): queda en la bitácora, debe cambiarlo al entrar,
/// el código usado deja de servir y se genera otro (se devuelve para mostrarlo una vez).
pub async fn cambiar_pin(pool: &SqlitePool, a: &Actor, id: &str, p: &str, actual: Option<&str>, codigo: Option<&str>) -> Res<Option<String>> {
    let (u, _, _, _) = obtener(pool, id).await?.ok_or("Usuario no encontrado")?;
    let propio = u.id == a.id;
    let dueno_ajeno = u.rol == Rol::Dueno && !propio;
    if !propio && !administrables(a.rol).contains(&u.rol) {
        return Err(sin_permiso("administrar ese usuario"));
    }
    if propio && !u.debe_cambiar_pin {
        confirmar_propio(pool, a, actual.unwrap_or(""), "cambiar el PIN propio").await.map_err(|_| "El PIN actual no es correcto".to_string())?;
    }
    let con_codigo = match codigo.map(normalizar_codigo).filter(|c| !c.is_empty()) {
        Some(c) if dueno_ajeno => {
            let _turno = PIN_EN_CURSO.lock().await;
            freno_autorizacion(pool, crate::util::ahora().with_timezone(&chrono::Utc)).await?;
            let h: Option<String> = sqlx::query_scalar("SELECT recuperacion_hash FROM usuarios WHERE id = ?").bind(id).fetch_one(pool).await.map_err(e)?;
            if !h.is_some_and(|h| pin::verificar(&c, &h)) {
                let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
                bitacora::registrar(&mut tx, Some(&a.id), "autorizacion.fallida", "usuario", Some(id), &json!({"contexto": "código de recuperación"})).await?;
                tx.commit().await.map_err(e)?;
                return Err("El código de recuperación no es correcto".into());
            }
            true
        }
        _ => false,
    };
    if dueno_ajeno && !con_codigo && hay_dueno_con_pin(pool).await? {
        return Err("Para restablecer el PIN de un dueño hace falta su código de recuperación.".into());
    }
    validar_pin(pool, u.rol, p).await?;
    let hash = pin::hash(p)?;
    let ahora = ahora_iso();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    // Si lo cambia otra persona, el dueño de la cuenta debe cambiarlo de nuevo al entrar.
    sqlx::query("UPDATE usuarios SET pin_hash = ?, intentos_fallidos = 0, bloqueado_hasta = NULL, debe_cambiar_pin = ?, pin_restablecido_en = ?, actualizado_en = ? WHERE id = ?")
        .bind(&hash)
        .bind(!propio as i64)
        .bind(if dueno_ajeno { Some(&ahora) } else { None })
        .bind(&ahora)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    let nuevo = if con_codigo { Some(poner_codigo(&mut tx, id).await?) } else { None };
    bitacora::registrar(&mut tx, Some(&a.id), "usuario.pin", "usuario", Some(id), &json!({"conCodigo": con_codigo})).await?;
    tx.commit().await.map_err(e)?;
    Ok(nuevo)
}

/// El dueño se hace un código de recuperación nuevo (el anterior deja de servir), con su PIN.
pub async fn codigo_recuperacion(pool: &SqlitePool, a: &Actor, actual: &str) -> Res<String> {
    if a.rol != Rol::Dueno {
        return Err(sin_permiso("tener un código de recuperación"));
    }
    confirmar_propio(pool, a, actual, "código de recuperación").await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let codigo = poner_codigo(&mut tx, &a.id).await?;
    bitacora::registrar(&mut tx, Some(&a.id), "usuario.codigo_recuperacion", "usuario", Some(&a.id), &json!({})).await?;
    tx.commit().await.map_err(e)?;
    Ok(codigo)
}

pub async fn eliminar(pool: &SqlitePool, a: &Actor, id: &str) -> Res<()> {
    let u = administrable(pool, a, id).await?;
    if u.id == a.id {
        return Err("No puede eliminarse a sí mismo".into());
    }
    let ahora = ahora_iso();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    no_quedar_sin_dueno(&mut tx, &u).await?;
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
    let _turno = PIN_EN_CURSO.lock().await;
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
/// Cada fallo queda en bitácora y frena los siguientes (freno_autorizacion).
/// Un PIN que puso otra persona (debe_cambiar_pin) no autoriza nada hasta que el dueño lo cambie.
pub async fn autorizar_dueno(pool: &SqlitePool, p: &str, contexto: &str, actor_id: &str) -> Res<String> {
    let _turno = PIN_EN_CURSO.lock().await;
    freno_autorizacion(pool, crate::util::ahora().with_timezone(&chrono::Utc)).await?;
    let duenos = sqlx::query("SELECT id, pin_hash FROM usuarios WHERE rol = 'dueno' AND activo = 1 AND debe_cambiar_pin = 0 AND eliminado_en IS NULL").fetch_all(pool).await.map_err(e)?;
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

/// Freno de los PIN de autorización (dueño o propio), con la misma escalera que el inicio de
/// sesión: 4 fallos libres en 24 h y después 30 s, 1 min, 2 min… hasta 15 min desde el último.
/// Un tope fijo por minuto dejaba probar ~7.000 PIN al día desde la pantalla de venta.
async fn freno_autorizacion(pool: &SqlitePool, ahora: chrono::DateTime<chrono::Utc>) -> Res<()> {
    let desde = (ahora - chrono::Duration::hours(24)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let f = sqlx::query("SELECT COUNT(*) AS n, MAX(fecha) AS ultima FROM bitacora WHERE accion = 'autorizacion.fallida' AND fecha >= ?")
        .bind(desde)
        .fetch_one(pool)
        .await
        .map_err(e)?;
    let ultima = f.get::<Option<String>, _>("ultima").and_then(|u| chrono::DateTime::parse_from_rfc3339(&u).ok());
    let falta = ultima.map_or(0, |u| espera_tras_fallos(f.get("n")) - (ahora - u.with_timezone(&chrono::Utc)).num_milliseconds());
    if falta > 0 {
        let s = (falta + 999) / 1000;
        let cuanto = if s < 60 { format!("{s} segundos") } else { format!("{} minutos", (s + 59) / 60) };
        return Err(format!("Demasiados PIN incorrectos. Espere {cuanto} y vuelva a intentarlo."));
    }
    Ok(())
}

/// Acciones que SIEMPRE se confirman con el PIN de un dueño (reabrir, corte, anonimizar, ajustes…):
/// quien tenga la acción (politica) y, además, el PIN de un dueño en el momento. Darle la acción a un
/// cajero no le quita el PIN.
pub async fn confirmar_dueno(pool: &SqlitePool, a: &Actor, accion: &str, p: &str, contexto: &str) -> Res<String> {
    a.exigir(accion, contexto)?;
    autorizar_dueno(pool, p, contexto, &a.id).await
}

/// Para acciones grandes del dueño o el técnico (importar el catálogo): el usuario de la sesión
/// vuelve a escribir SU PIN. Mismo freno que autorizar_dueno (freno_autorizacion).
pub async fn confirmar_propio(pool: &SqlitePool, a: &Actor, p: &str, contexto: &str) -> Res<()> {
    // Quién puede (importar el catálogo) ya lo revisó la política de la acción.
    let _ = contexto;
    let _turno = PIN_EN_CURSO.lock().await;
    freno_autorizacion(pool, crate::util::ahora().with_timezone(&chrono::Utc)).await?;
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
        let tec = Actor::nuevo(t.id, Rol::Tecnico, "Técnico");
        let d = crear(&bd.pool, &tec, "Ana", Rol::Dueno, "246813").await.unwrap();
        let c = crear(&bd.pool, &tec, "Luis", Rol::Cajero, "2580").await.unwrap();
        // Ana entra por primera vez y pone su propio PIN (si no, su PIN no autoriza nada).
        let ana = Actor::nuevo(d.id.clone(), Rol::Dueno, "Ana");
        cambiar_pin(&bd.pool, &ana, &d.id, "246813", None, None).await.unwrap();
        (
            bd,
            tec,
            ana,
            Actor::nuevo(c.id, Rol::Cajero, "Luis"),
        )
    }

    #[tokio::test]
    async fn pin_minimo_y_cambio_obligatorio() {
        let (bd, tec, ana, _) = base_con_usuarios().await;
        // Dueño y técnico: mínimo 6. Repetidos no.
        assert!(crear(&bd.pool, &tec, "Otro", Rol::Dueno, "1234").await.unwrap_err().contains("6"));
        assert!(crear(&bd.pool, &tec, "Otro", Rol::Dueno, "111111").await.unwrap_err().contains("repetido"));
        // Ya hay un dueño con su PIN: el técnico no crea otro (D1); lo crea un dueño.
        assert!(crear(&bd.pool, &tec, "Otra", Rol::Dueno, "864209").await.is_err());
        // Creado por otro → debe cambiar PIN; cambiándolo él mismo, ya no. Trae su código de recuperación.
        let o = crear(&bd.pool, &ana, "Otra", Rol::Dueno, "864209").await.unwrap();
        assert_eq!(o.codigo_recuperacion.as_deref().map(str::len), Some(23));
        let Login::Ok { usuario } = iniciar_sesion(&bd.pool, &o.id, "864209", 0).await.unwrap() else { panic!() };
        assert!(usuario.debe_cambiar_pin);
        let otra = Actor::nuevo(o.id.clone(), Rol::Dueno, "Otra");
        cambiar_pin(&bd.pool, &otra, &o.id, "975318", None, None).await.unwrap();
        let Login::Ok { usuario } = iniciar_sesion(&bd.pool, &o.id, "975318", 0).await.unwrap() else { panic!() };
        assert!(!usuario.debe_cambiar_pin);
    }

    #[tokio::test]
    async fn pin_puesto_por_el_tecnico_no_autoriza() {
        let (bd, tec, dueno, cajero) = base_con_usuarios().await;
        assert_eq!(autorizar_dueno(&bd.pool, "246813", "prueba", &cajero.id).await.unwrap(), dueno.id);
        // Sin el código de recuperación, el técnico no le cambia el PIN a la dueña (D1).
        assert!(cambiar_pin(&bd.pool, &tec, &dueno.id, "802468", None, None).await.is_err());
        assert!(cambiar_pin(&bd.pool, &tec, &dueno.id, "802468", None, Some("AAAAA-AAAAA-AAAAA-AAAAA")).await.is_err());
        // Con el código: ni el viejo ni el nuevo autorizan hasta que Ana lo cambie; el código usado ya no sirve.
        let codigo = codigo_recuperacion(&bd.pool, &dueno, "246813").await.unwrap();
        let nuevo = cambiar_pin(&bd.pool, &tec, &dueno.id, "802468", None, Some(&codigo.to_lowercase())).await.unwrap();
        assert!(nuevo.is_some_and(|n| n != codigo));
        assert!(cambiar_pin(&bd.pool, &tec, &dueno.id, "802469", None, Some(&codigo)).await.is_err());
        let Login::Ok { usuario } = iniciar_sesion(&bd.pool, &dueno.id, "802468", 0).await.unwrap() else { panic!() };
        assert!(usuario.debe_cambiar_pin && usuario.pin_restablecido_en.is_some());
        assert!(autorizar_dueno(&bd.pool, "802468", "prueba", &cajero.id).await.is_err());
        assert!(autorizar_dueno(&bd.pool, "246813", "prueba", &cajero.id).await.is_err());
        cambiar_pin(&bd.pool, &dueno, &dueno.id, "913579", None, None).await.unwrap();
        assert_eq!(autorizar_dueno(&bd.pool, "913579", "prueba", &cajero.id).await.unwrap(), dueno.id);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn intentos_en_paralelo_cuentan_todos() {
        let (bd, _, _, cajero) = base_con_usuarios().await;
        let tareas: Vec<_> = (0..6)
            .map(|_| {
                let (pool, id) = (bd.pool.clone(), cajero.id.clone());
                tokio::spawn(async move { iniciar_sesion(&pool, &id, "0000", 1_800_000_000_000).await.unwrap() })
            })
            .collect();
        for t in tareas {
            t.await.unwrap();
        }
        // 4 libres + el 5.º bloquea; el 6.º ya encuentra el bloqueo. Sin turno, todos leían 0 y quedaba en 1.
        let n: i64 = sqlx::query_scalar("SELECT intentos_fallidos FROM usuarios WHERE id = ?").bind(&cajero.id).fetch_one(&bd.pool).await.unwrap();
        assert_eq!(n, 5);
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
    async fn autorizacion_con_espera_progresiva() {
        let (bd, _, _, cajero) = base_con_usuarios().await;
        for _ in 0..5 {
            assert!(autorizar_dueno(&bd.pool, "000000", "prueba", &cajero.id).await.unwrap_err().contains("incorrecto"));
        }
        // 5 fallos: ni el PIN correcto pasa hasta que se cumpla la espera (30 s desde el último).
        assert!(autorizar_dueno(&bd.pool, "246813", "prueba", &cajero.id).await.unwrap_err().contains("Espere"));
        let luego = crate::util::ahora().with_timezone(&chrono::Utc) + chrono::Duration::seconds(31);
        assert!(freno_autorizacion(&bd.pool, luego).await.is_ok());
        assert!(freno_autorizacion(&bd.pool, luego - chrono::Duration::seconds(5)).await.is_err());
    }

    #[tokio::test]
    async fn siempre_queda_un_dueno_activo() {
        let (bd, tec, ana, _) = base_con_usuarios().await;
        assert!(editar(&bd.pool, &tec, &ana.id, None, Some(false)).await.unwrap_err().contains("único dueño"));
        assert!(eliminar(&bd.pool, &tec, &ana.id).await.unwrap_err().contains("único dueño"));
        // Otro dueño que todavía no puso su PIN no cuenta (no autoriza nada); ya con su PIN, sí.
        let otra = crear(&bd.pool, &ana, "Otra", Rol::Dueno, "864209").await.unwrap();
        assert!(editar(&bd.pool, &tec, &ana.id, None, Some(false)).await.unwrap_err().contains("único dueño"));
        cambiar_pin(&bd.pool, &Actor::nuevo(otra.id.clone(), Rol::Dueno, "Otra"), &otra.id, "864209", None, None).await.unwrap();
        editar(&bd.pool, &tec, &ana.id, None, Some(false)).await.unwrap();
    }

    #[tokio::test]
    async fn cajero_no_administra_usuarios() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        assert!(crear(&bd.pool, &cajero, "X", Rol::Cajero, "8642").await.unwrap_err().contains("permiso"));
        assert!(eliminar(&bd.pool, &cajero, &dueno.id).await.unwrap_err().contains("permiso"));
        assert!(confirmar_dueno(&bd.pool, &cajero, "caja.reabrir", "246813", "reabrir").await.unwrap_err().contains("permiso"));
    }
}
