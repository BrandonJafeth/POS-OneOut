// Apartar la venta actual (F9): cuánto abona hoy (viene el mínimo, seleccionado) y Enter; después el
// mismo cobro de siempre por ese monto. F9 → Enter → Enter. Rust vuelve a revisar todo.
import { CalendarClock } from "lucide-react";
import { useRef, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import type { Reglas } from "../../db/cuentas";
import { abonoMinimo, fechaLimite, validarAbono } from "../../lib/cuentas";
import { conMiles, leerMontoEntero } from "../../lib/texto";
import { monto } from "../../lib/tickets";
import type { Banco, FormaPago, PagoEntrada } from "../../tipos";
import Alert from "../../ui/Alert";
import Button from "../../ui/Button";
import CampoMonto from "../../ui/CampoMonto";
import Field from "../../ui/Field";
import Cobro from "./Cobro";

const fechaLarga = (d: string) => new Intl.DateTimeFormat("es-CR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

export default function Apartar(p: {
  total: number;
  cliente: string;
  reglas: Reglas;
  /** Día de negocio del turno abierto: desde ahí corre el plazo. */
  dia: string;
  formas: FormaPago[];
  bancos: Banco[];
  onApartar(monto: number, pagos: PagoEntrada[], descripcion: string): Promise<void>;
  onCerrar(): void;
}) {
  const { config } = useSesion();
  const minimo = abonoMinimo(p.total, p.reglas.abonoMinimoPct);
  const [texto, setTexto] = useState(conMiles(String(minimo)));
  const [cobrando, setCobrando] = useState<number | null>(null);
  const [intento, setIntento] = useState(false);
  const [detalle, setDetalle] = useState("");
  const campo = useRef<HTMLInputElement>(null);
  const abono = leerMontoEntero(texto) ?? 0;
  const limite = fechaLimite(p.dia, p.reglas.plazoDias, p.reglas.plazoTipo, config.caja_horario);
  const error = abono === p.total ? "Si paga todo hoy, cóbrelo como venta (F12)." : validarAbono(p.total, abono, minimo);

  if (cobrando != null)
    return (
      <Cobro
        titulo={`Abono del apartado · ${monto(cobrando)}`}
        total={cobrando}
        totalExacto={cobrando}
        pagador={p.cliente}
        formas={p.formas}
        bancos={p.bancos}
        onCobrar={(pagos) => p.onApartar(cobrando, pagos, detalle)}
        onCerrar={() => setCobrando(null)}
      />
    );

  return (
    <Modal titulo="Apartar" onCerrar={p.onCerrar} ancho={520}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setIntento(true);
          if (error) return campo.current?.focus();
          setCobrando(abono);
        }}
      >
        <dl className="cifras">
          <div>
            <dt>Cliente</dt>
            <dd>{p.cliente}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>{monto(p.total)}</dd>
          </div>
          <div>
            <dt>Abono mínimo ({p.reglas.abonoMinimoPct} %)</dt>
            <dd>{monto(minimo)}</dd>
          </div>
          <div>
            <dt>
              <CalendarClock size={16} aria-hidden /> Retirar antes del
            </dt>
            <dd>{fechaLarga(limite)}</dd>
          </div>
        </dl>
        <Field label="Abona hoy" error={intento ? error : undefined} ayuda={!intento || !error ? `Queda debiendo ${monto(Math.max(0, p.total - abono))}.` : undefined}>
          <CampoMonto ref={campo} grande autoFocus valor={texto} onCambio={(t) => (setTexto(t), setIntento(false))} />
        </Field>
        <Field label="Qué se aparta (opcional)" ayuda="Sale en el comprobante y sirve para buscarlo al abonar.">
          {/* data-opcional: Enter en el monto cobra directo (F9 → Enter → Enter); aquí se llega con Tab o ↓. */}
          <input data-opcional value={detalle} maxLength={200} placeholder="Ej.: retablo de graduada, marco dorado" onChange={(e) => setDetalle(e.target.value)} />
        </Field>
        {p.reglas.condiciones.trim() && (
          <Alert tono="info" titulo="Condiciones">
            {p.reglas.condiciones}
          </Alert>
        )}
        <div className="fila-botones">
          <Button type="submit" variante="primario" tamano="lg" atajo="Enter">
            Cobrar el abono
          </Button>
        </div>
      </form>
    </Modal>
  );
}
