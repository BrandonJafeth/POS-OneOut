// Diálogos de caja: abrir (con conteo), entrada/salida de efectivo y cierre con arqueo.
import { ArrowDownToLine, ArrowUpFromLine, Banknote, Lock, LockOpen } from "lucide-react";
import { useState } from "react";
import { textoError } from "../../components/Mensaje";
import Modal from "../../components/Modal";
import PinDueno from "../../components/PinDueno";
import {
  abrirCaja,
  cerrarCaja,
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
import { leerMontoEntero } from "../../lib/texto";
import { monto } from "../../lib/tickets";
import Alert from "../../ui/Alert";
import Button from "../../ui/Button";
import CampoMonto from "../../ui/CampoMonto";
import Field from "../../ui/Field";
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
  const [error, setError] = useState("");
  const [pidePin, setPidePin] = useState(false);
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
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          if (grande) return setPidePin(true);
          try {
            await enviar();
          } catch (err) {
            setError(textoError(err));
          }
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
        <Button type="submit" variante="primario" icono={p.tipo === "salida" ? ArrowUpFromLine : ArrowDownToLine} atajo="Enter" disabled={!categoria || !texto}>
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

export function CerrarCaja(p: { estado: EstadoCaja; esperasAbiertas: number; pagosElectronicos: PagoElectronico[]; onCerrar(): void; onCerrada(r: ResultadoCierre): void }) {
  const [conteo, setConteo] = useState<ConteoEntrada>(CONTEO_VACIO);
  // Primero se revisan tarjeta/SINPE/transferencias contra el datáfono; después se cuenta el efectivo.
  const [paso, setPaso] = useState<"revisar" | "contar" | "nota">(p.pagosElectronicos.length ? "revisar" : "contar");
  const [nota, setNota] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const cerrar = async (conNota: string) => {
    setOcupado(true);
    setError("");
    try {
      p.onCerrada(await cerrarCaja(conteo, conNota));
    } catch (e) {
      const m = textoError(e);
      if (m.startsWith(NOTA_REQUERIDA)) setPaso("nota");
      else setError(m);
      setOcupado(false);
    }
  };

  return (
    <Modal titulo="Cerrar caja" onCerrar={p.onCerrar} ancho={720}>
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
            Cuente todo el efectivo de la gaveta.{" "}
            {p.estado.cierreCiego ? "El sistema compara con lo esperado al cerrar." : "Al cerrar verá si cuadra con lo esperado."}
          </p>
          {p.esperasAbiertas > 0 && <Alert tono="aviso">Hay {p.esperasAbiertas} venta(s) en espera sin cobrar. Se quedan para mañana.</Alert>}
          <ConteoDinero denominaciones={p.estado.denominaciones} valor={conteo} onCambio={setConteo} etiquetaTotal="Efectivo contado" />
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
                try {
                  if (await necesitaNota(conteo)) return setPaso("nota");
                } catch (e) {
                  return setError(textoError(e));
                }
                await cerrar("");
              }}
            >
              Cerrar con {monto(totalConteo(conteo))}
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
            Revise de nuevo el dinero. Si el conteo está bien, escriba qué pudo pasar: el dueño lo va a revisar.
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
