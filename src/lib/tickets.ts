// Documentos de prueba. Cada uno devuelve los bytes exactos que se mandan a la impresora;
// la vista previa (Pantalla 3) interpreta esos mismos bytes.
import { CODE_PAGES } from "./codepages";
import { ean13CheckDigit } from "./ean13";
import { EscPos } from "./escpos";
import { LOGO } from "./logo";

export const COLS = 32; // 58 mm, fuente A (12×24): 384 puntos / 12 = 32 columnas (80 mm: 48)

export interface TicketSettings {
  codePage: number;
  cortador: boolean;
  /** Mandar FS . al inicio (apaga el modo chino de las POS-58 chinas). */
  sinModoChino: boolean;
  /** Formato del comando GS k para el código de barras. */
  barras: "A" | "B";
  /** Columnas de texto de la impresora (32 en 58 mm, 48 en 80 mm). Sin dato: 32. */
  columnas?: number;
}

export const DEFAULT_SETTINGS: TicketSettings = { codePage: 19, cortador: false, sinModoChino: true, barras: "B", columnas: COLS };

/** Columnas de una impresora (24 a 64; 32 si no se sabe). */
export function columnas(s: Pick<TicketSettings, "columnas">): number {
  const c = Math.floor(s.columnas ?? COLS);
  return c >= 24 && c <= 64 ? c : COLS;
}

function nuevo(s: TicketSettings, codePage = s.codePage): EscPos {
  return new EscPos(codePage, { sinModoChino: s.sinModoChino });
}

export interface Doc {
  bytes: Uint8Array;
  missing: string[];
}

function finish(p: EscPos, s: TicketSettings, feedLines = 4): Doc {
  p.feed(feedLines);
  if (s.cortador) p.cut();
  return { bytes: p.bytes(), missing: [...p.missing] };
}

/** 1.500 (separador de miles con punto, sin decimales). */
export function colones(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** dd/mm/aaaa hh:mm armado a mano: toLocale* puede meter espacios Unicode que la impresora no tiene. */
export function fechaHora(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

/** ¢1.500 — la impresora no trae ₡ en ninguna code page (sale "?"); el ¢ sí y es lo que se usa en CR. */
export function monto(n: number): string {
  return "¢" + colones(n);
}

/** +¢500 / −¢500 (sobrante o faltante). En papel va "-": el "−" no está en las code pages. */
export function montoConSigno(n: number, menos = "−"): string {
  return (n > 0 ? "+" : n < 0 ? menos : "") + monto(Math.abs(n));
}

/** Texto a la izquierda y a la derecha en una misma línea de `cols` columnas. */
export function lr(left: string, right: string, cols = COLS): string {
  const space = cols - right.length;
  return left.slice(0, Math.max(0, space - 1)).padEnd(space) + right;
}

/** Corta un texto largo de forma ordenada: termina en "." en vez de partir a la mitad sin aviso. */
export function cortar(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= n) return t;
  return n <= 1 ? t.slice(0, n) : t.slice(0, n - 1).trimEnd() + ".";
}

/** Como lr(), pero si el texto no cabe junto al monto lo parte en varias líneas (el monto va en la última). */
export function lrLargo(left: string, right: string, cols = COLS): string[] {
  if (left.length + 1 + right.length <= cols) return [lr(left, right, cols)];
  const lineas = wrap(left, cols);
  const ultima = lineas[lineas.length - 1] ?? "";
  if (ultima.length + 1 + right.length <= cols) lineas[lineas.length - 1] = lr(ultima, right, cols);
  else lineas.push(lr("", right, cols));
  return lineas;
}

export const sep = (cols = COLS) => "-".repeat(cols);
export const sep2 = (cols = COLS) => "=".repeat(cols);

/** Parte el texto en líneas de `width` sin cortar palabras (salvo que una sola no quepa). */
export function wrap(text: string, width = COLS): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (cur) lines.push(cur), (cur = "");
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += " " + word;
    else lines.push(cur), (cur = word);
  }
  if (cur) lines.push(cur);
  return lines;
}

