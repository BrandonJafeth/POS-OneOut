// Teclado en los diálogos de la venta (se activa solo en Venta.tsx), como en las cajas de supermercado:
// · Enter pasa a la siguiente casilla VACÍA; si ya no queda ninguna, guarda (el submit normal del form).
//   Así un formulario lleno (editar, cobrar con el monto ya puesto) se confirma con un solo Enter.
// · ↓ / ↑ pasan a la casilla siguiente / anterior (también a las filas de una lista de resultados).
// Un campo que ya maneja su Enter (buscador de venta, lector, filas) hace preventDefault y aquí no se toca.
// Las casillas con data-opcional no detienen el Enter (sí se alcanzan con Tab y flechas).

const CAMPOS = 'input:not([type="hidden"]):not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled]), tr[tabindex="0"], [role="option"]';
/** Inputs donde ↑/↓ ya significan algo (subir un número, mover una fecha, elegir un radio). */
const FLECHAS_PROPIAS = new Set(["number", "date", "time", "datetime-local", "month", "week", "range", "radio"]);

export interface Casilla {
  vacia: boolean;
  opcional: boolean;
}

/** Índice al que se mueve el foco, o -1 para dejar que el navegador haga lo suyo (Enter al final = guardar). */
export function destino(casillas: Casilla[], i: number, tecla: string): number {
  if (tecla === "ArrowDown") return i + 1 < casillas.length ? i + 1 : -1;
  if (tecla === "ArrowUp") return i - 1;
  if (tecla === "Enter") return casillas.findIndex((c, j) => j > i && c.vacia && !c.opcional);
  return -1;
}

function vacia(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) return el.type === "checkbox" ? false : !el.value;
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return !el.value;
  return true; // una fila de resultados: Enter en el buscador baja a la primera
}

/** La pantalla está bloqueada por inactividad: lo que queda debajo del velo no escucha el teclado
 *  (los atajos y el lector de la venta seguían recibiendo teclas a través de `window`). */
export function pantallaBloqueada(): boolean {
  return document.querySelector("dialog.velo-bloqueo[open]") !== null;
}

export function navegarCampos(e: KeyboardEvent): void {
  if (pantallaBloqueada()) return;
  if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing) return;
  if (e.key !== "Enter" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const el = document.activeElement as HTMLElement | null;
  if (!el || el instanceof HTMLTextAreaElement) return;
  // Enter en un botón o fila es su clic: solo las flechas se mueven desde ahí.
  if (e.key === "Enter" && !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
  if (e.key !== "Enter" && (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && (FLECHAS_PROPIAS.has(el.type) || el.list)))) return;
  const zona = el.closest("form") ?? el.closest("dialog");
  if (!zona) return;
  const lista = [...zona.querySelectorAll<HTMLElement>(CAMPOS)].filter((x) => x.offsetParent !== null);
  const i = lista.indexOf(el);
  if (i < 0) return;
  const j = destino(
    lista.map((x) => ({ vacia: vacia(x), opcional: x.hasAttribute("data-opcional") })),
    i,
    e.key,
  );
  if (j < 0) return;
  e.preventDefault();
  lista[j].focus();
  if (lista[j] instanceof HTMLInputElement) (lista[j] as HTMLInputElement).select();
}
