import type { ReactNode } from "react";
import { ICONO_TONO, type Tono } from "./Badge";

/** Mensaje en bloque. Los errores se anuncian al lector de pantalla (role=alert). */
export default function Alert({ tono, titulo, children }: { tono: Tono; titulo?: string; children?: ReactNode }) {
  const Icono = ICONO_TONO[tono];
  return (
    <div className={`alert alert-${tono}`} role={tono === "error" ? "alert" : "status"}>
      <Icono size={22} aria-hidden className="alert-icono" />
      <div>
        {titulo && <strong>{titulo}</strong>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}
