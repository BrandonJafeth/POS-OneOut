// Generado desde Rust (src-tauri/src/tipos_ts.rs). No editar a mano.
import type { Limites } from "./Limites";
import type { Nivel } from "./Nivel";
export type Politica = { nivel: Nivel, 
/**
 * Con PIN: además pide motivo.
 */
motivo: boolean, limites: Limites, };
