// Exporta lo que se ve en una pestaña de Reportes: CSV (sin fórmulas, con tildes, montos enteros)
// y PDF carta (pdf.ts). Las tablas son las mismas definiciones de columnas de la pantalla.
import type { Negocio } from "../../tipos";
import { csvSeguro } from "../csv";
import { crearDocumento, type Bloque } from "../pdf";
import { monto } from "../tickets";

export interface TablaExport {
  titulo: string;
  columnas: { titulo: string; numero?: boolean; dinero?: boolean }[];
  filas: (string | number)[][];
  total?: (string | number)[];
}

export interface SeccionExport {
  titulo: string;
  resumen?: { etiqueta: string; valor: string }[];
  tablas: TablaExport[];
}

/** CSV: una tabla tras otra, con su título; los montos como enteros (Excel los suma). */
export function csvReporte(s: SeccionExport, rango: string): Uint8Array {
  const filas: string[][] = [[s.titulo, rango]];
  for (const x of s.resumen ?? []) filas.push([x.etiqueta, x.valor]);
  for (const t of s.tablas) {
    filas.push([], [t.titulo], t.columnas.map((c) => c.titulo));
    for (const f of t.filas) filas.push(f.map(String));
    if (t.total) filas.push(t.total.map(String));
  }
  return csvSeguro(filas);
}

export function pdfReporte(n: Negocio, s: SeccionExport, rango: string): Uint8Array {
  const celda = (t: TablaExport, i: number, v: string | number) => (t.columnas[i]?.dinero && typeof v === "number" ? monto(v) : String(v));
  const bloques: Bloque[] = [];
  if (s.resumen?.length) bloques.push({ tipo: "resumen", items: s.resumen.slice(0, 8) });
  for (const t of s.tablas) {
    bloques.push({ tipo: "seccion", titulo: t.titulo });
    bloques.push({
      tipo: "tabla",
      columnas: t.columnas.map((c, i) => ({ titulo: c.titulo, ancho: i === 0 ? 3 : 1.4, derecha: c.numero || c.dinero })),
      filas: t.filas.map((f) => f.map((v, i) => celda(t, i, v))),
      total: t.total?.map((v, i) => celda(t, i, v)),
      vacio: "Sin datos en esas fechas.",
    });
  }
  return crearDocumento({ negocio: n.nombreComercial || "Punto de venta", titulo: `Reporte: ${s.titulo}`, subtitulo: rango, logo: n.logo, bloques });
}

/** Nombre de archivo: ventas-por-dia_2026-11-01_2026-11-30.pdf */
export function nombreArchivo(titulo: string, desde: string, hasta: string, ext: "csv" | "pdf"): string {
  const base = titulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base}_${desde}_${hasta}.${ext}`;
}
