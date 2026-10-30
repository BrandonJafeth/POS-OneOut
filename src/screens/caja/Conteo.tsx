// Conteo de billetes y monedas con − / + y total en vivo (apertura y cierre de caja).
import { Minus, Plus } from "lucide-react";
import { totalConteo, type Conteo } from "../../db/caja";
import { monto } from "../../lib/tickets";

export default function ConteoDinero(p: { denominaciones: number[]; valor: Conteo; onCambio(c: Conteo): void; etiquetaTotal?: string }) {
  const poner = (d: number, n: number) => p.onCambio({ ...p.valor, [String(d)]: Math.max(0, Math.min(100_000, Math.floor(n) || 0)) });
  const billetes = p.denominaciones.filter((d) => d >= 1000);
  const monedas = p.denominaciones.filter((d) => d < 1000);
  const fila = (d: number) => {
    const n = p.valor[String(d)] ?? 0;
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
            value={n ? String(n) : ""}
            placeholder="0"
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
      <div className="conteo-total" aria-live="polite">
        <span>{p.etiquetaTotal ?? "Total contado"}</span>
        <strong>{monto(totalConteo(p.valor))}</strong>
      </div>
    </div>
  );
}
