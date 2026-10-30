// Bitácora: TODA acción sensible pasa por bitacora(). Devuelve una sentencia para meterla
// en el mismo lote que el cambio (así no queda un cambio sin registro ni un registro sin cambio).
import type { AccionBitacora, EntradaBitacora } from "../tipos";
import { ulid } from "../lib/ulid";
import { ahoraIso } from "../lib/texto";
import { db, textoONull, type Sentencia } from "./conexion";

export function bitacora(
  usuarioId: string | null,
  accion: AccionBitacora,
  entidad: string,
  entidadId: string | null,
  detalle: unknown = {},
): Sentencia {
  return {
    sql: "INSERT INTO bitacora (id, fecha, usuario_id, accion, entidad, entidad_id, detalle) VALUES (?, ?, ?, ?, ?, ?, ?)",
    params: [ulid(), ahoraIso(), usuarioId, accion, entidad, entidadId, JSON.stringify(detalle ?? {})],
  };
}

/** Para acciones que no cambian nada más (p. ej. login fallido). */
export async function registrar(...args: Parameters<typeof bitacora>): Promise<void> {
  await db().lote([bitacora(...args)]);
}

export async function listarBitacora(limite = 200, entidad?: string): Promise<EntradaBitacora[]> {
  const filas = await db().select(
    `SELECT b.*, u.nombre AS usuario FROM bitacora b LEFT JOIN usuarios u ON u.id = b.usuario_id
     ${entidad ? "WHERE b.entidad = ?" : ""} ORDER BY b.fecha DESC, b.id DESC LIMIT ?`,
    entidad ? [entidad, limite] : [limite],
  );
  return filas.map((f) => ({
    id: String(f.id),
    fecha: String(f.fecha),
    usuarioId: textoONull(f.usuario_id),
    usuario: textoONull(f.usuario),
    accion: f.accion as AccionBitacora,
    entidad: String(f.entidad),
    entidadId: textoONull(f.entidad_id),
    detalle: JSON.parse(String(f.detalle ?? "{}")),
  }));
}
