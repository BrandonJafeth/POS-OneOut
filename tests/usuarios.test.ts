// Usuarios, PIN, bloqueo y permisos se prueban en Rust (src-tauri/src/usuarios.rs).
// Aquí solo lo que la pantalla calcula para mostrar.
import { describe, expect, it } from "vitest";
import { esperaRestante, esperaTrasFallos, PIN_VALIDO } from "../src/lib/bloqueo";
import { pinMinimo } from "../src/db/usuarios";

describe("bloqueo de PIN (lo que muestra la pantalla)", () => {
  it("la espera se duplica y tiene tope", () => {
    expect([4, 5, 6, 7].map(esperaTrasFallos)).toEqual([0, 30_000, 60_000, 120_000]);
    expect(esperaTrasFallos(50)).toBe(15 * 60_000);
    expect(esperaRestante(null)).toBe(0);
  });

  it("PIN de 4 a 12 números; dueño y técnico, mínimo 6", () => {
    expect(PIN_VALIDO.test("1234")).toBe(true);
    expect(PIN_VALIDO.test("123")).toBe(false);
    expect(PIN_VALIDO.test("1234567890123")).toBe(false);
    expect([pinMinimo("cajero"), pinMinimo("dueno"), pinMinimo("tecnico")]).toEqual([4, 6, 6]);
  });
});

describe("mensajes de error para el usuario", async () => {
  const { textoError, mostrarDetalleTecnico, MENSAJE_GENERAL } = await import("../src/components/Mensaje");

  it("los de negocio pasan tal cual; los técnicos se cambian por uno general", () => {
    expect(textoError(new Error("Todavía faltan ¢500 por pagar."))).toBe("Todavía faltan ¢500 por pagar.");
    expect(textoError(new Error("ERROR_TECNICO: error returned from database: (code: 1) no such column: x"))).toBe(MENSAJE_GENERAL);
    expect(textoError(new TypeError("Cannot read properties of undefined"))).toBe(MENSAJE_GENERAL);
    expect(textoError(new Error("ERROR_TECNICO: database is locked"))).toContain("Espere unos segundos");
    expect(textoError(new Error("ERROR_TECNICO: turno cerrado: el pago no se puede modificar"))).toContain("ya se cerró");
  });

  it("el técnico ve además el detalle", () => {
    mostrarDetalleTecnico(true);
    expect(textoError(new Error("ERROR_TECNICO: no such column: x"))).toContain("Detalle técnico: no such column: x");
    mostrarDetalleTecnico(false);
  });
});
