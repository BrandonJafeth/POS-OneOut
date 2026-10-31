// Cobro. Lo común en un toque: elegir la forma y Enter. El pago mixto se abre con "Dividir pago".
// El monto viene ESCRITO con el total (no como texto gris de ejemplo): se ve que hay un valor,
// y como queda seleccionado, escribir otro número lo reemplaza.
import { AlertTriangle, Banknote, CheckCircle2, CreditCard, Landmark, Plus, Smartphone, Trash2, Wallet, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import Mensaje, { textoError } from "../../components/Mensaje";
import { conMiles, leerMontoEntero } from "../../lib/texto";
import { monto } from "../../lib/tickets";
import { calcularPagos, sugerenciasEfectivo } from "../../lib/venta/pagos";
import type { Banco, FormaPago, PagoEntrada, TipoFormaPago } from "../../tipos";
import Button from "../../ui/Button";
import Field from "../../ui/Field";

const ICONO_FORMA: Record<TipoFormaPago, LucideIcon> = {
  efectivo: Banknote,
  tarjeta: CreditCard,
  sinpe: Smartphone,
  transferencia: Landmark,
  otro: Wallet,
};

interface Fila extends Omit<PagoEntrada, "monto"> {
  clave: number;
  texto: string; // lo que se escribe en el monto
}

export default function Cobro(p: { total: number; formas: FormaPago[]; bancos: Banco[]; onCobrar(pagos: PagoEntrada[]): Promise<void>; onCerrar(): void }) {
  const { config } = useSesion();
  const efectivo = p.formas.find((f) => f.daVuelto) ?? p.formas[0];
  const clave = useRef(1);
  const [filas, setFilas] = useState<Fila[]>(efectivo ? [{ clave: 0, formaPagoId: efectivo.id, texto: conMiles(String(p.total)) }] : []);
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
  const restoEfectivo = Math.max(0, p.total - otrosMontos);
  const pagos: PagoEntrada[] = filas.map((f) => ({ ...f, monto: f === filaAuto ? restoEfectivo : (leerMontoEntero(f.texto) ?? 0) }));
  // Un monto borrado cuenta como 0 (se ve "Falta"): nunca se cobra un campo vacío como exacto.
  const pagosEfectivos = pagos.filter((x) => x.monto > 0);
  const r = useMemo(() => calcularPagos(p.total, pagosEfectivos, p.formas), [p.total, JSON.stringify(pagosEfectivos), p.formas]);
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

  async function confirmar() {
    if (!r.ok || ocupado) return;
    setOcupado(true);
    setError("");
    try {
      await p.onCobrar(pagosEfectivos);
    } catch (e) {
      setError(textoError(e));
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
          <strong>{monto(p.total)}</strong>
        </div>

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
                    onClick={() => setFilas([{ clave: filas[0].clave, formaPagoId: f.id, texto: conMiles(String(p.total)) }])}
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
                <span className="monto-campo">
                  <span aria-hidden>¢</span>
                  <input
                    ref={primerMonto}
                    className="precio"
                    inputMode="numeric"
                    value={filas[0].texto}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => set(filas[0].clave, { texto: conMiles(e.target.value) })}
                  />
                </span>
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
                    <select value={f.formaPagoId} onChange={(e) => set(f.clave, { formaPagoId: e.target.value })}>
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
                  <span className="monto-campo">
                    <span aria-hidden>¢</span>
                    <input
                      ref={i === 0 ? primerMonto : i === filas.length - 1 ? nuevaFila : undefined}
                      className="precio"
                      inputMode="numeric"
                      value={f.texto}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => set(f.clave, { texto: conMiles(e.target.value) })}
                    />
                  </span>
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
        {r.errores.length > 0 && <Mensaje error={r.errores.join(". ") + "."} />}
        <Mensaje error={error} />
        <div className="row">
          <Button icono={Plus} variante="fantasma" onClick={dividir}>
            Dividir pago
          </Button>
          <span style={{ flex: 1 }} />
          <Button type="submit" variante="primario" tamano="lg" atajo="Enter" disabled={!r.ok || ocupado}>
            {ocupado ? "Guardando…" : "Confirmar cobro"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
