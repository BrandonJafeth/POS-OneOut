// Detecta lecturas del escáner USB (que "teclea" el código muy rápido y termina en Enter)
// en cualquier parte de la pantalla, aunque el foco esté en otro campo.
// Si las teclas cayeron dentro de un campo de texto, se las quita para que no ensucien lo escrito.
import { useEffect, useRef } from "react";

interface Opciones {
  activo?: boolean;
  /** Ignora el mismo código leído de nuevo antes de este tiempo (config escaner_debounce_ms). */
  debounceMs?: number;
  /** Promedio entre teclas por debajo del cual se considera lector (el prototipo midió < 40 ms). */
  maxIntervaloMs?: number;
  minLargo?: number;
}

/** Pausa que corta una lectura: más que esto entre teclas ya es una persona tecleando. */
const PAUSA_MS = 120;

export function esLecturaDeEscaner(tiempos: number[], maxIntervaloMs: number, minLargo: number): boolean {
  if (tiempos.length < minLargo) return false;
  const total = tiempos[tiempos.length - 1] - tiempos[0];
  return total / (tiempos.length - 1) < maxIntervaloMs;
}

/** El lector a veces manda la misma lectura dos veces seguidas: se ignora si llega antes de `debounceMs`. */
export function esRepetida(ultimo: { codigo: string; en: number }, codigo: string, ahora: number, debounceMs: number): boolean {
  return ultimo.codigo.toLowerCase() === codigo.toLowerCase() && ahora - ultimo.en < debounceMs;
}

/** Quita `codigo` del final del campo y avisa a React (que escucha el evento input). */
function quitarDelCampo(el: Element | null, codigo: string) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  if (!el.value.endsWith(codigo)) return;
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, el.value.slice(0, -codigo.length));
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function useEscaner(onEscaneo: (codigo: string) => void, opc: Opciones = {}): void {
  const { activo = true, debounceMs = 400, maxIntervaloMs = 40, minLargo = 3 } = opc;
  const cb = useRef(onEscaneo);
  cb.current = onEscaneo;
  const buf = useRef<{ texto: string; tiempos: number[] }>({ texto: "", tiempos: [] });
  const ultimo = useRef<{ codigo: string; en: number }>({ codigo: "", en: 0 });

  useEffect(() => {
    if (!activo) return;
    const k = (e: KeyboardEvent) => {
      const ahora = performance.now();
      const b = buf.current;
      if (e.key === "Enter") {
        const codigo = b.texto;
        const esEscaner = esLecturaDeEscaner([...b.tiempos, ahora], maxIntervaloMs, minLargo);
        buf.current = { texto: "", tiempos: [] };
        if (!esEscaner) return;
        e.preventDefault();
        e.stopPropagation();
        quitarDelCampo(document.activeElement, codigo);
        if (esRepetida(ultimo.current, codigo, ahora, debounceMs)) return;
        ultimo.current = { codigo, en: ahora };
        cb.current(codigo);
        return;
      }
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = b.tiempos;
      if (t.length && ahora - t[t.length - 1] > PAUSA_MS) buf.current = { texto: "", tiempos: [] };
      buf.current.texto += e.key;
      buf.current.tiempos.push(ahora);
    };
    // Fase de captura: se entera antes que los campos y puede frenar el Enter.
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [activo, debounceMs, maxIntervaloMs, minLargo]);
}
