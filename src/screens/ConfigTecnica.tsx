// Solo técnico. Lo que cambia entre negocios se ajusta aquí, sin tocar código.
import Alert from "../ui/Alert";
import { FileText } from "lucide-react";
import Button from "../ui/Button";
import { invocar } from "../lib/invocar";
import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import { listarBitacora, verificarBitacora, type VerificacionBitacora } from "../db/bitacora";
import { obtenerCaja } from "../db/cajas";
import { guardarConfig, leerConfigCruda } from "../db/config";
import { aSettings, ajustesDe } from "../db/impresoras";
import { estadoSistema, type EstadoSistema } from "../db/usuarios";
import { PERMISOS, type Permiso } from "../lib/permisos";
import { DEFAULT_SETTINGS, type TicketSettings } from "../lib/tickets";
import { ROL_NOMBRE, type Caja, type EntradaBitacora, type Rol } from "../tipos";
import { Bancos, FormasPago } from "./config/FormasPago";
import Departamentos from "./Departamentos";
import Preparacion from "./config/Preparacion";
import Diagnostico from "./hardware/Diagnostico";
import { useToast } from "../ui/Toast";

const TABS = [
  ["preparar", "Preparar para el cliente"],
  ["claves", "Claves de configuración"],
  ["departamentos", "Departamentos"],
  ["hardware", "Hardware"],
  ["formas", "Formas de pago"],
  ["bancos", "Bancos"],
  ["tiquete", "Formato del tiquete"],
  ["permisos", "Permisos por rol"],
  ["bitacora", "Bitácora"],
  ["sistema", "Sistema"],
] as const;
type Tab = (typeof TABS)[number][0];

