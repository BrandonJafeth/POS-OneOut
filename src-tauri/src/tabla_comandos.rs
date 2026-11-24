// Tabla completa comando × rol, llamando cada comando POR IPC (runtime simulado de Tauri), igual
// que la pantalla. Compara con `tests/casos/permisos_antes.json`, la foto del comportamiento de la
// 0.9.2 (antes de los permisos configurables): con la plantilla «Normal» nada puede cambiar.
//
// Resultado de cada llamada: "no" (sin permiso), "pin" (pide o rechaza un PIN), "sesion" (sin
// sesión) o "si" (pasó el permiso; puede fallar por otra cosa: el id de prueba no existe…).
// Regenerar la foto (solo si un cambio de permisos es a propósito): POS_GENERAR_TABLA=1 cargo test tabla_comandos
use crate::bd::Bd;
use crate::caja::{self, tests::conteo, CAJA_1};
use crate::permisos::Rol;
use crate::sesion::{Actor, Sesion};
use crate::usuarios::tests::base_con_usuarios;
use crate::App;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::{Manager, WebviewWindow};

const FOTO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/casos/permisos_antes.json");
const X: &str = "00000000000000000000000000";

pub(crate) struct Prueba {
    pub app: tauri::App<MockRuntime>,
    pub w: WebviewWindow<MockRuntime>,
    pub tec: Actor,
    pub dueno: Actor,
    pub cajero: Actor,
    _dir: TempDir,
}

/// Carpeta temporal que se borra al terminar.
pub(crate) struct TempDir(pub std::path::PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// App simulada con todos los comandos de la app real, base en memoria y los tres usuarios.
pub(crate) fn prueba() -> Prueba {
    let (bd, tec, dueno, cajero): (Bd, Actor, Actor, Actor) = tauri::async_runtime::block_on(base_con_usuarios());
    let dir = std::env::temp_dir().join(format!("pos-tabla-{}", crate::util::ulid()));
    std::fs::create_dir_all(&dir).unwrap();
    let app = mock_builder()
        .invoke_handler(crate::comandos())
        .build(mock_context(noop_assets()))
        .unwrap();
    let seguridad = tauri::async_runtime::block_on(crate::politica::cargar(&bd.pool)).unwrap();
    app.manage(App { bd: Ok(bd), dir: dir.clone(), clave: None, sesion: Sesion::default(), debe_cambiar_pin: AtomicBool::new(false), seguridad: std::sync::RwLock::new(std::sync::Arc::new(seguridad)) });
    let w = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    Prueba { app, w, tec, dueno, cajero, _dir: TempDir(dir) }
}

impl Prueba {
    pub fn st(&self) -> tauri::State<'_, App> {
        self.app.state::<App>()
    }
    /// Entra (o sale, con None) sin pasar por el PIN.
    pub fn como(&self, a: Option<&Actor>) {
        let st = self.st();
        tauri::async_runtime::block_on(async {
            match a {
                Some(a) => st.sesion.iniciar(a.clone()).await,
                None => st.sesion.cerrar().await,
            }
        });
    }
    pub fn llamar(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        let r = get_ipc_response(
            &self.w,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        r.map(|b| b.deserialize::<Value>().unwrap_or(Value::Null))
    }
}

pub(crate) fn clase(r: &Result<Value, Value>) -> &'static str {
    let Err(e) = r else { return "si" };
    let t = e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string());
    if t.contains("invalid args") || t.contains("missing required key") || t.contains("command ") && t.contains("not found") {
        return "args";
    }
    if t.contains("No tiene permiso") {
        "no"
    } else if t.contains("SESION_EXPIRADA") || t.contains("SESION_BLOQUEADA") || t.contains("DEBE_CAMBIAR_PIN") {
        "sesion"
    } else if t.contains("PIN") {
        "pin"
    } else {
        "si"
    }
}

fn estado() -> Value {
    json!({"lineas": [], "descuentoTotal": 0, "requiereFactura": false})
}

