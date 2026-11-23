// Proformas en papel (térmica y PDF carta) y la regla de "la venta coincide con su proforma" para AVISAR
// en pantalla. Rust decide al cobrar (proformas::coincide, mismos casos en tests/casos/proformas.json).
import { obtenerNegocio } from "../db/negocio";
import { ajustesPara } from "../db/impresoras";
import { imprimirProformaBytes, obtenerProforma, type ProformaDetalle } from "../db/proformas";
import type { EstadoEspera, Negocio } from "../tipos";
import { EscPos } from "./escpos";
import { escribirEncabezado, escribirPie } from "./impresion";
import type { Bloque } from "./pdf";
import { columnas, cortar, fechaHora, lr, monto, sep, sep2, type Doc, type TicketSettings, wrap } from "./tickets";

export const LEYENDA_PROFORMA = "Proforma. No es una factura ni un comprobante de pago. Precios sujetos a existencia.";

const fechaCorta = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** Clave de una línea: producto (o descripción si es precio libre), cantidad y descuento. El precio no. */
const clave = (productoId: string | null | undefined, descripcion: string, cantidad: number, descuento: number) =>
  `${productoId ?? `libre:${descripcion.trim().toLowerCase()}`}|${cantidad}|${descuento}`;

/** La venta tiene exactamente las líneas y el descuento al total de la proforma (copia de proformas::coincide). */
export function coincide(
  venta: Pick<EstadoEspera, "lineas" | "descuentoTotal">,
  p: { lineas: { productoId: string | null; descripcion: string; cantidad: number; descuento: number }[]; descuento: number },
): boolean {
  const a = venta.lineas.map((l) => clave(l.productoId, l.descripcion, l.cantidad, l.descuento)).sort();
  const b = p.lineas.map((l) => clave(l.productoId, l.descripcion, l.cantidad, l.descuento)).sort();
  return a.length === b.length && a.every((x, i) => x === b[i]) && venta.descuentoTotal === p.descuento;
}

/** Número de la versión siguiente: P-0012 → P-0012-2, P-0012-2 → P-0012-3 (como proformas::numero). */
export function siguienteVersion(numero: string): string {
  const m = /^(P-\d+)(?:-(\d+))?$/.exec(numero);
  return m ? `${m[1]}-${(Number(m[2]) || 1) + 1}` : numero;
}

export function proformaTermica(n: Negocio, d: ProformaDetalle, s: TicketSettings, o: { copia?: boolean } = {}): Doc {
  const c = columnas(s);
  const p = new EscPos(s.codePage, { sinModoChino: s.sinModoChino });
  const x = d.proforma;
  escribirEncabezado(p, n, c);
  p.line(sep2(c));
  if (o.copia) p.align("center").bold(true).line("*** COPIA ***").bold(false).align("left");
  p.align("center").bold(true).line("PROFORMA").size(true, true).line(x.numero).size(false, false).bold(false).align("left");
  p.line(lr("Fecha:", fechaHora(new Date(x.fecha)), c));
  p.bold(true).line(lr("Válida hasta el:", fechaCorta(x.vence), c)).bold(false);
  wrap("Cliente: " + (x.cliente ?? "no registrado"), c).forEach((l) => p.line(l));
  p.line(sep(c));
  for (const l of d.lineas) {
    wrap(l.descripcion, c).forEach((w) => p.line(w));
    p.line(lr(`  ${l.cantidad} x ${monto(l.precioUnitario)}`, monto(l.cantidad * l.precioUnitario), c));
    if (l.descuento) p.line(lr("  Descuento", "-" + monto(l.descuento), c));
  }
  p.line(sep(c));
  if (d.descuento) p.line(lr("Descuento", "-" + monto(d.descuento), c));
  p.bold(true).line(lr("TOTAL", monto(x.total), c)).bold(false);
  p.line(lr("Atendió:", cortar(x.usuario, c - 9), c));
  p.line(sep2(c));
  if (d.condiciones.trim()) {
    wrap(d.condiciones.trim(), c).forEach((l) => p.line(l));
    p.line(sep(c));
  }
  p.align("center");
  wrap(LEYENDA_PROFORMA, c).forEach((l) => p.line(l));
  p.align("left");
  escribirPie(p, n, c);
  p.feed(4);
  if (s.cortador) p.cut();
  return { bytes: p.bytes(), missing: [...p.missing] };
}

export function proformaPdf(d: ProformaDetalle): Bloque[] {
  const x = d.proforma;
  return [
    {
      tipo: "datos",
      pares: [
        ["Proforma", x.numero],
        ["Fecha", fechaHora(new Date(x.fecha))],
        ["Válida hasta el", fechaCorta(x.vence)],
        ["Cliente", x.cliente ?? "no registrado"],
        ["Atendió", x.usuario],
      ],
    },
    {
      tipo: "tabla",
      columnas: [
        { titulo: "Producto", ancho: 6 },
        { titulo: "Cant.", ancho: 1.2, derecha: true },
        { titulo: "Precio", ancho: 2, derecha: true },
        { titulo: "Descuento", ancho: 2, derecha: true },
        { titulo: "Importe", ancho: 2, derecha: true },
      ],
      filas: d.lineas.map((l) => [l.descripcion, l.cantidad, monto(l.precioUnitario), l.descuento ? monto(l.descuento) : "", monto(l.total)]),
      total: ["Total", "", "", d.descuento ? `-${monto(d.descuento)}` : "", monto(x.total)],
    },
    ...(d.condiciones.trim() ? ([{ tipo: "texto", texto: d.condiciones.trim() }] as Bloque[]) : []),
    { tipo: "texto", texto: LEYENDA_PROFORMA, tenue: true },
  ];
}

/** Imprime en la impresora de tiquetes. `copia`: reimpresión (sale COPIA y Rust la cuenta). */
export async function imprimirProforma(id: string, copia = false): Promise<void> {
  const [s, d, n] = await Promise.all([ajustesPara("tiquete"), obtenerProforma(id), obtenerNegocio()]);
  await imprimirProformaBytes(id, proformaTermica(n, d, s, { copia }).bytes);
}
