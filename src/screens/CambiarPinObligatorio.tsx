import { KeyRound, LogOut } from "lucide-react";
import { useState } from "react";
import { textoError } from "../components/Mensaje";
import { cambiarPin, pinMinimo } from "../db/usuarios";
import type { Usuario } from "../tipos";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Field from "../ui/Field";

/**
 * Primera entrada con un PIN puesto por otra persona (o más corto que el mínimo de su rol):
 * hasta cambiarlo, Rust no deja hacer nada más.
 */
export default function CambiarPinObligatorio(p: { usuario: Usuario; onListo(): void; onSalir(): void }) {
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const min = pinMinimo(p.usuario.rol);

  const motivo = p.usuario.pinCorto
    ? `Su PIN actual tiene menos de ${min} dígitos, que es el mínimo requerido para su rol. Escoja uno nuevo.`
    : "Por seguridad, debe cambiar el PIN temporal que le asignaron antes de continuar.";

  return (
    <main className="centro">
      <form
        className="card login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          if (pin !== pin2) return setError("Los dos PIN no son iguales.");
          setOcupado(true);
          try {
            await cambiarPin({ id: p.usuario.id, rol: p.usuario.rol }, p.usuario.id, pin);
            p.onListo();
          } catch (err) {
            setError(textoError(err));
            setOcupado(false);
          }
        }}
      >
        <h1>Cambie su PIN</h1>
        <p className="muted">
          Hola, <strong>{p.usuario.nombre}</strong>. {motivo}
        </p>
        <Field label="PIN nuevo" ayuda={`De ${min} a 12 números, que no sean todos iguales.`}>
          <input className="pin" type="password" inputMode="numeric" autoComplete="off" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Field label="Repita el PIN">
          <input className="pin" type="password" inputMode="numeric" autoComplete="off" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))} />
        </Field>
        {error && <Alert tono="error">{error}</Alert>}
        <div className="fila-botones">
          <Button icono={LogOut} onClick={p.onSalir}>
            Salir
          </Button>
          <span className="separador" />
          <Button type="submit" variante="primario" icono={KeyRound} disabled={ocupado || pin.length < min}>
            Guardar PIN
          </Button>
        </div>
      </form>
    </main>
  );
}
