// Caja: el turno abierto (de la caja, no de una persona), movimientos, "no venta", corte, cierre
// con arqueo y cierre Z; historial de turnos y, para el dueño, las aperturas de gaveta sin venta.
// Con el turno abierto, el cajero no ve totales de ventas (Rust ni siquiera se los manda).
import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, FileDown, History, Inbox, KeyRound, Lock, LockOpen, NotebookPen, Printer, RotateCcw, Scissors } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import { textoError } from "../components/Mensaje";
import Modal from "../components/Modal";
import PinDueno from "../components/PinDueno";
import {
  aperturasGaveta,
  datosReporteZ,
  detalleTurno,
  listarTurnos,
  marcarRevisada,
  notaCierre,
  reabrirCaja,
  type AperturaGaveta,
  type Corte,
  type Detalle,
  type EstadoCaja,
  type ResultadoCierre,
  type TurnoFila,
} from "../db/caja";
import { obtenerNegocio } from "../db/negocio";
import { listarUsuarios } from "../db/usuarios";
import { listarEsperas } from "../db/ventas";
import { imprimirCorte, imprimirMovimiento, imprimirZ } from "../lib/caja/imprimir";
import { pdfCierre } from "../lib/caja/pdfZ";
import { opcionesPorDefecto } from "../lib/caja/reporteZ";
import { descargar } from "../lib/exportarCliente";
import { DIAS_SIN_RESPALDO, ultimoRespaldo } from "../lib/respaldoApi";
import { diaLocal, plural } from "../lib/texto";
import { fechaHora, monto, montoConSigno as signo } from "../lib/tickets";
import type { Usuario } from "../tipos";
import Alert from "../ui/Alert";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import FilaClic from "../ui/FilaClic";
import Field from "../ui/Field";
import { useToast } from "../ui/Toast";
import { AbrirCaja, CasillasZ, CerrarCaja, CorteCaja, GavetaDueno, MovimientoCaja, NoVenta, type OpcionesCierre } from "./caja/Dialogos";
import PagosElectronicos from "./caja/PagosElectronicos";
import VistaZ from "./caja/VistaZ";

const hora = (iso: string) => fechaHora(new Date(iso)).slice(11, 16);

function haceDias(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return diaLocal(d);
}

type Dialogo = null | "abrir" | "entrada" | "salida" | "cerrar" | "noventa" | "gaveta" | "corte";

