// Imprime el tiquete de una venta guardada. Si falla, la venta ya está guardada: se reimprime después.
import type { ConfigApp } from "../../db/config";
import { obtenerNegocio } from "../../db/negocio";
import { obtenerVenta, registrarReimpresion } from "../../db/ventas";
import type { Actor } from "../../tipos";
import { ajustesImpresora } from "../impresion";
import { printRaw } from "../printerApi";
import { tiqueteVenta } from "./tiquete";

export async function imprimirVenta(
  actor: Actor,
  ventaId: string,
  config: ConfigApp,
  opc: { copia?: boolean; abrirGaveta?: boolean; verCliente?: boolean } = {},
): Promise<void> {
  if (!config.impresora_nombre) throw new Error("No hay impresora elegida. El técnico la elige en Técnico → Hardware");
  const v = await obtenerVenta(ventaId);
  if (!v) throw new Error("Venta no encontrada");
  const doc = tiqueteVenta(await obtenerNegocio(), v, ajustesImpresora(config), {
    copia: opc.copia,
    textoNoFactura: config.texto_no_factura,
    abrirGaveta: opc.abrirGaveta,
    mostrarIva: config.mostrar_iva,
    nombreCliente: opc.verCliente === false ? null : (v.cliente ?? v.nombreTiquete),
  });
  await printRaw(config.impresora_nombre, doc.bytes);
  if (opc.copia) await registrarReimpresion(actor, ventaId);
}
