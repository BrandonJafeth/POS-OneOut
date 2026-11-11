// Bitácora para el dueño (Administración → Bitácora): quién hizo qué y cuándo, en frases simples.
// Sin códigos ni datos personales. La versión técnica, con el detalle crudo, está en Técnico.
import { ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { textoError } from "../components/Mensaje";
import { listarBitacora, verificarBitacora } from "../db/bitacora";
import { listarUsuarios } from "../db/usuarios";
import { describir, GRUPOS, type Grupo } from "../lib/bitacoraTexto";
import { normalizar } from "../lib/texto";
import type { EntradaBitacora } from "../tipos";
import Alert from "../ui/Alert";
import Badge from "../ui/Badge";
import EmptyState from "../ui/EmptyState";
import Field from "../ui/Field";

const CUANTAS = 1000; // las más recientes; suficiente para revisar las últimas semanas

export default function Historial() {
  const [lista, setLista] = useState<EntradaBitacora[] | null>(null);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [integra, setIntegra] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [grupo, setGrupo] = useState<Grupo | "">("");
  const [usuario, setUsuario] = useState("");
  const [soloImportante, setSoloImportante] = useState(false);
  const [buscar, setBuscar] = useState("");

  useEffect(() => {
    listarBitacora(CUANTAS).then(setLista, (e) => setError(textoError(e)));
    listarUsuarios().then((u) => setNombres(Object.fromEntries(u.map((x) => [x.id, x.nombre]))), () => {});
    verificarBitacora().then((v) => setIntegra(v.ok), () => setIntegra(null));
  }, []);

  const filas = useMemo(() => {
    const q = normalizar(buscar);
    return (lista ?? [])
      .map((e) => ({ e, f: describir(e, nombres) }))
      .filter(({ e, f }) => (!grupo || f.grupo === grupo) && (!soloImportante || f.importante) && (!usuario || e.usuario === usuario))
      .filter(({ e, f }) => !q || normalizar(`${f.texto} ${e.usuario ?? ""}`).includes(q));
  }, [lista, nombres, grupo, usuario, soloImportante, buscar]);

  const usuarios = useMemo(() => [...new Set((lista ?? []).map((e) => e.usuario).filter(Boolean) as string[])].sort(), [lista]);
  const dia = (iso: string) => new Date(iso).toLocaleDateString("es-CR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <div className="screen">
      <h1>Bitácora</h1>
      <p className="muted">Todo lo importante que se hace en el sistema: quién, qué y cuándo. No se puede borrar ni cambiar.</p>
      {integra === false && (
        <Alert tono="error" titulo="La bitácora fue alterada">
          Alguien modificó el archivo de datos por fuera del programa. Avise al técnico.
        </Alert>
      )}
      {error && <Alert tono="error">{error}</Alert>}
      <section className="card">
        <div className="row abajo" style={{ flexWrap: "wrap" }}>
          <Field label="Tema">
            <select value={grupo} onChange={(e) => setGrupo(e.target.value as Grupo | "")}>
              <option value="">Todo</option>
              {(Object.keys(GRUPOS) as Grupo[]).map((g) => (
                <option key={g} value={g}>
                  {GRUPOS[g]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Persona">
            <select value={usuario} onChange={(e) => setUsuario(e.target.value)}>
              <option value="">Todas</option>
              {usuarios.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </Field>
          <Field label="Buscar">
            <input value={buscar} placeholder="anuló, gaveta, 4.500…" onChange={(e) => setBuscar(e.target.value)} />
          </Field>
          <label className="row" style={{ alignSelf: "center" }}>
            <input type="checkbox" checked={soloImportante} onChange={(e) => setSoloImportante(e.target.checked)} /> Solo lo que hay que revisar
          </label>
          <span style={{ flex: 1 }} />
          {integra && (
            <span className="muted row" title="Nadie modificó la bitácora por fuera del programa">
              <ShieldCheck size={18} aria-hidden /> Íntegra
            </span>
          )}
        </div>

        {lista === null ? (
          <p className="muted">Cargando…</p>
        ) : filas.length === 0 ? (
          <EmptyState icono={ShieldCheck} titulo="Nada con esos filtros" texto="Pruebe con otro tema, otra persona o quite la búsqueda." />
        ) : (
          <table className="tbl historial">
            <tbody>
              {filas.map(({ e, f }, i) => {
                const nuevoDia = i === 0 || dia(filas[i - 1].e.fecha) !== dia(e.fecha);
                return [
                  nuevoDia && (
                    <tr key={`d${e.id}`} className="historial-dia">
                      <th colSpan={3}>{dia(e.fecha)}</th>
                    </tr>
                  ),
                  <tr key={e.id}>
                    <td className="num muted" style={{ whiteSpace: "nowrap" }}>
                      {new Date(e.fecha).toLocaleTimeString("es-CR", { hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <strong>{e.usuario ?? "Sistema"}</strong>
                    </td>
                    <td>
                      {f.importante && <Badge tono="aviso">Revisar</Badge>}{" "}
                      {f.texto}
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        )}
        {lista && lista.length >= CUANTAS && <p className="muted">Se muestran las últimas {CUANTAS} acciones.</p>}
      </section>
    </div>
  );
}
