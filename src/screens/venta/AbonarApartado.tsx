// F10 en la venta: buscar un apartado o crédito (número, teléfono o 3 letras del nombre), ver su saldo y
// abonar. Si el abono deja el saldo en 0, el apartado se liquida (sale el tiquete de la venta) y se
// entrega. ↑/↓ y Enter recorren la lista (manejador de teclado de la venta).
import { ArrowLeft, PackageCheck, Printer, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import Mensaje, { textoError } from "../../components/Mensaje";
import { busquedaValida } from "../../lib/cuentas/busqueda";
import { buscarCuentas, entregarApartado, obtenerCuenta, type CuentaDetalle, type CuentaFila } from "../../db/cuentas";
import { imprimirComprobante } from "../../lib/cuentas/imprimir";
import { validarAbono } from "../../lib/cuentas";
import { conMiles, leerMontoEntero } from "../../lib/texto";
import { monto } from "../../lib/tickets";
import type { Banco, FormaPago, PagoEntrada } from "../../tipos";
import Badge from "../../ui/Badge";
import Button from "../../ui/Button";
import CampoMonto from "../../ui/CampoMonto";
import Field from "../../ui/Field";
import FilaClic from "../../ui/FilaClic";
import { useToast } from "../../ui/Toast";
import Cobro from "./Cobro";

const fecha = (d: string | null) => (d ? new Intl.DateTimeFormat("es-CR", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`)) : "");

export function EstadoCuenta({ k }: { k: CuentaFila }) {
  if (k.estado === "abierta") return k.vencida ? <Badge tono="error">Vencido hace {k.diasAtraso} d</Badge> : <Badge tono="info">Abierto</Badge>;
  if (k.estado === "pagada") return <Badge tono="aviso">{k.tipo === "credito" ? "Pagado" : "Pagado, sin entregar"}</Badge>;
  if (k.estado === "entregada") return <Badge tono="ok">Entregado</Badge>;
  return <Badge tono="error">Cancelado</Badge>;
}

export default function AbonarApartado(p: {
  formas: FormaPago[];
  bancos: Banco[];
  /** Abona y devuelve; la venta imprime, abre la gaveta y avisa. */
  onAbonar(cuenta: CuentaFila, monto: number, pagos: PagoEntrada[], entregar: boolean): Promise<void>;
  onCerrar(): void;
}) {
  const { config } = useSesion();
  const toast = useToast();
  const [texto, setTexto] = useState("");
  const [lista, setLista] = useState<CuentaFila[]>([]);
  const [d, setD] = useState<CuentaDetalle | null>(null);
  const [abono, setAbono] = useState("");
  const [entregar, setEntregar] = useState(true);
  const [cobrando, setCobrando] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [intento, setIntento] = useState(false);
  const buscador = useRef<HTMLInputElement>(null);

  // D3: número, teléfono o al menos 3 letras (lo mismo que exige Rust); sin eso no se lista nada.
  useEffect(() => {
    if (!busquedaValida(texto)) return setLista([]);
    const t = setTimeout(() => buscarCuentas(texto).then(setLista, (e) => setError(textoError(e))), 150);
    return () => clearTimeout(t);
  }, [texto]);

  async function abrir(k: CuentaFila) {
    setError("");
    try {
      const x = await obtenerCuenta(k.id);
      setD(x);
      setAbono(conMiles(String(x.cuenta.saldo)));
      setIntento(false);
    } catch (e) {
      setError(textoError(e));
    }
  }

  const k = d?.cuenta;
  const n = leerMontoEntero(abono) ?? 0;
  const problema = k ? validarAbono(k.saldo, n, null) : "";
  const liquida = !!k && n === k.saldo && k.tipo === "apartado";

  if (k && cobrando != null)
    return (
      <Cobro
        titulo={`Abono ${k.numero} · ${monto(cobrando)}`}
        total={cobrando}
        totalExacto={cobrando}
        pagador={k.cliente}
        formas={p.formas}
        bancos={p.bancos}
        onCobrar={(pagos) => p.onAbonar(k, cobrando, pagos, entregar)}
        onCerrar={() => setCobrando(null)}
      />
    );

  if (d && k)
    return (
      <Modal titulo={`${k.tipo === "credito" ? "Crédito" : "Apartado"} ${k.numero}`} onCerrar={p.onCerrar} ancho={640}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <strong>{k.cliente}</strong>
            {k.telefono && <span className="muted"> · {k.telefono}</span>}
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
          {k.fechaLimite && (
            <div className={k.vencida ? "err" : undefined}>
              <dt>{k.tipo === "credito" ? "Pagar antes del" : "Retirar antes del"}</dt>
              <dd>{fecha(k.fechaLimite)}</dd>
            </div>
          )}
        </dl>
        <table className="tbl">
          <caption className="sr-only">Productos</caption>
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
        {k.estado === "abierta" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setIntento(true);
              if (!problema) setCobrando(n);
            }}
          >
            <Field label="Abona" error={intento ? problema : undefined} ayuda={liquida ? "Paga todo: el apartado se liquida." : `Queda debiendo ${monto(Math.max(0, k.saldo - n))}.`}>
              <CampoMonto grande autoFocus valor={abono} onCambio={(t) => (setAbono(t), setIntento(false))} />
            </Field>
            {liquida && (
              <label className="check">
                <input type="checkbox" data-opcional checked={entregar} onChange={(e) => setEntregar(e.target.checked)} /> Se lleva los productos ahora
              </label>
            )}
            <div className="fila-botones">
              <Button icono={ArrowLeft} onClick={() => (setD(null), setTimeout(() => buscador.current?.focus(), 0))}>
                Otro apartado
              </Button>
              <span style={{ flex: 1 }} />
              <Button type="submit" variante="primario" tamano="lg" atajo="Enter">
                Cobrar el abono
              </Button>
            </div>
          </form>
        ) : (
          <div className="fila-botones">
            <Button icono={ArrowLeft} onClick={() => setD(null)}>
              Otro apartado
            </Button>
            <span style={{ flex: 1 }} />
            <Button
              icono={Printer}
              onClick={() => imprimirComprobante(k.id, config, { tipo: "abono", copia: true }).then(() => toast.ok("Comprobante enviado (COPIA)."), (e) => setError(textoError(e)))}
            >
              Reimprimir
            </Button>
            {k.estado === "pagada" && k.tipo === "apartado" && (
              <Button
                variante="primario"
                icono={PackageCheck}
                autoFocus
                onClick={() =>
                  entregarApartado(k.id).then(
                    () => (toast.ok(`${k.numero} entregado.`), p.onCerrar()),
                    (e) => setError(textoError(e)),
                  )
                }
              >
                Entregar
              </Button>
            )}
          </div>
        )}
        <Mensaje error={error} />
      </Modal>
    );

  return (
    <Modal titulo="Apartados" onCerrar={p.onCerrar} ancho={720}>
      <Field label="Número, teléfono o al menos 3 letras del nombre">
        <div className="buscador-entrada">
          <Search size={20} aria-hidden />
          <input ref={buscador} autoFocus className="grande-venta" style={{ minHeight: 48, fontSize: 17 }} value={texto} onChange={(e) => setTexto(e.target.value)} />
        </div>
      </Field>
      {lista.length > 0 ? (
        <table className="tbl tbl-grande">
          <caption className="sr-only">Apartados y créditos abiertos</caption>
          <thead>
            <tr>
              <th scope="col">Número</th>
              <th scope="col">Cliente</th>
              <th scope="col" className="num">
                Saldo
              </th>
              <th scope="col">Vence</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((c) => (
              <FilaClic key={c.id} etiqueta={`${c.numero}, ${c.cliente}, saldo ${monto(c.saldo)}`} onAbrir={() => abrir(c)}>
                <td className="mono">{c.numero}</td>
                <td>
                  {c.cliente}
                  {c.descripcion && <div className="muted">{c.descripcion}</div>}
                </td>
                <td className="num">{monto(c.saldo)}</td>
                <td>{c.estado === "pagada" || c.vencida ? <EstadoCuenta k={c} /> : fecha(c.fechaLimite)}</td>
              </FilaClic>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">{busquedaValida(texto) ? `No hay apartados con «${texto}».` : "Escriba el número del apartado, el teléfono o al menos 3 letras del nombre del cliente."}</p>
      )}
      <Mensaje error={error} />
    </Modal>
  );
}

