// Diálogo accesible: foco atrapado adentro (Tab da la vuelta), Esc cierra y, al cerrar,
// el foco vuelve a donde estaba.
import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

interface Props {
  titulo: string;
  onCerrar(): void;
  children: ReactNode;
  ancho?: number;
  /** Acciones del diálogo: quedan fijas abajo, siempre visibles aunque el contenido desplace. */
  pie?: ReactNode;
}

const ENFOCABLES = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({ titulo, onCerrar, children, ancho = 560, pie }: Props) {
  const caja = useRef<HTMLDivElement>(null);
  const id = useId();
  const cerrar = useRef(onCerrar);
  cerrar.current = onCerrar;

  useEffect(() => {
    const el = caja.current;
    // Si un hijo ya tomó el foco (autoFocus), se respeta. Si no, el primer campo o el primer
    // botón que no sea "Cerrar".
    const yaAdentro = !!el && el.contains(document.activeElement);
    const previo = yaAdentro ? null : (document.activeElement as HTMLElement | null);
    if (!yaAdentro) {
      const primero = el?.querySelector<HTMLElement>("input:not([disabled]), select, textarea") ?? el?.querySelectorAll<HTMLElement>(ENFOCABLES)[1];
      primero?.focus();
    }
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cerrar.current();
      }
      if (e.key !== "Tab" || !el) return;
      const lista = [...el.querySelectorAll<HTMLElement>(ENFOCABLES)];
      if (!lista.length) return;
      const [a, z] = [lista[0], lista[lista.length - 1]];
      if (e.shiftKey && document.activeElement === a) (e.preventDefault(), z.focus());
      else if (!e.shiftKey && document.activeElement === z) (e.preventDefault(), a.focus());
    };
    el?.addEventListener("keydown", k);
    return () => {
      el?.removeEventListener("keydown", k);
      previo?.focus?.();
    };
  }, []);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div ref={caja} className="modal" role="dialog" aria-modal="true" aria-labelledby={id} style={{ width: ancho }}>
        <div className="modal-cab">
          <h2 id={id}>{titulo}</h2>
          <button type="button" className="btn btn-fantasma btn-md" onClick={onCerrar} aria-label="Cerrar" title="Cerrar (Esc)" style={{ width: 44, padding: 0 }}>
            <X size={20} aria-hidden />
          </button>
        </div>
        <div className="modal-cuerpo">{children}</div>
        {pie && <div className="modal-pie">{pie}</div>}
      </div>
    </div>
  );
}
