import { describe, expect, it } from "vitest";
import { calcularTotales, conLinea, estadoVacio, leerDescuento, necesitaAutorizacion, redondear } from "../src/lib/venta/calculo";
import type { LineaEspera } from "../src/tipos";

const linea = (precioUnitario: number, cantidad: number, descuento: number, x: Partial<LineaEspera> = {}): LineaEspera => ({
  id: String(Math.random()),
  productoId: null,
  codigo: null,
  descripcion: "A",
  departamentoId: "D",
  cantidad,
  precioUnitario,
  descuento,
  tasaIva: 13,
  exento: false,
  ...x,
});

// Mismos casos que calculo.rs (redondeo_y_totales): la pantalla muestra lo mismo que Rust cobra.
describe("calcularTotales (espejo de calculo.rs)", () => {
  it("redondeo al múltiplo más cercano", () => expect([1502, 1503, 1500].map((x) => redondear(x, 5))).toEqual([1500, 1505, 1500]));
  it("totales con descuento de línea y al total", () => {
    const t = calcularTotales({ ...estadoVacio(), lineas: [linea(1001, 2, 0), linea(500, 1, 100)], descuentoTotal: 200 }, 5);
    expect([t.bruto, t.subtotal, t.descuento, t.total, t.redondeo]).toEqual([2502, 2402, 200, 2200, -2]);
  });
  it("el descuento al total no pasa del subtotal", () => {
    expect(calcularTotales({ ...estadoVacio(), lineas: [linea(1000, 1, 0)], descuentoTotal: 5000 }, 1).total).toBe(0);
  });
});

describe("conLinea", () => {
  const p = (descuento = 0, precio = 500) => linea(precio, 1, descuento, { productoId: "P1" });
  it("el mismo producto suma cantidad", () => expect(conLinea(conLinea(estadoVacio(), p()), p()).lineas.map((l) => l.cantidad)).toEqual([2]));
  it("con descuento, otro precio o sin producto: línea aparte", () => {
    expect(conLinea(conLinea(estadoVacio(), p(100)), p()).lineas).toHaveLength(2);
    expect(conLinea(conLinea(estadoVacio(), p(0, 500)), p(0, 600)).lineas).toHaveLength(2);
    expect(conLinea(conLinea(estadoVacio(), linea(500, 1, 0)), linea(500, 1, 0)).lineas).toHaveLength(2);
  });
});

describe("leerDescuento", () => {
  it("colones con separador y porcentaje con coma", () => {
    expect(leerDescuento("1.500", 10000, "¢")).toBe(1500);
    expect(leerDescuento("12,5", 10000, "%")).toBe(1250);
    expect(leerDescuento("", 10000, "%")).toBe(0);
  });
  it("lo que no se entiende es null", () => {
    expect(leerDescuento("101", 10000, "%")).toBeNull();
    expect(leerDescuento("-5", 10000, "%")).toBeNull();
    expect(leerDescuento("abc", 10000, "¢")).toBeNull();
  });
});

describe("necesitaAutorizacion", () => {
  const e = estadoVacio();
  it("hasta el tope no pide PIN; por encima sí, salvo autorización que lo cubra", () => {
    expect(necesitaAutorizacion(e, 10, 10)).toBe(false);
    expect(necesitaAutorizacion(e, 10.5, 10)).toBe(true);
    expect(necesitaAutorizacion({ ...e, autorizacion: { duenoId: "d", pct: 20, token: "t" } }, 15, 10)).toBe(false);
    expect(necesitaAutorizacion({ ...e, autorizacion: { duenoId: "d", pct: 20, token: "t" } }, 25, 10)).toBe(true);
  });
});
