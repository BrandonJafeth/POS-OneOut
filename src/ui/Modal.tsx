// Diálogo nativo (<dialog> + showModal): el navegador hace inerte el resto de la página, lo pone en
// la capa superior, cierra con Esc (evento cancel) y devuelve el foco a donde estaba. Varios diálogos
// se apilan solos (el PIN del dueño sobre el cobro). Guía: Modern Web Guidance «dialog».
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

/** El puntero está fuera del recuadro del diálogo (sobre el velo). Se mide la posición: el <dialog>
 *  también es el target de su propio relleno. */
const afuera = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};

export default function Modal({ titulo, onCerrar, children, ancho = 560, pie }: Props) {
  const caja = useRef<HTMLDialogElement>(null);
  const id = useId();
  const cerrar = useRef(onCerrar);
  cerrar.current = onCerrar;
  // Con algo escrito, un clic fuera de la ventana (sin querer, al soltar el mouse) NO la cierra:
  // se perdería lo escrito. La X, Esc y los botones sí la cierran.
  const escrito = useRef(false);
  const presionAfuera = useRef(false);

  useEffect(() => {
    const el = caja.current;
    if (!el) return;
    if (!el.open) el.showModal();
    // Si un hijo ya tomó el foco (autoFocus), se respeta. Si no, el primer campo o el primer
    // botón que no sea "Cerrar".
    if (!el.contains(document.activeElement) || document.activeElement === el.querySelector(".modal-cab button")) {
      const primero = el.querySelector<HTMLElement>(".modal-cuerpo input:not([disabled]), .modal-cuerpo select, .modal-cuerpo textarea") ?? el.querySelectorAll<HTMLElement>(ENFOCABLES)[1];
      primero?.focus();
    }
    // Esc: lo decide quien abrió (puede no cerrarse, p. ej. mientras guarda).
    const cancelar = (e: Event) => {
      e.preventDefault();
      cerrar.current();
    };
    el.addEventListener("cancel", cancelar);
    return () => {
      el.removeEventListener("cancel", cancelar);
      if (el.open) el.close();
    };
  }, []);

  return (
    <dialog
      ref={caja}
      className="modal"
      aria-labelledby={id}
      style={{ width: ancho }}
      onInput={() => (escrito.current = true)}
      onPointerDown={(e) => (presionAfuera.current = e.target === e.currentTarget && afuera(e, e.currentTarget))}
      onPointerUp={(e) => {
        // Presionar y soltar afuera: cierra (salvo que haya algo escrito). Un arrastre que termina afuera, no.
        if (presionAfuera.current && afuera(e, e.currentTarget) && !escrito.current) onCerrar();
        presionAfuera.current = false;
      }}
    >
      <div className="modal-cab">
        <h2 id={id}>{titulo}</h2>
        <button type="button" className="btn btn-fantasma btn-md" onClick={onCerrar} aria-label="Cerrar" title="Cerrar (Esc)" style={{ width: 44, padding: 0 }}>
          <X size={20} aria-hidden />
        </button>
      </div>
      <div className="modal-cuerpo">{children}</div>
      {pie && <div className="modal-pie">{pie}</div>}
    </dialog>
  );
}
