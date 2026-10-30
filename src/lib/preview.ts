// Intérprete ESC/POS mínimo: convierte los BYTES (los mismos que van a la impresora) en
// líneas para la vista previa. Solo entiende los comandos que genera escpos.ts; lo demás
// lo muestra como evento "desconocido" para no esconder errores.
import { codePageByEscT, decodeByte, REPLACEMENT, type CodePage } from "./codepages";

export interface Span {
  text: string;
  bold: boolean;
  dw: boolean;
  dh: boolean;
  bad: boolean; // "?" de reemplazo o byte sin carácter en el code page
}

export type PreviewItem =
  | { kind: "line"; align: "left" | "center" | "right"; spans: Span[] }
  | { kind: "barcode"; data: string; type: number }
  | { kind: "image"; align: "left" | "center" | "right"; width: number; height: number; data: Uint8Array }
  | { kind: "event"; text: string };

export function interpret(bytes: Uint8Array): PreviewItem[] {
  const items: PreviewItem[] = [];
  let align: "left" | "center" | "right" = "left";
  let bold = false;
  let dw = false;
  let dh = false;
  let cp: CodePage | undefined = codePageByEscT(0);
  let spans: Span[] = [];

  const push = (ch: string, bad: boolean) => {
    const last = spans[spans.length - 1];
    if (last && last.bold === bold && last.dw === dw && last.dh === dh && last.bad === bad) last.text += ch;
    else spans.push({ text: ch, bold, dw, dh, bad });
  };
  const flush = () => {
    items.push({ kind: "line", align, spans });
    spans = [];
  };
  const reset = () => {
    align = "left";
    bold = dw = dh = false;
  };

  let i = 0;
  const at = (k: number) => bytes[i + k] ?? 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x0a) {
      flush();
      i += 1;
    } else if (b === 0x1b) {
      const c = at(1);
      if (c === 0x40) {
        reset();
        cp = codePageByEscT(0);
        i += 2;
      } else if (c === 0x74) {
        cp = codePageByEscT(at(2));
        if (!cp) items.push({ kind: "event", text: `ESC t ${at(2)}: code page sin tabla en la vista previa` });
        i += 3;
      } else if (c === 0x61) {
        align = (["left", "center", "right"] as const)[at(2) % 3] ?? "left";
        i += 3;
      } else if (c === 0x45) {
        bold = at(2) === 1;
        i += 3;
      } else if (c === 0x64) {
        if (spans.length) flush();
        for (let n = 0; n < at(2); n++) items.push({ kind: "line", align, spans: [] });
        i += 3;
      } else if (c === 0x70) {
        items.push({ kind: "event", text: `ESC p: pulso a gaveta (pin ${at(2)}, ${at(3) * 2}/${at(4) * 2} ms)` });
        i += 5;
      } else {
        items.push({ kind: "event", text: `ESC 0x${c.toString(16)} desconocido` });
        i += 2;
      }
    } else if (b === 0x1d) {
      const c = at(1);
      if (c === 0x21) {
        dw = (at(2) & 0xf0) !== 0;
        dh = (at(2) & 0x0f) !== 0;
        i += 3;
      } else if (c === 0x68 || c === 0x77 || c === 0x48) {
        i += 3; // alto / ancho / HRI del código de barras: no afectan el texto
      } else if (c === 0x6b) {
        const m = at(2);
        if (m >= 65) {
          // Formato B: GS k m n d1..dn
          const n = at(3);
          const data = String.fromCharCode(...bytes.slice(i + 4, i + 4 + n));
          items.push({ kind: "barcode", data, type: m });
          i += 4 + n;
        } else {
          // Formato A: GS k m d1..dk NUL
          let j = i + 3;
          while (j < bytes.length && bytes[j] !== 0) j++;
          items.push({ kind: "barcode", data: String.fromCharCode(...bytes.slice(i + 3, j)), type: m });
          i = j + 1;
        }
      } else if (c === 0x76 && at(2) === 0x30) {
        // GS v 0 m xL xH yL yH d1..dk
        if (spans.length) flush();
        const bpr = at(4) | (at(5) << 8);
        const height = at(6) | (at(7) << 8);
        const data = bytes.slice(i + 8, i + 8 + bpr * height);
        items.push({ kind: "image", align, width: bpr * 8, height, data });
        i += 8 + bpr * height;
      } else if (c === 0x56) {
        if (spans.length) flush();
        items.push({ kind: "event", text: "✂ GS V: corte de papel" });
        i += at(2) >= 65 ? 4 : 3;
      } else {
        items.push({ kind: "event", text: `GS 0x${c.toString(16)} desconocido` });
        i += 2;
      }
    } else if (b === 0x1c) {
      const c = at(1);
      if (c === 0x2e) items.push({ kind: "event", text: "FS .: modo chino apagado" });
      else if (c === 0x26) items.push({ kind: "event", text: "FS &: modo chino ENCENDIDO (las tildes saldrían mal)" });
      else items.push({ kind: "event", text: `FS 0x${c.toString(16)} desconocido` });
      i += 2;
    } else if (b < 0x20) {
      items.push({ kind: "event", text: `Byte de control 0x${b.toString(16).padStart(2, "0")}` });
      i += 1;
    } else {
      const ch = decodeByte(b, cp);
      push(ch ?? "·", ch === null || b === REPLACEMENT);
      i += 1;
    }
  }
  if (spans.length) flush();
  return items;
}

/** Vista hexadecimal clásica: offset, 16 bytes, ASCII. */
export function hexDump(bytes: Uint8Array): string {
  const rows: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = Array.from(bytes.slice(off, off + 16));
    const hex = chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = chunk.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    rows.push(`${off.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return rows.join("\n");
}
