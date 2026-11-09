// Respaldo cifrado (Rust: src-tauri/src/respaldo.rs). Aquí se valida antes de llamar,
// y Rust vuelve a validar: sin contraseña de 8+ caracteres no se genera nada.
import { invocar as invocarRust } from "./invocar";

export const CONTRASENA_MINIMA = 8;

export const AVISO_RESPALDO =
  "Este respaldo contiene datos personales de clientes (Ley 8968). Va cifrado con AES-256: sin la contraseña no se puede abrir, y si la pierde no hay forma de recuperarlo. Guárdelo en un lugar seguro y no lo comparta.";

export function validarContrasenaRespaldo(contrasena: string, repetida: string): void {
  if ([...contrasena].length < CONTRASENA_MINIMA) throw new Error(`La contraseña debe tener al menos ${CONTRASENA_MINIMA} caracteres`);
  if (contrasena !== repetida) throw new Error("Las contraseñas no coinciden");
}

/** "20261029-1830" */
export function marcaTiempo(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

type Invocar = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** Lo crea Rust en la carpeta de la app sin pasar por un archivo en claro. Devuelve la ruta. */
export async function crearRespaldo(contrasena: string, repetida: string, invocar: Invocar = invocarRust): Promise<string> {
  validarContrasenaRespaldo(contrasena, repetida);
  return String(await invocar("respaldo_crear", { contrasena }));
}

/**
 * Restaura desde un archivo elegido con <input type="file"> (la ventana no tiene acceso al disco).
 * Rust lo descifra, revisa integridad y lo deja listo; la app se reinicia para usarlo.
 */
export async function restaurarRespaldo(archivo: File, contrasena: string, pinDueno: string, invocar: Invocar = invocarRust): Promise<void> {
  if (!archivo.name.toLowerCase().endsWith(".posbak")) throw new Error("Elija un archivo .posbak");
  const datos = Array.from(new Uint8Array(await archivo.arrayBuffer()));
  await invocar("respaldo_restaurar", { pin: pinDueno, archivo: datos, contrasena });
}

/** Fecha ISO del último respaldo cifrado, o null si nunca se hizo. */
export async function ultimoRespaldo(invocar: Invocar = invocarRust): Promise<string | null> {
  return ((await invocar("respaldo_ultimo", {})) as string | null) ?? null;
}

/** Días sin respaldo a partir de los cuales se avisa al dueño. */
export const DIAS_SIN_RESPALDO = 7;

export async function reiniciarApp(): Promise<void> {
  await invocarRust("app_reiniciar");
}

// ─────────── Respaldo automático ───────────

export interface EstadoAutomatico {
  configurado: boolean;
  ultimo: string | null;
  ultimoVerificado: boolean | null;
  hechoHoy: boolean;
  recordarUsb: boolean;
  cantidad: number;
  carpeta: string;
}

export const estadoAutomatico = () => invocarRust<EstadoAutomatico>("respaldo_auto_estado");
export const configurarAutomatico = (contrasena: string, pin: string) => invocarRust<void>("respaldo_auto_configurar", { contrasena, pin });
export const respaldoAhora = () => invocarRust<string | null>("respaldo_auto_ahora");
export const usbConfirmado = () => invocarRust<void>("respaldo_usb_confirmado");
