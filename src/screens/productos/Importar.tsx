// Importar productos desde el CSV de la web: elegir archivo → mapear categorías (la primera vez)
// → vista previa con conteos y errores → confirmar (una sola transacción).
import { useEffect, useMemo, useState } from "react";
import { useSesion } from "../../app/sesion";
import Mensaje, { textoError } from "../../components/Mensaje";
import { guardarConfig } from "../../db/config";
import { listarDepartamentos } from "../../db/departamentos";
import { aplicarImportacion, productosParaImportar } from "../../db/importacion";
import type { FuenteImportacion } from "../../lib/importar/fuente";
import { categoriasSinMapear, crearPlan, type Plan, type ProductoExistente } from "../../lib/importar/plan";
import { leerCsvWeb } from "../../lib/importar/web";
import { normalizar } from "../../lib/texto";
import { monto } from "../../lib/tickets";
import type { Departamento } from "../../tipos";

type Paso = "archivo" | "mapeo" | "vista" | "listo";

/** Sugerencia para una categoría nueva: el departamento cuyo nombre aparece en ella, si hay. */
function sugerir(categoria: string, deps: Departamento[], defecto: string): string {
  const c = normalizar(categoria);
  return deps.find((d) => c.includes(normalizar(d.nombre)))?.id ?? defecto;
}

