// Fechas de negocio (AAAA-MM-DD, sin husos) para los reportes.

const utc = (d: string) => new Date(`${d}T00:00:00Z`);

/** La misma fecha un año antes (como Rust: el 29 de febrero pasa al 28). */
export function haceUnAnio(d: string): string {
  const x = `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
  return x.endsWith("-02-29") ? x.replace(/29$/, "28") : x;
}

/** Días del rango, uno por uno (máximo 400). */
export function diasEntre(desde: string, hasta: string): string[] {
  const out: string[] = [];
  for (let t = utc(desde).getTime(), fin = utc(hasta).getTime(); t <= fin && out.length < 400; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Cambio contra `cuando` (las fechas comparadas): texto (no solo color) y dirección para el icono. */
export function variacion(ahora: number, antes: number, cuando: string): { texto: string; dir: 1 | -1 | 0 } | undefined {
  if (!antes) return ahora ? { texto: `Sin ventas para comparar (${cuando})`, dir: 0 } : undefined;
  const p = Math.round(((ahora - antes) / antes) * 100);
  return { texto: `${p > 0 ? "+" : p < 0 ? "−" : "±"}${Math.abs(p)} % vs. ${cuando}`, dir: p > 0 ? 1 : p < 0 ? -1 : 0 };
}
