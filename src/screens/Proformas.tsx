// Proformas (cotizaciones): buscar por número, nombre o producto; ver, reimprimir (COPIA), PDF, pasar a
// venta (una pestaña nueva ligada; se convierte al cobrar o apartar) y anular (dueño). Opciones del dueño.
// Rust decide todo (proformas.rs). No mueven dinero ni inventario.
import { Ban, FileDown, FileText, Printer, ShoppingCart } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import Modal from "../components/Modal";
import { guardarConfig } from "../db/config";
import { obtenerNegocio } from "../db/negocio";
import { abrirProforma, anularProforma, buscarProformas, obtenerProforma, type FiltroProformas, type ProformaDetalle, type ProformaFila } from "../db/proformas";
import { crearEspera } from "../db/ventas";
import { descargar } from "../lib/exportarCliente";
import { crearDocumento } from "../lib/pdf";
import { imprimirProforma, proformaPdf } from "../lib/proformas";
import { fechaHora, monto } from "../lib/tickets";
import Alert from "../ui/Alert";
import Badge, { type Tono } from "../ui/Badge";
import Button from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import Field from "../ui/Field";
import FilaClic from "../ui/FilaClic";
import { flechasPestanas } from "../ui/pestanas";
import { useToast } from "../ui/Toast";
import { useEnvio } from "../ui/useEnvio";
import { activarAlEntrar } from "./venta/useEsperas";

const fecha = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const TONO: Record<string, Tono> = { vigente: "ok", vencida: "aviso", convertida: "info", anulada: "error", reemplazada: "info" };
const NOMBRE: Record<string, string> = { vigente: "Vigente", vencida: "Vencida", convertida: "Convertida", anulada: "Anulada", reemplazada: "Reemplazada" };

export function EstadoProforma({ estado }: { estado: string }) {
  return <Badge tono={TONO[estado] ?? "info"}>{NOMBRE[estado] ?? estado}</Badge>;
}

