// Aplica un plan de importación en UNA transacción: o entra todo, o nada.
import type { Actor } from "../tipos";
import type { Plan, ProductoExistente } from "../lib/importar/plan";
import { puede, SinPermiso } from "../lib/permisos";
import { ahoraIso, normalizar } from "../lib/texto";
import { ulid } from "../lib/ulid";
import { bitacora } from "./bitacora";
import { db, textoONull, type Sentencia } from "./conexion";

/** Todos los productos (también los eliminados, para no resucitarlos), solo con lo que usa el plan. */
export async function productosParaImportar(): Promise<ProductoExistente[]> {
  const filas = await db().select("SELECT id, web_id, nombre, precio, eliminado_en FROM productos");
  return filas.map((f) => ({
    id: String(f.id),
    webId: textoONull(f.web_id),
    nombre: String(f.nombre),
    precio: Number(f.precio),
    eliminado: f.eliminado_en != null,
  }));
}

export async function aplicarImportacion(actor: Actor, plan: Plan): Promise<{ creados: number; actualizados: number }> {
  if (!puede(actor.rol, "productos.importar")) throw new SinPermiso("importar productos");
  const ahora = ahoraIso();
  const s: Sentencia[] = [];
  for (const it of plan.nuevos) {
    // ON CONFLICT: si entre la vista previa y la confirmación apareció ese web_id, se actualiza en vez de duplicar.
    s.push({
      sql: `INSERT INTO productos (id, web_id, nombre, nombre_busqueda, departamento_id, precio, creado_en, actualizado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (web_id) DO UPDATE SET nombre = excluded.nombre, nombre_busqueda = excluded.nombre_busqueda,
              precio = excluded.precio, actualizado_en = excluded.actualizado_en`,
      params: [ulid(), it.webId, it.nombre, normalizar(it.nombre), it.departamentoId, it.precio, ahora, ahora],
    });
  }
  for (const it of plan.actualizar) {
    s.push({
      sql: "UPDATE productos SET nombre = ?, nombre_busqueda = ?, precio = ?, actualizado_en = ? WHERE id = ?",
      params: [it.nombre, normalizar(it.nombre), it.precio, ahora, it.productoId!],
    });
  }
  const cambiosPrecio = plan.actualizar
    .filter((it) => it.antes && it.antes.precio !== it.precio)
    .map((it) => ({ id: it.productoId, nombre: it.nombre, antes: it.antes!.precio, despues: it.precio }));
  s.push(
    bitacora(actor.id, "importacion", "producto", null, {
      origen: plan.origen,
      filas: plan.total,
      creados: plan.nuevos.length,
      actualizados: plan.actualizar.length,
      sinCambios: plan.sinCambios,
      omitidos: plan.omitidos.length,
      errores: plan.errores.length,
      cambiosPrecio,
    }),
  );
  await db().lote(s);
  return { creados: plan.nuevos.length, actualizados: plan.actualizar.length };
}
