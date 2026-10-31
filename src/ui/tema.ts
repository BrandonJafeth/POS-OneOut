// Colores de la app: UNA sola fuente. Se aplican como variables CSS (--nombre) y la prueba
// tests/tema.test.ts verifica el contraste WCAG 2.1 AA de cada combinación que se usa.

export type NombreTema = "claro" | "oscuro";

export interface Tema {
  bg: string; // fondo de la app
  card: string; // tarjetas, modales, tablas
  card2: string; // zonas secundarias dentro de una tarjeta (encabezados de tabla, filas pares)
  line: string; // bordes de campos y botones (≥ 3:1 contra bg y card: WCAG 1.4.11)
  hair: string; // divisores y contornos decorativos (no identifican un control)
  text: string;
  muted: string; // texto secundario (≥ 4,5:1)
  accent: string; // único color de acento
  "on-accent": string; // texto sobre el acento
  "accent-bg": string; // fila seleccionada / pestaña activa
  focus: string; // anillo de foco (≥ 3:1)
  ok: string;
  "ok-bg": string;
  warn: string;
  "warn-bg": string;
  err: string;
  "err-bg": string;
  "on-err": string; // texto sobre botón rojo lleno
  mark: string;
  sombra: string;
}

export const TEMAS: Record<NombreTema, Tema> = {
  // Grafito neutro: sirve para cualquier negocio y no evoca ninguna marca. El color propio de
  // cada negocio (config color_acento) se monta encima con temaConAcento().
  claro: {
    bg: "#f2f3f4",
    card: "#ffffff",
    card2: "#f7f7f8",
    line: "#84888f",
    hair: "#e3e5e8",
    text: "#1a1c20",
    muted: "#575b63",
    accent: "#24272c",
    "on-accent": "#ffffff",
    "accent-bg": "#eaebed",
    focus: "#24272c",
    ok: "#0b6b4d",
    "ok-bg": "#e1f4ec",
    warn: "#7a4a00",
    "warn-bg": "#fdf1d8",
    err: "#b42318",
    "err-bg": "#fdeceb",
    "on-err": "#ffffff",
    mark: "#ffd54a",
    sombra: "rgba(20, 22, 26, 0.12)",
  },
  oscuro: {
    bg: "#111214",
    card: "#18191c",
    card2: "#1f2024",
    line: "#737780",
    hair: "#2b2d32",
    text: "#eceef1",
    muted: "#a6aab2",
    accent: "#eceef1",
    "on-accent": "#18191c",
    "accent-bg": "#2e3036",
    focus: "#eceef1",
    ok: "#7fdcae",
    "ok-bg": "#123327",
    warn: "#f2c86b",
    "warn-bg": "#382908",
    err: "#ff9e95",
    "err-bg": "#3b1714",
    "on-err": "#2b0705",
    mark: "#8a6d00",
    sombra: "rgba(0, 0, 0, 0.5)",
  },
};

// ─── Color propio del negocio ───

const HEX = /^#[0-9a-f]{6}$/i;

function aRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function aHex([r, g, b]: number[]): string {
  return "#" + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
}

/** Mezcla `a` con `b`: t = 0 → a, t = 1 → b. */
export function mezclar(a: string, b: string, t: number): string {
  const [x, y] = [aRgb(a), aRgb(b)];
  return aHex(x.map((v, i) => v + (y[i] - v) * t));
}

