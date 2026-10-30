// Driver de la app: lecturas con tauri-plugin-sql y escrituras con el comando Rust sql_lote
// (una transacción real; ver src-tauri/src/db.rs).
import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import type { Driver, Sentencia, Valor } from "./conexion";

export const DB_URL = "sqlite:pos.db";

/** El plugin mandaría true como texto 'true' y los bytes como texto JSON: se convierten antes. */
function param(v: Valor): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return Array.from(v);
  return v;
}

export async function crearDriverTauri(): Promise<Driver> {
  const conn = await Database.load(DB_URL);
  const lote = (sentencias: Sentencia[]) =>
    invoke<number[]>("sql_lote", {
      sentencias: sentencias.map((s) => ({ sql: s.sql, params: (s.params ?? []).map(param) })),
    });
  return {
    select: (sql, params = []) => conn.select(sql, params.map(param)),
    execute: async (sql, params) => (await lote([{ sql, params }]))[0],
    lote,
  };
}
