import { useEffect, useMemo, useState } from "react";
import Modal from "../../components/Modal";
import Mensaje, { textoError } from "../../components/Mensaje";
import Papel from "../../components/Papel";
import { aSettings, ajustesDe, imprimirDocumento, type AjustesImpresora } from "../../db/impresoras";
import { etiquetaProducto } from "../../lib/impresion";
import { interpret } from "../../lib/preview";
import { DEFAULT_SETTINGS } from "../../lib/tickets";
import { useToast } from "../../ui/Toast";

/** Vista previa e impresión de la etiqueta (nombre, precio, EAN-13) en la impresora de etiquetas. */
export default function Etiqueta(p: { producto: { nombre: string; precio: number }; codigo: string; onCerrar(): void }) {
  const [copias, setCopias] = useState(1);
  const [error, setError] = useState("");
  const toast = useToast();
  const [ocupado, setOcupado] = useState(false);
  const [impresora, setImpresora] = useState<AjustesImpresora | null | undefined>(undefined);
  useEffect(() => {
    ajustesDe("etiqueta").then(setImpresora, (e) => setError(textoError(e)));
  }, []);
  const ajustes = impresora ? aSettings(impresora) : DEFAULT_SETTINGS;
  const muestra = useMemo(() => interpret(etiquetaProducto(p.producto, p.codigo, ajustes).bytes), [p.producto, p.codigo, impresora]);

  async function imprimir() {
    setError("");
    if (!impresora) return setError("No hay impresora para etiquetas. El dueño o el técnico la asigna en Administración → Impresoras.");
    setOcupado(true);
    try {
      const nombre = await imprimirDocumento("etiqueta", etiquetaProducto(p.producto, p.codigo, ajustes, copias).bytes);
      toast.ok(`Enviado a ${nombre}.`);
    } catch (e) {
      setError(textoError(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Modal titulo="Imprimir etiqueta" onCerrar={p.onCerrar} ancho={420}>
      <Papel items={muestra} />
      <div className="row" style={{ marginTop: 12 }}>
        <label>
          Copias{" "}
          <input className="small" type="number" min={1} max={50} value={copias} onChange={(e) => setCopias(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
        </label>
        <button className="primary" disabled={ocupado} onClick={imprimir}>
          Imprimir
        </button>
      </div>
      <Mensaje error={error} />
    </Modal>
  );
}
