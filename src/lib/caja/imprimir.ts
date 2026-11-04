// Impresión del reporte Z, del corte y del comprobante de movimiento, cada uno en la impresora
// asignada a su documento (Administración → Impresoras). Rust revisa cada byte antes de imprimir.
import { datosReporteZ, imprimirReporteZ, type Corte, type Movimiento } from "../../db/caja";
import { ajustesPara, imprimirDocumento } from "../../db/impresoras";
import { obtenerNegocio } from "../../db/negocio";
import { comprobanteMovimiento, documentosCierre, reporteCorte, type OpcionesZ } from "./reporteZ";

/**
 * Imprime el Z y, si se eligió, un tiquete por departamento. La primera vez sale el original; las
 * siguientes, "COPIA" con el PIN del dueño. Devuelve si fue copia.
 */
export async function imprimirZ(turnoId: string, opciones: Omit<OpcionesZ, "copia">, pin?: string): Promise<boolean> {
  const ajustes = await ajustesPara("cierre");
  const { detalle, copia } = await datosReporteZ(turnoId);
  const docs = documentosCierre(await obtenerNegocio(), detalle, ajustes, { ...opciones, copia });
  return imprimirReporteZ(turnoId, docs.map((d) => d.bytes), pin);
}

export async function imprimirCorte(k: Corte): Promise<void> {
  const ajustes = await ajustesPara("cierre");
  await imprimirDocumento("cierre", reporteCorte(await obtenerNegocio(), k, ajustes).bytes);
}

export async function imprimirMovimiento(m: Movimiento): Promise<void> {
  const ajustes = await ajustesPara("movimiento");
  await imprimirDocumento("movimiento", comprobanteMovimiento(await obtenerNegocio(), m, ajustes).bytes);
}
