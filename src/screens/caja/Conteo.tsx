// Conteo del efectivo (apertura y cierre de caja). Dos formas:
//  - "Escribir el total": un solo monto, lo más rápido.
//  - "Contar billetes y monedas": − / + por denominación, con total en vivo.
import { Minus, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { totalConteo, type ConteoEntrada } from "../../db/caja";
import { conMiles, leerMontoEntero } from "../../lib/texto";
import CampoMonto from "../../ui/CampoMonto";
import { monto } from "../../lib/tickets";

/** `soloDenominaciones`: el cierre del cajero se cuenta billete por billete (sin "escribir el total"). */
export default function ConteoDinero(p: { denominaciones: number[]; valor: ConteoEntrada; onCambio(c: ConteoEntrada): void; etiquetaTotal?: string; soloDenominaciones?: boolean }) {
  const porTotal = p.valor.total !== null;
  const totalRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (porTotal) totalRef.current?.focus();
  }, [porTotal]);

  const poner = (d: number, n: number) =>
    p.onCambio({ total: null, cantidades: { ...p.valor.cantidades, [String(d)]: Math.max(0, Math.min(100_000, Math.floor(n) || 0)) } });
  const billetes = p.denominaciones.filter((d) => d >= 1000);
  const monedas = p.denominaciones.filter((d) => d < 1000);
  const fila = (d: number) => {
    const n = p.valor.cantidades[String(d)] ?? 0;
    return (
      <li key={d} className="conteo-fila">
        <span className="conteo-den">{monto(d)}</span>
        <div className="paso">
          <button type="button" aria-label={`Una menos de ${monto(d)}`} disabled={n <= 0} onClick={() => poner(d, n - 1)}>
            <Minus size={16} aria-hidden />
          </button>
          <input
            inputMode="numeric"
            aria-label={`Cantidad de ${monto(d)}`}
            value={String(n)}
            onChange={(e) => poner(d, Number(e.target.value.replace(/\D/g, "")))}
            onFocus={(e) => e.target.select()}
          />
          <button type="button" aria-label={`Una más de ${monto(d)}`} onClick={() => poner(d, n + 1)}>
            <Plus size={16} aria-hidden />
          </button>
        </div>
        <span className="conteo-sub">{n ? monto(d * n) : ""}</span>
      </li>
    );
  };

  return (
    <div className="conteo">
      {!p.soloDenominaciones && <div className="segmento" role="group" aria-label="Forma de contar">
        <button type="button" aria-pressed={porTotal} onClick={() => p.onCambio({ cantidades: {}, total: totalConteo(p.valor) })}>
          Escribir el total
        </button>
        <button type="button" aria-pressed={!porTotal} onClick={() => p.onCambio({ cantidades: {}, total: null })}>
          Contar billetes y monedas
        </button>
      </div>}

      {porTotal ? (
        <label className="campo conteo-directo">
          <span className="campo-etiqueta">{p.etiquetaTotal ?? "Total contado"}</span>
          <CampoMonto
            ref={totalRef}
            grande
            valor={conMiles(String(p.valor.total ?? 0))}
            onCambio={(t) => p.onCambio({ cantidades: {}, total: leerMontoEntero(t) ?? 0 })}
          />
        </label>
      ) : (
        <div className="conteo-columnas">
          <section>
            <h3>Billetes</h3>
            <ul>{billetes.map(fila)}</ul>
          </section>
          <section>
            <h3>Monedas</h3>
            <ul>{monedas.map(fila)}</ul>
          </section>
        </div>
      )}

      <div className="conteo-total" aria-live="polite">
        <span>{p.etiquetaTotal ?? "Total contado"}</span>
        <strong>{monto(totalConteo(p.valor))}</strong>
      </div>
    </div>
  );
}
