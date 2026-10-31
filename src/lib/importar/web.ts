// CSV exportado de la tienda web. Obligatorias: id, nombre, precio y categoria o categorias
// (varias separadas por " | "). Opcionales: slug, estado, tipo, destacado, precio_oferta.
// El archivo lo lee Rust (importacion_leer: límites, codificación, separador); aquí solo se
// interpretan las columnas de la tabla que devuelve.
import { leerCsv } from "../csv";
import { normalizar } from "../texto";
import type { FuenteImportacion } from "./fuente";

export interface FilaTabla {
  linea: number;
  celdas: string[];
}

const OPCIONALES = ["slug", "estado", "tipo", "destacado", "precio_oferta"] as const;
const SI = new Set(["true", "1", "si", "verdadero", "x"]);

export function fuenteDesdeTabla(cabecera: string[], filas: FilaTabla[]): FuenteImportacion {
  // "Categoría", " ID " y "PRECIO" también valen; "precio oferta" = "precio_oferta".
  const cab = cabecera.map((c) => normalizar(c).replace(/ /g, "_"));
  const col = (n: string) => cab.indexOf(n);
  const categoria = col("categorias") >= 0 ? col("categorias") : col("categoria");
  const faltan = (["id", "nombre", "precio"] as const).filter((c) => col(c) < 0) as string[];
  if (categoria < 0) faltan.push("categorias");
  if (faltan.length) throw new Error(`Faltan columnas: ${faltan.join(", ")}. El archivo debe tener id, nombre, precio y categorias.`);
  const celda = (f: FilaTabla, i: number) => (i >= 0 ? (f.celdas[i] ?? "").trim() : "");
  return {
    origen: "web",
    columnas: OPCIONALES.filter((c) => col(c) >= 0),
    filas: filas.map((f) => ({
      fila: f.linea,
      webId: celda(f, col("id")),
      slug: celda(f, col("slug")),
      nombre: celda(f, col("nombre")),
      precio: celda(f, col("precio")),
      estado: normalizar(celda(f, col("estado"))),
      tipo: normalizar(celda(f, col("tipo"))),
      destacado: SI.has(normalizar(celda(f, col("destacado")))),
      precioOferta: celda(f, col("precio_oferta")),
      categorias: celda(f, categoria)
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean),
    })),
  };
}

/** Misma limpieza que importacion::limpiar en Rust: sin caracteres de control, espacios simples. */
export function limpiarCelda(s: string): string {
  return s
    .replace(/[\p{Cc}​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lectura en la pantalla, sin Rust (pruebas y herramientas). La app usa importacion_leer. */
export function leerCsvWeb(texto: string): FuenteImportacion {
  const { filas } = leerCsv(texto);
  if (!filas.length) throw new Error("El archivo está vacío");
  return fuenteDesdeTabla(
    filas[0].map(limpiarCelda),
    filas.slice(1).map((celdas, i) => ({ linea: i + 2, celdas: celdas.map(limpiarCelda) })),
  );
}