/// (nombre, comando, argumentos). `ids`: cajero, dueño y técnico reales (para los comandos de usuarios).
pub(crate) fn llamadas(cajero: &str, dueno: &str, tec: &str) -> Vec<(String, &'static str, Value)> {
    let mut v: Vec<(String, &'static str, Value)> = vec![];
    let mut c = |nombre: &str, cmd: &'static str, args: Value| v.push((nombre.to_string(), cmd, args));
    let simple = |cmd: &'static str| cmd.to_string();
    // Sin sesión o cualquier sesión
    c(&simple("sistema_estado"), "sistema_estado", json!({}));
    c(&simple("sistema_restaurar"), "sistema_restaurar", json!({"archivo": [1], "contrasena": "contrasena-larga"}));
    c(&simple("sistema_crear_tecnico"), "sistema_crear_tecnico", json!({"pin": "975319"}));
    c(&simple("sesion_usuarios"), "sesion_usuarios", json!({}));
    c(&simple("sesion_iniciar"), "sesion_iniciar", json!({"usuarioId": X, "pin": "000000"}));
    c(&simple("sesion_tecnico"), "sesion_tecnico", json!({"pin": "000000"}));
    c(&simple("sesion_actual"), "sesion_actual", json!({}));
    c(&simple("sesion_tocar"), "sesion_tocar", json!({}));
    c(&simple("sesion_estado"), "sesion_estado", json!({}));
    c(&simple("sesion_permisos"), "sesion_permisos", json!({}));
    c(&simple("prueba_avanzar_reloj"), "prueba_avanzar_reloj", json!({"segundos": 0}));
    c(&simple("seguridad_obtener"), "seguridad_obtener", json!({}));
    c(&simple("seguridad_diferencias"), "seguridad_diferencias", json!({"datos": crate::politica::plantilla_normal()}));
    c(&simple("seguridad_plantilla"), "seguridad_plantilla", json!({"nombre": "estricto"}));
    c(&simple("seguridad_historial"), "seguridad_historial", json!({}));
    c(&simple("seguridad_version"), "seguridad_version", json!({"id": 1}));
    // Sin cambios (misma Normal) o con PIN equivocado: pasa el permiso y no crea nada.
    c(&simple("seguridad_guardar"), "seguridad_guardar", json!({"datos": crate::politica::plantilla_normal(), "motivo": ""}));
    c(&simple("seguridad_inactividad"), "seguridad_inactividad", json!({"inactividad": {"general": 10}}));
    c(&simple("seguridad_volver"), "seguridad_volver", json!({"id": 1, "motivo": "", "pin": ""}));
    c(&simple("seguridad_autorizar"), "seguridad_autorizar", json!({"accion": "venta.vender"}));
    c(&simple("avisos_dueno"), "avisos_dueno", json!({}));
    c(&simple("avisos_anulaciones_vistas"), "avisos_anulaciones_vistas", json!({}));
    c(&simple("sesion_cerrar"), "sesion_cerrar", json!({}));
    c(&simple("diagnostico_anotar"), "diagnostico_anotar", json!({"origen": "prueba", "mensaje": "x"}));
    c(&simple("bd_leer"), "bd_leer", json!({"sql": "SELECT id FROM productos LIMIT 1", "params": []}));
    c("bd_leer (ventas)", "bd_leer", json!({"sql": "SELECT id FROM ventas LIMIT 1", "params": []}));
    // bd_lote: cada operación con nombre (sentencias.json).
    let ops: Map<String, Value> = serde_json::from_str(include_str!("../../src/db/sentencias.json")).unwrap();
    for id in ops.keys().filter(|k| !k.starts_with('_')) {
        c(&format!("bd_lote ({id})"), "bd_lote", json!({"ops": [{"id": id, "params": []}]}));
    }
    c("bd_lote (bitacora.registrar)", "bd_lote", json!({"ops": [{"id": "bitacora.registrar", "params": [null, "prueba", "prueba", null, "{}"]}]}));
    // Usuarios
    c(&simple("usuarios_listar"), "usuarios_listar", json!({}));
    for (r, pin) in [("cajero", "1593"), ("dueno", "864209"), ("tecnico", "864209")] {
        c(&format!("usuarios_crear ({r})"), "usuarios_crear", json!({"nombre": format!("Nuevo {r}"), "rol": r, "pin": pin}));
    }
    for (r, id) in [("cajero", cajero), ("dueno", dueno), ("tecnico", tec)] {
        c(&format!("usuarios_editar (nombre de {r})"), "usuarios_editar", json!({"id": id, "nombre": format!("Otro {r}")}));
        c(&format!("usuarios_cambiar_pin (de {r})"), "usuarios_cambiar_pin", json!({"id": id, "pin": if r == "cajero" { "2580" } else { "246813" }}));
    }
    // Configuración: una clave de cada grupo de permisos (config::permiso_de).
    for (clave, val) in [
        ("tema", json!("claro")),
        ("redondeo_total", json!(5)),
        ("pin_min_cajero", json!(4)),
        ("sesion_inactividad_min", json!(10)),
        ("usa_credito", json!(false)),
        ("descuento_max_pct", json!({"cajero": 10})),
        ("caja_umbral_diferencia", json!(1000)),
        ("caja_salida_max_sin_pin", json!(20000)),
        ("caja_no_venta_umbral", json!(0)),
        ("caja_quitar_linea_bitacora", json!(5000)),
        ("departamentos_color", json!("cada_uno")),
        ("color_fondo", json!("")),
        ("permitir_vender_sin_existencia", json!(true)),
        ("venta_mostrar_existencia", json!(false)),
        ("inventario_motivos_ajuste", json!(["Dañado"])),
        ("respaldo_auto_cantidad", json!(30)),
        ("importacion_codigos_internos", json!(true)),
        ("abono_minimo_pct", json!(20)),
        ("apartado_plazo_dias", json!(30)),
        ("credito_plazo_dias", json!(30)),
        ("proforma_vigencia_dias", json!(8)),
    ] {
        c(&format!("config_guardar ({clave})"), "config_guardar", json!({"clave": clave, "valor": val}));
    }
    c("negocio_guardar (contacto)", "negocio_guardar", json!({"cambios": {"telefono": "2222-2222"}}));
    c("negocio_guardar (legal)", "negocio_guardar", json!({"cambios": {"cedula": "3-101-000000"}}));
    c(&simple("negocio_logo"), "negocio_logo", json!({"logo": null}));
    c(&simple("bitacora_listar"), "bitacora_listar", json!({"limite": 5}));
    c(&simple("bitacora_verificar"), "bitacora_verificar", json!({}));
    // Caja (la caja está abierta)
    c(&simple("caja_estado"), "caja_estado", json!({}));
    c(&simple("caja_abrir"), "caja_abrir", json!({"conteo": {"total": 1000}}));
    c(&simple("caja_queda"), "caja_queda", json!({"turnoId": X, "monto": 0}));
    c(&simple("caja_corregir_dia"), "caja_corregir_dia", json!({"turnoId": X, "dia": "2026-01-01", "pin": "000000", "motivo": "motivo largo"}));
    c("caja_movimiento (entrada)", "caja_movimiento", json!({"movimiento": {"tipo": "entrada", "monto": 100, "categoria": "Ingreso de cambio"}}));
    c("caja_movimiento (salida chica)", "caja_movimiento", json!({"movimiento": {"tipo": "salida", "monto": 100, "categoria": "Gasto"}}));
    c("caja_movimiento (salida sobre el tope)", "caja_movimiento", json!({"movimiento": {"tipo": "salida", "monto": 50000, "categoria": "Gasto"}}));
    c(&simple("caja_detalle"), "caja_detalle", json!({"turnoId": X}));
    c(&simple("caja_necesita_nota"), "caja_necesita_nota", json!({"conteo": {"total": 1000}}));
    c(&simple("caja_consecutivo"), "caja_consecutivo", json!({"numero": 100}));
    c(&simple("caja_reabrir"), "caja_reabrir", json!({"turnoId": X, "pin": "000000", "motivo": "motivo largo"}));
    c(&simple("caja_revisada"), "caja_revisada", json!({"turnoId": X}));
    c(&simple("caja_z"), "caja_z", json!({"turnoId": X}));
    c(&simple("caja_z_imprimir"), "caja_z_imprimir", json!({"turnoId": X, "documentos": []}));
    c(&simple("caja_nota_cierre"), "caja_nota_cierre", json!({"turnoId": X, "nota": "nota"}));
    c(&simple("caja_corte"), "caja_corte", json!({}));
    c(&simple("caja_turnos"), "caja_turnos", json!({"desde": "2000-01-01", "hasta": "2999-01-01"}));
    c(&simple("gaveta_venta"), "gaveta_venta", json!({"ventaId": X}));
    c(&simple("gaveta_abono"), "gaveta_abono", json!({"operacionId": X}));
    c(&simple("gaveta_no_venta"), "gaveta_no_venta", json!({"motivo": "Cambio de billetes", "nota": ""}));
    c(&simple("gaveta_dueno"), "gaveta_dueno", json!({"pin": "000000", "motivo": "motivo"}));
    c(&simple("gaveta_aperturas"), "gaveta_aperturas", json!({"desde": "2000-01-01", "hasta": "2999-01-01"}));
    // Venta
    c(&simple("venta_esperas"), "venta_esperas", json!({}));
    c(&simple("venta_espera_crear"), "venta_espera_crear", json!({"estado": estado()}));
    c(&simple("venta_espera_guardar"), "venta_espera_guardar", json!({"id": X, "estado": estado()}));
    c(&simple("venta_espera_descartar"), "venta_espera_descartar", json!({"id": X}));
    c(&simple("venta_autorizar_descuento"), "venta_autorizar_descuento", json!({"esperaId": X, "pct": 50.0, "pin": "000000"}));
    c(&simple("venta_faltantes"), "venta_faltantes", json!({"lineas": [[X, 1]]}));
    c(&simple("venta_referencia_usada"), "venta_referencia_usada", json!({"formaPagoId": X, "referencia": "12345"}));
    c(&simple("venta_cobrar"), "venta_cobrar", json!({"esperaId": X, "estado": estado(), "pagos": []}));
    c(&simple("venta_obtener"), "venta_obtener", json!({"id": X}));
    c(&simple("venta_listar_dia"), "venta_listar_dia", json!({"dia": "2026-01-01"}));
    c(&simple("venta_listar_turno"), "venta_listar_turno", json!({"turnoId": X}));
    c(&simple("venta_imprimir"), "venta_imprimir", json!({"ventaId": X, "data": [120, 10]}));
    c(&simple("venta_correcciones"), "venta_correcciones", json!({"ventaId": X}));
    c(&simple("venta_corregir_pago"), "venta_corregir_pago", json!({"pagoId": X, "cambio": {"formaPagoId": X}, "motivo": "motivo largo"}));
    c(&simple("venta_anular"), "venta_anular", json!({"ventaId": X, "pin": "000000", "motivo": "motivo largo", "devolucionEfectivo": 0}));
    c(&simple("venta_pendientes_factura"), "venta_pendientes_factura", json!({}));
    c(&simple("venta_pedir_factura"), "venta_pedir_factura", json!({"ventaId": X, "clienteId": X}));
    c(&simple("venta_marcar_factura"), "venta_marcar_factura", json!({"ventaId": X, "referencia": "FE-1"}));
    // Clientes
    c(&simple("cliente_crear"), "cliente_crear", json!({"datos": {"nombre": "Ana Mora", "telefono": "8888-8888"}, "consentimiento": true, "versionAviso": "1"}));
    c(&simple("cliente_buscar"), "cliente_buscar", json!({"texto": "ana"}));
    c(&simple("cliente_basico"), "cliente_basico", json!({"id": X}));
    c(&simple("cliente_dato_factura"), "cliente_dato_factura", json!({"id": X, "campo": "nombre"}));
    c(&simple("cliente_tiene_correo"), "cliente_tiene_correo", json!({"id": X}));
    c(&simple("cliente_listar"), "cliente_listar", json!({}));
    c(&simple("cliente_obtener"), "cliente_obtener", json!({"id": X}));
    c(&simple("cliente_editar"), "cliente_editar", json!({"id": X, "datos": {"nombre": "Ana Mora", "telefono": "8888-8888"}}));
    c(&simple("cliente_cuentas_saldo"), "cliente_cuentas_saldo", json!({"id": X}));
    c(&simple("cliente_exportar"), "cliente_exportar", json!({"id": X, "formato": "csv"}));
    c(&simple("cliente_anonimizar"), "cliente_anonimizar", json!({"id": X, "pin": "000000", "motivo": "otro"}));
    c(&simple("cliente_retencion"), "cliente_retencion", json!({}));
    // Apartados y crédito
    c(&simple("cuentas_reglas"), "cuentas_reglas", json!({}));
    c(&simple("cuenta_crear_apartado"), "cuenta_crear_apartado", json!({"esperaId": X, "estado": estado(), "monto": 1, "pagos": [], "operacionId": "OP1"}));
    c(&simple("cuenta_abonar"), "cuenta_abonar", json!({"cuentaId": X, "monto": 1, "pagos": [], "operacionId": "OP2", "entregar": true}));
    c(&simple("cuenta_entregar"), "cuenta_entregar", json!({"cuentaId": X}));
    c(&simple("cuenta_buscar"), "cuenta_buscar", json!({"texto": ""}));
    c(&simple("cuenta_obtener"), "cuenta_obtener", json!({"id": X}));
    c(&simple("cuenta_imprimir"), "cuenta_imprimir", json!({"cuentaId": X, "datos": [120]}));
    c(&simple("cuenta_listar"), "cuenta_listar", json!({"filtro": "abiertas"}));
    c(&simple("cuenta_vencidas"), "cuenta_vencidas", json!({}));
    c(&simple("cuenta_cancelar"), "cuenta_cancelar", json!({"cuentaId": X, "pin": "000000", "motivo": "motivo largo", "devuelto": 0, "enEfectivo": 0}));
    c(&simple("cuenta_ajustar"), "cuenta_ajustar", json!({"cuentaId": X, "cambio": 1, "pin": "000000", "motivo": "motivo largo"}));
    c(&simple("cuenta_condonar"), "cuenta_condonar", json!({"cuentaId": X, "pin": "000000", "motivo": "motivo largo", "entregar": false}));
    c(&simple("cuenta_prorrogar"), "cuenta_prorrogar", json!({"cuentaId": X, "fechaLimite": "2099-01-01", "motivo": "motivo largo", "pin": "000000"}));
    c(&simple("abono_anular"), "abono_anular", json!({"abonoId": X, "pin": "000000", "motivo": "motivo largo", "devolucionEfectivo": 0}));
    c(&simple("cliente_limite_credito"), "cliente_limite_credito", json!({"clienteId": X, "limite": 1, "pin": "000000"}));
    c(&simple("cliente_limite_obtener"), "cliente_limite_obtener", json!({"clienteId": X}));
    c(&simple("cliente_estado_cuenta"), "cliente_estado_cuenta", json!({"clienteId": X}));
    c(&simple("credito_disponible"), "credito_disponible", json!({"clienteId": X}));
    c(&simple("credito_opciones"), "credito_opciones", json!({}));
    c(&simple("credito_guardar_opciones"), "credito_guardar_opciones", json!({"opciones": {"limiteDefecto": 0, "plazoDias": 30, "plazoTipo": "calendario", "condiciones": ""}, "pin": "000000"}));
    // Proformas y reportes
    c(&simple("proforma_guardar"), "proforma_guardar", json!({"esperaId": X, "estado": estado()}));
    c(&simple("proforma_buscar"), "proforma_buscar", json!({"texto": "", "filtro": ""}));
    c(&simple("proforma_obtener"), "proforma_obtener", json!({"id": X}));
    c(&simple("proforma_imprimir"), "proforma_imprimir", json!({"id": X, "datos": [120]}));
    c(&simple("proforma_anular"), "proforma_anular", json!({"id": X, "motivo": "motivo largo"}));
    c(&simple("proforma_abrir"), "proforma_abrir", json!({"id": X}));
    c(&simple("proforma_reporte"), "proforma_reporte", json!({"desde": "2026-01-01", "hasta": "2026-01-31"}));
    c(&simple("reporte_rangos"), "reporte_rangos", json!({}));
    c(&simple("reporte_ventas"), "reporte_ventas", json!({"desde": "2026-01-01", "hasta": "2026-01-31"}));
    // Respaldo y sistema
    c(&simple("respaldo_crear"), "respaldo_crear", json!({"contrasena": "x"}));
    c(&simple("respaldo_ultimo"), "respaldo_ultimo", json!({}));
    c(&simple("respaldo_auto_configurar"), "respaldo_auto_configurar", json!({"contrasena": "x", "pin": "000000"}));
    c(&simple("respaldo_auto_estado"), "respaldo_auto_estado", json!({}));
    c(&simple("respaldo_usb_confirmado"), "respaldo_usb_confirmado", json!({}));
    c(&simple("respaldo_restaurar"), "respaldo_restaurar", json!({"pin": "000000", "archivo": [1], "contrasena": "contrasena-larga"}));
    // Nombre no permitido: pasa el permiso y no escribe ningún archivo.
    for carpeta in [None, Some("Reportes"), Some("Clientes"), Some("Cierres de caja"), Some("Inventario")] {
        c(&format!("guardar_descarga ({})", carpeta.unwrap_or("Descargas")), "guardar_descarga", json!({"nombre": "no-valido.exe", "datos": [1], "carpeta": carpeta}));
    }
    c(&simple("sistema_preparacion"), "sistema_preparacion", json!({}));
    // Importación e inventario
    c(&simple("importacion_leer"), "importacion_leer", json!({"archivo": [120]}));
    c(&simple("importacion_aplicar"), "importacion_aplicar", json!({"pin": "000000", "pedido": {"modo": "todo", "items": []}}));
    c(&simple("inventario_lista"), "inventario_lista", json!({"filtro": {}}));
    c(&simple("inventario_estado"), "inventario_estado", json!({"ids": [X]}));
    c(&simple("inventario_existencia"), "inventario_existencia", json!({"ids": [X]}));
    c(&simple("inventario_alertas"), "inventario_alertas", json!({}));
    c(&simple("inventario_producto"), "inventario_producto", json!({"productoId": X, "controla": true, "minimo": 0}));
    c(&simple("inventario_kardex"), "inventario_kardex", json!({"productoId": X, "desde": "2026-01-01", "hasta": "2026-01-31"}));
    c(&simple("inventario_entrada"), "inventario_entrada", json!({"entrada": {"fecha": "2026-01-01", "lineas": []}}));
    c(&simple("inventario_entrada_obtener"), "inventario_entrada_obtener", json!({"id": X}));
    c(&simple("inventario_ajustar"), "inventario_ajustar", json!({"ajuste": {"productoId": X, "diferencia": 1, "motivo": "Dañado"}, "pin": "000000"}));
    c(&simple("inventario_conteo_abierto"), "inventario_conteo_abierto", json!({}));
    c(&simple("inventario_conteo_guardar"), "inventario_conteo_guardar", json!({"datos": {}}));
    c(&simple("inventario_conteo_diferencias"), "inventario_conteo_diferencias", json!({"id": X}));
    c(&simple("inventario_conteo_aplicar"), "inventario_conteo_aplicar", json!({"id": X, "pin": "000000"}));
    c(&simple("inventario_conteo_descartar"), "inventario_conteo_descartar", json!({"id": X}));
    c(&simple("inventario_inicial"), "inventario_inicial", json!({"filas": [], "aplicar": false}));
    c(&simple("inventario_reporte_bajo_minimo"), "inventario_reporte_bajo_minimo", json!({}));
    c(&simple("inventario_reporte_valorizado"), "inventario_reporte_valorizado", json!({}));
    c(&simple("inventario_reporte_movimientos"), "inventario_reporte_movimientos", json!({"desde": "2026-01-01", "hasta": "2026-01-31"}));
    c(&simple("proveedores_listar"), "proveedores_listar", json!({}));
    c(&simple("proveedor_guardar"), "proveedor_guardar", json!({"proveedor": {"nombre": ""}}));
    c(&simple("proveedor_eliminar"), "proveedor_eliminar", json!({"id": X}));
    // Impresoras (no hay ninguna configurada: no imprime nada de verdad)
    c(&simple("impresoras_listar"), "impresoras_listar", json!({}));
    c(&simple("impresoras_detectar"), "impresoras_detectar", json!({}));
    c(&simple("impresora_guardar"), "impresora_guardar", json!({"datos": {"nombre": "", "conexion": "windows", "destino": "no-existe", "anchoMm": 58, "columnas": 32, "codePage": 19, "sinModoChino": true, "barras": "ninguno", "cortador": false, "gaveta": false}}));
    c(&simple("impresora_eliminar"), "impresora_eliminar", json!({"id": X}));
    c(&simple("impresora_asignar"), "impresora_asignar", json!({"documento": "tiquete", "impresoraId": null}));
    c(&simple("impresora_probar"), "impresora_probar", json!({"id": X, "data": [120]}));
    c(&simple("impresora_ajustes"), "impresora_ajustes", json!({"documento": "tiquete"}));
    for doc in ["movimiento", "entrada", "etiqueta", "cierre", "estado_cuenta", "tiquete"] {
        c(&format!("imprimir ({doc})"), "imprimir", json!({"documento": doc, "data": [120]}));
    }
    c(&simple("list_printers"), "list_printers", json!({}));
    c(&simple("print_raw"), "print_raw", json!({"printerName": "no-existe-pos", "data": [120]}));
    // Al final: los que cambian el estado de los demás (cerrar la caja, borrar usuarios).
    c(&simple("gaveta_cierre"), "gaveta_cierre", json!({}));
    c(&simple("caja_cerrar"), "caja_cerrar", json!({"conteo": {"total": 1000}, "nota": ""}));
    c("usuarios_editar (desactivar cajero)", "usuarios_editar", json!({"id": cajero, "activo": false}));
    c("usuarios_eliminar (cajero)", "usuarios_eliminar", json!({"id": cajero}));
    c("usuarios_eliminar (tecnico)", "usuarios_eliminar", json!({"id": tec}));
    c("usuarios_editar (desactivar dueno)", "usuarios_editar", json!({"id": dueno, "activo": false}));
    c("usuarios_eliminar (dueno)", "usuarios_eliminar", json!({"id": dueno}));
    v
}

/// Cambios a propósito en la 0.9.3 (nombre, sin sesión, cajero, dueño, técnico) y por qué. Lo demás
/// tiene que quedar igual que en la foto.
const DELIBERADOS: &[(&str, &str, &str, &str, &str, &str)] = &[
    // Estos topes pasaron a Administración → Permisos (políticas versionadas, con PIN del dueño si
    // dan más permiso): config_guardar ya no los acepta de nadie.
    ("config_guardar (descuento_max_pct)", "sesion", "no", "no", "no", "en Permisos: venta.descuento"),
    ("config_guardar (caja_salida_max_sin_pin)", "sesion", "no", "no", "no", "en Permisos: caja.salida"),
    ("config_guardar (permitir_vender_sin_existencia)", "sesion", "no", "no", "no", "en Permisos: venta.sin_existencia"),
    ("config_guardar (venta_mostrar_existencia)", "sesion", "no", "no", "no", "en Permisos: venta.ver_existencia"),
    ("config_guardar (sesion_inactividad_min)", "sesion", "no", "no", "no", "en Permisos: bloqueo por inactividad"),
];

/// Comandos nuevos (0.9.3): (nombre, sin sesión, cajero, dueño, técnico).
const NUEVOS: &[(&str, &str, &str, &str, &str)] = &[
    ("sesion_estado", "si", "si", "si", "si"),
    ("sesion_permisos", "sesion", "si", "si", "si"),
    ("prueba_avanzar_reloj", "si", "si", "si", "si"),
    ("seguridad_obtener", "sesion", "no", "si", "si"),
    ("seguridad_diferencias", "sesion", "no", "si", "si"),
    ("seguridad_plantilla", "sesion", "no", "si", "si"),
    ("seguridad_historial", "sesion", "no", "si", "si"),
    ("seguridad_version", "sesion", "no", "si", "si"),
    ("seguridad_guardar", "sesion", "no", "pin", "pin"),
    ("seguridad_inactividad", "sesion", "no", "si", "si"),
    ("seguridad_volver", "sesion", "no", "pin", "pin"),
    // Venta: el técnico no la tiene (aunque pida autorización).
    ("seguridad_autorizar", "sesion", "si", "si", "no"),
    ("avisos_dueno", "sesion", "si", "si", "si"),
    ("avisos_anulaciones_vistas", "sesion", "no", "si", "no"),
];

/// Comandos que la prueba no llama: (comando, por qué).
const SIN_LLAMAR: &[(&str, &str)] = &[
    ("app_reiniciar", "reinicia el proceso; no usa sesión ni datos"),
    ("diagnostico_exportar", "escribe en la carpeta Descargas real; mismo permiso que sistema_preparacion (prueba aparte)"),
    ("respaldo_auto_ahora", "lanza un respaldo en segundo plano; mismo permiso que respaldo_auto_estado"),
];

/// Los comandos registrados en la app (lista de `comandos()` en lib.rs).
pub(crate) fn registrados() -> Vec<String> {
    let src = include_str!("lib.rs");
    let i = src.find("fn comandos<R").unwrap();
    let ini = i + src[i..].find("generate_handler![").unwrap() + "generate_handler![".len();
    let fin = ini + src[ini..].find(']').unwrap();
    src[ini..fin].split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

/// Corre la tabla: nombre → {rol → clase}.
pub(crate) fn correr() -> BTreeMap<String, BTreeMap<String, String>> {
    let mut tabla: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for rol in ["sin_sesion", "cajero", "dueno", "tecnico"] {
        let p = prueba();
        let actor = match rol {
            "cajero" => Some(p.cajero.clone()),
            "dueno" => Some(p.dueno.clone()),
            "tecnico" => Some(p.tec.clone()),
            _ => None,
        };
        // La caja abierta (por quien puede), para que los comandos de caja lleguen a revisar el permiso.
        let abre = if rol == "cajero" { &p.cajero } else { &p.dueno };
        tauri::async_runtime::block_on(async {
            let st = p.st();
            caja::abrir(st.pool().unwrap(), abre, CAJA_1, &conteo(&[(1000, 1)])).await.unwrap();
        });
        let ll = llamadas(&p.cajero.id, &p.dueno.id, &p.tec.id);
        for (nombre, cmd, args) in ll {
            p.como(actor.as_ref());
            let r = p.llamar(cmd, args);
            let k = clase(&r);
            assert_ne!(k, "args", "{nombre} con {rol}: argumentos mal armados en la prueba: {r:?}");
            tabla.entry(nombre).or_default().insert(rol.to_string(), k.to_string());
        }
    }
    tabla
}

#[test]
fn tabla_comandos_igual_que_la_foto() {
    // Cada comando registrado se llama al menos una vez (o está en SIN_LLAMAR con su razón).
    let llamados: std::collections::BTreeSet<&str> = llamadas("a", "b", "c").iter().map(|(_, c, _)| *c).collect();
    let faltan: Vec<String> = registrados().into_iter().filter(|c| !llamados.contains(c.as_str()) && !SIN_LLAMAR.iter().any(|(s, _)| s == c)).collect();
    assert!(faltan.is_empty(), "comandos sin llamar en tabla_comandos: {faltan:?}");

    let real = correr();
    if std::env::var("POS_GENERAR_TABLA").as_deref() == Ok("1") {
        let txt = serde_json::to_string_pretty(&real).unwrap() + "\n";
        std::fs::write(FOTO, txt).unwrap();
        return;
    }
    let foto: BTreeMap<String, BTreeMap<String, String>> = serde_json::from_str(&std::fs::read_to_string(FOTO).expect("falta la foto: POS_GENERAR_TABLA=1")).unwrap();
    let mut dif = vec![];
    for (n, roles) in &foto {
        let deliberado = DELIBERADOS.iter().find(|(x, ..)| x == n).map(|(_, sin, c, d, t, _)| [("sin_sesion", *sin), ("cajero", *c), ("dueno", *d), ("tecnico", *t)].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>());
        let roles = deliberado.as_ref().unwrap_or(roles);
        match real.get(n) {
            None => dif.push(format!("{n}: ya no se prueba")),
            Some(r) if r != roles => dif.push(format!("{n}: antes {roles:?}, ahora {r:?}")),
            _ => {}
        }
    }
    // Comandos nuevos de la 0.9.3 (no estaban en la foto): lo esperado está aquí.
    for n in real.keys().filter(|n| !foto.contains_key(*n)) {
        match NUEVOS.iter().find(|(x, ..)| x == n) {
            None => dif.push(format!("{n}: nuevo (no está en la foto ni en NUEVOS)")),
            Some((_, sin, c, d, t)) => {
                let esperado: BTreeMap<String, String> = [("sin_sesion", sin), ("cajero", c), ("dueno", d), ("tecnico", t)].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
                if real[n] != esperado {
                    dif.push(format!("{n}: esperado {esperado:?}, ahora {:?}", real[n]));
                }
            }
        }
    }
    assert!(dif.is_empty(), "\n{}", dif.join("\n"));
    let _ = Rol::Cajero;
}
