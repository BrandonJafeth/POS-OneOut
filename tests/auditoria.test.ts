// Auditoría 0.9.4: lo que la pantalla decide antes de mandar a Rust (Rust vuelve a revisar todo).
import { describe, expect, it } from "vitest";
import { busquedaValida } from "../src/lib/cuentas/busqueda";
import { estadoVacio, huellaDescuento } from "../src/lib/venta/calculo";
import type { EstadoEspera, LineaEspera } from "../src/tipos";

describe("F10 (D3): número, teléfono o al menos 3 letras", () => {
  it("igual que cuentas::buscar", () => {
    for (const q of ["", "  ", "ab", "%", "1-0", "1-0987", "_"]) expect(busquedaValida(q), q).toBe(false);
    for (const q of ["12", "A12", "A-12", "C7", "8765-4321", "+506 8765 4321", "Mar", "maría"]) expect(busquedaValida(q), q).toBe(true);
  });
});

describe("autorización de descuento (D5): atada al contenido", () => {
  const linea = (cantidad: number, descuento: number): LineaEspera => ({ id: "L1", productoId: "P", codigo: null, descripcion: "A", departamentoId: "D", cantidad, precioUnitario: 2000, descuento, tasaIva: 13, exento: false });
  const e = (l: LineaEspera[], extra: Partial<EstadoEspera> = {}): EstadoEspera => ({ ...estadoVacio(), lineas: l, ...extra });
  it("cambia si cambia una línea, una cantidad, un descuento o se agrega algo", () => {
    const base = huellaDescuento(e([linea(1, 1000)]));
    expect(huellaDescuento(e([linea(2, 1000)]))).not.toBe(base);
    expect(huellaDescuento(e([linea(1, 900)]))).not.toBe(base);
    expect(huellaDescuento(e([linea(1, 1000), { ...linea(1, 0), id: "L2" }]))).not.toBe(base);
    expect(huellaDescuento(e([linea(1, 1000)], { descuentoTotal: 10 }))).not.toBe(base);
  });
  it("no cambia por el cliente, el nombre del tiquete ni la autorización misma", () => {
    const base = huellaDescuento(e([linea(1, 1000)]));
    expect(huellaDescuento(e([linea(1, 1000)], { nombreTiquete: "Ana", autorizacion: { duenoId: "d", pct: 50, token: "t" } }))).toBe(base);
  });
});
