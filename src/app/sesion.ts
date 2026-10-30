import { createContext, useContext } from "react";
import type { ConfigApp } from "../db/config";
import { puede, type Permiso } from "../lib/permisos";
import type { Actor, Usuario } from "../tipos";

export interface Sesion {
  usuario: Usuario;
  actor: Actor;
  config: ConfigApp;
  recargarConfig(): Promise<void>;
  puede(p: Permiso): boolean;
  salir(): void;
}

export const SesionCtx = createContext<Sesion | null>(null);

export function useSesion(): Sesion {
  const s = useContext(SesionCtx);
  if (!s) throw new Error("useSesion fuera de una sesión");
  return s;
}

export function crearSesion(usuario: Usuario, config: ConfigApp, recargarConfig: () => Promise<void>, salir: () => void): Sesion {
  return {
    usuario,
    actor: { id: usuario.id, rol: usuario.rol },
    config,
    recargarConfig,
    puede: (p) => puede(usuario.rol, p),
    salir,
  };
}
