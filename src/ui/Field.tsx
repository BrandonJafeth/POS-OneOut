import { XCircle } from "lucide-react";
import type { ReactNode } from "react";

/** Campo con etiqueta SIEMPRE visible (el placeholder solo da un ejemplo), ayuda y error con icono. */
export default function Field(p: { label: ReactNode; ayuda?: ReactNode; error?: string; children: ReactNode; className?: string; flex?: number }) {
  return (
    <label className={`campo ${p.className ?? ""}`} style={p.flex ? { flex: p.flex } : undefined}>
      <span className="campo-etiqueta">{p.label}</span>
      {p.children}
      {p.ayuda && <span className="ayuda">{p.ayuda}</span>}
      {p.error && (
        <span className="campo-error">
          <XCircle size={16} aria-hidden /> {p.error}
        </span>
      )}
    </label>
  );
}