export default function Caja() {
  const { caja, recargarCaja, config, puede, usuario, irA } = useSesion();
  const [respaldo, setRespaldo] = useState<string | null | undefined>(undefined);
  const [detalle, setDetalle] = useState<Detalle | null>(null);
  const [dialogo, setDialogo] = useState<Dialogo>(null);
  const [esperas, setEsperas] = useState(0);
  const [cierre, setCierre] = useState<{ r: ResultadoCierre; o: OpcionesCierre; errorImpresion?: string } | null>(null);
  const [corte, setCorte] = useState<{ k: Corte; errorImpresion?: string } | null>(null);
  const [verTurno, setVerTurno] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [recarga, setRecarga] = useState(0);
  const toast = useToast();
  const turno = caja?.turno ?? null;
  const admin = puede("caja.admin");
  const usable = !!turno && !!caja?.puedeUsar;

  // Una falla del disco se lleva todas las ventas: se avisa si el respaldo es viejo o no existe.
  useEffect(() => {
    if (puede("respaldo")) ultimoRespaldo().then(setRespaldo, () => undefined);
  }, []);
  const diasSinRespaldo = respaldo ? Math.floor((Date.now() - Date.parse(respaldo)) / 86_400_000) : null;

  useEffect(() => {
    setDetalle(null);
    if (turno && (usable || admin)) detalleTurno(turno.id).then(setDetalle, (e) => setError(textoError(e)));
  }, [turno?.id, recarga, usable]);

  const refrescar = async () => {
    await recargarCaja();
    setRecarga((n) => n + 1);
  };

  async function imprimir(f: () => Promise<unknown>) {
    setError("");
    try {
      await f();
    } catch (e) {
      setError(textoError(e));
    }
  }

  if (!caja) return <div className="screen muted">Cargando…</div>;
  const r = detalle?.resumen;
  const veTotales = !!detalle?.veTotales;

  return (
    <div className="screen">
      <h1>Caja</h1>
      {error && <Alert tono="error">{error}</Alert>}
      {respaldo !== undefined && (respaldo === null || (diasSinRespaldo ?? 0) >= DIAS_SIN_RESPALDO) && (
        <Alert tono="aviso" titulo={respaldo === null ? "Todavía no hay ningún respaldo" : `El último respaldo es de hace ${plural(diasSinRespaldo ?? 0, "día", "días")}`}>
          Si la computadora se daña o se la roban, se pierden todas las ventas y cierres desde entonces. Haga un respaldo en Administración → Respaldo y cópielo a una memoria USB.{" "}
          <Button variante="fantasma" onClick={() => irA("admin")}>
            Ir a Administración
          </Button>
        </Alert>
      )}

      <section className="card caja-turno">
        {!turno ? (
          <div className="caja-cabeza">
            <div>
              <h2>Caja cerrada</h2>
              <p className="muted">Ábrala con el conteo del fondo para empezar a vender.</p>
            </div>
            <div className="fila-botones">
              <Button icono={KeyRound} onClick={() => setDialogo("gaveta")} title="Abrir la gaveta con el PIN del dueño">
                Gaveta (dueño)
              </Button>
              <Button variante="primario" tamano="lg" icono={LockOpen} onClick={() => setDialogo("abrir")}>
                Abrir caja
              </Button>
            </div>
          </div>
        ) : !usable && !admin ? (
          <div className="caja-cabeza">
            <div>
              <h2>La caja la tiene abierta {turno.usuarioApertura}</h2>
              <p className="muted">
                Desde las {hora(turno.abiertoEn)}. En este negocio cada persona usa su propio turno: {turno.usuarioApertura} la cierra con su conteo
                (o el dueño) y después usted abre el suyo.
              </p>
            </div>
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
                  {caja.compartido && turno.usuarioAperturaId !== usuario.id && " · turno compartido"}
                </p>
              </div>
              <div className="fila-botones">
                {usable && (
                  <>
                    <Button icono={ArrowDownToLine} onClick={() => setDialogo("entrada")}>
                      Entrada
                    </Button>
                    <Button icono={ArrowUpFromLine} onClick={() => setDialogo("salida")}>
                      Salida
                    </Button>
                    <Button icono={Inbox} onClick={() => setDialogo("noventa")} title="Abrir la gaveta sin vender (cambio de billetes…)">
                      No venta
                    </Button>
                  </>
                )}
                <Button icono={KeyRound} onClick={() => setDialogo("gaveta")} title="Abrir la gaveta con el PIN del dueño">
                  Gaveta (dueño)
                </Button>
                {admin && (
                  <Button icono={Scissors} onClick={() => setDialogo("corte")} title="Ver e imprimir lo vendido hasta ahora sin cerrar">
                    Corte
                  </Button>
                )}
                {caja.puedeCerrar && (
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
                )}
              </div>
            </div>
            {caja.deOtroDia && <Alert tono="aviso">Esta caja quedó abierta desde el {turno.dia}. Ciérrela para poder vender hoy.</Alert>}
            {caja.noVentaUmbral > 0 && caja.noVentas >= caja.noVentaUmbral && (
              <Alert tono="aviso">En este turno se abrió la gaveta sin venta {plural(caja.noVentas, "vez", "veces")}. Queda marcado en el cierre.</Alert>
            )}
            {detalle && !veTotales && (
              <Alert tono="info" titulo="Los totales se ven al cerrar">
                Mientras el turno está abierto no se muestra lo vendido. Al cerrar, cuente el efectivo y verá el resultado completo.
              </Alert>
            )}
            {r && veTotales && (
              <div className="caja-resumen">
                <dl className="caja-cifras">
                  <div>
                    <dt>Ventas</dt>
                    <dd>{r.ventas}</dd>
                  </div>
                  <div>
                    <dt>Vendido</dt>
                    <dd>{monto(r.totalVentas)}</dd>
                  </div>
                  <div>
                    <dt>Entradas</dt>
                    <dd>{monto(r.entradas)}</dd>
                  </div>
                  <div>
                    <dt>Salidas</dt>
                    <dd>{monto(r.salidas)}</dd>
                  </div>
                  <div className="destacado">
                    <dt>Efectivo esperado</dt>
                    <dd>{monto(r.efectivoEsperado)}</dd>
                  </div>
                </dl>
                {r.porForma.length > 0 && (
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
                {r.porUsuario.length > 0 && (
                  <p className="muted">
                    {r.porUsuario.map((u) => `${u.usuario}: ${plural(u.ventas, "venta", "ventas")} · ${monto(u.total)}`).join(" — ")}
                  </p>
                )}
                <h3>Tarjeta, SINPE y transferencias</h3>
                <PagosElectronicos pagos={r.pagosElectronicos} />
                {r.ajustes.length > 0 && (
                  <Alert tono="info" titulo="Ajustes de turnos anteriores">
                    {r.ajustes.map((a) => `${a.tipo === "anulacion" ? "Anulación" : "Pago corregido"} tiquete ${a.ventaNumero} (${monto(a.monto)})`).join(" · ")}
                  </Alert>
                )}
              </div>
            )}
            {r && r.movimientos.length > 0 && (
              <>
                <h3>Movimientos</h3>
                <ul className="caja-movs">
                  {r.movimientos.map((m) => (
                    <li key={m.id}>
                      <span>{hora(m.fecha)}</span>
                      <span>
                        {m.categoria}
                        {m.motivo && <span className="muted"> · {m.motivo}</span>}
                        <span className="muted"> · {m.usuario}</span>
                      </span>
                      <span className={m.tipo === "salida" ? "num neg" : "num"}>
                        {m.tipo === "salida" ? "−" : "+"}
                        {monto(m.monto)}
                      </span>
                      <Button variante="fantasma" icono={Printer} title="Imprimir comprobante" aria-label="Imprimir comprobante" onClick={() => imprimir(() => imprimirMovimiento(m))} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      <Historial key={recarga} admin={admin} onVer={setVerTurno} />
      {admin && <AperturasSinVenta key={`a${recarga}`} />}

      {dialogo === "abrir" && <AbrirCaja estado={caja} onCerrar={() => setDialogo(null)} onAbierta={() => (setDialogo(null), toast.ok("Caja abierta."), void refrescar())} />}
      {(dialogo === "entrada" || dialogo === "salida") && (
        <MovimientoCaja
          estado={caja}
          tipo={dialogo}
          onCerrar={() => setDialogo(null)}
          onListo={() => (setDialogo(null), toast.ok(dialogo === "salida" ? "Salida registrada." : "Entrada registrada."), void refrescar())}
        />
      )}
      {dialogo === "noventa" && <NoVenta motivos={caja.noVentaMotivos} onCerrar={() => setDialogo(null)} onListo={() => (setDialogo(null), toast.ok("Gaveta abierta. Quedó anotado."), void refrescar())} />}
      {dialogo === "gaveta" && <GavetaDueno onCerrar={() => setDialogo(null)} onListo={() => (setDialogo(null), toast.ok("Gaveta abierta por orden del dueño."), void refrescar())} />}
      {dialogo === "corte" && (
        <CorteCaja
          estado={caja}
          onCerrar={() => setDialogo(null)}
          onHecho={async (k) => {
            setDialogo(null);
            let errorImpresion: string | undefined;
            try {
              await imprimirCorte(k);
            } catch (e) {
              errorImpresion = textoError(e);
            }
            setCorte({ k, errorImpresion });
            void refrescar();
          }}
        />
      )}
      {dialogo === "cerrar" && (
        <CerrarCaja
          estado={caja}
          ciego={usuario.rol === "cajero"}
          esperasAbiertas={esperas}
          pagosElectronicos={r?.pagosElectronicos ?? []}
          onCerrar={() => setDialogo(null)}
          onCerrada={async (res, o) => {
            setDialogo(null);
            setCierre({ r: res, o });
            void refrescar();
            if (config.imprime_tiquete) {
              try {
                await imprimirZ(res.turnoId, { ...o, denominaciones: caja.denominaciones });
              } catch (e) {
                setCierre({ r: res, o, errorImpresion: textoError(e) });
              }
            }
          }}
        />
      )}
      {cierre && <ResultadoCierreModal cierre={cierre} estado={caja} onCerrar={() => setCierre(null)} onCambio={refrescar} />}
      {corte && (
        <Modal titulo={`Corte de las ${hora(corte.k.fecha)}`} onCerrar={() => setCorte(null)} ancho={480}>
          <table className="tbl tbl-compacta">
            <tbody>
              {corte.k.resumen.porForma.map((f) => (
                <tr key={f.formaPagoId}>
                  <td>{f.nombre}</td>
                  <td className="num">{f.pagos}</td>
                  <td className="num">{monto(f.monto)}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Total vendido</td>
                <td className="num">{corte.k.resumen.ventas}</td>
                <td className="num">{monto(corte.k.resumen.totalVentas)}</td>
              </tr>
            </tbody>
          </table>
          <dl className="caja-cifras">
            <div>
              <dt>Efectivo esperado</dt>
              <dd>{monto(corte.k.resumen.efectivoEsperado)}</dd>
            </div>
            {corte.k.retiro > 0 && (
              <div>
                <dt>Retiro</dt>
                <dd>−{monto(corte.k.retiro)}</dd>
              </div>
            )}
            <div className="destacado">
              <dt>Queda en la caja</dt>
              <dd>{monto(corte.k.efectivoDespues)}</dd>
            </div>
          </dl>
          {corte.errorImpresion ? <Alert tono="error" titulo="No se imprimió el corte">{corte.errorImpresion}</Alert> : <p className="muted">Corte enviado a la impresora.</p>}
          <div className="fila-botones">
            <Button icono={Printer} onClick={() => imprimirCorte(corte.k).then(() => setCorte({ ...corte, errorImpresion: undefined }), (e) => setCorte({ ...corte, errorImpresion: textoError(e) }))}>
              Imprimir otra vez
            </Button>
            <span className="separador" />
            <Button variante="primario" onClick={() => setCorte(null)}>
              Listo
            </Button>
          </div>
        </Modal>
      )}
      {verTurno && <DetalleTurno turnoId={verTurno} estado={caja} onCerrar={() => setVerTurno(null)} onCambio={refrescar} />}
    </div>
  );
}

/** Después de cerrar: el resultado y el Z completo en pantalla (también para el cajero). */
function ResultadoCierreModal(p: { cierre: { r: ResultadoCierre; o: OpcionesCierre; errorImpresion?: string }; estado: EstadoCaja; onCerrar(): void; onCambio(): Promise<void> }) {
  const { config, puede, usuario } = useSesion();
  const { r: res } = p.cierre;
  const [d, setD] = useState<Detalle | null>(null);
  const [nota, setNota] = useState("");
  const [notaGuardada, setNotaGuardada] = useState(false);
  const [error, setError] = useState(p.cierre.errorImpresion ?? "");
  const toast = useToast();
  const cargar = () => datosReporteZ(res.turnoId).then((x) => setD(x.detalle), (e) => setError(textoError(e)));
  useEffect(() => void cargar(), [res.turnoId]);
  useEffect(() => setError(p.cierre.errorImpresion ?? ""), [p.cierre.errorImpresion]);
  const dif = res.diferencia ?? 0;
  return (
    <Modal titulo="Caja cerrada" onCerrar={p.onCerrar} ancho={900}>
      {dif === 0 ? (
        <Alert tono="ok" titulo="Cuadra">
          Contado {monto(res.contado)}, igual a lo esperado.
        </Alert>
      ) : (
        <Alert tono={res.requiereRevision ? "aviso" : "info"} titulo={dif > 0 ? "Sobrante" : "Faltante"}>
          Esperado {monto(res.esperado ?? 0)}, contado {monto(res.contado)}: {signo(dif)}.{res.requiereRevision && " Queda para revisión del dueño."}
        </Alert>
      )}
      {!res.bitacoraOk && <Alert tono="error">La bitácora no pasó la verificación. Avise al técnico.</Alert>}
      {res.requiereRevision && !notaGuardada && d && !d.turno.notaCierre && (usuario.rol === "cajero" || puede("caja.admin")) && (
        <form
          className="row abajo"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await notaCierre(res.turnoId, nota.trim());
              setNotaGuardada(true);
              toast.ok("Nota guardada.");
              await cargar();
            } catch (err) {
              setError(textoError(err));
            }
          }}
        >
          <Field label="¿Qué pudo pasar? (opcional, queda en el cierre)" flex={1} className="sin-margen">
            <input value={nota} maxLength={500} onChange={(e) => setNota(e.target.value)} />
          </Field>
          <Button type="submit" icono={NotebookPen} disabled={nota.trim().length < 5}>
            Guardar nota
          </Button>
        </form>
      )}
      {error && <Alert tono="error" titulo="No se imprimió el cierre">{error} El cierre sí quedó guardado: se puede imprimir desde aquí o desde Turnos.</Alert>}
      {d && <VistaZ d={d} denominaciones={p.estado.denominaciones} />}
      <div className="fila-botones">
        {d && <BotonImprimirZ turnoId={res.turnoId} opciones={p.cierre.o} denominaciones={p.estado.denominaciones} onError={setError} onListo={() => setError("")} />}
        {d && puede("caja.admin") && <BotonPdf d={d} denominaciones={p.estado.denominaciones} onError={setError} />}
        <span className="separador" />
        <Button variante="primario" onClick={p.onCerrar}>
          Listo
        </Button>
      </div>
      {!config.imprime_tiquete && <p className="muted">La impresión automática está apagada (config imprime_tiquete).</p>}
    </Modal>
  );
}

/** Imprime el Z con las casillas elegidas. Si ya se imprimió, sale como COPIA y pide el PIN del dueño. */
function BotonImprimirZ(p: { turnoId: string; opciones: OpcionesCierre; denominaciones: number[]; onError(m: string): void; onListo(): void; texto?: string }) {
  const [pidePin, setPidePin] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const toast = useToast();
  async function intentar(pin?: string) {
    setOcupado(true);
    try {
      const copia = await imprimirZ(p.turnoId, { ...p.opciones, denominaciones: p.denominaciones }, pin);
      toast.ok(copia ? "Copia del cierre enviada a la impresora." : "Cierre enviado a la impresora.");
      p.onListo();
      setPidePin(false);
    } finally {
      setOcupado(false);
    }
  }
  return (
    <>
      <Button
        icono={Printer}
        disabled={ocupado}
        onClick={async () => {
          try {
            const { copia } = await datosReporteZ(p.turnoId);
            if (copia) return setPidePin(true);
            await intentar();
          } catch (e) {
            p.onError(textoError(e));
          }
        }}
      >
        {p.texto ?? "Imprimir cierre Z"}
      </Button>
      {pidePin && <PinDueno motivo="El cierre ya se imprimió: la reimpresión sale marcada COPIA." onCerrar={() => setPidePin(false)} onPin={(pin) => intentar(pin)} />}
    </>
  );
}

function BotonPdf(p: { d: Detalle; denominaciones: number[]; onError(m: string): void }) {
  return (
    <Button
      icono={FileDown}
      onClick={async () => {
        try {
          const n = await obtenerNegocio();
          const bytes = pdfCierre(n, p.d, { copia: p.d.turno.reimpresiones > 0, denominaciones: p.denominaciones });
          descargar(`cierre-${p.d.turno.dia}-${p.d.turno.id.slice(-6)}.pdf`, bytes, "application/pdf");
        } catch (e) {
          p.onError(textoError(e));
        }
      }}
    >
      Exportar PDF
    </Button>
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
                <td className="num">{t.ventas ?? <span className="muted" title="Se ve al cerrar">—</span>}</td>
                <td className="num">{t.total == null ? <span className="muted" title="Se ve al cerrar">—</span> : monto(t.total)}</td>
                <td className="num">{t.diferencia == null ? "" : signo(t.diferencia)}</td>
                <td>
                  <div className="row">
                    {t.pendienteRevision && <Badge tono="aviso">Revisar</Badge>}
                    {t.alertaNoVentas && <Badge tono="aviso">{plural(t.noVentas, "apertura", "aperturas")} sin venta</Badge>}
                  </div>
                </td>
              </FilaClic>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DetalleTurno(p: { turnoId: string; estado: EstadoCaja; onCerrar(): void; onCambio(): Promise<void> }) {
  const { config, puede } = useSesion();
  const [d, setD] = useState<Detalle | null>(null);
  const [error, setError] = useState("");
  const [reabrir, setReabrir] = useState(false);
  const [pin, setPin] = useState("");
  const [motivo, setMotivo] = useState("");
  const [opciones, setOpciones] = useState<OpcionesCierre>(opcionesPorDefecto(p.estado));
  const cargar = () => detalleTurno(p.turnoId).then(setD, (e) => setError(textoError(e)));
  useEffect(() => {
    void cargar();
  }, [p.turnoId]);

  const t = d?.turno;
  const admin = puede("caja.admin");
  const umbral = config.caja_umbral_diferencia;

  return (
    <Modal titulo={t ? `Turno del ${t.dia}` : "Turno"} onCerrar={p.onCerrar} ancho={900}>
      {error && <Alert tono="error">{error}</Alert>}
      {t && d && (
        <>
          {d.veTotales ? (
            <VistaZ d={d} denominaciones={p.estado.denominaciones} />
          ) : (
            <Alert tono="info" titulo="Turno abierto">
              Abrió {t.usuarioApertura} a las {hora(t.abiertoEn)}. Los totales se ven al cerrar.
            </Alert>
          )}
          {admin && t.diferencia != null && t.diferencia !== 0 && Math.abs(t.diferencia) >= umbral && !t.revisadaPor && (
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
              <Alert tono="aviso">Reabrir borra el conteo de este cierre (queda en la bitácora) y deja contar otra vez.</Alert>
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
            <>
              {t.estado === "cerrado" && d.veTotales && <CasillasZ valor={opciones} onCambio={setOpciones} />}
              <div className="fila-botones">
                {t.estado === "cerrado" && d.veTotales && (
                  <BotonImprimirZ
                    turnoId={t.id}
                    opciones={opciones}
                    denominaciones={p.estado.denominaciones}
                    onError={setError}
                    onListo={() => void cargar()}
                    texto={t.reimpresiones > 0 ? "Reimprimir (COPIA)" : "Imprimir cierre Z"}
                  />
                )}
                {t.estado === "cerrado" && admin && <BotonPdf d={d} denominaciones={p.estado.denominaciones} onError={setError} />}
                <span className="separador" />
                {admin && t.estado === "cerrado" && t.dia === diaLocal() && (
                  <Button icono={RotateCcw} onClick={() => setReabrir(true)}>
                    Reabrir
                  </Button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

/** Vista del dueño: todas las aperturas de gaveta sin venta, por fechas y usuario. */
function AperturasSinVenta() {
  const [desde, setDesde] = useState(haceDias(7));
  const [hasta, setHasta] = useState(diaLocal());
  const [usuarioId, setUsuarioId] = useState("");
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [filas, setFilas] = useState<AperturaGaveta[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    listarUsuarios().then((l) => setUsuarios(l.filter((u) => u.rol !== "tecnico")), () => undefined);
  }, []);
  useEffect(() => {
    aperturasGaveta(desde, hasta, usuarioId || null).then(setFilas, (e) => setError(textoError(e)));
  }, [desde, hasta, usuarioId]);
  return (
    <section className="card">
      <div className="caja-cabeza">
        <h2>
          <Inbox size={20} aria-hidden /> Gaveta abierta sin venta
        </h2>
        <div className="row">
          <Field label="Desde">
            <input type="date" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} />
          </Field>
          <Field label="Hasta">
            <input type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} />
          </Field>
          <Field label="Usuario">
            <select value={usuarioId} onChange={(e) => setUsuarioId(e.target.value)}>
              <option value="">Todos</option>
              {usuarios.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nombre}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      {error && <Alert tono="error">{error}</Alert>}
      {filas && filas.length === 0 && <EmptyState icono={Inbox} titulo="No se abrió la gaveta sin venta en esas fechas" />}
      {filas && filas.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Usuario</th>
              <th>Motivo</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((x) => (
              <tr key={x.id}>
                <td>{fechaHora(new Date(x.fecha)).slice(0, 16)}</td>
                <td>{x.usuario}</td>
                <td>
                  {x.causa === "dueno" ? `Orden del dueño (${x.autorizadoPor ?? ""}): ${x.motivo}` : x.motivo}
                  {x.nota && <span className="muted"> · {x.nota}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
