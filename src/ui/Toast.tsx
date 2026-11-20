// Avisos breves ("toast"): confirman algo que ya pasó bien, sin interrumpir. Uno a la vez (el
// nuevo reemplaza al anterior), abajo al centro, con barra de tiempo que se pausa con el mouse
// o el foco. Pueden traer una acción ("Deshacer"). Los errores que piden corregir algo NO van
// aquí: se quedan junto al campo hasta que se arreglen.
//   const toast = useToast();
//   toast.ok("Producto guardado");
//   toast.mostrar({ tono: "info", titulo: "Venta 2 descartada", accion: { texto: "Deshacer", onClick } });
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { copiar } from "../lib/copiar";
import { ICONO_TONO, type Tono } from "./Badge";

export interface AvisoToast {
  tono?: Tono;
  titulo: string;
  texto?: ReactNode;
  accion?: { texto: string; onClick(): void };
  /** ms; por defecto 4 s, 7 s si trae acción o es un error. */
  duracion?: number;
}

interface Api {
  mostrar(a: AvisoToast): void;
  ok(titulo: string, texto?: ReactNode): void;
  info(titulo: string, texto?: ReactNode): void;
  /** Para acciones cuyo botón puede quedar lejos del mensaje en pantalla (imprimir, descargar). */
  error(titulo: string, texto?: ReactNode): void;
  /** Archivo exportado: muestra la ruta con botón "Copiar ruta". */
  guardado(titulo: string, ruta: string): void;
  cerrar(): void;
}

/** El último <dialog> modal abierto (el de más arriba), o null. */
export function dialogoDeArriba(): HTMLDialogElement | null {
  const modales = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter((d) => {
    try {
      return d.matches(":modal");
    } catch {
      return true; // sin :modal, todo diálogo abierto con showModal cuenta
    }
  });
  return modales[modales.length - 1] ?? null;
}

const Ctx = createContext<Api>({ mostrar: () => {}, ok: () => {}, info: () => {}, error: () => {}, guardado: () => {}, cerrar: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [actual, setActual] = useState<(AvisoToast & { id: number }) | null>(null);
  const id = useRef(0);
  const cerrar = useCallback(() => setActual(null), []);
  // Un aviso con acción ("Deshacer") no lo tapa uno simple: perderlo sería perder lo que deshace.
  // "Copiar ruta" (tono ok) no cuenta: la ruta no se pierde, y taparía errores de lo que siga.
  const mostrar = useCallback((a: AvisoToast) => setActual((v) => (v?.accion && v.tono !== "ok" && !a.accion ? v : { ...a, id: ++id.current })), []);
  const api = useMemo<Api>(
    () => ({
      mostrar,
      cerrar,
      ok: (titulo, texto) => mostrar({ tono: "ok", titulo, texto }),
      info: (titulo, texto) => mostrar({ tono: "info", titulo, texto }),
      error: (titulo, texto) => mostrar({ tono: "error", titulo, texto }),
      guardado: (titulo, ruta) => mostrar({ tono: "ok", titulo, texto: ruta, accion: { texto: "Copiar ruta", onClick: () => void copiar(ruta) } }),
    }),
    [mostrar, cerrar],
  );
  // La zona es un popover manual: así queda en la capa superior, también sobre un <dialog> modal.
  // Pero un diálogo modal deja INERTE todo lo que no está dentro de él (no se puede tocar ni enfocar):
  // por eso la zona se monta dentro del diálogo modal de más arriba, si hay uno abierto, y vuelve al
  // body cuando ese diálogo se cierra. Cada aviso nuevo la vuelve a abrir para quedar encima.
  const zona = useRef<HTMLDivElement>(null);
  const [destino, setDestino] = useState<HTMLElement>(() => document.body);
  useLayoutEffect(() => {
    if (!actual) return;
    const elegir = () => setDestino(dialogoDeArriba() ?? document.body);
    elegir();
    // Mientras se ve el aviso, si se abre o se cierra un diálogo, el aviso lo sigue.
    const obs = new MutationObserver(elegir);
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    return () => obs.disconnect();
  }, [actual?.id]);
  useEffect(() => {
    const z = zona.current;
    if (!z?.showPopover) return;
    try {
      if (z.matches(":popover-open")) z.hidePopover();
      z.showPopover();
    } catch {
      // Sin soporte de popover: queda como antes (z-index).
    }
  }, [actual?.id, destino]);
  const tono = actual?.tono ?? "ok";
  const Icono = ICONO_TONO[tono];
  // Tiempo para leerlo: mínimo 4 s (7 s con acción o error) y más si el texto es largo.
  const largo = (actual?.titulo.length ?? 0) + (typeof actual?.texto === "string" ? actual.texto.length : 0);
  const duracion = actual?.duracion ?? Math.max(actual?.accion || tono === "error" ? 7000 : 4000, Math.min(10000, largo * 70));

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* La zona existe siempre: así el lector de pantalla anuncia lo que entra. */}
      {createPortal(
        // Esc sobre el aviso lo cierra a él, no al diálogo de abajo.
        <div
          ref={zona}
          popover="manual"
          className="toast-zona"
          role="status"
          aria-live="polite"
          onKeyDown={(e) => {
            if (e.key === "Escape" && actual) (e.preventDefault(), e.stopPropagation(), cerrar());
          }}
        >
          {actual && (
            <div key={actual.id} className={`toast toast-${tono}`} role={tono === "error" ? "alert" : undefined}>
              <span className="toast-icono" aria-hidden>
                <Icono size={18} strokeWidth={2.25} />
              </span>
              <div className="toast-cuerpo">
                <strong>{actual.titulo}</strong>
                {actual.texto && <span className="toast-texto">{actual.texto}</span>}
              </div>
              {actual.accion && (
                <button
                  type="button"
                  className="toast-accion"
                  onClick={() => {
                    actual.accion!.onClick();
                    cerrar();
                  }}
                >
                  {actual.accion.texto}
                </button>
              )}
              <button type="button" className="toast-cerrar" aria-label="Cerrar aviso" onClick={cerrar}>
                <X size={16} aria-hidden />
              </button>
              {/* Tiempo restante: al terminar la animación se cierra; con mouse o foco se pausa. */}
              <span className="toast-tiempo" aria-hidden style={{ animationDuration: `${duracion}ms` }} onAnimationEnd={cerrar} />
            </div>
          )}
        </div>,
      destino,
      )}
    </Ctx.Provider>
  );
}

export function useToast(): Api {
  return useContext(Ctx);
}
