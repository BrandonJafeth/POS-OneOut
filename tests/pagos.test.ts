import { describe, expect, it } from "vitest";
import { calcularPagos } from "../src/lib/venta/pagos";
import type { FormaPago } from "../src/tipos";

const forma = (x: Partial<FormaPago>) => ({ activo: true, requiereBanco: false, requiereReferencia: false, daVuelto: false, pideUltimos4: false, ...x }) as FormaPago;
const formas = [forma({ id: "EF", nombre: "Efectivo", daVuelto: true }), forma({ id: "TJ", nombre: "Tarjeta", pideUltimos4: true })];
const pago = (formaPagoId: string, monto: number, ultimos4?: string) => ({ formaPagoId, monto, bancoId: null, referencia: null, ultimos4 });

// Mismas reglas que calculo::pagos en Rust: lo que la pantalla acepta, el cobro no lo rechaza.
describe("calcularPagos", () => {
  it("pago mixto: el vuelto sale del efectivo", () => {
    const r = calcularPagos(8000, [pago("TJ", 3000), pago("EF", 10000)], formas);
    expect(r.ok).toBe(true);
    expect(r.vuelto).toBe(5000);
    expect(r.aplicados[1]).toMatchObject({ aplicado: 5000, recibido: 10000, vuelto: 5000 });
  });
  it("tarjeta no pasa del total", () => expect(calcularPagos(8000, [pago("TJ", 9000)], formas).ok).toBe(false));
  it("venta de ¢0: sin pagos sí, con dinero no (abriría la gaveta)", () => {
    expect(calcularPagos(0, [], formas).ok).toBe(true);
    expect(calcularPagos(0, [pago("EF", 1000)], formas).errores.join()).toMatch(/¢0/);
    expect(calcularPagos(500, [pago("TJ", 500), pago("EF", 1000)], formas).errores.join()).toMatch(/quite el efectivo/);
  });
  it("últimos 4 solo en la forma que los pide", () => {
    expect(calcularPagos(500, [pago("TJ", 500, "1234")], formas).ok).toBe(true);
    expect(calcularPagos(500, [pago("TJ", 500, "12")], formas).ok).toBe(false);
    expect(calcularPagos(500, [pago("EF", 500, "1234")], formas).ok).toBe(false);
  });
});

describe("SINPE Móvil: nombre de quien paga, banco y referencia", () => {
  const sp = forma({ id: "SP", nombre: "SINPE Móvil", tipo: "sinpe", requiereBanco: true, requiereReferencia: true });
  const fs = [...formas, sp];
  const sinpe = (x: { pagador?: string; bancoId?: string | null; referencia?: string | null } = {}) => ({ ...pago("SP", 500), bancoId: "BN", referencia: "123", pagador: "Ana Mora", ...x });
  it("los tres obligatorios; el nombre no va en otra forma", () => {
    expect(calcularPagos(500, [sinpe()], fs).ok).toBe(true);
    expect(calcularPagos(500, [sinpe({ pagador: "  " })], fs).errores.join()).toMatch(/nombre de quien paga/);
    expect(calcularPagos(500, [sinpe({ pagador: "A" })], fs).errores.join()).toMatch(/2 a 60/);
    expect(calcularPagos(500, [sinpe({ bancoId: null })], fs).errores.join()).toMatch(/banco/);
    expect(calcularPagos(500, [sinpe({ referencia: "" })], fs).errores.join()).toMatch(/referencia/);
    expect(calcularPagos(500, [{ ...pago("TJ", 500), pagador: "Ana" }], fs).errores.join()).toMatch(/no lleva nombre/);
  });
});
