// Bitácora para el dueño (Administración → Bitácora): quién hizo qué y cuándo, en frases simples.
// Sin códigos ni datos personales. La versión técnica, con el detalle crudo, está en Técnico.
// Se mira por día (hoy por defecto): lo de rutina (entrar, consultar clientes) va oculto.
import { ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { textoError } from "../components/Mensaje";
import { listarBitacora, verificarBitacora } from "../db/bitacora";
import { listarUsuarios } from "../db/usuarios";
import { describir, GRUPOS, type Grupo } from "../lib/bitacoraTexto";
import { diaLocal, normalizar } from "../lib/texto";
import type { EntradaBitacora } from "../tipos";
import Alert from "../ui/Alert";
import Badge from "../ui/Badge";
import EmptyState from "../ui/EmptyState";
import Field from "../ui/Field";

const CUANTAS = 1000; // tope por consulta; un rango de días con más avisa que se acorte
type Periodo = "hoy" | "ayer" | "semana" | "mes" | "fechas";
const PERIODOS: [Periodo, string][] = [
  ["hoy", "Hoy"],
  ["ayer", "Ayer"],
  ["semana", "Últimos 7 días"],
  ["mes", "Últimos 30 días"],
  ["fechas", "Elegir fechas"],
];

const haceDias = (n: number) => diaLocal(new Date(Date.now() - n * 86_400_000));
function rango(p: Periodo, desde: string, hasta: string) {
  if (p === "hoy") return { desde: diaLocal(), hasta: diaLocal() };
  if (p === "ayer") return { desde: haceDias(1), hasta: haceDias(1) };
  if (p === "semana") return { desde: haceDias(6), hasta: diaLocal() };
  if (p === "mes") return { desde: haceDias(29), hasta: diaLocal() };
  return desde <= hasta ? { desde, hasta } : { desde: hasta, hasta: desde };
}

/** "Miércoles 11 de noviembre": mayúscula solo al inicio (no "De Noviembre De"). */
function tituloDia(iso: string) {
  const t = new Date(iso).toLocaleDateString("es-CR", { weekday: "long", day: "numeric", month: "long" });
  return t.charAt(0).toUpperCase() + t.slice(1).replace(",", "");
}

export default function Historial() {
  const [periodo, setPeriodo] = useState<Periodo>("hoy");
  const [desde, setDesde] = useState(haceDias(7));
  const [hasta, setHasta] = useState(diaLocal());
  const [lista, setLista] = useState<EntradaBitacora[] | null>(null);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [integra, setIntegra] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [grupo, setGrupo] = useState<Grupo | "">("");
  const [usuario, setUsuario] = useState("");
  const [soloImportante, setSoloImportante] = useState(false);
  const [verRutina, setVerRutina] = useState(false);
  const [buscar, setBuscar] = useState("");

  const dias = rango(periodo, desde, hasta);
  useEffect(() => {
    setLista(null);
    setError("");
    listarBitacora(CUANTAS, undefined, dias).then(setLista, (e) => setError(textoError(e)));
  }, [dias.desde, dias.hasta]);
  useEffect(() => {
    listarUsuarios().then((u) => setNombres(Object.fromEntries(u.map((x) => [x.id, x.nombre]))), () => {});
    verificarBitacora().then((v) => setIntegra(v.ok), () => setIntegra(null));
  }, []);

  const todas = useMemo(() => (lista ?? []).map((e) => ({ e, f: describir(e, nombres) })), [lista, nombres]);
  const filas = useMemo(() => {
    const q = normalizar(buscar);
    return todas.filter(
      ({ e, f }) =>
        (verRutina || !f.rutina) &&
        (!grupo || f.grupo === grupo) &&
        (!soloImportante || f.importante) &&
        (!usuario || e.usuario === usuario) &&
        (!q || normalizar(`${f.texto} ${e.usuario ?? ""}`).includes(q)),
    );
  }, [todas, grupo, usuario, soloImportante, verRutina, buscar]);
  const rutinas = todas.filter(({ f }) => f.rutina).length;
  const porRevisar = todas.filter(({ f }) => f.importante).length;
  const usuarios = useMemo(() => [...new Set((lista ?? []).map((e) => e.usuario).filter(Boolean) as string[])].sort(), [lista]);
  const variosDias = dias.desde !== dias.hasta;

  return (
    <div className="screen">
      <h1>Bitácora</h1>
      <p className="muted">Lo que se hace en el sistema: quién, qué y cuándo. No se puede borrar ni cambiar.</p>
      {integra === false && (
        <Alert tono="error" titulo="La bitácora fue alterada">
          Alguien modificó el archivo de datos por fuera del programa. Avise al técnico.
        </Alert>
      )}
      {error && <Alert tono="error">{error}</Alert>}
      <section className="card">
        <div className="historial-filtros">
          <div className="row abajo" style={{ flexWrap: "wrap" }}>
            <div className="segmento" role="group" aria-label="Qué días ver">
              {PERIODOS.map(([id, texto]) => (
                <button key={id} type="button" aria-pressed={periodo === id} onClick={() => setPeriodo(id)}>
                  {texto}
                </button>
              ))}
            </div>
            {periodo === "fechas" && (
              <>
                <Field label="Desde">
                  <input type="date" value={desde} max={diaLocal()} onChange={(e) => setDesde(e.target.value)} />
                </Field>
                <Field label="Hasta">
                  <input type="date" value={hasta} max={diaLocal()} onChange={(e) => setHasta(e.target.value)} />
                </Field>
              </>
            )}
            <span style={{ flex: 1 }} />
            {integra && (
              <span className="muted row" title="Nadie modificó la bitácora por fuera del programa">
                <ShieldCheck size={18} aria-hidden /> Íntegra
              </span>
            )}
          </div>
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
            <div className="historial-casillas">
              <label className="row">
                <input type="checkbox" checked={soloImportante} onChange={(e) => setSoloImportante(e.target.checked)} /> Solo lo que hay que revisar
                {porRevisar > 0 && <Badge tono="aviso">{porRevisar}</Badge>}
              </label>
              <label className="row">
                <input type="checkbox" checked={verRutina} onChange={(e) => setVerRutina(e.target.checked)} /> Mostrar entradas y consultas
                {rutinas > 0 && <span className="muted">({rutinas})</span>}
              </label>
            </div>
          </div>
        </div>

        {lista === null ? (
          <p className="muted">Cargando…</p>
        ) : filas.length === 0 ? (
          <EmptyState
            icono={ShieldCheck}
            titulo={todas.length ? "Nada con esos filtros" : periodo === "hoy" ? "Todavía no pasa nada hoy" : "Nada en esos días"}
            texto={todas.length ? "Quite algún filtro o marque «Mostrar entradas y consultas»." : "Elija otros días arriba."}
          />
        ) : (
          <table className="tbl historial">
            <colgroup>
              <col style={{ width: 84 }} />
              <col style={{ width: 150 }} />
              <col />
            </colgroup>
            <tbody>
              {filas.map(({ e, f }, i) => {
                const nuevoDia = variosDias && (i === 0 || tituloDia(filas[i - 1].e.fecha) !== tituloDia(e.fecha));
                return [
                  nuevoDia && (
                    <tr key={`d${e.id}`} className="historial-dia">
                      <th colSpan={3}>{tituloDia(e.fecha)}</th>
                    </tr>
                  ),
                  <tr key={e.id}>
                    <td className="muted historial-hora">{new Date(e.fecha).toLocaleTimeString("es-CR", { hour: "numeric", minute: "2-digit" })}</td>
                    <td>
                      <strong>{e.usuario ?? "Sistema"}</strong>
                    </td>
                    <td>
                      {f.importante && <Badge tono="aviso">Revisar</Badge>} {f.texto}
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        )}
        {lista && lista.length >= CUANTAS && <p className="muted">Hay más de {CUANTAS} acciones en esos días: se muestran las más recientes. Elija menos días.</p>}
      </section>
    </div>
  );
}
