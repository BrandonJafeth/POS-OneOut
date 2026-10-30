/** Minúsculas, sin tildes ni diéresis, espacios simples. "Lápiz  HB" → "lapiz hb". La ñ pasa a n. */
export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Fecha ISO UTC actual (formato de todas las columnas *_en). */
export function ahoraIso(): string {
  return new Date().toISOString();
}

/** "1.500", "¢1500", "1500" → 1500. Devuelve null si no es un entero ≥ 0. */
export function leerMontoEntero(s: string): number | null {
  const limpio = s.replace(/[¢₡\s]/g, "").replace(/\./g, "");
  if (!/^\d+$/.test(limpio)) return null;
  const n = Number(limpio);
  return Number.isSafeInteger(n) ? n : null;
}

/** Día local "AAAA-MM-DD" (la jornada de la caja, en la hora de la computadora). */
export function diaLocal(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
