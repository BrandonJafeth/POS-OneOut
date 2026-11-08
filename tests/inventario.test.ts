import { describe, expect, it } from "vitest";
import { filasIniciales } from "../src/db/inventario";

describe("CSV de inventario inicial", () => {
  it("lee columnas por nombre, en cualquier orden, y numera las filas como la hoja", () => {
    const f = filasIniciales([
      ["Costo", "Existencia", "Código"],
      ["350", "12", "7401234567895"],
      ["", "", ""],
      ["", "3", "07toc"],
    ]);
    expect(f).toEqual([
      { fila: 2, clave: "7401234567895", existencia: "12", costo: "350" },
      { fila: 4, clave: "07toc", existencia: "3", costo: "" },
    ]);
  });

  it("sin encabezado: código, existencia, costo", () => {
    expect(filasIniciales([["ABC", "5"]])).toEqual([{ fila: 1, clave: "ABC", existencia: "5", costo: "" }]);
  });

  it("encabezado sin la columna de existencia: error claro", () => {
    expect(() => filasIniciales([["codigo", "nombre"], ["x", "y"]])).toThrow(/existencia/);
  });
});
