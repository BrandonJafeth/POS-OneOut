// Conexión abstracta: el resto de src/db no sabe si habla con Rust (la app) o con node:sqlite
// (las pruebas). La pantalla NO manda SQL de escritura: pide operaciones por nombre del registro
// src/db/sentencias.json, y Rust pone el SQL y revisa el permiso contra la sesión.

export type Valor = string | number | boolean | null | Uint8Array;

/** Una operación del registro (src/db/sentencias.json) con sus parámetros. */
export interface Sentencia {
  id: string;
  params?: Valor[];
}

export type Fila = Record<string, unknown>;

export interface Driver {
  /** Una consulta SELECT (Rust la valida y la corre en modo solo lectura). */
  select(sql: string, params?: Valor[]): Promise<Fila[]>;
  /** Varias operaciones en UNA transacción: todas o ninguna. Por cada una: filas afectadas, o filas devueltas. */
  lote(sentencias: Sentencia[]): Promise<unknown[]>;
}

let actual: Driver | null = null;

export function usarDriver(d: Driver | null): void {
  actual = d;
}

export function db(): Driver {
  if (!actual) throw new Error("La base de datos no está iniciada");
  return actual;
}

/** SQLite guarda booleanos como 0/1. */
export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === "1";
}

export function texto(v: unknown): string {
  return v == null ? "" : String(v);
}

export function textoONull(v: unknown): string | null {
  return v == null ? null : String(v);
}

/** BLOB: Rust lo devuelve como arreglo de números; node:sqlite como Uint8Array. */
export function bytes(v: unknown): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return null;
}
