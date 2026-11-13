// Plan de importación: compara la fuente con lo que ya hay y decide qué crear, qué actualizar
// y qué filas tienen errores, con el departamento, el código interno y el favorito de cada una.
// Es puro (no toca la base), así la vista previa es exacta, se recalcula al editar las reglas
// y se prueba fácil. Rust vuelve a validar todo al aplicar.
import { normalizar } from "../texto";
import type { ErrorFila, FuenteImportacion } from "./fuente";
import { codigoInterno } from "../ean13";
import { porCategorias, porPalabras, sugerenciaNombre, type ReglasImportacion } from "./reglas";

export const MAX_NOMBRE = 120;
const ESTADOS = new Set(["disponible", "agotado"]);
const TIPOS = new Set(["simple"]);
const CLAVE = /^[A-Za-z0-9_-]+$/;

export interface ProductoExistente {
  id: string;
  webId: string | null;
  slug: string | null;
  nombre: string;
  precio: number;
  activo: boolean;
  departamentoId: string;
  favorito: boolean;
  categoriasOrigen: string | null;
  /** Ya tiene un código interno (no se le genera otro). */
  tieneInterno: boolean;
  eliminado: boolean;
}

export interface DepartamentoPlan {
  id: string;
  codigo: string;
  nombre: string;
  activo: boolean;
}

export interface Contexto {
  existentes: ProductoExistente[];
  /** Todos los códigos que ya existen (para no repetir códigos internos). */
  codigos: string[];
  /** Favoritos que ya hay en el catálogo. */
  favoritosActuales: number;
  departamentos: DepartamentoPlan[];
  departamentoDefecto: string;
  /** Siguiente número de código interno (config codigo_interno_siguiente); Rust toma el mismo contador. */
  siguienteInterno?: number;
}

export type Respuesta = "mover" | "dejar";

export interface Opciones {
  reglas: ReglasImportacion;
  /** Respuesta del dueño a cada regla "preguntar" (por índice en reglas.palabras). */
  respuestas: Record<number, Respuesta>;
  /** Filas cuya sugerencia de nombre aceptó el dueño. */
  sugerenciasAceptadas: ReadonlySet<number>;
  limitarFavoritos: boolean;
  /** Generar un código interno a los que no tienen uno (por defecto no: se escanea su código de barras). */
  codigosInternos?: boolean;
  /** Reemplazar lo que el dueño editó en el POS (por defecto no). */
  pisar: { departamento: boolean; favorito: boolean };
}

export type Via = "categoria" | "regla" | "defecto";
export type Cambio = "nombre" | "precio" | "activo" | "departamento" | "favorito" | "codigo" | "slug" | "categorias";

export interface ItemPlan {
  fila: number;
  accion: "crear" | "actualizar";
  webId: string;
  slug: string;
  /** Nombre que se guarda (con la sugerencia, si se aceptó). */
  nombre: string;
  /** Nombre del archivo, ya sin espacios de más. */
  nombreArchivo: string;
  sugerencia: string | null;
  precio: number;
  activo: boolean;
  destacado: boolean;
  favorito: boolean;
  categorias: string[];
  /** Departamento que dicen las reglas. */
  departamentoReglas: string;
  /** Departamento que se guarda (al actualizar, el del POS salvo que se pida reemplazarlo). */
  departamentoId: string;
  /** Departamento del paso 1 (categoría), antes de las palabras. */
  departamentoCategoria: string;
  via: Via;
  regla: { indice: number; palabra: string } | null;
  revisar: boolean;
  /** Código interno a crear (null si ya tiene uno). */
  codigo: string | null;
  productoId?: string;
  antes?: { nombre: string; precio: number; activo: boolean; departamentoId: string; favorito: boolean };
  cambios: Cambio[];
}

export interface ConteoDepartamento {
  departamentoId: string;
  categoria: number;
  regla: number;
  defecto: number;
  total: number;
}

export interface Pregunta {
  indice: number;
  palabras: string[];
  departamentoId: string;
  respuesta: Respuesta | undefined;
  items: ItemPlan[];
}

export interface Plan {
  origen: string;
  total: number;
  nuevos: ItemPlan[];
  actualizar: ItemPlan[];
  sinCambios: number;
  /** Productos eliminados en el POS: no se resucitan. */
  omitidos: ErrorFila[];
  errores: ErrorFila[];
  /** Filas con precio de oferta: se avisa y no se aplica. */
  avisos: ErrorFila[];
  /** Todas las filas válidas, con su departamento según las reglas. */
  validos: ItemPlan[];
  porDepartamento: ConteoDepartamento[];
  /** Filas a las que una regla de palabras les cambió el departamento de la categoría. */
  cambiadosPorRegla: ItemPlan[];
  preguntas: Pregunta[];
  /** Preguntas que el dueño todavía no respondió: no se puede confirmar. */
  pendientes: number;
  sugerencias: ItemPlan[];
  favoritos: { destacados: number; marcados: number; cupo: number | null };
  paraRevisar: number;
}

