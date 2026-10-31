// Driver de pruebas: SQLite en memoria con node:sqlite (incluido en Node 22.5+), aplicando
// las MISMAS migraciones que usa la app (src/db/migraciones/*.sql). Imita a Rust (src-tauri/src/bd.rs):
// - select: solo un SELECT y nunca sobre tablas sensibles (mismas reglas que validar_lectura).
// - lote: solo operaciones del registro src/db/sentencias.json, con permiso del actor de prueba.
// - bitacora.registrar: con hash encadenado (la base lo exige por trigger).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { usarDriver, type Driver, type Valor } from "../src/db/conexion";
import { puede, type Permiso } from "../src/lib/permisos";
import { ulid } from "../src/lib/ulid";
import type { EntradaBitacora, Rol } from "../src/tipos";

const DIR = fileURLToPath(new URL("../src/db/migraciones/", import.meta.url));
const REGISTRO = JSON.parse(readFileSync(fileURLToPath(new URL("../src/db/sentencias.json", import.meta.url)), "utf8")) as Record<
  string,
  { sql: string; permiso: Permiso; devuelve?: boolean }
>;

const PROHIBIDAS = [
  "usuarios", "clientes", "bitacora", "pin_hash", "ventas_espera", "cuentas", "cuenta_lineas", "abonos", "insert", "update", "delete", "drop", "create", "alter", "replace",
  "attach", "detach", "pragma", "vacuum", "load_extension", "sqlite_master", "sqlite_schema", "_sqlx_migrations",
];

/** Copia de bd.rs::validar_lectura: si una pantalla lee algo prohibido, la prueba falla igual que la app. */
export function validarLectura(sql: string): void {
  const t = sql.trim().replace(/;+\s*$/, "").trim();
  if (t.includes(";")) throw new Error("Lectura rechazada: una sola consulta");
  const palabras = t.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  if (palabras[0] !== "select" && palabras[0] !== "with") throw new Error("Lectura rechazada: solo SELECT");
  const p = palabras.find((w) => PROHIBIDAS.includes(w));
  if (p) throw new Error(`Lectura rechazada: «${p}» no está permitido desde la pantalla`);
}

function p(v: Valor) {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

let ultima: DatabaseSync | null = null;

export function baseDePrueba(opc: { rol?: Rol; usuarioId?: string } = {}): { driver: Driver; sqlite: DatabaseSync } {
  const rol: Rol = opc.rol ?? "dueno";
  const usuarioId = opc.usuarioId ?? "U-PRUEBA";
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(DIR).filter((n) => n.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(DIR, f), "utf8"));
  }
  sqlite.prepare("INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES (?, 'Prueba', ?, 'x')").run(usuarioId, rol);

  const registrarBitacora = (params: Valor[]) => {
    const anterior = (sqlite.prepare("SELECT hash FROM bitacora WHERE hash IS NOT NULL ORDER BY rowid DESC LIMIT 1").get() as { hash?: string } | undefined)?.hash ?? "";
    const fila = [ulid(), new Date().toISOString(), usuarioId, String(params[1]), String(params[2]), params[3] == null ? null : String(params[3]), String(params[4] ?? "{}")];
    const hash = createHash("sha256").update([anterior, ...fila.map((x) => x ?? "")].join("\u001f")).digest("hex");
    sqlite
      .prepare("INSERT INTO bitacora (id, fecha, usuario_id, accion, entidad, entidad_id, detalle, hash, hash_anterior) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...fila, hash, anterior);
    return 1;
  };

  const driver: Driver = {
    select: async (sql, params = []) => {
      validarLectura(sql);
      return sqlite.prepare(sql).all(...params.map(p)) as Record<string, unknown>[];
    },
    lote: async (ops) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const r = ops.map((o) => {
          const params = o.params ?? [];
          if (o.id === "bitacora.registrar") return registrarBitacora(params);
          const st = REGISTRO[o.id];
          if (!st || o.id.startsWith("_")) throw new Error(`Operación desconocida: ${o.id}`);
          if (!puede(rol, st.permiso)) throw new Error("No tiene permiso para hacer este cambio");
          const q = sqlite.prepare(st.sql);
          return st.devuelve ? q.all(...params.map(p)) : Number(q.run(...params.map(p)).changes);
        });
        sqlite.exec("COMMIT");
        return r;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  usarDriver(driver);
  ultima = sqlite;
  return { driver, sqlite };
}

/** Lo que listarBitacora devuelve en la app (más nuevo primero), leído directo de la base de prueba. */
export async function entradasBitacora(limite = 200, entidad?: string): Promise<EntradaBitacora[]> {
  if (!ultima) throw new Error("Sin base de prueba");
  const filas = ultima
    .prepare(`SELECT * FROM bitacora ${entidad ? "WHERE entidad = ?" : ""} ORDER BY rowid DESC LIMIT ?`)
    .all(...(entidad ? [entidad, limite] : [limite])) as Record<string, unknown>[];
  return filas.map((f) => ({
    id: String(f.id),
    fecha: String(f.fecha),
    usuarioId: f.usuario_id == null ? null : String(f.usuario_id),
    usuario: null,
    accion: f.accion as EntradaBitacora["accion"],
    entidad: String(f.entidad),
    entidadId: f.entidad_id == null ? null : String(f.entidad_id),
    detalle: JSON.parse(String(f.detalle ?? "{}")),
  }));
}