export default function Proformas() {
  const { puede } = useSesion();
  const [tab, setTab] = useState<FiltroProformas | "opciones">("vigentes");
  const [texto, setTexto] = useState("");
  const [lista, setLista] = useState<ProformaFila[] | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [error, setError] = useState("");
  const tabs: [FiltroProformas | "opciones", string][] = [
    ["vigentes", "Vigentes"],
    ["vencidas", "Vencidas"],
    ["convertidas", "Convertidas"],
    ["anuladas", "Anuladas"],
    ["", "Todas"],
    ...(puede("proformas.admin") ? ([["opciones", "Opciones"]] as [FiltroProformas | "opciones", string][]) : []),
  ];
  const cargar = () => (tab === "opciones" ? Promise.resolve() : buscarProformas(texto, tab).then(setLista, (e) => setError(textoError(e))));
  useEffect(() => {
    setLista(null);
    void cargar();
  }, [tab, texto]);

  return (
    <div className="screen">
      <h1>Proformas</h1>
      <div className="tabs" role="tablist" aria-label="Proformas" onKeyDown={flechasPestanas}>
        {tabs.map(([id, t]) => (
          <button key={id || "todas"} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
            {t}
          </button>
        ))}
      </div>
      <Mensaje error={error} />
      {tab === "opciones" ? (
        <Opciones />
      ) : (
        <>
          <Field label="Número, nombre o producto">
            <input value={texto} placeholder="P-0012, Marta, cuaderno…" onChange={(e) => setTexto(e.target.value)} />
          </Field>
          {lista === null ? (
            <p className="muted">Cargando…</p>
          ) : lista.length === 0 ? (
            <EmptyState icono={FileText} titulo="No hay proformas aquí" texto="Se crean desde la venta con F11 o el botón «Proforma»." />
          ) : (
            <table className="tbl">
              <caption className="sr-only">Proformas</caption>
              <thead>
                <tr>
                  <th scope="col">Número</th>
                  <th scope="col">Fecha</th>
                  <th scope="col">Cliente</th>
                  <th scope="col">Válida hasta</th>
                  <th scope="col" className="num">
                    Total
                  </th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>
                {lista.map((x) => (
                  <FilaClic key={x.id} etiqueta={`${x.numero}, ${x.cliente ?? "sin nombre"}, ${monto(x.total)}`} onAbrir={() => setAbierta(x.id)}>
                    <td className="mono">{x.numero}</td>
                    <td>{fechaHora(new Date(x.fecha)).slice(0, 16)}</td>
                    <td>{x.cliente ?? <span className="muted">no registrado</span>}</td>
                    <td>{fecha(x.vence)}</td>
                    <td className="num">{monto(x.total)}</td>
                    <td>
                      <EstadoProforma estado={x.estado} />
                    </td>
                  </FilaClic>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {abierta && <Detalle id={abierta} onCerrar={() => (setAbierta(null), void cargar())} />}
    </div>
  );
}

function Detalle(p: { id: string; onCerrar(): void }) {
  const { puede, irA, actor } = useSesion();
  const toast = useToast();
  const [d, setD] = useState<ProformaDetalle | null>(null);
  const [error, setError] = useState("");
  const [avisos, setAvisos] = useState<{ avisos: string[]; vencida: boolean; abrir(): Promise<void> } | null>(null);
  const [anulando, setAnulando] = useState(false);
  const envio = useEnvio();
  useEffect(() => void obtenerProforma(p.id).then(setD, (e) => setError(textoError(e))), [p.id]);
  if (!d) return <Modal titulo="Proforma" onCerrar={p.onCerrar}>{error ? <Mensaje error={error} /> : "Cargando…"}</Modal>;
  const x = d.proforma;
  const convertible = x.estado === "vigente" || x.estado === "vencida";

  async function pasarAVenta() {
    const r = await abrirProforma(x.id);
    const abrir = async () => {
      const esp = await crearEspera(actor, r.estado);
      activarAlEntrar(esp.id);
      irA("venta");
    };
    // Vencida o con cambios: primero el aviso línea por línea; si no, directo a la venta.
    if (r.vencida || r.avisos.length) setAvisos({ avisos: r.avisos, vencida: r.vencida, abrir });
    else await abrir();
  }

  async function pdf() {
    const n = await obtenerNegocio();
    const bytes = crearDocumento({ negocio: n.nombreComercial || "Punto de venta", titulo: `Proforma ${x.numero}`, subtitulo: `Válida hasta el ${fecha(x.vence)}`, logo: n.logo, bloques: proformaPdf(d!) });
    toast.guardado("PDF guardado.", await descargar(`proforma-${x.numero}.pdf`, bytes, "Clientes"));
  }

  return (
    <Modal
      titulo={`Proforma ${x.numero}`}
      onCerrar={p.onCerrar}
      ancho={720}
      pie={
        <div className="fila-botones">
          <Button icono={Printer} disabled={envio.ocupado} onClick={() => envio.enviar(() => imprimirProforma(x.id, true).then(() => toast.ok("Proforma enviada (COPIA)."), (e) => setError(textoError(e))))}>
            Reimprimir
          </Button>
          <Button icono={FileDown} disabled={envio.ocupado} onClick={() => envio.enviar(() => pdf().catch((e) => setError(textoError(e))))}>
            PDF
          </Button>
          <span className="separador" />
          {convertible && puede("proformas.anular") && (
            <Button variante="peligro" icono={Ban} onClick={() => setAnulando(true)}>
              Anular
            </Button>
          )}
          {convertible && (
            <Button variante="primario" icono={ShoppingCart} disabled={envio.ocupado} onClick={() => envio.enviar(() => pasarAVenta().catch((e) => setError(textoError(e))))}>
              Pasar a venta
            </Button>
          )}
        </div>
      }
    >
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{x.cliente ?? "Cliente no registrado"}</strong>
          <div className="muted">
            {fechaHora(new Date(x.fecha))} · atendió {x.usuario} · válida hasta el {fecha(x.vence)}
            {x.convertidaEn && ` · convertida en ${x.convertidaEn}`}
          </div>
        </div>
        <EstadoProforma estado={x.estado} />
      </div>
      <table className="tbl">
        <caption className="sr-only">Detalle de la proforma</caption>
        <tbody>
          {d.lineas.map((l, i) => (
            <tr key={i}>
              <td>
                {l.cantidad} × {l.descripcion}
                {l.descuento > 0 && <span className="muted"> · descuento {monto(l.descuento)}</span>}
              </td>
              <td className="num">{monto(l.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {d.descuento > 0 && (
            <tr>
              <td>Descuento</td>
              <td className="num">-{monto(d.descuento)}</td>
            </tr>
          )}
          <tr className="total">
            <td>Total</td>
            <td className="num">{monto(x.total)}</td>
          </tr>
        </tfoot>
      </table>
      {d.condiciones && <p className="muted">{d.condiciones}</p>}
      <Mensaje error={error} />
      {avisos && (
        <Modal titulo={avisos.vencida ? `${x.numero} venció el ${fecha(x.vence)}` : "Cambios desde la proforma"} onCerrar={() => setAvisos(null)} ancho={520}>
          {avisos.vencida && <Alert tono="aviso">Está vencida: se cobra al precio de hoy.</Alert>}
          {avisos.avisos.length > 0 && (
            <ul>
              {avisos.avisos.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
          <div className="fila-botones">
            <Button onClick={() => setAvisos(null)}>Volver</Button>
            <span className="separador" />
            <Button variante="primario" autoFocus onClick={() => void avisos.abrir().catch((e) => setError(textoError(e)))}>
              Abrir la venta con estos precios
            </Button>
          </div>
        </Modal>
      )}
      {anulando && <Anular id={x.id} numero={x.numero} onCerrar={() => setAnulando(false)} onHecho={() => (toast.ok(`${x.numero} anulada.`), p.onCerrar())} />}
    </Modal>
  );
}

function Anular(p: { id: string; numero: string; onCerrar(): void; onHecho(): void }) {
  const [motivo, setMotivo] = useState("");
  const { ocupado, error, enviar } = useEnvio();
  return (
    <Modal titulo={`Anular ${p.numero}`} onCerrar={p.onCerrar} ancho={460}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void enviar(async () => {
            await anularProforma(p.id, motivo);
            p.onHecho();
          });
        }}
      >
        <Field label="Motivo">
          <input autoFocus value={motivo} maxLength={300} onChange={(e) => setMotivo(e.target.value)} />
        </Field>
        <Mensaje error={error} />
        <div className="fila-botones">
          <Button type="submit" variante="peligro" disabled={ocupado || motivo.trim().length < 5}>
            Anular proforma
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Opciones del dueño: vigencia, precio al convertir, condiciones y cuánto se guarda el nombre escrito. */
function Opciones() {
  const { actor, config, recargarConfig } = useSesion();
  const toast = useToast();
  const [dias, setDias] = useState(String(config.proforma_vigencia_dias));
  const [tipo, setTipo] = useState(config.proforma_vigencia_tipo);
  const [precio, setPrecio] = useState(config.proforma_precio_al_convertir);
  const [condiciones, setCondiciones] = useState(config.proforma_condiciones);
  const [retencion, setRetencion] = useState(String(config.proforma_retencion_nombre_dias));
  const { ocupado, error, enviar } = useEnvio();
  return (
    <form
      className="formulario card"
      onSubmit={(e) => {
        e.preventDefault();
        void enviar(async () => {
          await guardarConfig(actor, "proforma_vigencia_dias", Number(dias));
          await guardarConfig(actor, "proforma_vigencia_tipo", tipo);
          await guardarConfig(actor, "proforma_precio_al_convertir", precio);
          await guardarConfig(actor, "proforma_condiciones", condiciones.trim());
          await guardarConfig(actor, "proforma_retencion_nombre_dias", Number(retencion));
          await recargarConfig();
          toast.ok("Opciones de proformas guardadas.");
        });
      }}
    >
      <div className="row">
        <Field label="Válida por (días)">
          <input className="small" inputMode="numeric" value={dias} onChange={(e) => setDias(e.target.value.replace(/\D/g, "").slice(0, 3))} />
        </Field>
        <Field label="Los días se cuentan">
          <select value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)}>
            <option value="laborables">Solo días de trabajo</option>
            <option value="calendario">Todos (calendario)</option>
          </select>
        </Field>
        <Field label="Al pasar a venta una vigente, se cobra">
          <select value={precio} onChange={(e) => setPrecio(e.target.value as typeof precio)}>
            <option value="proforma">El precio de la proforma</option>
            <option value="actual">El precio de hoy (con aviso si cambió)</option>
          </select>
        </Field>
      </div>
      <Field label="Condiciones impresas en la proforma" ayuda="Hasta 300 letras. La leyenda «Proforma. No es una factura…» sale siempre.">
        <textarea rows={3} maxLength={300} value={condiciones} onChange={(e) => setCondiciones(e.target.value)} />
      </Field>
      <Field label="Borrar el nombre escrito después de (días)" ayuda="Cuando el cliente no está guardado. Se cuenta desde que la proforma vence, se convierte o se anula.">
        <input className="small" inputMode="numeric" value={retencion} onChange={(e) => setRetencion(e.target.value.replace(/\D/g, "").slice(0, 4))} />
      </Field>
      <Mensaje error={error} />
      <Button type="submit" variante="primario" disabled={ocupado}>
        Guardar
      </Button>
    </form>
  );
}
