// Pruebas basadas en propiedades (fast-check) de lo que la pantalla calcula antes de mandar a Rust:
// totales con descuentos y redondeo, y pago mixto con vuelto. Mismas propiedades que
// src-tauri/src/propiedades_tests.rs (si la pantalla y Rust no coinciden, el cajero ve un total y
// Rust cobra otro).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { calcularTotales } from "../src/lib/venta/calculo";
import { calcularPagos } from "../src/lib/venta/pagos";
import type { EstadoEspera, FormaPago, LineaEspera, PagoEntrada } from "../src/tipos";

const linea = fc.record({ p: fc.integer({ min: 0, max: 200_000 }), c: fc.integer({ min: 1, max: 50 }), pct: fc.integer({ min: 0, max: 100 }) }).map(
  ({ p, c, pct }): LineaEspera => ({ id: "x", productoId: null, codigo: null, descripcion: "A", departamentoId: "D", cantidad: c, precioUnitario: p, descuento: Math.floor((p * c * pct) / 100), tasaIva: 13, exento: false }),
);

describe("propiedades", () => {
  it("totales: nunca negativos, descuento dentro del subtotal, redondeo al paso más cercano", () => {
    fc.assert(
      fc.property(fc.array(linea, { maxLength: 15 }), fc.integer({ min: 0, max: 5_000_000 }), fc.constantFrom(1, 5, 10, 25, 50, 100), (lineas, desc, paso) => {
        const e: EstadoEspera = { lineas, descuentoTotal: desc, cliente: null, nombreTiquete: null, requiereFactura: false, autorizacion: null };
        const t = calcularTotales(e, paso);
        const neto = t.subtotal - t.descuento;
        expect(t.total).toBeGreaterThanOrEqual(0);
        expect(t.descuento).toBeGreaterThanOrEqual(0);
        expect(t.descuento).toBeLessThanOrEqual(Math.max(0, t.subtotal));
        expect(t.redondeo).toBe(t.total - neto);
        if (paso > 1) {
          expect(t.total % paso).toBe(0);
          expect(2 * Math.abs(t.redondeo)).toBeLessThanOrEqual(paso);
        } else expect(t.total).toBe(neto);
        expect(Number.isInteger(t.total)).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it("pago mixto: si se acepta cubre el total exacto; el vuelto sale solo del efectivo", () => {
    const formas = [
      { id: "EF", codigo: "EF", nombre: "Efectivo", tipo: "efectivo", requiereBanco: false, requiereReferencia: false, daVuelto: true, pideUltimos4: false, orden: 1, activo: true },
      { id: "TJ", codigo: "TJ", nombre: "Tarjeta", tipo: "tarjeta", requiereBanco: false, requiereReferencia: false, daVuelto: false, pideUltimos4: false, orden: 2, activo: true },
    ] as FormaPago[];
    const pago = (formaPagoId: string, monto: number) => ({ formaPagoId, monto, bancoId: null, referencia: null, ultimos4: null, pagador: null }) as PagoEntrada;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500_000 }), fc.array(fc.integer({ min: 1, max: 600_000 }), { maxLength: 3 }), fc.array(fc.integer({ min: 1, max: 600_000 }), { maxLength: 3 }), (total, ef, tj) => {
        const r = calcularPagos(total, [...tj.map((m) => pago("TJ", m)), ...ef.map((m) => pago("EF", m))], formas);
        const recibidoEf = ef.reduce((s, x) => s + x, 0);
        expect(r.vuelto).toBeGreaterThanOrEqual(0);
        if (r.ok) {
          expect(r.aplicados.reduce((s, a) => s + a.aplicado, 0)).toBe(total);
          expect(r.vuelto).toBeLessThanOrEqual(recibidoEf);
          for (const a of r.aplicados) {
            expect(a.vuelto ?? 0).toBeGreaterThanOrEqual(0);
            if (a.formaPagoId === "TJ") expect(a.vuelto ?? 0).toBe(0);
          }
        }
        if (tj.reduce((s, x) => s + x, 0) > total) expect(r.ok).toBe(false);
      }),
      { numRuns: 400 },
    );
  });
});
