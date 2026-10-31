// Tablas editables del importador: categoría de la web → departamento (en orden de prioridad)
// y palabras del nombre que cambian el departamento. Se guardan en config importacion_reglas.
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { normalizar } from "../../../lib/texto";
import type { ReglasImportacion } from "../../../lib/importar/reglas";
import type { Departamento } from "../../../tipos";
import Button from "../../../ui/Button";

interface Props {
  reglas: ReglasImportacion;
  onCambio(r: ReglasImportacion): void;
  departamentos: Departamento[];
  departamentoDefecto: string;
  /** Productos del archivo por categoría (clave normalizada). */
  porCategoria: Map<string, number>;
  sinMapear: string[];
  plurales: { indice: number; forma: string; productos: number }[];
}

function SelectDepartamento(p: { valor: string; onCambio(id: string): void; departamentos: Departamento[]; etiqueta: string }) {
  return (
    <select aria-label={p.etiqueta} value={p.valor} onChange={(e) => p.onCambio(e.target.value)}>
      {!p.departamentos.some((d) => d.id === p.valor) && <option value={p.valor}>(departamento inexistente)</option>}
      {p.departamentos.map((d) => (
        <option key={d.id} value={d.id}>
          {d.codigo} {d.nombre}
        </option>
      ))}
    </select>
  );
}

/** Palabras separadas por coma; se confirma al salir del campo (así la coma no se pierde al escribir). */
function CampoPalabras(p: { palabras: string[]; onCambio(l: string[]): void; etiqueta: string }) {
  const [texto, setTexto] = useState(p.palabras.join(", "));
  useEffect(() => setTexto(p.palabras.join(", ")), [p.palabras]);
  return (
    <input
      aria-label={p.etiqueta}
      value={texto}
      onChange={(e) => setTexto(e.target.value)}
      onBlur={() => p.onCambio(texto.split(",").map((s) => s.trim()).filter(Boolean))}
    />
  );
}

export default function EditorReglas(p: Props) {
  const { reglas } = p;
  const cats = reglas.categorias;
  const pal = reglas.palabras;
  const setCats = (categorias: typeof cats) => p.onCambio({ ...reglas, categorias });
  const setPal = (palabras: typeof pal) => p.onCambio({ ...reglas, palabras });
  const mover = (i: number, d: -1 | 1) => {
    const l = [...cats];
    [l[i], l[i + d]] = [l[i + d], l[i]];
    setCats(l);
  };

  return (
    <div className="importar-reglas">
      <section aria-labelledby="t-mapeo">
        <div className="seccion-cab">
          <h3 id="t-mapeo">Categoría de la web → departamento</h3>
          <p className="muted">Si un producto trae varias categorías, gana la que está más arriba.</p>
        </div>
        <table className="tbl tbl-editable">
          <thead>
            <tr>
              <th className="num">Prioridad</th>
              <th>Categoría</th>
              <th>Departamento</th>
              <th className="num">En el archivo</th>
              <th>
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {cats.map((c, i) => (
              <tr key={i}>
                <td className="num muted">{i + 1}</td>
                <td>
                  <input aria-label={`Categoría ${i + 1}`} value={c.categoria} onChange={(e) => setCats(cats.map((x, j) => (j === i ? { ...x, categoria: e.target.value } : x)))} />
                </td>
                <td>
                  <SelectDepartamento
                    etiqueta={`Departamento de ${c.categoria}`}
                    valor={c.departamentoId}
                    departamentos={p.departamentos}
                    onCambio={(id) => setCats(cats.map((x, j) => (j === i ? { ...x, departamentoId: id } : x)))}
                  />
                </td>
                <td className="num">{p.porCategoria.get(normalizar(c.categoria)) ?? <span className="muted">0</span>}</td>
                <td className="acciones-fila">
                  <Button variante="fantasma" icono={ArrowUp} aria-label={`Subir ${c.categoria}`} title="Subir prioridad" disabled={i === 0} onClick={() => mover(i, -1)} />
                  <Button variante="fantasma" icono={ArrowDown} aria-label={`Bajar ${c.categoria}`} title="Bajar prioridad" disabled={i === cats.length - 1} onClick={() => mover(i, 1)} />
                  <Button variante="peligro" icono={Trash2} aria-label={`Quitar ${c.categoria}`} title="Quitar" onClick={() => setCats(cats.filter((_, j) => j !== i))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {p.sinMapear.length > 0 && (
          <div className="sin-mapeo">
            <p>
              <strong>Categorías del archivo sin mapeo.</strong> <span className="muted">Mientras no se agreguen, esos productos van a Otros y quedan para revisar.</span>
            </p>
            <div className="row">
              {p.sinMapear.map((c) => (
                <Button key={c} icono={Plus} onClick={() => setCats([...cats, { categoria: c, departamentoId: p.departamentoDefecto }])}>
                  {c} ({p.porCategoria.get(normalizar(c)) ?? 0})
                </Button>
              ))}
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="t-palabras">
        <div className="seccion-cab">
          <h3 id="t-palabras">Palabras en el nombre</h3>
          <p className="muted">
            Se aplican después de la categoría y la reemplazan. Solo palabra completa, sin mayúsculas ni tildes: «marco» no toma «marcador». Si dos reglas coinciden,
            gana la de más arriba.
          </p>
        </div>
        <table className="tbl tbl-editable">
          <thead>
            <tr>
              <th>Palabras (separadas por coma)</th>
              <th>Departamento</th>
              <th>Preguntar antes</th>
              <th>
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pal.map((r, i) => (
              <tr key={i}>
                <td style={{ width: "46%" }}>
                  <CampoPalabras etiqueta={`Palabras de la regla ${i + 1}`} palabras={r.palabras} onCambio={(l) => setPal(pal.map((x, j) => (j === i ? { ...x, palabras: l } : x)))} />
                </td>
                <td>
                  <SelectDepartamento
                    etiqueta={`Departamento de la regla ${i + 1}`}
                    valor={r.departamentoId}
                    departamentos={p.departamentos}
                    onCambio={(id) => setPal(pal.map((x, j) => (j === i ? { ...x, departamentoId: id } : x)))}
                  />
                </td>
                <td>
                  <label className="check">
                    <input type="checkbox" checked={r.preguntar} onChange={(e) => setPal(pal.map((x, j) => (j === i ? { ...x, preguntar: e.target.checked } : x)))} />
                    Preguntar
                  </label>
                </td>
                <td className="acciones-fila">
                  <Button variante="peligro" icono={Trash2} aria-label={`Quitar la regla ${i + 1}`} title="Quitar" onClick={() => setPal(pal.filter((_, j) => j !== i))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: "var(--e3)" }}>
          <Button icono={Plus} onClick={() => setPal([...pal, { palabras: [], departamentoId: p.departamentoDefecto, preguntar: false }])}>
            Agregar regla
          </Button>
        </div>
        {p.plurales.length > 0 && (
          <div className="sin-mapeo">
            <p>
              <strong>Plurales que ninguna regla toma.</strong> <span className="muted">«lapices» no es «lapiz». Agréguelos solo si deben ir al mismo departamento.</span>
            </p>
            <div className="row">
              {p.plurales.map((x) => (
                <Button
                  key={x.forma}
                  icono={Plus}
                  title={`Agregar a la regla «${pal[x.indice].palabras.join(", ")}»`}
                  onClick={() => setPal(pal.map((r, j) => (j === x.indice ? { ...r, palabras: [...r.palabras, x.forma] } : r)))}
                >
                  {x.forma} ({x.productos})
                </Button>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
