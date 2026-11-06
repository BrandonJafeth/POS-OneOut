// El cierre Z en pantalla: lo mismo que sale en papel (resumen, efectivo, usuarios, departamentos,
// pagos electrónicos, movimientos, aperturas sin venta, cortes y conteo), en tablas legibles.
import { ChevronDown } from "lucide-react";
import type { Detalle } from "../../db/caja";
import { DENOMINACIONES, descuadres, LEYENDA_CODIGOS, NOTA_USUARIOS } from "../../lib/caja/reporteZ";
import { fechaHora, monto, montoConSigno as signo } from "../../lib/tickets";
import Alert from "../../ui/Alert";
import Badge from "../../ui/Badge";
import PagosElectronicos from "./PagosElectronicos";

const hora = (iso: string) => fechaHora(new Date(iso)).slice(11, 16);

export default function VistaZ({ d, denominaciones }: { d: Detalle; denominaciones?: number[] }) {
  const { turno: t, resumen: r } = d;
  const malos = descuadres(r);
  const conteo = t.conteoFinal;
  const lista = (denominaciones?.length ? denominaciones : DENOMINACIONES).slice().sort((a, b) => b - a);
  return (
    <div className="vista-z">
      {malos.length > 0 && (
        <Alert tono="error" titulo="Los totales no cuadran">
          {malos.join("; ")}. El Z no se imprime hasta revisarlo: avise al técnico.
        </Alert>
      )}
      <dl className="caja-cifras">
        <div>
          <dt>Abrió</dt>
          <dd>
            {t.usuarioApertura} · {hora(t.abiertoEn)}
          </dd>
        </div>
        <div>
          <dt>Cerró</dt>
          <dd>{t.cerradoEn ? `${t.usuarioCierre} · ${hora(t.cerradoEn)}` : "Abierta"}</dd>
        </div>
        <div>
          <dt>Ventas ({r.ventas})</dt>
          <dd>{monto(r.totalVentas)}</dd>
        </div>
        <div>
          <dt>Efectivo esperado</dt>
          <dd>{monto(r.efectivoEsperado)}</dd>
        </div>
        {t.contado != null && (
          <div>
            <dt>Contado</dt>
            <dd>{monto(t.contado)}</dd>
          </div>
        )}
        {t.diferencia != null && (
          <div className="destacado">
            <dt>{t.diferencia === 0 ? "Diferencia" : t.diferencia > 0 ? "Sobrante" : "Faltante"}</dt>
            <dd>{t.diferencia === 0 ? "Cuadra" : signo(t.diferencia)}</dd>
          </div>
        )}
      </dl>
      {t.notaCierre && <Alert tono="info" titulo="Nota del cierre">{t.notaCierre}</Alert>}

      <div className="vista-z-columnas">
        <section>
          <h3>Por forma de pago</h3>
          <table className="tbl tbl-compacta">
            <tbody>
              {r.porForma.map((f) => (
                <tr key={f.formaPagoId}>
                  <td>
                    <span className="codigo-pago">{f.codigo}</span> {f.nombre}
                  </td>
                  <td className="num">{f.pagos}</td>
                  <td className="num">{monto(f.monto)}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Total ventas</td>
                <td className="num">{r.ventas}</td>
                <td className="num">{monto(r.totalVentas)}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section>
          <h3>Efectivo</h3>
          <table className="tbl tbl-compacta">
            <tbody>
              <Fila k="Fondo inicial" v={monto(r.fondo)} />
              <Fila k="Contado (recibido)" v={"+" + monto(r.recibidoEfectivo)} />
              <Fila k="Entradas" v={"+" + monto(r.entradas)} />
              <Fila k="Salidas" v={"−" + monto(r.salidas)} />
              <Fila k="Vueltos" v={"−" + monto(r.vueltos)} />
              <tr className="total">
                <td>Esperado</td>
                <td className="num">{monto(r.efectivoEsperado)}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section>
          <h3>Otros</h3>
          <table className="tbl tbl-compacta">
            <tbody>
              <Fila k="Descuentos" v={monto(r.descuentos)} />
              <Fila k={`Anulaciones (${r.anuladas})`} v={monto(r.totalAnuladas)} />
              <tr>
                <td>Aperturas sin venta</td>
                <td className="num">
                  {r.noVentas.length} {r.noVentaUmbral > 0 && r.noVentas.length >= r.noVentaUmbral && <Badge tono="aviso">Muchas</Badge>}
                </td>
              </tr>
              <Fila k="Cortes realizados" v={String(r.cortes.length)} />
            </tbody>
          </table>
        </section>
        <section>
          <h3>Ventas por usuario</h3>
          <table className="tbl tbl-compacta">
            <tbody>
              {r.porUsuario.map((u) => (
                <tr key={u.usuario}>
                  <td>{u.usuario}</td>
                  <td className="num">{u.ventas} tiq.</td>
                  <td className="num">{monto(u.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted nota-pie">{NOTA_USUARIOS}</p>
        </section>
      </div>

      {r.conDesglose && r.desglose.departamentos.length > 0 && (
        <section>
          <h3>Por departamento</h3>
          <p className="muted nota-pie">{LEYENDA_CODIGOS}</p>
          <div className="electronicos">
            {r.desglose.departamentos.map((x) => (
              <details key={x.departamentoId}>
                <summary>
                  <ChevronDown size={18} aria-hidden />
                  <span>
                    {x.nombre} <span className="muted">({x.cantidad})</span>
                  </span>
                  <span className="muted">efectivo {monto(x.efectivo)}</span>
                  <strong>{monto(x.monto)}</strong>
                </summary>
                <table className="tbl tbl-compacta">
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th>Producto</th>
                      <th className="num">Cant.</th>
                      <th className="num">Precio</th>
                      <th className="num">Monto</th>
                      <th className="num">Efectivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {x.filas.map((f, i) => (
                      <tr key={i}>
                        <td className="codigo-pago">{f.codigo}</td>
                        <td>{f.producto}</td>
                        <td className="num">{f.cantidad}</td>
                        <td className="num">{monto(f.precio)}</td>
                        <td className="num">{monto(f.monto)}</td>
                        <td className="num">{monto(f.efectivo)}</td>
                      </tr>
                    ))}
                    {x.porForma.map((f) => (
                      <tr key={f.forma} className="muted">
                        <td className="codigo-pago">{f.codigo}</td>
                        <td colSpan={3}>Subtotal {f.forma}</td>
                        <td className="num">{monto(f.monto)}</td>
                        <td />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
          </div>
          <p className="total-general">
            Total general ({r.desglose.cantidad}): <strong>{monto(r.desglose.total)}</strong> · en efectivo {monto(r.desglose.efectivo)}
          </p>
        </section>
      )}

      <h3>Tarjeta, SINPE y transferencias</h3>
      <PagosElectronicos pagos={r.pagosElectronicos ?? []} />

      {r.movimientos.length > 0 && (
        <>
          <h3>Movimientos de efectivo</h3>
          <ul className="caja-movs">
            {r.movimientos.map((m) => (
              <li key={m.id}>
                <span>{hora(m.fecha)}</span>
                <span>
                  {m.categoria}
                  <span className="muted"> · {m.usuario}</span>
                  {m.motivo && <span className="muted"> · {m.motivo}</span>}
                </span>
                <span className={m.tipo === "salida" ? "num neg" : "num"}>
                  {m.tipo === "salida" ? "−" : "+"}
                  {monto(m.monto)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {r.noVentas.length > 0 && (
        <>
          <h3>Aperturas sin venta</h3>
          <ul className="caja-movs">
            {r.noVentas.map((x, i) => (
              <li key={i}>
                <span>{hora(x.fecha)}</span>
                <span>
                  {x.causa === "dueno" ? `Orden del dueño: ${x.motivo}` : x.motivo}
                  {x.nota && <span className="muted"> · {x.nota}</span>}
                  <span className="muted"> · {x.usuario}</span>
                </span>
                <span />
              </li>
            ))}
          </ul>
        </>
      )}

      {r.cortes.length > 0 && (
        <>
          <h3>Cortes</h3>
          <ul className="caja-movs">
            {r.cortes.map((k) => (
              <li key={k.id}>
                <span>{hora(k.fecha)}</span>
                <span>
                  {k.usuario} · {k.ventas} ventas{k.retiro ? ` · retiró ${monto(k.retiro)}` : ""}
                </span>
                <span className="num">{monto(k.total)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {conteo && (
        <>
          <h3>Conteo</h3>
          {"total" in conteo ? (
            <p>Total escrito, sin detalle: {monto(Number(conteo.total))}</p>
          ) : (
            <table className="tbl tbl-compacta conteo-z">
              <tbody>
                {lista.map((x) => (
                  <tr key={x}>
                    <td>{monto(x)}</td>
                    <td className="num">× {conteo[String(x)] ?? 0}</td>
                    <td className="num">{monto(x * (conteo[String(x)] ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {d.bitacoraOk === false && <Alert tono="error">Al cerrar, la bitácora no pasó la verificación.</Alert>}
    </div>
  );
}

function Fila({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td>{k}</td>
      <td className="num">{v}</td>
    </tr>
  );
}
