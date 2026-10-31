// Lector de CSV (RFC 4180): comillas dobles, "" como comilla escapada, saltos de línea dentro de
// comillas, CRLF o LF, BOM de UTF-8 al inicio. Detecta si el separador es coma o punto y coma.

export type Separador = "," | ";";

/** Cuenta separadores fuera de comillas en la primera línea; gana el que más aparece. */
export function detectarSeparador(texto: string): Separador {
  let comas = 0;
  let puntoComa = 0;
  let enComillas = false;
  for (const c of texto) {
    if (c === '"') enComillas = !enComillas;
    else if (!enComillas && (c === "\n" || c === "\r")) break;
    else if (!enComillas && c === ",") comas++;
    else if (!enComillas && c === ";") puntoComa++;
  }
  return puntoComa > comas ? ";" : ",";
}

export function leerCsv(texto: string, separador?: Separador): { separador: Separador; filas: string[][] } {
  const t = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
  const sep = separador ?? detectarSeparador(t);
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let enComillas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (enComillas) {
      if (c === '"' && t[i + 1] === '"') (campo += '"'), i++;
      else if (c === '"') enComillas = false;
      else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === sep) fila.push(campo), (campo = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = "";
    } else campo += c;
  }
  if (campo !== "" || fila.length) fila.push(campo), filas.push(fila);
  // Las líneas totalmente vacías no cuentan como filas.
  return { separador: sep, filas: filas.filter((f) => f.some((x) => x.trim() !== "")) };
}

/**
 * Celda para un CSV que alguien abrirá en Excel. Inyección de fórmulas: Excel ejecuta una celda
 * que empieza con = + - @ (o tab/CR); se le antepone ' para que quede como texto.
 */
export function celdaSegura(s: string): string {
  const t = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",;\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** CSV con BOM (para que Excel muestre bien las tildes), celdas neutralizadas y CRLF. */
export function csvSeguro(filas: string[][]): Uint8Array {
  return new TextEncoder().encode("﻿" + filas.map((f) => f.map(celdaSegura).join(",")).join("\r\n") + "\r\n");
}
