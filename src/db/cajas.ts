// Sucursales y cajas. Hoy hay una de cada (filas fijas de la migración 1); el consecutivo
// del tiquete vive en la caja para que cada caja futura numere por su cuenta.
import type { Caja } from "../tipos";
import { db, texto } from "./conexion";

export const SUCURSAL_PRINCIPAL = "0000000000000000000000S001";
export const CAJA_1 = "0000000000000000000000C001";

function aCaja(f: Record<string, unknown>): Caja {
  return {
    id: String(f.id),
    sucursalId: String(f.sucursal_id),
    nombre: String(f.nombre),
    prefijoTiquete: texto(f.prefijo_tiquete),
    consecutivoSiguiente: Number(f.consecutivo_siguiente),
  };
}

export async function obtenerCaja(id = CAJA_1): Promise<Caja | null> {
  const f = (await db().select("SELECT * FROM cajas WHERE id = ? AND eliminado_en IS NULL", [id]))[0];
  return f ? aCaja(f) : null;
}

export function numeroTiquete(prefijo: string, consecutivo: number): string {
  return prefijo + consecutivo;
}

/**
 * Toma el siguiente consecutivo de la caja en UNA sentencia (UPDATE … RETURNING): dos
 * llamadas simultáneas nunca reciben el mismo número.
 * En la fase 2, la venta lo tomará dentro de su propio lote (INSERT … SELECT consecutivo_siguiente
 * + UPDATE en la misma transacción) para que una venta fallida no deje huecos.
 */
export async function tomarConsecutivo(cajaId = CAJA_1): Promise<{ consecutivo: number; numero: string }> {
  const f = (
    await db().select(
      `UPDATE cajas SET consecutivo_siguiente = consecutivo_siguiente + 1
       WHERE id = ? AND eliminado_en IS NULL
       RETURNING consecutivo_siguiente - 1 AS consecutivo, prefijo_tiquete`,
      [cajaId],
    )
  )[0];
  if (!f) throw new Error("Caja no encontrada");
  const consecutivo = Number(f.consecutivo);
  return { consecutivo, numero: numeroTiquete(texto(f.prefijo_tiquete), consecutivo) };
}
