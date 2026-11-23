// Generado desde Rust (src-tauri/src/tipos_ts.rs). No editar a mano.
import type { GrupoProformas } from "./GrupoProformas";
import type { ProformaFila } from "./ProformaFila";
export type ReporteProformas = { emitidas: GrupoProformas, convertidas: GrupoProformas, vencidas: GrupoProformas, anuladas: GrupoProformas, vigentes: GrupoProformas, 
/**
 * Las versiones reemplazadas no cuentan: cada número cuenta una vez, con su última versión.
 */
filas: Array<ProformaFila>, };
