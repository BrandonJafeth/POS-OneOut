// Caja y cierre (dueño y técnico): turno compartido, casillas del cierre Z por defecto, "no venta"
// y umbrales. Las claves caja_* solo las cambian el dueño y el técnico (lo revisa Rust).
import { CopyCheck, Save } from "lucide-react";
import { useState } from "react";
import { useSesion } from "../app/sesion";
import { textoError } from "../components/Mensaje";
import { guardarConfig } from "../db/config";
import { conMiles, leerMontoEntero } from "../lib/texto";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import CampoMonto from "../ui/CampoMonto";
import Field from "../ui/Field";
import { useToast } from "../ui/Toast";
import Consecutivo from "./caja/Consecutivo";

export const AYUDA_TURNO_COMPARTIDO =
  "Si varias personas usan la misma caja en el mismo turno, el faltante o sobrante es de la caja y no se puede atribuir a una persona. El cierre Z dice qué vendió cada uno, pero el efectivo es uno solo. Si quiere controlar el efectivo de cada cajero por separado, desactive esta opción y cada uno abre y cierra su propio turno.";

const DIAS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

export default function ConfigCaja() {
  const { actor, config, recargarConfig } = useSesion();
  const [error, setError] = useState("");
  const toast = useToast();
  const [motivos, setMotivos] = useState(config.caja_no_venta_motivos.join("\n"));
  const [umbralNv, setUmbralNv] = useState(String(config.caja_no_venta_umbral));
  const [quitar, setQuitar] = useState(conMiles(String(config.caja_quitar_linea_bitacora)));
  // La hora que más se repite: punto de partida para "misma hora para todos".
  const horas = config.caja_horario.filter((x): x is string => x !== null);
  const cuenta = (h: string) => horas.filter((x) => x === h).length;
  const [todos, setTodos] = useState([...horas].sort((a, b) => cuenta(b) - cuenta(a))[0] ?? "18:30");

  async function guardar(cambios: Record<string, unknown>, ok = "Guardado.") {
    setError("");
    try {
      for (const [k, v] of Object.entries(cambios)) await guardarConfig(actor, k, v);
      await recargarConfig();
      toast.ok(ok);
    } catch (e) {
      setError(textoError(e));
    }
  }

  const listaMotivos = motivos
    .split(/\r?\n/)
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, 12);

  return (
    <div className="screen">
      <h1>Caja y cierre</h1>
      {error && <Alert tono="error">{error}</Alert>}

      <Consecutivo />
      <section className="card">
        <h2>Turno de caja</h2>
        <label className="opcion">
          <input type="checkbox" checked={config.caja_turno_compartido} onChange={(e) => void guardar({ caja_turno_compartido: e.target.checked })} />
          <span>
            <strong>Permitir que otros usuarios usen un turno abierto por otro</strong>
            <span className="ayuda">{AYUDA_TURNO_COMPARTIDO}</span>
          </span>
        </label>
        <h3>Días de trabajo y hora de cierre</h3>
        <p className="ayuda">
          Ponga la hora real en que cierra el negocio. Mientras la caja siga abierta se vende normal, aunque ya pasó la hora.
        </p>
        <div className="row horario-todos">
          <Field label="Misma hora para todos los días de trabajo" ayuda="Después cambie solo el día que sea distinto." className="sin-margen">
            <input type="time" step={60} value={todos} onChange={(e) => e.target.value && setTodos(e.target.value)} />
          </Field>
          <Button
            icono={CopyCheck}
            disabled={horas.every((h) => h === todos)}
            onClick={() => void guardar({ caja_horario: config.caja_horario.map((x) => (x === null ? null : todos)) }, "Hora aplicada a todos los días de trabajo.")}
          >
            Aplicar a todos
          </Button>
        </div>
        <table className="tbl tbl-compacta horario">
          <tbody>
            {DIAS.map((d, i) => {
              const h = config.caja_horario[i] ?? null;
              const cambiar = (v: string | null) => {
                const nuevo = config.caja_horario.map((x, j) => (j === i ? v : x));
                if (nuevo.every((x) => x === null)) return setError("Tiene que haber al menos un día de trabajo.");
                void guardar({ caja_horario: nuevo });
              };
              return (
                <tr key={d}>
                  <th scope="row">{d}</th>
                  <td>
                    <label className="opcion sin-margen">
                      <input type="checkbox" checked={h !== null} onChange={(e) => cambiar(e.target.checked ? todos : null)} />
                      <span>Se trabaja</span>
                    </label>
                  </td>
                  <td>
                    {h !== null ? (
                      <label>
                        <span className="muted">Cierra a las </span>
                        <input type="time" step={60} value={h} aria-label={`Hora de cierre del ${d.toLowerCase()}`} onChange={(e) => e.target.value && cambiar(e.target.value)} />
                      </label>
                    ) : (
                      <span className="muted">No se trabaja</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="ayuda">
          Si ya cerró la caja y llega un cliente: abierta otra vez antes de la hora de cierre, se pregunta si cuenta para hoy o para el siguiente día de
          trabajo; abierta después, cuenta para el siguiente día. En un día que no se trabaja, abrir la caja pide confirmar. Cambiar el horario no mueve las
          cajas ya abiertas o cerradas.
        </p>
      </section>

      <section className="card">
        <h2>Cierre Z</h2>
        <p className="muted">Casillas que aparecen marcadas al cerrar la caja (se pueden cambiar en cada cierre).</p>
        <label className="opcion">
          <input type="checkbox" checked={config.caja_z_detalle_completo} onChange={(e) => void guardar({ caja_z_detalle_completo: e.target.checked })} />
          <span>
            <strong>Detalle completo</strong>
            <span className="ayuda">Todas las ventas por departamento, una línea por producto y forma de pago.</span>
          </span>
        </label>
        <label className="opcion">
          <input type="checkbox" checked={config.caja_z_por_departamento} onChange={(e) => void guardar({ caja_z_por_departamento: e.target.checked })} />
          <span>
            <strong>Un tiquete aparte por departamento</strong>
            <span className="ayuda">Además del Z, un comprobante para cada departamento con ventas, para entregar o archivar por separado.</span>
          </span>
        </label>
      </section>

      <section className="card">
        <h2>Abrir la gaveta sin venta</h2>
        <div className="row arriba">
          <Field label="Motivos (uno por línea)" ayuda="Los que empiezan con «Otro» piden escribir el motivo." flex={1}>
            <textarea rows={4} value={motivos} onChange={(e) => setMotivos(e.target.value)} />
          </Field>
          <Field label="Límite por turno" ayuda="Aperturas sin venta: al llegar, avisa en el cierre; pasado, el cajero necesita el PIN del dueño. 0 = sin límite.">
            <input className="small" inputMode="numeric" value={umbralNv} onChange={(e) => setUmbralNv(e.target.value.replace(/\D/g, ""))} />
          </Field>
        </div>
        <div>
          <Button
            variante="primario"
            icono={Save}
            disabled={!listaMotivos.length}
            onClick={() => void guardar({ caja_no_venta_motivos: listaMotivos, caja_no_venta_umbral: Number(umbralNv || 0) })}
          >
            Guardar
          </Button>
        </div>
      </section>

      <section className="card">
        <h2>Ventas abiertas</h2>
        <Field label="Anotar en la bitácora al quitar una línea desde" ayuda="El cajero puede quitar líneas antes de cobrar; desde este monto queda anotado para que usted lo vea. 0 = nunca.">
          <CampoMonto valor={quitar} onCambio={setQuitar} />
        </Field>
        {!leerMontoEntero(quitar) && <Alert tono="aviso">Con 0 no queda anotada ninguna línea quitada y el cierre Z no las muestra en «Control por usuario».</Alert>}
        <div>
          <Button variante="primario" icono={Save} onClick={() => void guardar({ caja_quitar_linea_bitacora: leerMontoEntero(quitar) ?? 0 })}>
            Guardar
          </Button>
        </div>
      </section>
    </div>
  );
}
