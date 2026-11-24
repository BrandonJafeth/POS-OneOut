// Permisos en la pantalla: SOLO para mostrar u ocultar. Quien decide es Rust (politica.rs). La
// política efectiva del usuario de la sesión llega de `sesion_permisos` (acción → política) y se
// vuelve a pedir cuando cambia la configuración (evento «seguridad-cambiada»).
import type { Politica } from "../generados/Politica";
import type { Rol } from "../tipos";

/** Id de una acción del catálogo (src-tauri/src/acciones.rs). La prueba espejo revisa que existan. */
export type Accion = string;
/** Compatibilidad con el nombre viejo. */
export type Permiso = Accion;

let actuales: Record<string, Politica | undefined> = {};
let motivos: string[] = [];
let umbral = 3;

/** La app guarda aquí lo que respondió Rust para el usuario de la sesión. */
export function establecerPermisos(p: Record<string, Politica | undefined>, motivosAnulacion: string[] = [], umbralAnulaciones = 3) {
  actuales = p;
  motivos = motivosAnulacion;
  umbral = umbralAnulaciones;
}

/** Más anulaciones sin PIN que esto en un día: el día se marca en Cierres de caja. */
export function umbralAnulaciones(): number {
  return umbral;
}

/** Motivos de anulación de la lista configurable (opción C del cajero). */
export function motivosAnulacion(): string[] {
  return motivos;
}

export function politicaDe(accion: Accion): Politica | undefined {
  return actuales[accion];
}

/** ¿Se muestra? `rol` queda por compatibilidad: la política ya es la del usuario de la sesión. */
export function puede(_rol: Rol | undefined, accion: Accion): boolean {
  return estado(politicaDe(accion)) !== "oculto";
}

/** Cómo se muestra una acción: oculta, libre, con motivo o con PIN del dueño. */
export function estado(p: Politica | undefined): "oculto" | "libre" | "motivo" | "pin" {
  if (!p || p.nivel === "no") return "oculto";
  if (p.nivel === "pin") return "pin";
  if (p.nivel === "motivo" || p.motivo) return "motivo";
  return "libre";
}

/** Tope de descuento (igual que ventas::tope_descuento en Rust: prueba espejo). */
export function topeDescuento(p: Politica | undefined): { pct: number; bloquear: boolean } {
  if (!p || p.nivel === "no") return { pct: 0, bloquear: true };
  if (p.nivel === "pin") return { pct: 0, bloquear: false };
  return { pct: p.limites.pctMax ?? 100, bloquear: p.limites.alPasar === "bloquear" };
}

/** Roles que `rol` puede crear o administrar (además de cambiar su propio PIN). Regla fija. */
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
