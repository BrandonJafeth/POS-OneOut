// Pago mixto: varias formas en una venta. Reglas:
// - La suma tiene que cubrir el total.
// - Solo las formas que dan vuelto (efectivo) pueden pasarse; las demás, como mucho, el total.
// - El vuelto se descuenta del efectivo: lo "aplicado" a la venta es lo recibido menos el vuelto.
// - Banco, referencia y últimos 4 dígitos se piden según la configuración de cada forma.
import type { FormaPago, PagoEntrada } from "../../tipos";

export interface PagoAplicado extends PagoEntrada {
  /** Lo que cuenta para la venta (suma de aplicados = total). */
  aplicado: number;
  recibido: number | null;
  vuelto: number | null;
}

export interface ResultadoPagos {
  ok: boolean;
  pagado: number;
  faltante: number;
  vuelto: number;
  errores: string[];
  aplicados: PagoAplicado[];
}

export function calcularPagos(total: number, pagos: PagoEntrada[], formas: FormaPago[]): ResultadoPagos {
  const errores: string[] = [];
  const porId = new Map(formas.map((f) => [f.id, f]));
  let sinVuelto = 0;
  for (const p of pagos) {
    const f = porId.get(p.formaPagoId);
    if (!f || !f.activo) {
      errores.push("Forma de pago no disponible");
      continue;
    }
    if (!Number.isSafeInteger(p.monto) || p.monto <= 0) errores.push(`${f.nombre}: monto inválido`);
    if (f.requiereBanco && !p.bancoId) errores.push(`${f.nombre}: elija el banco`);
    if (f.requiereReferencia && !p.referencia?.trim()) errores.push(`${f.nombre}: escriba la referencia`);
    // Igual que calculo::validar_pagador: SINPE Móvil pide el nombre de quien paga; otra forma no lo lleva.
    const pagador = (p.pagador ?? "").trim().replace(/\s+/g, " ");
    if (f.tipo === "sinpe" && !pagador) errores.push(`${f.nombre}: escriba el nombre de quien paga`);
    else if (f.tipo === "sinpe" && ([...pagador].length < 2 || [...pagador].length > 60)) errores.push(`${f.nombre}: el nombre de quien paga debe tener de 2 a 60 letras`);
    else if (f.tipo !== "sinpe" && pagador) errores.push(`${f.nombre}: esta forma de pago no lleva nombre de quien paga`);
    // Igual que calculo.rs: últimos 4 en una forma que no los pide también se rechaza.
    if (p.ultimos4 && !(f.pideUltimos4 && /^\d{4}$/.test(p.ultimos4))) errores.push(`${f.nombre}: los últimos 4 dígitos son 4 números`);
    if (!f.daVuelto) sinVuelto += p.monto;
  }
  // Igual que calculo.rs: una venta de ¢0 no recibe dinero (abriría la gaveta sin venta real).
  if (total === 0 && pagos.some((p) => p.monto > 0)) errores.push("La venta es de ¢0: no reciba dinero. Borre el monto del pago");
  else if (sinVuelto >= total && pagos.some((p) => p.monto > 0 && porId.get(p.formaPagoId)?.daVuelto)) errores.push("La tarjeta, SINPE o transferencia ya pagan todo: quite el efectivo");
  if (sinVuelto > total) errores.push("Tarjeta, SINPE y transferencia no dan vuelto: no pueden pasar del total");

  const pagado = pagos.reduce((s, p) => s + (Number.isFinite(p.monto) ? p.monto : 0), 0);
  const faltante = Math.max(0, total - pagado);
  const vuelto = Math.max(0, pagado - total);

  // El vuelto sale del efectivo, empezando por el último pago en efectivo.
  let porRepartir = vuelto;
  const aplicados: PagoAplicado[] = pagos.map((p) => ({ ...p, aplicado: p.monto, recibido: null, vuelto: null }));
  for (let i = aplicados.length - 1; i >= 0; i--) {
    const a = aplicados[i];
    if (!porId.get(a.formaPagoId)?.daVuelto) continue;
    const v = Math.min(porRepartir, a.monto);
    a.recibido = a.monto;
    a.vuelto = v;
    a.aplicado = a.monto - v;
    porRepartir -= v;
  }
  if (porRepartir > 0 && !errores.length) errores.push("El vuelto solo puede salir del efectivo");

  // Un efectivo que se fue entero en vuelto no se guarda como pago.
  return { ok: errores.length === 0 && faltante === 0, pagado, faltante, vuelto, errores, aplicados: aplicados.filter((a) => a.aplicado > 0) };
}

/** Denominaciones rápidas útiles para un total: solo las que lo cubren, más "exacto". */
export function sugerenciasEfectivo(falta: number, denominaciones: number[]): number[] {
  const out = new Set<number>([falta]);
  for (const d of [...denominaciones].sort((a, b) => a - b)) {
    if (d >= falta) out.add(d);
    // Redondeos hacia arriba al siguiente múltiplo (p. ej. faltan 3.250 → 4.000, 5.000).
    const m = Math.ceil(falta / d) * d;
    if (m > falta && m <= falta + d) out.add(m);
  }
  return [...out].sort((a, b) => a - b).slice(0, 6);
}
