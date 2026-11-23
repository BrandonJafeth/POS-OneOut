// Generado desde Rust (src-tauri/src/tipos_ts.rs). No editar a mano.
import type { ProformaFila } from "./ProformaFila";
import type { ProformaLinea } from "./ProformaLinea";
export type ProformaDetalle = { proforma: ProformaFila, subtotal: number, descuento: number, condiciones: string, lineas: Array<ProformaLinea>, reimpresiones: number, };
