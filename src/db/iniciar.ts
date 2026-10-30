import { usarDriver, db } from "./conexion";
import { crearDriverTauri } from "./driverTauri";

export interface EstadoBase {
  journalMode: string;
  foreignKeys: boolean;
}

/**
 * Abre la base de la app. Las migraciones ya las corrió el plugin al arrancar (preload).
 * WAL queda guardado en el archivo, así que basta pedirlo una vez por arranque.
 * foreign_keys lo activa sqlx en cada conexión del pool (es su valor por defecto); aquí solo se comprueba.
 */
export async function iniciarBase(): Promise<EstadoBase> {
  usarDriver(await crearDriverTauri());
  await db().select("PRAGMA journal_mode = WAL");
  return estadoBase();
}

/** Para mostrar en Configuración técnica. */
export async function estadoBase(): Promise<EstadoBase> {
  const jm = await db().select("PRAGMA journal_mode");
  const fk = await db().select("PRAGMA foreign_keys");
  return {
    journalMode: String(Object.values(jm[0] ?? {})[0] ?? "?"),
    foreignKeys: Number(Object.values(fk[0] ?? {})[0]) === 1,
  };
}
