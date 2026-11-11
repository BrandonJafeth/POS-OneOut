// Diálogos de caja: abrir (con conteo), entrada/salida de efectivo, cierre con arqueo (ciego para el
// cajero) y casillas del Z, "no venta", orden del dueño para abrir la gaveta y corte parcial.
import { ArrowDownToLine, ArrowUpFromLine, Banknote, Inbox, Lock, LockOpen, Scissors, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { textoError } from "../../components/Mensaje";
import Modal from "../../components/Modal";
import PinDueno from "../../components/PinDueno";
import {
  abrirCaja,
  cerrarCaja,
  gavetaDueno,
  hacerCorte,
  noVenta,
  type Corte,
  NOTA_REQUERIDA,
  necesitaNota,
  registrarMovimiento,
  CONTEO_VACIO,
  totalConteo,
  type ConteoEntrada,
  type EstadoCaja,
  type PagoElectronico,
  type ResultadoCierre,
} from "../../db/caja";
import { leerMontoEntero, plural } from "../../lib/texto";
import { monto } from "../../lib/tickets";
import Alert from "../../ui/Alert";
import Button from "../../ui/Button";
import CampoMonto from "../../ui/CampoMonto";
import Field from "../../ui/Field";
import { useEnvio } from "../../ui/useEnvio";
import { opcionesPorDefecto } from "../../lib/caja/reporteZ";
import ConteoDinero from "./Conteo";
import PagosElectronicos from "./PagosElectronicos";

export function AbrirCaja(p: { estado: EstadoCaja; onCerrar(): void; onAbierta(): void }) {
  const [conteo, setConteo] = useState<ConteoEntrada>(CONTEO_VACIO);
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  return (
    <Modal titulo="Abrir caja" onCerrar={p.onCerrar} ancho={720}>
      <p className="muted">Cuente el dinero con que empieza el día (el fondo para dar vuelto).</p>
      <ConteoDinero denominaciones={p.estado.denominaciones} valor={conteo} onCambio={setConteo} etiquetaTotal="Fondo inicial" />
      {totalConteo(conteo) === 0 && <Alert tono="aviso">Sin fondo: no habrá efectivo para dar vuelto en las primeras ventas.</Alert>}
      {error && <Alert tono="error">{error}</Alert>}
      <div className="fila-botones">
        <Button onClick={p.onCerrar}>Cancelar</Button>
        <span className="separador" />
        <Button
          variante="primario"
          tamano="lg"
          icono={LockOpen}
          disabled={ocupado}
          onClick={async () => {
            setOcupado(true);
            setError("");
            try {
              await abrirCaja(conteo);
              p.onAbierta();
            } catch (e) {
              setError(textoError(e));
              setOcupado(false);
            }
          }}
        >
          Abrir con {monto(totalConteo(conteo))}
        </Button>
      </div>
    </Modal>
  );
}

export function MovimientoCaja(p: { estado: EstadoCaja; tipo: "entrada" | "salida"; onCerrar(): void; onListo(id: string): void }) {
  const motivos = p.estado.motivos[p.tipo] ?? [];
  const [categoria, setCategoria] = useState(motivos[0] ?? "");
  const [texto, setTexto] = useState("");
  const [nota, setNota] = useState("");
  const [pidePin, setPidePin] = useState(false);
  // Dinero: un doble clic o doble Enter registraría la entrada dos veces.
  const { ocupado, error, setError, enviar: unaVez } = useEnvio();
  const valor = leerMontoEntero(texto);
  const grande = p.tipo === "salida" && valor !== null && valor > p.estado.salidaMaxSinPin;

  const enviar = async (pin?: string) => {
    if (valor === null || valor <= 0) return setError("Escriba el monto en colones.");
    const id = await registrarMovimiento({ tipo: p.tipo, monto: valor, categoria, nota: nota.trim() }, pin);
    p.onListo(id);
  };

  return (
    <Modal titulo={p.tipo === "salida" ? "Salida de efectivo" : "Entrada de efectivo"} onCerrar={p.onCerrar} ancho={460}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          if (grande) return setPidePin(true);
          void unaVez(() => enviar());
        }}
      >
        <Field label="Monto">
          <CampoMonto autoFocus valor={texto} onCambio={setTexto} />
        </Field>
        <Field label="Motivo">
          <select value={categoria} onChange={(e) => setCategoria(e.target.value)}>
            {motivos.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Nota (opcional)">
          <input value={nota} maxLength={200} onChange={(e) => setNota(e.target.value)} />
        </Field>
        {grande && <Alert tono="aviso">Pasa de {monto(p.estado.salidaMaxSinPin)}: pide el PIN del dueño.</Alert>}
        {error && <Alert tono="error">{error}</Alert>}
        <Button type="submit" variante="primario" icono={p.tipo === "salida" ? ArrowUpFromLine : ArrowDownToLine} atajo="Enter" disabled={!categoria || !texto || ocupado}>
          Registrar {valor ? monto(valor) : ""}
        </Button>
      </form>
      {pidePin && (
        <PinDueno
          motivo={`Salida de ${monto(valor ?? 0)} (${categoria}).`}
          onCerrar={() => setPidePin(false)}
          onPin={async (pin) => {
            await enviar(pin);
            setPidePin(false);
          }}
        />
      )}
    </Modal>
  );
}

