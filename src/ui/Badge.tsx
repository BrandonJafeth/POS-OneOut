import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type Tono = "ok" | "aviso" | "error" | "info";

export const ICONO_TONO: Record<Tono, LucideIcon> = { ok: CheckCircle2, aviso: AlertTriangle, error: XCircle, info: Info };

/** Etiqueta de estado: color + icono + texto (nunca solo color). */
export default function Badge({ tono, children, icono }: { tono: Tono; children: ReactNode; icono?: LucideIcon }) {
  const Icono = icono ?? ICONO_TONO[tono];
  return (
    <span className={`badge badge-${tono}`}>
      <Icono size={16} aria-hidden />
      {children}
    </span>
  );
}
