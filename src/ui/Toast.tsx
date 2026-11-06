// Avisos breves ("toast"): confirman algo que ya pasó bien, sin interrumpir. Uno a la vez (el
// nuevo reemplaza al anterior), abajo al centro, con barra de tiempo que se pausa con el mouse
// o el foco. Pueden traer una acción ("Deshacer"). Los errores que piden corregir algo NO van
// aquí: se quedan junto al campo hasta que se arreglen.
//   const toast = useToast();
//   toast.ok("Producto guardado");
//   toast.mostrar({ tono: "info", titulo: "Venta 2 descartada", accion: { texto: "Deshacer", onClick } });
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
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
  cerrar(): void;
}

const Ctx = createContext<Api>({ mostrar: () => {}, ok: () => {}, info: () => {}, error: () => {}, cerrar: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [actual, setActual] = useState<(AvisoToast & { id: number }) | null>(null);
  const id = useRef(0);
  const cerrar = useCallback(() => setActual(null), []);
  // Un aviso con acción ("Deshacer") no lo tapa uno simple: perderlo sería perder lo que deshace.
  const mostrar = useCallback((a: AvisoToast) => setActual((v) => (v?.accion && !a.accion ? v : { ...a, id: ++id.current })), []);
  const api = useMemo<Api>(
    () => ({
      mostrar,
      cerrar,
      ok: (titulo, texto) => mostrar({ tono: "ok", titulo, texto }),
      info: (titulo, texto) => mostrar({ tono: "info", titulo, texto }),
      error: (titulo, texto) => mostrar({ tono: "error", titulo, texto }),
    }),
    [mostrar, cerrar],
  );
  const tono = actual?.tono ?? "ok";
  const Icono = ICONO_TONO[tono];
  // Tiempo para leerlo: mínimo 4 s (7 s con acción o error) y más si el texto es largo.
  const largo = (actual?.titulo.length ?? 0) + (typeof actual?.texto === "string" ? actual.texto.length : 0);
  const duracion = actual?.duracion ?? Math.max(actual?.accion || tono === "error" ? 7000 : 4000, Math.min(10000, largo * 70));

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* La zona existe siempre: así el lector de pantalla anuncia lo que entra. */}
      <div className="toast-zona" role="status" aria-live="polite">
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
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): Api {
  return useContext(Ctx);
}
