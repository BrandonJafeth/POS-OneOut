import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Estado vacío útil: qué pasa y qué hacer ahora. */
export default function EmptyState({ icono: Icono, titulo, texto, children }: { icono: LucideIcon; titulo: string; texto?: ReactNode; children?: ReactNode }) {
  return (
    <div className="vacio">
      <Icono size={44} aria-hidden strokeWidth={1.6} />
      <strong>{titulo}</strong>
      {texto && <p>{texto}</p>}
      {children && <div className="vacio-acciones">{children}</div>}
    </div>
  );
}
