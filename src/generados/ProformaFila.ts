// Generado desde Rust (src-tauri/src/tipos_ts.rs). No editar a mano.
export type ProformaFila = { id: string, numero: string, 
/**
 * vigente, vencida, convertida, anulada o reemplazada.
 */
estado: string, clienteId: string | null, 
/**
 * Cliente guardado o nombre escrito (None: sin nombre o ya borrado).
 */
cliente: string | null, fecha: string, vence: string, total: number, usuario: string, 
/**
 * Venta o apartado al que se convirtió.
 */
convertidaEn: string | null, };
