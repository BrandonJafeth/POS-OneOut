// Preparación para una futura sincronización con la nube (p. ej. Supabase). Hoy NO hay
// sincronización: este módulo fija la regla para cuando exista.
//
// Ley 8968: a la nube va solo lo de esta LISTA BLANCA (tabla → columnas). Todo lo que no
// esté aquí no sale, por diseño: tablas nuevas quedan fuera hasta que alguien las agregue
// a propósito. Clientes, apartados (llevan cliente y notas), usuarios y bitácora nunca.
import { db } from "./conexion";

export const NUBE_LISTA_BLANCA: Readonly<Record<string, readonly string[]>> = {
  departamentos: ["id", "codigo", "nombre", "orden", "activo", "creado_en", "actualizado_en", "eliminado_en"],
  productos: ["id", "web_id", "nombre", "departamento_id", "precio", "activo", "cabys", "tasa_iva", "exento", "creado_en", "actualizado_en", "eliminado_en"],
  codigos: ["codigo", "producto_id", "tipo", "creado_en"],
  formas_pago: ["id", "codigo", "nombre", "tipo", "requiere_banco", "requiere_referencia", "da_vuelto", "orden", "activo", "creado_en", "actualizado_en", "eliminado_en"],
  bancos: ["id", "nombre", "orden", "activo", "creado_en", "actualizado_en", "eliminado_en"],
  // Ventas SIN cliente_id ni usuario_id: los totales sirven para reportes, la persona no.
  ventas: ["id", "sucursal_id", "caja_id", "consecutivo", "numero", "fecha", "subtotal", "descuento", "total", "iva_total", "estado", "creado_en", "actualizado_en", "eliminado_en"],
  venta_lineas: ["id", "venta_id", "producto_id", "codigo", "descripcion", "departamento_id", "cantidad", "precio_unitario", "descuento", "total", "tasa_iva", "iva", "orden", "creado_en", "actualizado_en", "eliminado_en"],
};

/** Columnas que nunca pueden salir, aunque alguien las agregue por error a la lista blanca. */
export const COLUMNAS_PERSONALES = ["cliente_id", "cedula", "telefono", "correo", "notas", "pin_hash", "usuario_id", "nombre_busqueda", "tipo_identificacion", "nombre_tiquete"];
export const TABLAS_PROHIBIDAS = ["clientes", "cuentas", "cuenta_lineas", "abonos", "usuarios", "bitacora", "negocio"];

export function tablaSincronizable(tabla: string): boolean {
  return tabla in NUBE_LISTA_BLANCA && !TABLAS_PROHIBIDAS.includes(tabla);
}

/** Recorta una fila a las columnas permitidas. Una tabla no permitida lanza error (nunca se manda "por las dudas"). */
export function filaParaNube(tabla: string, fila: Record<string, unknown>): Record<string, unknown> {
  if (!tablaSincronizable(tabla)) throw new Error(`La tabla "${tabla}" no se sincroniza con la nube`);
  const permitidas = NUBE_LISTA_BLANCA[tabla].filter((c) => !COLUMNAS_PERSONALES.includes(c));
  return Object.fromEntries(permitidas.filter((c) => c in fila).map((c) => [c, fila[c]]));
}

/** Lo que se subiría: filas cambiadas desde `desde`, por tabla, ya filtradas. */
export async function cambiosParaNube(desde: string): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const tabla of Object.keys(NUBE_LISTA_BLANCA)) {
    if (!tablaSincronizable(tabla)) continue;
    const tieneActualizado = NUBE_LISTA_BLANCA[tabla].includes("actualizado_en");
    const filas = await db().select(
      `SELECT * FROM ${tabla} WHERE ${tieneActualizado ? "actualizado_en" : "creado_en"} > ?`,
      [desde],
    );
    out[tabla] = filas.map((f) => filaParaNube(tabla, f));
  }
  return out;
}
