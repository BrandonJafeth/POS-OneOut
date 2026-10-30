// Reporte Z (cierre de caja) y comprobante de movimiento, para la POS-58 (32 columnas, ¢).
// La reimpresión del Z sale marcada "COPIA" (Rust lleva la cuenta de impresiones).
import type { Detalle, Movimiento } from "../../db/caja";
import type { Negocio } from "../../tipos";
import { EscPos } from "../escpos";
import { escribirEncabezado } from "../impresion";
import { fechaHora, lr, monto, SEP, SEP2, type Doc, type TicketSettings, wrap } from "../tickets";

const signo = (n: number) => (n < 0 ? "-" : n > 0 ? "+" : "") + monto(Math.abs(n));

export function reporteZ(n: Negocio, d: Detalle, s: TicketSettings, o: { copia: boolean }): Doc {
  const { turno: t, resumen: r } = d;
  const p = new EscPos(s.codePage, { sinModoChino: s.sinModoChino });
  escribirEncabezado(p, n);
  p.line(SEP2);
  p.align("center").bold(true).line("CIERRE DE CAJA (Z)").bold(false);
  if (o.copia) p.bold(true).line("*** COPIA ***").bold(false);
  p.align("left");
  p.line(lr("Día:", t.dia));
  p.line(lr("Abrió:", `${t.usuarioApertura.slice(0, 12)} ${fechaHora(new Date(t.abiertoEn)).slice(-5)}`));
  if (t.cerradoEn) p.line(lr("Cerró:", `${(t.usuarioCierre ?? "").slice(0, 12)} ${fechaHora(new Date(t.cerradoEn)).slice(-5)}`));
  p.line(SEP);
  p.line(lr(`Ventas (${r.ventas})`, monto(r.totalVentas)));
  if (r.descuentos) p.line(lr("  Descuentos dados", monto(r.descuentos)));
  if (r.anuladas) p.line(lr(`Anuladas (${r.anuladas})`, monto(r.totalAnuladas)));
  p.line(SEP);
  p.bold(true).line("POR FORMA DE PAGO").bold(false);
  for (const f of r.porForma) p.line(lr(`${f.nombre.slice(0, 18)} (${f.pagos})`, monto(f.monto)));
  if (!r.porForma.length) p.line("  Sin cobros");
  p.line(SEP);
  p.bold(true).line("EFECTIVO").bold(false);
  p.line(lr("Fondo inicial", monto(r.fondo)));
  p.line(lr("Cobrado (recibido)", monto(r.recibidoEfectivo)));
  if (r.vueltos) p.line(lr("Vueltos", "-" + monto(r.vueltos)));
  if (r.entradas) p.line(lr("Entradas", "+" + monto(r.entradas)));
  if (r.salidas) p.line(lr("Salidas", "-" + monto(r.salidas)));
  if (d.veEsperado) p.bold(true).line(lr("Esperado", monto(r.efectivoEsperado))).bold(false);
  if (t.contado != null) p.bold(true).line(lr("Contado", monto(t.contado))).bold(false);
  if (d.veEsperado && t.diferencia != null) p.bold(true).line(lr(t.diferencia === 0 ? "Cuadra" : t.diferencia > 0 ? "Sobrante" : "Faltante", signo(t.diferencia))).bold(false);
  if (t.notaCierre) wrap("Nota: " + t.notaCierre).forEach((l) => p.line(l));
  if (r.movimientos.length) {
    p.line(SEP);
    p.bold(true).line("MOVIMIENTOS").bold(false);
    for (const m of r.movimientos) p.line(lr(`${m.tipo === "salida" ? "-" : "+"} ${m.categoria}`.slice(0, 20), monto(m.monto)));
  }
  if (r.ajustes.length) {
    p.line(SEP);
    p.bold(true).line("AJUSTES DE TURNOS ANTERIORES").bold(false);
    for (const a of r.ajustes) p.line(lr(`${a.tipo === "anulacion" ? "Anula" : "Pago"} ${a.ventaNumero}`.slice(0, 20), monto(a.monto)));
  }
  if (t.conteoFinal && Object.keys(t.conteoFinal).length) {
    p.line(SEP);
    p.bold(true).line("CONTEO").bold(false);
    for (const [den, cant] of Object.entries(t.conteoFinal).sort((a, b) => Number(b[0]) - Number(a[0])))
      p.line(lr(`  ${cant} x ${monto(Number(den))}`, monto(Number(den) * cant)));
  }
  if (d.bitacoraOk === false) {
    p.line(SEP);
    p.bold(true).line("ATENCION: BITACORA ALTERADA").bold(false);
  }
  p.line(SEP2);
  p.line("");
  p.line("Firma: ________________________");
  p.feed(4);
  if (s.cortador) p.cut();
  return { bytes: p.bytes(), missing: [...p.missing] };
}

/** Comprobante de una entrada/salida de efectivo (para firmar y guardar con el dinero). */
export function comprobanteMovimiento(n: Negocio, m: Movimiento, s: TicketSettings): Doc {
  const p = new EscPos(s.codePage, { sinModoChino: s.sinModoChino });
  escribirEncabezado(p, n);
  p.line(SEP2);
  p.align("center").bold(true).line(m.tipo === "salida" ? "SALIDA DE EFECTIVO" : "ENTRADA DE EFECTIVO").bold(false).align("left");
  p.line(lr("Fecha:", fechaHora(new Date(m.fecha))));
  p.line(lr("Usuario:", m.usuario.slice(0, 22)));
  p.line(lr("Motivo:", m.categoria.slice(0, 23)));
  if (m.motivo) wrap("Nota: " + m.motivo).forEach((l) => p.line(l));
  p.bold(true).line(lr("MONTO", monto(m.monto))).bold(false);
  if (m.autorizadoPor) p.line("Autorizado por el dueño");
  p.line(SEP2);
  p.line("");
  p.line("Firma: ________________________");
  p.feed(4);
  if (s.cortador) p.cut();
  return { bytes: p.bytes(), missing: [...p.missing] };
}
