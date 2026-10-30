// Driver de pruebas: SQLite en memoria con node:sqlite (incluido en Node 22.5+), aplicando
// las MISMAS migraciones que usa la app (src/db/migraciones/*.sql).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { usarDriver, type Driver, type Valor } from "../src/db/conexion";

const DIR = fileURLToPath(new URL("../src/db/migraciones/", import.meta.url));

function p(v: Valor) {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

export function baseDePrueba(): { driver: Driver; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(DIR).filter((n) => n.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(DIR, f), "utf8"));
  }
  const run = (sql: string, params: Valor[] = []) => Number(sqlite.prepare(sql).run(...params.map(p)).changes);
  const driver: Driver = {
    select: async (sql, params = []) => sqlite.prepare(sql).all(...params.map(p)) as Record<string, unknown>[],
    execute: async (sql, params) => run(sql, params),
    lote: async (sentencias) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const r = sentencias.map((s) => run(s.sql, s.params));
        sqlite.exec("COMMIT");
        return r;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  usarDriver(driver);
  return { driver, sqlite };
}
