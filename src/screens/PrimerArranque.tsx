import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { textoError } from "../components/Mensaje";
import { crearTecnicoInicial, iniciarSesionTecnico } from "../db/usuarios";
import { PIN_VALIDO } from "../lib/bloqueo";
import type { Usuario } from "../tipos";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Field from "../ui/Field";

/** Solo aparece cuando la base está recién creada: crea el usuario técnico. */
export default function PrimerArranque({ onListo }: { onListo(u: Usuario, minutosInactividad: number): void }) {
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!PIN_VALIDO.test(pin) || pin.length < 6) return setError("El PIN debe tener de 6 a 12 números. Escríbalo de nuevo.");
    if (/^(\d)\1+$/.test(pin)) return setError("El PIN no puede ser un mismo número repetido.");
    if (pin !== pin2) return setError("Los dos PIN no son iguales. Escríbalos de nuevo.");
    setOcupado(true);
    try {
      await crearTecnicoInicial(pin);
      const r = await iniciarSesionTecnico(pin);
      if (!r.ok) throw new Error("No se pudo entrar con el PIN nuevo");
      onListo(r.usuario, r.minutosInactividad);
    } catch (err) {
      setError(textoError(err));
      setOcupado(false);
    }
  }

  return (
    <main className="centro">
      <form className="card login-card" onSubmit={crear}>
        <h1>Primer arranque</h1>
        <p className="muted">
          Cree el PIN del usuario <strong>técnico</strong>. Con él se configura el negocio y se crean los usuarios dueño y cajero. Guárdelo en
          un lugar seguro: no se muestra en la pantalla de entrada.
        </p>
        <Field label="PIN técnico" ayuda="De 6 a 12 números, que no sean todos iguales.">
          <input className="pin" type="password" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Field label="Repita el PIN">
          <input className="pin" type="password" inputMode="numeric" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))} />
        </Field>
        {error && <Alert tono="error">{error}</Alert>}
        <Button type="submit" variante="primario" tamano="lg" icono={ShieldCheck} ancho disabled={ocupado}>
          {ocupado ? "Creando…" : "Crear usuario técnico"}
        </Button>
      </form>
    </main>
  );
}
