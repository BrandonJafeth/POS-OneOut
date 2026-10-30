// Qué puede hacer cada rol. Hoy es fijo en código; más adelante "Permisos por rol" en
// Configuración técnica podrá sobrescribirlo desde config.
import type { Rol } from "../tipos";

export type Permiso =
  | "venta"
  | "productos" // ver, crear y editar productos y sus códigos
  | "productos.importar"
  | "departamentos" // nombre, orden, activo
  | "departamentos.estructura" // crear y cambiar códigos
  | "usuarios"
  | "negocio" // teléfono, correo, encabezado extra, pie
  | "negocio.legal" // nombre, razón social, cédula, régimen, dirección, logo
  | "config.tecnica"
  | "reportes"
  | "clientes.basico" // buscar/crear cliente para un apartado: solo nombre y teléfono
  | "clientes" // lista completa, datos del cliente, exportar, anonimizar
  | "respaldo" // el respaldo lleva datos de clientes
  | "facturas" // pendientes de factura electrónica (muestra datos del cliente)
  | "dia.cerrar";

// Ley 8968: el técnico administra el sistema pero NO tiene acceso a datos de clientes
// (ni al respaldo, que los contiene).
export const PERMISOS: Record<Rol, readonly Permiso[]> = {
  cajero: ["venta", "clientes.basico", "facturas"],
  dueno: [
    "venta",
    "productos",
    "productos.importar",
    "departamentos",
    "usuarios",
    "negocio",
    "reportes",
    "clientes.basico",
    "clientes",
    "respaldo",
    "facturas",
    "dia.cerrar",
  ],
  tecnico: [
    "venta",
    "productos",
    "productos.importar",
    "departamentos",
    "departamentos.estructura",
    "usuarios",
    "negocio",
    "negocio.legal",
    "config.tecnica",
    "reportes",
    "dia.cerrar",
  ],
};

export function puede(rol: Rol, permiso: Permiso): boolean {
  return PERMISOS[rol].includes(permiso);
}

/** Roles que `rol` puede crear o administrar (además de cambiar su propio PIN). */
export function rolesAdministrables(rol: Rol): Rol[] {
  if (rol === "tecnico") return ["dueno", "cajero"];
  if (rol === "dueno") return ["cajero"];
  return [];
}

export class SinPermiso extends Error {
  constructor(que = "hacer esto") {
    super(`No tiene permiso para ${que}`);
  }
}
