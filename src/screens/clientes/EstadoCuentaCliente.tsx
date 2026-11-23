// Estado de cuenta de un cliente (solo dueño): créditos y apartados abiertos, abonos con fecha y hora
// real y total adeudado. Imprimir en la térmica o guardar en PDF carta. Rust arma los datos.
import { FileDown, Printer } from "lucide-react";
import { useEffect, useState } from "react";
import Mensaje, { textoError } from "../../components/Mensaje";
import Modal from "../../components/Modal";
import { estadoCuenta, type EstadoCuenta } from "../../db/cuentas";
import { ajustesPara } from "../../db/impresoras";
import { obtenerNegocio } from "../../db/negocio";
import { estadoCuentaPdf, estadoCuentaTermica } from "../../lib/cuentas/estadoCuenta";
import { descargar } from "../../lib/exportarCliente";
import { invocar } from "../../lib/invocar";
import { crearDocumento } from "../../lib/pdf";
import { fechaHora, monto } from "../../lib/tickets";
import Button from "../../ui/Button";
import { useToast } from "../../ui/Toast";
import { useEnvio } from "../../ui/useEnvio";
import { EstadoCuenta as Estado } from "../venta/AbonarApartado";

export default function EstadoCuentaCliente(p: { clienteId: string; onCerrar(): void }) {
  const [ec, setEc] = useState<EstadoCuenta | null>(null);
  const [error, setError] = useState("");
  const toast = useToast();
  const envio = useEnvio();
  useEffect(() => void estadoCuenta(p.clienteId).then(setEc, (e) => setError(textoError(e))), [p.clienteId]);

  async function imprimir() {
    const [s, n] = await Promise.all([ajustesPara("tiquete"), obtenerNegocio()]);
    await invocar("imprimir", { documento: "estado_cuenta", data: Array.from(estadoCuentaTermica(n, ec!, s).bytes) });
    toast.ok("Estado de cuenta enviado a la impresora.");
  }
  async function pdf() {
    const n = await obtenerNegocio();
    const bytes = crearDocumento({ negocio: n.nombreComercial || "Punto de venta", titulo: "Estado de cuenta", subtitulo: `${ec!.cliente} · ${fechaHora(new Date())}`, logo: n.logo, bloques: estadoCuentaPdf(ec!) });
    toast.guardado("PDF guardado. Entrégueselo solo al cliente.", await descargar(`estado-de-cuenta-${p.clienteId.slice(-6)}.pdf`, bytes, "Clientes"));
  }

  return (
    <Modal
      titulo="Estado de cuenta"
      onCerrar={p.onCerrar}
      ancho={720}
      pie={
        ec && (
          <div className="fila-botones">
            <Button icono={Printer} disabled={envio.ocupado} onClick={() => envio.enviar(() => imprimir().catch((e) => setError(textoError(e))))}>
              Imprimir
            </Button>
            <Button icono={FileDown} disabled={envio.ocupado} onClick={() => envio.enviar(() => pdf().catch((e) => setError(textoError(e))))}>
              PDF
            </Button>
          </div>
        )
      }
    >
      <Mensaje error={error} />
      {ec && (
        <>
          <dl className="cifras">
            <div>
              <dt>Cliente</dt>
              <dd>{ec.cliente}</dd>
            </div>
            <div>
              <dt>Total adeudado</dt>
              <dd>{monto(ec.totalAdeudado)}</dd>
            </div>
          </dl>
          {ec.cuentas.length === 0 && <p className="muted">No tiene créditos ni apartados abiertos.</p>}
          {ec.cuentas.map((d) => (
            <section key={d.cuenta.id} className="estado-cuenta-bloque">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h3>
                  {d.cuenta.tipo === "credito" ? "Crédito" : "Apartado"} {d.cuenta.numero}
                </h3>
                <Estado k={d.cuenta} />
              </div>
              <table className="tbl tbl-compacta">
                <caption className="sr-only">
                  Abonos de {d.cuenta.numero}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Fecha y hora</th>
                    <th scope="col">Forma</th>
                    <th scope="col" className="num">
                      Monto
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.abonos
                    .filter((a) => !a.anulado)
                    .map((a) => (
                      <tr key={a.id}>
                        <td>{fechaHora(new Date(a.fecha))}</td>
                        <td>{a.forma}</td>
                        <td className="num">{monto(a.monto)}</td>
                      </tr>
                    ))}
                </tbody>
                <tfoot>
                  <tr className="total">
                    <td colSpan={2}>Total {monto(d.cuenta.total)} · saldo</td>
                    <td className="num">{monto(d.cuenta.saldo)}</td>
                  </tr>
                </tfoot>
              </table>
            </section>
          ))}
        </>
      )}
    </Modal>
  );
}
