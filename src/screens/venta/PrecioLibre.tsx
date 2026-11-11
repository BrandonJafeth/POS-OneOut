import { useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import { leerMontoEntero } from "../../lib/texto";
import { ulid } from "../../lib/ulid";
import type { Departamento, LineaEspera } from "../../tipos";
import Button from "../../ui/Button";
import Alert from "../../ui/Alert";
import CampoMonto from "../../ui/CampoMonto";
import Field from "../../ui/Field";

/** Venta simple (precio libre): monto + departamento con un toque, descripción opcional. */
/** Una venta simple desde aquí suele ser un cero de más; se confirma con un segundo Agregar. */
const MONTO_GRANDE = 50_000;

export default function PrecioLibre(p: { departamentos: Departamento[]; onAgregar(l: LineaEspera): void; onCerrar(): void }) {
  const { config } = useSesion();
  const [monto, setMonto] = useState("");
  const [depto, setDepto] = useState<string | null>(null);
  const [descripcion, setDescripcion] = useState("");
  const [errores, setErrores] = useState<{ monto?: string; depto?: string }>({});
  const [revisado, setRevisado] = useState(""); // monto grande que ya se avisó (segundo Agregar lo acepta)
  const d = p.departamentos.find((x) => x.id === depto);

  return (
    <Modal titulo="Venta simple" onCerrar={p.onCerrar} ancho={560}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const m = leerMontoEntero(monto);
          const err = { monto: m ? undefined : "Escriba el monto en colones.", depto: d ? undefined : "Elija un departamento." };
          setErrores(err);
          if (!m || !d) return;
          if (m >= MONTO_GRANDE && revisado !== monto) return setRevisado(monto);
          p.onAgregar({
            id: ulid(),
            productoId: null,
            codigo: null,
            descripcion: descripcion.trim() || d.nombre,
            departamentoId: d.id,
            cantidad: 1,
            precioUnitario: m,
            descuento: 0,
            tasaIva: config.producto_tasa_iva_defecto, // la del negocio, no un 13 fijo
            exento: false,
          });
        }}
      >
        <Field label="Monto" error={errores.monto}>
          <CampoMonto grande autoFocus valor={monto} onCambio={setMonto} />
        </Field>
        {revisado !== "" && revisado === monto && (
          <Alert tono="aviso">¢{monto} es mucho para una venta simple. Revise el monto; si está bien, presione Agregar otra vez.</Alert>
        )}
        <div className="campo">
          <span id="depto-libre">Departamento</span>
          <div className="chips" role="radiogroup" aria-labelledby="depto-libre">
            {p.departamentos.map((x) => (
              <button
                type="button"
                key={x.id}
                role="radio"
                aria-checked={x.id === depto}
                className="tab"
                aria-pressed={x.id === depto}
                onClick={() => setDepto(x.id)}
              >
                {x.nombre}
              </button>
            ))}
          </div>
          {errores.depto && <span className="campo-error">{errores.depto}</span>}
        </div>
        <Field label="Descripción (opcional)" ayuda={d ? `Si la deja vacía, en el tiquete sale «${d.nombre}».` : undefined}>
          <input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
        </Field>
        <Button type="submit" variante="primario" tamano="lg" atajo="Enter">
          Agregar
        </Button>
      </form>
    </Modal>
  );
}