export default function Importar({ onSalir }: { onSalir(): void }) {
  const { actor, config, recargarConfig } = useSesion();
  const [paso, setPaso] = useState<Paso>("archivo");
  const [deps, setDeps] = useState<Departamento[]>([]);
  const [archivo, setArchivo] = useState("");
  const [fuente, setFuente] = useState<FuenteImportacion | null>(null);
  const [existentes, setExistentes] = useState<ProductoExistente[]>([]);
  const [mapeo, setMapeo] = useState<Record<string, string>>(config.importacion_mapeo_categorias);
  const [resultado, setResultado] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    listarDepartamentos().then(setDeps, (e) => setError(textoError(e)));
  }, []);

  const defecto = config.departamento_defecto;
  const plan = useMemo<Plan | null>(
    () => (fuente ? crearPlan(fuente, existentes, mapeo, defecto) : null),
    [fuente, existentes, mapeo, defecto],
  );
  const categorias = useMemo(
    () => (fuente ? [...new Set(fuente.filas.map((f) => f.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es")) : []),
    [fuente],
  );

  async function elegir(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setError("");
    try {
      // File.text() decodifica UTF-8 (con o sin BOM).
      const fu = leerCsvWeb(await f.text());
      setArchivo(f.name);
      setFuente(fu);
      setExistentes(await productosParaImportar());
      const faltan = categoriasSinMapear(fu, mapeo);
      if (faltan.length) {
        setMapeo({ ...mapeo, ...Object.fromEntries(faltan.map((c) => [c, sugerir(c, deps, defecto)])) });
        setPaso("mapeo");
      } else setPaso("vista");
    } catch (err) {
      setError(textoError(err));
    }
  }

  async function guardarMapeo() {
    setError("");
    try {
      await guardarConfig(actor, "importacion_mapeo_categorias", mapeo);
      await recargarConfig();
      setPaso("vista");
    } catch (e) {
      setError(textoError(e));
    }
  }

  async function confirmar() {
    if (!plan) return;
    setOcupado(true);
    setError("");
    try {
      const r = await aplicarImportacion(actor, plan);
      setResultado(`Listo: ${r.creados} productos nuevos y ${r.actualizados} actualizados.`);
      setPaso("listo");
    } catch (e) {
      setError("No se importó nada (se deshizo todo): " + textoError(e));
    } finally {
      setOcupado(false);
    }
  }

  const nombreDep = (id: string) => deps.find((d) => d.id === id)?.nombre ?? "?";

  return (
    <div className="screen">
      <div className="row between">
        <h1>Importar productos</h1>
        <button onClick={onSalir}>Volver a productos</button>
      </div>
      <Mensaje error={error} />

      {paso === "archivo" && (
        <section className="card">
          <p>
            Archivo CSV exportado de la web con las columnas <strong>id, nombre, precio, categoria</strong> (separadas por coma o punto y
            coma). Si un producto ya se importó antes (mismo id), se actualizan su nombre y precio; si no, se crea.
          </p>
          <label className="boton-archivo">
            <input type="file" accept=".csv,text/csv" onChange={elegir} className="sr-only" />
            <span>Elegir archivo CSV…</span>
          </label>
        </section>
      )}

      {paso === "mapeo" && (
        <section className="card">
          <h2>¿A qué departamento va cada categoría de la web?</h2>
          <p className="muted">Se guarda para las próximas importaciones. Lo que no tenga categoría va a "{nombreDep(defecto)}".</p>
          <table className="tbl tbl-grande">
            <tbody>
              {categorias.map((c) => (
                <tr key={c}>
                  <td>{c}</td>
                  <td>
                    <select value={mapeo[c] ?? defecto} onChange={(e) => setMapeo({ ...mapeo, [c]: e.target.value })}>
                      {deps.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.nombre}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={guardarMapeo}>
              Guardar y ver vista previa
            </button>
          </div>
        </section>
      )}

      {paso === "vista" && plan && (
        <>
          <section className="card">
            <h2>Vista previa · {archivo}</h2>
            <div className="conteos">
              <div>
                <strong>{plan.total}</strong>filas
              </div>
              <div className="ok">
                <strong>{plan.nuevos.length}</strong>nuevos
              </div>
              <div>
                <strong>{plan.actualizar.length}</strong>a actualizar
              </div>
              <div className="muted">
                <strong>{plan.sinCambios}</strong>sin cambios
              </div>
              <div className={plan.errores.length ? "err" : "muted"}>
                <strong>{plan.errores.length}</strong>con errores
              </div>
              {plan.omitidos.length > 0 && (
                <div className="muted">
                  <strong>{plan.omitidos.length}</strong>omitidos
                </div>
              )}
            </div>
            <p className="muted">Las filas con errores no se importan; el resto sí.</p>
            <div className="row">
              <button className="primary grande" disabled={ocupado || plan.nuevos.length + plan.actualizar.length === 0} onClick={confirmar}>
                {ocupado ? "Importando…" : `Confirmar importación (${plan.nuevos.length + plan.actualizar.length})`}
              </button>
              {categorias.length > 0 && <button onClick={() => setPaso("mapeo")}>Cambiar mapeo de categorías</button>}
              <button onClick={() => setPaso("archivo")}>Otro archivo</button>
            </div>
          </section>

          {plan.errores.length + plan.omitidos.length > 0 && (
            <section className="card">
              <h2>Errores y omitidos</h2>
              <ListaFilas filas={[...plan.errores, ...plan.omitidos].sort((a, b) => a.fila - b.fila)} />
            </section>
          )}
          {plan.actualizar.length > 0 && (
            <section className="card">
              <h2>Cambios</h2>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Fila</th>
                    <th>Antes</th>
                    <th>Después</th>
                    <th className="num">Precio</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.actualizar.slice(0, 300).map((it) => (
                    <tr key={it.fila}>
                      <td>{it.fila}</td>
                      <td>{it.antes!.nombre}</td>
                      <td>{it.nombre === it.antes!.nombre ? <span className="muted">igual</span> : it.nombre}</td>
                      <td className="num">
                        {it.precio === it.antes!.precio ? monto(it.precio) : `${monto(it.antes!.precio)} → ${monto(it.precio)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.actualizar.length > 300 && <p className="muted">… y {plan.actualizar.length - 300} más.</p>}
            </section>
          )}
          {plan.nuevos.length > 0 && (
            <section className="card">
              <h2>Nuevos</h2>
              <table className="tbl">
                <tbody>
                  {plan.nuevos.slice(0, 300).map((it) => (
                    <tr key={it.fila}>
                      <td>{it.fila}</td>
                      <td>{it.nombre}</td>
                      <td className="muted">{nombreDep(it.departamentoId)}</td>
                      <td className="num">{monto(it.precio)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.nuevos.length > 300 && <p className="muted">… y {plan.nuevos.length - 300} más.</p>}
            </section>
          )}
        </>
      )}

      {paso === "listo" && (
        <section className="card">
          <Mensaje ok={resultado} />
          <div className="row">
            <button className="primary" onClick={onSalir}>
              Ver productos
            </button>
            <button onClick={() => setPaso("archivo")}>Importar otro archivo</button>
          </div>
        </section>
      )}
    </div>
  );
}

function ListaFilas({ filas }: { filas: { fila: number; nombre: string; mensaje: string }[] }) {
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Fila</th>
          <th>Nombre</th>
          <th>Problema</th>
        </tr>
      </thead>
      <tbody>
        {filas.map((e) => (
          <tr key={e.fila}>
            <td>{e.fila}</td>
            <td>{e.nombre || <span className="muted">(vacío)</span>}</td>
            <td>{e.mensaje}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
