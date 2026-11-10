// Productos y sus códigos. Por defecto todo excluye lo eliminado (eliminado_en IS NULL).
import type { Actor, Codigo, Producto, ProductoConCodigos, ProductoLista, TipoCodigo } from "../tipos";
import { codigoInterno, variantesCodigo } from "../lib/ean13";
import { puede, SinPermiso } from "../lib/permisos";
import { ahoraIso, limpiarNombre, normalizar } from "../lib/texto";
import { ulid } from "../lib/ulid";
import { bitacora } from "./bitacora";
import { bool, db, textoONull, type Sentencia } from "./conexion";

/** El código ya pertenece a otro producto: la pantalla pregunta si moverlo. */
export class CodigoOcupado extends Error {
  constructor(
    readonly codigo: string,
    readonly producto: { id: string; nombre: string },
  ) {
    super(`El código ${codigo} ya pertenece a "${producto.nombre}"`);
  }
}

function aProducto(f: Record<string, unknown>): Producto {
  return {
    id: String(f.id),
    webId: textoONull(f.web_id),
    nombre: String(f.nombre),
    departamentoId: String(f.departamento_id),
    precio: Number(f.precio),
    activo: bool(f.activo),
    cabys: textoONull(f.cabys),
    tasaIva: f.tasa_iva == null ? 13 : Number(f.tasa_iva),
    exento: bool(f.exento),
    favorito: bool(f.favorito),
    revisar: bool(f.revisar),
    actualizadoEn: String(f.actualizado_en),
  };
}

function permitir(actor: Actor) {
  if (!puede(actor.rol, "productos")) throw new SinPermiso("modificar productos");
}

