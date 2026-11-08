// Reportes de inventario (dueño con permiso de reportes): bajo mínimo con cantidad sugerida
// (ajustable), inventario valorizado y movimientos por fecha y tipo. CSV sin fórmulas y PDF.
import { FileDown, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import Mensaje, { textoError } from "../../components/Mensaje";
import { NOMBRE_TIPO, rangoDias, reporteBajoMinimo, reporteMovimientos, reporteValorizado, type FilaBajoMinimo, type FilaKardex, type TipoMovimiento, type Valorizado } from "../../db/inventario";
import { CABECERA_KARDEX, exportarCsv, exportarPdf, filaKardex } from "../../lib/inventario";
import { monto } from "../../lib/tickets";
import Button from "../../ui/Button";
import Field from "../../ui/Field";
import { useToast } from "../../ui/Toast";

function Exportar(p: { nombre: string; titulo: string; cabecera: string[]; filas: (string | number)[][]; onError(m: string): void }) {
  const toast = useToast();
  const hacer = async (f: () => Promise<string>) => {
    try {
      toast.ok(`Guardado en ${await f()}`);
    } catch (e) {
      p.onError(textoError(e));
    }
  };
  return (
    <div className="row">
      <Button icono={FileDown} disabled={!p.filas.length} onClick={() => hacer(() => exportarCsv(p.nombre, [p.cabecera, ...p.filas]))}>
        CSV
      </Button>
      <Button icono={FileText} disabled={!p.filas.length} onClick={() => hacer(() => exportarPdf(p.nombre, p.titulo, p.cabecera, p.filas))}>
        PDF
      </Button>
    </div>
  );
}

export default function Reportes() {
  const [error, setError] = useState("");
  return (
    <>
      <Mensaje error={error} />
      <BajoMinimo onError={setError} />
      <ValorizadoReporte onError={setError} />
      <Movimientos onError={setError} />
    </>
  );
}

function BajoMinimo(p: { onError(m: string): void }) {
  const [filas, setFilas] = useState<FilaBajoMinimo[]>([]);
  const [pedir, setPedir] = useState<Record<string, string>>({});
  useEffect(() => void reporteBajoMinimo().then(setFilas, (e) => p.onError(textoError(e))), []);
  const cant = (f: FilaBajoMinimo) => pedir[f.productoId] ?? String(f.sugerido);
  return (
    <section className="card">
      <h2>Bajo mínimo</h2>
      <p className="muted">Sugerido = mínimo × 2 − existencia. Cámbielo antes de exportar si quiere.</p>
      {filas.length === 0 ? (
        <p className="muted">Ningún producto está en su mínimo o por debajo.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Producto</th>
              <th>Departamento</th>
              <th className="num">Existencia</th>
              <th className="num">Mínimo</th>
              <th className="num">Pedir</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.productoId}>
                <td>{f.nombre}</td>
                <td>{f.departamento}</td>
                <td className="num">{f.existencia}</td>
                <td className="num">{f.minimo}</td>
                <td className="num">
                  <input className="small" inputMode="numeric" aria-label={`Cantidad a pedir de ${f.nombre}`} value={cant(f)} onChange={(e) => setPedir({ ...pedir, [f.productoId]: e.target.value.replace(/\D/g, "") })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Exportar nombre="inventario-bajo-minimo" titulo="Productos bajo mínimo" cabecera={["Producto", "Departamento", "Existencia", "Mínimo", "Pedir"]} filas={filas.map((f) => [f.nombre, f.departamento, f.existencia, f.minimo, cant(f)])} onError={p.onError} />
    </section>
  );
}

function ValorizadoReporte(p: { onError(m: string): void }) {
  const [v, setV] = useState<Valorizado | null>(null);
  useEffect(() => void reporteValorizado().then(setV, (e) => p.onError(textoError(e))), []);
  if (!v) return null;
  const filas: (string | number)[][] = [...v.porDepartamento.map((d) => [d.departamento, d.unidades, d.valor]), ["TOTAL", "", v.total]];
  return (
    <section className="card">
      <h2>Inventario valorizado</h2>
      <p className="muted">Existencia × último costo. Lo negativo cuenta como cero.</p>
      <table className="tbl">
        <thead>
          <tr>
            <th>Departamento</th>
            <th className="num">Unidades</th>
            <th className="num">Valor</th>
          </tr>
        </thead>
        <tbody>
          {v.porDepartamento.map((d) => (
            <tr key={d.departamento}>
              <td>{d.departamento}</td>
              <td className="num">{d.unidades}</td>
              <td className="num">{monto(d.valor)}</td>
            </tr>
          ))}
          <tr>
            <td>
              <strong>Total</strong>
            </td>
            <td />
            <td className="num">
              <strong>{monto(v.total)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      {v.sinCosto.length > 0 && (
        <details>
          <summary>{v.sinCosto.length} producto(s) con existencia y sin costo (no entran en el total)</summary>
          <ul>
            {v.sinCosto.map((s, i) => (
              <li key={i}>
                {s.nombre} · {s.departamento} · {s.existencia}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Exportar
        nombre="inventario-valorizado"
        titulo="Inventario valorizado"
        cabecera={["Departamento", "Unidades", "Valor"]}
        filas={[...filas, ...(v.sinCosto.length ? [["Sin costo:", "", ""], ...v.sinCosto.map((s) => [s.nombre, s.existencia, ""])] : [])]}
        onError={p.onError}
      />
    </section>
  );
}

function Movimientos(p: { onError(m: string): void }) {
  const hoy = new Date().toLocaleDateString("sv-SE");
  const [desde, setDesde] = useState(hoy.slice(0, 8) + "01");
  const [hasta, setHasta] = useState(hoy);
  const [tipo, setTipo] = useState<TipoMovimiento | "">("");
  const [filas, setFilas] = useState<FilaKardex[]>([]);
  useEffect(() => {
    if (desde && hasta) reporteMovimientos(...rangoDias(desde, hasta), tipo || null).then(setFilas, (e) => p.onError(textoError(e)));
  }, [desde, hasta, tipo]);
  return (
    <section className="card">
      <h2>Movimientos</h2>
      <div className="row">
        <Field label="Desde">
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </Field>
        <Field label="Hasta">
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </Field>
        <Field label="Tipo">
          <select value={tipo} onChange={(e) => setTipo(e.target.value as TipoMovimiento | "")}>
            <option value="">Todos</option>
            {Object.entries(NOMBRE_TIPO).map(([id, t]) => (
              <option key={id} value={id}>
                {t}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="muted">{filas.length} movimiento(s).</p>
      <Exportar nombre={`inventario-movimientos-${desde}-${hasta}`} titulo={`Movimientos de inventario ${desde} a ${hasta}`} cabecera={CABECERA_KARDEX} filas={filas.map(filaKardex)} onError={p.onError} />
    </section>
  );
}
