// Permisos configurables y bloqueo por inactividad (DISENO-PERMISOS.md). Rust decide todo; aquí
// solo se piden datos y se mandan los cambios.
import { invocar } from "../lib/invocar";
import type { Datos } from "../generados/Datos";
import type { Inactividad } from "../generados/Inactividad";
import type { Politica } from "../generados/Politica";

export type { Datos, Inactividad, Politica };

export interface AccionInfo {
  id: string;
  area: string;
  nombre: string;
  sensible: boolean;
  protegida: boolean;
  noDelegable: boolean;
  limites: number;
  dueno: Politica;
  /** El tope es del negocio: el dueño sigue los límites del cajero (con PIN al pasar). */
  duenoSigueCajero: boolean;
  normalCajero: Politica;
  normalTecnico: Politica;
  /** Niveles que la acción aplica (1 PIN, 2 motivo, 4 sí): la pantalla ofrece solo esos (Rust rechaza otros). */
  niveles: number;
  /** Sin un monto máximo, el cajero la tiene solo con PIN. */
  montoOPin: boolean;
}

export const N_PIN = 1;
export const N_MOTIVO = 2;
export const N_SI = 4;
/** «Sí» y «con PIN» son lo mismo: el comando siempre pide el PIN del dueño. */
export const N_CON_PIN = N_PIN | N_SI;

export interface Seguridad {
  version: number;
  datos: Datos;
  catalogo: AccionInfo[];
  cajeros: { id: string; nombre: string }[];
  /** La cadena de versiones estaba rota: se usa la última válida. */
  rotaEn: number | null;
}

export interface VersionFila {
  id: number;
  creadaEn: string;
  creadaPor: string | null;
  pinDueno: boolean;
  plantilla: string | null;
  motivo: string;
}

/** Lo que ve la pantalla del usuario de la sesión: acción → política efectiva. */
export interface PermisosSesion {
  version: number;
  acciones: Record<string, Politica>;
  /** Lista para el cajero al anular (opción C). */
  motivosAnulacion: string[];
  umbralAvisoAnulaciones: number;
}

export interface EstadoSesion {
  bloqueada: boolean;
  restanteMs: number;
  minutos: number;
}

export interface Avisos {
  anulacionesSinPin: number;
  seguridadAlterada: boolean;
  /** Más anulaciones sin PIN que esto en un día: el día sale marcado en Cierres de caja. */
  umbral: number;
}

// Bits de límites (acciones.rs).
export const L_MONTO = 1;
export const L_PCT = 2;
export const L_CANTIDAD = 4;
export const L_TURNO = 8;
export const L_VENTANA = 16;

export const permisosSesion = () => invocar<PermisosSesion>("sesion_permisos");
export const estadoSesion = () => invocar<(EstadoSesion & { usuario: { id: string; nombre: string; rol: string } }) | null>("sesion_estado");
export const seguridadObtener = () => invocar<Seguridad>("seguridad_obtener");
export const seguridadHistorial = () => invocar<VersionFila[]>("seguridad_historial");
export const seguridadVersion = (id: number) => invocar<Datos>("seguridad_version", { id });
/** Qué afloja la propuesta (si no está vacío, guardar pide el PIN del dueño). */
export const seguridadDiferencias = (datos: Datos) => invocar<string[]>("seguridad_diferencias", { datos });
export const seguridadGuardar = (datos: Datos, motivo: string, plantilla: string | null, pin: string | null) =>
  invocar<number>("seguridad_guardar", { datos, motivo, plantilla, pin });
export const seguridadVolver = (id: number, motivo: string, pin: string) => invocar<number>("seguridad_volver", { id, motivo, pin });
export const seguridadPlantilla = (nombre: string) => invocar<Datos>("seguridad_plantilla", { nombre });
export const seguridadInactividad = (inactividad: Inactividad, pin: string | null) => invocar<number>("seguridad_inactividad", { inactividad, pin });
export const seguridadAutorizar = (accion: string, pin: string | null, motivo: string | null) => invocar<void>("seguridad_autorizar", { accion, pin, motivo });
export const avisosDueno = () => invocar<Avisos>("avisos_dueno");
export const anulacionesVistas = () => invocar<void>("avisos_anulaciones_vistas");
