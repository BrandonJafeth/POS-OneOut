// Respaldo cifrado (Rust: src-tauri/src/respaldo.rs). Aquí se valida antes de llamar,
// y Rust vuelve a validar: sin contraseña de 8+ caracteres no se genera nada.
import { invoke } from "@tauri-apps/api/core";

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

/** Devuelve la ruta del archivo creado. `invocar` se inyecta en las pruebas. */
export async function crearRespaldo(contrasena: string, repetida: string, invocar: Invocar = invoke): Promise<string> {
  validarContrasenaRespaldo(contrasena, repetida);
  return String(await invocar("respaldo_crear", { contrasena, marca: marcaTiempo() }));
}
