// CSV exportado de la tienda web: columnas id, nombre, precio, categoria (en cualquier orden).
import { leerCsv } from "../csv";
import { normalizar } from "../texto";
import type { FuenteImportacion } from "./fuente";

const COLUMNAS = ["id", "nombre", "precio", "categoria"] as const;

export function leerCsvWeb(texto: string): FuenteImportacion {
  const { filas } = leerCsv(texto);
  if (!filas.length) throw new Error("El archivo está vacío");
  // "Categoría", " ID " y "PRECIO" también valen.
  const cab = filas[0].map((c) => normalizar(c));
  const idx = Object.fromEntries(COLUMNAS.map((c) => [c, cab.indexOf(c)])) as Record<(typeof COLUMNAS)[number], number>;
  const faltan = COLUMNAS.filter((c) => idx[c] < 0);
  if (faltan.length) throw new Error(`Faltan columnas: ${faltan.join(", ")}. El archivo debe tener id, nombre, precio y categoria.`);
  return {
    origen: "web",
    filas: filas.slice(1).map((f, i) => ({
      fila: i + 2,
      webId: (f[idx.id] ?? "").trim(),
      nombre: (f[idx.nombre] ?? "").trim(),
      precio: (f[idx.precio] ?? "").trim(),
      categoria: (f[idx.categoria] ?? "").trim(),
    })),
  };
}