export default function ConfigTecnica() {
  const [tab, setTab] = useState<Tab>("preparar");
  return (
    <div className="screen">
      <h1>Técnico</h1>
      <nav className="tabs">
        {TABS.map(([id, t]) => (
          <button key={id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
            {t}
          </button>
        ))}
      </nav>
      {tab === "preparar" && <Preparacion />}
      {tab === "claves" && <Claves />}
      {tab === "departamentos" && <Departamentos embebido />}
      {tab === "hardware" && <Hardware />}
      {tab === "formas" && <FormasPago />}
      {tab === "bancos" && <Bancos />}
      {tab === "tiquete" && (
        <Reservado texto="Formato del tiquete (logo o nombre, copias, tiquete por departamento): pendiente. Hoy el encabezado y el pie salen de Datos del negocio, y en Claves están imprime_tiquete, texto_no_factura, abrir_gaveta_efectivo y redondeo_total." />
      )}
      {tab === "permisos" && <Permisos />}
      {tab === "bitacora" && <Bitacora />}
      {tab === "sistema" && <Sistema />}
    </div>
  );
}

function Reservado({ texto }: { texto: string }) {
  return (
    <section className="card">
      <p className="muted">{texto}</p>
    </section>
  );
}

/** Editor genérico: cada clave con su valor JSON (true, 50, "texto", {...}). */
function Claves() {
  const { actor, recargarConfig } = useSesion();
  const [valores, setValores] = useState<Record<string, string>>({});
  const [originales, setOriginales] = useState<Record<string, string>>({});
  const [nueva, setNueva] = useState({ clave: "", valor: "" });
  const [error, setError] = useState("");
  const toast = useToast();

  const cargar = async () => {
    const c = await leerConfigCruda();
    const txt = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, JSON.stringify(v)]));
    setValores(txt);
    setOriginales(txt);
  };
  useEffect(() => void cargar().catch((e) => setError(textoError(e))), []);

  async function guardar(clave: string, texto: string) {
    setError("");
    let valor: unknown;
    try {
      valor = JSON.parse(texto);
    } catch {
      return setError(`"${clave}": no es JSON válido. Texto entre comillas ("así"), números sin comillas, true/false.`);
    }
    try {
      await guardarConfig(actor, clave, valor);
      await cargar();
      await recargarConfig();
      toast.ok(`"${clave}" guardada.`);
    } catch (e) {
      setError(textoError(e));
    }
  }

  return (
    <section className="card">
      <Mensaje error={error} />
      <table className="tbl tbl-grande">
        <thead>
          <tr>
            <th>Clave</th>
            <th>Valor (JSON)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {Object.keys(valores).map((k) => (
            <tr key={k}>
              <td className="mono">{k}</td>
              <td style={{ width: "60%" }}>
                <input className="mono" aria-label={`Valor de ${k}`} style={{ width: "100%" }} value={valores[k]} onChange={(e) => setValores({ ...valores, [k]: e.target.value })} />
              </td>
              <td>
                {valores[k] !== originales[k] && (
                  <button className="primary" onClick={() => guardar(k, valores[k])}>
                    Guardar
                  </button>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <input className="mono" aria-label="Clave nueva" placeholder="clave_nueva" value={nueva.clave} onChange={(e) => setNueva({ ...nueva, clave: e.target.value })} />
            </td>
            <td>
              <input className="mono" aria-label="Valor de la clave nueva (JSON)" style={{ width: "100%" }} placeholder="valor" value={nueva.valor} onChange={(e) => setNueva({ ...nueva, valor: e.target.value })} />
            </td>
            <td>
              <button disabled={!nueva.clave || !nueva.valor} onClick={() => guardar(nueva.clave, nueva.valor).then(() => setNueva({ clave: "", valor: "" }))}>
                Agregar
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/** Las impresoras se configuran en Administración → Impresoras; aquí quedan las pruebas del prototipo. */
function Hardware() {
  const { irA } = useSesion();
  const [ajustes, setAjustes] = useState<TicketSettings>(DEFAULT_SETTINGS);
  useEffect(() => {
    ajustesDe("tiquete").then((a) => a && setAjustes(aSettings(a)), () => undefined);
  }, []);
  return (
    <>
      <section className="card">
        <h2>Impresoras</h2>
        <p className="muted">Cada impresora (tiquetes, etiquetas…), su ancho, code page, cortador y gaveta, y a cuál va cada documento, se configuran en Administración → Impresoras.</p>
        <div>
          <Button onClick={() => irA("admin")}>Ir a Administración</Button>
        </div>
      </section>
      <section className="card">
        <h2>Diagnóstico (prototipo de hardware)</h2>
        <p className="muted">Pruebas del lector y de la impresora. Los cambios aquí no se guardan.</p>
        <Diagnostico key={JSON.stringify(ajustes)} ajustes={ajustes} />
      </section>
    </>
  );
}

const NOMBRE_PERMISO: Record<Permiso, string> = {
  venta: "Venta",
  productos: "Productos y códigos",
  "productos.importar": "Importar productos",
  departamentos: "Departamentos (nombre, orden)",
  "departamentos.estructura": "Departamentos (crear, códigos)",
  usuarios: "Usuarios",
  negocio: "Negocio: contacto y pie",
  "negocio.legal": "Negocio: datos legales y logo",
  "config.tecnica": "Configuración técnica",
  reportes: "Reportes",
  "clientes.basico": "Clientes: nombre y teléfono (apartados)",
  clientes: "Clientes: lista, datos, exportar, anonimizar",
  respaldo: "Respaldo cifrado (lleva datos de clientes)",
  facturas: "Pendientes de factura electrónica",
  caja: "Caja: abrir, movimientos, no venta, cerrar (conteo ciego)",
  "caja.admin": "Caja: totales en vivo, cortes, todos los turnos, reabrir, anular",
  impresoras: "Impresoras y gaveta",
  inventario: "Inventario: existencias, entradas, ajustes, conteos, costos",
};

function Permisos() {
  const roles: Rol[] = ["cajero", "dueno", "tecnico"];
  return (
    <section className="card">
      <p className="muted">Hoy son fijos. Más adelante se podrán ajustar por negocio desde aquí.</p>
      <table className="tbl tbl-grande">
        <thead>
          <tr>
            <th>Permiso</th>
            {roles.map((r) => (
              <th key={r}>{ROL_NOMBRE[r]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(Object.keys(NOMBRE_PERMISO) as Permiso[]).map((p) => (
            <tr key={p}>
              <td>{NOMBRE_PERMISO[p]}</td>
              {roles.map((r) => (
                <td key={r}>{PERMISOS[r].includes(p) ? "✓" : ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Bitacora() {
  const [lista, setLista] = useState<EntradaBitacora[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    listarBitacora(300).then(setLista, (e) => setError(textoError(e)));
  }, []);
  return (
    <section className="card">
      <Mensaje error={error} />
      <div className="tabla-scroll">
      <table className="tbl tbl-compacta">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Usuario</th>
            <th>Acción</th>
            <th>Entidad</th>
            <th>Detalle</th>
          </tr>
        </thead>
        <tbody>
          {lista.map((e) => (
            <tr key={e.id}>
              <td style={{ whiteSpace: "nowrap" }}>{new Date(e.fecha).toLocaleString("es-CR", { dateStyle: "short", timeStyle: "medium" })}</td>
              <td>{e.usuario ?? "—"}</td>
              <td className="mono" style={{ whiteSpace: "nowrap" }}>{e.accion}</td>
              <td className="mono" title={e.entidadId ?? ""} style={{ whiteSpace: "nowrap" }}>
                {e.entidad}
                {e.entidadId ? ` …${e.entidadId.slice(-6)}` : ""}
              </td>
              <td className="mono detalle">{JSON.stringify(e.detalle)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}

function Sistema() {
  const [estado, setEstado] = useState<EstadoSistema | null>(null);
  const [bit, setBit] = useState<VerificacionBitacora | null>(null);
  const [caja, setCaja] = useState<Caja | null>(null);
  const [diagnostico, setDiagnostico] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void estadoSistema().then(setEstado, (e) => setError(textoError(e)));
    void obtenerCaja().then(setCaja, (e) => setError(textoError(e)));
  }, []);
  return (
    <section className="card">
      <div className="grid2">
        <span>Carpeta de datos</span>
        <span className="mono">{estado ? estado.carpeta : "…"}</span>
        <span>Base de datos</span>
        <span>{estado ? (estado.cifrada ? "Cifrada (SQLCipher, clave protegida por Windows)" : "SIN CIFRAR (compilación de desarrollo)") : "…"}</span>
        <span>Caja</span>
        <span>{caja ? `${caja.nombre} · próximo tiquete ${caja.prefijoTiquete}${caja.consecutivoSiguiente}` : "…"}</span>
        <span>Bitácora</span>
        <span>
          {bit ? (bit.ok ? `Íntegra (${bit.filas} registros)` : `ALTERADA desde el registro ${bit.rotaEn}`) : (
            <Button onClick={() => verificarBitacora().then(setBit, (e) => setError(textoError(e)))}>
              Verificar ahora
            </Button>
          )}
        </span>
      </div>
      {error && <Alert tono="error">{error}</Alert>}
      {diagnostico && <Alert tono="ok">Diagnóstico guardado en {diagnostico}. Mándelo al desarrollador; no lleva datos de clientes.</Alert>}
      <Button
        icono={FileText}
        onClick={() =>
          invocar<string>("diagnostico_exportar").then(setDiagnostico, (e) => setError(textoError(e)))
        }
      >
        Exportar diagnóstico
      </Button>
      <p className="muted">
        La base y su clave solo sirven en esta computadora y con este usuario de Windows. Para llevar los datos a otra, use un respaldo
        cifrado (Administración → Respaldo).
      </p>
    </section>
  );
}
