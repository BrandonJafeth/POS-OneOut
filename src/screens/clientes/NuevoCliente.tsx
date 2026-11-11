// Alta de cliente con aviso de privacidad y consentimiento obligatorio (Ley 8968).
// Lo usa el dueño en Clientes y lo usará el cajero al crear un apartado (fase 2).
import { useEffect, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import Mensaje, { textoError } from "../../components/Mensaje";
import { ADVERTENCIA_NOTAS, crearCliente } from "../../db/clientes";
import { obtenerNegocio } from "../../db/negocio";
import type { ClienteBasico, Negocio } from "../../tipos";
import { useEnvio } from "../../ui/useEnvio";

export default function NuevoCliente(p: { onCreado(c: ClienteBasico): void; onCerrar(): void }) {
  const { actor, puede } = useSesion();
  const [negocio, setNegocio] = useState<Negocio | null>(null);
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [cedula, setCedula] = useState("");
  const [correo, setCorreo] = useState("");
  const [notas, setNotas] = useState("");
  const [acepta, setAcepta] = useState(false);
  const { ocupado, error, setError, enviar } = useEnvio();

  useEffect(() => {
    obtenerNegocio().then(setNegocio, (e) => setError(textoError(e)));
  }, []);

  // Cédula y correo (opcionales) sirven para la factura electrónica; las notas, solo el dueño.
  const completo = puede("clientes");

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!acepta) return setError("Marque que el cliente fue informado y acepta. Sin eso no se guardan sus datos.");
    await enviar(async () => p.onCreado(await crearCliente(actor, { nombre, telefono, cedula, correo, notas }, true, negocio?.avisoPrivacidadVersion ?? "1")));
  }

  return (
    <Modal titulo="Nuevo cliente" onCerrar={p.onCerrar} ancho={620}>
      <form onSubmit={guardar}>
        <div className="row">
          <label className="campo" style={{ flex: 2 }}>
            Nombre *
            <input autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} />
          </label>
          <label className="campo" style={{ flex: 1 }}>
            Teléfono
            <input inputMode="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label className="campo" style={{ flex: 1 }}>
            Cédula
            <input value={cedula} onChange={(e) => setCedula(e.target.value)} />
          </label>
          <label className="campo" style={{ flex: 1 }}>
            Correo (opcional)
            <input type="email" value={correo} onChange={(e) => setCorreo(e.target.value)} />
          </label>
        </div>
        <p className="muted">Pida teléfono (para avisarle) o cédula (para factura). Solo lo necesario.</p>
        {completo && (
          <>
            <label className="campo">
              Notas
              <textarea rows={2} value={notas} onChange={(e) => setNotas(e.target.value)} />
              <span className="ayuda advertencia">{ADVERTENCIA_NOTAS}.</span>
            </label>
          </>
        )}
        <div className="aviso">
          <strong>Aviso de privacidad{negocio?.responsableTratamiento ? ` · ${negocio.responsableTratamiento}` : ""}</strong>
          <p>{negocio?.avisoPrivacidadTexto || "…"}</p>
          <span className="muted">Versión {negocio?.avisoPrivacidadVersion ?? "…"}. Léalo o muéstreselo al cliente.</span>
        </div>
        <label className="consentimiento">
          <input type="checkbox" checked={acepta} onChange={(e) => setAcepta(e.target.checked)} /> El cliente fue informado y acepta el uso de
          sus datos
        </label>
        <Mensaje error={error} />
        <button className="primary" disabled={!acepta || ocupado}>
          Guardar cliente
        </button>
      </form>
    </Modal>
  );
}
