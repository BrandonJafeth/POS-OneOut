// Conexión abstracta: el resto de src/db no sabe si habla con tauri-plugin-sql (la app)
// o con node:sqlite (las pruebas). Cambiar de almacenamiento = escribir otro Driver.

export type Valor = string | number | boolean | null | Uint8Array;

export interface Sentencia {
  sql: string;
  params?: Valor[];
}

export type Fila = Record<string, unknown>;

export interface Driver {
  select(sql: string, params?: Valor[]): Promise<Fila[]>;
  /** Una sentencia de escritura; devuelve filas afectadas. */
  execute(sql: string, params?: Valor[]): Promise<number>;
  /** Varias sentencias en UNA transacción: todas o ninguna. */
  lote(sentencias: Sentencia[]): Promise<number[]>;
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

/** BLOB: el plugin lo devuelve como arreglo de números; node:sqlite como Uint8Array. */
export function bytes(v: unknown): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return null;
}
