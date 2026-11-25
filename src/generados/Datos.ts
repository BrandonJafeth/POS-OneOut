// Generado desde Rust (src-tauri/src/tipos_ts.rs). No editar a mano.
import type { Inactividad } from "./Inactividad";
import type { Politica } from "./Politica";
export type Datos = { 
/**
 * Acción → política del cajero. Lo que no está: no permitido.
 */
cajero: { [key in string]?: Politica }, tecnico: { [key in string]?: Politica }, 
/**
 * Excepciones: usuario (cajero) → acción → política.
 */
usuarios: { [key in string]?: { [key in string]?: Politica } }, motivosAnulacion: Array<string>, umbralAvisoAnulaciones: number, 
/**
 * Comprobante de anulación también en las opciones A y B (en C siempre).
 */
comprobanteAnulacionAb: boolean, 
/**
 * Se confirmó la advertencia de dejar ver totales al cajero.
 */
verTotalesConfirmado: boolean, inactividad: Inactividad, };
