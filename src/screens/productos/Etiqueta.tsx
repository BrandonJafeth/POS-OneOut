import { useMemo, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import Mensaje, { textoError } from "../../components/Mensaje";
import Papel from "../../components/Papel";
import { ajustesImpresora, etiquetaProducto } from "../../lib/impresion";
import { printRaw } from "../../lib/printerApi";
import { interpret } from "../../lib/preview";
import { useToast } from "../../ui/Toast";

/** Vista previa e impresión de la etiqueta (nombre, precio, EAN-13) en la POS-58. */
export default function Etiqueta(p: { producto: { nombre: string; precio: number }; codigo: string; onCerrar(): void }) {
  const { config } = useSesion();
  const [copias, setCopias] = useState(1);
  const [error, setError] = useState("");
  const toast = useToast();
  const [ocupado, setOcupado] = useState(false);
  const ajustes = ajustesImpresora(config);
  const muestra = useMemo(() => interpret(etiquetaProducto(p.producto, p.codigo, ajustes).bytes), [p.producto, p.codigo, config]);

  async function imprimir() {
    setError("");
    if (!config.impresora_nombre) return setError("No hay impresora elegida. El técnico la elige en Técnico → Hardware.");
    setOcupado(true);
    try {
      await printRaw(config.impresora_nombre, etiquetaProducto(p.producto, p.codigo, ajustes, copias).bytes);
      toast.ok(`Enviado a ${config.impresora_nombre}.`);
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
