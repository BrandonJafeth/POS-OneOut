// Comprobantes de apartados y crédito en la impresora de tiquetes: el del apartado (al crearlo), el
// de cada abono (con el saldo restante) y el de la cancelación. Fecha y hora REAL. La reimpresión
// lleva "*** COPIA ***" (Rust la cuenta y la anota). El tiquete final al liquidar es el de la venta.
import type { CuentaDetalle } from "../../db/cuentas";
import type { Negocio } from "../../tipos";
import { EscPos } from "../escpos";
import { escribirAvisoCorto, escribirEncabezado, escribirPie } from "../impresion";
import { columnas, cortar, fechaHora, lr, lrLargo, monto, sep, sep2, type Doc, type TicketSettings, wrap } from "../tickets";

/** "credito": la venta a crédito (además del tiquete), con condiciones y línea de firma del cliente. */
export type TipoComprobante = "apartado" | "abono" | "cancelacion" | "credito";

export interface OpcionesComprobante {
  tipo: TipoComprobante;
  copia?: boolean;
  /** Abono que se está comprobando (id de su operación): sus filas, recibido y vuelto. */
  operacionId?: string | null;
  condiciones?: string;
  avisoPrivacidad?: boolean;
  textoNoFactura?: string;
}

const fechaCorta = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

export function comprobanteCuenta(n: Negocio, d: CuentaDetalle, s: TicketSettings, o: OpcionesComprobante): Doc {
  const c = columnas(s);
  const k = d.cuenta;
  const credito = k.tipo === "credito";
  const p = new EscPos(s.codePage, { sinModoChino: s.sinModoChino });
  escribirEncabezado(p, n, c);
  p.line(sep2(c));
  if (o.copia) p.align("center").bold(true).line("*** COPIA ***").bold(false).align("left");
  const titulo = o.tipo === "cancelacion" ? "APARTADO CANCELADO" : o.tipo === "abono" ? "ABONO" : credito ? "CRÉDITO" : "APARTADO";
  p.align("center").bold(true).size(true, true).line(k.numero).size(false, false).line(titulo).bold(false);
  // El número grande es la forma principal de buscarlo; el CODE128 solo si la impresora lo tiene probado.
  if (s.code128 && k.numero) p.barcode128(k.numero);
  p.align("left");
  p.line(lr("Fecha:", fechaHora(new Date()), c));
  wrap("Cliente: " + k.cliente, c).forEach((l) => p.line(l));
  if (k.descripcion) wrap("Detalle: " + k.descripcion, c).forEach((l) => p.line(l));
  p.line(sep(c));
  const conDetalle = o.tipo === "apartado" || o.tipo === "credito";
  if (conDetalle) {
    for (const l of d.lineas) {
      wrap(l.descripcion, c).forEach((w) => p.line(w));
      p.line(lr(`  ${l.cantidad} x ${monto(l.precioUnitario)}`, monto(l.cantidad * l.precioUnitario), c));
      if (l.descuento) p.line(lr("  Descuento", "-" + monto(l.descuento), c));
    }
    if (d.descuento) p.line(lr("Descuento", "-" + monto(d.descuento), c));
    p.line(sep(c));
  }
  if (o.tipo === "credito") {
    // La cuenta guarda lo que quedó por cobrar; el total y lo pagado hoy salen de la venta.
    const venta = d.ventaTotal ?? k.total;
    p.bold(true).line(lr("TOTAL", monto(venta), c)).bold(false);
    p.line(lr("Pagado hoy", monto(venta - k.total), c));
  } else {
    p.bold(true).line(lr("TOTAL", monto(k.total), c)).bold(false);
  }
  if (o.tipo === "abono" || o.tipo === "apartado") {
    const filas = d.abonos.filter((a) => !a.anulado && (o.operacionId ? a.operacionId === o.operacionId : false));
    for (const a of filas) lrLargo(`Abono ${a.forma}${a.referencia ? ` ref ${a.referencia}` : ""}`, monto(a.monto), c).forEach((l) => p.line(l));
    const recibido = filas.filter((a) => a.recibido != null).reduce((x, a) => x + (a.recibido ?? 0), 0);
    const vuelto = filas.reduce((x, a) => x + (a.vuelto ?? 0), 0);
    if (vuelto) {
      p.line(lr("  Recibido", monto(recibido), c));
      p.line(lr("  Vuelto", monto(vuelto), c));
    }
  }
  if (o.tipo === "cancelacion") {
    p.line(lr("Abonado", monto(k.abonado), c));
    p.line(lr("Devuelto", monto(d.devuelto), c));
    if (d.retenido) p.line(lr("Retenido", monto(d.retenido), c));
  } else {
    if (o.tipo !== "credito") p.line(lr("Total abonado", monto(k.abonado), c));
    p.bold(true).line(lr("SALDO", monto(k.saldo), c)).bold(false);
    if (k.saldo > 0 && k.fechaLimite) p.line(lr(credito ? "Pagar antes del:" : "Retirar antes del:", fechaCorta(k.fechaLimite), c));
  }
  p.line(lr("Atendió:", cortar(d.usuario, c - 9), c));
  p.line(sep2(c));
  if (conDetalle && o.condiciones?.trim()) {
    wrap(o.condiciones.trim(), c).forEach((l) => p.line(l));
    p.line(sep(c));
  }
  if (o.tipo === "credito") {
    p.line("").line("").line("_".repeat(Math.min(c, 30))).line("Firma del cliente");
    p.line(sep(c));
  }
  if (conDetalle && o.avisoPrivacidad) escribirAvisoCorto(p, n, c);
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
