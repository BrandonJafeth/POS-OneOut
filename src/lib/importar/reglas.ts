// Reglas de importación (config importacion_reglas): categoría de la web → departamento, en
// orden de prioridad, y palabras del nombre que sobrescriben el departamento. Viven en la
// configuración y se editan en la pantalla; aquí solo está cómo se aplican.
import { normalizar } from "../texto";

export interface ReglaCategoria {
  categoria: string;
  departamentoId: string;
}

export interface ReglaPalabras {
  /** Palabras o frases ("porta retrato"); cuentan solo como palabra completa, sin mayúsculas ni tildes. */
  palabras: string[];
  departamentoId: string;
  /** El dueño decide en la vista previa si se aplica (p. ej. "marcador"). */
  preguntar: boolean;
}

/** Cómo se eligen los favoritos cuando hay más destacados que el límite. */
export type CriterioFavoritos = "alfabetico" | "archivo" | "precio";

export interface ReglasImportacion {
  categorias: ReglaCategoria[];
  palabras: ReglaPalabras[];
  favoritosMax: number;
  criterioFavoritos: CriterioFavoritos;
}

const D = (n: string) => `00000000000000000000000D${n}`;

/** Lo mismo que siembra la migración 7 (por si la clave falta o se restablece). */
export const REGLAS_DEFECTO: ReglasImportacion = {
  categorias: [
    { categoria: "Escolar", departamentoId: D("01") },
    { categoria: "Cuadernos", departamentoId: D("01") },
    { categoria: "Libros", departamentoId: D("01") },
    { categoria: "Arte y Manualidades", departamentoId: D("09") },
    { categoria: "Oficina", departamentoId: D("02") },
    { categoria: "Carpetas", departamentoId: D("02") },
    { categoria: "Papeleria", departamentoId: D("03") },
    { categoria: "Agendas", departamentoId: D("03") },
    { categoria: "Fotografia", departamentoId: D("04") },
    { categoria: "Tecnología", departamentoId: D("06") },
    { categoria: "Bazar", departamentoId: D("08") },
    { categoria: "Figuras", departamentoId: D("08") },
    { categoria: "sublimacion y DTF", departamentoId: D("12") },
  ],
  palabras: [
    { palabras: ["lapicero", "lapiz", "boligrafo", "portaminas"], departamentoId: D("11"), preguntar: false },
    { palabras: ["portarretrato", "marco", "porta retrato"], departamentoId: D("05"), preguntar: false },
    { palabras: ["carton", "cartulina"], departamentoId: D("10"), preguntar: false },
    { palabras: ["marcador"], departamentoId: D("11"), preguntar: true },
  ],
  favoritosMax: 40,
  criterioFavoritos: "alfabetico",
};

export const CRITERIOS_FAVORITOS: Record<CriterioFavoritos, string> = {
  alfabetico: "Orden alfabético",
  archivo: "Orden del archivo",
  precio: "Menor precio primero",
};

/** Lo guardado puede venir viejo o a medias: se completa con lo predeterminado. */
export function reglasValidas(v: unknown): ReglasImportacion {
  const r = (v && typeof v === "object" ? v : {}) as Partial<ReglasImportacion>;
  return {
    categorias: Array.isArray(r.categorias) ? r.categorias : REGLAS_DEFECTO.categorias,
    palabras: Array.isArray(r.palabras) ? r.palabras : REGLAS_DEFECTO.palabras,
    favoritosMax: Number.isSafeInteger(r.favoritosMax) && r.favoritosMax! >= 0 ? r.favoritosMax! : REGLAS_DEFECTO.favoritosMax,
    criterioFavoritos: r.criterioFavoritos && r.criterioFavoritos in CRITERIOS_FAVORITOS ? r.criterioFavoritos : REGLAS_DEFECTO.criterioFavoritos,
  };
}

/**
 * Paso 1: el departamento de la categoría con más prioridad (la que está más arriba en la lista)
 * entre las que trae el producto. "Fotografia " y "fotografía" son la misma categoría.
 */
export function porCategorias(categorias: string[], reglas: ReglaCategoria[]): ReglaCategoria | null {
  const tiene = new Set(categorias.map(normalizar));
  return reglas.find((r) => tiene.has(normalizar(r.categoria))) ?? null;
}

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ¿El nombre contiene la palabra (o frase) completa? "marcador" no cuenta como "marco". */
export function contienePalabra(nombre: string, palabra: string): boolean {
  const p = normalizar(palabra);
  if (!p) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapar(p)}($|[^\\p{L}\\p{N}])`, "u").test(normalizar(nombre));
}

/** Paso 2: la primera regla de palabras (en el orden de la tabla) que coincide con el nombre. */
export function porPalabras(nombre: string, reglas: ReglaPalabras[]): { indice: number; palabra: string } | null {
  for (let i = 0; i < reglas.length; i++) {
    const palabra = reglas[i].palabras.find((p) => contienePalabra(nombre, p));
    if (palabra) return { indice: i, palabra };
  }
  return null;
}

/**
 * Mayúsculas evidentemente erradas: dos mayúsculas y el resto minúsculas ("TIjera" → "Tijera").
 * No toca siglas ("DTF", "USB") ni nada más. Devuelve null si no hay nada que sugerir.
 */
export function sugerenciaNombre(nombre: string): string | null {
  const s = nombre.replace(/(?<![\p{L}\p{N}])(\p{Lu})(\p{Lu})(\p{Ll}{2,})(?![\p{L}\p{N}])/gu, (_, a: string, b: string, resto: string) => a + b.toLowerCase() + resto);
  return s === nombre ? null : s;
}

/**
 * Plurales de las palabras de las reglas que aparecen en los nombres y que la regla NO toma
 * ("lapices" no es "lapiz"). Se muestran para que el dueño decida si los agrega.
 */
export function pluralesSinRegla(nombres: string[], reglas: ReglaPalabras[]): { indice: number; forma: string; productos: number }[] {
  const yaEsta = new Set(reglas.flatMap((r) => r.palabras.map(normalizar)));
  const out: { indice: number; forma: string; productos: number }[] = [];
  reglas.forEach((r, indice) => {
    for (const p of r.palabras.map(normalizar)) {
      // En una frase se pluraliza la última palabra ("porta retrato" → "porta retratos").
      const formas = [p + "s", p + "es", ...(p.endsWith("z") ? [p.slice(0, -1) + "ces"] : [])];
      for (const forma of formas) {
        if (yaEsta.has(forma)) continue;
        const productos = nombres.filter((n) => contienePalabra(n, forma)).length;
        if (productos) out.push({ indice, forma, productos }), yaEsta.add(forma);
      }
    }
  });
  return out;
}
