// Totales de una venta. Todo en colones enteros:
//   importe de línea = cantidad × precio − descuento de línea
//   subtotal         = Σ importes
//   total            = redondear(subtotal − descuento al total, paso)   (paso = config redondeo_total)
//   redondeo         = total − (subtotal − descuento)                   (puede ser negativo)
// El redondeo es "al múltiplo más cercano" (₡5: 1.502 → 1.500, 1.503 → 1.505).
import type { EstadoEspera, LineaEspera } from "../../tipos";
import { ivaIncluido } from "../iva";
import { leerMontoEntero } from "../texto";

export function redondear(n: number, paso: number): number {
  if (!Number.isInteger(paso) || paso <= 1) return n;
  return Math.max(0, Math.round(n / paso) * paso);
}

export function bruto(l: LineaEspera): number {
  return l.cantidad * l.precioUnitario;
}

export function importeLinea(l: LineaEspera): number {
  return bruto(l) - l.descuento;
}

export interface Totales {
  bruto: number;
  descuentoLineas: number;
  subtotal: number;
  descuento: number;
  redondeo: number;
  total: number;
  iva: number;
  /** Descuento total (líneas + total) como % del bruto. */
  pctDescuento: number;
  /** IVA de cada línea, ya con su parte del descuento al total (informativo). */
  ivaLineas: number[];
}

/** Agrega una línea a la venta. El mismo producto, al mismo precio y sin descuento, suma
 *  cantidad en vez de repetir la línea. */
export function conLinea(e: EstadoEspera, l: LineaEspera): EstadoEspera {
  const igual = l.productoId ? e.lineas.find((x) => x.productoId === l.productoId && !x.descuento && x.precioUnitario === l.precioUnitario) : undefined;
  const lineas = igual ? e.lineas.map((x) => (x === igual ? { ...x, cantidad: x.cantidad + l.cantidad } : x)) : [...e.lineas, l];
  return { ...e, lineas };
}

/** Descuento en colones a partir de "500" (¢) o "10" (%) sobre `base`. null si no se entiende. */
export function leerDescuento(texto: string, base: number, modo: "¢" | "%"): number | null {
  const t = texto.trim();
  if (!t) return 0;
  if (modo === "%") {
    const n = Number(t.replace(",", "."));
    return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round((base * n) / 100) : null;
  }
  return leerMontoEntero(t);
}

export function calcularTotales(e: EstadoEspera, paso: number): Totales {
  const b = e.lineas.reduce((s, l) => s + bruto(l), 0);
  const descuentoLineas = e.lineas.reduce((s, l) => s + l.descuento, 0);
  const subtotal = b - descuentoLineas;
  const descuento = Math.max(0, Math.min(Math.round(e.descuentoTotal || 0), subtotal));
  const neto = subtotal - descuento;
  const total = redondear(neto, paso);
  // El descuento al total se reparte en proporción para calcular el IVA de cada línea.
  const factor = subtotal > 0 ? neto / subtotal : 0;
  const ivaLineas = e.lineas.map((l) => ivaIncluido(Math.round(importeLinea(l) * factor), l.tasaIva, l.exento));
  return {
    bruto: b,
    descuentoLineas,
    subtotal,
    descuento,
    redondeo: total - neto,
    total,
    iva: ivaLineas.reduce((s, x) => s + x, 0),
    pctDescuento: b > 0 ? ((descuentoLineas + descuento) / b) * 100 : 0,
    ivaLineas,
  };
}

/** % máximo que puede dar `rol` sin autorización (config descuento_max_pct). */
export function topeDescuento(rol: string, config: Record<string, number>): number {
  return config[rol] ?? 0;
}

/** ¿Hace falta el PIN del dueño? Sí, si el descuento pasa el tope del rol y no hay autorización que lo cubra. */
export function necesitaAutorizacion(e: EstadoEspera, pct: number, tope: number): boolean {
  const ε = 1e-9;
  if (pct <= tope + ε) return false;
  return !e.autorizacion || pct > e.autorizacion.pct + ε;
}

export function estadoVacio(): EstadoEspera {
  return { lineas: [], descuentoTotal: 0, cliente: null, nombreTiquete: null, requiereFactura: false, autorizacion: null };
}
