import { describe, expect, it } from "vitest";
import { describir } from "../src/lib/bitacoraTexto";
import type { EntradaBitacora } from "../src/tipos";

const entrada = (accion: string, detalle: unknown, entidadId: string | null = null) =>
  ({ id: "1", fecha: "2026-11-11T15:00:00.000Z", usuario: "Ana", accion, entidad: "x", entidadId, detalle }) as EntradaBitacora;

describe("bitácora en palabras", () => {
  it("dice qué pasó con montos, motivo y quién autorizó, sin códigos", () => {
    const f = describir(entrada("venta.anular", { numero: "A-102", total: 4500, motivo: "Cliente devolvió", autorizadoPor: "U1" }), { U1: "Ana" });
    expect(f.texto).toBe("Anuló el tiquete A-102 de ¢4.500. Motivo: «Cliente devolvió» (autorizó Ana con su PIN).");
    expect(f).toMatchObject({ grupo: "ventas", importante: true });
  });

  it("el cierre dice si cuadró o cuánto faltó, y marca la diferencia para revisar", () => {
    expect(describir(entrada("caja.cerrar", { ventas: 3, total: 9000, esperado: 19000, contado: 19000, diferencia: 0 })).importante).toBe(false);
    const falta = describir(entrada("caja.cerrar", { ventas: 3, total: 9000, esperado: 19000, contado: 18000, diferencia: -1000 }));
    expect(falta.texto).toContain("Faltaron ¢1.000");
    expect(falta.importante).toBe(true);
  });

  it("una acción nueva o un detalle raro no rompe la pantalla", () => {
    expect(describir(entrada("algo.nuevo", null)).texto).toContain("algo.nuevo");
    expect(() => describir(entrada("caja.salida", "texto"))).not.toThrow();
    // Autorizó alguien que ya no está en la lista: no inventa un nombre.
    expect(describir(entrada("caja.salida", { monto: 30000, categoria: "Pago a proveedor", autorizadoPor: "X" })).texto).toContain("autorizó el dueño");
  });
});
