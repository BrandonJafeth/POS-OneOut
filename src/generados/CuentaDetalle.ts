// Generado desde Rust (src-tauri/src/tipos_ts.rs). No editar a mano.
import type { AbonoFila } from "./AbonoFila";
import type { CuentaFila } from "./CuentaFila";
import type { CuentaLinea } from "./CuentaLinea";
import type { EventoFila } from "./EventoFila";
export type CuentaDetalle = { cuenta: CuentaFila, subtotal: number, descuento: number, redondeo: number, condonado: number, devuelto: number, retenido: number, 
/**
 * Total de la venta ligada (crédito: la venta a crédito; apartado: la liquidación).
 */
ventaTotal: number | null, ventaId: string | null, ventaNumero: string | null, usuario: string, lineas: Array<CuentaLinea>, abonos: Array<AbonoFila>, 
/**
 * Solo el dueño recibe el historial completo (ajustes, condonaciones, motivos).
 */
eventos: Array<EventoFila>, };
