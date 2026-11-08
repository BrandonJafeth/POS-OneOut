#![recursion_limit = "256"]
mod bd;
mod bitacora;
mod caja;
mod calculo;
mod clave;
mod clientes;
mod config;
mod desglose;
mod escpos;
mod estadisticas;
mod gaveta;
mod importacion;
mod impresoras;
mod inventario;
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
    let a = st.actor().await?;
    st.bd()?.leer(&a, &sql, &params).await
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

/// Datos del Z de un turno cerrado y si la próxima impresión sale como COPIA.
#[tauri::command]
async fn caja_z(st: St<'_>, turno_id: String) -> Res<Value> {
    let a = st.actor().await?;
    let (d, copia) = caja::datos_z(st.pool()?, &a, &turno_id).await?;
    Ok(json!({"detalle": d, "copia": copia}))
}

/// Imprime el Z (y los tiquetes por departamento) en la impresora de cierres. COPIA = PIN del dueño.
#[tauri::command]
async fn caja_z_imprimir(st: St<'_>, turno_id: String, documentos: Vec<Vec<u8>>, pin: Option<String>) -> Res<bool> {
    let a = st.actor().await?;
    caja::imprimir_z(st.pool()?, &a, &turno_id, &documentos, pin.as_deref()).await
}

#[tauri::command]
async fn caja_nota_cierre(st: St<'_>, turno_id: String, nota: String) -> Res<()> {
    let a = st.actor().await?;
    caja::nota_cierre(st.pool()?, &a, &turno_id, &nota).await
}

#[tauri::command]
async fn caja_corte(st: St<'_>, retiro: Option<caja::Retiro>, pin: Option<String>) -> Res<caja::Corte> {
    let a = st.actor().await?;
    caja::corte(st.pool()?, &a, caja::CAJA_1, retiro.as_ref(), pin.as_deref()).await
}

// ─────────── Gaveta (solo tres caminos: venta con efectivo, "no venta" con motivo, orden del dueño) ───────────

#[tauri::command]
async fn gaveta_venta(st: St<'_>, venta_id: String) -> Res<()> {
    let a = st.actor().await?;
    gaveta::por_venta(st.pool()?, &a, &venta_id).await
}

#[tauri::command]
async fn gaveta_no_venta(st: St<'_>, motivo: String, nota: String) -> Res<()> {
    let a = st.actor().await?;
    gaveta::no_venta(st.pool()?, &a, caja::CAJA_1, &motivo, &nota).await
}

#[tauri::command]
async fn gaveta_dueno(st: St<'_>, pin: String, motivo: String) -> Res<()> {
    let a = st.actor().await?;
    gaveta::orden_dueno(st.pool()?, &a, caja::CAJA_1, &pin, &motivo).await
}

