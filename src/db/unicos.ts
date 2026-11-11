// Nombres que no se pueden repetir en tablas de configuración (departamentos, formas de pago,
// bancos). "Efectivo", "efectivo " y "Éfectivo" son el mismo. Los eliminados no cuentan.
// Lo que vive en Rust (proveedores, usuarios, clientes) usa util::nombre_libre, que hace lo mismo.
// Productos tiene su propia versión (productoConNombre) porque el aviso muestra precio y estado.
import { normalizar } from "../lib/texto";
import { db } from "./conexion";

type Tabla = "departamentos" | "formas_pago" | "bancos";

/** Lanza "Ya existe {que} «X»" si otro registro vivo de `tabla` tiene ese nombre. */
export async function exigirNombreLibre(tabla: Tabla, nombre: string, menosId: string | null | undefined, que: string): Promise<void> {
  const buscado = normalizar(nombre);
  if (!buscado) return;
  const filas = await db().select(`SELECT id, nombre FROM ${tabla} WHERE eliminado_en IS NULL`);
  const otro = filas.find((f) => String(f.id) !== menosId && normalizar(String(f.nombre)) === buscado);
  if (otro) throw new Error(`Ya existe ${que} «${String(otro.nombre)}». Use otro nombre o edite el que ya está.`);
}
