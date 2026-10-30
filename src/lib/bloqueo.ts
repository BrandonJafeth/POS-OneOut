// Límite de intentos de PIN: los primeros fallos son libres; desde el 5.º hay que esperar,
// y cada fallo extra duplica la espera (30 s, 1 min, 2 min… hasta 15 min).

export const INTENTOS_LIBRES = 4;
const ESPERA_BASE_MS = 30_000;
const ESPERA_MAX_MS = 15 * 60_000;

/** Espera que corresponde tras acumular `intentos` fallos seguidos (0 = ninguna). */
export function esperaTrasFallos(intentos: number): number {
  if (intentos <= INTENTOS_LIBRES) return 0;
  return Math.min(ESPERA_MAX_MS, ESPERA_BASE_MS * 2 ** (intentos - INTENTOS_LIBRES - 1));
}

/** Milisegundos que faltan para poder volver a intentar (0 = ya puede). */
export function esperaRestante(bloqueadoHasta: string | null, ahora = Date.now()): number {
  if (!bloqueadoHasta) return 0;
  return Math.max(0, Date.parse(bloqueadoHasta) - ahora);
}

export function formatoEspera(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

export const PIN_VALIDO = /^\d{4,8}$/;
