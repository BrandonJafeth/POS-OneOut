// Cobro. Lo común en un toque: elegir la forma y Enter. El pago mixto se abre con "Dividir pago".
import { AlertTriangle, Banknote, CheckCircle2, CreditCard, Landmark, Plus, Smartphone, Trash2, Wallet, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import Mensaje, { textoError } from "../../components/Mensaje";
import { leerMontoEntero } from "../../lib/texto";
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
  const [filas, setFilas] = useState<Fila[]>(efectivo ? [{ clave: 0, formaPagoId: efectivo.id, texto: "" }] : []);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  const primerMonto = useRef<HTMLInputElement>(null);
  useEffect(() => primerMonto.current?.focus(), [filas[0]?.formaPagoId]);

  const pagos: PagoEntrada[] = filas.map((f) => ({ ...f, monto: leerMontoEntero(f.texto) ?? 0 }));
  // Una sola fila en blanco = pago exacto: el caso más común sin escribir nada.
  const pagosEfectivos = pagos.length === 1 && !filas[0].texto ? [{ ...pagos[0], monto: p.total }] : pagos.filter((x) => x.monto > 0);
  const r = useMemo(() => calcularPagos(p.total, pagosEfectivos, p.formas), [p.total, JSON.stringify(pagosEfectivos), p.formas]);
  const forma = (id: string) => p.formas.find((f) => f.id === id)!;
  const set = (k: number, patch: Partial<Fila>) => setFilas(filas.map((f) => (f.clave === k ? { ...f, ...patch } : f)));
  const mixto = filas.length > 1;

  function dividir() {
    const yaPagado = pagos.reduce((s, x) => s + x.monto, 0) || 0;
    const otra = p.formas.find((f) => !filas.some((x) => x.formaPagoId === f.id)) ?? p.formas[0];
    const primera = filas[0].texto ? filas : [{ ...filas[0], texto: "" }];
    setFilas([...primera, { clave: clave.current++, formaPagoId: otra.id, texto: String(Math.max(0, p.total - yaPagado) || "") }]);
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
    <Modal titulo="Cobrar" onCerrar={p.onCerrar} ancho={620}>
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
                    onClick={() => setFilas([{ clave: filas[0].clave, formaPagoId: f.id, texto: "" }])}
                  >
                    <Icono size={20} aria-hidden /> {f.nombre}
                  </button>
                );
              })}
            </div>
            <div className="row abajo">
              <Field label={forma(filas[0].formaPagoId)?.daVuelto ? "Recibido (¢)" : "Monto (¢)"} className="sin-margen">
                <input
                  ref={primerMonto}
                  className="precio big"
                  inputMode="numeric"
                  placeholder={monto(p.total)}
                  value={filas[0].texto}
                  onChange={(e) => set(filas[0].clave, { texto: e.target.value })}
                />
              </Field>
              {extras(filas[0])}
            </div>
          </>
        )}

        {mixto &&
          filas.map((f, i) => {
            const Icono = ICONO_FORMA[forma(f.formaPagoId)?.tipo ?? "otro"];
            return (
              <div key={f.clave} className="fila-pago">
                <Field label="Forma" className="sin-margen">
                  <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
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
                <Field label="Monto (¢)" className="sin-margen">
                  <input ref={i === 0 ? primerMonto : undefined} className="precio" inputMode="numeric" value={f.texto} onChange={(e) => set(f.clave, { texto: e.target.value })} />
                </Field>
                {extras(f)}
                <Button variante="fantasma" icono={Trash2} aria-label="Quitar este pago" onClick={() => setFilas(filas.filter((x) => x.clave !== f.clave))} />
              </div>
            );
          })}

        {filaEfectivo && (
          <div className="billetes" role="group" aria-label="Montos rápidos en efectivo">
            {sugerenciasEfectivo(Math.max(0, faltaSinEfectivo), config.denominaciones_rapidas).map((d) => (
              <button type="button" key={d} onClick={() => set(filaEfectivo.clave, { texto: String(d) })}>
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
