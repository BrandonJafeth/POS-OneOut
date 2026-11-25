// Catálogo de acciones del sistema (DISENO-PERMISOS.md §2). Cada comando de la app corresponde a una
// acción (COMANDOS); la política de cada acción por rol o por usuario sale de politica.rs.
// Una acción nueva sin política queda negada; un comando sin acción hace fallar las pruebas.

use serde::{Deserialize, Serialize};
#[cfg(test)]
use ts_rs::TS;

/// Qué tan permitido: el orden importa (no < pin < motivo < si = más permisivo).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "lowercase")]
pub enum Nivel {
    #[default]
    No,
    Pin,
    Motivo,
    Si,
}

/// Al pasar un límite: pedir el PIN del dueño o no dejar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "lowercase")]
pub enum AlPasar {
    #[default]
    Pin,
    Bloquear,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Limites {
    /// Colones (monto de la venta, la salida, la línea…).
    #[cfg_attr(test, ts(type = "number | null"))]
    pub monto_max: Option<i64>,
    /// Porcentaje de descuento (sin el descuento fijo del producto).
    pub pct_max: Option<f64>,
    /// Veces por turno abierto, por usuario.
    #[cfg_attr(test, ts(type = "number | null"))]
    pub cantidad_turno: Option<i64>,
    pub solo_turno_abierto: bool,
    /// Minutos desde la venta (hora real).
    #[cfg_attr(test, ts(type = "number | null"))]
    pub ventana_min: Option<i64>,
    pub al_pasar: AlPasar,
}

impl Limites {
    pub const NINGUNO: Limites = Limites { monto_max: None, pct_max: None, cantidad_turno: None, solo_turno_abierto: false, ventana_min: None, al_pasar: AlPasar::Pin };
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Politica {
    pub nivel: Nivel,
    /// Con PIN: además pide motivo.
    pub motivo: bool,
    pub limites: Limites,
}

impl Politica {
    pub const NO: Politica = Politica { nivel: Nivel::No, motivo: false, limites: Limites::NINGUNO };
    pub const SI: Politica = Politica { nivel: Nivel::Si, motivo: false, limites: Limites::NINGUNO };
    pub const PIN: Politica = Politica { nivel: Nivel::Pin, motivo: false, limites: Limites::NINGUNO };
    pub const PIN_MOTIVO: Politica = Politica { nivel: Nivel::Pin, motivo: true, limites: Limites::NINGUNO };
    pub const MOTIVO: Politica = Politica { nivel: Nivel::Motivo, motivo: true, limites: Limites::NINGUNO };
    const fn con(nivel: Nivel, limites: Limites) -> Politica {
        Politica { nivel, motivo: false, limites }
    }
}

// Límites que admite cada acción (bits).
pub const L_MONTO: u8 = 1;
pub const L_PCT: u8 = 2;
pub const L_CANTIDAD: u8 = 4;
pub const L_TURNO: u8 = 8;
pub const L_VENTANA: u8 = 16;

// Niveles que la acción puede aplicar de verdad, además de «no» (D4). La pantalla Permisos ofrece solo
// esos y politica::validar rechaza los demás; uno que llegue igual (versión vieja) se baja al más
// estricto que sí aplique (Accion::ajustar), nunca vale como «sí».
pub const N_PIN: u8 = 1;
pub const N_MOTIVO: u8 = 2;
pub const N_SI: u8 = 4;
/// El comando revisa la política con sus argumentos (politica::aplicar) o pasa por la puerta común.
pub const N_TODOS: u8 = N_PIN | N_MOTIVO | N_SI;
/// El comando siempre pide el PIN del dueño (usuarios::confirmar_dueno): «sí» y «con PIN» son lo mismo.
pub const N_CON_PIN: u8 = N_PIN | N_SI;

#[derive(Debug)]
pub struct Accion {
    pub id: &'static str,
    pub area: &'static str,
    pub nombre: &'static str,
    /// Dinero, caja, clientes o anulaciones: dar más permiso pide el PIN del dueño.
    pub sensible: bool,
    /// El técnico nunca la tiene (Ley 8968 o dinero), aunque venga en los datos.
    pub protegida: bool,
    /// Solo dueño y técnico, fijo (el cajero nunca, ni por excepción).
    pub no_delegable: bool,
    /// El comando aplica su política adentro de su transacción (límites, PIN y motivo con sus
    /// propios argumentos). Las demás las aplica la puerta común (politica::puerta).
    pub propia: bool,
    pub limites: u8,
    /// Plantilla «Normal» (= 0.9.2) para el cajero y el técnico.
    pub normal_cajero: Politica,
    pub normal_tecnico: Politica,
    /// Fila fija del dueño (lo que hace hoy).
    pub dueno: Politica,
    /// El tope es del negocio, no del cajero: el dueño sigue los límites del rol cajero (con PIN al
    /// pasarlos, nunca «no»). Salidas de caja y vender sin existencia (0.9.2: también el dueño).
    pub dueno_sigue_cajero: bool,
    /// Niveles que aplica (N_*).
    pub niveles: u8,
    /// Sin un monto máximo configurado, el cajero la tiene solo con PIN (dinero que sale sin venta).
    pub monto_o_pin: bool,
}

const fn a(id: &'static str, area: &'static str, nombre: &'static str, c: Politica, t: Politica) -> Accion {
    Accion { id, area, nombre, sensible: false, protegida: false, no_delegable: false, propia: false, limites: 0, normal_cajero: c, normal_tecnico: t, dueno: Politica::SI, dueno_sigue_cajero: false, niveles: N_SI, monto_o_pin: false }
}
impl Accion {
    const fn sensible(mut self) -> Self {
        self.sensible = true;
        self
    }
    /// Sensible y protegida (dinero o datos de clientes).
    const fn p(mut self) -> Self {
        self.sensible = true;
        self.protegida = true;
        self
    }
    const fn propia(mut self, limites: u8) -> Self {
        self.propia = true;
        self.limites = limites;
        self
    }
    const fn dueno(mut self, d: Politica) -> Self {
        self.dueno = d;
        self
    }
    const fn sigue_cajero(mut self) -> Self {
        self.dueno_sigue_cajero = true;
        self
    }
    const fn fija(mut self) -> Self {
        self.no_delegable = true;
        self
    }
    const fn todos(mut self) -> Self {
        self.niveles = N_TODOS;
        self
    }
    const fn con_pin(mut self) -> Self {
        self.niveles = N_CON_PIN;
        self
    }
    const fn monto_o_pin(mut self) -> Self {
        self.monto_o_pin = true;
        self
    }

