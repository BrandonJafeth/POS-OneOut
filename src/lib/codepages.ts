// Tablas propias de code pages (mitad alta 0x80–0xFF). La mitad baja 0x00–0x7F es ASCII.
// Evita depender de iconv-lite, que necesita Buffer de Node y polyfills en el navegador.

// "￿" marca posiciones sin carácter asignado (huecos en CP1252).
const X = "￿";

const CP437 =
  "ÇüéâäàåçêëèïîìÄÅ" +
  "ÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧" +
  "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩" +
  "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

const CP850 =
  "ÇüéâäàåçêëèïîìÄÅ" +
  "ÉæÆôöòûùÿÖÜø£Ø×ƒ" +
  "áíóúñÑªº¿®¬½¼¡«»" +
  "░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐" +
  "└┴┬├─┼ãÃ╚╔╩╦╠═╬¤" +
  "ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀" +
  "ÓßÔÒõÕµþÞÚÛÙýÝ¯´" +
  "­±‗¾¶§÷¸°¨·¹³²■ ";

// CP858 = CP850 con € en 0xD5 (en lugar de ı).
const CP858 = CP850.slice(0, 0x55) + "€" + CP850.slice(0x56);

// WPC1252 (Windows-1252): 0x80–0x9F propios, 0xA0–0xFF igual a Latin-1.
const CP1252 =
  "€" + X + "‚ƒ„…†‡ˆ‰Š‹Œ" + X + "Ž" + X +
  X + "‘’“”•–—˜™š›œ" + X + "žŸ" +
  Array.from({ length: 96 }, (_, i) => String.fromCharCode(0xa0 + i)).join("");

export interface CodePage {
  /** Valor n de ESC t n (según manual ESC/POS de Epson; los clones pueden variar). */
  escT: number;
  name: string;
  high: string; // 128 caracteres para 0x80–0xFF
}

export const CODE_PAGES: CodePage[] = [
  { escT: 0, name: "CP437", high: CP437 },
  { escT: 2, name: "CP850", high: CP850 },
  { escT: 16, name: "WPC1252", high: CP1252 },
  { escT: 19, name: "CP858", high: CP858 },
];

for (const cp of CODE_PAGES) {
  if (cp.high.length !== 128) throw new Error(`Tabla ${cp.name} mal formada: ${cp.high.length}`);
}

export function codePageByEscT(n: number): CodePage | undefined {
  return CODE_PAGES.find((c) => c.escT === n);
}

const encodeMaps = new Map<number, Map<string, number>>();

function encodeMap(cp: CodePage): Map<string, number> {
  let m = encodeMaps.get(cp.escT);
  if (!m) {
    m = new Map();
    for (let i = 0; i < 128; i++) if (cp.high[i] !== X) m.set(cp.high[i], 0x80 + i);
    encodeMaps.set(cp.escT, m);
  }
  return m;
}

export const REPLACEMENT = 0x3f; // "?"

/** Codifica texto; los caracteres que no existen en el code page salen como "?". */
export function encode(text: string, cp: CodePage): { bytes: number[]; missing: string[] } {
  const map = encodeMap(cp);
  const bytes: number[] = [];
  const missing: string[] = [];
  // Una tilde suelta (e + ◌́) no existe en la impresora: se pega a su letra antes (NFC).
  for (const ch of text.normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c < 0x7f) bytes.push(c);
    else {
      const b = map.get(ch);
      if (b === undefined) {
        bytes.push(REPLACEMENT);
        missing.push(ch);
      } else bytes.push(b);
    }
  }
  return { bytes, missing };
}

/** Decodifica un byte imprimible (≥ 0x20). null si no hay carácter. */
export function decodeByte(b: number, cp: CodePage | undefined): string | null {
  if (b < 0x80) return String.fromCharCode(b);
  if (!cp) return null;
  const ch = cp.high[b - 0x80];
  return ch === X ? null : ch;
}
