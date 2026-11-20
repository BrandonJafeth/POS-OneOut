// Prueba espejo: los mismos casos que src-tauri/src/cuentas_tests.rs (reglas_iguales_que_en_la_pantalla).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { abonoMinimo, creditoAlcanza, fechaLimite, validarAbono } from "../src/lib/cuentas";

const casos = JSON.parse(readFileSync(new URL("./casos/cuentas.json", import.meta.url), "utf8"));

describe("reglas de apartados (iguales que en Rust)", () => {
  it("abono mínimo", () => {
    for (const c of casos.abonoMinimo) expect(abonoMinimo(c.total, c.pct), JSON.stringify(c)).toBe(c.esperado);
  });
  it("fecha límite con días laborables", () => {
    for (const c of casos.fechaLimite) expect(fechaLimite(c.desde, c.dias, c.tipo, casos.horario), JSON.stringify(c)).toBe(c.esperado);
  });
  it("validar abono", () => {
    for (const c of casos.validarAbono) expect(validarAbono(c.saldo, c.monto, c.minimo) === "", JSON.stringify(c)).toBe(c.ok);
  });
  it("crédito alcanza", () => {
    for (const c of casos.creditoAlcanza) expect(creditoAlcanza(c.limite, c.saldo, c.nuevo), JSON.stringify(c)).toBe(c.ok);
  });
});