    /// ¿Esta acción aplica esa política? Err con el texto para la pantalla.
    pub fn admite(&self, p: &Politica) -> Result<(), String> {
        let bit = match p.nivel {
            Nivel::No => return Ok(()),
            Nivel::Pin => N_PIN,
            Nivel::Motivo => N_MOTIVO,
            Nivel::Si => N_SI,
        };
        if self.niveles & bit == 0 || (p.motivo && self.niveles & N_MOTIVO == 0) {
            return Err(format!("«{}» no se puede pedir con PIN o motivo: solo «sí» o «no».", self.nombre));
        }
        if self.monto_o_pin && p.nivel > Nivel::Pin && p.limites.monto_max.is_none() {
            return Err(format!("«{}»: sin un monto máximo, solo con PIN del dueño.", self.nombre));
        }
        Ok(())
    }

    /// La política que de verdad se aplica: si esta acción no admite `p`, el nivel más estricto que sí
    /// admita (nunca uno más permisivo). Lo usa politica::efectiva con cada fila del cajero y el técnico.
    pub fn ajustar(&self, p: Politica) -> Politica {
        if self.admite(&p).is_ok() {
            return p;
        }
        let motivo = (p.motivo || p.nivel == Nivel::Motivo) && self.niveles & N_MOTIVO != 0;
        for n in [Nivel::Si, Nivel::Motivo, Nivel::Pin] {
            let q = Politica { nivel: n, motivo: motivo && n != Nivel::Si, limites: p.limites };
            if n <= p.nivel && self.admite(&q).is_ok() {
                return q;
            }
        }
        Politica::NO
    }
}

use Politica as P;
const SI: P = P::SI;
const NO: P = P::NO;

pub const VENTA_DESCUENTO_DEFECTO: f64 = 10.0;
pub const CAJA_SALIDA_DEFECTO: i64 = 20_000;

pub static CATALOGO: &[Accion] = &[
    // Venta
    a("venta.vender", "Venta", "Vender y cobrar", SI, NO).p(),
    a("venta.descuento", "Venta", "Descuento por línea y al total", P::con(Nivel::Si, Limites { pct_max: Some(VENTA_DESCUENTO_DEFECTO), ..Limites::NINGUNO }), NO).p().propia(L_PCT).todos(),
    a("venta.precio_libre", "Venta", "Precio libre (F4)", SI, NO).p().propia(0).todos(),
    a("venta.sin_existencia", "Venta", "Vender sin existencia", SI, NO).p().propia(0).sigue_cajero().todos(),
    a("venta.apartadas", "Venta", "Vender unidades apartadas", P::PIN, NO).p().propia(0).dueno(P::PIN).todos(),
    a("venta.quitar_linea", "Venta", "Quitar líneas de una venta abierta", SI, NO).p().propia(L_MONTO).todos(),
    a("venta.descartar_espera", "Venta", "Descartar una venta en espera", SI, NO).p().todos(),
    a("venta.ver_existencia", "Venta", "Ver existencias al vender", NO, NO).p(),
    // Ventas cobradas
    a("ventas.ver", "Ventas cobradas", "Ver tiquetes del día", SI, NO).p(),
    a("ventas.reimprimir", "Ventas cobradas", "Reimprimir tiquete", SI, NO).p(),
    a("ventas.anular", "Ventas cobradas", "Anular una venta", NO, NO).p().propia(L_MONTO | L_CANTIDAD | L_TURNO | L_VENTANA).dueno(P::PIN_MOTIVO).todos(),
    a("ventas.cambiar_pago", "Ventas cobradas", "Cambiar la forma de pago", NO, NO).p().propia(L_MONTO).dueno(P::PIN_MOTIVO).todos().monto_o_pin(),
    a("facturas.ver", "Ventas cobradas", "Pendientes de factura", SI, NO).p(),
    a("facturas.marcar", "Ventas cobradas", "Marcar factura emitida", SI, NO).p(),
    // Caja
    a("caja.ver", "Caja", "Ver la caja y su turno", SI, NO).p(),
    a("caja.abrir", "Caja", "Abrir caja", SI, NO).p(),
    a("caja.cerrar", "Caja", "Cerrar caja (conteo y Z)", SI, NO).p(),
    a("caja.cerrar_otro", "Caja", "Cerrar el turno de otro (de un día anterior)", SI, NO).p().propia(0),
    a("caja.ver_totales", "Caja", "Ver totales con el turno abierto", NO, NO).p().propia(0),
    a("caja.reabrir", "Caja", "Reabrir un turno", NO, NO).p().propia(0).dueno(P::PIN_MOTIVO).con_pin(),
    a("caja.entrada", "Caja", "Entrada de efectivo", SI, NO).p(),
    a("caja.salida", "Caja", "Salida de efectivo", P::con(Nivel::Si, Limites { monto_max: Some(CAJA_SALIDA_DEFECTO), ..Limites::NINGUNO }), NO).p().propia(L_MONTO).sigue_cajero().todos(),
    a("caja.corte", "Caja", "Corte con retiro", NO, NO).p().propia(0),
    a("caja.no_venta", "Caja", "No venta (abrir la gaveta con motivo)", SI, NO).p().propia(L_CANTIDAD).todos(),
    a("caja.gaveta_sin_venta", "Caja", "Abrir la gaveta con orden del dueño", P::PIN, NO).p().propia(0).dueno(P::PIN).con_pin(),
    a("caja.historial", "Caja", "Historial de cierres y aperturas de gaveta", NO, NO).p(),
    a("caja.reimprimir_z", "Caja", "Reimprimir un cierre Z", P::PIN, NO).p().propia(0).dueno(P::PIN).con_pin(),
    a("caja.corregir_dia", "Caja", "Corregir la fecha de negocio", NO, NO).p().propia(0).dueno(P::PIN_MOTIVO).con_pin(),
    a("caja.consecutivo", "Caja", "Número inicial del consecutivo", NO, SI).sensible(),
    a("caja.opciones", "Caja", "Opciones de caja y cierre", NO, SI).sensible(),
    // Apartados y crédito
    a("cuentas.crear", "Apartados y crédito", "Crear y buscar apartados", SI, NO).p(),
    a("cuentas.abonar", "Apartados y crédito", "Recibir abonos y entregar", SI, NO).p(),
    a("cuentas.ver_todas", "Apartados y crédito", "Ver todas las cuentas y estados de cuenta", NO, NO).p(),
    a("cuentas.cancelar", "Apartados y crédito", "Cancelar un apartado", NO, NO).p().propia(L_MONTO).dueno(P::PIN_MOTIVO).todos().monto_o_pin(),
    a("cuentas.anular_abono", "Apartados y crédito", "Anular un abono", NO, NO).p().propia(L_MONTO).dueno(P::PIN_MOTIVO).todos().monto_o_pin(),
    a("cuentas.ajustar", "Apartados y crédito", "Ajustar el saldo", NO, NO).p().propia(0).dueno(P::PIN_MOTIVO).con_pin(),
    a("cuentas.condonar", "Apartados y crédito", "Condonar el saldo", NO, NO).p().propia(L_MONTO).dueno(P::PIN_MOTIVO).todos().monto_o_pin(),
    a("cuentas.prorrogar", "Apartados y crédito", "Prorrogar la fecha límite", NO, NO).p().propia(0).dueno(P::PIN_MOTIVO).con_pin(),
    a("credito.vender", "Apartados y crédito", "Vender a crédito", SI, NO).p(),
    a("credito.limite", "Apartados y crédito", "Límites y opciones de crédito", NO, NO).p().propia(0).dueno(P::PIN).con_pin(),
    a("cuentas.opciones", "Apartados y crédito", "Opciones de apartados y crédito", NO, SI).sensible(),
    // Proformas
    a("proformas.crear", "Proformas", "Crear, buscar e imprimir proformas", SI, NO).p(),
    a("proformas.convertir", "Proformas", "Pasar una proforma a venta", SI, NO).p(),
    a("proformas.anular", "Proformas", "Anular una proforma", NO, NO).p(),
    a("proformas.admin", "Proformas", "Reporte de proformas", NO, NO).p(),
    a("proformas.opciones", "Proformas", "Opciones de proformas", NO, SI),
    // Productos
    a("productos.crear", "Productos", "Crear productos y códigos", NO, SI).sensible(),
    a("productos.editar", "Productos", "Editar productos", NO, SI).sensible(),
    a("productos.precio", "Productos", "Cambiar precios de venta y descuentos fijos", NO, NO).sensible(),
    a("productos.desactivar", "Productos", "Desactivar productos", NO, SI).sensible(),
    a("productos.favoritos", "Productos", "Favoritos", NO, SI),
    a("productos.etiquetas", "Productos", "Imprimir etiquetas", NO, SI),
    a("productos.importar", "Productos", "Importar CSV", NO, SI).sensible(),
    a("departamentos.editar", "Productos", "Editar departamentos (nombre, orden, color)", NO, SI),
    a("departamentos.estructura", "Productos", "Crear departamentos y cambiar su código", NO, SI).dueno(P::NO),
    // Inventario
    a("inventario.ver", "Inventario", "Ver existencias y kardex", NO, NO).p(),
    a("inventario.costos", "Inventario", "Ver costos, valor del inventario y utilidad", NO, NO).sensible(),
    a("inventario.entradas", "Inventario", "Entradas de mercadería y proveedores", NO, NO).p(),
    a("inventario.ajustes", "Inventario", "Ajustes de inventario", NO, NO).p(),
    a("inventario.conteo", "Inventario", "Conteo físico y carga inicial", NO, NO).p(),
    a("inventario.reportes", "Inventario", "Reportes de inventario", NO, NO).p(),
    a("inventario.opciones", "Inventario", "Opciones de inventario", NO, NO).p(),
    // Clientes
    a("clientes.crear", "Clientes", "Buscar y crear clientes (nombre, teléfono, cédula)", SI, NO).p(),
    a("clientes.ver_todos", "Clientes", "Ver la lista y los datos completos", NO, NO).p(),
    a("clientes.editar", "Clientes", "Editar clientes", NO, NO).p(),
    a("clientes.exportar", "Clientes", "Exportar los datos de un cliente", NO, NO).p(),
    a("clientes.anonimizar", "Clientes", "Anonimizar un cliente", NO, NO).p().propia(0).dueno(P::PIN_MOTIVO).con_pin(),
    // Reportes
    a("reportes.ver", "Reportes", "Reportes de ventas", NO, NO).p(),
    // Administración
    a("usuarios.administrar", "Administración", "Usuarios", NO, SI).fija(),
    a("negocio.contacto", "Administración", "Datos de contacto del negocio", NO, SI),
    a("negocio.legal", "Administración", "Datos legales y logo", NO, SI).dueno(P::NO),
    a("pagos.formas", "Administración", "Formas de pago y bancos", NO, SI).sensible().dueno(P::NO),
    a("impresoras.configurar", "Administración", "Configurar impresoras y gaveta", NO, SI).dueno(P::NO),
    a("impresoras.asignar", "Administración", "Asignar y probar impresoras", NO, SI),
    a("config.tecnica", "Administración", "Configuración técnica", NO, SI).fija().dueno(P::NO),
    a("respaldo.crear", "Administración", "Respaldo", NO, NO).p(),
    a("respaldo.restaurar", "Administración", "Restaurar un respaldo", NO, NO).p().propia(0).dueno(P::PIN).con_pin(),
    a("bitacora.ver", "Administración", "Ver la bitácora", NO, SI),
    a("seguridad.editar", "Administración", "Editar permisos", NO, SI).fija(),
    a("seguridad.inactividad", "Administración", "Tiempo de bloqueo por inactividad", NO, SI).fija(),
    a("sistema.preparar", "Administración", "Preparar para el cliente y diagnóstico", NO, SI).fija().dueno(P::NO),
];

pub fn buscar(id: &str) -> Option<&'static Accion> {
    CATALOGO.iter().find(|a| a.id == id)
}

/// A qué corresponde cada comando de la app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Destino {
    /// Funciona sin sesión (lista cerrada).
    SinSesion,
    /// Cualquier usuario con sesión.
    CualquierSesion,
    Accion(&'static str),
    /// Depende de un argumento (clave de config, operación, documento, carpeta, campos, usuario).
    SegunArgumento,
}

use Destino::{Accion as Ac, CualquierSesion, SegunArgumento, SinSesion};

pub static COMANDOS: &[(&str, Destino)] = &[
    ("sistema_estado", SinSesion),
    ("sistema_crear_tecnico", SinSesion),
    ("sistema_restaurar", SinSesion),
    ("diagnostico_anotar", SinSesion),
    ("app_reiniciar", SinSesion),
    ("sesion_usuarios", SinSesion),
    ("sesion_iniciar", SinSesion),
    ("sesion_tecnico", SinSesion),
    ("sesion_actual", SinSesion),
    ("sesion_cerrar", SinSesion),
    ("sesion_tocar", SinSesion),
    ("sesion_estado", SinSesion),
    ("sesion_permisos", CualquierSesion),
    ("prueba_avanzar_reloj", SinSesion),
    ("seguridad_autorizar", CualquierSesion),
    ("avisos_dueno", CualquierSesion),
    ("avisos_anulaciones_vistas", CualquierSesion),
    ("seguridad_obtener", Ac("seguridad.editar")),
    ("seguridad_diferencias", Ac("seguridad.editar")),
    ("seguridad_plantilla", Ac("seguridad.editar")),
    ("seguridad_guardar", Ac("seguridad.editar")),
    ("seguridad_historial", Ac("seguridad.editar")),
    ("seguridad_version", Ac("seguridad.editar")),
    ("seguridad_volver", Ac("seguridad.editar")),
    ("seguridad_inactividad", Ac("seguridad.inactividad")),
    ("bd_leer", CualquierSesion),
    ("bd_lote", SegunArgumento),
    ("impresora_ajustes", CualquierSesion),
    ("usuarios_listar", Ac("usuarios.administrar")),
    ("usuarios_crear", Ac("usuarios.administrar")),
    ("usuarios_editar", SegunArgumento),
    ("usuarios_cambiar_pin", SegunArgumento),
    ("usuarios_codigo_recuperacion", CualquierSesion),
    ("usuarios_eliminar", SegunArgumento),
    ("config_guardar", SegunArgumento),
    ("negocio_guardar", SegunArgumento),
    ("negocio_logo", Ac("negocio.legal")),
    ("bitacora_listar", Ac("bitacora.ver")),
    ("bitacora_verificar", Ac("bitacora.ver")),
    ("caja_estado", Ac("caja.ver")),
    ("caja_abrir", Ac("caja.abrir")),
    ("caja_queda", Ac("caja.cerrar")),
    ("caja_corregir_dia", Ac("caja.corregir_dia")),
    ("caja_movimiento", SegunArgumento),
    ("caja_detalle", Ac("caja.ver")),
    ("caja_necesita_nota", Ac("caja.cerrar")),
    ("caja_cerrar", Ac("caja.cerrar")),
    ("caja_reabrir", Ac("caja.reabrir")),
    ("caja_consecutivo", Ac("caja.consecutivo")),
    ("caja_revisada", Ac("caja.historial")),
    ("caja_z", Ac("caja.cerrar")),
    ("caja_z_imprimir", Ac("caja.cerrar")),
    ("caja_nota_cierre", Ac("caja.cerrar")),
    ("caja_corte", Ac("caja.corte")),
    ("caja_turnos", Ac("caja.ver")),
    ("gaveta_venta", Ac("venta.vender")),
    ("gaveta_abono", Ac("cuentas.abonar")),
    ("gaveta_no_venta", Ac("caja.no_venta")),
    ("gaveta_cierre", Ac("caja.cerrar")),
    ("gaveta_dueno", Ac("caja.gaveta_sin_venta")),
    ("gaveta_aperturas", Ac("caja.historial")),
    ("venta_esperas", Ac("venta.vender")),
    ("venta_espera_crear", Ac("venta.vender")),
    ("venta_espera_guardar", Ac("venta.vender")),
    ("venta_espera_descartar", Ac("venta.descartar_espera")),
    ("venta_autorizar_descuento", Ac("venta.descuento")),
    ("venta_faltantes", Ac("venta.vender")),
    ("venta_referencia_usada", Ac("venta.vender")),
    ("venta_cobrar", Ac("venta.vender")),
    ("venta_obtener", Ac("ventas.ver")),
    ("venta_listar_dia", Ac("ventas.ver")),
    ("venta_listar_turno", Ac("ventas.ver")),
    ("venta_imprimir", Ac("ventas.reimprimir")),
    ("venta_correcciones", Ac("ventas.ver")),
    ("venta_corregir_pago", Ac("ventas.cambiar_pago")),
    ("venta_anular", Ac("ventas.anular")),
    ("venta_pendientes_factura", Ac("facturas.ver")),
    ("venta_pedir_factura", Ac("facturas.ver")),
    ("venta_marcar_factura", Ac("facturas.marcar")),
    ("cliente_crear", Ac("clientes.crear")),
    ("cliente_buscar", Ac("clientes.crear")),
    ("cliente_basico", Ac("clientes.crear")),
    ("cliente_dato_factura", Ac("facturas.ver")),
    ("cliente_tiene_correo", Ac("facturas.ver")),
    ("cliente_listar", Ac("clientes.ver_todos")),
    ("cliente_obtener", Ac("clientes.ver_todos")),
    ("cliente_editar", Ac("clientes.editar")),
    ("cliente_cuentas_saldo", Ac("clientes.ver_todos")),
    ("cliente_exportar", Ac("clientes.exportar")),
    ("cliente_anonimizar", Ac("clientes.anonimizar")),
    ("cliente_retencion", Ac("clientes.ver_todos")),
    ("cuentas_reglas", Ac("cuentas.crear")),
    ("cuenta_crear_apartado", Ac("cuentas.crear")),
    ("cuenta_abonar", Ac("cuentas.abonar")),
    ("cuenta_entregar", Ac("cuentas.abonar")),
    ("cuenta_buscar", Ac("cuentas.crear")),
    ("cuenta_obtener", Ac("cuentas.crear")),
    ("cuenta_imprimir", Ac("cuentas.crear")),
    ("cuenta_listar", Ac("cuentas.ver_todas")),
    ("cuenta_vencidas", Ac("cuentas.ver_todas")),
    ("cuenta_cancelar", Ac("cuentas.cancelar")),
    ("cuenta_ajustar", Ac("cuentas.ajustar")),
    ("cuenta_condonar", Ac("cuentas.condonar")),
    ("cuenta_prorrogar", Ac("cuentas.prorrogar")),
    ("abono_anular", Ac("cuentas.anular_abono")),
    ("cliente_limite_credito", Ac("credito.limite")),
    ("cliente_limite_obtener", Ac("credito.limite")),
    ("cliente_estado_cuenta", Ac("cuentas.ver_todas")),
    ("credito_disponible", Ac("credito.vender")),
    ("credito_opciones", Ac("credito.limite")),
    ("credito_guardar_opciones", Ac("credito.limite")),
    ("proforma_guardar", Ac("proformas.crear")),
    ("proforma_buscar", Ac("proformas.crear")),
    ("proforma_obtener", Ac("proformas.crear")),
    ("proforma_imprimir", Ac("proformas.crear")),
    ("proforma_anular", Ac("proformas.anular")),
    ("proforma_abrir", Ac("proformas.convertir")),
    ("proforma_reporte", Ac("proformas.admin")),
    ("reporte_rangos", Ac("reportes.ver")),
    ("reporte_ventas", Ac("reportes.ver")),
    ("respaldo_crear", Ac("respaldo.crear")),
    ("respaldo_ultimo", Ac("respaldo.crear")),
    ("respaldo_auto_configurar", Ac("respaldo.crear")),
    ("respaldo_auto_estado", Ac("respaldo.crear")),
    ("respaldo_auto_ahora", Ac("respaldo.crear")),
    ("respaldo_usb_confirmado", Ac("respaldo.crear")),
    ("respaldo_restaurar", Ac("respaldo.restaurar")),
    ("guardar_descarga", SegunArgumento),
    ("diagnostico_exportar", Ac("sistema.preparar")),
    ("sistema_preparacion", Ac("sistema.preparar")),
    ("importacion_leer", Ac("productos.importar")),
    ("importacion_aplicar", Ac("productos.importar")),
    ("inventario_lista", Ac("inventario.ver")),
    ("inventario_estado", Ac("inventario.ver")),
    ("inventario_existencia", Ac("venta.ver_existencia")),
    ("inventario_alertas", Ac("inventario.ver")),
    ("inventario_producto", Ac("inventario.opciones")),
    ("inventario_kardex", Ac("inventario.ver")),
    ("inventario_entrada", Ac("inventario.entradas")),
    ("inventario_entrada_obtener", Ac("inventario.entradas")),
    ("inventario_ajustar", Ac("inventario.ajustes")),
    ("inventario_conteo_abierto", Ac("inventario.conteo")),
    ("inventario_conteo_guardar", Ac("inventario.conteo")),
    ("inventario_conteo_diferencias", Ac("inventario.conteo")),
    ("inventario_conteo_aplicar", Ac("inventario.conteo")),
    ("inventario_conteo_descartar", Ac("inventario.conteo")),
    ("inventario_inicial", Ac("inventario.conteo")),
    ("inventario_reporte_bajo_minimo", Ac("inventario.reportes")),
    ("inventario_reporte_valorizado", Ac("inventario.reportes")),
    ("inventario_reporte_movimientos", Ac("inventario.reportes")),
    ("proveedores_listar", Ac("inventario.entradas")),
    ("proveedor_guardar", Ac("inventario.entradas")),
    ("proveedor_eliminar", Ac("inventario.entradas")),
    ("impresoras_listar", Ac("impresoras.asignar")),
    ("impresoras_detectar", Ac("impresoras.configurar")),
    ("impresora_guardar", Ac("impresoras.configurar")),
    ("impresora_eliminar", Ac("impresoras.configurar")),
    ("impresora_asignar", Ac("impresoras.asignar")),
    ("impresora_probar", Ac("impresoras.asignar")),
    ("imprimir", SegunArgumento),
    ("list_printers", Ac("impresoras.configurar")),
    ("print_raw", Ac("impresoras.configurar")),
];

pub fn destino(cmd: &str) -> Option<Destino> {
    COMANDOS.iter().find(|(c, _)| *c == cmd).map(|(_, d)| *d)
}
