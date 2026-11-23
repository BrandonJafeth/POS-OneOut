// Lo que se imprime después de cobrar: el tiquete de la venta y, si quedó a crédito, además el
// comprobante de la cuenta (C-0001: total, pagado, saldo, fecha límite, condiciones y firma).
// La venta ya quedó guardada: un fallo de impresión se avisa y se reimprime después.
import type { ResultadoCobro } from "../../db/ventas";

export interface Impresoras {
  venta(ventaId: string): Promise<void>;
  comprobanteCredito(cuentaId: string): Promise<void>;
}

/** Imprime todo lo del cobro. Devuelve el primer error (texto) o undefined. */
export async function imprimirTrasCobro(r: Pick<ResultadoCobro, "ventaId" | "cuentaId">, imp: Impresoras): Promise<string | undefined> {
  let error: string | undefined;
  const intentar = async (f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      error ??= e instanceof Error ? e.message : String(e);
    }
  };
  await intentar(() => imp.venta(r.ventaId));
  if (r.cuentaId) await intentar(() => imp.comprobanteCredito(r.cuentaId!));
  return error;
}
