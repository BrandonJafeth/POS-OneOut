// Plan de importación: compara la fuente con lo que ya hay y decide qué crear, qué actualizar
// y qué filas tienen errores. Es puro (no toca la base), así la vista previa es exacta y se prueba fácil.
import { normalizar } from "../texto";
import type { ErrorFila, FuenteImportacion } from "./fuente";

export interface ProductoExistente {
  id: string;
  webId: string | null;
  nombre: string;
  precio: number;
  eliminado: boolean;
}

export interface ItemPlan {
  fila: number;
  webId: string;
  nombre: string;
  precio: number;
  departamentoId: string;
  /** Solo en "actualizar": el producto y sus valores actuales. */
  productoId?: string;
  antes?: { nombre: string; precio: number };
}

export interface Plan {
  origen: string;
  total: number;
  nuevos: ItemPlan[];
  actualizar: ItemPlan[];
  sinCambios: number;
  /** web_id de un producto que se eliminó aquí: no se resucita. */
  omitidos: ErrorFila[];
  errores: ErrorFila[];
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

export function categoriasSinMapear(fuente: FuenteImportacion, mapeo: Record<string, string>): string[] {
  const set = new Set(fuente.filas.map((f) => f.categoria).filter((c) => c && !(c in mapeo)));
  return [...set].sort((a, b) => a.localeCompare(b, "es"));
}

export function crearPlan(
  fuente: FuenteImportacion,
  existentes: ProductoExistente[],
  mapeo: Record<string, string>,
  departamentoDefecto: string,
): Plan {
  const porWebId = new Map(existentes.filter((e) => e.webId).map((e) => [e.webId!, e]));
  const porNombre = new Map(existentes.filter((e) => !e.eliminado).map((e) => [normalizar(e.nombre), e]));
  const plan: Plan = { origen: fuente.origen, total: fuente.filas.length, nuevos: [], actualizar: [], sinCambios: 0, omitidos: [], errores: [] };
  const vistosNombre = new Map<string, number>();
  const vistosId = new Map<string, number>();

  for (const f of fuente.filas) {
    const error = (mensaje: string) => plan.errores.push({ fila: f.fila, nombre: f.nombre, mensaje });
    if (!f.nombre) {
      error("Nombre vacío");
      continue;
    }
    if (!f.webId) {
      error("Falta el id");
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
    const clave = normalizar(f.nombre);
    if (vistosId.has(f.webId)) {
      error(`Id repetido (igual que la fila ${vistosId.get(f.webId)})`);
      continue;
    }
    if (vistosNombre.has(clave)) {
      error(`Nombre repetido (igual que la fila ${vistosNombre.get(clave)})`);
      continue;
    }
    vistosId.set(f.webId, f.fila);
    vistosNombre.set(clave, f.fila);

    const existente = porWebId.get(f.webId);
    // Mismo nombre que OTRO producto que ya está en el catálogo: crearía un duplicado.
    const homonimo = porNombre.get(clave);
    if (homonimo && homonimo.id !== existente?.id) {
      error(`Ya existe otro producto con ese nombre ("${homonimo.nombre}")`);
      continue;
    }
    const item: ItemPlan = { fila: f.fila, webId: f.webId, nombre: f.nombre, precio, departamentoId: mapeo[f.categoria] || departamentoDefecto };
    if (!existente) plan.nuevos.push(item);
    else if (existente.eliminado) plan.omitidos.push({ fila: f.fila, nombre: f.nombre, mensaje: "Producto eliminado en el POS; no se vuelve a crear" });
    else if (existente.nombre === f.nombre && existente.precio === precio) plan.sinCambios++;
    else plan.actualizar.push({ ...item, productoId: existente.id, antes: { nombre: existente.nombre, precio: existente.precio } });
  }
  return plan;
}
