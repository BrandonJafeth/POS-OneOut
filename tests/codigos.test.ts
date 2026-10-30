import { beforeEach, describe, expect, it } from "vitest";
import { leerConfig } from "../src/db/config";
import { asociarCodigo, crearProducto, generarCodigoInterno, obtenerProducto, productoPorCodigo, siguienteCodigoInterno } from "../src/db/productos";
import { codigoInterno, ean13CheckDigit, isValidEan13 } from "../src/lib/ean13";
import { etiquetaProducto } from "../src/lib/impresion";
import { interpret } from "../src/lib/preview";
import { DEFAULT_SETTINGS } from "../src/lib/tickets";
import { esLecturaDeEscaner } from "../src/lib/useEscaner";
import type { Actor } from "../src/tipos";
import { baseDePrueba } from "./driverNode";

const DUENO: Actor = { id: "D", rol: "dueno" };
const OTROS = "00000000000000000000000D12";

describe("dígito verificador EAN-13", () => {
  it.each([
    ["978996800000", 0], // el del tiquete de prueba del prototipo (9789968000000)
    ["750103131130", 9],
    ["400638133393", 1],
    ["000000000000", 0],
  ])("%s → %i", (base, d) => expect(ean13CheckDigit(base)).toBe(d));

  it("valida y rechaza", () => {
    expect(isValidEan13("9789968000000")).toBe(true);
    expect(isValidEan13("9789968000001")).toBe(false);
    expect(isValidEan13("07toc")).toBe(false);
  });
});

describe("códigos internos", () => {
  it("prefijo 200, 13 dígitos y verificador válido", () => {
    expect(codigoInterno(1)).toBe("2000000000015");
    expect(codigoInterno(123)).toMatch(/^200000000123\d$/);
    for (const n of [1, 2, 99, 123456789, 999999999]) expect(isValidEan13(codigoInterno(n))).toBe(true);
    expect(() => codigoInterno(0)).toThrow();
    expect(() => codigoInterno(1e9)).toThrow();
  });

  describe("en la base", () => {
    beforeEach(async () => {
      const { driver } = baseDePrueba();
      await driver.execute("INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES ('D', 'Dueño', 'dueno', 'x')");
    });

    it("son secuenciales y avanzan el contador", async () => {
      expect(await siguienteCodigoInterno()).toBe(codigoInterno(1));
      expect(await siguienteCodigoInterno()).toBe(codigoInterno(2));
      expect((await leerConfig()).codigo_interno_siguiente).toBe(3);
    });

    it("saltan los ya usados y quedan asociados como 'interno'", async () => {
      const a = await crearProducto(DUENO, { nombre: "A", departamentoId: OTROS, precio: 1 });
      const b = await crearProducto(DUENO, { nombre: "B", departamentoId: OTROS, precio: 1 });
      await asociarCodigo(DUENO, a, codigoInterno(1), "manual");
      const c = await generarCodigoInterno(DUENO, b);
      expect(c).toBe(codigoInterno(2));
      expect((await productoPorCodigo(c))?.id).toBe(b);
      expect((await obtenerProducto(b))?.codigos).toEqual([{ codigo: c, tipo: "interno" }]);
    });
  });
});

describe("etiqueta", () => {
  it("lleva nombre, precio con ¢ y el EAN-13", () => {
    const items = interpret(etiquetaProducto({ nombre: "Cuaderno cosido 100 hojas", precio: 1250 }, codigoInterno(7), DEFAULT_SETTINGS).bytes);
    const texto = items.flatMap((i) => (i.kind === "line" ? [i.spans.map((s) => s.text).join("")] : []));
    expect(texto).toContain("Cuaderno cosido 100 hojas");
    expect(texto).toContain("¢1.250");
    expect(items.find((i) => i.kind === "barcode")).toMatchObject({ data: codigoInterno(7) });
  });

  it("no acepta un código que no sea EAN-13", () => {
    expect(() => etiquetaProducto({ nombre: "x", precio: 1 }, "07toc", DEFAULT_SETTINGS)).toThrow();
  });
});

describe("detección del escáner", () => {
  it("rápido = escáner, lento = persona", () => {
    expect(esLecturaDeEscaner([0, 10, 20, 30, 40], 40, 3)).toBe(true);
    expect(esLecturaDeEscaner([0, 150, 300, 450], 40, 3)).toBe(false);
    expect(esLecturaDeEscaner([0, 5], 40, 3)).toBe(false);
  });
});
