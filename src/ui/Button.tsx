import type { LucideIcon } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type Variante = "primario" | "normal" | "peligro" | "peligro-lleno" | "fantasma";
export type Tamano = "md" | "lg" | "xl";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  icono?: LucideIcon;
  variante?: Variante;
  tamano?: Tamano;
  /** Atajo de teclado (p. ej. "F12"): va en el tooltip; visible en el botón solo con `verAtajo`. */
  atajo?: string;
  verAtajo?: boolean;
  /** Ocupa todo el ancho disponible. */
  ancho?: boolean;
  children?: ReactNode;
}

/** Botón con icono + texto (mínimo 44 px de alto) y, si tiene, el atajo de teclado visible. */
const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { icono: Icono, variante = "normal", tamano = "md", atajo, verAtajo, ancho, className = "", children, type = "button", title, ...rest },
  ref,
) {
  const tam = tamano === "xl" ? 28 : tamano === "lg" ? 22 : 18;
  return (
    <button
      ref={ref}
      type={type}
      className={`btn btn-${variante} btn-${tamano} ${ancho ? "btn-ancho" : ""} ${verAtajo ? "con-atajo" : ""} ${className}`}
      aria-keyshortcuts={atajo}
      title={title ?? (atajo ? `Atajo: ${atajo}` : undefined)}
      {...rest}
    >
      {Icono && <Icono size={tam} aria-hidden strokeWidth={2} />}
      {children != null && <span className="btn-texto">{children}</span>}
      {atajo && <kbd>{atajo}</kbd>}
    </button>
  );
});

export default Button;
