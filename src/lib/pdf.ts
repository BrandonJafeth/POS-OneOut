// Generador de PDF mínimo, sin dependencias: páginas carta con texto en Helvetica.
// Alcanza para "exportar mis datos" (Ley 8968). Las tildes van en WinAnsi (= CP1252),
// la misma tabla que ya existe en codepages.ts.
import { codePageByEscT, encode } from "./codepages";

const CP1252 = codePageByEscT(16)!;
const ANCHO = 612; // carta, en puntos (1/72")
const ALTO = 792;
const MARGEN = 56;
const TAM = 10;
const INTERLINEA = 14;
const POR_PAGINA = Math.floor((ALTO - 2 * MARGEN) / INTERLINEA);
const MAX_CARACTERES = 95;

export interface LineaPdf {
  texto: string;
  negrita?: boolean;
}

/** Texto PDF entre paréntesis: se escapan \ ( ) y se codifica en CP1252 (byte a byte). */
function cadena(s: string): number[] {
  const out: number[] = [0x28];
  for (const b of encode(s, CP1252).bytes) {
    if (b === 0x5c || b === 0x28 || b === 0x29) out.push(0x5c);
    out.push(b);
  }
  out.push(0x29);
  return out;
}

/** Corta líneas largas en palabras para que no se salgan de la hoja. */
function partir(lineas: LineaPdf[]): LineaPdf[] {
  const out: LineaPdf[] = [];
  for (const l of lineas) {
    const palabras = l.texto.split(" ");
    let cur = "";
    for (const p of palabras) {
      if (cur && (cur + " " + p).length > MAX_CARACTERES) out.push({ ...l, texto: cur }), (cur = p);
      else cur = cur ? cur + " " + p : p;
    }
    out.push({ ...l, texto: cur });
  }
  return out;
}

