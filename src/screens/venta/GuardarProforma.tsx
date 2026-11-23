// Guardar la venta de la pestaña como proforma (F11). Cliente opcional: el elegido en la venta o un
// nombre escrito (solo queda en esta proforma y se borra solo). La pestaña sigue abierta y ligada.
// Si ya estaba ligada y cambió, se guarda como versión nueva (P-0012-2).
import { FileText } from "lucide-react";
import { useState } from "react";
import Mensaje from "../../components/Mensaje";
import Modal from "../../components/Modal";
import { monto } from "../../lib/tickets";
import type { EstadoEspera } from "../../tipos";
import Button from "../../ui/Button";
import Field from "../../ui/Field";
import { useEnvio } from "../../ui/useEnvio";

export default function GuardarProforma(p: {
  estado: EstadoEspera;
  total: number;
  /** Ya ligada a una proforma: se guarda una versión nueva de esa. */
  version?: string;
  onGuardar(nombre: string | null): Promise<void>;
  onCerrar(): void;
}) {
  const [nombre, setNombre] = useState(p.estado.nombreTiquete ?? "");
  const { ocupado, error, enviar } = useEnvio();
  return (
    <Modal titulo={p.version ? `Nueva versión de ${p.version}` : "Guardar como proforma"} onCerrar={p.onCerrar} ancho={480}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void enviar(() => p.onGuardar(p.estado.cliente ? null : nombre.trim() || null));
        }}
      >
        <p>
          Total <strong>{monto(p.total)}</strong>. No es una venta: no cobra, no abre la gaveta ni toca el inventario.
        </p>
        {p.estado.cliente ? (
          <p>
            Cliente: <strong>{p.estado.cliente.nombre}</strong>
          </p>
        ) : (
          <Field label="Nombre para la proforma (opcional)" ayuda="Solo sale en esta proforma; no se guarda como cliente.">
            <input autoFocus value={nombre} maxLength={80} onChange={(e) => setNombre(e.target.value)} />
          </Field>
        )}
        <Mensaje error={error} />
        <div className="fila-botones">
          <Button type="submit" variante="primario" icono={FileText} atajo="Enter" autoFocus={!!p.estado.cliente} disabled={ocupado}>
            Guardar e imprimir
          </Button>
        </div>
      </form>
    </Modal>
  );
}
