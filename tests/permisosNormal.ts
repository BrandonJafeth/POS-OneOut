// La política Normal efectiva de cada rol, tal como la calcula Rust (tests/casos/permisos.json, lo
// escribe la prueba casos_espejo_con_la_pantalla). Las pruebas de TS la usan como si viniera de
// `sesion_permisos`: la pantalla nunca decide permisos por su cuenta.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Politica } from "../src/generados/Politica";
import type { Inactividad } from "../src/generados/Inactividad";
import { establecerPermisos } from "../src/lib/permisos";
import type { Rol } from "../src/tipos";

export const CASOS = JSON.parse(readFileSync(fileURLToPath(new URL("./casos/permisos.json", import.meta.url)), "utf8")) as {
  catalogo: string[];
  normal: Record<Rol, Record<string, Politica>>;
  topes: { politica: Politica; pct: number; bloquear: boolean }[];
  inactividad: ({ inactividad: Inactividad } & Record<Rol, number>)[];
};

export function normalPuede(rol: Rol, accion: string): boolean {
  return (CASOS.normal[rol][accion]?.nivel ?? "no") !== "no";
}

/** Como si la sesión fuera de ese rol con la plantilla Normal. */
export function comoRol(rol: Rol): void {
  establecerPermisos(CASOS.normal[rol], ["Error de digitación", "Otro"], 3);
}
