// Generado desde Rust (src-tauri/src/tipos_ts.rs). No editar a mano.
import type { AlPasar } from "./AlPasar";
export type Limites = { 
/**
 * Colones (monto de la venta, la salida, la línea…).
 */
montoMax: number | null, 
/**
 * Porcentaje de descuento (sin el descuento fijo del producto).
 */
pctMax: number | null, 
/**
 * Veces por turno abierto, por usuario.
 */
cantidadTurno: number | null, soloTurnoAbierto: boolean, 
/**
 * Minutos desde la venta (hora real).
 */
ventanaMin: number | null, alPasar: AlPasar, };
