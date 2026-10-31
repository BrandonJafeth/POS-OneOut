// Importación de productos. El archivo lo lee Rust (importacion_leer) y la escritura también
// (importacion_aplicar: vuelve a validar cada campo, pide el PIN y usa una sola transacción).
import type { FilaTabla } from "../lib/importar/web";
import type { Plan, ProductoExistente } from "../lib/importar/plan";
import { invocar } from "../lib/invocar";
import { bool, db, textoONull } from "./conexion";

export const MAX_BYTES = 5 * 1024 * 1024;

export interface TablaLeida {
  separador: string;
  codificacion: string;
  cabecera: string[];
  filas: FilaTabla[];
}

/** Lee el CSV en Rust (límite de 5 MB y 20.000 filas). El tamaño se revisa antes de mandarlo. */
export async function leerArchivo(archivo: File): Promise<TablaLeida> {
  if (archivo.size > MAX_BYTES) throw new Error("El archivo pesa más de 5 MB y no se lee. Divídalo en archivos más pequeños.");
  const bytes = Array.from(new Uint8Array(await archivo.arrayBuffer()));
  return invocar<TablaLeida>("importacion_leer", { archivo: bytes });
}

/** Todos los productos (también los eliminados, para no resucitarlos), solo con lo que usa el plan. */
export async function productosParaImportar(): Promise<ProductoExistente[]> {
  const filas = await db().select(
    `SELECT p.id, p.web_id, p.web_slug, p.nombre, p.precio, p.activo, p.departamento_id, p.favorito, p.categorias_origen, p.eliminado_en,
            EXISTS (SELECT 1 FROM codigos c WHERE c.producto_id = p.id AND c.tipo = 'interno') AS tiene_interno
     FROM productos p`,
  );
  return filas.map((f) => ({
    id: String(f.id),
    webId: textoONull(f.web_id),
    slug: textoONull(f.web_slug),
    nombre: String(f.nombre),
    precio: Number(f.precio),
    activo: bool(f.activo),
    departamentoId: String(f.departamento_id),
    favorito: bool(f.favorito),
    categoriasOrigen: textoONull(f.categorias_origen),
    tieneInterno: bool(f.tiene_interno),
    eliminado: f.eliminado_en != null,
  }));
}

export async function codigosExistentes(): Promise<string[]> {
  return (await db().select("SELECT codigo FROM codigos")).map((f) => String(f.codigo));
}

export async function favoritosActuales(): Promise<number> {
  return Number((await db().select("SELECT COUNT(*) AS n FROM productos WHERE favorito = 1 AND eliminado_en IS NULL"))[0].n);
}

export type ModoImportacion = "todo" | "validas";

export interface ResultadoImportacion {
  creados: number;
  actualizados: number;
  fallidos: { fila: number; mensaje: string }[];
  codigos: { fila: number; codigo: string }[];
}

export async function aplicarImportacion(
  plan: Plan,
  opc: { pin: string; modo: ModoImportacion; pisar: { departamento: boolean; favorito: boolean } },
): Promise<ResultadoImportacion> {
  const items = [...plan.nuevos, ...plan.actualizar].map((i) => ({
    fila: i.fila,
    accion: i.accion,
    webId: i.webId,
    slug: i.slug,
    productoId: i.productoId ?? null,
    nombre: i.nombre,
    precio: i.precio,
    activo: i.activo,
    departamentoId: i.departamentoId,
    favorito: i.favorito,
    revisar: i.revisar,
    categoriasOrigen: i.categorias.join(" | "),
    codigo: i.codigo,
  }));
  return invocar<ResultadoImportacion>("importacion_aplicar", {
    pin: opc.pin,
    pedido: {
      modo: opc.modo,
      items,
      pisar: opc.pisar,
      resumen: { filas: plan.total, sinCambios: plan.sinCambios, omitidos: plan.omitidos.length, errores: plan.errores.length },
    },
  });
}

export interface ResumenCatalogo {
  porDepartamento: { departamentoId: string; nombre: string; total: number }[];
  total: number;
  sinBarras: number;
  favoritos: number;
  paraRevisar: number;
  inactivos: number;
}

/** Cómo quedó el catálogo después de importar (lo vigente, no solo lo del archivo). */
export async function resumenCatalogo(): Promise<ResumenCatalogo> {
  const porDepartamento = (
    await db().select(
      `SELECT d.id, d.nombre, COUNT(p.id) AS n FROM departamentos d
       LEFT JOIN productos p ON p.departamento_id = d.id AND p.eliminado_en IS NULL
       WHERE d.eliminado_en IS NULL GROUP BY d.id ORDER BY d.orden, d.codigo`,
    )
  ).map((f) => ({ departamentoId: String(f.id), nombre: String(f.nombre), total: Number(f.n) }));
  const [t] = await db().select(
    `SELECT COUNT(*) AS total,
            SUM(NOT EXISTS (SELECT 1 FROM codigos c WHERE c.producto_id = p.id AND c.tipo = 'barras')) AS sin_barras,
            SUM(p.favorito) AS favoritos, SUM(p.revisar) AS revisar, SUM(p.activo = 0) AS inactivos
     FROM productos p WHERE p.eliminado_en IS NULL`,
  );
  return {
    porDepartamento,
    total: Number(t.total ?? 0),
    sinBarras: Number(t.sin_barras ?? 0),
    favoritos: Number(t.favoritos ?? 0),
    paraRevisar: Number(t.revisar ?? 0),
    inactivos: Number(t.inactivos ?? 0),
  };
}
