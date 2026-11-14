// Catálogo de la venta: orden y páginas. Monto de cobro con punto de miles.
import { beforeEach, describe, expect, it } from "vitest";
import { buscarProductos, crearProducto } from "../src/db/productos";
import { conMiles, leerMontoEntero } from "../src/lib/texto";
import type { Actor } from "../src/tipos";
import { baseDePrueba } from "./driverNode";
import { lecturaConCantidad } from "../src/screens/venta/useCatalogo";

const DUENO: Actor = { id: "D", rol: "dueno" };
const LIBRERIA = "00000000000000000000000D01";

describe("monto con miles", () => {
  it.each([
    ["3500", "3.500"],
    ["3400", "3.400"],
    ["¢ 20 000", "20.000"],
    ["0050", "50"],
    ["", ""],
    ["abc", ""],
  ])("%s → %s", (s, r) => expect(conMiles(s)).toBe(r));

  it("lo que se muestra se vuelve a leer igual", () => {
    expect(leerMontoEntero(conMiles("123456"))).toBe(123456);
  });
});

describe("orden y páginas del catálogo", () => {
  beforeEach(async () => {
    baseDePrueba({ rol: "dueno", usuarioId: DUENO.id });
    for (const [nombre, precio] of [["Borrador", 300], ["Agenda", 3500], ["Cuaderno", 1200], ["Lápiz", 350]] as const)
      await crearProducto(DUENO, { nombre, departamentoId: LIBRERIA, precio });
  });

  it("ordena por nombre o precio en los dos sentidos", async () => {
    const nombres = async (orden: Parameters<typeof buscarProductos>[0]) => (await buscarProductos(orden)).filas.map((p) => p.nombre);
    expect(await nombres({})).toEqual(["Agenda", "Borrador", "Cuaderno", "Lápiz"]);
    expect(await nombres({ orden: "nombre_desc" })).toEqual(["Lápiz", "Cuaderno", "Borrador", "Agenda"]);
    expect(await nombres({ orden: "precio" })).toEqual(["Borrador", "Lápiz", "Cuaderno", "Agenda"]);
    expect(await nombres({ orden: "precio_desc" })).toEqual(["Agenda", "Cuaderno", "Lápiz", "Borrador"]);
  });

  it("devuelve el total aunque se pida una página, y la siguiente sigue donde quedó", async () => {
    const p1 = await buscarProductos({ orden: "precio", limite: 3 });
    expect(p1.total).toBe(4);
    expect(p1.filas).toHaveLength(3);
    const p2 = await buscarProductos({ orden: "precio", limite: 3, desplazamiento: 3 });
    expect(p2.filas.map((p) => p.nombre)).toEqual(["Agenda"]);
  });
});

describe("3* y escanear", () => {
  it("toma la cantidad del buscador o de la lectura pegada", () => {
    // Con pausa: el lector lee solo el código; "3*" quedó en el buscador (con o sin el código todavía).
    expect(lecturaConCantidad("7501234567890", "3*")).toEqual({ codigo: "7501234567890", cantidad: 3 });
    expect(lecturaConCantidad("7501234567890", "3*7501234567890")).toEqual({ codigo: "7501234567890", cantidad: 3 });
    // Escaneando enseguida del "*": la ráfaga trae todo junto.
    expect(lecturaConCantidad("12*07toc", "")).toEqual({ codigo: "07toc", cantidad: 12 });
    // Sin "N*": uno. "0*" cuenta como uno.
    expect(lecturaConCantidad("7501234567890", "lapiz")).toEqual({ codigo: "7501234567890", cantidad: 1 });
    expect(lecturaConCantidad("7501234567890", "0*")).toEqual({ codigo: "7501234567890", cantidad: 1 });
  });
});
