// Constructor ESC/POS mínimo. Solo lo necesario para el tiquete de prueba.
import { codePageByEscT, encode, type CodePage } from "./codepages";

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;
const LF = 0x0a;

export type Align = "left" | "center" | "right";

export class EscPos {
  private out: number[] = [];
  private cp: CodePage;
  /** Caracteres que no existían en el code page activo (salieron como "?"). */
  readonly missing = new Set<string>();

  constructor(codePage: number, opts: { sinModoChino?: boolean } = {}) {
    this.cp = codePageByEscT(codePage) ?? codePageByEscT(0)!;
    this.init();
    // Muchas POS-58 chinas arrancan en modo chino (GB2312): los bytes ≥ 0x80 se leen de a dos
    // y las tildes salen como caracteres chinos. FS . lo apaga.
    if (opts.sinModoChino) this.raw(FS, 0x2e);
    this.codePage(codePage);
  }

  raw(...bytes: number[]): this {
    this.out.push(...bytes);
    return this;
  }

  /** ESC @ — reinicia la impresora (estilos, alineación). */
  init(): this {
    return this.raw(ESC, 0x40);
  }

  /** ESC t n — selecciona tabla de caracteres. */
  codePage(n: number): this {
    this.cp = codePageByEscT(n) ?? this.cp;
    return this.raw(ESC, 0x74, n);
  }

  /** ESC a n — alineación. */
  align(a: Align): this {
    return this.raw(ESC, 0x61, a === "left" ? 0 : a === "center" ? 1 : 2);
  }

  /** ESC E n — negrita. */
  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /** GS ! n — tamaño: bits 0–3 alto, 4–7 ancho. */
  size(doubleWidth: boolean, doubleHeight: boolean): this {
    return this.raw(GS, 0x21, (doubleWidth ? 0x10 : 0) | (doubleHeight ? 0x01 : 0));
  }

  text(s: string): this {
    const { bytes, missing } = encode(s, this.cp);
    missing.forEach((m) => this.missing.add(m));
    return this.raw(...bytes);
  }

  line(s = ""): this {
    return this.text(s).raw(LF);
  }

  /** ESC d n — imprime y avanza n líneas. */
  feed(n: number): this {
    return this.raw(ESC, 0x64, n);
  }

  /**
   * Código de barras EAN-13 con GS k.
   * Formato B (m = 67, n = 13) es el moderno; formato A (m = 2, termina en NUL) es el viejo:
   * algunas POS-58 solo entienden uno de los dos.
   * Antes: GS h (alto), GS w (ancho de módulo), GS H 2 (texto legible debajo).
   */
  barcodeEan13(code: string, formato: "A" | "B" = "B"): this {
    if (!/^\d{13}$/.test(code)) throw new Error("EAN-13 requiere 13 dígitos");
    const digits = Array.from(code, (c) => c.charCodeAt(0));
    this.raw(GS, 0x68, 80); // alto 80 puntos
    this.raw(GS, 0x77, 2); // ancho de módulo 2 (95 módulos × 2 = 190 de 384 puntos)
    this.raw(GS, 0x48, 2); // HRI debajo
    if (formato === "B") this.raw(GS, 0x6b, 67, 13, ...digits);
    else this.raw(GS, 0x6b, 2, ...digits, 0);
    return this.raw(LF);
  }

  /**
   * GS v 0 — imagen de 1 bit (MSB = punto de la izquierda), respeta ESC a.
   * Se manda en franjas: algunas POS-58 tienen poco búfer y se traban con imágenes grandes.
   */
  raster(width: number, height: number, data: Uint8Array, franja = 128): this {
    const bpr = Math.ceil(width / 8);
    for (let y = 0; y < height; y += franja) {
      const h = Math.min(franja, height - y);
      this.raw(GS, 0x76, 0x30, 0, bpr & 0xff, bpr >> 8, h & 0xff, h >> 8);
      this.raw(...data.subarray(y * bpr, (y + h) * bpr));
    }
    return this;
  }

  /** GS V 66 n — avanza n puntos y corta (parcial). Solo con cortador. */
  cut(): this {
    return this.raw(GS, 0x56, 66, 0);
  }

  /** ESC p m t1 t2 — pulso a la gaveta (pin 2, 25×2 ms on, 250×2 ms off). */
  drawer(): this {
    return this.raw(ESC, 0x70, 0, 25, 250);
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}
