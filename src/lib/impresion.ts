// Documentos ESC/POS del POS real, armados con lib/escpos.ts y los ayudantes de lib/tickets.ts.
// Igual que en el prototipo: se generan BYTES y la vista previa interpreta esos mismos bytes.
// El formato (columnas, code page, cortador) es el de la impresora asignada a cada documento
// (db/impresoras.ts → ajustesPara). Rust vuelve a revisar los bytes antes de imprimir.
import type { Negocio } from "../tipos";
import { isValidEan13 } from "./ean13";
import { EscPos } from "./escpos";
import { columnas, lr, monto, sep, type Doc, type TicketSettings, wrap } from "./tickets";

function nuevo(s: TicketSettings) {
  return new EscPos(s.codePage, { sinModoChino: s.sinModoChino });
}

function cerrar(p: EscPos, s: TicketSettings, lineas = 4): Doc {
  p.feed(lineas);
  if (s.cortador) p.cut();
  return { bytes: p.bytes(), missing: [...p.missing] };
}

function lineasLibres(texto: string, cols: number): string[] {
  return texto.split(/\r?\n/).flatMap((l) => (l.trim() ? wrap(l.trim(), cols) : []));
}

/** Encabezado: logo (o nombre comercial si no hay logo) y datos del negocio, centrados. */
export function escribirEncabezado(p: EscPos, n: Negocio, cols = 32): void {
  p.align("center");
  if (n.logo) p.raster(n.logo.ancho, n.logo.alto, n.logo.bits);
  else if (n.nombreComercial.trim()) {
    p.bold(true).size(false, true);
    wrap(n.nombreComercial.trim(), cols).forEach((l) => p.line(l));
    p.size(false, false).bold(false);
  }
  const datos = [
    n.razonSocial,
    n.cedula && `Céd. ${n.cedula}`,
    n.regimen,
    n.direccion,
    n.telefono && `Tel. ${n.telefono}`,
    n.correo,
  ].filter(Boolean) as string[];
  for (const d of datos) wrap(d, cols).forEach((l) => p.line(l));
  lineasLibres(n.encabezadoExtra, cols).forEach((l) => p.line(l));
  p.align("left");
}

export function escribirPie(p: EscPos, n: Negocio, cols = 32): void {
  p.align("center");
  lineasLibres(n.pieTiquete, cols).forEach((l) => p.line(l));
  p.align("left");
}

/** Muestra para "Datos del negocio": encabezado + una línea de ejemplo + pie. */
export function muestraEncabezado(n: Negocio, s: TicketSettings): Doc {
  const p = nuevo(s);
  const c = columnas(s);
  escribirEncabezado(p, n, c);
  p.line(sep(c));
  p.line(lr("Tiquete:", "67791", c));
  p.line("  ... productos ...");  // ASCII: "…" no existe en las tablas de la impresora
  p.line(lr("TOTAL", monto(1500), c));
  p.line(sep(c));
  escribirPie(p, n, c);
  return cerrar(p, s);
}

/** Hoja de prueba de una impresora: ancho, tildes, ¢, código de barras y corte. */
export function paginaPrueba(nombre: string, s: TicketSettings & { anchoMm?: number }): Doc {
  const p = nuevo(s);
  const c = columnas(s);
  p.align("center").bold(true).line("PRUEBA DE IMPRESORA").bold(false);
  wrap(nombre, c).forEach((l) => p.line(l));
  p.line(`${s.anchoMm ?? 58} mm · ${c} columnas · code page ${s.codePage}`);
  p.align("left").line(sep(c));
  p.line("1234567890".repeat(Math.ceil(c / 10)).slice(0, c));
  p.line(lr("Izquierda", "Derecha", c));
  p.line("Tildes: áéíóú ñ Ñ ¿ ¡ ü");
  p.line(lr("Monto", monto(1500), c));
  p.align("center");
  p.barcodeEan13("9789968000000", s.barras);
  p.align("left").line(sep(c));
  return cerrar(p, s);
}

/** Etiqueta de producto: nombre, precio grande y código de barras EAN-13. */
export function etiquetaProducto(prod: { nombre: string; precio: number }, codigo: string, s: TicketSettings, copias = 1): Doc {
  if (!isValidEan13(codigo)) throw new Error("La etiqueta necesita un código EAN-13 válido");
  const p = nuevo(s);
  for (let i = 0; i < copias; i++) {
    p.align("center");
    wrap(prod.nombre, columnas(s)).slice(0, 2).forEach((l) => p.line(l));
    p.bold(true).size(true, true).line(monto(prod.precio)).size(false, false).bold(false);
    p.barcodeEan13(codigo, s.barras);
    p.align("left");
    if (i < copias - 1) p.feed(2);
  }
  return cerrar(p, s, 3);
}

/**
 * Línea corta del aviso de privacidad para el tiquete del apartado (config aviso_privacidad_en_tiquete).
 * El tiquete de apartado se arma en la fase 2; queda lista para usarla ahí.
 */
export function escribirAvisoCorto(p: EscPos, n: Negocio, cols = 32): void {
  const contacto = n.telefono ? ` Tel. ${n.telefono}` : "";
  p.align("center");
  wrap(`Sus datos se usan solo para este apartado. Para verlos, corregirlos o eliminarlos, consúltenos.${contacto}`, cols).forEach((l) => p.line(l));
  p.align("left");
}
