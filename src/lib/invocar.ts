// Único puente a los comandos Rust. Los errores llegan como texto; aquí se vuelven Error.
// Si Rust dice que la sesión venció (inactividad) o que falta cambiar el PIN, se avisa a la app.
import { invoke, isTauri } from "@tauri-apps/api/core";

export const SIN_TAURI = "No se está ejecutando dentro de Tauri (abra la app con npm run tauri dev).";
export const SESION_EXPIRADA = "SESION_EXPIRADA";
export const DEBE_CAMBIAR_PIN = "DEBE_CAMBIAR_PIN";

const escuchas = new Set<(motivo: string) => void>();

/** La app se suscribe para volver a la entrada cuando Rust cierra la sesión. */
export function alPerderSesion(f: (motivo: string) => void): () => void {
  escuchas.add(f);
  return () => escuchas.delete(f);
}

export async function invocar<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new Error(SIN_TAURI);
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const m = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    if (m === SESION_EXPIRADA || m === DEBE_CAMBIAR_PIN) escuchas.forEach((f) => f(m));
    if (m === SESION_EXPIRADA) throw new Error("La sesión se cerró por inactividad. Vuelva a entrar.");
    if (m === DEBE_CAMBIAR_PIN) throw new Error("Primero cambie su PIN.");
    throw new Error(m);
  }
}