#[tauri::command]
async fn gaveta_aperturas(st: St<'_>, desde: String, hasta: String, usuario_id: Option<String>) -> Res<Vec<gaveta::Apertura>> {
    let a = st.actor().await?;
    gaveta::listar(st.pool()?, &a, caja::CAJA_1, &desde, &hasta, usuario_id.as_deref()).await
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
async fn venta_cobrar(st: St<'_>, espera_id: String, estado: calculo::Estado, pagos: Vec<calculo::PagoEntrada>, pin_existencia: Option<String>) -> Res<ventas::ResultadoCobro> {
    let a = st.actor().await?;
    ventas::cobrar_con(st.pool()?, &a, caja::CAJA_1, &espera_id, &estado, &pagos, pin_existencia.as_deref()).await
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

/// Tiquete de una venta: el original una vez; después, solo COPIA. Devuelve si fue copia.
#[tauri::command]
async fn venta_imprimir(st: St<'_>, venta_id: String, data: Vec<u8>) -> Res<bool> {
    let a = st.actor().await?;
    ventas::imprimir_tiquete(st.pool()?, &a, &venta_id, &data).await
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
async fn venta_pedir_factura(st: St<'_>, venta_id: String, cliente_id: String) -> Res<()> {
    let a = st.actor().await?;
    ventas::pedir_factura(st.pool()?, &a, &venta_id, &cliente_id).await
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

/// PDF del cierre, CSV, datos del cliente: Rust lo guarda en Descargas y devuelve la ruta real.
/// Con un enlace "blob:" la app no podía saber si el archivo quedó guardado.
#[tauri::command]
async fn guardar_descarga(app: tauri::AppHandle, st: St<'_>, nombre: String, datos: Vec<u8>) -> Res<String> {
    st.actor().await?;
    let dir = app.path().download_dir().map_err(|err| format!("No se encontró la carpeta Descargas: {err}"))?;
    util::guardar_en(&dir, &nombre, &datos)
}

#[tauri::command]
async fn respaldo_ultimo(st: St<'_>) -> Res<Option<String>> {
    let a = st.actor().await?;
    respaldo::ultimo(st.bd()?, &a).await
}

#[tauri::command]
async fn app_reiniciar(app: tauri::AppHandle) -> Res<()> {
    app.restart();
}

// ─────────── Importación de productos ───────────

/// Lee el CSV elegido con <input type="file"> (llega como bytes: la ventana no toca el disco).
#[tauri::command]
async fn importacion_leer(st: St<'_>, archivo: Vec<u8>) -> Res<importacion::Tabla> {
    let a = st.actor().await?;
    a.exigir("productos.importar", "importar productos")?;
    importacion::leer(&archivo)
}

#[tauri::command]
async fn importacion_aplicar(st: St<'_>, pin: String, pedido: importacion::Pedido) -> Res<importacion::Resultado> {
    let a = st.actor().await?;
    importacion::aplicar(st.pool()?, &a, &pin, &pedido).await
}

// ─────────── Inventario (todo tipado: nada pasa por bd_leer) ───────────

#[tauri::command]
async fn inventario_lista(st: St<'_>, filtro: inventario::Filtro) -> Res<Value> {
    let a = st.actor().await?;
    let (filas, total) = inventario::lista(st.pool()?, &a, caja::CAJA_1, &filtro).await?;
    Ok(json!({"filas": filas, "total": total}))
}

#[tauri::command]
async fn inventario_estado(st: St<'_>, ids: Vec<String>) -> Res<Vec<inventario::FilaInventario>> {
    let a = st.actor().await?;
    inventario::estado_de(st.pool()?, &a, caja::CAJA_1, &ids).await
}

#[tauri::command]
async fn inventario_existencia(st: St<'_>, ids: Vec<String>) -> Res<Vec<inventario::ExistenciaVenta>> {
    let a = st.actor().await?;
    inventario::existencia_venta(st.pool()?, &a, caja::CAJA_1, &ids).await
}

#[tauri::command]
async fn inventario_alertas(st: St<'_>) -> Res<i64> {
    let a = st.actor().await?;
    inventario::alertas(st.pool()?, &a, caja::CAJA_1).await
}

#[tauri::command]
async fn inventario_producto(st: St<'_>, producto_id: String, controla: bool, minimo: i64, costo: Option<i64>) -> Res<()> {
    let a = st.actor().await?;
    inventario::producto_guardar(st.pool()?, &a, &producto_id, controla, minimo, costo).await
}

#[tauri::command]
async fn inventario_kardex(st: St<'_>, producto_id: String, desde: String, hasta: String) -> Res<Vec<inventario::FilaKardex>> {
    let a = st.actor().await?;
    inventario::kardex(st.pool()?, &a, &producto_id, &desde, &hasta).await
}

#[tauri::command]
async fn inventario_entrada(st: St<'_>, entrada: inventario::Entrada) -> Res<String> {
    let a = st.actor().await?;
    inventario::entrada(st.pool()?, &a, caja::CAJA_1, &entrada).await
}

#[tauri::command]
async fn inventario_entrada_obtener(st: St<'_>, id: String) -> Res<Value> {
    let a = st.actor().await?;
    inventario::entrada_obtener(st.pool()?, &a, &id).await
}

#[tauri::command]
async fn inventario_ajustar(st: St<'_>, ajuste: inventario::Ajuste, pin: String) -> Res<i64> {
    let a = st.actor().await?;
    inventario::ajustar(st.pool()?, &a, caja::CAJA_1, &ajuste, &pin).await
}

#[tauri::command]
async fn inventario_conteo_abierto(st: St<'_>) -> Res<Option<inventario::Conteo>> {
    let a = st.actor().await?;
    inventario::conteo_abierto(st.pool()?, &a).await
}

#[tauri::command]
async fn inventario_conteo_guardar(st: St<'_>, id: Option<String>, departamento_id: Option<String>, datos: std::collections::HashMap<String, i64>) -> Res<String> {
    let a = st.actor().await?;
    inventario::conteo_guardar(st.pool()?, &a, caja::CAJA_1, id.as_deref(), departamento_id.as_deref(), &datos).await
}

#[tauri::command]
async fn inventario_conteo_diferencias(st: St<'_>, id: String) -> Res<Vec<inventario::FilaConteo>> {
    let a = st.actor().await?;
    inventario::conteo_diferencias(st.pool()?, &a, &id).await
}

#[tauri::command]
async fn inventario_conteo_aplicar(st: St<'_>, id: String, pin: String) -> Res<i64> {
    let a = st.actor().await?;
    inventario::conteo_aplicar(st.pool()?, &a, &id, &pin).await
}

#[tauri::command]
async fn inventario_conteo_descartar(st: St<'_>, id: String) -> Res<()> {
    let a = st.actor().await?;
    inventario::conteo_descartar(st.pool()?, &a, &id).await
}

#[tauri::command]
async fn inventario_inicial(st: St<'_>, filas: Vec<inventario::FilaInicial>, aplicar: bool, pin: Option<String>) -> Res<Vec<inventario::PrevistaInicial>> {
    let a = st.actor().await?;
    inventario::inicial(st.pool()?, &a, caja::CAJA_1, &filas, aplicar, pin.as_deref()).await
}

#[tauri::command]
async fn inventario_reporte_bajo_minimo(st: St<'_>) -> Res<Vec<inventario::FilaBajoMinimo>> {
    let a = st.actor().await?;
    inventario::reporte_bajo_minimo(st.pool()?, &a, caja::CAJA_1).await
}

#[tauri::command]
async fn inventario_reporte_valorizado(st: St<'_>) -> Res<inventario::Valorizado> {
    let a = st.actor().await?;
    inventario::reporte_valorizado(st.pool()?, &a, caja::CAJA_1).await
}

#[tauri::command]
async fn inventario_reporte_movimientos(st: St<'_>, desde: String, hasta: String, tipo: Option<String>) -> Res<Vec<inventario::FilaKardex>> {
    let a = st.actor().await?;
    inventario::reporte_movimientos(st.pool()?, &a, &desde, &hasta, tipo.as_deref()).await
}

#[tauri::command]
async fn proveedores_listar(st: St<'_>) -> Res<Vec<inventario::Proveedor>> {
    let a = st.actor().await?;
    inventario::proveedores(st.pool()?, &a).await
}

#[tauri::command]
async fn proveedor_guardar(st: St<'_>, proveedor: inventario::Proveedor) -> Res<String> {
    let a = st.actor().await?;
    inventario::proveedor_guardar(st.pool()?, &a, &proveedor).await
}

#[tauri::command]
async fn proveedor_eliminar(st: St<'_>, id: String) -> Res<()> {
    let a = st.actor().await?;
    inventario::proveedor_eliminar(st.pool()?, &a, &id).await
}

// ─────────── Impresoras ───────────

#[tauri::command]
async fn impresoras_listar(st: St<'_>) -> Res<Vec<impresoras::Impresora>> {
    let a = st.actor().await?;
    impresoras::listar(st.pool()?, &a, caja::CAJA_1).await
}

/// Lo que detecta el sistema operativo (la pantalla solo elige de aquí).
#[tauri::command]
async fn impresoras_detectar(st: St<'_>) -> Res<printer::Detectadas> {
    let a = st.actor().await?;
    impresoras::detectar(&a)
}

#[tauri::command]
async fn impresora_guardar(st: St<'_>, datos: impresoras::Datos) -> Res<String> {
    let a = st.actor().await?;
    impresoras::guardar(st.pool()?, &a, caja::CAJA_1, &datos).await
}

#[tauri::command]
async fn impresora_eliminar(st: St<'_>, id: String) -> Res<()> {
    let a = st.actor().await?;
    impresoras::eliminar(st.pool()?, &a, &id).await
}

#[tauri::command]
async fn impresora_asignar(st: St<'_>, documento: String, impresora_id: Option<String>) -> Res<()> {
    let a = st.actor().await?;
    impresoras::asignar(st.pool()?, &a, caja::CAJA_1, &documento, impresora_id.as_deref()).await
}

#[tauri::command]
async fn impresora_probar(st: St<'_>, id: String, data: Vec<u8>) -> Res<()> {
    let a = st.actor().await?;
    impresoras::probar(st.pool()?, &a, &id, &data).await
}

/// Formato de la impresora de un documento (ancho, code page…), para armarlo en la pantalla.
#[tauri::command]
async fn impresora_ajustes(st: St<'_>, documento: String) -> Res<Option<impresoras::Ajustes>> {
    st.actor().await?;
    impresoras::ajustes(st.pool()?, caja::CAJA_1, &documento).await
}

/// Comprobantes de movimiento, etiquetas y cortes (cierres y reportes). Tiquetes y Z tienen su comando.
#[tauri::command]
async fn imprimir(st: St<'_>, documento: String, data: Vec<u8>) -> Res<String> {
    let a = st.actor().await?;
    let mut documento = documento;
    match documento.as_str() {
        "movimiento" => a.exigir("caja", "imprimir comprobantes de caja")?,
        // Comprobante de entrada de mercadería: sale por la impresora de comprobantes.
        "entrada" => {
            a.exigir("inventario", "imprimir comprobantes de inventario")?;
            documento = "movimiento".into();
        }
        "etiqueta" => a.exigir("productos", "imprimir etiquetas")?,
        "cierre" => a.exigir("caja.admin", "imprimir reportes de caja")?,
        _ => return Err("Ese documento se imprime desde su pantalla".into()),
    }
    impresoras::enviar(st.pool()?, caja::CAJA_1, &documento, &data).await
}

/// Diagnóstico del técnico: impresoras de Windows instaladas.
#[tauri::command]
async fn list_printers(st: St<'_>) -> Res<Vec<String>> {
    let a = st.actor().await?;
    a.exigir("config.tecnica", "usar el diagnóstico")?;
    printer::list_printers()
}

/// Diagnóstico del técnico: manda bytes a una impresora de Windows instalada. También pasan por
/// la lista blanca (no abren la gaveta).
#[tauri::command]
async fn print_raw(st: St<'_>, printer_name: String, data: Vec<u8>) -> Res<()> {
    let a = st.actor().await?;
    a.exigir("config.tecnica", "usar el diagnóstico")?;
    escpos::validar(&data)?;
    // Solo impresoras instaladas: un nombre inventado (\\equipo\cola) haría que Windows se conecte a otra máquina.
    if !printer::list_printers()?.contains(&printer_name) {
        return Err("Esa impresora no está instalada en este equipo".into());
    }
    printer::print_raw(&printer_name, &data)
}

#[cfg(all(not(debug_assertions), not(feature = "cifrado")))]
compile_error!("Una compilación release sin la feature `cifrado` guardaría la base sin cifrar.");

/// Abre la base al arrancar. Errores no tumban la app: la pantalla los muestra (sistema_estado).
async fn preparar(dir: &std::path::Path) -> (Result<Bd, String>, Option<[u8; 32]>) {
    let restaurada = match respaldo::aplicar_restauracion_pendiente(dir) {
        Ok(r) => r,
        Err(err) => return (Err(format!("No se pudo aplicar la restauración: {err}")), None),
    };
    let clave = if cfg!(feature = "cifrado") {
        match clave::obtener(dir) {
            Ok(k) => Some(k),
            Err(err) => return (Err(err), None),
        }
    } else {
        None
    };
    let bd = Bd::abrir(dir, clave).await;
    if let (Ok(b), Some(anterior)) = (&bd, &restaurada) {
        if let Err(err) = respaldo::anotar_restauracion(b, anterior, clave.as_ref()).await {
            return (Err(format!("Se restauró el respaldo pero no se pudo anotar en la bitácora: {err}")), clave);
        }
    }
    (bd, clave)
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
            caja_z_imprimir,
            caja_nota_cierre,
            caja_corte,
            caja_turnos,
            gaveta_venta,
            gaveta_no_venta,
            gaveta_dueno,
            gaveta_aperturas,
            venta_esperas,
            venta_espera_crear,
            venta_espera_guardar,
            venta_espera_descartar,
            venta_autorizar_descuento,
            venta_cobrar,
            venta_obtener,
            venta_listar_dia,
            venta_imprimir,
            venta_correcciones,
            venta_corregir_pago,
            venta_anular,
            venta_pendientes_factura,
            venta_marcar_factura,
            venta_pedir_factura,
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
            respaldo_ultimo,
            guardar_descarga,
            respaldo_restaurar,
            importacion_leer,
            importacion_aplicar,
            app_reiniciar,
            impresoras_listar,
            impresoras_detectar,
            impresora_guardar,
            impresora_eliminar,
            impresora_asignar,
            impresora_probar,
            impresora_ajustes,
            imprimir,
            list_printers,
            print_raw,
            inventario_lista,
            inventario_estado,
            inventario_existencia,
            inventario_alertas,
            inventario_producto,
            inventario_kardex,
            inventario_entrada,
            inventario_entrada_obtener,
            inventario_ajustar,
            inventario_conteo_abierto,
            inventario_conteo_guardar,
            inventario_conteo_diferencias,
            inventario_conteo_aplicar,
            inventario_conteo_descartar,
            inventario_inicial,
            inventario_reporte_bajo_minimo,
            inventario_reporte_valorizado,
            inventario_reporte_movimientos,
            proveedores_listar,
            proveedor_guardar,
            proveedor_eliminar,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicación Tauri");
}
