// Generado desde Rust (src-tauri/src/tipos_ts.rs). No editar a mano.
export type Reglas = { usaApartados: boolean, usaCredito: boolean, 
/**
 * % del total que se abona al apartar (solo el primer abono).
 */
abonoMinimoPct: number, plazoDias: number, 
/**
 * "calendario" o "laborables".
 */
plazoTipo: string, 
/**
 * "devolver" o "retener" (saldo a favor queda diseñado, apagado).
 */
cancelacion: string, retencionPct: number, condiciones: string, 
/**
 * Crédito: plazo para pagar, cómo se cuentan los días y condiciones impresas. Los límites NO van
 * aquí (las reglas las ve el cajero): están en OpcionesCredito, solo para el dueño.
 */
creditoPlazoDias: number, creditoPlazoTipo: string, creditoCondiciones: string, };
