// Respaldo automático: el dueño elige la contraseña una vez (con su PIN); después se hace uno al día
// y uno al cerrar cada turno, se verifica solo y se conservan los últimos N. Rust: respaldo.rs.
import { CheckCircle2, DatabaseBackup, Usb } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../../app/sesion";
import Mensaje, { textoError } from "../../components/Mensaje";
import { guardarConfig } from "../../db/config";
import { AVISO_RESPALDO, CONTRASENA_MINIMA, configurarAutomatico, estadoAutomatico, respaldoAhora, usbConfirmado, validarContrasenaRespaldo, type EstadoAutomatico } from "../../lib/respaldoApi";
import Alert from "../../ui/Alert";
import Button from "../../ui/Button";
import Field from "../../ui/Field";
import { useToast } from "../../ui/Toast";

const fecha = (iso: string) => new Date(iso).toLocaleString("es-CR", { dateStyle: "medium", timeStyle: "short" });

export default function RespaldoAutomatico() {
  const { actor } = useSesion();
  const toast = useToast();
  const [e, setE] = useState<EstadoAutomatico | null>(null);
  const [c1, setC1] = useState("");
  const [c2, setC2] = useState("");
  const [pin, setPin] = useState("");
  const [entendido, setEntendido] = useState(false);
  const [cambiar, setCambiar] = useState(false);
  const [cantidad, setCantidad] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const cargar = () =>
    estadoAutomatico().then(
      (x) => (setE(x), setCantidad(String(x.cantidad))),
      (err) => setError(textoError(err)),
    );
  useEffect(() => void cargar(), []);

  async function hacer(f: () => Promise<unknown>, ok: string) {
    setError("");
    setOcupado(true);
    try {
      await f();
      toast.ok(ok);
      await cargar();
    } catch (err) {
      setError(textoError(err));
    } finally {
      setOcupado(false);
    }
  }

  if (!e) return <Mensaje error={error} />;
  const formulario = !e.configurado || cambiar;
  return (
    <section className="card login-card">
      <h2>Respaldo automático</h2>
      {e.configurado ? (
        <>
          {e.ultimo ? (
            <Alert tono={e.ultimoVerificado ? "ok" : "error"} titulo={e.ultimoVerificado ? "Último respaldo verificado" : "El último respaldo no se pudo verificar"}>
              {fecha(e.ultimo)}. Se hace uno al día y otro al cerrar cada turno; quedan los últimos {e.cantidad}.
              {!e.ultimoVerificado && " Haga uno ahora; si se repite, avise al técnico."}
            </Alert>
          ) : (
            <Alert tono="info">Todavía no se ha hecho ninguno. El primero se hace solo en unos minutos, o pulse «Hacer uno ahora».</Alert>
          )}
          <p className="muted">
            Carpeta: <span className="mono" style={{ wordBreak: "break-all" }}>{e.carpeta}</span>
          </p>
          <div className="row">
            <Button icono={DatabaseBackup} disabled={ocupado} onClick={() => hacer(respaldoAhora, "Respaldo hecho y verificado.")}>
              Hacer uno ahora
            </Button>
            <Button icono={Usb} disabled={ocupado} onClick={() => hacer(usbConfirmado, "Anotado. Se lo recordamos de nuevo en una semana.")}>
              Ya copié los respaldos a la USB
            </Button>
          </div>
          <Field label="Cuántos respaldos automáticos conservar" ayuda="Los más viejos se borran solos. Los que haga a mano no se tocan.">
            <input
              className="small"
              inputMode="numeric"
              value={cantidad}
              onChange={(x) => setCantidad(x.target.value.replace(/\D/g, ""))}
              onBlur={() => Number(cantidad) !== e.cantidad && void hacer(() => guardarConfig(actor, "respaldo_auto_cantidad", Number(cantidad)), "Guardado.")}
            />
          </Field>
          {!cambiar && (
            <Button variante="fantasma" onClick={() => setCambiar(true)}>
              Cambiar la contraseña
            </Button>
          )}
        </>
      ) : (
        <Alert tono="aviso" titulo="Sin respaldo automático">
          Elija una contraseña para que el programa se respalde solo todos los días.
        </Alert>
      )}
      {formulario && (
        <form
          onSubmit={(x) => {
            x.preventDefault();
            void hacer(async () => {
              validarContrasenaRespaldo(c1, c2);
              await configurarAutomatico(c1, pin);
              setC1("");
              setC2("");
              setPin("");
              setCambiar(false);
            }, "Respaldo automático listo.");
          }}
        >
          <p className="note">{AVISO_RESPALDO} Anote esta contraseña fuera de la computadora: sin ella, ni usted ni el técnico pueden abrir los respaldos.</p>
          <Field label={`Contraseña (mínimo ${CONTRASENA_MINIMA} caracteres)`}>
            <input type="password" autoComplete="new-password" value={c1} onChange={(x) => setC1(x.target.value)} />
          </Field>
          <Field label="Repita la contraseña">
            <input type="password" autoComplete="new-password" value={c2} onChange={(x) => setC2(x.target.value)} />
          </Field>
          <Field label="Su PIN de dueño">
            <input className="pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(x) => setPin(x.target.value.replace(/\D/g, ""))} />
          </Field>
          <label className="consentimiento">
            <input type="checkbox" checked={entendido} onChange={(x) => setEntendido(x.target.checked)} /> Anoté la contraseña en un lugar seguro y entiendo que sin ella los respaldos no se
            pueden abrir
          </label>
          <Button type="submit" variante="primario" icono={CheckCircle2} disabled={ocupado || !entendido || c1.length < CONTRASENA_MINIMA || !pin}>
            Activar respaldo automático
          </Button>
        </form>
      )}
      <Mensaje error={error} />
    </section>
  );
}