/**
 * Precio en colones enteros. Acepta "1500", "1500.00", "1500,5", "1.500", "1,500", "¢1 500".
 * Con 3 cifras después del punto/coma se toma como separador de miles; con 1–2, como decimales (se redondea).
 */
export function leerPrecio(s: string): number | null {
  const t = s.replace(/[¢₡\s]/g, "");
  const m = /^(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,](\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const entero = Number(m[1].replace(/[.,]/g, ""));
  const n = m[2] ? Math.round(Number(`${entero}.${m[2]}`)) : entero;
  return Number.isSafeInteger(n) ? n : null;
}

const sinOferta = (s: string) => !s || /^(null|0|-)$/i.test(s.trim());

/** Productos que ya estaban y cambian de precio. `fuertes`: bajan a menos de la mitad (un precio
 *  mal escrito en la web, ¢120 en vez de ¢1.200, se vendería más barato sin que nadie lo note). */
export function cambiosDePrecio(plan: Pick<Plan, "actualizar">): { suben: number; bajan: number; fuertes: ItemPlan[] } {
  const con = plan.actualizar.filter((i) => i.antes && i.antes.precio !== i.precio);
  return {
    suben: con.filter((i) => i.precio > i.antes!.precio).length,
    bajan: con.filter((i) => i.precio < i.antes!.precio).length,
    fuertes: con.filter((i) => i.precio * 2 < i.antes!.precio),
  };
}

export function crearPlan(fuente: FuenteImportacion, ctx: Contexto, op: Opciones): Plan {
  const { reglas } = op;
  const deps = new Map(ctx.departamentos.filter((d) => d.activo).map((d) => [d.id, d]));
  const porWebId = new Map(ctx.existentes.filter((e) => e.webId).map((e) => [e.webId!, e]));
  const porSlug = new Map(ctx.existentes.filter((e) => e.slug && !e.eliminado).map((e) => [e.slug!, e]));
  const porNombre = new Map(ctx.existentes.filter((e) => !e.eliminado).map((e) => [normalizar(e.nombre), e]));
  const plan: Plan = {
    origen: fuente.origen,
    total: fuente.filas.length,
    nuevos: [],
    actualizar: [],
    sinCambios: 0,
    omitidos: [],
    errores: [],
    avisos: [],
    validos: [],
    porDepartamento: [],
    cambiadosPorRegla: [],
    preguntas: reglas.palabras.flatMap((r, indice) => (r.preguntar ? [{ indice, palabras: r.palabras, departamentoId: r.departamentoId, respuesta: op.respuestas[indice], items: [] }] : [])),
    pendientes: 0,
    sugerencias: [],
    favoritos: { destacados: 0, marcados: 0, cupo: null },
    paraRevisar: 0,
  };
  const hay = new Set(fuente.columnas);
  const vistos = { id: new Map<string, number>(), slug: new Map<string, number>(), nombre: new Map<string, number>() };

  for (const f of fuente.filas) {
    const error = (mensaje: string) => plan.errores.push({ fila: f.fila, nombre: f.nombre, mensaje });
    if (!f.nombre) {
      error("Nombre vacío");
      continue;
    }
    if (f.nombre.length > MAX_NOMBRE) {
      error(`Nombre de más de ${MAX_NOMBRE} caracteres`);
      continue;
    }
    if (!f.webId) {
      error("Falta el id");
      continue;
    }
    if (f.webId.length > 64 || !CLAVE.test(f.webId)) {
      error("El id tiene caracteres no válidos");
      continue;
    }
    if (f.slug && (f.slug.length > 160 || !CLAVE.test(f.slug))) {
      error("El slug tiene caracteres no válidos");
      continue;
    }
    if (!f.precio) {
      error("Precio vacío");
      continue;
    }
    const precio = leerPrecio(f.precio);
    if (precio === null) {
      error(`Precio no numérico: "${f.precio}"`);
      continue;
    }
    if (precio <= 0) {
      error("El precio debe ser mayor que cero");
      continue;
    }
    if (hay.has("estado") && f.estado && !ESTADOS.has(f.estado)) {
      error(`Estado no admitido: "${f.estado}"`);
      continue;
    }
    if (hay.has("tipo") && f.tipo && !TIPOS.has(f.tipo)) {
      error(`Tipo no admitido: "${f.tipo}" (solo "simple")`);
      continue;
    }
    const clave = normalizar(f.nombre);
    const repetido = (
      [
        ["id", f.webId, "Id"],
        ["slug", f.slug, "Slug"],
        ["nombre", clave, "Nombre"],
      ] as const
    ).find(([k, v]) => v && vistos[k].has(v));
    if (repetido) {
      const otra = vistos[repetido[0]].get(repetido[1]);
      // Mayúsculas, tildes y espacios no cuentan: "Copia" y "copia" son el mismo nombre.
      error(repetido[0] === "nombre" ? `Nombre repetido (igual que la fila ${otra}, sin contar mayúsculas ni tildes): cámbielo en la web` : `${repetido[2]} repetido (igual que la fila ${otra})`);
      continue;
    }
    vistos.id.set(f.webId, f.fila);
    if (f.slug) vistos.slug.set(f.slug, f.fila);
    vistos.nombre.set(clave, f.fila);

    let existente = porWebId.get(f.webId);
    if (!existente && f.slug) existente = porSlug.get(f.slug);
    const homonimo = porNombre.get(clave);
    // Creado a mano en el POS (nunca vino de la web) con el mismo nombre: es el mismo producto. Se une
    // con el de la web en vez de dar error en cada importación; sale en "actualizar" con sus cambios.
    if (!existente && homonimo && !homonimo.webId) {
      existente = homonimo;
      plan.avisos.push({ fila: f.fila, nombre: f.nombre, mensaje: `Se une con "${homonimo.nombre}", que ya estaba en el POS (creado a mano)` });
    }
    if (homonimo && homonimo.id !== existente?.id) {
      error(`Ya hay otro producto llamado "${homonimo.nombre}" en el POS: cámbiele el nombre a uno de los dos (en la web o en Productos) y vuelva a importar`);
      continue;
    }
    if (existente?.eliminado) {
      plan.omitidos.push({ fila: f.fila, nombre: f.nombre, mensaje: "Producto eliminado en el POS; no se vuelve a crear" });
      continue;
    }

    // Departamento: paso 1 por categoría (prioridad), paso 2 por palabras (sobrescribe).
    const cat = porCategorias(f.categorias, reglas.categorias);
    const departamentoCategoria = cat?.departamentoId ?? ctx.departamentoDefecto;
    let departamento = departamentoCategoria;
    let via: Via = cat ? "categoria" : "defecto";
    const regla = porPalabras(f.nombre, reglas.palabras);
    if (regla) {
      const r = reglas.palabras[regla.indice];
      if (!r.preguntar || op.respuestas[regla.indice] === "mover") {
        departamento = r.departamentoId;
        via = "regla";
      }
    }
    if (!deps.has(departamento)) {
      error("El departamento de las reglas no existe o está inactivo; revise el mapeo");
      continue;
    }

    const sugerencia = sugerenciaNombre(f.nombre);
    const nombre = sugerencia && op.sugerenciasAceptadas.has(f.fila) ? sugerencia : f.nombre;
    const activo = !hay.has("estado") || f.estado !== "agotado";
    const item: ItemPlan = {
      fila: f.fila,
      accion: existente ? "actualizar" : "crear",
      webId: f.webId,
      slug: f.slug,
      nombre,
      nombreArchivo: f.nombre,
      sugerencia,
      precio,
      activo,
      destacado: f.destacado,
      favorito: false,
      categorias: f.categorias,
      departamentoReglas: departamento,
      departamentoId: existente && !op.pisar.departamento ? existente.departamentoId : departamento,
      departamentoCategoria,
      via,
      regla,
      revisar: via === "defecto",
      codigo: null,
      cambios: [],
    };
    if (existente) {
      item.productoId = existente.id;
      item.antes = { nombre: existente.nombre, precio: existente.precio, activo: existente.activo, departamentoId: existente.departamentoId, favorito: existente.favorito };
      item.favorito = existente.favorito;
    }
    if (!sinOferta(f.precioOferta)) plan.avisos.push({ fila: f.fila, nombre: f.nombre, mensaje: `Trae precio de oferta (${f.precioOferta}); no se aplica` });
    plan.validos.push(item);
  }

  // Favoritos = destacados, con límite opcional. Sin "reemplazar favorito", solo cuentan los nuevos
  // y el cupo descuenta los favoritos que ya hay.
  const candidatos = plan.validos.filter((i) => i.destacado && (i.accion === "crear" || op.pisar.favorito));
  const orden = {
    alfabetico: (a: ItemPlan, b: ItemPlan) => a.nombre.localeCompare(b.nombre, "es"),
    archivo: (a: ItemPlan, b: ItemPlan) => a.fila - b.fila,
    precio: (a: ItemPlan, b: ItemPlan) => a.precio - b.precio || a.nombre.localeCompare(b.nombre, "es"),
  }[reglas.criterioFavoritos];
  const cupo = op.limitarFavoritos ? Math.max(0, reglas.favoritosMax - (op.pisar.favorito ? 0 : ctx.favoritosActuales)) : null;
  const elegidos = new Set([...candidatos].sort(orden).slice(0, cupo ?? undefined));
  if (op.pisar.favorito) for (const i of plan.validos) i.favorito = elegidos.has(i);
  else for (const i of elegidos) i.favorito = true;
  plan.favoritos = { destacados: plan.validos.filter((i) => i.destacado).length, marcados: elegidos.size, cupo };

  // Códigos internos EAN-13 "200…" (solo si se pidió), en el orden del archivo: los mismos que dará Rust.
  const usados = new Set(ctx.codigos);
  let n = ctx.siguienteInterno ?? 1;
  const tieneInterno = new Map(ctx.existentes.map((e) => [e.id, e.tieneInterno]));
  for (const i of op.codigosInternos ? plan.validos : []) {
    if (i.productoId && tieneInterno.get(i.productoId)) continue;
    while (usados.has(codigoInterno(n))) n++;
    i.codigo = codigoInterno(n++);
  }

  // Qué cambia en los que ya existen.
  const porId = new Map(ctx.existentes.map((e) => [e.id, e]));
  for (const i of plan.validos) {
    if (i.accion === "crear") {
      plan.nuevos.push(i);
      continue;
    }
    const e = porId.get(i.productoId!)!;
    const c: Cambio[] = [];
    if (e.nombre !== i.nombre) c.push("nombre");
    if (e.precio !== i.precio) c.push("precio");
    if (e.activo !== i.activo) c.push("activo");
    if (e.departamentoId !== i.departamentoId) c.push("departamento");
    if (e.favorito !== i.favorito) c.push("favorito");
    if (i.codigo) c.push("codigo");
    if ((e.slug ?? "") !== i.slug || e.webId !== i.webId) c.push("slug");
    if ((e.categoriasOrigen ?? "") !== i.categorias.join(" | ")) c.push("categorias");
    i.cambios = c;
    if (c.length) plan.actualizar.push(i);
    else plan.sinCambios++;
  }

  // Resúmenes para la vista previa.
  const conteo = new Map<string, ConteoDepartamento>();
  for (const i of plan.validos) {
    const k = conteo.get(i.departamentoReglas) ?? { departamentoId: i.departamentoReglas, categoria: 0, regla: 0, defecto: 0, total: 0 };
    k[i.via]++;
    k.total++;
    conteo.set(i.departamentoReglas, k);
    if (i.via === "regla" && i.departamentoReglas !== i.departamentoCategoria) plan.cambiadosPorRegla.push(i);
    if (i.sugerencia) plan.sugerencias.push(i);
    if (i.revisar) plan.paraRevisar++;
    if (i.regla && reglas.palabras[i.regla.indice].preguntar) plan.preguntas.find((p) => p.indice === i.regla!.indice)?.items.push(i);
  }
  const ordenDep = new Map(ctx.departamentos.map((d, n) => [d.id, n]));
  plan.porDepartamento = [...conteo.values()].sort((a, b) => (ordenDep.get(a.departamentoId) ?? 99) - (ordenDep.get(b.departamentoId) ?? 99));
  plan.preguntas = plan.preguntas.filter((p) => p.items.length);
  plan.pendientes = plan.preguntas.filter((p) => !p.respuesta).length;
  return plan;
}

/** Categorías del archivo que no están en la tabla de mapeo (se muestran para agregarlas). */
export function categoriasSinMapear(fuente: FuenteImportacion, reglas: ReglasImportacion): string[] {
  const conocidas = new Set(reglas.categorias.map((r) => normalizar(r.categoria)));
  const out = new Map<string, string>();
  for (const f of fuente.filas) for (const c of f.categorias) if (!conocidas.has(normalizar(c))) out.set(normalizar(c), c);
  return [...out.values()].sort((a, b) => a.localeCompare(b, "es"));
}
