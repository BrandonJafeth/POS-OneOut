import { useState } from "react";
import RespaldoAutomatico from "./respaldo/RespaldoAutomatico";
import Mensaje, { textoError } from "../components/Mensaje";
import { AVISO_RESPALDO, CONTRASENA_MINIMA, crearRespaldo, reiniciarApp, restaurarRespaldo } from "../lib/respaldoApi";
import { useConfirmar } from "../ui/Confirmar";

/** Respaldo cifrado de toda la base y su restauración (solo dueño: contiene datos de clientes). */
export default function Respaldo() {
  const confirmar = useConfirmar();
  const [c1, setC1] = useState("");
  const [c2, setC2] = useState("");
  const [entendido, setEntendido] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const [archivo, setArchivo] = useState<File | null>(null);
  const [cr, setCr] = useState("");
  const [pin, setPin] = useState("");
  const [errorR, setErrorR] = useState("");
  const [listo, setListo] = useState(false);

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    setOcupado(true);
    try {
      const ruta = await crearRespaldo(c1, c2);
      setOk(`Respaldo guardado en: ${ruta}. Cópielo también a una memoria USB que se guarde fuera del negocio.`);
      setC1("");
      setC2("");
    } catch (err) {
      setError(textoError(err));
    } finally {
      setOcupado(false);
    }
  }

  async function restaurar(e: React.FormEvent) {
    e.preventDefault();
    if (!archivo) return;
    setErrorR("");
    const si = await confirmar({
      titulo: "Restaurar respaldo",
      texto: "Todo lo registrado después de ese respaldo se reemplaza. La base actual queda guardada aparte por si hace falta. ¿Continuar?",
      aceptar: "Restaurar",
      peligro: true,
    });
    if (!si) return;
    setOcupado(true);
    try {
      await restaurarRespaldo(archivo, cr, pin);
      setListo(true);
    } catch (err) {
      setErrorR(textoError(err));
    } finally {
      setPin("");
      setOcupado(false);
    }
  }

  return (
    <div className="screen">
      <h1>Respaldo</h1>
      <RespaldoAutomatico />
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
      </section>

      <section className="card login-card">
        <h2>Restaurar</h2>
        {listo ? (
          <>
            <Mensaje ok="Respaldo verificado y listo. La aplicación se reinicia para usarlo." />
            <button className="primary" onClick={() => void reiniciarApp()}>
              Reiniciar ahora
            </button>
          </>
        ) : (
          <form onSubmit={restaurar}>
            <label className="campo">
              Archivo de respaldo (.posbak)
              <input type="file" accept=".posbak" onChange={(e) => setArchivo(e.target.files?.[0] ?? null)} />
            </label>
            <label className="campo">
              Contraseña del respaldo
              <input type="password" autoComplete="off" value={cr} onChange={(e) => setCr(e.target.value)} />
            </label>
            <label className="campo">
              Su PIN de dueño
              <input className="pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            </label>
            <Mensaje error={errorR} />
            <button className="primary" disabled={ocupado || !archivo || !cr || !pin}>
              {ocupado ? "Revisando…" : "Restaurar respaldo"}
            </button>
          </form>
        )}
        <p className="muted">Un archivo alterado o con otra contraseña no se restaura.</p>
      </section>
    </div>
  );
}
