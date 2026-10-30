import { useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import { registrar } from "../db/bitacora";
import { AVISO_RESPALDO, CONTRASENA_MINIMA, crearRespaldo } from "../lib/respaldoApi";

/** Respaldo cifrado de toda la base (solo dueño: contiene datos de clientes). */
export default function Respaldo() {
  const { actor } = useSesion();
  const [c1, setC1] = useState("");
  const [c2, setC2] = useState("");
  const [entendido, setEntendido] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [ocupado, setOcupado] = useState(false);

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    setOcupado(true);
    try {
      const ruta = await crearRespaldo(c1, c2);
      await registrar(actor.id, "respaldo.crear", "respaldo", null, { cifrado: "AES-256-GCM" });
      setOk(`Respaldo guardado en: ${ruta}`);
      setC1("");
      setC2("");
    } catch (err) {
      setError(textoError(err));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="screen">
      <h1>Respaldo</h1>
      <section className="card login-card">
        <p className="note">{AVISO_RESPALDO}</p>
        <form onSubmit={crear}>
          <label className="campo">
            Contraseña del respaldo (mínimo {CONTRASENA_MINIMA} caracteres)
            <input type="password" autoComplete="new-password" value={c1} onChange={(e) => setC1(e.target.value)} />
          </label>
          <label className="campo">
            Repita la contraseña
            <input type="password" autoComplete="new-password" value={c2} onChange={(e) => setC2(e.target.value)} />
          </label>
          <label className="consentimiento">
            <input type="checkbox" checked={entendido} onChange={(e) => setEntendido(e.target.checked)} /> Entiendo que contiene datos
            personales y que sin la contraseña no se puede recuperar
          </label>
          <Mensaje error={error} ok={ok} />
          <button className="primary" disabled={ocupado || !entendido || c1.length < CONTRASENA_MINIMA}>
            {ocupado ? "Creando…" : "Crear respaldo cifrado"}
          </button>
        </form>
        <p className="muted">Se guarda en Documentos\Respaldos POS. Para restaurarlo, llame al técnico.</p>
      </section>
    </div>
  );
}
