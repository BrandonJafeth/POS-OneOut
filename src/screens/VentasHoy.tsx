// Ventas del día: reimprimir (COPIA), corregir forma de pago, anular y cerrar el día.
import { Ban, CalendarCheck, Pencil, Printer, ReceiptText, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import Modal from "../components/Modal";
import { listarBancos, listarFormasPago } from "../db/formasPago";
import {
  anularVenta,
  cerrarDia,
  correccionesDe,
  corregirPago,
  diaAbierto,
  diaCerrado,
  efectivoEsperado,
  listarEsperas,
  listarVentasDia,
  obtenerVenta,
  type VentaResumen,
} from "../db/ventas";
import { diaLocal } from "../lib/texto";
import { monto } from "../lib/tickets";
import { imprimirVenta } from "../lib/venta/imprimir";
import type { Banco, FormaPago, Venta, VentaPago } from "../tipos";
import Alert from "../ui/Alert";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import { useConfirmar } from "../ui/Confirmar";
import EmptyState from "../ui/EmptyState";
import Field from "../ui/Field";
import FilaClic from "../ui/FilaClic";

export default function VentasHoy() {
  const { actor, config, puede } = useSesion();
  const confirmar = useConfirmar();
  const [dia, setDia] = useState(diaLocal());
  const [lista, setLista] = useState<VentaResumen[]>([]);
  const [efectivo, setEfectivo] = useState(0);
  const [cerrado, setCerrado] = useState(false);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const cargar = async () => {
    setLista(await listarVentasDia(dia));
    setEfectivo(await efectivoEsperado(dia));
    setCerrado(await diaCerrado(dia));
  };
  useEffect(() => void cargar().catch((e) => setError(textoError(e))), [dia]);

  async function cerrar() {
    setError("");
    setOk("");
    const esperas = await listarEsperas();
    const conProductos = esperas.filter((e) => e.estado.lineas.length).length;
    const ok = await confirmar({
      titulo: "¿Cerrar el día?",
      texto: (
        <>
          <p>Después de cerrar ya no se podrán corregir formas de pago de las ventas de hoy.</p>
          {config.avisar_espera_al_cerrar && conProductos > 0 && (
            <Alert tono="aviso">Hay {conProductos} venta(s) en espera con productos. Cóbrelas o descártelas antes, si corresponde.</Alert>
          )}
        </>
      ),
      aceptar: "Cerrar el día",
      peligro: true,
    });
    if (!ok) return;
    try {
      await cerrarDia(actor);
      await cargar();
      setOk("Día cerrado.");
    } catch (e) {
      setError(textoError(e));
    }
  }

  const completadas = lista.filter((v) => v.estado === "completada");
  return (
    <div className="screen">
      <div className="encabezado">
        <h1>Ventas del día</h1>
        <div className="row arriba">
          <Field label="Día">
            <input type="date" value={dia} max={diaLocal()} onChange={(e) => e.target.value && setDia(e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="row">
        {cerrado ? (
          <Badge tono="aviso">Día cerrado: ya no se corrigen formas de pago</Badge>
        ) : (
          dia === diaLocal() && <Badge tono="ok">Día abierto</Badge>
        )}
        <span style={{ flex: 1 }} />
        {puede("dia.cerrar") && dia === diaLocal() && !cerrado && (
          <Button icono={CalendarCheck} onClick={cerrar}>
            Cerrar el día
          </Button>
        )}
      </div>
      <Mensaje error={error} ok={ok} />
      <div className="conteos">
        <div>
          <strong>{completadas.length}</strong>ventas
        </div>
        <div>
          <strong>{monto(completadas.reduce((s, v) => s + v.total, 0))}</strong>vendido
        </div>
        <div>
          <strong>{monto(efectivo)}</strong>efectivo esperado
        </div>
      </div>
      <section className="card">
        {lista.length === 0 ? (
          <EmptyState icono={ReceiptText} titulo="Todavía no hay ventas este día" texto="Las ventas cobradas aparecen aquí para reimprimir, corregir el pago o anular." />
        ) : (
        <>
        <table className="tbl tbl-grande">
          <thead>
            <tr>
              <th>Tiquete</th>
              <th>Hora</th>
              <th>Cajero</th>
              <th>Pago</th>
              <th className="num">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lista.map((v) => (
              <FilaClic key={v.id} etiqueta={`Abrir tiquete ${v.numero}`} className={v.estado === "anulada" ? "inactivo" : ""} onAbrir={() => setAbierta(v.id)}>
                <td className="mono">{v.numero}</td>
                <td>{new Date(v.fecha).toLocaleTimeString("es-CR", { hour: "2-digit", minute: "2-digit" })}</td>
                <td>{v.cajero}</td>
                <td>{v.formas}</td>
                <td className="num">{monto(v.total)}</td>
                <td>
                  <div className="row">
                    {v.estado === "anulada" && <Badge tono="error">Anulada</Badge>}
                    {v.requiereFactura && !v.facturaEmitida && <Badge tono="aviso">Factura pendiente</Badge>}
                  </div>
                </td>
              </FilaClic>
            ))}
          </tbody>
        </table>
        </>
        )}
      </section>
      {abierta && <DetalleVenta ventaId={abierta} onCerrar={() => setAbierta(null)} onCambio={() => void cargar()} />}
    </div>
  );
}

function DetalleVenta(p: { ventaId: string; onCerrar(): void; onCambio(): void }) {
  const { actor, config, puede } = useSesion();
  const [v, setV] = useState<Venta | null>(null);
  const [abiertoDia, setAbiertoDia] = useState(false);
  const [correcciones, setCorrecciones] = useState<Record<string, unknown>[]>([]);
  const [corrigiendo, setCorrigiendo] = useState<VentaPago | null>(null);
  const [anulando, setAnulando] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const cargar = async () => {
    const x = await obtenerVenta(p.ventaId);
    setV(x);
    if (x) {
      setAbiertoDia(await diaAbierto(x.dia, x.cajaId));
      setCorrecciones(await correccionesDe(x.id));
    }
  };
  useEffect(() => void cargar().catch((e) => setError(textoError(e))), [p.ventaId]);
  if (!v) return <Modal titulo="Venta" onCerrar={p.onCerrar}>{error ? <Mensaje error={error} /> : "Cargando…"}</Modal>;

  const verCliente = puede("clientes.basico");
  async function reimprimir() {
    setError("");
    setOk("");
    try {
      await imprimirVenta(actor, v!.id, config, { copia: true, verCliente });
      setOk("Copia enviada a la impresora.");
      await cargar();
    } catch (e) {
      setError(textoError(e));
    }
  }

  return (
    <Modal titulo={`Tiquete ${v.numero}`} onCerrar={p.onCerrar} ancho={680}>
      <p className="muted">
        {new Date(v.fecha).toLocaleString("es-CR")} · {v.cajero}
        {verCliente && (v.cliente || v.nombreTiquete) && ` · ${v.cliente ?? v.nombreTiquete}`}
        {v.reimpresiones > 0 && ` · reimpreso ${v.reimpresiones} vez/veces`}
      </p>
      {v.estado === "anulada" && <Alert tono="error" titulo="Venta anulada">{v.anuladaMotivo ?? ""}</Alert>}
      <table className="tbl">
        <tbody>
          {v.lineas.map((l) => (
            <tr key={l.id}>
              <td>{l.descripcion}</td>
              <td className="num">
                {l.cantidad} × {monto(l.precioUnitario)}
              </td>
              <td className="num">{l.descuento ? "-" + monto(l.descuento) : ""}</td>
              <td className="num">{monto(l.total)}</td>
            </tr>
          ))}
          {v.descuento > 0 && (
            <tr>
              <td colSpan={3}>Descuento al total</td>
              <td className="num">-{monto(v.descuento)}</td>
            </tr>
          )}
          <tr>
            <td colSpan={3}>
              <strong>Total</strong>
            </td>
            <td className="num">
              <strong>{monto(v.total)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      <h3>Pagos</h3>
      <table className="tbl">
        <tbody>
          {v.pagos.map((pg) => (
            <tr key={pg.id}>
              <td>
                {pg.forma}
                {pg.banco && ` · ${pg.banco}`}
                {pg.referencia && ` · ref. ${pg.referencia}`}
                {pg.ultimos4 && ` · ****${pg.ultimos4}`}
              </td>
              <td className="num">{monto(pg.monto)}</td>
              <td className="num muted">{pg.vuelto ? `recibió ${monto(pg.recibido ?? 0)}, vuelto ${monto(pg.vuelto)}` : ""}</td>
              <td>
                {abiertoDia && v.estado === "completada" && (
                  <Button icono={Pencil} onClick={() => setCorrigiendo(pg)}>
                    Corregir forma
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!abiertoDia && <Alert tono="info">El día de esta venta ya se cerró: la forma de pago no se puede corregir.</Alert>}
      {correcciones.length > 0 && (
        <>
          <h3>Correcciones</h3>
          <ul className="muted">
            {correcciones.map((c, i) => (
              <li key={i}>
                {new Date(String(c.fecha)).toLocaleString("es-CR")} · {String(c.usuario)}: {String(c.antes)} → {String(c.despues)} — {String(c.motivo)}
              </li>
            ))}
          </ul>
        </>
      )}
      <Mensaje error={error} ok={ok} />
      <div className="fila-botones">
        <Button icono={Printer} onClick={reimprimir}>
          Reimprimir (sale como COPIA)
        </Button>
        <span className="separador" />
        {v.estado === "completada" && (
          <Button variante="peligro" icono={Ban} onClick={() => setAnulando(true)}>
            Anular venta
          </Button>
        )}
      </div>
      {corrigiendo && (
        <CorregirPago
          pago={corrigiendo}
          onCerrar={() => setCorrigiendo(null)}
          onListo={async () => {
            setCorrigiendo(null);
            await cargar();
            p.onCambio();
            setOk("Forma de pago corregida.");
          }}
        />
      )}
      {anulando && (
        <Anular
          ventaId={v.id}
          numero={v.numero}
          onCerrar={() => setAnulando(false)}
          onListo={async () => {
            setAnulando(false);
            await cargar();
            p.onCambio();
            setOk("Venta anulada.");
          }}
        />
      )}
    </Modal>
  );
}

function CorregirPago(p: { pago: VentaPago; onCerrar(): void; onListo(): Promise<void> }) {
  const { actor } = useSesion();
  const [formas, setFormas] = useState<FormaPago[]>([]);
  const [bancos, setBancos] = useState<Banco[]>([]);
  const [forma, setForma] = useState(p.pago.formaPagoId);
  const [banco, setBanco] = useState(p.pago.bancoId ?? "");
  const [referencia, setReferencia] = useState(p.pago.referencia ?? "");
  const [ultimos4, setUltimos4] = useState(p.pago.ultimos4 ?? "");
  const [motivo, setMotivo] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void listarFormasPago().then(setFormas);
    void listarBancos().then(setBancos);
  }, []);
  const nueva = formas.find((f) => f.id === forma);
  const antes = formas.find((f) => f.id === p.pago.formaPagoId);
  const tocaEfectivo = !!nueva && !!antes && nueva.daVuelto !== antes.daVuelto;

  return (
    <Modal titulo={`Corregir pago de ${monto(p.pago.monto)}`} onCerrar={p.onCerrar} ancho={480}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await corregirPago(actor, p.pago.id, { formaPagoId: forma, bancoId: banco || null, referencia, ultimos4 }, motivo, pin || undefined);
            await p.onListo();
          } catch (err) {
            setError(textoError(err));
          }
        }}
      >
        <p className="muted">El monto y el total no cambian; solo la forma de pago. Queda el historial.</p>
        <Field label="Forma de pago correcta">
          <select value={forma} onChange={(e) => setForma(e.target.value)}>
            {formas.map((f) => (
              <option key={f.id} value={f.id}>
                {f.nombre}
              </option>
            ))}
          </select>
        </Field>
        {nueva?.requiereBanco && (
          <label className="campo">
            Banco
            <select value={banco} onChange={(e) => setBanco(e.target.value)}>
              <option value="">—</option>
              {bancos.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.nombre}
                </option>
              ))}
            </select>
          </label>
        )}
        {nueva?.requiereReferencia && (
          <label className="campo">
            Referencia
            <input value={referencia} onChange={(e) => setReferencia(e.target.value)} />
          </label>
        )}
        {nueva?.pideUltimos4 && (
          <label className="campo">
            Últimos 4 dígitos
            <input className="small" value={ultimos4} onChange={(e) => setUltimos4(e.target.value.replace(/\D/g, "").slice(0, 4))} />
          </label>
        )}
        <Field label="Motivo (obligatorio)" ayuda="Ej. «El cliente pagó con SINPE, no con tarjeta».">
          <input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </Field>
        {tocaEfectivo && (
          <label className="campo">
            PIN del dueño (cambia el efectivo de la caja)
            <input className="pin" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
          </label>
        )}
        {error && <Alert tono="error">{error}</Alert>}
        <Button type="submit" variante="primario" icono={Save}>
          Guardar corrección
        </Button>
      </form>
    </Modal>
  );
}

function Anular(p: { ventaId: string; numero: string; onCerrar(): void; onListo(): Promise<void> }) {
  const { actor } = useSesion();
  const [motivo, setMotivo] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal titulo={`Anular tiquete ${p.numero}`} onCerrar={p.onCerrar} ancho={420}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await anularVenta(actor, p.ventaId, pin, motivo);
            await p.onListo();
          } catch (err) {
            setError(textoError(err));
            setPin("");
          }
        }}
      >
        <Alert tono="aviso">La venta queda registrada como anulada (no se borra) y conserva su número. No se puede deshacer.</Alert>
        <Field label="Motivo (obligatorio)">
          <input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </Field>
        <Field label="PIN del dueño">
          <input className="pin" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </Field>
        {error && <Alert tono="error">{error}</Alert>}
        <Button type="submit" variante="peligro-lleno" icono={ShieldCheck} disabled={!pin || !motivo.trim()}>
          Anular definitivamente
        </Button>
      </form>
    </Modal>
  );
}
