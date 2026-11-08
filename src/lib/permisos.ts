// Qué puede hacer cada rol. Hoy es fijo en código; más adelante "Permisos por rol" en
// Configuración técnica podrá sobrescribirlo desde config.
import type { Rol } from "../tipos";

export type Permiso =
  | "venta"
  | "caja" // abrir, entradas/salidas, cerrar y ver su propio turno
  | "caja.admin" // todos los turnos, reabrir, revisar diferencias, umbrales de caja
  | "productos" // ver, crear y editar productos y sus códigos
  | "productos.importar"
  | "departamentos" // nombre, orden, activo
  | "departamentos.estructura" // crear y cambiar códigos
  | "usuarios"
  | "negocio" // teléfono, correo, encabezado extra, pie
  | "negocio.legal" // nombre, razón social, cédula, régimen, dirección, logo
  | "config.tecnica"
  | "reportes"
  | "clientes.basico" // buscar/crear cliente en la venta: solo nombre, teléfono y cédula
  | "clientes" // lista completa, datos del cliente, exportar, anonimizar
  | "respaldo" // el respaldo lleva datos de clientes
  | "facturas" // pendientes de factura electrónica (muestra datos del cliente)
  | "impresoras" // impresoras, a cuál va cada documento y la gaveta
  | "inventario"; // existencias, entradas, ajustes, conteos, proveedores y costos (solo el dueño)

// Copia de src-tauri/src/permisos.rs: Rust es quien decide; aquí solo se usa para mostrar u ocultar.
// Ley 8968: el técnico administra el sistema pero NO ve datos de clientes (ni el respaldo).
// Y no maneja dinero: no vende ni toca la caja.
export const PERMISOS: Record<Rol, readonly Permiso[]> = {
  cajero: ["venta", "caja", "clientes.basico", "facturas"],
  dueno: [
    "venta",
    "caja",
    "caja.admin",
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
    "impresoras",
    "inventario",
  ],
  tecnico: [
    "productos",
    "productos.importar",
    "departamentos",
    "departamentos.estructura",
    "usuarios",
    "negocio",
    "negocio.legal",
    "config.tecnica",
    "reportes",
    "impresoras",
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
