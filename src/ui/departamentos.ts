// Colores de los departamentos (píldoras de la venta). Paleta de 12 colores distintos; el negocio
// puede cambiar el de cada departamento. El texto encima se elige solo: blanco o negro, el que dé
// más contraste. Con blanco puro y negro puro, cualquier color llega al menos a 4,58:1 (WCAG AA),
// y tests/tema.test.ts lo verifica para los 12 de la paleta y para colores al azar.
import type { Departamento } from "../tipos";
import { contraste } from "./tema";

export const PALETA_DEPARTAMENTOS: { color: string; nombre: string }[] = [
  { color: "#2563eb", nombre: "Azul" },
  { color: "#15803d", nombre: "Verde" },
  { color: "#ea580c", nombre: "Naranja" },
  { color: "#7e22ce", nombre: "Morado" },
  { color: "#f472b6", nombre: "Rosado" },
  { color: "#06b6d4", nombre: "Celeste" },
  { color: "#facc15", nombre: "Amarillo" },
  { color: "#92400e", nombre: "Café" },
  { color: "#9f1239", nombre: "Vino" },
  { color: "#84cc16", nombre: "Lima" },
  { color: "#1e3a8a", nombre: "Azul marino" },
  { color: "#475569", nombre: "Pizarra" },
];

const BLANCO = "#ffffff";
const NEGRO = "#000000";

/** Texto blanco o negro sobre `fondo`, el de más contraste (siempre ≥ 4,5:1). */
export function textoSobre(fondo: string): string {
  return contraste(BLANCO, fondo) >= contraste(NEGRO, fondo) ? BLANCO : NEGRO;
}

/** Config departamentos_color: cada uno con el suyo, todos de un color ("#rrggbb") o sin color. */
export type ModoColorDepartamentos = "cada_uno" | "ninguno" | string;

export const esColor = (c: string | null | undefined): c is string => !!c && /^#[0-9a-f]{6}$/i.test(c);

/** Fondo de la píldora en la venta según el modo; null = sin color (píldora neutra del tema). */
export function fondoPildora(d: Pick<Departamento, "color">, posicion: number, modo: ModoColorDepartamentos): string | null {
  if (modo === "ninguno") return null;
  if (esColor(modo)) return modo.toLowerCase();
  return colorDe(d, posicion);
}

/** Color del departamento: el guardado o, si no tiene, el de la paleta según su posición. */
export function colorDe(d: Pick<Departamento, "color">, posicion: number): string {
  if (esColor(d.color)) return d.color.toLowerCase();
  return PALETA_DEPARTAMENTOS[((posicion % 12) + 12) % 12].color;
}
