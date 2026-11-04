// Impresoras configurables y a cuál va cada documento. Todo lo decide Rust (src-tauri/src/impresoras.rs):
// la pantalla solo elige de lo que detecta el sistema, y lo que se imprime pasa por la lista blanca
// ESC/POS (ningún trabajo de impresión puede abrir la gaveta).
import { invocar } from "../lib/invocar";
import type { TicketSettings } from "../lib/tickets";

export type Conexion = "windows" | "serial" | "usb";
export type Documento = "tiquete" | "cierre" | "movimiento" | "etiqueta";

export const DOCUMENTOS: { id: Documento; nombre: string; detalle: string }[] = [
  { id: "tiquete", nombre: "Tiquete de venta", detalle: "Tiquetes, facturas y copias" },
  { id: "cierre", nombre: "Cierre y reportes", detalle: "Cierre Z, cortes y tiquetes por departamento" },
  { id: "movimiento", nombre: "Comprobantes de movimiento", detalle: "Entradas y salidas de efectivo" },
  { id: "etiqueta", nombre: "Etiquetas", detalle: "Etiquetas con código de barras" },
];

export const NOMBRE_CONEXION: Record<Conexion, string> = { windows: "Impresora de Windows", serial: "Puerto serial (COM)", usb: "USB directo" };

export interface Impresora {
  id: string;
  nombre: string;
  conexion: Conexion;
  destino: string;
  anchoMm: 58 | 80;
  columnas: number;
  codePage: number;
  sinModoChino: boolean;
  barras: "A" | "B";
  cortador: boolean;
  gaveta: boolean;
  baudios: number;
  documentos: Documento[];
}

export type DatosImpresora = Omit<Impresora, "id" | "documentos"> & { id?: string };

export interface Detectadas {
  windows: string[];
  serial: string[];
  usb: { ruta: string; nombre: string }[];
  avisos: string[];
}

/** Lo que necesita la pantalla para armar un documento con el formato de su impresora. */
export interface AjustesImpresora {
  impresoraId: string;
  nombre: string;
  anchoMm: number;
  columnas: number;
  codePage: number;
  sinModoChino: boolean;
  barras: "A" | "B";
  cortador: boolean;
}

export function aSettings(a: Pick<AjustesImpresora, "codePage" | "sinModoChino" | "barras" | "cortador" | "columnas">): TicketSettings {
  return { codePage: a.codePage, sinModoChino: a.sinModoChino, barras: a.barras === "A" ? "A" : "B", cortador: a.cortador, columnas: a.columnas };
}

export const NOMBRE_DOCUMENTO: Record<Documento, string> = {
  tiquete: "tiquetes de venta",
  cierre: "cierres y reportes",
  movimiento: "comprobantes de movimiento",
  etiqueta: "etiquetas",
};

export function listarImpresoras(): Promise<Impresora[]> {
  return invocar<Impresora[]>("impresoras_listar");
}

export function detectarImpresoras(): Promise<Detectadas> {
  return invocar<Detectadas>("impresoras_detectar");
}

export function guardarImpresora(datos: DatosImpresora): Promise<string> {
  return invocar<string>("impresora_guardar", { datos: { ...datos, id: datos.id ?? null } });
}

export async function eliminarImpresora(id: string): Promise<void> {
  await invocar("impresora_eliminar", { id });
}

export async function asignarImpresora(documento: Documento, impresoraId: string | null): Promise<void> {
  await invocar("impresora_asignar", { documento, impresoraId });
}

export async function probarImpresora(id: string, bytes: Uint8Array): Promise<void> {
  await invocar("impresora_probar", { id, data: Array.from(bytes) });
}

/** Ajustes de la impresora asignada a un documento; null si no hay ninguna. */
export function ajustesDe(documento: Documento): Promise<AjustesImpresora | null> {
  return invocar<AjustesImpresora | null>("impresora_ajustes", { documento });
}

/** Igual, pero con un mensaje claro si no hay impresora asignada. */
export async function ajustesPara(documento: Documento): Promise<TicketSettings & { impresora: string }> {
  const a = await ajustesDe(documento);
  if (!a) throw new Error(`No hay impresora para ${NOMBRE_DOCUMENTO[documento]}. El dueño o el técnico la asigna en Administración → Impresoras.`);
  return { ...aSettings(a), impresora: a.nombre };
}

/** Comprobantes de movimiento, etiquetas y cortes. Devuelve el nombre de la impresora. */
export function imprimirDocumento(documento: Exclude<Documento, "tiquete">, bytes: Uint8Array): Promise<string> {
  return invocar<string>("imprimir", { documento, data: Array.from(bytes) });
}
