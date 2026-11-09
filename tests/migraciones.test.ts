import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Los datos del cliente vienen desde la versión de prueba (0.9.0, migración 12). Toda migración
// posterior se aplica sobre datos REALES: no puede borrar tablas ni filas. Si alguna vez hace falta,
// se escribe "-- PERMITIDO: <motivo>" en la línea anterior y se respalda antes (bd.rs ya copia la base).
const DIR = new URL("../src/db/migraciones/", import.meta.url);
const PRIMERA_CON_DATOS_REALES = 13;

describe("migraciones", () => {
  const archivos = readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

  it("numeradas sin huecos ni repetidas", () => {
    archivos.forEach((f, i) => expect(Number(f.slice(0, 4))).toBe(i + 1));
  });

  it("desde la 13 no borran tablas ni filas (salvo que se marque a propósito)", () => {
    for (const f of archivos.filter((x) => Number(x.slice(0, 4)) >= PRIMERA_CON_DATOS_REALES)) {
      const lineas = readFileSync(new URL(f, DIR), "utf8").split("\n");
      lineas.forEach((l, i) => {
        if (/^\s*(DROP\s+TABLE|DELETE\s+FROM)/i.test(l)) expect(lineas[i - 1] ?? "", `${f}:${i + 1}`).toMatch(/-- PERMITIDO:/);
      });
    }
  });
});
