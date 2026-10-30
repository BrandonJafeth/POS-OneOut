import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useSesion } from "../app/sesion";
import { autorizarDueno } from "../db/usuarios";
import type { Usuario } from "../tipos";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Field from "../ui/Field";
import { textoError } from "./Mensaje";
import Modal from "./Modal";

/** Pide el PIN de un dueño para autorizar algo en el momento (descuento alto, etc.). */
export default function PinDueno(p: { motivo: string; contexto: string; onAutorizado(d: Usuario): void; onCerrar(): void }) {
  const { actor } = useSesion();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal titulo="Autorización del dueño" onCerrar={p.onCerrar} ancho={440}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            const d = await autorizarDueno(pin, p.contexto, actor.id);
            if (d) p.onAutorizado(d);
            else {
              setPin("");
              setError("Ese PIN no es de ningún dueño. Pídale al dueño que lo escriba de nuevo.");
            }
          } catch (err) {
            setError(textoError(err));
          }
        }}
      >
        <Alert tono="aviso">{p.motivo}</Alert>
        <Field label="PIN del dueño">
          <input className="pin" type="password" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </Field>
        {error && <Alert tono="error">{error}</Alert>}
        <Button type="submit" variante="primario" icono={ShieldCheck} atajo="Enter" disabled={!pin}>
          Autorizar
        </Button>
      </form>
    </Modal>
  );
}
