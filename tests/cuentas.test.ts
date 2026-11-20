// Prueba espejo: los mismos casos que src-tauri/src/cuentas_tests.rs (reglas_iguales_que_en_la_pantalla).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { abonoMinimo, creditoAlcanza, fechaLimite, validarAbono } from "../src/lib/cuentas";
import { comprobanteCuenta } from "../src/lib/cuentas/comprobante";
import { interpret } from "../src/lib/preview";
import { DEFAULT_SETTINGS } from "../src/lib/tickets";
import type { CuentaDetalle } from "../src/generados/CuentaDetalle";
import type { Negocio } from "../src/tipos";

describe("comprobante de apartado", () => {
  const d: CuentaDetalle = {
    cuenta: {
      id: "K1", numero: "A-0012", tipo: "apartado", estado: "abierta", clienteId: "C1", cliente: "Marta Solís", telefono: null,
      fecha: "2026-11-20T10:00:00-06:00", fechaLimite: "2026-12-20", descripcion: "Retablo de graduada", total: 20000, saldo: 10000, abonado: 10000, vencida: false, diasAtraso: 0,
    },
    subtotal: 20000, descuento: 0, redondeo: 0, condonado: 0, devuelto: 0, retenido: 0, ventaId: null, ventaNumero: null, usuario: "Isaias",
    lineas: [{ productoId: "P1", descripcion: "Retablo 20x25", cantidad: 1, precioUnitario: 20000, descuento: 0, total: 20000 }],
    abonos: [], eventos: [],
  };
  const negocio: Negocio = {
    nombreComercial: "Librería y Bazar Chagui", razonSocial: "", cedula: "", direccion: "", telefono: "", correo: "", regimen: "", encabezadoExtra: "", pieTiquete: "",
    responsableTratamiento: "", avisoPrivacidadTexto: "", avisoPrivacidadVersion: "1", logo: null, logoUmbral: null,
  };
  const barras = (code128: boolean) =>
    interpret(comprobanteCuenta(negocio, d, { ...DEFAULT_SETTINGS, code128 }, { tipo: "apartado", copia: false }).bytes).filter((x) => x.kind === "barcode");

  it("sin la opción (por defecto) no lleva código de barras", () => {
    expect(barras(false)).toEqual([]);
  });

  it("con CODE128 activo lleva el número del apartado (GS k 73, juego B)", () => {
    expect(barras(true)).toEqual([{ kind: "barcode", data: "{BA-0012", type: 73 }]);
  });
});

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
