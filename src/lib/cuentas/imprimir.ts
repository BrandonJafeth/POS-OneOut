// Imprime un comprobante de apartado o abono y abre la gaveta si el abono fue en efectivo.
// Lo guardado ya está guardado: si la impresora falla, se reimprime desde Apartados (COPIA).
import { CONFIG_DEFECTO, type ConfigApp } from "../../db/config";
import { imprimirCuenta, obtenerCuenta } from "../../db/cuentas";
import { ajustesPara } from "../../db/impresoras";
import { obtenerNegocio } from "../../db/negocio";
import { invocar } from "../invocar";
import { comprobanteCuenta, type OpcionesComprobante } from "./comprobante";

export async function imprimirComprobante(cuentaId: string, config: ConfigApp, o: Omit<OpcionesComprobante, "textoNoFactura" | "avisoPrivacidad">): Promise<void> {
  const [ajustes, d, n] = await Promise.all([ajustesPara("tiquete"), obtenerCuenta(cuentaId), obtenerNegocio()]);
  const doc = comprobanteCuenta(n, d, ajustes, {
    ...o,
    avisoPrivacidad: config.aviso_privacidad_en_tiquete,
    textoNoFactura: config.texto_no_factura?.trim() || CONFIG_DEFECTO.texto_no_factura,
  });
  await imprimirCuenta(cuentaId, doc.bytes);
}

/** Abre la gaveta por un abono con efectivo (Rust: una sola vez por operación). */
export async function abrirGavetaAbono(operacionId: string): Promise<void> {
  await invocar("gaveta_abono", { operacionId });
}
