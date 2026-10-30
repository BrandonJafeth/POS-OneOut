import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Field from "../ui/Field";
import { textoError } from "./Mensaje";
import Modal from "./Modal";

/**
 * Pide el PIN de un dueño para algo que se hace EN ESE MOMENTO (descuento alto, salida grande…).
 * El PIN va directo a la acción (`onPin`), que lo manda a Rust; aquí no se guarda nada.
 */
export default function PinDueno(p: { motivo: string; onPin(pin: string): Promise<void>; onCerrar(): void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  return (
    <Modal titulo="Autorización del dueño" onCerrar={p.onCerrar} ancho={440}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setOcupado(true);
          try {
            await p.onPin(pin);
          } catch (err) {
            setPin("");
            setError(textoError(err));
          } finally {
            setOcupado(false);
          }
        }}
      >
        <Alert tono="aviso">{p.motivo}</Alert>
        <Field label="PIN del dueño">
          <input className="pin" type="password" inputMode="numeric" autoComplete="off" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </Field>
        {error && <Alert tono="error">{error}</Alert>}
        <Button type="submit" variante="primario" icono={ShieldCheck} atajo="Enter" disabled={!pin || ocupado}>
          Autorizar
        </Button>
      </form>
    </Modal>
  );
}
