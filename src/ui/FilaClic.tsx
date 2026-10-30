import type { ReactNode } from "react";

/** Fila de tabla que se abre con clic, Enter o Espacio (y se alcanza con Tab). */
export default function FilaClic(p: { onAbrir(): void; children: ReactNode; className?: string; etiqueta: string }) {
  return (
    <tr
      tabIndex={0}
      className={`clic ${p.className ?? ""}`}
      aria-label={p.etiqueta}
      onClick={p.onAbrir}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") (e.preventDefault(), p.onAbrir());
      }}
    >
      {p.children}
    </tr>
  );
}
