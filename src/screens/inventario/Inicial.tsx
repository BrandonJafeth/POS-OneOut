// Datos iniciales: los productos importados empiezan en 0 y sin costo. Dos caminos: contar por
// departamento (pestaña Conteo) o cargar un CSV (código o id, existencia, costo opcional) con
// vista previa y "todo o nada". Rust revisa cada fila otra vez y lo anota como "inventario inicial".
import { ClipboardCheck, FileUp, Upload } from "lucide-react";
import { useState } from "react";
import Mensaje, { textoError } from "../../components/Mensaje";
import PinDueno from "../../components/PinDueno";
import { filasIniciales, inventarioInicial, type FilaInicial, type PrevistaInicial } from "../../db/inventario";
import { leerCsv } from "../../lib/csv";
import { monto } from "../../lib/tickets";
import Alert from "../../ui/Alert";
import Button from "../../ui/Button";
import Field from "../../ui/Field";
import { useToast } from "../../ui/Toast";

export default function Inicial(p: { onConteo(): void }) {
  const toast = useToast();
  const [filas, setFilas] = useState<FilaInicial[]>([]);
  const [prevista, setPrevista] = useState<PrevistaInicial[]>([]);
  const [pidePin, setPidePin] = useState(false);
  const [error, setError] = useState("");
  const errores = prevista.filter((x) => x.error);

  async function leer(archivo: File) {
    setError("");
    setPrevista([]);
    try {
      const f = filasIniciales(leerCsv(await archivo.text()).filas);
      setFilas(f);
      setPrevista(await inventarioInicial(f, false));
    } catch (e) {
      setError(textoError(e));
    }
  }

  return (
    <>
      <section className="card">
        <h2>Contar por departamento</h2>
        <p>Lo más seguro: cuente un departamento a la vez. Puede guardar a medias.</p>
        <Button icono={ClipboardCheck} onClick={p.onConteo}>
          Ir al conteo físico
        </Button>
      </section>
      <section className="card">
        <h2>Cargar desde un archivo CSV</h2>
        <p className="muted">Columnas: «codigo» (o «id»), «existencia» y, si quiere, «costo» en colones. Si una sola fila tiene error, no se carga nada.</p>
        <Field label="Archivo CSV">
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && void leer(e.target.files[0])} />
        </Field>
        <Mensaje error={error} />
        {prevista.length > 0 && (
          <>
            {errores.length > 0 ? (
              <Alert tono="error" titulo={`${errores.length} fila(s) con error`}>
                Corríjalas en el archivo y vuelva a elegirlo.
              </Alert>
            ) : (
              <Alert tono="ok" titulo={`${prevista.length} fila(s) listas`}>
                Revise y cargue.
              </Alert>
            )}
            <table className="tbl">
              <thead>
                <tr>
                  <th className="num">Fila</th>
                  <th>Producto</th>
                  <th className="num">Hoy</th>
                  <th className="num">Nueva</th>
                  <th className="num">Costo</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {[...errores, ...prevista.filter((x) => !x.error)].slice(0, 500).map((x) => (
                  <tr key={x.fila}>
                    <td className="num">{x.fila}</td>
                    <td>{x.nombre || "—"}</td>
                    <td className="num">{x.actual}</td>
                    <td className="num">{x.nueva ?? "—"}</td>
                    <td className="num">{x.costo == null ? "—" : monto(x.costo)}</td>
                    <td>{x.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {prevista.length > 500 && <p className="muted">Se muestran 500 de {prevista.length} filas (los errores primero).</p>}
            <Button variante="primario" icono={Upload} disabled={errores.length > 0} onClick={() => setPidePin(true)}>
              Cargar inventario inicial
            </Button>
          </>
        )}
        {!prevista.length && !error && (
          <p className="muted">
            <FileUp size={16} aria-hidden /> Elija el archivo para ver la vista previa.
          </p>
        )}
      </section>
      {pidePin && (
        <PinDueno
          motivo={`Se carga la existencia de ${prevista.length} producto(s) como inventario inicial.`}
          onCerrar={() => setPidePin(false)}
          onPin={async (pin) => {
            await inventarioInicial(filas, true, pin);
            setPidePin(false);
            setFilas([]);
            setPrevista([]);
            toast.ok("Inventario inicial cargado.");
          }}
        />
      )}
    </>
  );
}
