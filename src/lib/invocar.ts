// Único puente a los comandos Rust. Los errores llegan como texto; aquí se vuelven Error.
// Si Rust dice que la sesión venció, que la pantalla se bloqueó o que falta cambiar el PIN, se avisa a la app.
// Si una acción pide PIN del dueño o motivo (política configurable), se pide aquí y se reintenta una vez.
import { invoke, isTauri } from "@tauri-apps/api/core";

export const SIN_TAURI = "No se está ejecutando dentro de Tauri (abra la app con npm run tauri dev).";
export const SESION_EXPIRADA = "SESION_EXPIRADA";
export const SESION_BLOQUEADA = "SESION_BLOQUEADA";
export const DEBE_CAMBIAR_PIN = "DEBE_CAMBIAR_PIN";

const escuchas = new Set<(motivo: string) => void>();

/** La app se suscribe para volver a la entrada (o poner el velo de bloqueo). */
export function alPerderSesion(f: (motivo: string) => void): () => void {
  escuchas.add(f);
  return () => escuchas.delete(f);
}

/** Lo que pide Rust: «NECESITA_PIN:acción:por qué» o «NECESITA_MOTIVO:acción». */
export interface PedidoAutorizacion {
  accion: string;
  tipo: "pin" | "motivo";
  por: string;
}

export function leerPedido(m: string): PedidoAutorizacion | null {
  const r = /^NECESITA_(PIN|MOTIVO):([a-z_.]+)(?::(.*))?$/s.exec(m);
  if (!r) return null;
  return { accion: r[2], tipo: r[1] === "PIN" ? "pin" : "motivo", por: r[3] ?? "" };
}

type Autorizador = (p: PedidoAutorizacion) => Promise<{ pin?: string; motivo?: string } | null>;
let autorizador: Autorizador | null = null;

/** La app registra el diálogo que pide el PIN del dueño o el motivo. */
export function alPedirAutorizacion(f: Autorizador): () => void {
  autorizador = f;
  return () => {
    if (autorizador === f) autorizador = null;
  };
}

function mensaje(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

export async function invocar<T = unknown>(cmd: string, args: Record<string, unknown> = {}, reintento = false): Promise<T> {
  if (!isTauri()) throw new Error(SIN_TAURI);
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const m = mensaje(e);
    if (m === SESION_EXPIRADA || m === SESION_BLOQUEADA || m === DEBE_CAMBIAR_PIN) escuchas.forEach((f) => f(m));
    if (m === SESION_EXPIRADA) throw new Error("La sesión se cerró. Vuelva a entrar.");
    if (m === SESION_BLOQUEADA) throw new Error("La pantalla se bloqueó por inactividad. Vuelva a poner su PIN.");
    if (m === DEBE_CAMBIAR_PIN) throw new Error("Primero cambie su PIN.");
    const pedido = leerPedido(m);
    if (pedido && autorizador && !reintento && cmd !== "seguridad_autorizar") {
      const r = await autorizador(pedido);
      if (!r) throw new Error("No se hizo: hacía falta " + (pedido.tipo === "pin" ? "el PIN del dueño." : "un motivo."));
      await invocar("seguridad_autorizar", { accion: pedido.accion, pin: r.pin ?? null, motivo: r.motivo ?? null }, true);
      return await invocar<T>(cmd, args, true);
    }
    if (pedido) throw new Error(pedido.tipo === "pin" ? `Hace falta el PIN del dueño${pedido.por ? `: ${pedido.por}` : ""}.` : "Escriba el motivo.");
    // Errores técnicos: al registro local para el técnico (Rust quita lo que pueda ser personal).
    if (m.startsWith("ERROR_TECNICO: ") && cmd !== "diagnostico_anotar") void invoke("diagnostico_anotar", { origen: cmd, mensaje: m }).catch(() => undefined);
    throw new Error(m);
  }
}
