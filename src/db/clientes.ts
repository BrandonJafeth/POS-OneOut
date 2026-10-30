// Clientes (Ley 8968). Las reglas las aplica Rust (src-tauri/src/clientes.rs):
// - Sin consentimiento no se guarda. Obligatorios solo nombre y teléfono (o cédula).
// - El cajero ve nombre, teléfono y cédula; todo lo demás es del dueño. El técnico no entra.
// - No hay borrado: se ANONIMIZA (el id queda para que el historial cuadre).
// - La bitácora guarda ids, acciones y nombres de campos, NUNCA los datos personales.
import type { Actor, Cliente, ClienteBasico, TipoIdentificacion } from "../tipos";
import { invocar } from "../lib/invocar";

export const NOMBRE_ANONIMO = "Cliente anonimizado";
export const ADVERTENCIA_NOTAS = "No anote datos de salud, económicos ni sensibles";

export type MotivoAnonimizacion = "solicitud_titular" | "retencion" | "otro";
export const MOTIVOS_ANONIMIZACION: Record<MotivoAnonimizacion, string> = {
  solicitud_titular: "Lo pidió el cliente",
  retencion: "Plazo de retención vencido",
  otro: "Otro motivo",
};

export interface DatosCliente {
  nombre: string;
  telefono: string;
  tipoIdentificacion?: TipoIdentificacion | null;
  cedula?: string | null;
  correo?: string | null;
  notas?: string | null;
}

/** `consentimiento`: casilla "El cliente fue informado y acepta"; `versionAviso`: la que se le mostró. */
export function crearCliente(_actor: Actor, datos: DatosCliente, consentimiento: boolean, versionAviso: string): Promise<ClienteBasico> {
  return invocar<ClienteBasico>("cliente_crear", { datos, consentimiento, versionAviso });
}

/** Para la venta: solo nombre, teléfono y cédula, buscando por nombre, teléfono o cédula. */
export function buscarClientesBasico(_actor: Actor, texto: string, limite = 15): Promise<ClienteBasico[]> {
  return invocar<ClienteBasico[]>("cliente_buscar", { texto, limite });
}

export function clienteBasico(_actor: Actor, id: string): Promise<ClienteBasico | null> {
  return invocar<ClienteBasico | null>("cliente_basico", { id });
}

export type CampoFactura = "nombre" | "cedula" | "correo";

/** Un dato para pegar en el facturador externo. La bitácora anota QUÉ campo, nunca el valor. */
export function datoParaFactura(_actor: Actor, clienteId: string, campo: CampoFactura): Promise<string | null> {
  return invocar<string | null>("cliente_dato_factura", { id: clienteId, campo });
}

export function tieneCorreo(clienteId: string): Promise<boolean> {
  return invocar<boolean>("cliente_tiene_correo", { id: clienteId });
}

/** Lista completa (dueño). Cada consulta queda en bitácora, sin el texto buscado. */
export function listarClientes(_actor: Actor, opc: { texto?: string; incluirAnonimizados?: boolean } = {}): Promise<Cliente[]> {
  return invocar<Cliente[]>("cliente_listar", { texto: opc.texto ?? null, incluirAnonimizados: opc.incluirAnonimizados ?? false });
}

/** Todos los datos de un cliente (derecho de acceso). Queda en bitácora. */
export function obtenerCliente(_actor: Actor, id: string): Promise<Cliente | null> {
  return invocar<Cliente | null>("cliente_obtener", { id });
}

/** Rectificación (dueño). En bitácora van solo los NOMBRES de los campos cambiados. */
export async function editarCliente(_actor: Actor, id: string, datos: DatosCliente): Promise<void> {
  await invocar("cliente_editar", { id, datos });
}

export interface CuentaResumen {
  id: string;
  tipo: string;
  fecha: string;
  total: number;
  saldo: number;
  estado: string;
}

/** Apartados o créditos abiertos con saldo: mientras existan, no se puede anonimizar. */
export function cuentasConSaldo(id: string): Promise<CuentaResumen[]> {
  return invocar<CuentaResumen[]>("cliente_cuentas_saldo", { id });
}

export interface ExportacionCliente {
  cliente: Cliente;
  cuentas: CuentaResumen[];
  ventas: { numero: string; fecha: string; total: number }[];
}

/** "Exportar mis datos" (derecho de acceso). Queda en bitácora con el formato. */
export function datosParaExportar(_actor: Actor, id: string, formato: "csv" | "pdf"): Promise<ExportacionCliente> {
  return invocar<ExportacionCliente>("cliente_exportar", { id, formato });
}

/** Solo el dueño, con su PIN en el momento y un motivo. */
export async function anonimizarCliente(_actor: Actor, id: string, pin: string, motivo: MotivoAnonimizacion): Promise<void> {
  await invocar("cliente_anonimizar", { id, pin, motivo });
}

/** Clientes sin movimientos en el plazo de retención (config retencion_clientes_meses). Solo sugiere. */
export function sugerenciasRetencion(_actor: Actor, _meses?: number): Promise<ClienteBasico[]> {
  return invocar<ClienteBasico[]>("cliente_retencion");
}
