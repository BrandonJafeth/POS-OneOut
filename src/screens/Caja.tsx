// Caja: turno de hoy (abrir, entradas/salidas, cerrar con arqueo) e historial de turnos.
// El cajero ve su turno y su historial; el dueño ve todos, reabre y revisa diferencias.
import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, History, Lock, LockOpen, Printer, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import { textoError } from "../components/Mensaje";
import Modal from "../components/Modal";
import { detalleTurno, listarTurnos, marcarRevisada, reabrirCaja, type Detalle, type ResultadoCierre, type TurnoFila } from "../db/caja";
import { listarEsperas } from "../db/ventas";
import { imprimirMovimiento, imprimirZ } from "../lib/caja/imprimir";
import { diaLocal } from "../lib/texto";
import { fechaHora, monto } from "../lib/tickets";
import Alert from "../ui/Alert";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import FilaClic from "../ui/FilaClic";
import Field from "../ui/Field";
import { AbrirCaja, CerrarCaja, MovimientoCaja } from "./caja/Dialogos";

const hora = (iso: string) => fechaHora(new Date(iso)).slice(-5);
const signo = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + monto(Math.abs(n));

function haceDias(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return diaLocal(d);
}

export default function Caja() {
  const { caja, recargarCaja, config, puede } = useSesion();
  const [detalle, setDetalle] = useState<Detalle | null>(null);
  const [dialogo, setDialogo] = useState<null | "abrir" | "entrada" | "salida" | "cerrar">(null);
  const [esperas, setEsperas] = useState(0);
  const [cierre, setCierre] = useState<ResultadoCierre | null>(null);
  const [verTurno, setVerTurno] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [recarga, setRecarga] = useState(0);
  const turno = caja?.turno ?? null;

  useEffect(() => {
    setDetalle(null);
    if (turno) detalleTurno(turno.id).then(setDetalle, (e) => setError(textoError(e)));
  }, [turno?.id, recarga]);

  const refrescar = async () => {
    await recargarCaja();
    setRecarga((n) => n + 1);
  };

  async function imprimir(f: () => Promise<void>) {
    setError("");
    try {
      await f();
    } catch (e) {
      setError(textoError(e));
    }
  }

  if (!caja) return <div className="screen muted">Cargando…</div>;
  const r = detalle?.resumen;

  return (
    <div className="screen">
      <h1>Caja</h1>
      {error && <Alert tono="error">{error}</Alert>}
      {aviso && <Alert tono="ok">{aviso}</Alert>}

      <section className="card caja-turno">
        {!turno ? (
          <div className="caja-cabeza">
            <div>
              <h2>Caja cerrada</h2>
              <p className="muted">Ábrala con el conteo del fondo para empezar a vender.</p>
            </div>
            <Button variante="primario" tamano="lg" icono={LockOpen} onClick={() => setDialogo("abrir")}>
              Abrir caja
            </Button>
          </div>
        ) : (
          <>
            <div className="caja-cabeza">
              <div>
                <h2>
                  Caja abierta <Badge tono={caja.deOtroDia ? "aviso" : "ok"}>{caja.deOtroDia ? `Desde el ${turno.dia}` : "Hoy"}</Badge>
                </h2>
                <p className="muted">
                  Abrió {turno.usuarioApertura} a las {hora(turno.abiertoEn)} con {monto(turno.fondo)}
                </p>
              </div>
              <div className="fila-botones">
                <Button icono={ArrowDownToLine} onClick={() => setDialogo("entrada")}>
                  Entrada
                </Button>
                <Button icono={ArrowUpFromLine} onClick={() => setDialogo("salida")}>
                  Salida
                </Button>
                <Button
                  variante="primario"
                  tamano="lg"
                  icono={Lock}
                  onClick={async () => {
                    setEsperas((await listarEsperas().catch(() => [])).filter((e) => e.estado.lineas.length).length);
                    setDialogo("cerrar");
                  }}
                >
                  Cerrar caja
                </Button>
              </div>
            </div>
            {caja.deOtroDia && <Alert tono="aviso">Esta caja quedó abierta desde el {turno.dia}. Ciérrela para poder vender hoy.</Alert>}
            {r && (
              <div className="caja-resumen">
                <dl className="caja-cifras">
                  <div>
                    <dt>Ventas</dt>
                    <dd>{r.ventas}</dd>
                  </div>
                  {detalle.veEsperado && (
                    <div>
                      <dt>Vendido</dt>
                      <dd>{monto(r.totalVentas)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Entradas</dt>
                    <dd>{monto(r.entradas)}</dd>
                  </div>
                  <div>
                    <dt>Salidas</dt>
                    <dd>{monto(r.salidas)}</dd>
                  </div>
                  {detalle.veEsperado && (
                    <div className="destacado">
                      <dt>Efectivo esperado</dt>
                      <dd>{monto(r.efectivoEsperado)}</dd>
                    </div>
                  )}
                </dl>
                {detalle.veEsperado && r.porForma.length > 0 && (
                  <table className="tbl tbl-compacta">
                    <thead>
                      <tr>
                        <th>Forma de pago</th>
                        <th className="num">Pagos</th>
                        <th className="num">Monto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.porForma.map((f) => (
                        <tr key={f.formaPagoId}>
                          <td>{f.nombre}</td>
                          <td className="num">{f.pagos}</td>
                          <td className="num">{monto(f.monto)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {r.movimientos.length > 0 && (
                  <>
                    <h3>Movimientos</h3>
                    <ul className="caja-movs">
                      {r.movimientos.map((m) => (
                        <li key={m.id}>
                          <span>{hora(m.fecha)}</span>
                          <span>
                            {m.categoria}
                            {m.motivo && <span className="muted"> · {m.motivo}</span>}
                          </span>
                          <span className={m.tipo === "salida" ? "num neg" : "num"}>
                            {m.tipo === "salida" ? "−" : "+"}
                            {monto(m.monto)}
                          </span>
                          <Button variante="fantasma" icono={Printer} title="Imprimir comprobante" aria-label="Imprimir comprobante" onClick={() => imprimir(() => imprimirMovimiento(m, config))} />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {r.ajustes.length > 0 && (
                  <Alert tono="info" titulo="Ajustes de turnos anteriores">
                    {r.ajustes.map((a) => `${a.tipo === "anulacion" ? "Anulación" : "Pago corregido"} tiquete ${a.ventaNumero} (${monto(a.monto)})`).join(" · ")}
                  </Alert>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <Historial key={recarga} admin={puede("caja.admin")} onVer={setVerTurno} />

      {dialogo === "abrir" && <AbrirCaja estado={caja} onCerrar={() => setDialogo(null)} onAbierta={() => (setDialogo(null), setAviso("Caja abierta."), void refrescar())} />}
      {(dialogo === "entrada" || dialogo === "salida") && (
        <MovimientoCaja
          estado={caja}
          tipo={dialogo}
          onCerrar={() => setDialogo(null)}
          onListo={() => (setDialogo(null), setAviso(dialogo === "salida" ? "Salida registrada." : "Entrada registrada."), void refrescar())}
        />
      )}
      {dialogo === "cerrar" && (
        <CerrarCaja
          estado={caja}
          esperasAbiertas={esperas}
          onCerrar={() => setDialogo(null)}
          onCerrada={(res) => {
            setDialogo(null);
            setCierre(res);
            setAviso("");
            void refrescar();
            if (config.imprime_tiquete) void imprimir(() => imprimirZ(res.turnoId, config));
          }}
        />
      )}
      {cierre && (
        <Modal titulo="Caja cerrada" onCerrar={() => setCierre(null)} ancho={460}>
          {cierre.diferencia === null ? (
            <Alert tono="ok">Conteo registrado: {monto(cierre.contado)}. El dueño revisa el resultado.</Alert>
          ) : cierre.diferencia === 0 ? (
            <Alert tono="ok" titulo="Cuadra">
              Contado {monto(cierre.contado)}, igual a lo esperado.
            </Alert>
          ) : (
            <Alert tono={cierre.requiereRevision ? "aviso" : "info"} titulo={cierre.diferencia > 0 ? "Sobrante" : "Faltante"}>
              Esperado {monto(cierre.esperado ?? 0)}, contado {monto(cierre.contado)}: {signo(cierre.diferencia)}.
              {cierre.requiereRevision && " Queda para revisión del dueño."}
            </Alert>
          )}
          {!cierre.bitacoraOk && <Alert tono="error">La bitácora no pasó la verificación. Avise al técnico.</Alert>}
          <div className="fila-botones">
            <Button icono={Printer} onClick={() => imprimir(() => imprimirZ(cierre.turnoId, config))}>
              {config.imprime_tiquete ? "Reimprimir reporte Z" : "Imprimir reporte Z"}
            </Button>
            <span className="separador" />
            <Button variante="primario" onClick={() => setCierre(null)}>
              Listo
            </Button>
          </div>
        </Modal>
      )}
      {verTurno && <DetalleTurno turnoId={verTurno} onCerrar={() => setVerTurno(null)} onCambio={refrescar} />}
    </div>
  );
}

function Historial(p: { admin: boolean; onVer(id: string): void }) {
  const [desde, setDesde] = useState(haceDias(7));
  const [hasta, setHasta] = useState(diaLocal());
  const [filas, setFilas] = useState<TurnoFila[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    listarTurnos(desde, hasta).then(setFilas, (e) => setError(textoError(e)));
  }, [desde, hasta]);
  return (
    <section className="card">
      <div className="caja-cabeza">
        <h2>
          <History size={20} aria-hidden /> {p.admin ? "Turnos" : "Mis turnos"}
        </h2>
        <div className="row">
          <Field label="Desde">
            <input type="date" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} />
          </Field>
          <Field label="Hasta">
            <input type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} />
          </Field>
        </div>
      </div>
      {error && <Alert tono="error">{error}</Alert>}
      {filas && filas.length === 0 && <EmptyState icono={History} titulo="Sin turnos en esas fechas" />}
      {filas && filas.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Día</th>
              <th>Abrió</th>
              <th>Cerró</th>
              <th className="num">Ventas</th>
              <th className="num">Total</th>
              <th className="num">Diferencia</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filas.map((t) => (
              <FilaClic key={t.id} etiqueta={`Abrir turno del ${t.dia}`} onAbrir={() => p.onVer(t.id)}>
                <td>{t.dia}</td>
                <td>
                  {t.usuarioApertura} · {hora(t.abiertoEn)}
                </td>
                <td>{t.cerradoEn ? `${t.usuarioCierre ?? ""} · ${hora(t.cerradoEn)}` : <Badge tono="ok">Abierta</Badge>}</td>
                <td className="num">{t.ventas}</td>
                <td className="num">{monto(t.total)}</td>
                <td className="num">{t.diferencia == null ? "" : signo(t.diferencia)}</td>
                <td>{t.pendienteRevision && <Badge tono="aviso">Revisar</Badge>}</td>
              </FilaClic>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DetalleTurno(p: { turnoId: string; onCerrar(): void; onCambio(): Promise<void> }) {
  const { config, puede } = useSesion();
  const [d, setD] = useState<Detalle | null>(null);
  const [error, setError] = useState("");
  const [reabrir, setReabrir] = useState(false);
  const [pin, setPin] = useState("");
  const [motivo, setMotivo] = useState("");
  const cargar = () => detalleTurno(p.turnoId).then(setD, (e) => setError(textoError(e)));
  useEffect(() => {
    void cargar();
  }, [p.turnoId]);

  const t = d?.turno;
  const r = d?.resumen;
  const admin = puede("caja.admin");
  const umbral = config.caja_umbral_diferencia;

  return (
    <Modal titulo={t ? `Turno del ${t.dia}` : "Turno"} onCerrar={p.onCerrar} ancho={620}>
      {error && <Alert tono="error">{error}</Alert>}
      {t && r && (
        <>
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
              <dt>Ventas</dt>
              <dd>
                {r.ventas}
                {d.veEsperado && ` · ${monto(r.totalVentas)}`}
              </dd>
            </div>
            <div>
              <dt>Fondo</dt>
              <dd>{monto(r.fondo)}</dd>
            </div>
            {d.veEsperado && (
              <div>
                <dt>Esperado</dt>
                <dd>{monto(t.esperado ?? r.efectivoEsperado)}</dd>
              </div>
            )}
            {t.contado != null && (
              <div>
                <dt>Contado</dt>
                <dd>{monto(t.contado)}</dd>
              </div>
            )}
            {t.diferencia != null && (
              <div className="destacado">
                <dt>Diferencia</dt>
                <dd>{signo(t.diferencia)}</dd>
              </div>
            )}
          </dl>
          {t.notaCierre && <Alert tono="info" titulo="Nota del cierre">{t.notaCierre}</Alert>}
          {d.bitacoraOk === false && <Alert tono="error">Al cerrar, la bitácora no pasó la verificación.</Alert>}
          {admin && t.diferencia != null && Math.abs(t.diferencia) >= umbral && !t.revisadaPor && (
            <Alert tono="aviso" titulo="Diferencia por revisar">
              <Button icono={CheckCircle2} onClick={async () => (await marcarRevisada(t.id).catch((e) => setError(textoError(e))), await cargar(), await p.onCambio())}>
                Marcar como revisada
              </Button>
            </Alert>
          )}
          {reabrir ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setError("");
                try {
                  await reabrirCaja(t.id, pin, motivo);
                  await p.onCambio();
                  p.onCerrar();
                } catch (err) {
                  setPin("");
                  setError(textoError(err));
                }
              }}
            >
              <Field label="Motivo para reabrir">
                <input autoFocus value={motivo} maxLength={300} onChange={(e) => setMotivo(e.target.value)} />
              </Field>
              <Field label="Su PIN de dueño">
                <input className="pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
              </Field>
              <div className="fila-botones">
                <Button onClick={() => setReabrir(false)}>Cancelar</Button>
                <span className="separador" />
                <Button type="submit" variante="primario" icono={RotateCcw} disabled={!pin || motivo.trim().length < 5}>
                  Reabrir caja
                </Button>
              </div>
            </form>
          ) : (
            <div className="fila-botones">
              {t.estado === "cerrado" && (
                <Button icono={Printer} onClick={() => imprimirZ(t.id, config).catch((e) => setError(textoError(e)))}>
                  Imprimir reporte Z
                </Button>
              )}
              <span className="separador" />
              {admin && t.estado === "cerrado" && t.dia === diaLocal() && (
                <Button icono={RotateCcw} onClick={() => setReabrir(true)}>
                  Reabrir
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
