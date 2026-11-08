import { describe, expect, it } from "vitest";
import { codePageByEscT, encode } from "../src/lib/codepages";
import { limpiarNombre, normalizar } from "../src/lib/texto";

// Mismos casos que util::tests en Rust: la búsqueda solo funciona si las dos dan lo mismo.
describe("nombres normalizados igual en toda la app", () => {
  it.each([
    ["Café Ñandú", "cafe nandu"],
    ["Café Ñandú", "cafe nandu"],
    ["  LÁPIZ   2B ", "lapiz 2b"],
    ["Ana​Mora", "ana mora"],
    ["Pingüino Ýoyo", "pinguino yoyo"],
  ])("normalizar(%j)", (entrada, esperado) => expect(normalizar(limpiarNombre(entrada))).toBe(esperado));

  it("limpiarNombre: sin invisibles ni espacios dobles, tildes pegadas", () => {
    expect(limpiarNombre("  Ana ​ \t Mora ")).toBe("Ana Mora");
    expect(limpiarNombre("Café")).toBe("Café");
    expect(limpiarNombre("Café")).toHaveLength(4);
  });

  it("la impresora recibe la tilde pegada, no «Cafe?»", () => {
    const cp = codePageByEscT(16)!;
    const r = encode("Café", cp);
    expect(r.missing).toEqual([]);
    expect(r.bytes).toEqual(encode("Café", cp).bytes);
  });
});
