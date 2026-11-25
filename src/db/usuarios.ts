// Usuarios, PIN y sesión: todo lo decide Rust (src-tauri/src/usuarios.rs y lib.rs).
// El PIN nunca se guarda en la pantalla; la sesión vive en Rust y vence por inactividad.
import type { Actor, Rol, Usuario } from "../tipos";
import { invocar } from "../lib/invocar";

export function listarUsuarios(): Promise<Usuario[]> {
  return invocar<Usuario[]>("usuarios_listar");
}

/** Para la pantalla de entrada (sin el técnico, que entra por el atajo oculto). */
export function usuariosParaEntrar(): Promise<Pick<Usuario, "id" | "nombre" | "rol">[]> {
  return invocar("sesion_usuarios");
}

export interface EstadoSistema {
  error: string | null;
  necesitaTecnico: boolean;
  cifrada: boolean;
  nombreNegocio: string;
  tema: unknown;
  colorAcento: unknown;
  colorFondo: unknown;
  /** Carpeta de datos (base, clave protegida y respaldos). */
  carpeta: string;
  version: string;
  migracion: number;
}

/** Solo cuando la base no abrió: restaura un respaldo sin sesión (lo protege su contraseña). */
export function restaurarSinBase(archivo: Uint8Array, contrasena: string): Promise<void> {
  return invocar<void>("sistema_restaurar", { archivo: Array.from(archivo), contrasena });
}

export function estadoSistema(): Promise<EstadoSistema> {
  return invocar<EstadoSistema>("sistema_estado");
}

/** El usuario técnico del primer arranque (Rust lo rechaza si ya existe). Después hay que entrar con su PIN. */
export async function crearTecnicoInicial(pin: string): Promise<void> {
  await invocar("sistema_crear_tecnico", { pin });
}

/** Un dueño nuevo trae su código de recuperación (se muestra una sola vez). */
export function crearUsuario(_actor: Actor, datos: { nombre: string; rol: Rol; pin: string }): Promise<Usuario> {
  return invocar<Usuario>("usuarios_crear", datos);
}

/** El dueño se hace un código de recuperación nuevo con su PIN (el anterior deja de servir). */
export function nuevoCodigoRecuperacion(pin: string): Promise<string> {
  return invocar<string>("usuarios_codigo_recuperacion", { pin });
}

export async function editarUsuario(_actor: Actor, id: string, cambios: { nombre?: string; activo?: boolean }): Promise<void> {
  await invocar("usuarios_editar", { id, nombre: cambios.nombre ?? null, activo: cambios.activo ?? null });
}

/**
 * `actual`: el PIN propio de ahora (no hace falta en el cambio obligatorio). `codigo`: el código de
 * recuperación del dueño cuyo PIN se restablece. Devuelve el código nuevo si se generó (mostrarlo una vez).
 */
export async function cambiarPin(_actor: Actor, id: string, pin: string, extra: { actual?: string; codigo?: string } = {}): Promise<string | null> {
  return (await invocar<string | null>("usuarios_cambiar_pin", { id, pin, actual: extra.actual ?? null, codigo: extra.codigo ?? null })) ?? null;
}

/** Borrado lógico: el usuario queda en ventas y bitácora, pero ya no aparece ni puede entrar. */
export async function eliminarUsuario(_actor: Actor, id: string): Promise<void> {
  await invocar("usuarios_eliminar", { id });
}

export type ResultadoLogin =
  | { ok: true; usuario: Usuario; minutosInactividad: number; continua: boolean }
  | { ok: false; esperaMs: number; intentos: number };

type Respuesta =
  | { resultado: "ok"; usuario: Omit<Usuario, "activo">; minutosInactividad: number; continua?: boolean }
  | { resultado: "rechazado"; esperaMs: number; intentos: number };

function aLogin(r: Respuesta): ResultadoLogin {
  if (r.resultado === "ok") return { ok: true, usuario: { ...r.usuario, activo: true }, minutosInactividad: r.minutosInactividad, continua: !!r.continua };
  return { ok: false, esperaMs: r.esperaMs, intentos: r.intentos };
}

/** Rust responde igual si el usuario no existe que si el PIN está mal (no revela quién existe). */
export async function iniciarSesion(usuarioId: string, pin: string): Promise<ResultadoLogin> {
  return aLogin(await invocar<Respuesta>("sesion_iniciar", { usuarioId, pin }));
}

/** Entrada oculta del técnico. */
export async function iniciarSesionTecnico(pin: string): Promise<ResultadoLogin> {
  return aLogin(await invocar<Respuesta>("sesion_tecnico", { pin }));
}

export async function cerrarSesion(): Promise<void> {
  await invocar("sesion_cerrar");
}

/** Hubo actividad real (teclado, lector, mouse, táctil): lo único que renueva el plazo en Rust. */
export async function tocarSesion(): Promise<void> {
  await invocar("sesion_tocar");
}

/** PIN mínimo por rol (debe coincidir con config pin_min_dueno / pin_min_cajero; Rust decide igual). */
export function pinMinimo(rol: Rol): number {
  return rol === "cajero" ? 4 : 6;
}
