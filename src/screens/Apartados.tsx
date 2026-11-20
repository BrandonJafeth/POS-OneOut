// Apartados y créditos (dueño): todos con su estado, vencidos y saldo; cancelar, ajustar, condonar,
// anular un abono, prorrogar y el límite de crédito. Todo con motivo; lo que mueve dinero, con PIN.
// Rust decide (cuentas.rs); aquí se pide y se muestra.
import { Ban, Bookmark, CalendarPlus, HandCoins, Printer, Scale, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import Modal from "../components/Modal";
import {
  ajustarCuenta,
  anularAbono,
  cancelarApartado,
  condonarCuenta,
  fijarLimiteCredito,
  listarCuentas,
  obtenerCuenta,
  prorrogarCuenta,
  reglasCuentas,
  type AbonoFila,
  type CuentaDetalle,
  type CuentaFila,
  type FiltroCuentas,
  type Reglas,
} from "../db/cuentas";
import { guardarConfig } from "../db/config";
import { imprimirComprobante } from "../lib/cuentas/imprimir";
import { conMiles, leerMontoEntero } from "../lib/texto";
import { fechaHora, monto } from "../lib/tickets";
import Button from "../ui/Button";
import CampoMonto from "../ui/CampoMonto";
import EmptyState from "../ui/EmptyState";
import Field from "../ui/Field";
import FilaClic from "../ui/FilaClic";
import { flechasPestanas } from "../ui/pestanas";
import { useToast } from "../ui/Toast";
import { EstadoCuenta } from "./venta/AbonarApartado";

const fecha = (d: string | null) => (d ? new Intl.DateTimeFormat("es-CR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`)) : "—");

type Accion = { tipo: "cancelar" } | { tipo: "ajustar" } | { tipo: "condonar" } | { tipo: "prorrogar" } | { tipo: "limite" } | { tipo: "anular"; abono: AbonoFila };

export default function Apartados() {
  const { config } = useSesion();
  const [reglas, setReglas] = useState<Reglas | null>(null);
  const [tab, setTab] = useState<FiltroCuentas | "opciones">("abiertas");
  const [lista, setLista] = useState<CuentaFila[] | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [error, setError] = useState("");
  const tabs: [FiltroCuentas | "opciones", string][] = [
    ["abiertas", "Abiertos"],
    ["vencidas", "Vencidos"],
    ["pagadas", "Pagados sin entregar"],
    ["cerradas", "Entregados y cancelados"],
    ...(config.usa_credito ? ([["credito", "Crédito"]] as [FiltroCuentas, string][]) : []),
    ["opciones", "Opciones"],
  ];

  const cargar = () => (tab === "opciones" ? Promise.resolve() : listarCuentas(tab).then(setLista, (e) => setError(textoError(e))));
  useEffect(() => void reglasCuentas().then(setReglas, () => undefined), []);
  useEffect(() => {
    setLista(null);
    void cargar();
  }, [tab]);

  const total = (lista ?? []).reduce((s, k) => s + k.saldo, 0);

  return (
    <div className="screen">
      <h1>Apartados{config.usa_credito ? " y crédito" : ""}</h1>
      <div className="tabs" role="tablist" aria-label="Apartados" onKeyDown={flechasPestanas}>
        {tabs.map(([id, t]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
            {t}
          </button>
        ))}
      </div>
      <Mensaje error={error} />
      {tab === "opciones" ? (
        reglas && <Opciones reglas={reglas} onGuardado={() => void reglasCuentas().then(setReglas)} />
      ) : lista === null ? (
        <p className="muted">Cargando…</p>
      ) : lista.length === 0 ? (
        <EmptyState
          icono={Bookmark}
          titulo={tab === "vencidas" ? "Nada vencido" : "No hay apartados aquí"}
          texto={tab === "abiertas" ? "Se crean desde la venta con F9 y se abonan con F10." : "Cuando haya, aparecen en esta lista."}
        />
      ) : (
        <>
          {(tab === "abiertas" || tab === "vencidas" || tab === "credito") && (
            <p className="muted">
              {lista.length} {lista.length === 1 ? "cuenta" : "cuentas"} · saldo por cobrar <strong className="num">{monto(total)}</strong>
            </p>
          )}
          <table className="tbl">
            <caption className="sr-only">Apartados: {tabs.find((x) => x[0] === tab)?.[1]}</caption>
            <thead>
              <tr>
                <th scope="col">Número</th>
                <th scope="col">Cliente</th>
                <th scope="col">Creado</th>
                <th scope="col">Vence</th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col" className="num">
                  Abonado
                </th>
                <th scope="col" className="num">
                  Saldo
                </th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((k) => (
                <FilaClic key={k.id} etiqueta={`${k.numero}, ${k.cliente}, saldo ${monto(k.saldo)}`} onAbrir={() => setAbierta(k.id)}>
                  <td className="mono">{k.numero}</td>
                  <td>
                    {k.cliente}
                    {k.descripcion && <div className="muted">{k.descripcion}</div>}
                  </td>
                  <td>{fecha(k.fecha)}</td>
                  <td>{fecha(k.fechaLimite)}</td>
                  <td className="num">{monto(k.total)}</td>
                  <td className="num">{monto(k.abonado)}</td>
                  <td className="num">{monto(k.saldo)}</td>
                  <td>
                    <EstadoCuenta k={k} />
                  </td>
                </FilaClic>
              ))}
            </tbody>
          </table>
        </>
      )}
      {abierta && reglas && <Detalle id={abierta} reglas={reglas} onCerrar={() => (setAbierta(null), void cargar())} />}
    </div>
  );
}

function Detalle(p: { id: string; reglas: Reglas; onCerrar(): void }) {
  const { config } = useSesion();
  const toast = useToast();
  const [d, setD] = useState<CuentaDetalle | null>(null);
  const [accion, setAccion] = useState<Accion | null>(null);
  const [error, setError] = useState("");
  const cargar = () => obtenerCuenta(p.id).then(setD, (e) => setError(textoError(e)));
  useEffect(() => void cargar(), [p.id]);
  if (!d) return null;
  const k = d.cuenta;
  const abierta = k.estado === "abierta";
  const hecho = (texto: string) => (toast.ok(texto), setAccion(null), void cargar());

  return (
    <Modal titulo={`${k.tipo === "credito" ? "Crédito" : "Apartado"} ${k.numero}`} onCerrar={p.onCerrar} ancho={760}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{k.cliente}</strong>
          {k.telefono && <span className="muted"> · {k.telefono}</span>}
          <div className="muted">
            Creado el {fecha(k.fecha)} por {d.usuario}
            {d.ventaNumero ? ` · venta ${d.ventaNumero}` : ""}
          </div>
          {k.descripcion && <p className="apartado-detalle">{k.descripcion}</p>}
        </div>
        <EstadoCuenta k={k} />
      </div>
      <dl className="cifras">
        <div>
          <dt>Total</dt>
          <dd>{monto(k.total)}</dd>
        </div>
        <div>
          <dt>Abonado</dt>
          <dd>{monto(k.abonado)}</dd>
        </div>
        <div>
          <dt>Saldo</dt>
          <dd>{monto(k.saldo)}</dd>
        </div>
        <div className={k.vencida ? "err" : undefined}>
          <dt>Vence</dt>
          <dd>{fecha(k.fechaLimite)}</dd>
        </div>
        {(d.condonado > 0 || d.devuelto > 0 || d.retenido > 0) && (
          <>
            <div>
              <dt>Condonado</dt>
              <dd>{monto(d.condonado)}</dd>
            </div>
            <div>
              <dt>Devuelto / retenido</dt>
              <dd>
                {monto(d.devuelto)} / {monto(d.retenido)}
              </dd>
            </div>
          </>
        )}
      </dl>
      <h3>Productos</h3>
      <table className="tbl">
        <caption className="sr-only">Productos del apartado</caption>
        <tbody>
          {d.lineas.map((l, i) => (
            <tr key={i}>
              <td>
                {l.cantidad} × {l.descripcion}
              </td>
              <td className="num">{monto(l.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Abonos</h3>
      <table className="tbl">
        <caption className="sr-only">Abonos</caption>
        <thead>
          <tr>
            <th scope="col">Fecha y hora</th>
            <th scope="col">Forma</th>
            <th scope="col">Recibió</th>
            <th scope="col" className="num">
              Monto
            </th>
            {abierta && <th scope="col">
              <span className="sr-only">Acciones</span>
            </th>}
          </tr>
        </thead>
        <tbody>
          {d.abonos.map((a) => (
            <tr key={a.id}>
              <td>{fechaHora(new Date(a.fecha))}</td>
              <td>
                {a.forma}
                {a.referencia ? ` · ref ${a.referencia}` : ""}
              </td>
              <td>{a.usuario}</td>
              <td className="num">{a.anulado ? <s>{monto(a.monto)}</s> : monto(a.monto)}</td>
              {abierta && (
                <td>
                  {!a.anulado && (
                    <Button variante="fantasma" icono={Undo2} onClick={() => setAccion({ tipo: "anular", abono: a })}>
                      Anular
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {d.eventos.length > 0 && (
        <details>
          <summary>Historial</summary>
          <ul>
            {d.eventos.map((e, i) => (
              <li key={i}>
                {fechaHora(new Date(e.fecha))} · {EVENTO[e.tipo] ?? e.tipo}
                {e.monto ? ` ${monto(e.monto)}` : ""} · {e.usuario}
                {e.motivo ? ` — ${e.motivo}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Mensaje error={error} />
      <div className="fila-botones">
        <Button icono={Printer} onClick={() => imprimirComprobante(k.id, config, { tipo: k.estado === "cancelada" ? "cancelacion" : "abono", copia: true }).then(() => toast.ok("Comprobante enviado (COPIA)."), (e) => setError(textoError(e)))}>
          Reimprimir
        </Button>
        {abierta && (
          <>
            <Button icono={CalendarPlus} onClick={() => setAccion({ tipo: "prorrogar" })}>
              Prorrogar
            </Button>
            <Button icono={Scale} onClick={() => setAccion({ tipo: "ajustar" })}>
              Ajustar saldo
            </Button>
            <Button icono={HandCoins} onClick={() => setAccion({ tipo: "condonar" })}>
              Condonar
            </Button>
            {k.tipo === "apartado" && (
              <Button variante="peligro" icono={Ban} onClick={() => setAccion({ tipo: "cancelar" })}>
                Cancelar apartado
              </Button>
            )}
          </>
        )}
        {k.tipo === "credito" && (
          <Button onClick={() => setAccion({ tipo: "limite" })}>Límite de crédito</Button>
        )}
      </div>
      {accion && <DialogoAccion accion={accion} d={d} reglas={p.reglas} onHecho={hecho} onCerrar={() => setAccion(null)} />}
    </Modal>
  );
}

const EVENTO: Record<string, string> = {
  creada: "Creado",
  abono: "Abono",
  abono_anulado: "Abono anulado",
  liquidada: "Liquidado",
  entregada: "Entregado",
  cancelada: "Cancelado, devuelto",
  ajuste: "Ajuste",
  condonacion: "Condonado",
  prorroga: "Prórroga",
};

/** Una acción del dueño: motivo (y montos) + PIN en el mismo formulario. */
function DialogoAccion(p: { accion: Accion; d: CuentaDetalle; reglas: Reglas; onHecho(texto: string): void; onCerrar(): void }) {
  const k = p.d.cuenta;
  const a = p.accion;
  const retenerSugerido = p.reglas.cancelacion === "retener" ? Math.floor((k.abonado * p.reglas.retencionPct) / 100) : 0;
  const [motivo, setMotivo] = useState("");
  const [pin, setPin] = useState("");
  const [montoTxt, setMontoTxt] = useState(a.tipo === "cancelar" ? conMiles(String(k.abonado - retenerSugerido)) : a.tipo === "anular" ? "0" : "");
  const [efectivoTxt, setEfectivoTxt] = useState(a.tipo === "cancelar" ? conMiles(String(k.abonado - retenerSugerido)) : "0");
  const [baja, setBaja] = useState(true);
  const [fechaNueva, setFechaNueva] = useState(k.fechaLimite ?? "");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  const n = leerMontoEntero(montoTxt) ?? 0;
  const ef = leerMontoEntero(efectivoTxt) ?? 0;
  const conPin = a.tipo !== "prorrogar";
  const titulo = { cancelar: "Cancelar apartado", ajustar: "Ajustar saldo", condonar: "Condonar saldo", prorrogar: "Prorrogar", limite: "Límite de crédito", anular: "Anular abono" }[a.tipo];

  async function enviar() {
    switch (a.tipo) {
      case "cancelar":
        await cancelarApartado(k.id, pin, motivo, n, ef);
        return p.onHecho(`${k.numero} cancelado.`);
      case "ajustar":
        await ajustarCuenta(k.id, baja ? -n : n, pin, motivo);
        return p.onHecho("Saldo ajustado.");
      case "condonar":
        await condonarCuenta(k.id, pin, motivo, true);
        return p.onHecho(`Saldo de ${monto(k.saldo)} condonado.`);
      case "prorrogar":
        await prorrogarCuenta(k.id, fechaNueva, motivo);
        return p.onHecho("Fecha límite cambiada.");
      case "limite":
        await fijarLimiteCredito(k.clienteId, montoTxt.trim() ? n : null, pin);
        return p.onHecho("Límite guardado.");
      case "anular":
        await anularAbono(a.abono.id, pin, motivo, n);
        return p.onHecho("Abono anulado.");
    }
  }

  return (
    <Modal titulo={titulo} onCerrar={p.onCerrar} ancho={520}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setOcupado(true);
          try {
            await enviar();
          } catch (x) {
            setPin("");
            setError(textoError(x));
          } finally {
            setOcupado(false);
          }
        }}
      >
        {a.tipo === "cancelar" && (
          <>
            <p className="muted">
              Abonó {monto(k.abonado)}. {p.reglas.cancelacion === "retener" ? `La política retiene el ${p.reglas.retencionPct} %.` : "La política devuelve todo."} Lo que no se devuelva queda retenido.
            </p>
            <Field label="Se le devuelve">
              <CampoMonto autoFocus valor={montoTxt} onCambio={setMontoTxt} />
            </Field>
            <Field label="De eso, en efectivo de la caja" ayuda="Lo demás (SINPE, transferencia) se devuelve fuera de la caja.">
              <CampoMonto valor={efectivoTxt} onCambio={setEfectivoTxt} />
            </Field>
          </>
        )}
        {a.tipo === "ajustar" && (
          <>
            <div className="segmento" role="group" aria-label="Sube o baja">
              <button type="button" aria-pressed={baja} onClick={() => setBaja(true)}>
                Baja
              </button>
              <button type="button" aria-pressed={!baja} onClick={() => setBaja(false)}>
                Sube
              </button>
            </div>
            <Field label={baja ? "Baja el saldo en" : "Sube el saldo en"} ayuda={`Saldo actual ${monto(k.saldo)}. Para dejarlo en 0, use Condonar.`}>
              <CampoMonto autoFocus valor={montoTxt} onCambio={setMontoTxt} />
            </Field>
          </>
        )}
        {a.tipo === "condonar" && <p>Se perdona el saldo de {monto(k.saldo)}. {k.tipo === "apartado" ? "El apartado se liquida y se entrega (necesita la caja abierta)." : "El crédito queda pagado."}</p>}
        {a.tipo === "prorrogar" && (
          <Field label="Nueva fecha límite">
            <input type="date" autoFocus value={fechaNueva} onChange={(e) => setFechaNueva(e.target.value)} />
          </Field>
        )}
        {a.tipo === "limite" && (
          <Field label="Límite de crédito de este cliente" ayuda="Vacío: el del negocio. ¢0: sin crédito. No queda en la bitácora.">
            <CampoMonto autoFocus valor={montoTxt} onCambio={setMontoTxt} />
          </Field>
        )}
        {a.tipo === "anular" && (
          <>
            <p>
              Abono de {monto(a.abono.monto)} ({a.abono.forma}) del {fechaHora(new Date(a.abono.fecha))}.
            </p>
            <Field label="Devolver en efectivo de la caja de hoy" ayuda="Solo si el abono es de un turno ya cerrado. En su turno abierto, la anulación ya lo saca del efectivo.">
              <CampoMonto valor={montoTxt} onCambio={setMontoTxt} />
            </Field>
          </>
        )}
        {a.tipo !== "limite" && (
          <Field label="Motivo">
            <input autoFocus={a.tipo === "condonar"} value={motivo} maxLength={300} onChange={(e) => setMotivo(e.target.value)} />
          </Field>
        )}
        {conPin && (
          <Field label="PIN del dueño">
            <input className="pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
          </Field>
        )}
        <Mensaje error={error} />
        <div className="fila-botones">
          <Button type="submit" variante={a.tipo === "cancelar" ? "peligro" : "primario"} disabled={ocupado || (conPin && !pin) || (a.tipo !== "limite" && motivo.trim().length < 5)}>
            {titulo}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Política de apartados del negocio (dueño). Rust valida cada clave (config.rs). */
function Opciones(p: { reglas: Reglas; onGuardado(): void }) {
  const { actor } = useSesion();
  const toast = useToast();
  const [minimo, setMinimo] = useState(String(p.reglas.abonoMinimoPct));
  const [plazo, setPlazo] = useState(String(p.reglas.plazoDias));
  const [tipo, setTipo] = useState(p.reglas.plazoTipo);
  const [politica, setPolitica] = useState(p.reglas.cancelacion);
  const [retencion, setRetencion] = useState(String(p.reglas.retencionPct));
  const [condiciones, setCondiciones] = useState(p.reglas.condiciones);
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  return (
    <form
      className="formulario"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setOcupado(true);
        try {
          await guardarConfig(actor, "abono_minimo_pct", Number(minimo));
          await guardarConfig(actor, "apartado_plazo_dias", Number(plazo));
          await guardarConfig(actor, "apartado_plazo_tipo", tipo);
          await guardarConfig(actor, "apartado_cancelacion", politica);
          await guardarConfig(actor, "apartado_retencion_pct", Number(retencion));
          await guardarConfig(actor, "apartado_condiciones", condiciones.trim());
          p.onGuardado();
          toast.ok("Opciones de apartados guardadas.");
        } catch (x) {
          setError(textoError(x));
        } finally {
          setOcupado(false);
        }
      }}
    >
      <div className="row">
        <Field label="Abono mínimo al apartar (%)">
          <input className="small" inputMode="numeric" value={minimo} onChange={(e) => setMinimo(e.target.value.replace(/\D/g, "").slice(0, 3))} />
        </Field>
        <Field label="Plazo para retirar (días)">
          <input className="small" inputMode="numeric" value={plazo} onChange={(e) => setPlazo(e.target.value.replace(/\D/g, "").slice(0, 3))} />
        </Field>
        <Field label="Los días se cuentan">
          <select value={tipo} onChange={(e) => setTipo(e.target.value)}>
            <option value="calendario">Todos (calendario)</option>
            <option value="laborables">Solo días de trabajo</option>
          </select>
        </Field>
      </div>
      <div className="row">
        <Field label="Si el cliente cancela">
          <select value={politica} onChange={(e) => setPolitica(e.target.value)}>
            <option value="devolver">Se le devuelve todo lo abonado</option>
            <option value="retener">Se retiene una parte</option>
          </select>
        </Field>
        {politica === "retener" && (
          <Field label="Se retiene (%)">
            <input className="small" inputMode="numeric" value={retencion} onChange={(e) => setRetencion(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </Field>
        )}
      </div>
      <Field label="Condiciones impresas en el comprobante" ayuda="Hasta 300 letras. Ejemplo: «Pasado el plazo, el apartado se cancela y se devuelve lo abonado.»">
        <textarea rows={3} maxLength={300} value={condiciones} onChange={(e) => setCondiciones(e.target.value)} />
      </Field>
      <Mensaje error={error} />
      <Button type="submit" variante="primario" disabled={ocupado}>
        Guardar
      </Button>
    </form>
  );
}
