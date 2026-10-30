mod bd;
mod bitacora;
mod caja;
mod calculo;
mod clave;
mod clientes;
mod config;
mod negocio;
mod permisos;
mod pin;
mod printer;
mod respaldo;
mod sesion;
mod usuarios;
mod util;
mod ventas;

// Comandos que el frontend puede llamar con `invoke(...)`.
// Regla: el usuario SIEMPRE sale de la sesión guardada en Rust (nunca de un parámetro), y cada
// módulo revisa su permiso. Son `async`: Tauri los corre fuera del hilo de la ventana.

use bd::{Bd, Op};
use permisos::Rol;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sesion::{Actor, Sesion};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};
use util::Res;

struct App {
    bd: Result<Bd, String>,
    clave: Option<[u8; 32]>,
    sesion: Sesion,
    /// El usuario entró con un PIN que debe cambiar: hasta hacerlo, no puede hacer otra cosa.
    debe_cambiar_pin: AtomicBool,
}

impl App {
    fn bd(&self) -> Res<&Bd> {
        self.bd.as_ref().map_err(|e| e.clone())
    }
    fn pool(&self) -> Res<&sqlx::SqlitePool> {
        Ok(&self.bd()?.pool)
    }
    async fn actor(&self) -> Res<Actor> {
        let a = self.sesion.actor().await?;
        if self.debe_cambiar_pin.load(Ordering::SeqCst) {
            return Err("DEBE_CAMBIAR_PIN".into());
        }
        Ok(a)
    }
}

type St<'a> = State<'a, App>;

// ─────────── Sistema y sesión ───────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EstadoSistema {
    error: Option<String>,
    necesita_tecnico: bool,
    cifrada: bool,
    /// Lo que la pantalla de entrada muestra antes de que haya sesión.
    nombre_negocio: String,
    tema: Value,
    color_acento: Value,
    carpeta: String,
}

#[tauri::command]
async fn sistema_estado(st: St<'_>) -> Res<EstadoSistema> {
    match &st.bd {
        Err(err) => Ok(EstadoSistema { error: Some(err.clone()), necesita_tecnico: false, cifrada: false, nombre_negocio: String::new(), tema: Value::Null, color_acento: Value::Null, carpeta: String::new() }),
        Ok(b) => {
            let nombre: Option<String> = sqlx::query_scalar("SELECT nombre_comercial FROM negocio WHERE id = 1").fetch_optional(&b.pool).await.map_err(util::e)?;
            Ok(EstadoSistema {
                error: None,
                necesita_tecnico: usuarios::tecnico_id(&b.pool).await?.is_none(),
                cifrada: b.cifrada,
                nombre_negocio: nombre.unwrap_or_default(),
                tema: config::valor(&b.pool, "tema").await.unwrap_or(Value::Null),
                color_acento: config::valor(&b.pool, "color_acento").await.unwrap_or(Value::Null),
                carpeta: b.dir.as_ref().map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
            })
        }
    }
}

