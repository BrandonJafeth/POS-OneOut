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
import { crearDocumento, type Bloque } from "./pdf";
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

/** PDF de un reporte con el encabezado del negocio (nombre y logo). */
export async function exportarPdf(nombre: string, titulo: string, subtitulo: string, bloques: Bloque[]): Promise<string> {
  const n = await obtenerNegocio();
  return descargar(`${nombre}.pdf`, crearDocumento({ negocio: n.nombreComercial || "Punto de venta", titulo, subtitulo, logo: n.logo, bloques }));
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
/** Resumen y tabla de movimientos. `conProducto`: varias cosas mezcladas (reporte) o un solo producto (kardex). */
export function pdfMovimientos(filas: FilaKardex[], conProducto: boolean): Bloque[] {
  const entra = filas.filter((f) => f.cantidad > 0).reduce((s, f) => s + f.cantidad, 0);
  const sale = filas.filter((f) => f.cantidad < 0).reduce((s, f) => s - f.cantidad, 0);
  const d2 = (n: number) => String(n).padStart(2, "0");
  const fecha = (iso: string) => {
    const d = new Date(iso);
    return `${d2(d.getDate())}/${d2(d.getMonth() + 1)}/${d2(d.getFullYear() % 100)} ${d2(d.getHours())}:${d2(d.getMinutes())}`;
  };
  const signo = (n: number) => (n > 0 ? `+${n}` : String(n));
  return [
    {
      tipo: "resumen",
      items: [
        { etiqueta: "Movimientos", valor: filas.length.toLocaleString("es-CR") },
        { etiqueta: "Unidades que entraron", valor: `+${entra.toLocaleString("es-CR")}` },
        { etiqueta: "Unidades que salieron", valor: `−${sale.toLocaleString("es-CR")}` },
        ...(conProducto ? [] : [{ etiqueta: "Existencia actual", valor: filas.length ? String(filas[0].existencia) : "—" }]),
      ],
    },
    {
      tipo: "tabla",
      columnas: [
        { titulo: "Fecha", ancho: 2.3 },
        ...(conProducto ? [{ titulo: "Producto", ancho: 3.6 }] : []),
        { titulo: "Tipo", ancho: 1.7 },
        { titulo: "Cant.", ancho: 1, derecha: true },
        { titulo: "Queda", ancho: 1.1, derecha: true },
        { titulo: "Motivo / referencia", ancho: conProducto ? 3.5 : 5.4 },
        { titulo: "Usuario", ancho: 1.4 },
      ],
      filas: filas.map((f) => [
        fecha(f.fecha),
        ...(conProducto ? [f.producto] : []),
        f.tipo === "inicial" ? "Inicial" : NOMBRE_TIPO[f.tipo],
        signo(f.cantidad),
        f.existencia,
        [f.motivo, f.referencia].filter(Boolean).join(" · "),
        f.usuario,
      ]),
      vacio: "Sin movimientos en esas fechas.",
    },
  ];
}

export const CABECERA_KARDEX = ["Fecha", "Producto", "Tipo", "Cantidad", "Existencia", "Costo unitario", "Motivo", "Referencia", "Usuario"];
