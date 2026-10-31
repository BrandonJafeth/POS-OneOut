import { useState } from "react";
import Modal from "../../components/Modal";
import { leerMontoEntero } from "../../lib/texto";
import { ulid } from "../../lib/ulid";
import type { Departamento, LineaEspera } from "../../tipos";
import Button from "../../ui/Button";
import CampoMonto from "../../ui/CampoMonto";
import Field from "../../ui/Field";

/** Venta simple (precio libre): monto + departamento con un toque, descripción opcional. */
export default function PrecioLibre(p: { departamentos: Departamento[]; onAgregar(l: LineaEspera): void; onCerrar(): void }) {
  const [monto, setMonto] = useState("");
  const [depto, setDepto] = useState<string | null>(null);
  const [descripcion, setDescripcion] = useState("");
  const [errores, setErrores] = useState<{ monto?: string; depto?: string }>({});
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
          p.onAgregar({
            id: ulid(),
            productoId: null,
            codigo: null,
            descripcion: descripcion.trim() || d.nombre,
            departamentoId: d.id,
            cantidad: 1,
            precioUnitario: m,
            descuento: 0,
            tasaIva: 13,
            exento: false,
          });
        }}
      >
        <Field label="Monto" error={errores.monto}>
          <CampoMonto grande autoFocus valor={monto} onCambio={setMonto} />
        </Field>
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
