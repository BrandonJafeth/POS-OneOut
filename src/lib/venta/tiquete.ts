// Tiquete de venta (32 columnas en 58 mm, 48 en 80 mm; ¢ en lugar de ₡). Reutiliza encabezado/pie
// de lib/impresion.ts. No lleva el pulso de la gaveta: la gaveta la abre Rust (gaveta_venta).
//
// Pago dividido: después del TOTAL va una línea por pago con su forma, banco, referencia y monto
// ("SINPE Móvil BCR ref 69898 ¢200", "Efectivo ¢300"); si hubo efectivo, el recibido y el vuelto.
import type { Negocio, Venta, VentaPago } from "../../tipos";
import { EscPos } from "../escpos";
import { escribirEncabezado, escribirPie } from "../impresion";
import { columnas, cortar, fechaHora, lr, lrLargo, monto, sep, sep2, type Doc, type TicketSettings, wrap } from "../tickets";

export interface OpcionesTiquete {
  copia?: boolean;
  textoNoFactura?: string;
  /** Nombre del cliente o "nombre en tiquete". null = no se imprime. */
  nombreCliente?: string | null;
  /** Línea "IVA incluido" (config mostrar_iva; no en régimen simplificado). */
  mostrarIva?: boolean;
}

/** "SINPE Móvil BCR ref 69898", "Tarjeta ****1234", "Efectivo". */
export function descripcionPago(pg: Pick<VentaPago, "forma" | "banco" | "referencia" | "ultimos4">): string {
  return [pg.forma, pg.banco, pg.referencia && `ref ${pg.referencia}`, pg.ultimos4 && `****${pg.ultimos4}`].filter(Boolean).join(" ");
}

/** Líneas de pago del tiquete (también las usa la vista en pantalla). */
export function lineasPago(v: Pick<Venta, "pagos">): { texto: string; monto: number; sub?: boolean }[] {
  const out: { texto: string; monto: number; sub?: boolean }[] = [];
  for (const pg of v.pagos) out.push({ texto: descripcionPago(pg), monto: pg.monto });
  const efectivo = v.pagos.filter((pg) => pg.recibido != null);
  const recibido = efectivo.reduce((s, pg) => s + (pg.recibido ?? 0), 0);
  const vuelto = efectivo.reduce((s, pg) => s + (pg.vuelto ?? 0), 0);
  if (efectivo.length && (vuelto || v.pagos.length > 1)) {
    out.push({ texto: "Recibido", monto: recibido, sub: true });
    out.push({ texto: "Vuelto", monto: vuelto, sub: true });
  }
  return out;
}

export function tiqueteVenta(n: Negocio, v: Venta, s: TicketSettings, o: OpcionesTiquete = {}): Doc {
  const c = columnas(s);
  const p = new EscPos(s.codePage, { sinModoChino: s.sinModoChino });
  escribirEncabezado(p, n, c);
  p.line(sep2(c));
  if (o.copia) p.align("center").bold(true).line("*** COPIA ***").bold(false).align("left");
  if (v.estado === "anulada") p.align("center").bold(true).line("*** ANULADO ***").bold(false).align("left");
  p.line(lr("Tiquete:", v.numero, c));
  p.line(lr("Fecha:", fechaHora(new Date(v.fecha)), c));
  p.line(lr("Cajero:", cortar(v.cajero, c - 8), c));
  if (o.nombreCliente) wrap("Cliente: " + o.nombreCliente, c).forEach((l) => p.line(l));
  p.line(sep(c));
  for (const l of v.lineas) {
    wrap(l.descripcion, c).forEach((w) => p.line(w));
    p.line(lr(`  ${l.cantidad} x ${monto(l.precioUnitario)}`, monto(l.cantidad * l.precioUnitario), c));
    if (l.descuento) p.line(lr("  Descuento", "-" + monto(l.descuento), c));
  }
  p.line(sep(c));
  if (v.descuento || v.redondeo || v.lineas.some((l) => l.descuento)) p.line(lr("Subtotal", monto(v.subtotal), c));
  if (v.descuento) p.line(lr("Descuento", "-" + monto(v.descuento), c));
  if (v.redondeo) p.line(lr("Redondeo", (v.redondeo < 0 ? "-" : "") + monto(Math.abs(v.redondeo)), c));
  p.bold(true).line(lr("TOTAL", monto(v.total), c)).bold(false);
  for (const x of lineasPago(v)) lrLargo(x.sub ? `  ${x.texto}` : x.texto, monto(x.monto), c).forEach((l) => p.line(l));
  if (o.mostrarIva && v.ivaTotal) p.line(lr("IVA incluido", monto(v.ivaTotal), c));
  p.line(sep2(c));
  if (o.textoNoFactura?.trim()) {
    p.align("center");
    wrap(o.textoNoFactura.trim(), c).forEach((l) => p.line(l));
    p.align("left");
  }
  escribirPie(p, n, c);
  p.feed(4);
  if (s.cortador) p.cut();
  return { bytes: p.bytes(), missing: [...p.missing] };
}