/// Primer arranque: crea el técnico. Solo funciona si todavía no existe ninguno.
#[tauri::command]
async fn sistema_crear_tecnico(st: St<'_>, pin: String) -> Res<()> {
    usuarios::crear_tecnico_inicial(st.pool()?, &pin).await.map(|_| ())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SesionInfo {
    id: String,
    nombre: String,
    rol: Rol,
    debe_cambiar_pin: bool,
}

/// Usuarios para la pantalla de entrada (sin el técnico, que tiene entrada aparte).
#[tauri::command]
async fn sesion_usuarios(st: St<'_>) -> Res<Vec<Value>> {
    let l = usuarios::listar(st.pool()?, false, true).await?;
    Ok(l.into_iter().map(|u| json!({"id": u.id, "nombre": u.nombre, "rol": u.rol})).collect())
}

async fn entrar(st: &App, id: &str, pin: &str) -> Res<Value> {
    let pool = st.pool()?;
    let ahora = chrono::Utc::now().timestamp_millis();
    match usuarios::iniciar_sesion(pool, id, pin, ahora).await? {
        usuarios::Login::Ok { usuario } => {
            let minutos = config::entero(pool, "sesion_inactividad_min", 10).await;
            st.sesion.iniciar(Actor { id: usuario.id.clone(), rol: usuario.rol, nombre: usuario.nombre.clone() }, minutos).await;
            st.debe_cambiar_pin.store(usuario.debe_cambiar_pin, Ordering::SeqCst);
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(util::e)?;
            bitacora::registrar(&mut tx, Some(&usuario.id), "login.ok", "usuario", Some(&usuario.id), &json!({})).await?;
            tx.commit().await.map_err(util::e)?;
            Ok(json!({"resultado": "ok", "usuario": SesionInfo { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol, debe_cambiar_pin: usuario.debe_cambiar_pin }, "minutosInactividad": minutos}))
        }
        r => serde_json::to_value(r).map_err(util::e),
    }
}

#[tauri::command]
async fn sesion_iniciar(st: St<'_>, usuario_id: String, pin: String) -> Res<Value> {
    entrar(&st, &usuario_id, &pin).await
}

/// Entrada oculta del técnico (no aparece en la lista).
#[tauri::command]
async fn sesion_tecnico(st: St<'_>, pin: String) -> Res<Value> {
    let id = usuarios::tecnico_id(st.pool()?).await?.unwrap_or_default();
    entrar(&st, &id, &pin).await
}

/// Sesión vigente (al recargar la ventana), sin renovar el plazo.
#[tauri::command]
async fn sesion_actual(st: St<'_>) -> Res<Option<SesionInfo>> {
    Ok(st.sesion.vigente().await.map(|a| SesionInfo { id: a.id, nombre: a.nombre, rol: a.rol, debe_cambiar_pin: st.debe_cambiar_pin.load(Ordering::SeqCst) }))
}

#[tauri::command]
async fn sesion_cerrar(st: St<'_>) -> Res<()> {
    st.sesion.cerrar().await;
    st.debe_cambiar_pin.store(false, Ordering::SeqCst);
    Ok(())
}

/// La pantalla avisa que hubo actividad (teclado/ratón); renueva el plazo de inactividad.
#[tauri::command]
async fn sesion_tocar(st: St<'_>) -> Res<()> {
    st.sesion.actor().await.map(|_| ())
}

// ─────────── Base: lectura restringida y catálogo por nombre ───────────

#[tauri::command]
async fn bd_leer(st: St<'_>, sql: String, params: Vec<Value>) -> Res<Vec<Map<String, Value>>> {
    st.actor().await?;
    st.bd()?.leer(&sql, &params).await
}

#[tauri::command]
async fn bd_lote(st: St<'_>, ops: Vec<Op>) -> Res<Vec<Value>> {
    let a = st.actor().await?;
    st.bd()?.lote(&a, &ops).await
}

// ─────────── Usuarios ───────────

#[tauri::command]
async fn usuarios_listar(st: St<'_>) -> Res<Vec<usuarios::Usuario>> {
    let a = st.actor().await?;
    a.exigir("usuarios", "ver usuarios")?;
    usuarios::listar(st.pool()?, a.rol == Rol::Tecnico, false).await
}

#[tauri::command]
async fn usuarios_crear(st: St<'_>, nombre: String, rol: Rol, pin: String) -> Res<usuarios::Usuario> {
    let a = st.actor().await?;
    usuarios::crear(st.pool()?, &a, &nombre, rol, &pin).await
}

#[tauri::command]
async fn usuarios_editar(st: St<'_>, id: String, nombre: Option<String>, activo: Option<bool>) -> Res<()> {
    let a = st.actor().await?;
    usuarios::editar(st.pool()?, &a, &id, nombre.as_deref(), activo).await
}

/// También sirve con un cambio de PIN pendiente (es lo único que se puede hacer en ese estado).
#[tauri::command]
async fn usuarios_cambiar_pin(st: St<'_>, id: String, pin: String) -> Res<()> {
    let a = st.sesion.actor().await?;
    if st.debe_cambiar_pin.load(Ordering::SeqCst) && id != a.id {
        return Err("DEBE_CAMBIAR_PIN".into());
    }
    usuarios::cambiar_pin(st.pool()?, &a, &id, &pin).await?;
    if id == a.id {
        st.debe_cambiar_pin.store(false, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
async fn usuarios_eliminar(st: St<'_>, id: String) -> Res<()> {
    let a = st.actor().await?;
    usuarios::eliminar(st.pool()?, &a, &id).await
}

// ─────────── Configuración, negocio, bitácora ───────────

#[tauri::command]
async fn config_guardar(st: St<'_>, clave: String, valor: Value) -> Res<()> {
    let a = st.actor().await?;
    config::guardar(st.pool()?, &a, &clave, &valor).await
}

#[tauri::command]
async fn negocio_guardar(st: St<'_>, cambios: Map<String, Value>) -> Res<()> {
    let a = st.actor().await?;
    negocio::guardar(st.pool()?, &a, &cambios).await
}

#[tauri::command]
async fn negocio_logo(st: St<'_>, logo: Option<negocio::Logo>) -> Res<()> {
    let a = st.actor().await?;
    negocio::guardar_logo(st.pool()?, &a, logo).await
}

#[tauri::command]
async fn bitacora_listar(st: St<'_>, limite: i64, entidad: Option<String>) -> Res<Vec<bitacora::Entrada>> {
    let a = st.actor().await?;
    a.exigir("reportes", "ver la bitácora")?;
    bitacora::listar(st.pool()?, limite.clamp(1, 2000), entidad.as_deref()).await
}

#[tauri::command]
async fn bitacora_verificar(st: St<'_>) -> Res<bitacora::Verificacion> {
    let a = st.actor().await?;
    a.exigir("reportes", "verificar la bitácora")?;
    bitacora::verificar(st.pool()?).await
}

// ─────────── Caja ───────────

#[tauri::command]
async fn caja_estado(st: St<'_>) -> Res<caja::EstadoCaja> {
    let a = st.actor().await?;
    caja::estado(st.pool()?, &a, caja::CAJA_1).await
}

#[tauri::command]
async fn caja_abrir(st: St<'_>, conteo: caja::Conteo) -> Res<caja::Turno> {
    let a = st.actor().await?;
    caja::abrir(st.pool()?, &a, caja::CAJA_1, &conteo).await
}

#[tauri::command]
async fn caja_movimiento(st: St<'_>, movimiento: caja::NuevoMovimiento, pin_dueno: Option<String>) -> Res<String> {
    let a = st.actor().await?;
    caja::movimiento(st.pool()?, &a, caja::CAJA_1, &movimiento, pin_dueno.as_deref()).await
}

#[tauri::command]
async fn caja_detalle(st: St<'_>, turno_id: String) -> Res<caja::Detalle> {
    let a = st.actor().await?;
    caja::detalle(st.pool()?, &a, &turno_id).await
}

#[tauri::command]
async fn caja_necesita_nota(st: St<'_>, conteo: caja::Conteo) -> Res<bool> {
    let a = st.actor().await?;
    caja::necesita_nota(st.pool()?, &a, caja::CAJA_1, &conteo).await
}

#[tauri::command]
async fn caja_cerrar(st: St<'_>, conteo: caja::Conteo, nota: String) -> Res<caja::ResultadoCierre> {
    let a = st.actor().await?;
    caja::cerrar(st.pool()?, &a, caja::CAJA_1, &conteo, &nota).await
}

#[tauri::command]
async fn caja_reabrir(st: St<'_>, turno_id: String, pin: String, motivo: String) -> Res<()> {
    let a = st.actor().await?;
    caja::reabrir(st.pool()?, &a, &turno_id, &pin, &motivo).await
}

#[tauri::command]
async fn caja_revisada(st: St<'_>, turno_id: String) -> Res<()> {
    let a = st.actor().await?;
    caja::marcar_revisada(st.pool()?, &a, &turno_id).await
}

#[tauri::command]
async fn caja_z(st: St<'_>, turno_id: String) -> Res<Value> {
    let a = st.actor().await?;
    let (d, copia) = caja::imprimir_z(st.pool()?, &a, &turno_id).await?;
    Ok(json!({"detalle": d, "copia": copia}))
}

#[tauri::command]
async fn caja_turnos(st: St<'_>, desde: String, hasta: String) -> Res<Vec<caja::TurnoFila>> {
    let a = st.actor().await?;
    caja::listar(st.pool()?, &a, caja::CAJA_1, &desde, &hasta).await
}

// ─────────── Ventas ───────────

#[tauri::command]
async fn venta_esperas(st: St<'_>) -> Res<Vec<ventas::Espera>> {
    let a = st.actor().await?;
    ventas::listar_esperas(st.pool()?, &a, caja::CAJA_1).await
}

#[tauri::command]
async fn venta_espera_crear(st: St<'_>, estado: calculo::Estado) -> Res<ventas::Espera> {
    let a = st.actor().await?;
    ventas::crear_espera(st.pool()?, &a, caja::CAJA_1, &estado).await
}

#[tauri::command]
async fn venta_espera_guardar(st: St<'_>, id: String, estado: calculo::Estado) -> Res<()> {
    let a = st.actor().await?;
    ventas::guardar_espera(st.pool()?, &a, &id, &estado).await
}

#[tauri::command]
async fn venta_espera_descartar(st: St<'_>, id: String) -> Res<()> {
    let a = st.actor().await?;
    ventas::descartar_espera(st.pool()?, &a, &id).await
}

#[tauri::command]
async fn venta_autorizar_descuento(st: St<'_>, espera_id: String, pct: f64, pin: String) -> Res<ventas::AutorizacionEmitida> {
    let a = st.actor().await?;
    ventas::autorizar_descuento(st.pool()?, &a, &espera_id, pct, &pin).await
}

#[tauri::command]
async fn venta_cobrar(st: St<'_>, espera_id: String, estado: calculo::Estado, pagos: Vec<calculo::PagoEntrada>) -> Res<ventas::ResultadoCobro> {
    let a = st.actor().await?;
    ventas::cobrar(st.pool()?, &a, caja::CAJA_1, &espera_id, &estado, &pagos).await
}

#[tauri::command]
async fn venta_obtener(st: St<'_>, id: String) -> Res<Option<Value>> {
    let a = st.actor().await?;
    ventas::obtener(st.pool()?, &a, &id).await
}

#[tauri::command]
async fn venta_listar_dia(st: St<'_>, dia: String) -> Res<Vec<ventas::VentaResumen>> {
    let a = st.actor().await?;
    ventas::listar_dia(st.pool()?, &a, caja::CAJA_1, &dia).await
}

#[tauri::command]
async fn venta_reimpresion(st: St<'_>, venta_id: String) -> Res<()> {
    let a = st.actor().await?;
    ventas::registrar_reimpresion(st.pool()?, &a, &venta_id).await
}

#[tauri::command]
async fn venta_correcciones(st: St<'_>, venta_id: String) -> Res<Vec<Value>> {
    let a = st.actor().await?;
    ventas::correcciones_de(st.pool()?, &a, &venta_id).await
}

#[tauri::command]
async fn venta_corregir_pago(st: St<'_>, pago_id: String, cambio: ventas::CambioPago, motivo: String, pin_dueno: Option<String>) -> Res<()> {
    let a = st.actor().await?;
    ventas::corregir_pago(st.pool()?, &a, caja::CAJA_1, &pago_id, &cambio, &motivo, pin_dueno.as_deref()).await
}

#[tauri::command]
async fn venta_anular(st: St<'_>, venta_id: String, pin: String, motivo: String, devolucion_efectivo: i64) -> Res<()> {
    let a = st.actor().await?;
    ventas::anular(st.pool()?, &a, caja::CAJA_1, &venta_id, &pin, &motivo, devolucion_efectivo).await
}

#[tauri::command]
async fn venta_pendientes_factura(st: St<'_>) -> Res<Vec<Value>> {
    let a = st.actor().await?;
    ventas::pendientes_factura(st.pool()?, &a).await
}

#[tauri::command]
async fn venta_marcar_factura(st: St<'_>, venta_id: String, referencia: String) -> Res<()> {
    let a = st.actor().await?;
    ventas::marcar_factura(st.pool()?, &a, &venta_id, &referencia).await
}

// ─────────── Clientes ───────────

#[tauri::command]
async fn cliente_crear(st: St<'_>, datos: clientes::Datos, consentimiento: bool, version_aviso: String) -> Res<clientes::Basico> {
    let a = st.actor().await?;
    clientes::crear(st.pool()?, &a, &datos, consentimiento, &version_aviso).await
}

#[tauri::command]
async fn cliente_buscar(st: St<'_>, texto: String, limite: Option<i64>) -> Res<Vec<clientes::Basico>> {
    let a = st.actor().await?;
    clientes::buscar_basico(st.pool()?, &a, &texto, limite.unwrap_or(15)).await
}

#[tauri::command]
async fn cliente_basico(st: St<'_>, id: String) -> Res<Option<clientes::Basico>> {
    let a = st.actor().await?;
    clientes::basico(st.pool()?, &a, &id).await
}

#[tauri::command]
async fn cliente_dato_factura(st: St<'_>, id: String, campo: String) -> Res<Option<String>> {
    let a = st.actor().await?;
    clientes::dato_para_factura(st.pool()?, &a, &id, &campo).await
}

#[tauri::command]
async fn cliente_tiene_correo(st: St<'_>, id: String) -> Res<bool> {
    let a = st.actor().await?;
    clientes::tiene_correo(st.pool()?, &a, &id).await
}

#[tauri::command]
async fn cliente_listar(st: St<'_>, texto: Option<String>, incluir_anonimizados: Option<bool>) -> Res<Vec<Value>> {
    let a = st.actor().await?;
    clientes::listar(st.pool()?, &a, texto.as_deref().unwrap_or(""), incluir_anonimizados.unwrap_or(false)).await
}

#[tauri::command]
async fn cliente_obtener(st: St<'_>, id: String) -> Res<Option<Value>> {
    let a = st.actor().await?;
    clientes::obtener(st.pool()?, &a, &id).await
}

#[tauri::command]
async fn cliente_editar(st: St<'_>, id: String, datos: clientes::Datos) -> Res<()> {
    let a = st.actor().await?;
    clientes::editar(st.pool()?, &a, &id, &datos).await
}

#[tauri::command]
async fn cliente_cuentas_saldo(st: St<'_>, id: String) -> Res<Vec<Map<String, Value>>> {
    let a = st.actor().await?;
    clientes::cuentas_con_saldo(st.pool()?, &a, &id).await
}

#[tauri::command]
async fn cliente_exportar(st: St<'_>, id: String, formato: String) -> Res<Value> {
    let a = st.actor().await?;
    clientes::para_exportar(st.pool()?, &a, &id, &formato).await
}

#[tauri::command]
async fn cliente_anonimizar(st: St<'_>, id: String, pin: String, motivo: String) -> Res<()> {
    let a = st.actor().await?;
    clientes::anonimizar(st.pool()?, &a, &id, &pin, &motivo).await
}

#[tauri::command]
async fn cliente_retencion(st: St<'_>) -> Res<Vec<clientes::Basico>> {
    let a = st.actor().await?;
    clientes::sugerencias_retencion(st.pool()?, &a).await
}

// ─────────── Respaldo ───────────

#[tauri::command]
async fn respaldo_crear(st: St<'_>, contrasena: String) -> Res<String> {
    let a = st.actor().await?;
    respaldo::crear(st.bd()?, &a, &contrasena).await
}

/// El archivo llega como bytes desde un <input type="file">: la ventana no necesita acceso al disco.
#[tauri::command]
async fn respaldo_restaurar(st: St<'_>, pin: String, archivo: Vec<u8>, contrasena: String) -> Res<()> {
    let a = st.actor().await?;
    respaldo::restaurar(st.bd()?, &a, &pin, &archivo, &contrasena, st.clave.as_ref()).await
}

#[tauri::command]
async fn app_reiniciar(app: tauri::AppHandle) -> Res<()> {
    app.restart();
}

// ─────────── Impresora ───────────

/// Nombres de las impresoras instaladas en Windows.
#[tauri::command]
async fn list_printers(st: St<'_>) -> Res<Vec<String>> {
    st.actor().await?;
    printer::list_printers()
}

/// Manda `data` tal cual (RAW) a la impresora. Ok = el spooler aceptó el trabajo.
#[tauri::command]
async fn print_raw(st: St<'_>, printer_name: String, data: Vec<u8>) -> Res<()> {
    st.actor().await?;
    if data.len() > 2_000_000 {
        return Err("Trabajo de impresión demasiado grande".into());
    }
    printer::print_raw(&printer_name, &data)
}

/// Abre la base al arrancar. Errores no tumban la app: la pantalla los muestra (sistema_estado).
async fn preparar(dir: &std::path::Path) -> (Result<Bd, String>, Option<[u8; 32]>) {
    if let Err(err) = respaldo::aplicar_restauracion_pendiente(dir) {
        return (Err(format!("No se pudo aplicar la restauración: {err}")), None);
    }
    let clave = if cfg!(feature = "cifrado") {
        match clave::obtener(dir) {
            Ok(k) => Some(k),
            Err(err) => return (Err(err), None),
        }
    } else {
        None
    };
    (Bd::abrir(dir, clave).await, clave)
}

/// Solo se navega dentro de la app (nada de sitios externos ni ventanas nuevas).
fn url_propia(u: &tauri::Url) -> bool {
    match u.scheme() {
        // blob: = descargas que arma la propia app (exportar datos del cliente).
        "tauri" | "blob" => true,
        "http" | "https" => u.host_str() == Some("tauri.localhost") || (cfg!(debug_assertions) && u.host_str() == Some("localhost") && u.port() == Some(1420)),
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let (bd, clave) = tauri::async_runtime::block_on(preparar(&dir));
            // Revisión periódica de integridad (además de la del arranque).
            if let Ok(b) = &bd {
                let pool = b.pool.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
                        let r: Result<String, _> = sqlx::query_scalar("PRAGMA quick_check").fetch_one(&pool).await;
                        if !matches!(r.as_deref(), Ok("ok")) {
                            if let Ok(mut tx) = pool.begin_with("BEGIN IMMEDIATE").await {
                                if bitacora::registrar(&mut tx, None, "bd.integridad_fallida", "bd", None, &json!({})).await.is_ok() {
                                    let _ = tx.commit().await;
                                }
                            }
                        }
                    }
                });
            }
            app.manage(App { bd, clave, sesion: Sesion::default(), debe_cambiar_pin: AtomicBool::new(false) });
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Punto de Venta")
                .inner_size(1280.0, 800.0)
                .min_inner_size(1024.0, 640.0)
                .center()
                .devtools(cfg!(debug_assertions))
                .on_navigation(url_propia)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sistema_estado,
            sistema_crear_tecnico,
            sesion_usuarios,
            sesion_iniciar,
            sesion_tecnico,
            sesion_actual,
            sesion_cerrar,
            sesion_tocar,
            bd_leer,
            bd_lote,
            usuarios_listar,
            usuarios_crear,
            usuarios_editar,
            usuarios_cambiar_pin,
            usuarios_eliminar,
            config_guardar,
            negocio_guardar,
            negocio_logo,
            bitacora_listar,
            bitacora_verificar,
            caja_estado,
            caja_abrir,
            caja_movimiento,
            caja_detalle,
            caja_necesita_nota,
            caja_cerrar,
            caja_reabrir,
            caja_revisada,
            caja_z,
            caja_turnos,
            venta_esperas,
            venta_espera_crear,
            venta_espera_guardar,
            venta_espera_descartar,
            venta_autorizar_descuento,
            venta_cobrar,
            venta_obtener,
            venta_listar_dia,
            venta_reimpresion,
            venta_correcciones,
            venta_corregir_pago,
            venta_anular,
            venta_pendientes_factura,
            venta_marcar_factura,
            cliente_crear,
            cliente_buscar,
            cliente_basico,
            cliente_dato_factura,
            cliente_tiene_correo,
            cliente_listar,
            cliente_obtener,
            cliente_editar,
            cliente_cuentas_saldo,
            cliente_exportar,
            cliente_anonimizar,
            cliente_retencion,
            respaldo_crear,
            respaldo_restaurar,
            app_reiniciar,
            list_printers,
            print_raw,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicación Tauri");
}
