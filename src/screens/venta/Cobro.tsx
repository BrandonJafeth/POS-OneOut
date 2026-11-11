// Cobro. Lo común en un toque: elegir la forma y Enter. El pago mixto se abre con "Dividir pago".
// El monto viene ESCRITO con el total (no como texto gris de ejemplo): se ve que hay un valor,
// y como queda seleccionado, escribir otro número lo reemplaza.
import { AlertTriangle, Banknote, CheckCircle2, CreditCard, Landmark, Plus, Smartphone, Trash2, Wallet, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import Mensaje, { textoError } from "../../components/Mensaje";
import { referenciaUsada } from "../../db/ventas";
import { conMiles, leerMontoEntero } from "../../lib/texto";
import { monto } from "../../lib/tickets";
import { useEscaner } from "../../lib/useEscaner";
import { calcularPagos, sugerenciasEfectivo } from "../../lib/venta/pagos";
import type { Banco, FormaPago, PagoEntrada, TipoFormaPago } from "../../tipos";
import Alert from "../../ui/Alert";
import Button from "../../ui/Button";
import CampoMonto from "../../ui/CampoMonto";
import Field from "../../ui/Field";

const ICONO_FORMA: Record<TipoFormaPago, LucideIcon> = {
  efectivo: Banknote,
  tarjeta: CreditCard,
  sinpe: Smartphone,
  transferencia: Landmark,
  otro: Wallet,
};

/** Más vuelto que el billete más grande casi siempre es un cero de más en lo recibido. */
const VUELTO_GRANDE = 50_000;

interface Fila extends Omit<PagoEntrada, "monto"> {
  clave: number;
  texto: string; // lo que se escribe en el monto
}

/** `total`: redondeado, lo que se cobra en efectivo. `totalExacto`: sin redondear, lo que se cobra si no hay efectivo. */
export default function Cobro(p: { total: number; totalExacto: number; formas: FormaPago[]; bancos: Banco[]; onCobrar(pagos: PagoEntrada[]): Promise<void>; onCerrar(): void }) {
  const { config } = useSesion();
  const efectivo = p.formas.find((f) => f.daVuelto) ?? p.formas[0];
  const clave = useRef(1);
  const totalDe = (f?: FormaPago) => (f?.daVuelto ? p.total : p.totalExacto);
  const [filas, setFilas] = useState<Fila[]>(efectivo ? [{ clave: 0, formaPagoId: efectivo.id, texto: conMiles(String(totalDe(efectivo))) }] : []);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  const primerMonto = useRef<HTMLInputElement>(null);
  useEffect(() => {
    primerMonto.current?.focus();
    primerMonto.current?.select();
  }, [filas[0]?.formaPagoId]);

  const forma = (id: string) => p.formas.find((f) => f.id === id)!;
  const mixto = filas.length > 1;
  // Pago dividido: si la fila de efectivo se deja en blanco, cubre lo que falte (lo más común:
  // se escribe cuánto va en tarjeta/SINPE y el resto es efectivo).
  const filaAuto = mixto ? filas.find((f) => forma(f.formaPagoId)?.daVuelto && !f.texto.trim()) : undefined;
  const otrosMontos = filas.filter((f) => f !== filaAuto).reduce((s, f) => s + (leerMontoEntero(f.texto) ?? 0), 0);
  const restoEfectivo = Math.max(0, p.total - otrosMontos); // el efectivo siempre paga sobre el total redondeado
  const pagos: PagoEntrada[] = filas.map((f) => ({ ...f, monto: f === filaAuto ? restoEfectivo : (leerMontoEntero(f.texto) ?? 0) }));
  // Un monto borrado cuenta como 0 (se ve "Falta"): nunca se cobra un campo vacío como exacto.
  const pagosEfectivos = pagos.filter((x) => x.monto > 0);
  // El redondeo es del efectivo. Igual que Rust (ventas::cobrar_con): se cobra el monto exacto solo
  // si hay pagos y ninguno es efectivo.
  const total = pagosEfectivos.length > 0 && !pagosEfectivos.some((x) => forma(x.formaPagoId)?.daVuelto) ? p.totalExacto : p.total;

  // Una lectura del lector con el cobro abierto no es un monto: se deshace lo que escribió y no confirma.
  // `estable` es lo que había antes de la ráfaga (el lector escribe todo en menos de 300 ms).
  const estable = useRef(filas);
  useEffect(() => {
    const t = setTimeout(() => (estable.current = filas), 300);
    return () => clearTimeout(t);
  }, [filas]);
  useEscaner(
    () => {
      setFilas(estable.current);
      setError("Se leyó un código con el cobro abierto y no se tomó como monto. Para agregar productos, cierre el cobro.");
    },
    { debounceMs: 0, activo: !ocupado },
  );

  // Pago dividido: una fila sin monto es un olvido (no un 0), salvo el efectivo que cubre lo que falta.
  const sinMonto = mixto ? filas.filter((f, i) => f !== filaAuto && pagos[i].monto <= 0) : [];
  const r = useMemo(() => calcularPagos(total, pagosEfectivos, p.formas), [total, JSON.stringify(pagosEfectivos), p.formas]);
  // Comprobante repetido (el mismo SINPE mostrado dos veces): se avisa, no se bloquea.
  const [repetidas, setRepetidas] = useState<string[]>([]);
  const referencias = filas.map((f) => `${f.formaPagoId}|${(f.referencia ?? "").trim()}`).join("\n");
  useEffect(() => {
    let vivo = true;
    const t = setTimeout(async () => {
      const avisos: string[] = [];
      for (const f of filas) {
        const ref = (f.referencia ?? "").trim();
        const tiquete = ref.length >= 4 ? await referenciaUsada(f.formaPagoId, ref).catch(() => null) : null;
        if (tiquete) avisos.push(`La referencia ${ref} ya se usó en el tiquete ${tiquete}.`);
      }
      if (vivo) setRepetidas(avisos);
    }, 300);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [referencias]);
  const set = (k: number, patch: Partial<Fila>) => setFilas(filas.map((f) => (f.clave === k ? { ...f, ...patch } : f)));
  const nuevaFila = useRef<HTMLInputElement>(null);

  /** Agrega otra forma de pago. Si todavía no hay efectivo, la nueva es efectivo (cubre lo que falte);
   *  si ya hay, se agrega la siguiente forma sin monto, para escribir cuánto va ahí. */
  function dividir() {
    const hayEfectivo = filas.some((f) => forma(f.formaPagoId)?.daVuelto);
    const otra = hayEfectivo
      ? (p.formas.find((f) => !f.daVuelto && !filas.some((x) => x.formaPagoId === f.id)) ?? p.formas.find((f) => !f.daVuelto) ?? p.formas[0])
      : (efectivo ?? p.formas[0]);
    // Al dividir, el efectivo que tenía el total queda en blanco: cubre lo que falte.
    const previas = filas.map((f) => (forma(f.formaPagoId)?.daVuelto && leerMontoEntero(f.texto) === p.total ? { ...f, texto: "" } : f));
    setFilas([...previas, { clave: clave.current++, formaPagoId: otra.id, texto: "" }]);
    setTimeout(() => nuevaFila.current?.focus(), 0);
  }

  // Vuelto enorme (casi siempre un cero de más): no se confirma con Enter/F12 sin antes decir
  // "sí, recibí eso". Si cambia el monto, hay que volver a confirmarlo.
  const [vueltoVisto, setVueltoVisto] = useState(0);
  const vueltoPorRevisar = r.vuelto > VUELTO_GRANDE && vueltoVisto !== r.vuelto;
  const listo = r.ok && !sinMonto.length && !vueltoPorRevisar;

  async function confirmar() {
    if (!listo || ocupado) return;
    setOcupado(true);
    setError("");
    try {
      await p.onCobrar(pagosEfectivos);
    } catch (e) {
      setError(textoError(e));
    } finally {
      // También si el cobro quedó esperando el PIN del dueño y se canceló: se puede reintentar.
      setOcupado(false);
    }
  }

  const filaEfectivo = filas.find((f) => forma(f.formaPagoId)?.daVuelto);
  const faltaSinEfectivo = p.total - pagos.filter((x) => !forma(x.formaPagoId)?.daVuelto).reduce((s, x) => s + x.monto, 0);

  const extras = (f: Fila) => {
    const fp = forma(f.formaPagoId);
    return (
      <>
        {fp?.requiereBanco && (
          <Field label="Banco">
            <select value={f.bancoId ?? ""} onChange={(e) => set(f.clave, { bancoId: e.target.value || null })}>
              <option value="">Elija…</option>
              {p.bancos.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.nombre}
                </option>
              ))}
            </select>
          </Field>
        )}
        {fp?.requiereReferencia && (
          <Field label="Referencia">
            <input value={f.referencia ?? ""} onChange={(e) => set(f.clave, { referencia: e.target.value })} />
          </Field>
        )}
        {fp?.pideUltimos4 && (
          <Field label="Últimos 4 (opcional)">
            <input className="mini mono" inputMode="numeric" value={f.ultimos4 ?? ""} onChange={(e) => set(f.clave, { ultimos4: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
          </Field>
        )}
      </>
    );
  };

  return (
    <Modal titulo="Cobrar" onCerrar={p.onCerrar} ancho={680}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void confirmar();
        }}
        onKeyDown={(e) => e.key === "F12" && (e.preventDefault(), void confirmar())}
      >
        <div className="cobro-total">
          <span>Total</span>
          <strong>{monto(total)}</strong>
        </div>
        {p.total !== p.totalExacto && (
          <p className="muted">
            En efectivo se redondea a {monto(p.total)}. Con tarjeta, SINPE o transferencia se cobra exacto: {monto(p.totalExacto)}.
          </p>
        )}

        {!mixto && filas[0] && (
          <>
            <div className="formas" role="radiogroup" aria-label="Forma de pago">
              {p.formas.map((f) => {
                const Icono = ICONO_FORMA[f.tipo];
                return (
                  <button
                    type="button"
                    key={f.id}
                    role="radio"
                    aria-checked={filas[0].formaPagoId === f.id}
                    aria-pressed={filas[0].formaPagoId === f.id}
                    className="forma"
                    onClick={() => setFilas([{ clave: filas[0].clave, formaPagoId: f.id, texto: conMiles(String(totalDe(f))) }])}
                  >
                    <Icono size={20} aria-hidden /> {f.nombre}
                  </button>
                );
              })}
            </div>
            <div className="cobro-campos">
              <Field
                label={forma(filas[0].formaPagoId)?.daVuelto ? "Recibido" : "Monto"}
                ayuda={
                  !filas[0].texto
                    ? "Escriba el monto."
                    : forma(filas[0].formaPagoId)?.daVuelto
                      ? "Lo que le entregó el cliente. Escriba otro número para cambiarlo."
                      : "Escriba otro número para cambiarlo."
                }
              >
                <CampoMonto ref={primerMonto} valor={filas[0].texto} onCambio={(texto) => set(filas[0].clave, { texto })} />
              </Field>
              <div className="cobro-extras">{extras(filas[0])}</div>
            </div>
          </>
        )}

        {mixto &&
          filas.map((f, i) => {
            const Icono = ICONO_FORMA[forma(f.formaPagoId)?.tipo ?? "otro"];
            return (
              <div key={f.clave} className="fila-pago cobro-campos">
                <Field label="Forma">
                  <span className="cobro-forma">
                    <Icono size={20} aria-hidden />
                    <select value={f.formaPagoId} onChange={(e) => set(f.clave, { formaPagoId: e.target.value, bancoId: null, referencia: null, ultimos4: null })}>
                      {p.formas.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.nombre}
                        </option>
                      ))}
                    </select>
                  </span>
                </Field>
                <Field
                  label={forma(f.formaPagoId)?.daVuelto ? "Recibido" : "Monto"}
                  ayuda={f === filaAuto ? `Vacío: cubre lo que falta (${monto(restoEfectivo)})` : !f.texto ? "Escriba el monto." : undefined}
                >
                  <CampoMonto
                    ref={i === 0 ? primerMonto : i === filas.length - 1 ? nuevaFila : undefined}
                    valor={f.texto}
                    onCambio={(texto) => set(f.clave, { texto })}
                  />
                </Field>
                <div className="cobro-extras">{extras(f)}</div>
                <Button variante="fantasma" icono={Trash2} aria-label="Quitar este pago" onClick={() => setFilas(filas.filter((x) => x.clave !== f.clave))} />
              </div>
            );
          })}

        {filaEfectivo && (
          <div className="billetes" role="group" aria-label="Montos rápidos en efectivo">
            {sugerenciasEfectivo(Math.max(0, faltaSinEfectivo), config.denominaciones_rapidas).map((d) => (
              <button type="button" key={d} onClick={() => set(filaEfectivo.clave, { texto: conMiles(String(d)) })}>
                {d === faltaSinEfectivo ? "Exacto" : monto(d)}
              </button>
            ))}
          </div>
        )}

        <div className={r.faltante > 0 ? "cobro-resumen falta" : "cobro-resumen ok"} aria-live="polite">
          {r.faltante > 0 ? (
            <>
              <AlertTriangle size={22} aria-hidden /> Falta <strong>{monto(r.faltante)}</strong>
            </>
          ) : (
            <>
              <CheckCircle2 size={22} aria-hidden /> Vuelto <strong>{monto(r.vuelto)}</strong>
            </>
          )}
        </div>
        {total === 0 && <Alert tono="aviso">El total es ¢0: la venta queda registrada sin cobrar nada.</Alert>}
        {r.vuelto > VUELTO_GRANDE && (
          <Alert tono="aviso" titulo={`Vuelto de ${monto(r.vuelto)}`}>
            Revise que de verdad recibió {monto(r.pagado)}: un cero de más da un vuelto que sale de la gaveta.
            {vueltoPorRevisar && (
              <div style={{ marginTop: 8 }}>
                <Button onClick={() => setVueltoVisto(r.vuelto)}>Sí, recibí {monto(r.pagado)}</Button>
              </div>
            )}
          </Alert>
        )}
        {repetidas.length > 0 && (
          <Alert tono="aviso" titulo="Comprobante repetido">
            {repetidas.join(" ")} Revise en el banco que este pago sí entró antes de entregar.
          </Alert>
        )}
        {sinMonto.length > 0 && (
          <Alert tono="aviso">
            {sinMonto.map((f) => forma(f.formaPagoId)?.nombre).join(" y ")} sin monto: escríbalo o quite {sinMonto.length > 1 ? "esas filas" : "la fila"} con la papelera.
          </Alert>
        )}
        {r.errores.length > 0 && <Mensaje error={r.errores.join(". ") + "."} />}
        <Mensaje error={error} />
        <div className="row">
          <Button icono={Plus} variante="fantasma" onClick={dividir}>
            Dividir pago
          </Button>
          <span style={{ flex: 1 }} />
          <Button type="submit" variante="primario" tamano="lg" atajo="Enter" disabled={!listo || ocupado}>
            {ocupado ? "Guardando…" : "Confirmar cobro"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