export const SEP = "-".repeat(COLS);
export const SEP2 = "=".repeat(COLS);

// Encabezado del tiquete que usaba la librería en el sistema anterior.
// En vez del nombre va el logo (src/assets/logo-tiquete.png, convertido a 1 bit en lib/logo.ts).
const LOGO_BITS = Uint8Array.from(atob(LOGO.data), (c) => c.charCodeAt(0));

const NEGOCIO = {
  lineas: [
    "Hatillo, Diagonal Plaza América",
    "Isaias Días García",
    "Céd. 503210821",
    "Acogido al Régimen Simplificado",
    "Tel. 4080-7942",
    "libreriaybazarchagui04@gmail.com",
  ],
};

const ITEMS = [
  { qty: 2, name: "Cuaderno cosido 100 hojas", price: 1250 },
  { qty: 1, name: "Lápiz HB Mongol", price: 350 },
  { qty: 3, name: "Borrador blanco pequeño", price: 200 },
  { qty: 1, name: "Cien años de soledad (Bolsillo)", price: 12500 },
];

const PAGO = 20000;
export const EAN_PRUEBA = "978996800000" + ean13CheckDigit("978996800000");

/** Texto simple (paso 3): comprobar que llega algo al papel. */
export function textoSimple(s: TicketSettings): Doc {
  const p = nuevo(s);
  p.line("Hola desde Tauri").line("Prueba de impresion RAW").line(fechaHora());
  return finish(p, s);
}

export function tiquete(s: TicketSettings, etiqueta?: string): Doc {
  const p = nuevo(s);
  p.align("center").raster(LOGO.width, LOGO.height, LOGO_BITS);
  for (const l of NEGOCIO.lineas) wrap(l).forEach((w) => p.line(w));
  p.align("left").line(SEP2);
  p.line("Fecha:   " + fechaHora());
  p.line("Usuario: prueba");
  p.line("Tiquete: PRUEBA" + (etiqueta ? ` (${etiqueta})` : ""));
  p.line("Cliente: Genérico");
  p.line(SEP);

  // Formato estándar de 58 mm: nombre completo (partido en líneas si hace falta)
  // y debajo "cant x precio" a la izquierda con el importe a la derecha.
  let subtotal = 0;
  for (const it of ITEMS) {
    const importe = it.qty * it.price;
    subtotal += importe;
    wrap(it.name).forEach((w) => p.line(w));
    p.line(lr(`  ${it.qty} x ${monto(it.price)}`, monto(importe)));
  }
  p.line(SEP);
  p.line(lr("Subtotal", monto(subtotal)));
  p.bold(true).line(lr("TOTAL", monto(subtotal))).bold(false);
  p.line(lr("Contado - Paga con", monto(PAGO)));
  p.line(lr("Vuelto", monto(PAGO - subtotal)));
  p.line(SEP2);
  p.align("center").line("¡Gracias por preferirnos!");
  p.barcodeEan13(EAN_PRUEBA, s.barras);
  p.align("left");
  return finish(p, s);
}

export const LINEA_TILDES = "áéíóú ñ Ñ ¿ ¡ ü";

/** Una línea de identificación + tildes por cada code page. */
export function todosCodePages(s: TicketSettings): Doc {
  const p = nuevo(s, 0);
  for (const cp of CODE_PAGES) {
    p.codePage(cp.escT).line(`ESC t ${cp.escT} = ${cp.name}:`).line(LINEA_TILDES).line();
  }
  return finish(p, s, 3);
}

export function colon(s: TicketSettings): Doc {
  const p = nuevo(s);
  p.line("Prueba simbolo colon:");
  p.line("1) Unicode directo:").line("₡1.500");
  p.line("2) Texto:").line("CRC 1.500");
  p.line("3) Centavo como sustituto:").line("¢1.500");
  return finish(p, s, 3);
}

export function gaveta(s: TicketSettings): Doc {
  const p = nuevo(s, 0);
  p.drawer();
  return { bytes: p.bytes(), missing: [] };
}
