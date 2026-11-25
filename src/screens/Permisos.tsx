// Administración → Permisos (DISENO-PERMISOS.md §4): matriz por rol, excepciones por usuario,
// anulación por el cajero (A/B/C), bloqueo por inactividad, plantillas e historial. Edita la
// propuesta en memoria y la manda entera a Rust, que valida las reglas fijas y pide el PIN del dueño
// si da más permiso (lib/invocar muestra el diálogo y reintenta).
import { FileDown, History, RotateCcw, Save, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { textoError } from "../components/Mensaje";
import { obtenerNegocio as leerNegocio } from "../db/negocio";
import {
  L_CANTIDAD,
  L_MONTO,
  L_PCT,
  L_TURNO,
  L_VENTANA,
  seguridadDiferencias,
  seguridadGuardar,
  seguridadHistorial,
  seguridadInactividad,
  seguridadObtener,
  seguridadPlantilla,
  seguridadVersion,
  seguridadVolver,
  N_CON_PIN,
  N_MOTIVO,
  N_PIN,
  N_SI,
  type AccionInfo,
  type Datos,
  type Inactividad,
  type Politica,
  type Seguridad,
  type VersionFila,
} from "../db/seguridad";
import { descargar } from "../lib/exportarCliente";
import { crearPdfReporte } from "../lib/pdf";
import { cambios, describir, describirInactividad, hayLimites, lineasTabla, minutosDe, NIVELES, opcionAnulacion } from "../lib/seguridad";
import { fechaHora } from "../lib/tickets";
import { useSesion } from "../app/sesion";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Field from "../ui/Field";
import { useConfirmar } from "../ui/Confirmar";
import { useToast } from "../ui/Toast";

const TABS = [
  ["rol", "Por rol"],
  ["usuario", "Por usuario"],
  ["anulacion", "Anulación por el cajero"],
  ["bloqueo", "Bloqueo por inactividad"],
  ["historial", "Historial"],
] as const;
type Tab = (typeof TABS)[number][0];

const NINGUNO: Politica["limites"] = { montoMax: null, pctMax: null, cantidadTurno: null, soloTurnoAbierto: false, ventanaMin: null, alPasar: "pin" };
const politica = (nivel: Politica["nivel"], anterior?: Politica): Politica => ({ nivel, motivo: nivel === "motivo" || (nivel === "pin" && !!anterior?.motivo), limites: nivel === "no" ? NINGUNO : (anterior?.limites ?? NINGUNO) });
const copia = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export default function Permisos() {
  const [s, setS] = useState<Seguridad | null>(null);
  const [d, setD] = useState<Datos | null>(null);
  const [plantilla, setPlantilla] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("rol");
  const [error, setError] = useState("");
  const cargar = () =>
    seguridadObtener().then(
      (x) => (setS(x), setD(copia(x.datos)), setPlantilla(null)),
      (e) => setError(textoError(e)),
    );
  useEffect(() => void cargar(), []);
  if (!s || !d) return <section className="card">{error ? <Alert tono="error">{error}</Alert> : <p className="muted">Cargando…</p>}</section>;
  const nombres = Object.fromEntries(s.cajeros.map((c) => [c.id, c.nombre]));
  const lista = cambios(s.datos, d, s.catalogo, nombres);
  return (
    <div className="permisos">
      {s.rotaEn !== null && (
        <Alert tono="error" titulo="Los permisos fueron alterados">
          La versión {s.rotaEn} no es válida (alguien la cambió fuera del programa). Se usa la versión {s.version}. Al guardar, la nueva queda encadenada a la última válida.
        </Alert>
      )}
      <Plantillas s={s} d={d} onAplicar={(x, n) => (setD(x), setPlantilla(n))} />
      <nav className="tabs">
        {TABS.map(([id, t]) => (
          <button key={id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
            {t}
          </button>
        ))}
      </nav>
      {tab === "rol" && <PorRol s={s} d={d} setD={setD} />}
      {tab === "usuario" && <PorUsuario s={s} d={d} setD={setD} />}
      {tab === "anulacion" && <Anulacion d={d} setD={setD} />}
      {tab === "bloqueo" && <Bloqueo d={d} setD={setD} />}
      {tab === "historial" && <Historial s={s} onCambio={cargar} />}
      {tab !== "historial" && <Guardar s={s} d={d} lista={lista} plantilla={plantilla} onDeshacer={() => (setD(copia(s.datos)), setPlantilla(null))} onGuardado={cargar} />}
    </div>
  );
}

function Plantillas(p: { s: Seguridad; d: Datos; onAplicar(d: Datos, nombre: string): void }) {
  const [vista, setVista] = useState<{ nombre: string; d: Datos } | null>(null);
  const [error, setError] = useState("");
  const textos: Record<string, string> = { estricto: "Estricto: todo lo sensible con PIN", normal: "Normal (recomendado, igual que antes)", flexible: "Flexible: cajero de confianza, con límites" };
  const dif = vista ? cambios(p.d, vista.d, p.s.catalogo) : [];
  return (
    <section className="card">
      <h2>Plantillas</h2>
      <div className="fila">
        {Object.entries(textos).map(([n, t]) => (
          <Button key={n} onClick={() => seguridadPlantilla(n).then((d) => setVista({ nombre: n, d }), (e) => setError(textoError(e)))}>
            {t}
          </Button>
        ))}
      </div>
      {error && <Alert tono="error">{error}</Alert>}
      {vista && (
        <div>
          <p>
            <strong>Diferencias con lo de ahora ({textos[vista.nombre]}):</strong>
          </p>
          {dif.length ? (
            <ul>
              {dif.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">Ninguna.</p>
          )}
          <div className="fila">
            <Button variante="primario" disabled={!dif.length} onClick={() => (p.onAplicar(vista.d, vista.nombre), setVista(null))}>
              Usar esta plantilla
            </Button>
            <Button variante="fantasma" onClick={() => setVista(null)}>
              Cancelar
            </Button>
          </div>
          <p className="muted">Se aplica al guardar (abajo).</p>
        </div>
      )}
    </section>
  );
}

/** Selector de nivel + límites que la acción admite, con la frase de lo que significa. */
function Celda(p: { a: AccionInfo; quien: string; valor: Politica | undefined; fijo?: string; heredado?: boolean; onCambio(v: Politica | undefined): void }) {
  const confirmar = useConfirmar();
  if (p.fijo) return <span className="muted">{p.fijo}</span>;
  const v = p.valor;
  const id = `n-${p.quien}-${p.a.id}`;
  // Solo los niveles que esta acción aplica de verdad (D4). Si siempre pide el PIN, «sí» = «con PIN».
  const conPin = p.a.niveles === N_CON_PIN;
  const bit = { no: 0, pin: N_PIN, motivo: N_MOTIVO, si: N_SI } as const;
  const opciones = NIVELES.filter((x) => x.valor === "no" || (conPin ? x.valor === "pin" : (p.a.niveles & bit[x.valor]) > 0)).map((x) => (conPin && x.valor === "pin" ? { ...x, texto: "Sí, siempre con PIN del dueño" } : x));
  const valor = conPin && v?.nivel === "si" ? "pin" : (v?.nivel ?? "no");
  const lim = (cambio: Partial<Politica["limites"]>) => v && p.onCambio({ ...v, limites: { ...v.limites, ...cambio } });
  const num = (x: string) => (x.trim() === "" ? null : Math.max(0, Math.round(Number(x.replace(/\D/g, "")))));
  return (
    <div className="celda-politica">
      <select
        id={id}
        aria-label={`${p.a.nombre}: ${p.quien}`}
        value={p.heredado ? "" : valor}
        onChange={async (e) => {
          const n = e.target.value as Politica["nivel"] | "";
          if (n === "") return p.onCambio(undefined);
          if (p.a.id === "caja.ver_totales" && n !== "no") {
            const ok = await confirmar({
              titulo: "¿Dejar ver los totales con el turno abierto?",
              texto: "El cajero va a ver cuánto se ha vendido en el turno. Así puede dejar de registrar ventas sin que se note en el cierre.",
              aceptar: "Sí, entiendo",
              peligro: true,
            });
            if (!ok) return;
          }
          p.onCambio(conPin ? { ...politica(n, v), motivo: false } : politica(n, v));
        }}
      >
        {p.heredado !== undefined && <option value="">Como su rol</option>}
        {opciones.map((x) => (
          <option key={x.valor} value={x.valor}>
            {x.texto}
          </option>
        ))}
      </select>
      {v && v.nivel !== "no" && v.nivel !== "pin" && p.a.limites > 0 && !p.heredado && (
        <div className="limites">
          {(p.a.limites & L_MONTO) > 0 && (
            <label>
              Hasta ¢ <input inputMode="numeric" value={v.limites.montoMax ?? ""} onChange={(e) => lim({ montoMax: num(e.target.value) })} placeholder={p.a.montoOPin ? "obligatorio" : "sin tope"} required={p.a.montoOPin} />
            </label>
          )}
          {(p.a.limites & L_PCT) > 0 && (
            <label>
              Hasta % <input inputMode="decimal" value={v.limites.pctMax ?? ""} onChange={(e) => lim({ pctMax: e.target.value.trim() === "" ? null : Math.min(100, Math.max(0, Number(e.target.value.replace(",", ".")) || 0)) })} placeholder="sin tope" />
            </label>
          )}
          {(p.a.limites & L_CANTIDAD) > 0 && (
            <label>
              Por turno <input inputMode="numeric" value={v.limites.cantidadTurno ?? ""} onChange={(e) => lim({ cantidadTurno: num(e.target.value) })} placeholder="sin tope" />
            </label>
          )}
          {(p.a.limites & L_VENTANA) > 0 && (
            <label>
              Minutos <input inputMode="numeric" value={v.limites.ventanaMin ?? ""} onChange={(e) => lim({ ventanaMin: num(e.target.value) })} placeholder="sin tope" />
            </label>
          )}
          {(p.a.limites & L_TURNO) > 0 && (
            <label className="check">
              <input type="checkbox" checked={v.limites.soloTurnoAbierto} onChange={(e) => lim({ soloTurnoAbierto: e.target.checked })} /> Solo turno abierto
            </label>
          )}
          {hayLimites(v) && (
            <label>
              Al pasar{" "}
              <select value={v.limites.alPasar} onChange={(e) => lim({ alPasar: e.target.value as "pin" | "bloquear" })}>
                <option value="pin">pide PIN</option>
                <option value="bloquear">no deja</option>
              </select>
            </label>
          )}
        </div>
      )}
      {!p.heredado && <p className="frase">{describir(p.quien, p.a.nombre, v)}</p>}
    </div>
  );
}

function PorRol(p: { s: Seguridad; d: Datos; setD(d: Datos): void }) {
  const [q, setQ] = useState("");
  const filas = useMemo(() => p.s.catalogo.filter((a) => !q || `${a.area} ${a.nombre} ${a.id}`.toLowerCase().includes(q.toLowerCase())), [q, p.s.catalogo]);
  const poner = (rol: "cajero" | "tecnico", id: string, v: Politica | undefined) => {
    const d = copia(p.d);
    if (!v || v.nivel === "no") delete d[rol][id];
    else d[rol][id] = v;
    if (id === "caja.ver_totales" && rol === "cajero" && v && v.nivel !== "no") d.verTotalesConfirmado = true;
    p.setD(d);
  };
  let area = "";
  return (
    <section className="card">
      <Field label="Buscar una acción">
        <div className="con-icono">
          <Search size={16} aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="anular, descuento, caja…" />
        </div>
      </Field>
      <div className="tabla-scroll">
        <table className="tbl tbl-permisos">
          <thead>
            <tr>
              <th>Acción</th>
              <th>Cajero</th>
              <th>Técnico</th>
              <th>Dueño</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((a) => {
              const cab = a.area !== area ? ((area = a.area), true) : false;
              return [
                cab && (
                  <tr key={`h-${a.area}`} className="grupo">
                    <th colSpan={4}>{a.area}</th>
                  </tr>
                ),
                <tr key={a.id}>
                  <td>
                    {a.nombre}
                    {a.sensible && <span className="muted"> · sensible</span>}
                  </td>
                  <td>
                    <Celda a={a} quien="cajero" valor={p.d.cajero[a.id]} fijo={a.noDelegable ? "No (fijo)" : undefined} onCambio={(v) => poner("cajero", a.id, v)} />
                  </td>
                  <td>
                    <Celda a={a} quien="tecnico" valor={p.d.tecnico[a.id]} fijo={a.protegida ? "No (Ley 8968 o dinero)" : a.noDelegable ? "Sí (fijo)" : undefined} onCambio={(v) => poner("tecnico", a.id, v)} />
                  </td>
                  <td className="muted">{a.duenoSigueCajero ? "Sí, con el tope del cajero (PIN al pasar)" : (NIVELES.find((n) => n.valor === a.dueno.nivel)?.texto ?? "")}</td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PorUsuario(p: { s: Seguridad; d: Datos; setD(d: Datos): void }) {
  const [u, setU] = useState(p.s.cajeros[0]?.id ?? "");
  if (!p.s.cajeros.length) return <section className="card muted">No hay cajeros. Las excepciones son solo para cajeros.</section>;
  const nombre = p.s.cajeros.find((c) => c.id === u)?.nombre ?? "";
  const propias = p.d.usuarios[u] ?? {};
  const poner = (id: string, v: Politica | undefined) => {
    const d = copia(p.d);
    const m = { ...(d.usuarios[u] ?? {}) };
    if (v) m[id] = v;
    else delete m[id];
    if (Object.keys(m).length) d.usuarios[u] = m;
    else delete d.usuarios[u];
    if (id === "caja.ver_totales" && v && v.nivel !== "no") d.verTotalesConfirmado = true;
    p.setD(d);
  };
  return (
    <section className="card">
      <Field label="Cajero">
        <select value={u} onChange={(e) => setU(e.target.value)}>
          {p.s.cajeros.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
            </option>
          ))}
        </select>
      </Field>
      <p className="muted">«Como su rol» sigue la columna del cajero. Una excepción cambia solo esa acción, solo para {nombre}.</p>
      <div className="tabla-scroll">
        <table className="tbl tbl-permisos">
          <tbody>
            {p.s.catalogo
              .filter((a) => !a.noDelegable)
              .map((a) => (
                <tr key={a.id}>
                  <td>{a.nombre}</td>
                  <td>
                    <Celda a={a} quien={nombre} valor={propias[a.id] ?? p.d.cajero[a.id]} heredado={!propias[a.id]} onCambio={(v) => poner(a.id, v)} />
                    {propias[a.id] && <p className="frase">{describir(nombre, a.nombre, propias[a.id])}</p>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Anulacion(p: { d: Datos; setD(d: Datos): void }) {
  const actual = p.d.cajero["ventas.anular"];
  const op = opcionAnulacion(actual);
  const elegir = (o: "A" | "B" | "C") => {
    const d = copia(p.d);
    if (o === "A") delete d.cajero["ventas.anular"];
    else if (o === "B") d.cajero["ventas.anular"] = { nivel: "pin", motivo: true, limites: NINGUNO };
    else d.cajero["ventas.anular"] = { nivel: "motivo", motivo: true, limites: actual?.nivel === "motivo" ? actual.limites : { montoMax: 10000, pctMax: null, cantidadTurno: 3, soloTurnoAbierto: true, ventanaMin: 30, alPasar: "pin" } };
    p.setD(d);
  };
  return (
    <section className="card">
      <h2>¿Puede el cajero anular ventas?</h2>
      {(
        [
          ["A", "Solo el dueño anula (como antes)."],
          ["B", "El cajero anula con el PIN del dueño."],
          ["C", "El cajero anula sin PIN, con motivo de la lista y límites; si pasa un límite, pide el PIN."],
        ] as const
      ).map(([o, t]) => (
        <label key={o} className="check">
          <input type="radio" name="anulacion" checked={op === o} onChange={() => elegir(o)} /> <strong>{o}.</strong> {t}
        </label>
      ))}
      {op === "C" && actual && (
        <>
          <Celda
            a={{ id: "ventas.anular", area: "", nombre: "Anular una venta", sensible: true, protegida: true, noDelegable: false, limites: L_MONTO | L_CANTIDAD | L_TURNO | L_VENTANA, dueno: actual, duenoSigueCajero: false, normalCajero: actual, normalTecnico: actual, niveles: N_PIN | N_MOTIVO | N_SI, montoOPin: false }}
            quien="cajero"
            valor={actual}
            onCambio={(v) => {
              const d = copia(p.d);
              if (v) d.cajero["ventas.anular"] = v;
              p.setD(d);
            }}
          />
          <Alert tono="info">
            Siempre con PIN, aunque cumpla los límites: ventas de un turno cerrado, ventas con factura electrónica y devoluciones de más dinero del permitido. Las ventas que liquidan un apartado o un crédito con abonos se corrigen en Apartados.
          </Alert>
        </>
      )}
      <Field label="Motivos (uno por línea; «Otro» pide escribir cuál)">
        <textarea rows={5} value={p.d.motivosAnulacion.join("\n")} onChange={(e) => p.setD({ ...copia(p.d), motivosAnulacion: e.target.value.split("\n").map((x) => x.trimStart()).filter((x, i, l) => x || i === l.length - 1) })} />
      </Field>
      <Field label="Marcar el día en Cierres de caja si hay más anulaciones sin PIN que">
        <input inputMode="numeric" value={p.d.umbralAvisoAnulaciones} onChange={(e) => p.setD({ ...copia(p.d), umbralAvisoAnulaciones: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={p.d.comprobanteAnulacionAb} onChange={(e) => p.setD({ ...copia(p.d), comprobanteAnulacionAb: e.target.checked })} /> Imprimir comprobante también en las opciones A y B (en C siempre se imprime)
      </label>
    </section>
  );
}

/** Tiempo de bloqueo. También en Configuración técnica (mismo componente, guarda solo esto). */
export function Bloqueo(p: { d: Datos; setD?(d: Datos): void; soloEsto?: boolean }) {
  const [i, setI] = useState<Inactividad>(p.d.inactividad);
  const [error, setError] = useState("");
  const toast = useToast();
  const { usuario } = useSesion();
  const poner = (x: Inactividad) => (setI(x), p.setD?.({ ...copia(p.d), inactividad: x }));
  const campo = (k: "cajero" | "dueno" | "tecnico", texto: string) => (
    <Field label={texto} ayuda={describirInactividad(minutosDe(i, k))}>
      <input inputMode="numeric" placeholder={`General (${i.general})`} value={i[k] ?? ""} onChange={(e) => poner({ ...i, [k]: e.target.value.trim() === "" ? null : Number(e.target.value.replace(/\D/g, "")) })} />
    </Field>
  );
  return (
    <section className="card">
      <h2>Bloqueo por inactividad</h2>
      <p className="muted">De 1 a 60 minutos (el técnico, hasta 15). No se puede apagar. Bajarlo lo hace el técnico solo; subirlo de 10 minutos pide el PIN del dueño.</p>
      <Field label="General (minutos)" ayuda={describirInactividad(minutosDe(i, "cajero"))}>
        <input inputMode="numeric" value={i.general} onChange={(e) => poner({ ...i, general: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
      </Field>
      {campo("cajero", "Cajero (vacío = general)")}
      {campo("dueno", "Dueño (vacío = general)")}
      {campo("tecnico", "Técnico (vacío = general, máx. 15)")}
      {error && <Alert tono="error">{error}</Alert>}
      {p.soloEsto && (
        <Button
          variante="primario"
          icono={Save}
          onClick={() =>
            seguridadInactividad(i, null).then(
              () => (setError(""), toast.ok("Tiempo de bloqueo guardado", describirInactividad(minutosDe(i, usuario.rol)))),
              (e) => setError(textoError(e)),
            )
          }
        >
          Guardar el tiempo
        </Button>
      )}
    </section>
  );
}

function Guardar(p: { s: Seguridad; d: Datos; lista: string[]; plantilla: string | null; onDeshacer(): void; onGuardado(): void }) {
  const [motivo, setMotivo] = useState("");
  const [pidePin, setPidePin] = useState(false);
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!p.lista.length) return setPidePin(false);
    seguridadDiferencias(p.d).then((x) => setPidePin(x.length > 0), () => setPidePin(false));
  }, [p.d, p.lista.length]);
  async function pdf() {
    try {
      const n = await leerNegocio();
      const bytes = crearPdfReporte({ negocio: n.nombreComercial, titulo: "Tabla de permisos", subtitulo: `Versión ${p.s.version}`, logo: null, lineas: lineasTabla(p.s.datos, p.s.version, p.s.catalogo, p.s.cajeros) });
      toast.guardado("Tabla de permisos guardada", await descargar(`permisos-v${p.s.version}.pdf`, bytes, "Reportes"));
    } catch (e) {
      toast.error("No se pudo guardar el PDF", textoError(e));
    }
  }
  return (
    <section className="card barra-guardar">
      {p.lista.length ? (
        <>
          <h2>Cambios sin guardar</h2>
          <ul>
            {p.lista.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
          {pidePin && <Alert tono="aviso">Esto da más permiso sobre dinero, caja, clientes o anulaciones (o sube el bloqueo): al guardar se pide el PIN del dueño.</Alert>}
          <Field label="Motivo del cambio (opcional)">
            <input maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          </Field>
          {error && <Alert tono="error">{error}</Alert>}
          <div className="fila">
            <Button
              variante="primario"
              icono={Save}
              disabled={ocupado}
              onClick={async () => {
                setOcupado(true);
                setError("");
                try {
                  const v = await seguridadGuardar(p.d, motivo, p.plantilla, null);
                  toast.ok(`Permisos guardados (versión ${v})`, "Se aplican ya, sin cerrar sesión.");
                  setMotivo("");
                  p.onGuardado();
                } catch (e) {
                  setError(textoError(e));
                } finally {
                  setOcupado(false);
                }
              }}
            >
              Guardar
            </Button>
            <Button variante="fantasma" icono={RotateCcw} onClick={p.onDeshacer}>
              Deshacer
            </Button>
          </div>
        </>
      ) : (
        <div className="fila">
          <span className="muted">Versión {p.s.version} vigente.</span>
          <Button icono={FileDown} onClick={() => void pdf()}>
            PDF para firmar
          </Button>
        </div>
      )}
    </section>
  );
}

function Historial(p: { s: Seguridad; onCambio(): void }) {
  const [filas, setFilas] = useState<VersionFila[]>([]);
  const [ver, setVer] = useState<{ id: number; lista: string[] } | null>(null);
  const [error, setError] = useState("");
  const toast = useToast();
  useEffect(() => void seguridadHistorial().then(setFilas, (e) => setError(textoError(e))), [p.s.version]);
  return (
    <section className="card">
      <h2>
        <History size={18} aria-hidden /> Historial de versiones
      </h2>
      {error && <Alert tono="error">{error}</Alert>}
      <table className="tbl">
        <thead>
          <tr>
            <th>Versión</th>
            <th>Cuándo</th>
            <th>Quién</th>
            <th>PIN del dueño</th>
            <th>Motivo</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => (
            <tr key={f.id}>
              <td>
                {f.id}
                {f.id === p.s.version && " (vigente)"}
              </td>
              <td>{fechaHora(new Date(f.creadaEn))}</td>
              <td>{f.creadaPor ?? "Sistema"}</td>
              <td>{f.pinDueno ? "Sí" : "No"}</td>
              <td>{f.plantilla ? `Plantilla ${f.plantilla}. ` : ""}{f.motivo}</td>
              <td>
                {f.id !== p.s.version && (
                  <Button variante="fantasma" onClick={() => seguridadVersion(f.id).then((d) => setVer({ id: f.id, lista: cambios(p.s.datos, d, p.s.catalogo) }), (e) => setError(textoError(e)))}>
                    Ver
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ver && (
        <div>
          <p>
            <strong>Volver a la versión {ver.id} cambiaría:</strong>
          </p>
          <ul>{ver.lista.length ? ver.lista.map((x, i) => <li key={i}>{x}</li>) : <li>Nada.</li>}</ul>
          <Button
            variante="primario"
            icono={RotateCcw}
            onClick={() =>
              seguridadVolver(ver.id, "", "").then(
                (v) => (toast.ok(`Se volvió a la versión ${ver.id}`, `Queda como versión ${v}.`), setVer(null), p.onCambio()),
                (e) => setError(textoError(e)),
              )
            }
          >
            Volver a esta versión (pide el PIN del dueño)
          </Button>
        </div>
      )}
    </section>
  );
}