/** Opciones del cierre Z que se eligen al cerrar (por defecto, las de Caja y cierre). */
export interface OpcionesCierre {
  detalleCompleto: boolean;
  porDepartamento: boolean;
}

export function CasillasZ(p: { valor: OpcionesCierre; onCambio(v: OpcionesCierre): void }) {
  return (
    <fieldset className="casillas-z">
      <legend>Al imprimir el cierre Z, agregar:</legend>
      <label>
        <input type="checkbox" checked={p.valor.detalleCompleto} onChange={(e) => p.onCambio({ ...p.valor, detalleCompleto: e.target.checked })} /> Detalle completo (cada producto por departamento)
      </label>
      <label>
        <input type="checkbox" checked={p.valor.porDepartamento} onChange={(e) => p.onCambio({ ...p.valor, porDepartamento: e.target.checked })} /> Un tiquete aparte por departamento
      </label>
    </fieldset>
  );
}

/**
 * Cierre. El cajero cuenta a ciegas (total o billete por billete): no ve lo esperado. Al confirmar, el conteo
 * queda bloqueado (solo el dueño reabre) y recién entonces ve el resultado y el Z completo.
 * El dueño revisa además tarjeta/SINPE/transferencias y escribe una nota si no cuadra.
 */
export function CerrarCaja(p: {
  estado: EstadoCaja;
  ciego: boolean;
  esperasAbiertas: number;
  pagosElectronicos: PagoElectronico[];
  onCerrar(): void;
  onCerrada(r: ResultadoCierre, o: OpcionesCierre): void;
}) {
  const [conteo, setConteo] = useState<ConteoEntrada>(CONTEO_VACIO);
  // El dueño revisa primero tarjeta/SINPE/transferencias contra el datáfono; el cajero no recibe esos montos.
  const [paso, setPaso] = useState<"revisar" | "contar" | "confirmar" | "nota">(!p.ciego && p.pagosElectronicos.length ? "revisar" : "contar");
  const [nota, setNota] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [opciones, setOpciones] = useState<OpcionesCierre>(opcionesPorDefecto(p.estado));

  const cerrar = async (conNota: string) => {
    setOcupado(true);
    setError("");
    try {
      p.onCerrada(await cerrarCaja(conteo, conNota), opciones);
    } catch (e) {
      const m = textoError(e);
      if (m.startsWith(NOTA_REQUERIDA)) setPaso("nota");
      else setError(m), setPaso("contar");
      setOcupado(false);
    }
  };

  return (
    <Modal titulo="Cerrar caja" onCerrar={p.onCerrar} ancho={760}>
      {paso === "revisar" ? (
        <>
          <p className="muted">
            1 de 2 · Revise que los pagos con tarjeta, SINPE y transferencia coincidan con el cierre del datáfono y los comprobantes.
          </p>
          <PagosElectronicos pagos={p.pagosElectronicos} abierto />
          <div className="fila-botones">
            <Button onClick={p.onCerrar}>Cancelar</Button>
            <span className="separador" />
            <Button variante="primario" icono={Banknote} onClick={() => setPaso("contar")}>
              Coincide, contar el efectivo
            </Button>
          </div>
        </>
      ) : paso === "contar" ? (
        <>
          <p className="muted">
            {p.ciego
              ? "Cuente todo el efectivo de la gaveta: escriba el total o cuente billete por billete. Al confirmar, el conteo queda guardado y ya no se puede cambiar; después verá el resultado."
              : "Cuente todo el efectivo de la gaveta. Al cerrar verá si cuadra con lo esperado."}
          </p>
          {p.esperasAbiertas > 0 && <Alert tono="aviso">Hay {plural(p.esperasAbiertas, "venta", "ventas")} en espera sin cobrar. Se quedan para mañana.</Alert>}
          <ConteoDinero denominaciones={p.estado.denominaciones} valor={conteo} onCambio={setConteo} etiquetaTotal="Efectivo contado" />
          <CasillasZ valor={opciones} onCambio={setOpciones} />
          {error && <Alert tono="error">{error}</Alert>}
          <div className="fila-botones">
            <Button onClick={p.onCerrar}>Cancelar</Button>
            <span className="separador" />
            <Button
              variante="primario"
              tamano="lg"
              icono={Lock}
              disabled={ocupado}
              onClick={async () => {
                if (p.ciego) return setPaso("confirmar");
                try {
                  if (await necesitaNota(conteo)) return setPaso("nota");
                } catch (e) {
                  return setError(textoError(e));
                }
                await cerrar("");
              }}
            >
              {p.ciego ? "Listo, revisar el conteo" : `Cerrar con ${monto(totalConteo(conteo))}`}
            </Button>
          </div>
        </>
      ) : paso === "confirmar" ? (
        <>
          <Alert tono="aviso" titulo={`Usted contó ${monto(totalConteo(conteo))}`}>
            Al confirmar se cierra la caja y el conteo ya no se puede cambiar. Si se equivocó, vuelva a contar ahora.
          </Alert>
          <ResumenConteo denominaciones={p.estado.denominaciones} conteo={conteo} />
          {error && <Alert tono="error">{error}</Alert>}
          <div className="fila-botones">
            <Button onClick={() => setPaso("contar")}>Volver a contar</Button>
            <span className="separador" />
            <Button variante="primario" tamano="lg" icono={Lock} disabled={ocupado} onClick={() => void cerrar("")}>
              Confirmar y cerrar
            </Button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void cerrar(nota.trim());
          }}
        >
          <Alert tono="aviso" titulo="El conteo no coincide">
            Revise de nuevo el dinero. Si el conteo está bien, escriba qué pudo pasar: queda en el cierre.
          </Alert>
          <Field label="¿Qué pasó?">
            <textarea rows={3} maxLength={500} autoFocus value={nota} onChange={(e) => setNota(e.target.value)} />
          </Field>
          {error && <Alert tono="error">{error}</Alert>}
          <div className="fila-botones">
            <Button onClick={() => setPaso("contar")}>Volver a contar</Button>
            <span className="separador" />
            <Button type="submit" variante="primario" icono={Lock} disabled={ocupado || nota.trim().length < 5}>
              Cerrar con nota
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function ResumenConteo(p: { denominaciones: number[]; conteo: ConteoEntrada }) {
  if (p.conteo.total !== null) return null; // escribió el total: no hay detalle que mostrar
  const filas = p.denominaciones.map((d) => [d, p.conteo.cantidades[String(d)] ?? 0] as const).filter(([, n]) => n > 0);
  if (!filas.length) return <p className="muted">No contó ningún billete ni moneda (caja vacía).</p>;
  return (
    <table className="tbl tbl-compacta">
      <tbody>
        {filas.map(([d, n]) => (
          <tr key={d}>
            <td>{monto(d)}</td>
            <td className="num">× {n}</td>
            <td className="num">{monto(d * n)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "No venta": abrir la gaveta sin vender (cambiar billetes…), con un motivo. Queda en la bitácora. */
export function NoVenta(p: { motivos: string[]; onCerrar(): void; onListo(): void }) {
  const [motivo, setMotivo] = useState(p.motivos[0] ?? "");
  const [nota, setNota] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const otro = motivo.toLowerCase().startsWith("otro");
  return (
    <Modal titulo="Abrir la gaveta sin venta" onCerrar={p.onCerrar} ancho={440}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setOcupado(true);
          try {
            await noVenta(motivo, nota.trim());
            p.onListo();
          } catch (err) {
            setError(textoError(err));
            setOcupado(false);
          }
        }}
      >
        <p className="muted">Queda anotado con su nombre, la hora y el motivo, y aparece en el cierre.</p>
        <div className="motivos" role="radiogroup" aria-label="Motivo">
          {p.motivos.map((m) => (
            <label key={m} className={m === motivo ? "motivo activo" : "motivo"}>
              <input type="radio" name="motivo" checked={m === motivo} onChange={() => setMotivo(m)} /> {m}
            </label>
          ))}
        </div>
        {otro && (
          <Field label="¿Cuál es el motivo?">
            <input autoFocus value={nota} maxLength={200} onChange={(e) => setNota(e.target.value)} />
          </Field>
        )}
        {error && <Alert tono="error">{error}</Alert>}
        <Button type="submit" variante="primario" icono={Inbox} atajo="Enter" disabled={ocupado || !motivo || (otro && nota.trim().length < 3)}>
          Abrir la gaveta
        </Button>
      </form>
    </Modal>
  );
}

/** Orden del dueño: abre la gaveta con su PIN (también con la caja cerrada). */
export function GavetaDueno(p: { onCerrar(): void; onListo(): void }) {
  const [motivo, setMotivo] = useState("");
  const [pin, setPin] = useState("");
  const { ocupado, error, enviar } = useEnvio();
  return (
    <Modal titulo="Abrir la gaveta (orden del dueño)" onCerrar={p.onCerrar} ancho={420}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void enviar(async () => {
            await gavetaDueno(pin, motivo.trim());
            p.onListo();
          }).then((ok) => ok || setPin(""));
        }}
      >
        <Field label="Motivo">
          <input autoFocus value={motivo} maxLength={120} onChange={(e) => setMotivo(e.target.value)} placeholder="Poner el fondo" />
        </Field>
        <Field label="PIN del dueño">
          <input className="pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </Field>
        {error && <Alert tono="error">{error}</Alert>}
        <Button type="submit" variante="primario" icono={ShieldCheck} disabled={!pin || motivo.trim().length < 3 || ocupado}>
          Abrir la gaveta
        </Button>
      </form>
    </Modal>
  );
}

/** Corte (dueño): acumulado del turno sin cerrarlo y, si quiere, retiro de efectivo con su PIN. */
export function CorteCaja(p: { estado: EstadoCaja; onCerrar(): void; onHecho(c: Corte): void }) {
  const motivos = p.estado.motivos.salida ?? [];
  const [retirar, setRetirar] = useState(false);
  const [texto, setTexto] = useState("");
  const [categoria, setCategoria] = useState(motivos.find((m) => /retiro/i.test(m)) ?? motivos[0] ?? "");
  const [nota, setNota] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const valor = leerMontoEntero(texto) ?? 0;
  return (
    <Modal titulo="Corte de caja" onCerrar={p.onCerrar} ancho={480}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setOcupado(true);
          try {
            p.onHecho(await hacerCorte(retirar && valor > 0 ? { monto: valor, categoria, nota: nota.trim() } : null, retirar ? pin : undefined));
          } catch (err) {
            setError(textoError(err));
            setPin("");
            setOcupado(false);
          }
        }}
      >
        <p className="muted">Muestra e imprime lo vendido hasta ahora por forma de pago. El turno sigue abierto. Queda en la bitácora y en el cierre Z.</p>
        <label className="opcion">
          <input type="checkbox" checked={retirar} onChange={(e) => setRetirar(e.target.checked)} />
          <span>
            <strong>Retirar efectivo</strong>
            <span className="ayuda">Para dejar la caja con menos dinero. Pide su PIN.</span>
          </span>
        </label>
        {retirar && (
          <>
            <Field label="Monto a retirar">
              <CampoMonto autoFocus valor={texto} onCambio={setTexto} />
            </Field>
            <Field label="Motivo">
              <select value={categoria} onChange={(e) => setCategoria(e.target.value)}>
                {motivos.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="Nota (opcional)">
              <input value={nota} maxLength={200} onChange={(e) => setNota(e.target.value)} />
            </Field>
            <Field label="Su PIN de dueño">
              <input className="pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            </Field>
          </>
        )}
        {error && <Alert tono="error">{error}</Alert>}
        <Button type="submit" variante="primario" icono={Scissors} disabled={ocupado || (retirar && (!valor || !pin || !categoria))}>
          {retirar && valor ? `Hacer corte y retirar ${monto(valor)}` : "Hacer corte"}
        </Button>
      </form>
    </Modal>
  );
}