export function crearPdf(lineas: LineaPdf[]): Uint8Array {
  const todas = partir(lineas);
  const paginas: LineaPdf[][] = [];
  for (let i = 0; i < Math.max(1, todas.length); i += POR_PAGINA) paginas.push(todas.slice(i, i + POR_PAGINA));

  const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
  const objetos: number[][] = [];
  // 1 catálogo, 2 páginas, 3 fuente normal, 4 fuente negrita, luego por página: contenido + página.
  const nPaginas = paginas.map((_, i) => 5 + i * 2 + 1);
  objetos[1] = ascii("<< /Type /Catalog /Pages 2 0 R >>");
  objetos[2] = ascii(`<< /Type /Pages /Kids [${nPaginas.map((n) => `${n} 0 R`).join(" ")}] /Count ${paginas.length} >>`);
  objetos[3] = ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objetos[4] = ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  paginas.forEach((pag, i) => {
    const contenido: number[] = [];
    let y = ALTO - MARGEN;
    for (const l of pag) {
      contenido.push(...ascii(`BT /${l.negrita ? "F2" : "F1"} ${TAM} Tf ${MARGEN} ${y} Td `), ...cadena(l.texto), ...ascii(" Tj ET\n"));
      y -= INTERLINEA;
    }
    const nc = 5 + i * 2;
    objetos[nc] = [...ascii(`<< /Length ${contenido.length} >>\nstream\n`), ...contenido, ...ascii("endstream")];
    objetos[nc + 1] = ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${nc} 0 R >>`,
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

// ─── Reporte tabular (cierre Z) ───
// Courier para que las columnas queden alineadas como en el papel, encabezado y número de página
// en cada hoja, y el logo del negocio (1 bit, el mismo del tiquete) arriba de la primera.

export interface LineaReporte {
  texto: string;
  negrita?: boolean;
  centro?: boolean;
  /** Empieza una página nueva antes de esta línea. */
  salto?: boolean;
}

export interface Logo1Bit {
  ancho: number; // múltiplo de 8
  alto: number;
  bits: Uint8Array; // 1 = punto negro (formato GS v 0)
}

/** Columnas que caben en una línea del reporte (Courier 9 pt en carta). */
export const COLUMNAS_REPORTE = 90;
const TAM_R = 9;
const ALTO_R = 11.5;
const MARGEN_R = 40;

export function crearPdfReporte(o: { titulo: string; subtitulo: string; lineas: LineaReporte[]; logo?: Logo1Bit | null }): Uint8Array {
  const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
  const ancho = (n: number) => n * TAM_R * 0.6;
  // Logo: hasta 160 × 70 pt, respetando la proporción.
  const logo = o.logo && o.logo.ancho > 0 && o.logo.alto > 0 && o.logo.bits.length >= (o.logo.ancho / 8) * o.logo.alto ? o.logo : null;
  const escala = logo ? Math.min(160 / logo.ancho, 70 / logo.alto, 1) : 0;
  const altoLogo = logo ? logo.alto * escala + 8 : 0;
  const cabecera = 3 * ALTO_R + 6;
  // Reparte las líneas en páginas.
  const paginas: LineaReporte[][] = [[]];
  let y = ALTO - MARGEN_R - cabecera - altoLogo;
  for (const l of o.lineas) {
    if ((l.salto && paginas[paginas.length - 1].length) || y < MARGEN_R) {
      paginas.push([]);
      y = ALTO - MARGEN_R - cabecera;
    }
    paginas[paginas.length - 1].push(l);
    y -= ALTO_R;
  }
  const objetos: number[][] = [];
  const nPaginas = paginas.map((_, i) => 6 + i * 2 + 1);
  objetos[1] = ascii("<< /Type /Catalog /Pages 2 0 R >>");
  objetos[2] = ascii(`<< /Type /Pages /Kids [${nPaginas.map((n) => `${n} 0 R`).join(" ")}] /Count ${paginas.length} >>`);
  objetos[3] = ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  objetos[4] = ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");
  objetos[5] = logo
    ? [
        ...ascii(`<< /Type /XObject /Subtype /Image /Width ${logo.ancho} /Height ${logo.alto} /ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [1 0] /Length ${(logo.ancho / 8) * logo.alto} >>\nstream\n`),
        ...logo.bits.subarray(0, (logo.ancho / 8) * logo.alto),
        ...ascii("\nendstream"),
      ]
    : ascii("null");
  paginas.forEach((pag, i) => {
    const c: number[] = [];
    const texto = (x: number, yy: number, s: string, negrita = false) =>
      c.push(...ascii(`BT /${negrita ? "F2" : "F1"} ${TAM_R} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td `), ...cadena(s), ...ascii(" Tj ET\n"));
    let yy = ALTO - MARGEN_R;
    if (i === 0 && logo) {
      const w = logo.ancho * escala;
      const h = logo.alto * escala;
      c.push(...ascii(`q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${MARGEN_R} ${(yy - h).toFixed(1)} cm /Im1 Do Q\n`));
      yy -= altoLogo;
    }
    const pagina = `Página ${String(i + 1).padStart(3, "0")} de ${String(paginas.length).padStart(3, "0")}`;
    texto(MARGEN_R, yy, o.titulo, true);
    texto(ANCHO - MARGEN_R - ancho(pagina.length), yy, pagina);
    yy -= ALTO_R;
    texto(MARGEN_R, yy, o.subtitulo);
    yy -= ALTO_R;
    c.push(...ascii(`${MARGEN_R} ${(yy + 4).toFixed(1)} m ${ANCHO - MARGEN_R} ${(yy + 4).toFixed(1)} l 0.8 w S\n`));
    yy -= ALTO_R + 6 - ALTO_R;
    yy -= ALTO_R;
    for (const l of pag) {
      const s = l.texto.slice(0, COLUMNAS_REPORTE);
      const x = l.centro ? (ANCHO - ancho(s.length)) / 2 : MARGEN_R;
      texto(x, yy, s, l.negrita);
      yy -= ALTO_R;
    }
    const nc = 6 + i * 2;
    objetos[nc] = [...ascii(`<< /Length ${c.length} >>\nstream\n`), ...c, ...ascii("endstream")];
    objetos[nc + 1] = ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${logo ? " /XObject << /Im1 5 0 R >>" : ""} >> /Contents ${nc} 0 R >>`,
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
