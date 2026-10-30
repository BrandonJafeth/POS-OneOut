// Conversión de una imagen (RGBA) a 1 bit para GS v 0.
// Formato de salida: filas de arriba a abajo, ancho redondeado hacia arriba a múltiplo de 8,
// MSB = punto de la izquierda, 1 = punto negro. Lo transparente cuenta como papel (blanco).
import type { LogoUnBit } from "../tipos";

/** 58 mm: 384 puntos de ancho útil; se dejan 368 (46 mm) para no tocar los bordes. */
export const LOGO_ANCHO_MAX = 368;

/** Tamaño final manteniendo proporción, sin pasar de `max` de ancho ni agrandar imágenes chicas. */
export function medidasLogo(ancho: number, alto: number, max = LOGO_ANCHO_MAX): { ancho: number; alto: number } {
  if (ancho <= max) return { ancho, alto };
  return { ancho: max, alto: Math.max(1, Math.round((alto * max) / ancho)) };
}

/**
 * @param umbral 0–255: un punto es negro si su luminancia es MENOR que el umbral.
 * @param invertir para logos claros sobre fondo oscuro (el fondo se volvería un bloque negro).
 */
export function aUnBit(rgba: ArrayLike<number>, ancho: number, alto: number, umbral = 128, invertir = false): LogoUnBit {
  if (rgba.length < ancho * alto * 4) throw new Error("Datos de imagen incompletos");
  const bpr = Math.ceil(ancho / 8);
  const bits = new Uint8Array(bpr * alto);
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const p = (y * ancho + x) * 4;
      const a = rgba[p + 3] / 255;
      // Mezcla con papel blanco según la transparencia y luminancia perceptual (Rec. 601).
      const lum = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) * a + 255 * (1 - a);
      const negro = invertir ? a > 0 && lum >= umbral : lum < umbral;
      if (negro) bits[y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { ancho: bpr * 8, alto, bits };
}

/** Umbral sugerido: punto medio entre el más claro y el más oscuro (opacos). */
export function umbralSugerido(rgba: ArrayLike<number>): number {
  let min = 255;
  let max = 0;
  for (let p = 0; p + 3 < rgba.length; p += 4) {
    if (rgba[p + 3] < 128) continue;
    const lum = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    if (lum < min) min = lum;
    if (lum > max) max = lum;
  }
  return max > min ? Math.round((min + max) / 2) : 128;
}
