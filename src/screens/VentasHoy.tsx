// Ventas del día: reimprimir (COPIA) y, solo el dueño con su PIN, corregir forma de pago y anular.
// El cajero ve los tiquetes que emitió en el turno abierto (Rust no le manda los demás) y nunca
// sumas acumuladas; las ventas de turnos ya cerrados sí las ve. El cierre es el de Caja.
// Para encontrar una venta cuando el cliente vuelve ("la de la tijera, como a las 3"): buscar por
// tiquete, producto, monto o cajero, acotar por hora y filtrar por factura pendiente, anuladas o pago.
import { Ban, FileText, Landmark, Pencil, Printer, ReceiptText, Save, Search, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import Modal from "../components/Modal";
import { listarBancos, listarFormasPago } from "../db/formasPago";
import { anularVenta, correccionesDe, corregirPago, listarVentasDia, obtenerVenta, type Correccion, type VentaResumen } from "../db/ventas";
import { conMiles, diaLocal, plural } from "../lib/texto";
import { monto } from "../lib/tickets";
import { buscarVentas, formasDe, horaDe, pendienteFactura } from "../lib/venta/buscar";
import { imprimirVenta } from "../lib/venta/imprimir";
import { descripcionPago } from "../lib/venta/tiquete";
import type { Banco, FormaPago, Venta, VentaPago } from "../tipos";
import Alert from "../ui/Alert";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import CampoMonto from "../ui/CampoMonto";
import Field from "../ui/Field";
import FilaClic from "../ui/FilaClic";
import PedirFactura from "./venta/PedirFactura";
import { useToast } from "../ui/Toast";

export default function VentasHoy() {
  const { caja, irA, puede } = useSesion();
  const [dia, setDia] = useState(diaLocal());
  const [lista, setLista] = useState<VentaResumen[]>([]);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [texto, setTexto] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [filtro, setFiltro] = useState("todas");

  const [cargado, setCargado] = useState(false);
  const cargar = async () => {
    setLista(await listarVentasDia(dia));
    setCargado(true);
  };
  useEffect(() => void cargar().catch((e) => setError(textoError(e))), [dia]);

  const completadas = lista.filter((v) => v.estado === "completada");
  const formasDelDia = useMemo(() => [...new Set(lista.flatMap(formasDe))].sort(), [lista]);
  const pendientes = lista.filter(pendienteFactura).length;
  const anuladas = lista.filter((v) => v.estado === "anulada").length;
  const visibles = useMemo(() => buscarVentas(lista, { texto, desde, hasta, filtro }), [lista, texto, desde, hasta, filtro]);
  const hayFiltros = !!(texto || desde || hasta || filtro !== "todas");
  const limpiar = () => (setTexto(""), setDesde(""), setHasta(""), setFiltro("todas"));
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
      {puede("caja.admin") ? (
        <div className="conteos">
          <div>
            <strong>{completadas.length}</strong>ventas
          </div>
          <div>
            <strong>{monto(completadas.reduce((s, v) => s + v.total, 0))}</strong>vendido
          </div>
        </div>
      ) : (
        <p className="muted">Aquí están los tiquetes que usted emitió y los de turnos ya cerrados. Los totales del turno se ven al cerrar la caja.</p>
      )}
      {lista.length > 0 && (
        <section className="card ventas-filtros" aria-label="Buscar ventas">
          <div className="row abajo">
            <Field label="Buscar" flex={1} className="sin-margen">
              <div className="buscador-entrada">
                <Search size={20} aria-hidden />
                <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Tiquete, producto, monto o cajero" />
              </div>
            </Field>
            <Field label="Desde (hora)" className="sin-margen">
              <input type="time" value={desde} onChange={(e) => setDesde(e.target.value)} />
            </Field>
            <Field label="Hasta" className="sin-margen">
              <input type="time" value={hasta} onChange={(e) => setHasta(e.target.value)} />
            </Field>
            {hayFiltros && (
              <Button variante="fantasma" icono={X} onClick={limpiar}>
                Limpiar
              </Button>
            )}
          </div>
          <div className="chips" role="group" aria-label="Filtrar ventas">
            {[
              ["todas", `Todas (${lista.length})`],
              ...(pendientes ? [["factura", `Factura pendiente (${pendientes})`]] : []),
              ...(anuladas ? [["anuladas", `Anuladas (${anuladas})`]] : []),
              ...formasDelDia.map((fp) => [`forma:${fp}`, fp]),
            ].map(([k, t]) => (
              <button key={k} type="button" className="tab" aria-pressed={filtro === k} onClick={() => setFiltro(filtro === k ? "todas" : k)}>
                {t}
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="card">
        {!cargado ? (
          <p className="muted">Cargando…</p>
        ) : lista.length === 0 ? (
          <EmptyState icono={ReceiptText} titulo="Todavía no hay ventas este día" texto="Las ventas cobradas aparecen aquí para reimprimir, corregir el pago o anular." />
        ) : (
        <>
        {hayFiltros && <p className="muted">{visibles.length ? `${plural(visibles.length, "venta coincide", "ventas coinciden")} de ${lista.length}.` : "Ninguna venta coincide."}</p>}
        <table className="tbl tbl-grande">
          <thead>
            <tr>
              <th>Hora</th>
              <th>Tiquete</th>
              <th>Productos</th>
              <th>Cajero</th>
              <th>Pago</th>
              <th className="num">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visibles.map((v) => (
              <FilaClic key={v.id} etiqueta={`Abrir tiquete ${v.numero}`} className={v.estado === "anulada" ? "inactivo" : ""} onAbrir={() => setAbierta(v.id)}>
                <td className="hora">{horaDe(v.fecha)}</td>
                <td className="mono">{v.numero}</td>
                <td className="productos-venta" title={v.productos}>
                  <span className="muted">{plural(v.articulos, "art.", "art.")} · </span>
                  {v.productos || <span className="muted">—</span>}
                </td>
                <td>{v.cajero}</td>
                <td>{v.formas}</td>
                <td className="num">{monto(v.total)}</td>
                <td>
                  <div className="row">
                    {v.estado === "anulada" && <Badge tono="error">Anulada</Badge>}
                    {pendienteFactura(v) && <Badge tono="aviso">Factura pendiente</Badge>}
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
  const { config, puede } = useSesion();
  const [v, setV] = useState<Venta | null>(null);
  const [correcciones, setCorrecciones] = useState<Correccion[]>([]);
  const [corrigiendo, setCorrigiendo] = useState<VentaPago | null>(null);
  const [anulando, setAnulando] = useState(false);
  const [factura, setFactura] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  const cargar = async () => {
    const x = await obtenerVenta(p.ventaId);
    setV(x);
    if (x) setCorrecciones(await correccionesDe(x.id));
  };
  useEffect(() => void cargar().catch((e) => setError(textoError(e))), [p.ventaId]);
  if (!v) return <Modal titulo="Venta" onCerrar={p.onCerrar}>{error ? <Mensaje error={error} /> : "Cargando…"}</Modal>;

  const verCliente = puede("clientes.basico");
  // Una venta cobrada solo la cambia el dueño (con su PIN y motivo). Si su turno ya cerró, queda
  // como ajuste en la caja de hoy.
  const puedeAjustar = puede("caja.admin");
  async function reimprimir() {
    setError("");
    try {
      await imprimirVenta(v!.id, config, { copia: v!.impreso, verCliente });
      toast.ok(v!.impreso ? "Copia enviada a la impresora." : "Tiquete enviado a la impresora.");
      await cargar();
    } catch (e) {
      setError(textoError(e));
      toast.error("No se imprimió el tiquete", textoError(e));
    }
  }

  return (
    <Modal titulo={`Tiquete ${v.numero}`} onCerrar={p.onCerrar} ancho={680}>
      <p className="muted">
        {new Date(v.fecha).toLocaleString("es-CR")} · cobró {v.cajero}
        {v.esperaCreadaPor && v.esperaCreadaPor !== v.cajero && ` (la empezó ${v.esperaCreadaPor})`}
        {verCliente && (v.cliente || v.nombreTiquete) && ` · ${v.cliente ?? v.nombreTiquete}`}
        {v.reimpresiones > 0 && ` · reimpreso ${plural(v.reimpresiones, "vez", "veces")}`}
      </p>
      {v.requiereFactura && (
        <Alert tono={v.facturaEmitida ? "ok" : "aviso"} titulo={v.facturaEmitida ? `Factura hecha${v.facturaReferencia ? ` (${v.facturaReferencia})` : ""}` : "Factura pendiente"}>
          {!v.facturaEmitida && "Está en «Pendientes de factura» para hacerla en el sistema de facturación."}
        </Alert>
      )}
      {v.estado === "anulada" && (
        <Alert tono="error" titulo={`Venta anulada${v.anuladaPor ? ` por ${v.anuladaPor}` : ""}`}>
          {v.anuladaMotivo ?? ""}
        </Alert>
      )}
      <table className="tbl">
        <tbody>
          {v.lineas.map((l) => (
            <tr key={l.id}>
              <td className="linea-producto">{l.descripcion}</td>
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
      <h3>{v.pagos.length > 1 ? "Pago dividido" : "Pago"}</h3>
      <table className="tbl">
        <tbody>
          {v.pagos.map((pg) => (
            <tr key={pg.id}>
              <td>{descripcionPago(pg)}</td>
              <td className="num">{monto(pg.monto)}</td>
              <td className="num muted">{pg.recibido != null ? `recibió ${monto(pg.recibido)}${pg.vuelto ? `, vuelto ${monto(pg.vuelto)}` : ""}` : ""}</td>
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
      {v.turnoAbierto && !puedeAjustar && v.estado === "completada" && (
        <Alert tono="info">Para anular esta venta o cambiar su forma de pago, pida al dueño que entre con su PIN.</Alert>
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
      <Mensaje error={error} />
      <div className="fila-botones">
        <Button icono={Printer} onClick={reimprimir}>
          {v.impreso ? "Reimprimir (sale como COPIA)" : "Imprimir tiquete"}
        </Button>
        {v.estado === "completada" && !v.requiereFactura && puede("facturas") && (
          <Button icono={FileText} onClick={() => setFactura(true)}>
            Pedir factura
          </Button>
        )}
        <span className="separador" />
        {v.estado === "completada" && puedeAjustar && (
          <Button variante="fantasma" className="texto-peligro" icono={Ban} onClick={() => setAnulando(true)}>
            Anular venta
          </Button>
        )}
      </div>
      {factura && (
        <PedirFactura
          ventaId={v.id}
          numero={v.numero}
          clienteActual={v.clienteId && v.cliente ? { id: v.clienteId, nombre: v.cliente, cedula: null, telefono: null } : null}
          onCerrar={() => setFactura(false)}
          onListo={() => {
            setFactura(false);
            toast.ok("Quedó pendiente de factura.");
            void cargar();
            p.onCambio();
          }}
        />
      )}
      {corrigiendo && (
        <CorregirPago
          pago={corrigiendo}
          turnoAbierto={v.turnoAbierto}
          onCerrar={() => setCorrigiendo(null)}
          onListo={async () => {
            setCorrigiendo(null);
            await cargar();
            p.onCambio();
            toast.ok("Forma de pago corregida.");
          }}
        />
      )}
      {anulando && (
        <Anular
          ventaId={v.id}
          numero={v.numero}
          total={v.total}
          facturaEmitida={v.facturaEmitida}
          efectivo={v.pagos.filter((x) => x.tipo === "efectivo").reduce((s, x) => s + x.monto, 0)}
          turnoAbierto={v.turnoAbierto}
          onCerrar={() => setAnulando(false)}
          onListo={async () => {
            setAnulando(false);
            await cargar();
            p.onCambio();
            toast.ok("Venta anulada.");
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
  const sinCambios =
    forma === p.pago.formaPagoId &&
    (nueva?.requiereBanco ? banco || null : null) === (p.pago.bancoId ?? null) &&
    referencia.trim() === (p.pago.referencia ?? "") &&
    (nueva?.pideUltimos4 ? ultimos4 : "") === (p.pago.ultimos4 ?? "");

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
        {p.turnoAbierto && nueva && antes && nueva.daVuelto !== antes.daVuelto && (
          <Alert tono="aviso">
            La caja esperará {monto(p.pago.monto)} {nueva.daVuelto ? "más" : "menos"} en efectivo al cerrar.
          </Alert>
        )}
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
        <Field label="Motivo (obligatorio)" ayuda="Al menos 5 letras. Ej. «El cliente pagó con SINPE, no con tarjeta».">
          <input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </Field>
        {/* Solo el dueño corrige, y siempre con su PIN. */}
        <label className="campo">
          {p.turnoAbierto ? "Su PIN de dueño" : "Su PIN de dueño (la caja de esta venta ya cerró: queda como ajuste en la de hoy)"}
          <input className="pin" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </label>
        {sinCambios && <Alert tono="info">Esa ya es la forma de pago registrada. Elija la forma correcta (o cambie el banco o la referencia).</Alert>}
        {error && <Alert tono="error">{error}</Alert>}
        <Button type="submit" variante="primario" icono={Save} disabled={sinCambios || motivo.trim().length < 5}>
          Guardar corrección
        </Button>
      </form>
    </Modal>
  );
}

function Anular(p: { ventaId: string; numero: string; total: number; efectivo: number; turnoAbierto: boolean; facturaEmitida: boolean; onCerrar(): void; onListo(): Promise<void> }) {
  const { actor } = useSesion();
  const [motivo, setMotivo] = useState("");
  const [pin, setPin] = useState("");
  const [devolver, setDevolver] = useState(conMiles(String(Math.max(0, p.efectivo))));
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
        {p.turnoAbierto && p.efectivo > 0 && (
          <Alert tono="aviso" titulo={`Devuelva ${monto(p.efectivo)} en efectivo`}>
            Ese efectivo sale de lo que la caja espera al cerrar. Si no se lo devuelve al cliente, el cierre dará sobrante.
          </Alert>
        )}
        {p.total > p.efectivo && (
          <Alert tono="aviso" titulo={`${monto(p.total - p.efectivo)} con tarjeta, SINPE o transferencia`}>
            Anular aquí no devuelve ese dinero: hágalo en el datáfono o en el banco.
          </Alert>
        )}
        {p.facturaEmitida && (
          <Alert tono="error" titulo="Esta venta ya tiene factura electrónica">
            Anularla aquí no anula la factura en Hacienda: haga también la nota de crédito en el sistema de facturación.
          </Alert>
        )}
        <Field label="Motivo (obligatorio)">
          <input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </Field>
        {!p.turnoAbierto && (
          <Field label="Efectivo que se devuelve ahora" ayuda={`Sale de la caja de hoy como salida. Máximo ${monto(p.total)}; 0 si no se devuelve dinero.`}>
            <CampoMonto valor={devolver} onCambio={setDevolver} />
          </Field>
        )}
        <Field label="Su PIN de dueño">
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
