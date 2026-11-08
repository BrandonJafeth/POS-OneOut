// Inventario en papel: comprobante de entrada (térmica), etiquetas de lo recibido y exportes
// (CSV sin fórmulas y PDF) de los reportes. Los datos vienen de Rust; aquí solo se formatean.
import { obtenerNegocio } from "../db/negocio";
import { ajustesPara } from "../db/impresoras";
import { NOMBRE_TIPO, type Comprobante, type FilaKardex } from "../db/inventario";
import { aEscPos, type LineaDoc } from "./caja/reporteZ";
import { csvSeguro } from "./csv";
import { descargar } from "./exportarCliente";
import { etiquetaProducto } from "./impresion";
import { invocar } from "./invocar";
import { crearPdf } from "./pdf";
import { columnas, cortar, fechaHora, lr, monto, sep2, wrap } from "./tickets";

/** Comprobante de una entrada de mercadería, por la impresora de comprobantes. */
export async function imprimirComprobanteEntrada(c: Comprobante): Promise<string> {
  const s = await ajustesPara("movimiento");
  const n = columnas(s);
  const l: LineaDoc[] = [{ t: sep2(n) }, { t: "ENTRADA DE MERCADERIA", b: true, centro: true }];
  l.push({ t: lr("Registrada:", fechaHora(new Date(c.creadoEn)), n) }, { t: lr("Factura:", cortar(c.factura || "—", n - 9), n) }, { t: lr("Fecha factura:", c.fecha, n) });
  if (c.proveedor) l.push({ t: lr("Proveedor:", cortar(c.proveedor, n - 11), n) });
  l.push({ t: lr("Usuario:", cortar(c.usuario, n - 9), n) }, { t: sep2(n) });
  let total = 0;
  for (const x of c.lineas) {
    wrap(x.nombre, n).forEach((t) => l.push({ t }));
    const costo = x.costoUnitario == null ? "sin costo" : `${monto(x.costoUnitario)} c/u`;
    l.push({ t: lr(`  ${x.cantidad} x ${costo}`, x.costoUnitario == null ? "" : monto(x.cantidad * x.costoUnitario), n) });
    total += x.cantidad * (x.costoUnitario ?? 0);
  }
  l.push({ t: sep2(n) }, { t: lr("UNIDADES", String(c.lineas.reduce((a, x) => a + x.cantidad, 0)), n), b: true }, { t: lr("COSTO TOTAL", monto(total), n), b: true });
  l.push({ t: "" }, { t: "Recibe: ________________________" });
  const doc = aEscPos(await obtenerNegocio(), l, s);
  return invocar<string>("imprimir", { documento: "entrada", data: Array.from(doc.bytes) });
}

/** Etiquetas de lo recibido: una por unidad, en la impresora de etiquetas. Solo productos con código de barras. */
export async function imprimirEtiquetasEntrada(c: Comprobante): Promise<{ impresas: number; sinCodigo: number }> {
  const s = await ajustesPara("etiqueta");
  let impresas = 0;
  let sinCodigo = 0;
  for (const x of c.lineas) {
    if (!x.codigoBarras) {
      sinCodigo++;
      continue;
    }
    // shortcut: tope de 500 etiquetas por producto y por envío; si una entrada trae más, imprimir en tandas.
    const copias = Math.min(x.cantidad, 500);
    await invocar<string>("imprimir", { documento: "etiqueta", data: Array.from(etiquetaProducto({ nombre: x.nombre, precio: x.precio }, x.codigoBarras, s, copias).bytes) });
    impresas += copias;
  }
  return { impresas, sinCodigo };
}

export async function exportarCsv(nombre: string, filas: (string | number)[][]): Promise<string> {
  return descargar(`${nombre}.csv`, csvSeguro(filas.map((f) => f.map(String))));
}

export async function exportarPdf(nombre: string, titulo: string, encabezado: string[], filas: (string | number)[][]): Promise<string> {
  const lineas = [
    { texto: titulo, negrita: true },
    { texto: `Generado: ${new Date().toLocaleString("es-CR")}` },
    { texto: "" },
    { texto: encabezado.join(" · "), negrita: true },
    ...filas.map((f) => ({ texto: f.join(" · ") })),
  ];
  return descargar(`${nombre}.pdf`, crearPdf(lineas));
}

export const filaKardex = (f: FilaKardex): (string | number)[] => [
  new Date(f.fecha).toLocaleString("es-CR"),
  f.producto,
  NOMBRE_TIPO[f.tipo],
  f.cantidad,
  f.existencia,
  f.costoUnitario ?? "",
  f.motivo,
  f.referencia ?? "",
  f.usuario,
];
export const CABECERA_KARDEX = ["Fecha", "Producto", "Tipo", "Cantidad", "Existencia", "Costo unitario", "Motivo", "Referencia", "Usuario"];
