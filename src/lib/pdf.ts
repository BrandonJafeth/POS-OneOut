// Generador de PDF sin dependencias, tamaño carta. Dos formatos:
//  - crearDocumento: documento de negocio (reportes de inventario, datos del cliente). Encabezado con
//    el negocio y el título, resumen con las cifras clave, tablas con números alineados a la derecha,
//    filas alternas y total, y pie con la página en cada hoja. Grafito, como la app (DESIGN.md).
//  - crearPdfReporte: el cierre Z, en Courier para que diga lo mismo (y en las mismas columnas) que
//    el papel térmico, con el mismo encabezado y pie que los demás documentos.
// Las tildes van en WinAnsi (= CP1252), la misma tabla que ya existe en codepages.ts.
import { codePageByEscT, encode } from "./codepages";

const CP1252 = codePageByEscT(16)!;
const ANCHO = 612; // carta, en puntos (1/72")
const ALTO = 792;
const M = 48; // margen
const UTIL = ANCHO - 2 * M;
const PIE = 40; // línea base del pie

// Grises (0 = negro): texto, tenue, líneas, fondos.
const G = { texto: 0.1, tenue: 0.38, fuerte: 0.15, linea: 0.82, cabecera: 0.925, cebra: 0.972, tarjeta: 0.955 };

export interface Logo1Bit {
  ancho: number; // múltiplo de 8
  alto: number;
  bits: Uint8Array; // 1 = punto negro (formato GS v 0)
}

// ─────────── Medidas de Helvetica (AFM, milésimas de em) ───────────

// Caracteres 32…126.
const ANCHOS =
  "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584"
    .split(" ")
    .map(Number);
const ESPECIALES: Record<string, number> = { "−": 333, "¢": 556, "…": 1000, "·": 278, "°": 400, "—": 1000, "–": 556, "×": 584, "«": 556, "»": 556 };

function anchoLetra(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c >= 32 && c <= 126) return ANCHOS[c - 32];
  if (ch in ESPECIALES) return ESPECIALES[ch];
  const base = ch.normalize("NFD")[0]; // á → a, Ñ → N
  const b = base.codePointAt(0)!;
  return b >= 32 && b <= 126 ? ANCHOS[b - 32] : 556;
}

/** Ancho en puntos de un texto en Helvetica (la negrita es un poco más ancha, salvo los dígitos). */
export function medir(s: string, tam: number, negrita = false): number {
  let w = 0;
  for (const ch of s) w += anchoLetra(ch) * (negrita && !/\d/.test(ch) ? 1.06 : 1);
  return (w * tam) / 1000;
}

/** Recorta con «…» para que quepa en `max` puntos. */
function recortar(s: string, max: number, tam: number, negrita = false): string {
  if (medir(s, tam, negrita) <= max) return s;
  let t = s;
  while (t && medir(t + "…", tam, negrita) > max) t = t.slice(0, -1);
  return t.trimEnd() + "…";
}

/** Parte un párrafo en líneas que quepan en `max` puntos. */
function partir(s: string, max: number, tam: number, negrita = false): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of s.split(/\s+/).filter(Boolean)) {
    const prueba = cur ? `${cur} ${p}` : p;
    if (cur && medir(prueba, tam, negrita) > max) out.push(cur), (cur = p);
    else cur = prueba;
  }
  out.push(cur);
  return out.map((l) => recortar(l, max, tam, negrita));
}

// ─────────── Bajo nivel: contenido de página y archivo ───────────

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const n2 = (v: number) => v.toFixed(2);

/** Texto PDF entre paréntesis: se escapan \ ( ) y se codifica en CP1252 (byte a byte). */
function cadena(s: string): number[] {
  const out: number[] = [0x28];
  // El menos tipográfico (−) no existe en WinAnsi: saldría "?".
  for (const b of encode(s.replace(/−/g, "-"), CP1252).bytes) {
    if (b === 0x5c || b === 0x28 || b === 0x29) out.push(0x5c);
    out.push(b);
  }
  out.push(0x29);
  return out;
}

type Fuente = "F1" | "F2" | "F3" | "F4"; // Helvetica, Helvetica-Bold, Courier, Courier-Bold

class Pagina {
  c: number[] = [];
  texto(x: number, y: number, s: string, tam: number, f: Fuente = "F1", gris = G.texto) {
    this.c.push(...ascii(`BT /${f} ${tam} Tf ${gris} g ${n2(x)} ${n2(y)} Td `), ...cadena(s), ...ascii(" Tj ET\n"));
  }
  /** Texto alineado a la derecha en `xDer` (solo Helvetica). */
  derecha(xDer: number, y: number, s: string, tam: number, negrita = false, gris = G.texto) {
    this.texto(xDer - medir(s, tam, negrita), y, s, tam, negrita ? "F2" : "F1", gris);
  }
  rect(x: number, y: number, w: number, h: number, gris: number) {
    this.c.push(...ascii(`${gris} g ${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re f\n`));
  }
  linea(x1: number, y: number, x2: number, gris = G.linea, grosor = 0.5) {
    this.c.push(...ascii(`${gris} G ${grosor} w ${n2(x1)} ${n2(y)} m ${n2(x2)} ${n2(y)} l S\n`));
  }
  imagen(x: number, y: number, w: number, h: number) {
    this.c.push(...ascii(`q ${n2(w)} 0 0 ${n2(h)} ${n2(x)} ${n2(y)} cm /Im1 Do Q\n`));
  }
}

