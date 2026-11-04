// Imprime el tiquete de una venta guardada en la impresora de tiquetes. Si falla, la venta ya está
// guardada: se reimprime después. El original sale una vez; las demás, como COPIA (Rust lo revisa).
import type { ConfigApp } from "../../db/config";
import { ajustesPara } from "../../db/impresoras";
import { obtenerNegocio } from "../../db/negocio";
import { obtenerVenta } from "../../db/ventas";
import { invocar } from "../invocar";
import { tiqueteVenta } from "./tiquete";

export async function imprimirVenta(ventaId: string, config: ConfigApp, opc: { copia?: boolean; verCliente?: boolean } = {}): Promise<void> {
  const ajustes = await ajustesPara("tiquete");
  const v = await obtenerVenta(ventaId);
  if (!v) throw new Error("Venta no encontrada");
  const doc = tiqueteVenta(await obtenerNegocio(), v, ajustes, {
    copia: opc.copia,
    textoNoFactura: config.texto_no_factura,
    mostrarIva: config.mostrar_iva,
    nombreCliente: opc.verCliente === false ? null : (v.cliente ?? v.nombreTiquete),
  });
  await invocar("venta_imprimir", { ventaId, data: Array.from(doc.bytes) });
}

/** Abre la gaveta por una venta con efectivo (Rust: una sola vez por venta). */
export async function abrirGavetaVenta(ventaId: string): Promise<void> {
  await invocar("gaveta_venta", { ventaId });
}
