// "Datos del cliente" (solo dueño): ver, rectificar, exportar y anonimizar (derechos del titular).
import { useEffect, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import Mensaje, { textoError } from "../../components/Mensaje";
import {
  ADVERTENCIA_NOTAS,
  anonimizarCliente,
  cuentasConSaldo,
  datosParaExportar,
  editarCliente,
  MOTIVOS_ANONIMIZACION,
  obtenerCliente,
  type CuentaResumen,
  type MotivoAnonimizacion,
} from "../../db/clientes";
import { obtenerNegocio } from "../../db/negocio";
import { csvCliente, descargar, pdfCliente } from "../../lib/exportarCliente";
import { monto } from "../../lib/tickets";
import { plural } from "../../lib/texto";
import { TIPO_IDENTIFICACION, type Cliente, type TipoIdentificacion } from "../../tipos";
import { useToast } from "../../ui/Toast";
import { useEnvio } from "../../ui/useEnvio";

export default function DatosCliente(p: { clienteId: string; motivoSugerido?: MotivoAnonimizacion; onCerrar(): void; onCambio(): void }) {
  const { actor } = useSesion();
  const [c, setC] = useState<Cliente | null>(null);
  const [form, setForm] = useState<Cliente | null>(null);
  const [pendientes, setPendientes] = useState<CuentaResumen[]>([]);
  const [anonimizando, setAnonimizando] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const envio = useEnvio(); // guardar y exportar, de a uno (doble clic = un solo archivo)

  async function cargar() {
    const x = await obtenerCliente(actor, p.clienteId);
    if (!x) throw new Error("Cliente no encontrado");
    setC(x);
    setForm(x);
    setPendientes(await cuentasConSaldo(p.clienteId));
  }
  useEffect(() => void cargar().catch((e) => setError(textoError(e))), [p.clienteId]);

  if (!c || !form) return <Modal titulo="Datos del cliente" onCerrar={p.onCerrar}>{error ? <Mensaje error={error} /> : "Cargando…"}</Modal>;
  const anonimo = !!c.anonimizadoEn;
  const set = (patch: Partial<Cliente>) => setForm({ ...form, ...patch });
  const sucio = (["nombre", "telefono", "tipoIdentificacion", "cedula", "correo", "notas"] as const).some((k) => (form[k] ?? "") !== (c[k] ?? ""));

  async function guardar() {
    setError("");
    try {
      await editarCliente(actor, c!.id, {
        nombre: form!.nombre,
        telefono: form!.telefono ?? "",
        tipoIdentificacion: form!.tipoIdentificacion,
        cedula: form!.cedula,
        correo: form!.correo,
        notas: form!.notas,
      });
      p.onCambio();
      toast.ok("Datos corregidos.");
      p.onCerrar();
    } catch (e) {
      setError(textoError(e));
    }
  }

  async function exportar(formato: "csv" | "pdf") {
    setError("");
    try {
      const datos = await datosParaExportar(actor, c!.id, formato);
      const base = `datos-cliente-${c!.id.slice(-6)}`;
      const ruta =
        formato === "csv" ? await descargar(`${base}.csv`, csvCliente(datos), "Clientes") : await descargar(`${base}.pdf`, pdfCliente(datos, await obtenerNegocio()), "Clientes");
      toast.guardado("Archivo guardado. Entrégueselo solo al titular de los datos.", ruta);
    } catch (e) {
      setError(textoError(e));
    }
  }

  const campo = (texto: string, k: "nombre" | "telefono" | "cedula" | "correo") => (
    <label className="campo" style={{ flex: 1 }}>
      {texto}
      <input value={form[k] ?? ""} disabled={anonimo} onChange={(e) => set({ [k]: e.target.value })} />
    </label>
  );

  return (
    <Modal titulo="Datos del cliente" onCerrar={p.onCerrar} ancho={680}>
      {anonimo && <p className="note">Cliente anonimizado el {new Date(c.anonimizadoEn!).toLocaleDateString("es-CR")}. Sus compras quedan sin datos personales.</p>}
      <div className="row">
        {campo("Nombre *", "nombre")}
        {campo("Teléfono *", "telefono")}
      </div>
      <div className="row">
        <label className="campo" style={{ flex: 1 }}>
          Tipo de identificación
          <select
            value={form.tipoIdentificacion ?? ""}
            disabled={anonimo}
            onChange={(e) => set({ tipoIdentificacion: (e.target.value || null) as TipoIdentificacion | null })}
          >
            <option value="">—</option>
            {Object.entries(TIPO_IDENTIFICACION).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {campo("Cédula", "cedula")}
        {campo("Correo", "correo")}
      </div>
      <label className="campo">
        Notas
        <textarea rows={2} value={form.notas ?? ""} disabled={anonimo} onChange={(e) => set({ notas: e.target.value })} />
        <span className="ayuda advertencia">{ADVERTENCIA_NOTAS}.</span>
      </label>
      <p className="muted">
        Consentimiento: {c.consentimientoDatos ? "sí" : "no"}
        {c.consentimientoFecha && ` · ${new Date(c.consentimientoFecha).toLocaleString("es-CR")}`}
        {c.consentimientoVersion && ` · aviso versión ${c.consentimientoVersion}`}
      </p>
      {pendientes.length > 0 && (
        <p className="muted">
          Saldo pendiente: {pendientes.map((k) => `${k.tipo} ${monto(k.saldo)}`).join(", ")}
        </p>
      )}
      <Mensaje error={error} />
      {!anonimo && (
        <div className="row">
          <button className="primary" disabled={!sucio || envio.ocupado} onClick={() => envio.enviar(guardar)}>
            Guardar corrección
          </button>
          <button disabled={envio.ocupado} onClick={() => envio.enviar(() => exportar("pdf"))}>
            Exportar PDF
          </button>
          <button disabled={envio.ocupado} onClick={() => envio.enviar(() => exportar("csv"))}>
            Exportar CSV
          </button>
          <button className="peligro" onClick={() => setAnonimizando(true)}>
            Anonimizar…
          </button>
        </div>
      )}
      {anonimizando && (
        <Anonimizar
          bloqueo={pendientes.length ? `Tiene ${plural(pendientes.length, "apartado o crédito", "apartados o créditos")} con saldo pendiente. Primero liquídelos o cancélelos.` : ""}
          motivoSugerido={p.motivoSugerido}
          onCerrar={() => setAnonimizando(false)}
          onConfirmar={async (pin, motivo) => {
            await anonimizarCliente(actor, c.id, pin, motivo);
            p.onCambio();
            toast.ok("Cliente anonimizado.");
            p.onCerrar();
          }}
        />
      )}
    </Modal>
  );
}

function Anonimizar(p: {
  bloqueo: string;
  motivoSugerido?: MotivoAnonimizacion;
  onCerrar(): void;
  onConfirmar(pin: string, motivo: MotivoAnonimizacion): Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [motivo, setMotivo] = useState<MotivoAnonimizacion | "">(p.motivoSugerido ?? "");
  const { ocupado, error, setError, enviar } = useEnvio();
  return (
    <Modal titulo="Anonimizar cliente" onCerrar={p.onCerrar} ancho={460}>
      {p.bloqueo ? (
        <Mensaje error={p.bloqueo} />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!motivo) return setError("Elija el motivo");
            void enviar(() => p.onConfirmar(pin, motivo)).then((ok) => ok || setPin(""));
          }}
        >
          <p>
            Se borran para siempre nombre, teléfono, cédula, correo y notas. Las compras y apartados se conservan sin datos personales.{" "}
            <strong>No se puede deshacer.</strong>
          </p>
          <label className="campo">
            Motivo
            <select value={motivo} onChange={(e) => setMotivo(e.target.value as MotivoAnonimizacion)}>
              <option value="">— Elija —</option>
              {Object.entries(MOTIVOS_ANONIMIZACION).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="campo">
            Su PIN de dueño
            <input className="pin" type="password" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
          </label>
          <Mensaje error={error} />
          <button className="peligro" disabled={!pin || !motivo || ocupado}>
            Anonimizar definitivamente
          </button>
        </form>
      )}
    </Modal>
  );
}
