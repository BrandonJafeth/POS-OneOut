// Venta: ventas en espera, cobro, consulta, reimpresión, corrección de pago, anulación y
// pendientes de factura. Todo lo decide Rust (src-tauri/src/ventas.rs): totales, descuentos y su
// autorización, pagos, consecutivo, turno de caja. La pantalla calcula lo mismo solo para mostrarlo.
import type { Actor, EstadoEspera, PagoEntrada, Venta, VentaEspera } from "../tipos";
import { invocar } from "../lib/invocar";

// ─────────── Ventas en espera ───────────

export function listarEsperas(): Promise<VentaEspera[]> {
  return invocar<VentaEspera[]>("venta_esperas");
}

/** Nueva pestaña: Rust toma el número libre más bajo (1, 2, 3…) dentro de la transacción. */
export function crearEspera(_actor: Actor, estado: EstadoEspera): Promise<VentaEspera> {
  return invocar<VentaEspera>("venta_espera_crear", { estado });
}

/** Se llama en cada cambio de la venta: si se va la luz, queda lo último. */
export async function guardarEspera(id: string, estado: EstadoEspera): Promise<void> {
  await invocar("venta_espera_guardar", { id, estado });
}

export async function descartarEspera(_actor: Actor, id: string): Promise<void> {
  await invocar("venta_espera_descartar", { id });
}

/**
 * El dueño autoriza un descuento sobre el tope con su PIN. Rust devuelve un token de un solo uso
 * para ESA venta y ese porcentaje; el PIN no se guarda en ningún lado.
 */
export function autorizarDescuento(esperaId: string, pct: number, pin: string): Promise<{ duenoId: string; pct: number; token: string }> {
  return invocar("venta_autorizar_descuento", { esperaId, pct, pin });
}

// ─────────── Cobro ───────────

export interface ResultadoCobro {
  ventaId: string;
  numero: string;
  vuelto: number;
  hayEfectivo: boolean;
  /** Hay efectivo y la caja abre la gaveta con las ventas: pedir gaveta_venta después de imprimir. */
  abrirGaveta: boolean;
}

/** Rust rechaza el cobro con este prefijo si falta existencia y la configuración no deja vender sin ella. */
export const SIN_EXISTENCIA = "SIN_EXISTENCIA: ";

/** Productos de la venta que no alcanzan (vacío si se permite vender sin existencia). */
export const faltantesVenta = (lineas: { productoId?: string | null; cantidad: number }[]) =>
  invocar<string[]>("venta_faltantes", { lineas: lineas.map((l) => [l.productoId ?? null, l.cantidad]) });

/** Tiquete que ya usó esa referencia con esa forma de pago ("A12 del 2026-11-10"), o null. */
export const referenciaUsada = (formaPagoId: string, referencia: string) => invocar<string | null>("venta_referencia_usada", { formaPagoId, referencia });

/** Sin caja abierta de hoy, Rust lo rechaza ("La caja está cerrada…"). */
export function cobrarVenta(_actor: Actor, esperaId: string, estado: EstadoEspera, pagos: PagoEntrada[], pinExistencia?: string): Promise<ResultadoCobro> {
  return invocar<ResultadoCobro>("venta_cobrar", { esperaId, estado, pagos, pinExistencia: pinExistencia ?? null });
}

// ─────────── Consultas ───────────

export function obtenerVenta(id: string): Promise<Venta | null> {
  return invocar<Venta | null>("venta_obtener", { id });
}

export interface VentaResumen {
  id: string;
  numero: string;
  fecha: string;
  total: number;
  estado: string;
  cajero: string;
  requiereFactura: boolean;
  facturaEmitida: boolean;
  formas: string;
  turnoAbierto: boolean;
  /** Descripciones de las líneas, separadas por " · ". */
  productos: string;
  articulos: number;
}

export function listarVentasDia(dia: string): Promise<VentaResumen[]> {
  return invocar<VentaResumen[]>("venta_listar_dia", { dia });
}

export interface Correccion {
  fecha: string;
  motivo: string;
  antes: string;
  despues: string;
  usuario: string;
  /** "turno": se corrigió el pago; "ajuste": el turno ya estaba cerrado y quedó como ajuste. */
  donde: "turno" | "ajuste";
}

export function correccionesDe(ventaId: string): Promise<Correccion[]> {
  return invocar<Correccion[]>("venta_correcciones", { ventaId });
}

// ─────────── Corrección de forma de pago ───────────

export interface CambioPago {
  formaPagoId: string;
  bancoId?: string | null;
  referencia?: string | null;
  ultimos4?: string | null;
  telefono?: string | null;
}

/**
 * Cambia la forma de pago (el monto no cambia). Turno abierto: pide PIN del dueño solo si entra
 * o sale efectivo. Turno cerrado: solo el dueño con su PIN, y queda como ajuste en el turno de hoy.
 */
export async function corregirPago(_actor: Actor, pagoId: string, cambio: CambioPago, motivo: string, pinDueno?: string): Promise<void> {
  await invocar("venta_corregir_pago", {
    pagoId,
    cambio: { formaPagoId: cambio.formaPagoId, bancoId: cambio.bancoId ?? null, referencia: cambio.referencia ?? null, ultimos4: cambio.ultimos4 ?? null, telefono: cambio.telefono ?? null },
    motivo,
    pinDueno: pinDueno ?? null,
  });
}

// ─────────── Anulación ───────────

/**
 * Turno abierto: PIN del dueño y motivo. Turno cerrado: solo el dueño; `devolucionEfectivo`
 * (opcional) sale de la caja de hoy como salida.
 */
export async function anularVenta(_actor: Actor, ventaId: string, pin: string, motivo: string, devolucionEfectivo = 0): Promise<void> {
  await invocar("venta_anular", { ventaId, pin, motivo, devolucionEfectivo });
}

// ─────────── Factura electrónica externa ───────────

export interface PendienteFactura {
  ventaId: string;
  numero: string;
  fecha: string;
  total: number;
  clienteId: string;
  cliente: string;
  cedula: string | null;
  tieneCorreo: boolean;
}

export function pendientesFactura(_actor: Actor): Promise<PendienteFactura[]> {
  return invocar<PendienteFactura[]>("venta_pendientes_factura");
}

/** Una venta ya cobrada pasa a "Pendientes de factura" con ese cliente. */
export async function pedirFactura(_actor: Actor, ventaId: string, clienteId: string): Promise<void> {
  await invocar("venta_pedir_factura", { ventaId, clienteId });
}

export async function marcarFacturaEmitida(_actor: Actor, ventaId: string, referencia: string): Promise<void> {
  await invocar("venta_marcar_factura", { ventaId, referencia });
}
