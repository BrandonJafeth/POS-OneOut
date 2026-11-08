// Driver de la app: lecturas con bd_leer (un SELECT de solo lectura, solo tablas de catálogo y
// configuración pública: LECTURA_PERMITIDA en bd.rs) y escrituras con bd_lote
// (operaciones por nombre, en una transacción). Ver src-tauri/src/bd.rs.
import { invocar } from "../lib/invocar";
import type { Driver, Fila, Valor } from "./conexion";

/** Booleanos como 0/1 y bytes como arreglo de números (así los recibe Rust). */
function param(v: Valor): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return Array.from(v);
  return v;
}

export function crearDriverTauri(): Driver {
  return {
    select: (sql, params = []) => invocar<Fila[]>("bd_leer", { sql, params: params.map(param) }),
    lote: (ops) => invocar<unknown[]>("bd_lote", { ops: ops.map((o) => ({ id: o.id, params: (o.params ?? []).map(param) })) }),
  };
}
