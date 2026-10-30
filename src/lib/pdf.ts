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
