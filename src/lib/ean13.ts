// Validación EAN-13 / ISBN-13 (dígito verificador módulo 10, pesos 1 y 3).

export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** ISBN-13 = EAN-13 válido con prefijo 978 o 979. */
export function isIsbn13(code: string): boolean {
  return isValidEan13(code) && /^97[89]/.test(code);
}

/**
 * Otras formas en que el mismo código puede estar guardado o salir del lector: UPC-A de 12 dígitos
 * = EAN-13 con un 0 adelante, e ISBN-10 = ISBN-13 con prefijo 978. Sin esto, un producto que sí
 * está en el catálogo sale como "no registrado".
 */
export function variantesCodigo(codigo: string): string[] {
  const c = codigo.trim().replace(/-/g, "").toUpperCase();
  const out: string[] = [];
  if (/^\d{12}$/.test(c)) out.push("0" + c);
  if (/^0\d{12}$/.test(c)) out.push(c.slice(1));
  const pesos = (nueve: string) => [...nueve].reduce((s, d, i) => s + Number(d) * (10 - i), 0);
  // ISBN-10 válido (verificador módulo 11, X = 10) → su ISBN-13.
  if (/^\d{9}[\dX]$/.test(c) && (pesos(c.slice(0, 9)) + (c[9] === "X" ? 10 : Number(c[9]))) % 11 === 0) {
    const base = "978" + c.slice(0, 9);
    out.push(base + ean13CheckDigit(base));
  }
  // ISBN-13 con prefijo 978 → su ISBN-10 (los 979 no tienen).
  if (/^978\d{10}$/.test(c) && isValidEan13(c)) {
    const nueve = c.slice(3, 12);
    const v = (11 - (pesos(nueve) % 11)) % 11;
    out.push(nueve + (v === 10 ? "X" : String(v)));
  }
  return out;
}

// Tablas de codificación EAN-13 (para dibujar las barras en la vista previa).
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** Devuelve 95 módulos ("1" = barra) o null si el código no es EAN-13 válido. */
export function ean13Modules(code: string): string | null {
  if (!isValidEan13(code)) return null;
  const d = code.split("").map(Number);
  const parity = PARITY[d[0]];
  let out = "101";
  for (let i = 1; i <= 6; i++) out += (parity[i - 1] === "L" ? L : G)[d[i]];
  out += "01010";
  for (let i = 7; i <= 12; i++) out += R[d[i]];
  return out + "101";
}

/** Prefijo GS1 "200–299": uso interno de la tienda, nunca choca con códigos de fábrica. */
export const PREFIJO_INTERNO = "200";

/** Código interno n.º `secuencia`: "200" + 9 dígitos + verificador. */
export function codigoInterno(secuencia: number): string {
  if (!Number.isSafeInteger(secuencia) || secuencia < 1 || secuencia > 999_999_999) throw new Error("Secuencia de código interno fuera de rango");
  const base = PREFIJO_INTERNO + String(secuencia).padStart(9, "0");
  return base + ean13CheckDigit(base);
}