function logoValido(l?: Logo1Bit | null): Logo1Bit | null {
  return l && l.ancho > 0 && l.alto > 0 && l.bits.length >= (l.ancho / 8) * l.alto ? l : null;
}

/** Arma el archivo: catálogo, fuentes, logo (si hay) y una página por contenido. */
function ensamblar(paginas: Pagina[], logo: Logo1Bit | null): Uint8Array {
  const objetos: number[][] = [];
  const primera = 8;
  objetos[1] = ascii("<< /Type /Catalog /Pages 2 0 R >>");
  objetos[2] = ascii(`<< /Type /Pages /Kids [${paginas.map((_, i) => `${primera + i * 2 + 1} 0 R`).join(" ")}] /Count ${paginas.length} >>`);
  ["Helvetica", "Helvetica-Bold", "Courier", "Courier-Bold"].forEach((f, i) => (objetos[3 + i] = ascii(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`)));
  const bytesLogo = logo ? (logo.ancho / 8) * logo.alto : 0;
  objetos[7] = logo
    ? [
        ...ascii(`<< /Type /XObject /Subtype /Image /Width ${logo.ancho} /Height ${logo.alto} /ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [1 0] /Length ${bytesLogo} >>\nstream\n`),
        ...logo.bits.subarray(0, bytesLogo),
        ...ascii("\nendstream"),
      ]
    : ascii("null");
  paginas.forEach((p, i) => {
    const nc = primera + i * 2;
    objetos[nc] = [...ascii(`<< /Length ${p.c.length} >>\nstream\n`), ...p.c, ...ascii("endstream")];
    objetos[nc + 1] = ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >>${logo ? " /XObject << /Im1 7 0 R >>" : ""} >> /Contents ${nc} 0 R >>`,
    );
  });
  const out: number[] = ascii("%PDF-1.4\n");
  const offsets: number[] = [];
  for (let n = 1; n < objetos.length; n++) {
    offsets[n] = out.length;
    out.push(...ascii(`${n} 0 obj\n`), ...objetos[n], ...ascii("\nendobj\n"));
  }
  const xref = out.length;
  out.push(...ascii(`xref\n0 ${objetos.length}\n0000000000 65535 f \n`));
  for (let n = 1; n < objetos.length; n++) out.push(...ascii(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`));
  out.push(...ascii(`trailer\n<< /Size ${objetos.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Uint8Array.from(out);
}

// ─────────── Encabezado y pie compartidos ───────────

export interface Encabezado {
  /** Nombre del negocio. */
  negocio: string;
  titulo: string;
  /** Una línea de contexto: período, caja, filtros… */
  subtitulo?: string;
  logo?: Logo1Bit | null;
}

const generado = () => new Date().toLocaleString("es-CR", { dateStyle: "medium", timeStyle: "short" });

/** Encabezado completo en la primera hoja; en las demás, una línea corta. Devuelve la y donde sigue. */
function encabezado(p: Pagina, e: Encabezado, primera: boolean, logo: Logo1Bit | null): number {
  let y = ALTO - M;
  if (!primera) {
    p.texto(M, y - 8, recortar(`${e.negocio} · ${e.titulo}`, UTIL, 8.5, true), 8.5, "F2", G.tenue);
    p.linea(M, y - 15, ANCHO - M, G.linea, 0.6);
    return y - 34;
  }
  let x = M;
  if (logo) {
    const esc = Math.min(110 / logo.ancho, 52 / logo.alto, 1);
    const w = logo.ancho * esc;
    const h = logo.alto * esc;
    p.imagen(M, y - h, w, h);
    x = M + w + 14;
  }
  const derecha = `Generado ${generado()}`;
  const anchoTitulo = ANCHO - M - x - medir(derecha, 8, false) - 16;
  p.texto(x, y - 9, recortar(e.negocio.toUpperCase(), anchoTitulo, 8.5, true), 8.5, "F2", G.tenue);
  p.derecha(ANCHO - M, y - 9, derecha, 8, false, G.tenue);
  const lineasTitulo = partir(e.titulo, ANCHO - M - x, 19, true).slice(0, 2);
  lineasTitulo.forEach((l, i) => p.texto(x, y - 31 - i * 22, l, 19, "F2"));
  let yy = y - 31 - (lineasTitulo.length - 1) * 22;
  if (e.subtitulo) {
    for (const l of partir(e.subtitulo, ANCHO - M - x, 9.5).slice(0, 2)) p.texto(x, (yy -= 16), l, 9.5, "F1", G.tenue);
  }
  yy = Math.min(yy, logo ? y - Math.min(52, logo.alto) : yy) - 14;
  p.linea(M, yy, ANCHO - M, G.fuerte, 1.2);
  return yy - 22;
}

function pies(paginas: Pagina[], e: Encabezado) {
  paginas.forEach((p, i) => {
    p.linea(M, PIE + 12, ANCHO - M, G.linea, 0.5);
    p.texto(M, PIE, recortar(`${e.negocio} · ${e.titulo}`, UTIL - 90, 7.5), 7.5, "F1", G.tenue);
    p.derecha(ANCHO - M, PIE, `Página ${i + 1} de ${paginas.length}`, 7.5, false, G.tenue);
  });
}

// ─────────── Documento de negocio ───────────

export type Celda = string | number;

export interface Columna {
  titulo: string;
  /** Parte del ancho útil (se reparten en proporción). */
  ancho: number;
  /** Números: a la derecha. */
  derecha?: boolean;
}

export type Bloque =
  /** Cifras clave en tarjetas (hasta 4 por fila). */
  | { tipo: "resumen"; items: { etiqueta: string; valor: string }[] }
  | { tipo: "seccion"; titulo: string; nota?: string }
  | { tipo: "tabla"; columnas: Columna[]; filas: Celda[][]; total?: Celda[]; vacio?: string }
  /** Pares etiqueta → valor (datos de una persona o de un registro). */
  | { tipo: "datos"; pares: [string, string][] }
  | { tipo: "texto"; texto: string; tenue?: boolean };

const BAJO = PIE + 26; // por debajo de aquí no se escribe contenido

export function crearDocumento(o: Encabezado & { bloques: Bloque[] }): Uint8Array {
  const logo = logoValido(o.logo);
  const paginas: Pagina[] = [];
  let p!: Pagina;
  let y = 0;
  const nueva = () => {
    p = new Pagina();
    paginas.push(p);
    y = encabezado(p, o, paginas.length === 1, logo);
  };
  /** Hay lugar para `h` puntos? Si no, hoja nueva. Devuelve si cambió de hoja. */
  const lugar = (h: number) => {
    if (y - h >= BAJO) return false;
    nueva();
    return true;
  };
  nueva();

  for (const b of o.bloques) {
    if (b.tipo === "resumen") {
      const porFila = Math.min(4, b.items.length) || 1;
      const sep = 10;
      const w = (UTIL - sep * (porFila - 1)) / porFila;
      for (let i = 0; i < b.items.length; i += porFila) {
        lugar(54);
        b.items.slice(i, i + porFila).forEach((it, j) => {
          const x = M + j * (w + sep);
          p.rect(x, y - 46, w, 46, G.tarjeta);
          p.rect(x, y - 46, 2.5, 46, G.fuerte);
          p.texto(x + 12, y - 16, recortar(it.etiqueta.toUpperCase(), w - 20, 7.5, true), 7.5, "F2", G.tenue);
          p.texto(x + 12, y - 36, recortar(it.valor, w - 20, 15, true), 15, "F2");
        });
        y -= 46 + 12;
      }
      y -= 8;
    } else if (b.tipo === "seccion") {
      lugar(b.nota ? 64 : 50); // título + al menos una fila de lo que sigue
      p.texto(M, (y -= 12), b.titulo, 12, "F2");
      if (b.nota) for (const l of partir(b.nota, UTIL, 8.5)) p.texto(M, (y -= 13), l, 8.5, "F1", G.tenue);
      y -= 12;
    } else if (b.tipo === "texto") {
      for (const l of partir(b.texto, UTIL, 9.5)) {
        lugar(14);
        p.texto(M, (y -= 13), l, 9.5, "F1", b.tenue ? G.tenue : G.texto);
      }
      y -= 10;
    } else if (b.tipo === "datos") {
      const wk = UTIL * 0.34;
      for (const [k, v] of b.pares) {
        const lineas = partir(v || "—", UTIL - wk - 8, 9.5);
        const h = 9 + lineas.length * 13;
        lugar(h);
        p.texto(M, y - 13, recortar(k, wk - 8, 9, true), 9, "F2", G.tenue);
        lineas.forEach((l, i) => p.texto(M + wk, y - 13 - i * 13, l, 9.5, "F1", v ? G.texto : G.tenue));
        y -= h;
        p.linea(M, y + 2, ANCHO - M, G.linea, 0.4);
      }
      y -= 14;
    } else {
      tabla(b);
    }
  }
  pies(paginas, o);
  return ensamblar(paginas, logo);

  function tabla(t: Extract<Bloque, { tipo: "tabla" }>) {
    const suma = t.columnas.reduce((s, c) => s + c.ancho, 0) || 1;
    const xs: number[] = [];
    let x = M;
    for (const c of t.columnas) xs.push(x), (x += (c.ancho / suma) * UTIL);
    const anchoCol = (i: number) => (i + 1 < xs.length ? xs[i + 1] : ANCHO - M) - xs[i];
    const PAD = 6;
    const ALTO_FILA = 17;
    const celda = (v: Celda, i: number, yy: number, tam: number, negrita: boolean, gris = G.texto) => {
      const s = recortar(String(v ?? ""), anchoCol(i) - 2 * PAD, tam, negrita);
      if (t.columnas[i].derecha) p.derecha(xs[i] + anchoCol(i) - PAD, yy, s, tam, negrita, gris);
      else p.texto(xs[i] + PAD, yy, s, tam, negrita ? "F2" : "F1", gris);
    };
    const cabecera = () => {
      p.rect(M, y - 20, UTIL, 20, G.cabecera);
      t.columnas.forEach((c, i) => celda(c.titulo, i, y - 13.5, 8, true, G.fuerte));
      y -= 20;
    };
    lugar(20 + ALTO_FILA * Math.min(2, Math.max(1, t.filas.length)));
    cabecera();
    if (!t.filas.length) {
      p.texto(M + PAD, y - 13, t.vacio ?? "Sin datos.", 9, "F1", G.tenue);
      y -= ALTO_FILA + 14;
      return;
    }
    t.filas.forEach((f, n) => {
      if (lugar(ALTO_FILA)) cabecera(); // la cabecera se repite en cada hoja
      if (n % 2 === 1) p.rect(M, y - ALTO_FILA, UTIL, ALTO_FILA, G.cebra);
      f.forEach((v, i) => i < t.columnas.length && celda(v, i, y - 11.5, 9, false));
      y -= ALTO_FILA;
    });
    p.linea(M, y, ANCHO - M, G.linea, 0.5);
    if (t.total) {
      lugar(ALTO_FILA + 4);
      p.linea(M, y, ANCHO - M, G.fuerte, 1);
      t.total.forEach((v, i) => i < t.columnas.length && celda(v, i, y - 12.5, 9.5, true));
      y -= ALTO_FILA + 2;
    }
    y -= 18;
  }
}

// ─────────── Cierre Z (Courier, igual que el papel) ───────────

export interface LineaReporte {
  texto: string;
  negrita?: boolean;
  centro?: boolean;
  /** Empieza una página nueva antes de esta línea. */
  salto?: boolean;
}

/** Columnas que caben en una línea del reporte (Courier 9 pt en carta). */
export const COLUMNAS_REPORTE = 90;
const TAM_R = 9;
const ALTO_R = 11.5;

export function crearPdfReporte(o: Encabezado & { lineas: LineaReporte[] }): Uint8Array {
  const logo = logoValido(o.logo);
  const anchoCourier = (n: number) => n * TAM_R * 0.6;
  const x0 = M + (UTIL - anchoCourier(COLUMNAS_REPORTE)) / 2;
  const paginas: Pagina[] = [];
  let p!: Pagina;
  let y = 0;
  let vacia = true;
  const nueva = () => {
    p = new Pagina();
    paginas.push(p);
    y = encabezado(p, o, paginas.length === 1, logo);
    vacia = true;
  };
  nueva();
  for (const l of o.lineas) {
    if ((l.salto && !vacia) || y - ALTO_R < BAJO) nueva();
    vacia = false;
    const s = l.texto.slice(0, COLUMNAS_REPORTE);
    // Las líneas de "====" o "----" del papel son reglas de verdad en la hoja.
    if (/^[=-]{8,}$/.test(s.trim())) {
      const fuerte = s.trim()[0] === "=";
      p.linea(x0, y - ALTO_R / 2, x0 + anchoCourier(COLUMNAS_REPORTE), fuerte ? G.fuerte : G.linea, fuerte ? 0.9 : 0.5);
    } else {
      const x = l.centro ? x0 + (anchoCourier(COLUMNAS_REPORTE) - anchoCourier(s.length)) / 2 : x0;
      // Títulos de sección (en negrita) con una banda suave detrás, como la cabecera de una tabla.
      if (l.negrita && !l.centro && s.trim()) p.rect(x0 - 4, y - ALTO_R + 1, anchoCourier(COLUMNAS_REPORTE) + 8, ALTO_R + 1, G.cebra);
      p.texto(x, y - 9, s, TAM_R, l.negrita ? "F4" : "F3");
    }
    y -= ALTO_R;
  }
  pies(paginas, o);
  return ensamblar(paginas, logo);
}
