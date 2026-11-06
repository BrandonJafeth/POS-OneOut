import { describe, expect, it } from "vitest";
import type { VentaResumen } from "../src/db/ventas";
import { buscarVentas, pendienteFactura, type Criterios } from "../src/lib/venta/buscar";

const venta = (x: Partial<VentaResumen>): VentaResumen => ({
  id: "1",
  numero: "000123",
  fecha: new Date(2026, 10, 5, 15, 10).toISOString(),
  total: 3500,
  estado: "completada",
  cajero: "Ana",
  requiereFactura: false,
  facturaEmitida: false,
  formas: "Efectivo",
  turnoAbierto: true,
  productos: "Tijera · Cuaderno",
  articulos: 2,
  ...x,
});
const sin: Criterios = { texto: "", desde: "", hasta: "", filtro: "todas" };
const ids = (l: VentaResumen[], c: Partial<Criterios>) => buscarVentas(l, { ...sin, ...c }).map((v) => v.id);

describe("buscarVentas", () => {
  const lista = [
    venta({ id: "a" }),
    venta({ id: "b", total: 13500, numero: "000124", formas: "Efectivo + SINPE", fecha: new Date(2026, 10, 5, 9, 0).toISOString() }),
    venta({ id: "c", estado: "anulada", requiereFactura: true, productos: "Lápiz" }),
    venta({ id: "d", requiereFactura: true, cajero: "José" }),
  ];

  it("sin criterios muestra todo", () => expect(ids(lista, {})).toEqual(["a", "b", "c", "d"]));
  it("monto con o sin separadores", () => {
    expect(ids(lista, { texto: "3.500" })).toEqual(["a", "b", "c", "d"]);
    expect(ids(lista, { texto: "13500" })).toEqual(["b"]);
  });
  it("texto sin tildes ni mayúsculas", () => {
    expect(ids(lista, { texto: "lapiz" })).toEqual(["c"]);
    expect(ids(lista, { texto: "jose" })).toEqual(["d"]);
  });
  it("filtros", () => {
    expect(ids(lista, { filtro: "factura" })).toEqual(["d"]);
    expect(ids(lista, { filtro: "anuladas" })).toEqual(["c"]);
    expect(ids(lista, { filtro: "forma:SINPE" })).toEqual(["b"]);
  });
  it("rango de horas, combinado con texto", () => {
    expect(ids(lista, { desde: "10:00" })).toEqual(["a", "c", "d"]);
    expect(ids(lista, { hasta: "09:30", texto: "000124" })).toEqual(["b"]);
  });
  it("una anulada no queda pendiente de factura", () => expect(pendienteFactura(lista[2])).toBe(false));
});
