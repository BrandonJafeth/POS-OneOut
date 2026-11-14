// Cierre Z en PDF tamaño carta (con logo), para mandarle al dueño: el Z completo a 90 columnas, el
// detalle por departamento y las transacciones del turno (cada tiquete con sus líneas y su pago).
import type { Detalle } from "../../db/caja";
import type { Negocio, Venta } from "../../tipos";
import { COLUMNAS_REPORTE, crearPdfReporte } from "../pdf";
import { cortar, fechaHora, lr, monto, sep2, wrap } from "../tickets";
import { exigirCuadre, lineasZ, type LineaDoc } from "./reporteZ";

/** Cada tiquete: número, hora, cajero y total; sus líneas; y cómo se pagó (banco, referencia...). */
export function lineasTransacciones(ventas: Venta[], cols: number): LineaDoc[] {
  const l: LineaDoc[] = [{ t: sep2(cols), salto: true }, { t: "TRANSACCIONES DEL TURNO", b: true, centro: true }];
  if (!ventas.length) l.push({ t: "Sin ventas" });
  for (const v of ventas) {
    const anulada = v.estado === "anulada" ? " ANULADA" : "";
    l.push({ t: lr(`Tiquete ${v.numero}  ${fechaHora(new Date(v.fecha)).slice(11, 16)}  ${cortar(v.cajero, 20)}${anulada}`, monto(v.total), cols), b: true });
    for (const x of v.lineas) {
      const der = `${monto(x.precioUnitario).padStart(12)}${monto(x.total).padStart(13)}`;
      l.push({ t: lr(`  ${String(x.cantidad).padStart(4)} ${cortar(x.descripcion, cols - der.length - 8)}`, der, cols) });
    }
    const pago = v.pagos.map((p) => [p.forma, p.banco, p.referencia && `ref ${p.referencia}`, p.ultimos4 && `****${p.ultimos4}`, p.pagador, monto(p.monto)].filter(Boolean).join(" ")).join(" + ");
    wrap(`Pago: ${pago || "-"}`, cols - 2).forEach((y) => l.push({ t: `  ${y}` }));
  }
  return l;
}

export function pdfCierre(n: Negocio, d: Detalle, o: { copia: boolean; denominaciones?: number[]; ventas: Venta[] }): Uint8Array {
  exigirCuadre(d.resumen);
  const cols = COLUMNAS_REPORTE;
  const cuerpo: LineaDoc[] = [
    ...lineasZ(n, d, cols, { copia: o.copia, detalleCompleto: true, porDepartamento: false, completo: true, denominaciones: o.denominaciones }),
    ...lineasTransacciones(o.ventas, cols),
  ];
  const t = d.turno;
  return crearPdfReporte({
    negocio: n.nombreComercial || "Punto de venta",
    titulo: o.copia ? "Cierre de caja (copia)" : "Cierre de caja",
    subtitulo: `${t.caja || "Caja"} · Día ${t.dia} · abrió ${fechaHora(new Date(t.abiertoEn)).slice(0, 16)}${t.cerradoEn ? ` · cerró ${fechaHora(new Date(t.cerradoEn)).slice(0, 16)}` : ""}`,
    logo: n.logo,
    lineas: cuerpo.map((l) => ({ texto: l.t, negrita: l.b, centro: l.centro, salto: l.salto })),
  });
}
