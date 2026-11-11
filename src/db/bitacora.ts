// Bitácora: TODA acción sensible queda registrada. bitacora() devuelve una operación para meterla
// en el mismo lote que el cambio (así no queda un cambio sin registro ni un registro sin cambio).
// Rust la escribe con el usuario de la SESIÓN (el primer parámetro se ignora) y la encadena con hash.
import type { AccionBitacora, EntradaBitacora } from "../tipos";
import { invocar } from "../lib/invocar";
import { db, type Sentencia } from "./conexion";

export function bitacora(
  usuarioId: string | null,
  accion: AccionBitacora,
  entidad: string,
  entidadId: string | null,
  detalle: unknown = {},
): Sentencia {
  return { id: "bitacora.registrar", params: [usuarioId, accion, entidad, entidadId, JSON.stringify(detalle ?? {})] };
}

/** Para acciones que no cambian nada más (p. ej. login fallido). */
export async function registrar(...args: Parameters<typeof bitacora>): Promise<void> {
  await db().lote([bitacora(...args)]);
}

/** `dias`: del día local `desde` al `hasta` incluidos ("AAAA-MM-DD"). */
export async function listarBitacora(limite = 200, entidad?: string, dias?: { desde: string; hasta: string }): Promise<EntradaBitacora[]> {
  const inicio = (dia: string) => new Date(`${dia}T00:00:00`); // medianoche en la hora de la caja
  const finExclusivo = (dia: string) => new Date(inicio(dia).getTime() + 86_400_000);
  return invocar<EntradaBitacora[]>("bitacora_listar", {
    limite,
    entidad: entidad ?? null,
    desde: dias ? inicio(dias.desde).toISOString() : null,
    hasta: dias ? finExclusivo(dias.hasta).toISOString() : null,
  });
}

export interface VerificacionBitacora {
  ok: boolean;
  filas: number;
  rotaEn: string | null;
}

/** Recorre la cadena de hashes: si alguien editó o borró una fila directo en el archivo, aparece aquí. */
export function verificarBitacora(): Promise<VerificacionBitacora> {
  return invocar<VerificacionBitacora>("bitacora_verificar");
}
