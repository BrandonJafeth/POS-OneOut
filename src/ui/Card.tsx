import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  titulo?: ReactNode;
  icono?: LucideIcon;
  /** Botones a la derecha del título. */
  acciones?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export default function Card({ titulo, icono: Icono, acciones, children, className = "" }: Props) {
  return (
    <section className={`card ${className}`}>
      {(titulo || acciones) && (
        <header className="card-cab">
          {titulo && (
            <h2>
              {Icono && <Icono size={20} aria-hidden />}
              {titulo}
            </h2>
          )}
          {acciones && <div className="card-acciones">{acciones}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
