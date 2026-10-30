// Ventas del día: reimprimir (COPIA), corregir forma de pago y anular. El cierre es el de Caja.
import { Ban, Landmark, Pencil, Printer, ReceiptText, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import Modal from "../components/Modal";
import { listarBancos, listarFormasPago } from "../db/formasPago";
import { anularVenta, correccionesDe, corregirPago, listarVentasDia, obtenerVenta, type Correccion, type VentaResumen } from "../db/ventas";
import { diaLocal } from "../lib/texto";
import { monto } from "../lib/tickets";
import { imprimirVenta } from "../lib/venta/imprimir";
import type { Banco, FormaPago, Venta, VentaPago } from "../tipos";
import Alert from "../ui/Alert";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import Field from "../ui/Field";
import FilaClic from "../ui/FilaClic";

export default function VentasHoy() {
  const { caja, irA, puede } = useSesion();
  const [dia, setDia] = useState(diaLocal());
  const [lista, setLista] = useState<VentaResumen[]>([]);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [error, setError] = useState("");

  const cargar = async () => {
    setLista(await listarVentasDia(dia));
  };
  useEffect(() => void cargar().catch((e) => setError(textoError(e))), [dia]);

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
        {caja?.turno ? <Badge tono="ok">Caja abierta</Badge> : <Badge tono="aviso">Caja cerrada</Badge>}
        <span style={{ flex: 1 }} />
        {puede("caja") && (
          <Button icono={Landmark} onClick={() => irA("caja")}>
            Ir a Caja
          </Button>
        )}
      </div>
      <Mensaje error={error} />
      <div className="conteos">
        <div>
          <strong>{completadas.length}</strong>ventas
        </div>
        <div>
          <strong>{monto(completadas.reduce((s, v) => s + v.total, 0))}</strong>vendido
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
  const [correcciones, setCorrecciones] = useState<Correccion[]>([]);
  const [corrigiendo, setCorrigiendo] = useState<VentaPago | null>(null);
  const [anulando, setAnulando] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const cargar = async () => {
    const x = await obtenerVenta(p.ventaId);
    setV(x);
    if (x) setCorrecciones(await correccionesDe(x.id));
  };
  useEffect(() => void cargar().catch((e) => setError(textoError(e))), [p.ventaId]);
  if (!v) return <Modal titulo="Venta" onCerrar={p.onCerrar}>{error ? <Mensaje error={error} /> : "Cargando…"}</Modal>;

  const verCliente = puede("clientes.basico");
  // Turno cerrado: corregir o anular es un ajuste que solo hace el dueño (queda en la caja de hoy).
  const puedeAjustar = v.turnoAbierto ? puede("venta") : puede("caja.admin");
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
                {puedeAjustar && v.estado === "completada" && (
                  <Button icono={Pencil} onClick={() => setCorrigiendo(pg)}>
                    Corregir forma
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!v.turnoAbierto && (
        <Alert tono="info">
          La caja de esta venta ya se cerró. {puede("caja.admin") ? "Una corrección o anulación queda como ajuste en la caja de hoy." : "Solo el dueño puede corregirla o anularla."}
        </Alert>
      )}
      {correcciones.length > 0 && (
        <>
          <h3>Correcciones</h3>
          <ul className="muted">
            {correcciones.map((c, i) => (
              <li key={i}>
                {new Date(c.fecha).toLocaleString("es-CR")} · {c.usuario}: {c.antes} → {c.despues} — {c.motivo}
                {c.donde === "ajuste" && " (ajuste posterior al cierre)"}
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
        {v.estado === "completada" && puedeAjustar && (
          <Button variante="peligro" icono={Ban} onClick={() => setAnulando(true)}>
            Anular venta
          </Button>
        )}
      </div>
      {corrigiendo && (
        <CorregirPago
          pago={corrigiendo}
          turnoAbierto={v.turnoAbierto}
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
          total={v.total}
          efectivo={v.pagos.filter((x) => x.tipo === "efectivo").reduce((s, x) => s + x.monto, 0)}
          turnoAbierto={v.turnoAbierto}
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

function CorregirPago(p: { pago: VentaPago; turnoAbierto: boolean; onCerrar(): void; onListo(): Promise<void> }) {
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
  // Turno cerrado: siempre el PIN del dueño. Abierto: solo si entra o sale efectivo de la gaveta.
  const pidePin = !p.turnoAbierto || (!!nueva && !!antes && nueva.daVuelto !== antes.daVuelto);

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
        {pidePin && (
          <label className="campo">
            {p.turnoAbierto ? "PIN del dueño (cambia el efectivo de la caja)" : "Su PIN de dueño (la caja de esta venta ya cerró)"}
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

function Anular(p: { ventaId: string; numero: string; total: number; efectivo: number; turnoAbierto: boolean; onCerrar(): void; onListo(): Promise<void> }) {
  const { actor } = useSesion();
  const [motivo, setMotivo] = useState("");
  const [pin, setPin] = useState("");
  const [devolver, setDevolver] = useState(p.efectivo > 0 ? String(p.efectivo) : "");
  const [error, setError] = useState("");
  return (
    <Modal titulo={`Anular tiquete ${p.numero}`} onCerrar={p.onCerrar} ancho={420}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            const dev = p.turnoAbierto ? 0 : Number(devolver.replace(/\D/g, "") || 0);
            await anularVenta(actor, p.ventaId, pin, motivo, dev);
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
        {!p.turnoAbierto && (
          <Field label="Efectivo que se devuelve ahora" ayuda={`Sale de la caja de hoy como salida. Máximo ${monto(p.total)}; 0 si no se devuelve dinero.`}>
            <input inputMode="numeric" value={devolver} onChange={(e) => setDevolver(e.target.value.replace(/\D/g, ""))} />
          </Field>
        )}
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
