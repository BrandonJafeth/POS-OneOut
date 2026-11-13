import { useRef, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import { conMiles, leerMontoEntero } from "../../lib/texto";
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
  const [cantidad, setCantidad] = useState("1");
  const [depto, setDepto] = useState<string | null>(null);
  const [descripcion, setDescripcion] = useState("");
  const [errores, setErrores] = useState<{ monto?: string; cantidad?: string; depto?: string }>({});
  const [revisado, setRevisado] = useState(""); // monto grande que ya se avisó (segundo Agregar lo acepta)
  const d = p.departamentos.find((x) => x.id === depto);
  // Un doble Enter no agrega la línea dos veces (el diálogo se cierra al agregar).
  const agregada = useRef(false);

  return (
    <Modal titulo="Venta simple" onCerrar={p.onCerrar} ancho={560}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const m = leerMontoEntero(monto);
          const n = Number(cantidad);
          const cantOk = Number.isInteger(n) && n >= 1 && n <= 9999;
          const err = { monto: m ? undefined : "Escriba el monto en colones.", cantidad: cantOk ? undefined : "Cantidad de 1 a 9999.", depto: d ? undefined : "Elija un departamento." };
          setErrores(err);
          if (!m || !d || !cantOk) return;
          const clave = `${monto}×${n}`;
          if (m * n >= MONTO_GRANDE && revisado !== clave) return setRevisado(clave);
          if (agregada.current) return;
          agregada.current = true;
          p.onAgregar({
            id: ulid(),
            productoId: null,
            codigo: null,
            descripcion: descripcion.trim() || d.nombre,
            departamentoId: d.id,
            cantidad: n,
            precioUnitario: m,
            descuento: 0,
            tasaIva: config.producto_tasa_iva_defecto, // la del negocio, no un 13 fijo
            exento: false,
          });
        }}
      >
        <div className="row">
          <Field label="Precio de cada uno" error={errores.monto}>
            <CampoMonto grande autoFocus valor={monto} onCambio={setMonto} />
          </Field>
          <Field label="Cantidad" error={errores.cantidad}>
            <input className="small" inputMode="numeric" value={cantidad} onFocus={(e) => e.target.select()} onChange={(e) => setCantidad(e.target.value.replace(/\D/g, "").slice(0, 4))} />
          </Field>
        </div>
        {Number(cantidad) > 1 && leerMontoEntero(monto) ? <p className="muted">Total: ¢{conMiles(String(leerMontoEntero(monto)! * Number(cantidad)))}</p> : null}
        {revisado !== "" && revisado === `${monto}×${Number(cantidad)}` && (
          <Alert tono="aviso">Es mucho para una venta simple. Revise el monto y la cantidad; si está bien, presione Agregar otra vez.</Alert>
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
