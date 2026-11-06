// Búsqueda en «Ventas del día». Cada criterio se evalúa por separado y una venta se muestra si
// cumple todos: el orden no importa y agregar un criterio no toca los demás.
import type { VentaResumen } from "../../db/ventas";
import { normalizar } from "../texto";

export interface Criterios {
  texto: string;
  /** "HH:MM" o vacío. */
  desde: string;
  hasta: string;
  /** "todas" | "factura" | "anuladas" | "forma:<nombre>" */
  filtro: string;
}

export const pendienteFactura = (v: VentaResumen) => v.requiereFactura && !v.facturaEmitida && v.estado !== "anulada";

export const formasDe = (v: VentaResumen) => v.formas.split(" + ").filter(Boolean);

export const horaDe = (iso: string) => new Date(iso).toLocaleTimeString("es-CR", { hour: "2-digit", minute: "2-digit", hour12: false });

export function cumpleFiltro(v: VentaResumen, filtro: string): boolean {
  if (filtro === "factura") return pendienteFactura(v);
  if (filtro === "anuladas") return v.estado === "anulada";
  if (filtro.startsWith("forma:")) return formasDe(v).includes(filtro.slice(6));
  return true;
}

export function enHorario(v: VentaResumen, desde: string, hasta: string): boolean {
  const h = horaDe(v.fecha);
  return (!desde || h >= desde) && (!hasta || h <= hasta);
}

export function coincideTexto(v: VentaResumen, texto: string): boolean {
  const q = normalizar(texto);
  if (!q) return true;
  // Monto: "3500" o "3.500" encuentran ¢3.500 (y ¢13.500); el número de tiquete también.
  const cifras = texto.replace(/\D/g, "");
  const soloCifras = cifras !== "" && cifras.length === texto.replace(/[\s.¢₡]/g, "").length;
  if (soloCifras && (String(v.total).includes(cifras) || v.numero.includes(cifras))) return true;
  return normalizar(`${v.numero} ${v.productos} ${v.cajero} ${v.formas}`).includes(q);
}

export function buscarVentas(lista: VentaResumen[], c: Criterios): VentaResumen[] {
  return lista.filter((v) => cumpleFiltro(v, c.filtro) && enHorario(v, c.desde, c.hasta) && coincideTexto(v, c.texto));
}
