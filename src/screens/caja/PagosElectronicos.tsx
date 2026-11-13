// Tarjeta, SINPE y transferencias del turno, agrupados por forma, para cuadrar contra el cierre
// del datáfono y los comprobantes antes de hacer el cierre Z. No es efectivo: lo ve también el
// cajero en cierre ciego.
import { CreditCard } from "lucide-react";
import { agruparPorForma, type PagoElectronico } from "../../db/caja";
import { fechaHora, monto } from "../../lib/tickets";

const detalle = (p: PagoElectronico) => [p.ultimos4 && `****${p.ultimos4}`, p.banco, p.referencia && `ref. ${p.referencia}`, p.pagador].filter(Boolean).join(" · ");

export default function PagosElectronicos(p: { pagos: PagoElectronico[]; abierto?: boolean }) {
  const grupos = agruparPorForma(p.pagos);
  if (!grupos.length) return <p className="muted">No hubo pagos con tarjeta, SINPE ni transferencia en este turno.</p>;
  return (
    <div className="electronicos">
      {grupos.map((g) => (
        <details key={g.forma} open={p.abierto}>
          <summary>
            <CreditCard size={18} aria-hidden />
            <span>
              {g.forma} <span className="muted">({g.pagos.length})</span>
            </span>
            <strong>{monto(g.total)}</strong>
          </summary>
          <table className="tbl tbl-compacta">
            <tbody>
              {g.pagos.map((x, i) => (
                <tr key={i}>
                  <td>{fechaHora(new Date(x.fecha)).slice(11, 16)}</td>
                  <td className="mono">{x.ventaNumero}</td>
                  <td className="muted">{detalle(x)}</td>
                  <td className="num">{monto(x.monto)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </div>
  );
}
