// Bloqueo por inactividad y autorizaciones de la política (DISENO-PERMISOS.md). Rust decide; aquí
// solo se muestra el velo, el aviso de 1 minuto y el diálogo que pide PIN o motivo.
import { Lock, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { leerPedido, type PedidoAutorizacion } from "../lib/invocar";
import Login from "../screens/Login";
import type { Usuario } from "../tipos";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Field from "../ui/Field";
import Modal from "./Modal";

/**
 * Velo de bloqueo: un <dialog> modal propio, abierto AL FINAL, para quedar sobre cualquier otro
 * diálogo abierto (la capa superior apila en orden). Opaco: no deja ver nada de la pantalla de
 * abajo, que sigue montada (no se pierde lo que estaba a medias). Esc no lo cierra.
 */
export function VeloBloqueo(p: { nombreNegocio: string; usuario: { id: string; nombre: string }; onEntrar(u: Usuario, minutos: number, continua: boolean): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) el.showModal();
    const no = (e: Event) => e.preventDefault();
    el.addEventListener("cancel", no);
    return () => {
      el.removeEventListener("cancel", no);
      if (el.open) el.close();
    };
  }, []);
  return (
    <dialog ref={ref} className="velo-bloqueo" aria-label="Pantalla bloqueada">
      <div className="velo-bloqueo-cab">
        <Lock size={20} aria-hidden /> Pantalla bloqueada
      </div>
      <Login nombreNegocio={p.nombreNegocio} bloqueo={p.usuario} onEntrar={p.onEntrar} />
    </dialog>
  );
}

/** Aviso discreto 1 minuto antes del bloqueo. Cualquier tecla o toque lo cierra (y es actividad). */
export function AvisoInactividad() {
  return (
    <div className="aviso-inactividad" role="status">
      Se bloquea en 1 minuto por inactividad
    </div>
  );
}

/** Lo que muestra el diálogo según lo que pidió Rust. */
export function textoPedido(p: PedidoAutorizacion): string {
  const por = p.por && p.por !== "hace falta el PIN del dueño" ? ` (${p.por})` : "";
  return p.tipo === "pin" ? `Esto necesita el PIN del dueño${por}.` : "Escriba por qué lo hace. Queda en la bitácora.";
}

/** Pide el PIN del dueño o el motivo cuando una acción lo exige (y reintenta: lib/invocar). */
export function PedirAutorizacion(p: { pedido: PedidoAutorizacion; onListo(r: { pin?: string; motivo?: string } | null): void }) {
  const [pin, setPin] = useState("");
  const [motivo, setMotivo] = useState("");
  const esPin = p.pedido.tipo === "pin";
  const listo = esPin ? pin.length >= 4 : motivo.trim().length >= 3;
  return (
    <Modal titulo={esPin ? "Autorización del dueño" : "Motivo"} onCerrar={() => p.onListo(null)} ancho={440}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (listo) p.onListo(esPin ? { pin } : { motivo: motivo.trim() });
        }}
      >
        <Alert tono="aviso">{textoPedido(p.pedido)}</Alert>
        {esPin ? (
          <Field label="PIN del dueño">
            <input className="pin" type="password" inputMode="numeric" autoComplete="off" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
          </Field>
        ) : (
          <Field label="Motivo">
            <input autoFocus maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          </Field>
        )}
        <Button type="submit" variante="primario" icono={ShieldCheck} atajo="Enter" disabled={!listo}>
          {esPin ? "Autorizar" : "Seguir"}
        </Button>
      </form>
    </Modal>
  );
}

export { leerPedido };
