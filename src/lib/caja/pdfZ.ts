// Cierre Z en PDF tamaño carta (con logo): el mismo contenido que la térmica, a 90 columnas, con
// el detalle completo y cada departamento en su propia página.
import type { Detalle } from "../../db/caja";
import type { Negocio } from "../../tipos";
import { COLUMNAS_REPORTE, crearPdfReporte } from "../pdf";
import { fechaHora } from "../tickets";
import { exigirCuadre, lineasDepartamento, lineasZ, type LineaDoc } from "./reporteZ";

export function pdfCierre(n: Negocio, d: Detalle, o: { copia: boolean; denominaciones?: number[] }): Uint8Array {
  exigirCuadre(d.resumen);
  const cols = COLUMNAS_REPORTE;
  const cuerpo: LineaDoc[] = lineasZ(n, d, cols, { copia: o.copia, detalleCompleto: true, porDepartamento: true, denominaciones: o.denominaciones });
  for (const x of d.resumen.desglose.departamentos) {
    const [primera, ...resto] = lineasDepartamento(n, d, x, cols, { copia: o.copia });
    cuerpo.push({ ...primera, salto: true }, ...resto);
  }
  const t = d.turno;
  return crearPdfReporte({
    negocio: n.nombreComercial || "Punto de venta",
    titulo: o.copia ? "Cierre de caja (copia)" : "Cierre de caja",
    subtitulo: `${t.caja || "Caja"} · Día ${t.dia} · abrió ${fechaHora(new Date(t.abiertoEn)).slice(0, 16)}${t.cerradoEn ? ` · cerró ${fechaHora(new Date(t.cerradoEn)).slice(0, 16)}` : ""}`,
    logo: n.logo,
    lineas: cuerpo.map((l) => ({ texto: l.t, negrita: l.b, centro: l.centro, salto: l.salto })),
  });
}