/** Para LIKE: % y _ del usuario se buscan literalmente. */
function like(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export type OrdenProductos = "nombre" | "nombre_desc" | "precio" | "precio_desc";

const ORDEN_SQL: Record<OrdenProductos, string> = {
  nombre: "p.nombre_busqueda",
  nombre_desc: "p.nombre_busqueda DESC",
  precio: "p.precio, p.nombre_busqueda",
  precio_desc: "p.precio DESC, p.nombre_busqueda",
};

export const ORDENES_PRODUCTOS: Record<OrdenProductos, string> = {
  nombre: "Nombre A–Z",
  nombre_desc: "Nombre Z–A",
  precio: "Menor precio",
  precio_desc: "Mayor precio",
};

export interface FiltroProductos {
  texto?: string;
  soloFavoritos?: boolean;
  /** Sin ningún código de barras (para completarlos escaneando). */
  sinBarras?: boolean;
  /** Marcados para revisión por la importación. */
  paraRevisar?: boolean;
  /** Orden de la lista (por defecto A–Z). Al buscar, lo que coincide exacto por código va primero igual. */
  orden?: OrdenProductos;
  departamentoId?: string;
  incluirInactivos?: boolean;
  limite?: number;
  desplazamiento?: number;
}

/**
 * Búsqueda del catálogo: cada palabra debe aparecer en el nombre (sin tildes ni mayúsculas),
 * o el texto es (el inicio de) un código. Los que coinciden exacto por código salen primero.
 */
export async function buscarProductos(f: FiltroProductos = {}): Promise<{ filas: ProductoLista[]; total: number }> {
  const where = ["p.eliminado_en IS NULL"];
  const params: (string | number)[] = [];
  if (!f.incluirInactivos) where.push("p.activo = 1");
  if (f.departamentoId) where.push("p.departamento_id = ?"), params.push(f.departamentoId);
  if (f.soloFavoritos) where.push("p.favorito = 1");
  if (f.sinBarras) where.push("NOT EXISTS (SELECT 1 FROM codigos c WHERE c.producto_id = p.id AND c.tipo = 'barras')");
  if (f.paraRevisar) where.push("p.revisar = 1");
  const texto = (f.texto ?? "").trim();
  const base = ORDEN_SQL[f.orden ?? "nombre"] ?? ORDEN_SQL.nombre;
  let orden = base;
  const ordenParams: string[] = [];
  if (texto) {
    const palabras = normalizar(texto).split(" ").filter(Boolean);
    const porNombre = palabras.map(() => "p.nombre_busqueda LIKE ? ESCAPE '\\'").join(" AND ");
    where.push(`((${porNombre}) OR EXISTS (SELECT 1 FROM codigos c WHERE c.producto_id = p.id AND c.codigo LIKE ? ESCAPE '\\'))`);
    params.push(...palabras.map((w) => `%${like(w)}%`), `${like(texto)}%`);
    orden = `EXISTS (SELECT 1 FROM codigos c WHERE c.producto_id = p.id AND c.codigo = ?) DESC, ${base}`;
    ordenParams.push(texto);
  }
  const w = where.join(" AND ");
  const total = Number((await db().select(`SELECT COUNT(*) AS n FROM productos p WHERE ${w}`, params))[0].n);
  const filas = await db().select(
    `SELECT p.*, d.nombre AS departamento,
            (SELECT group_concat(c.codigo, ' ') FROM codigos c WHERE c.producto_id = p.id) AS lista_codigos
     FROM productos p JOIN departamentos d ON d.id = p.departamento_id
     WHERE ${w} ORDER BY ${orden} LIMIT ? OFFSET ?`,
    [...params, ...ordenParams, f.limite ?? 50, f.desplazamiento ?? 0],
  );
  return {
    total,
    filas: filas.map((r) => ({
      ...aProducto(r),
      departamento: String(r.departamento),
      codigos: r.lista_codigos ? String(r.lista_codigos).split(" ") : [],
    })),
  };
}

async function codigosDe(productoId: string): Promise<Codigo[]> {
  const filas = await db().select("SELECT codigo, tipo FROM codigos WHERE producto_id = ? ORDER BY creado_en, codigo", [productoId]);
  return filas.map((c) => ({ codigo: String(c.codigo), tipo: c.tipo as TipoCodigo }));
}

export async function obtenerProducto(id: string, opc: { incluirEliminados?: boolean } = {}): Promise<ProductoConCodigos | null> {
  const f = (
    await db().select(`SELECT * FROM productos WHERE id = ? ${opc.incluirEliminados ? "" : "AND eliminado_en IS NULL"}`, [id])
  )[0];
  return f ? { ...aProducto(f), codigos: await codigosDe(String(f.id)) } : null;
}

/** Producto vigente que tiene ese código (sin distinguir mayúsculas), o null.
 *  Si no está tal cual, se prueba como UPC-A/EAN-13 e ISBN-10/13 (variantesCodigo). */
export async function productoPorCodigo(codigo: string): Promise<ProductoConCodigos | null> {
  for (const c of [codigo.trim(), ...variantesCodigo(codigo)]) {
    const f = (await db().select("SELECT p.id FROM codigos c JOIN productos p ON p.id = c.producto_id WHERE c.codigo = ? AND p.eliminado_en IS NULL", [c]))[0];
    if (f) return obtenerProducto(String(f.id));
  }
  return null;
}

/** Dueño actual del código (incluye productos eliminados, para poder liberarlo). */
async function duenoDelCodigo(codigo: string): Promise<{ id: string; nombre: string; eliminado: boolean } | null> {
  const f = (
    await db().select(
      "SELECT p.id, p.nombre, p.eliminado_en FROM codigos c JOIN productos p ON p.id = c.producto_id WHERE c.codigo = ?",
      [codigo],
    )
  )[0];
  return f ? { id: String(f.id), nombre: String(f.nombre), eliminado: f.eliminado_en != null } : null;
}

export function limpiarCodigo(codigo: string): string {
  const c = codigo.trim();
  if (!c) throw new Error("El código está vacío");
  if (c.length > 64 || /\s/.test(c)) throw new Error("El código no puede tener espacios ni más de 64 caracteres");
  return c;
}

export interface DatosProducto {
  nombre: string;
  departamentoId: string;
  precio: number;
  activo?: boolean;
  cabys?: string | null;
  tasaIva?: number;
  exento?: boolean;
}

function validarDatos(d: DatosProducto) {
  if (!d.nombre.trim()) throw new Error("Escriba el nombre del producto");
  if (!d.departamentoId) throw new Error("Elija el departamento");
  if (!Number.isSafeInteger(d.precio) || d.precio < 0) throw new Error("El precio debe ser un número entero de colones");
  if (d.tasaIva !== undefined && !(d.tasaIva >= 0 && d.tasaIva <= 100)) throw new Error("La tasa de IVA debe estar entre 0 y 100");
  // CAByS: 13 dígitos (catálogo de Hacienda). Opcional.
  if (d.cabys && !/^\d{13}$/.test(d.cabys)) throw new Error("El código CAByS tiene 13 dígitos");
}

/**
 * Sentencias para poner `codigo` en `productoId`. Si ya es de otro producto vigente y no se pidió
 * moverlo, lanza CodigoOcupado. Si era de un producto eliminado, se mueve sin preguntar.
 */
async function sentenciasCodigo(actor: Actor, productoId: string, codigo: string, tipo: TipoCodigo, mover: boolean): Promise<Sentencia[]> {
  const dueno = await duenoDelCodigo(codigo);
  if (dueno?.id === productoId) return [];
  if (dueno && !dueno.eliminado && !mover) throw new CodigoOcupado(codigo, { id: dueno.id, nombre: dueno.nombre });
  if (dueno)
    return [
      { id: "codigo.mover", params: [productoId, tipo, codigo] },
      bitacora(actor.id, "codigo.mover", "codigo", codigo, { de: dueno.id, deNombre: dueno.nombre, a: productoId }),
    ];
  return [
    { id: "codigo.asociar", params: [codigo, productoId, tipo, ahoraIso()] },
    bitacora(actor.id, "codigo.asociar", "codigo", codigo, { producto: productoId, tipo }),
  ];
}

export async function crearProducto(
  actor: Actor,
  datos: DatosProducto,
  codigos: Codigo[] = [],
  opc: { moverCodigos?: boolean } = {},
): Promise<string> {
  permitir(actor);
  validarDatos(datos);
  const id = ulid();
  const ahora = ahoraIso();
  const sentencias: Sentencia[] = [
    {
      id: "producto.crear",
      params: [
        id,
        limpiarNombre(datos.nombre),
        normalizar(datos.nombre),
        datos.departamentoId,
        datos.precio,
        datos.activo ?? true,
        datos.cabys || null,
        datos.tasaIva ?? 13,
        datos.exento ?? false,
        ahora,
        ahora,
      ],
    },
    bitacora(actor.id, "producto.crear", "producto", id, { nombre: limpiarNombre(datos.nombre), precio: datos.precio, departamentoId: datos.departamentoId }),
  ];
  for (const c of codigos) sentencias.push(...(await sentenciasCodigo(actor, id, limpiarCodigo(c.codigo), c.tipo, !!opc.moverCodigos)));
  await db().lote(sentencias);
  return id;
}

export async function editarProducto(actor: Actor, id: string, cambios: Partial<DatosProducto>): Promise<void> {
  permitir(actor);
  const p = await obtenerProducto(id);
  if (!p) throw new Error("Producto no encontrado");
  const n = { ...p, ...cambios, nombre: limpiarNombre(cambios.nombre ?? p.nombre), cabys: (cambios.cabys ?? p.cabys) || null };
  validarDatos(n);
  const antes: Record<string, unknown> = {};
  const despues: Record<string, unknown> = {};
  for (const k of ["nombre", "departamentoId", "precio", "activo", "cabys", "tasaIva", "exento"] as const)
    if (n[k] !== p[k]) (antes[k] = p[k]), (despues[k] = n[k]);
  if (!Object.keys(despues).length) return;

  const sentencias: Sentencia[] = [
    {
      id: "producto.editar",
      params: [n.nombre, normalizar(n.nombre), n.departamentoId, n.precio, n.activo, n.cabys, n.tasaIva, n.exento, ahoraIso(), id],
    },
  ];
  // El cambio de precio va en su propia entrada para encontrarlo fácil en la bitácora.
  if ("precio" in despues) sentencias.push(bitacora(actor.id, "producto.precio", "producto", id, { nombre: n.nombre, antes: p.precio, despues: n.precio }));
  delete antes.precio;
  delete despues.precio;
  if (Object.keys(despues).length) sentencias.push(bitacora(actor.id, "producto.editar", "producto", id, { antes, despues }));
  await db().lote(sentencias);
}

/** Baja = borrado lógico. Sus códigos quedan apuntándole, pero ya no lo encuentran (y se pueden reasignar). */
export async function eliminarProducto(actor: Actor, id: string): Promise<void> {
  permitir(actor);
  const p = await obtenerProducto(id);
  if (!p) throw new Error("Producto no encontrado");
  const ahora = ahoraIso();
  await db().lote([
    { id: "producto.eliminar", params: [ahora, ahora, id] },
    bitacora(actor.id, "producto.eliminar", "producto", id, { nombre: p.nombre, precio: p.precio, codigos: p.codigos.map((c) => c.codigo) }),
  ]);
}

export async function asociarCodigo(actor: Actor, productoId: string, codigo: string, tipo: TipoCodigo, opc: { mover?: boolean } = {}): Promise<void> {
  permitir(actor);
  if (!(await obtenerProducto(productoId))) throw new Error("Producto no encontrado");
  const s = await sentenciasCodigo(actor, productoId, limpiarCodigo(codigo), tipo, !!opc.mover);
  if (s.length) await db().lote(s);
}

export async function quitarCodigo(actor: Actor, codigo: string): Promise<void> {
  permitir(actor);
  const dueno = await duenoDelCodigo(codigo);
  if (!dueno) return;
  await db().lote([
    { id: "codigo.quitar", params: [codigo] },
    bitacora(actor.id, "codigo.quitar", "codigo", codigo, { producto: dueno.id, nombre: dueno.nombre }),
  ]);
}

/**
 * Toma el siguiente número de código interno (config codigo_interno_siguiente) en una sola
 * sentencia, así dos pantallas a la vez nunca reciben el mismo. Salta números ya usados
 * (p. ej. si alguien asoció a mano un código 200…).
 */
export async function siguienteCodigoInterno(): Promise<string> {
  await db().lote([{ id: "codigo_interno.asegurar" }]);
  for (let intento = 0; intento < 1000; intento++) {
    const [filas] = (await db().lote([{ id: "codigo_interno.tomar", params: [ahoraIso()] }])) as Record<string, unknown>[][];
    const f = filas[0];
    const codigo = codigoInterno(Number(f.n));
    if (!(await duenoDelCodigo(codigo))) return codigo;
  }
  throw new Error("No se encontró un código interno libre");
}

/** Genera un código interno EAN-13 y lo asocia al producto. Devuelve el código. */
export async function generarCodigoInterno(actor: Actor, productoId: string): Promise<string> {
  permitir(actor);
  if (!(await obtenerProducto(productoId))) throw new Error("Producto no encontrado");
  const codigo = await siguienteCodigoInterno();
  await db().lote(await sentenciasCodigo(actor, productoId, codigo, "interno", false));
  return codigo;
}

/** Marca o desmarca un producto como favorito (tarjeta en la pantalla de venta). */
export async function marcarFavorito(actor: Actor, id: string, favorito: boolean): Promise<void> {
  permitir(actor);
  const p = await obtenerProducto(id);
  if (!p) throw new Error("Producto no encontrado");
  if (p.favorito === favorito) return;
  await db().lote([
    { id: "producto.favorito", params: [favorito, ahoraIso(), id] },
    bitacora(actor.id, "producto.editar", "producto", id, { antes: { favorito: p.favorito }, despues: { favorito } }),
  ]);
}

/** Marca o desmarca varios productos de una vez (p. ej. todo un departamento). Una sola transacción. */
export async function marcarFavoritos(actor: Actor, ids: string[], favorito: boolean): Promise<number> {
  permitir(actor);
  if (!ids.length) return 0;
  if (ids.length > 1000) throw new Error("Son demasiados productos de una vez: filtre un poco más");
  const ahora = ahoraIso();
  await db().lote([
    ...ids.map((id) => ({ id: "producto.favorito", params: [favorito, ahora, id] })),
    bitacora(actor.id, "producto.editar", "producto", null, { favoritos: favorito ? "marcar" : "quitar", cantidad: ids.length, ids: ids.slice(0, 200) }),
  ]);
  return ids.length;
}
