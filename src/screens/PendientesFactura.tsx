// Ventas que pidieron factura electrónica (se hace en el sistema de facturación externo).
// Los botones "Copiar" llevan el dato al portapapeles; la bitácora anota qué campo, no el valor.
import { CheckCircle2, Copy, FileCheck2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import Modal from "../components/Modal";
import { datoParaFactura, type CampoFactura } from "../db/clientes";
import { marcarFacturaEmitida, pendientesFactura, type PendienteFactura } from "../db/ventas";
import { copiar } from "../lib/copiar";
import { monto } from "../lib/tickets";
import Button from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import Field from "../ui/Field";
import { useToast } from "../ui/Toast";

export default function PendientesFactura() {
  const { actor } = useSesion();
  const [lista, setLista] = useState<PendienteFactura[] | null>(null); // null: todavía cargando
  const [marcando, setMarcando] = useState<PendienteFactura | null>(null);
  const [error, setError] = useState("");
  const toast = useToast();

  const cargar = () => pendientesFactura(actor).then(setLista, (e) => setError(textoError(e)));
  useEffect(() => void cargar(), []);

  async function copiarDato(p: PendienteFactura, campo: CampoFactura) {
    setError("");
    try {
      const v = await datoParaFactura(actor, p.clienteId, campo);
      if (!v) return setError("El cliente no tiene ese dato");
      await copiar(v);
      toast.ok(`${campo === "nombre" ? "Nombre" : campo === "cedula" ? "Cédula" : "Correo"} copiado.`);
    } catch (e) {
      setError(textoError(e));
    }
  }

  return (
    <div className="screen">
      <h1>Facturas pendientes</h1>
      <p className="muted" style={{ marginTop: -8 }}>Hágalas en el sistema de facturación y márquelas aquí.</p>
      <Mensaje error={error} />
      <section className="card">
        {!lista ? (
          <p className="muted">Cargando…</p>
        ) : lista.length === 0 ? (
          <EmptyState icono={CheckCircle2} titulo="No hay facturas pendientes" texto="Cuando una venta pida factura electrónica, aparecerá aquí hasta que la marque como emitida." />
        ) : (
        <table className="tbl tbl-grande">
          <thead>
            <tr>
              <th>Tiquete</th>
              <th>Fecha</th>
              <th>Cliente</th>
              <th className="num">Total</th>
              <th>Copiar para el facturador</th>
              <th>
                <span className="sr-only">Marcar</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lista.map((p) => (
              <tr key={p.ventaId}>
                <td className="mono">{p.numero}</td>
                <td style={{ whiteSpace: "nowrap" }}>{new Date(p.fecha).toLocaleString("es-CR", { dateStyle: "short", timeStyle: "short" })}</td>
                <td>
                  <strong>{p.cliente}</strong>
                  {p.cedula && <div className="muted">Céd. {p.cedula}</div>}
                </td>
                <td className="num">{monto(p.total)}</td>
                <td>
                  <div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>
                    <Button icono={Copy} onClick={() => copiarDato(p, "nombre")} aria-label={`Copiar nombre de ${p.cliente}`}>
                      Nombre
                    </Button>
                    <Button icono={Copy} disabled={!p.cedula} onClick={() => copiarDato(p, "cedula")} aria-label={`Copiar cédula de ${p.cliente}`}>
                      Cédula
                    </Button>
                    <Button icono={Copy} disabled={!p.tieneCorreo} onClick={() => copiarDato(p, "correo")} aria-label={`Copiar correo de ${p.cliente}`}>
                      Correo
                    </Button>
                  </div>
                </td>
                <td>
                  <Button variante="primario" icono={FileCheck2} onClick={() => setMarcando(p)}>
                    Marcar emitida
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </section>
      {marcando && (
        <MarcarEmitida
          pendiente={marcando}
          onCerrar={() => setMarcando(null)}
          onGuardar={async (ref) => {
            await marcarFacturaEmitida(actor, marcando.ventaId, ref);
            setMarcando(null);
            toast.ok(`Tiquete ${marcando.numero}: factura registrada.`);
            await cargar();
          }}
        />
      )}
    </div>
  );
}

function MarcarEmitida(p: { pendiente: PendienteFactura; onCerrar(): void; onGuardar(ref: string): Promise<void> }) {
  const [ref, setRef] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal titulo={`Factura del tiquete ${p.pendiente.numero}`} onCerrar={p.onCerrar} ancho={460}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await p.onGuardar(ref);
          } catch (err) {
            setError(textoError(err));
          }
        }}
      >
        <Field label="Número consecutivo o clave de la factura electrónica" ayuda="Cópielo del sistema de facturación.">
          <input autoFocus className="mono" value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
        <Mensaje error={error} />
        <Button type="submit" variante="primario" icono={Save} disabled={!ref.trim()}>
          Guardar
        </Button>
      </form>
    </Modal>
  );
}