/** Tono (0–360°), saturación y luz (0–1). */
function aHsl(hex: string): [number, number, number] {
  const [r, g, b] = aRgb(hex).map((x) => x / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function deHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return aHex([r, g, b].map((v) => (v + m) * 255));
}

/**
 * ¿El color del negocio se confunde con el rojo de error y de borrar? (mismo tono ±25° y con
 * color de verdad, no un gris). La app igual lo acepta: es la marca del negocio. Solo se avisa.
 */
export function pareceError(hex: unknown): boolean {
  if (!esColor(hex)) return false;
  const [h, s, l] = aHsl(hex.toLowerCase());
  const [he] = aHsl(TEMAS.claro.err);
  const dist = Math.min(Math.abs(h - he), 360 - Math.abs(h - he));
  return dist <= 25 && s >= 0.35 && l > 0.12 && l < 0.9;
}

/** Tonos parecidos a la marca que ya no se leen como error: vino (hacia el magenta) y un rojo muy oscuro. */
export function alternativasAError(hex: string): { nombre: string; color: string }[] {
  const [, s, l] = aHsl(hex.toLowerCase());
  return [
    { nombre: "Vino", color: deHsl(335, Math.max(0.55, s * 0.85), Math.min(0.38, Math.max(0.3, l))) },
    { nombre: "Ciruela", color: deHsl(310, 0.45, 0.32) },
    { nombre: "Grafito", color: TEMAS.claro.accent },
  ];
}

export function esColor(hex: unknown): hex is string {
  return typeof hex === "string" && HEX.test(hex);
}

/**
 * Monta el color de un negocio sobre un tema sin romper el contraste: conserva el tono y lo
 * oscurece (tema claro) o aclara (tema oscuro) lo justo para que se lea como texto (4,5:1) sobre
 * tarjeta, fondo y selección. El texto encima del botón es blanco o casi negro, el que más contraste.
 * Un valor inválido deja el tema grafito tal cual.
 */
export function temaConAcento(base: Tema, nombre: NombreTema, hex: unknown): Tema {
  if (!esColor(hex)) return base;
  const destino = nombre === "oscuro" ? "#ffffff" : "#000000";
  const fondoSel = mezclar(base.card, hex, nombre === "oscuro" ? 0.2 : 0.1);
  let acento = hex.toLowerCase();
  for (let paso = 0; paso < 40; paso++) {
    const ok = [base.card, base.bg, fondoSel].every((f) => contraste(acento, f) >= 4.5);
    if (ok) break;
    acento = mezclar(acento, destino, 0.06);
  }
  const sobre = contraste("#ffffff", acento) >= contraste("#111214", acento) ? "#ffffff" : "#111214";
  return { ...base, accent: acento, "on-accent": sobre, "accent-bg": fondoSel, focus: acento };
}

export function aplicarTema(nombre: NombreTema, colorNegocio?: unknown): void {
  const t = temaConAcento(TEMAS[nombre] ?? TEMAS.claro, nombre, colorNegocio);
  const raiz = document.documentElement;
  for (const [k, v] of Object.entries(t)) raiz.style.setProperty(`--${k}`, v);
  raiz.dataset.tema = nombre;
  raiz.style.colorScheme = nombre === "oscuro" ? "dark" : "light";
}

// ─── Contraste WCAG 2.1 ───

function canal(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminancia(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Color inválido: ${hex}`);
  const n = parseInt(m[1], 16);
  return 0.2126 * canal((n >> 16) & 255) + 0.7152 * canal((n >> 8) & 255) + 0.0722 * canal(n & 255);
}

/** Relación de contraste entre dos colores (1 a 21). */
export function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Combinaciones que usa la interfaz: [primer plano, fondo, mínimo exigido, para qué]. */
export function combinaciones(t: Tema): [string, string, number, string][] {
  return [
    [t.text, t.bg, 4.5, "texto sobre fondo"],
    [t.text, t.card, 4.5, "texto sobre tarjeta"],
    [t.text, t.card2, 4.5, "texto sobre zona secundaria"],
    [t.text, t["accent-bg"], 4.5, "texto en fila seleccionada"],
    [t.muted, t.bg, 4.5, "texto secundario sobre fondo"],
    [t.muted, t.card, 4.5, "texto secundario sobre tarjeta"],
    [t.muted, t.card2, 4.5, "texto secundario sobre zona secundaria"],
    [t["on-accent"], t.accent, 4.5, "botón principal"],
    [t.accent, t.card, 4.5, "texto de acento sobre tarjeta"],
    [t.accent, t.bg, 4.5, "texto de acento sobre fondo"],
    [t.ok, t["ok-bg"], 4.5, "mensaje correcto"],
    [t.warn, t["warn-bg"], 4.5, "aviso"],
    [t.err, t["err-bg"], 4.5, "error"],
    [t.err, t.card, 4.5, "botón rojo (texto) sobre tarjeta"],
    [t.ok, t.card, 4.5, "texto verde sobre tarjeta"],
    [t.warn, t.card, 3, "barra de tiempo del aviso sobre tarjeta"],
    [t["on-err"], t.err, 4.5, "botón rojo lleno"],
    [t.line, t.card, 3, "borde de campo/botón sobre tarjeta"],
    [t.line, t.bg, 3, "borde de campo/botón sobre fondo"],
    [t.focus, t.card, 3, "anillo de foco sobre tarjeta"],
    [t.focus, t.bg, 3, "anillo de foco sobre fondo"],
    [t.focus, t["accent-bg"], 3, "anillo de foco sobre fila seleccionada"],
    [t.accent, t.card, 3, "borde de botón principal"],
    [t.accent, t["accent-bg"], 4.5, "texto de acento sobre selección (chip/menú activo)"],
  ];
}
