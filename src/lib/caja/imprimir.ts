// Impresión del reporte Z y del comprobante de movimiento.
import { datosReporteZ, type Movimiento } from "../../db/caja";
import type { ConfigApp } from "../../db/config";
import { obtenerNegocio } from "../../db/negocio";
import { ajustesImpresora } from "../impresion";
import { printRaw } from "../printerApi";
import { comprobanteMovimiento, reporteZ } from "./reporteZ";

function impresora(config: ConfigApp): string {
  if (!config.impresora_nombre) throw new Error("No hay impresora elegida. El técnico la elige en Técnico → Hardware");
  return config.impresora_nombre;
}

/** La primera vez sale el original; las siguientes, "COPIA" (Rust cuenta las impresiones). */
export async function imprimirZ(turnoId: string, config: ConfigApp): Promise<void> {
  const nombre = impresora(config);
  const { detalle, copia } = await datosReporteZ(turnoId);
  await printRaw(nombre, reporteZ(await obtenerNegocio(), detalle, ajustesImpresora(config), { copia }).bytes);
}

export async function imprimirMovimiento(m: Movimiento, config: ConfigApp): Promise<void> {
  const nombre = impresora(config);
  await printRaw(nombre, comprobanteMovimiento(await obtenerNegocio(), m, ajustesImpresora(config)).bytes);
}
