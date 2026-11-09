// Primer número de tiquete: para seguir después del último del sistema anterior (sin repetir
// números ya entregados a clientes). Rust solo lo acepta antes de la primera venta de la caja.
import { Hash } from "lucide-react";
import { useEffect, useState } from "react";
import { textoError } from "../../components/Mensaje";
import { obtenerCaja } from "../../db/cajas";
import { invocar } from "../../lib/invocar";
import Alert from "../../ui/Alert";
import Button from "../../ui/Button";
import Field from "../../ui/Field";
import { useToast } from "../../ui/Toast";

export default function Consecutivo() {
  const toast = useToast();
  const [actual, setActual] = useState<number | null>(null);
  const [numero, setNumero] = useState("");
  const [error, setError] = useState("");
  const cargar = () => obtenerCaja().then((c) => c && (setActual(c.consecutivoSiguiente), setNumero(String(c.consecutivoSiguiente))), (e) => setError(textoError(e)));
  useEffect(() => void cargar(), []);
  return (
    <section className="card">
      <h2>Número del próximo tiquete</h2>
      <p className="muted">
        Si el negocio venía de otro sistema, ponga el número que sigue al último tiquete que entregó, para no repetir números. Solo se puede
        cambiar antes de la primera venta y queda en la bitácora.
      </p>
      <form
        className="row abajo"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await invocar("caja_consecutivo", { numero: Number(numero) });
            toast.ok(`El próximo tiquete será el ${numero}.`);
            await cargar();
          } catch (err) {
            setError(textoError(err));
          }
        }}
      >
        <Field label="Próximo tiquete">
          <input inputMode="numeric" className="mono" value={numero} onChange={(e) => setNumero(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Button type="submit" icono={Hash} disabled={!numero || Number(numero) === actual}>
          Guardar
        </Button>
      </form>
      {error && <Alert tono="error">{error}</Alert>}
    </section>
  );
}
