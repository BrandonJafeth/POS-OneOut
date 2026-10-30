// IVA informativo (Costa Rica): los precios de venta YA incluyen el impuesto.
// No se emiten facturas electrónicas; esto solo deja el dato calculado en cada venta.

/** IVA contenido en `total` (colones enteros) a la tasa `tasa` %. Exento = 0. */
export function ivaIncluido(total: number, tasa: number, exento = false): number {
  if (exento || tasa <= 0) return 0;
  return Math.round((total * tasa) / (100 + tasa));
}

/** IVA total de una venta = suma del IVA de cada línea (así coincide con lo guardado por línea). */
export function ivaTotal(lineas: { total: number; tasaIva: number; exento?: boolean }[]): number {
  return lineas.reduce((s, l) => s + ivaIncluido(l.total, l.tasaIva, l.exento), 0);
}
