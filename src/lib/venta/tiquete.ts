// Tiquete de venta (POS-58, 32 columnas, ¢ en lugar de ₡). Reutiliza encabezado/pie de lib/impresion.ts.
import type { Negocio, Venta } from "../../tipos";
import { EscPos } from "../escpos";
import { escribirEncabezado, escribirPie } from "../impresion";
import { fechaHora, lr, monto, SEP, SEP2, type Doc, type TicketSettings, wrap } from "../tickets";

export interface OpcionesTiquete {
  copia?: boolean;
  textoNoFactura?: string;
  /** Pulso a la gaveta al final (solo original con efectivo y config abrir_gaveta_efectivo). */
  abrirGaveta?: boolean;
  /** Nombre del cliente o "nombre en tiquete". null = no se imprime. */
  nombreCliente?: string | null;
  /** Línea "IVA incluido" (config mostrar_iva; no en régimen simplificado). */
  mostrarIva?: boolean;
}

export function tiqueteVenta(n: Negocio, v: Venta, s: TicketSettings, o: OpcionesTiquete = {}): Doc {
  const p = new EscPos(s.codePage, { sinModoChino: s.sinModoChino });
  escribirEncabezado(p, n);
  p.line(SEP2);
  if (o.copia) p.align("center").bold(true).line("*** COPIA ***").bold(false).align("left");
  if (v.estado === "anulada") p.align("center").bold(true).line("*** ANULADO ***").bold(false).align("left");
  p.line(lr("Tiquete:", v.numero));
  p.line(lr("Fecha:", fechaHora(new Date(v.fecha))));
  p.line(lr("Cajero:", v.cajero.slice(0, 22)));
  if (o.nombreCliente) wrap("Cliente: " + o.nombreCliente).forEach((l) => p.line(l));
  p.line(SEP);
  for (const l of v.lineas) {
    wrap(l.descripcion).forEach((w) => p.line(w));
    p.line(lr(`  ${l.cantidad} x ${monto(l.precioUnitario)}`, monto(l.cantidad * l.precioUnitario)));
    if (l.descuento) p.line(lr("  Descuento", "-" + monto(l.descuento)));
  }
  p.line(SEP);
  if (v.descuento || v.redondeo || v.lineas.some((l) => l.descuento)) p.line(lr("Subtotal", monto(v.subtotal)));
  if (v.descuento) p.line(lr("Descuento", "-" + monto(v.descuento)));
  if (v.redondeo) p.line(lr("Redondeo", (v.redondeo < 0 ? "-" : "") + monto(Math.abs(v.redondeo))));
  p.bold(true).line(lr("TOTAL", monto(v.total))).bold(false);
  for (const pg of v.pagos) {
    const extra = pg.ultimos4 ? ` ****${pg.ultimos4}` : pg.banco ? ` ${pg.banco}` : "";
    p.line(lr((pg.forma + extra).slice(0, 20), monto(pg.recibido ?? pg.monto)));
  }
  const vuelto = v.pagos.reduce((x, pg) => x + (pg.vuelto ?? 0), 0);
  if (vuelto) p.line(lr("Vuelto", monto(vuelto)));
  if (o.mostrarIva && v.ivaTotal) p.line(lr("IVA incluido", monto(v.ivaTotal)));
  p.line(SEP2);
  if (o.textoNoFactura?.trim()) {
    p.align("center");
    wrap(o.textoNoFactura.trim()).forEach((l) => p.line(l));
    p.align("left");
  }
  escribirPie(p, n);
  p.feed(4);
  if (s.cortador) p.cut();
  if (o.abrirGaveta && !o.copia) p.drawer();
  return { bytes: p.bytes(), missing: [...p.missing] };
}
