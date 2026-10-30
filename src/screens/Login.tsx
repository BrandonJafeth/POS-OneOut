import { ArrowLeft, LogIn, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { textoError } from "../components/Mensaje";
import { iniciarSesion, iniciarSesionTecnico, usuariosParaEntrar } from "../db/usuarios";
import { formatoEspera, INTENTOS_LIBRES } from "../lib/bloqueo";
import { ROL_NOMBRE, type Usuario } from "../tipos";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Field from "../ui/Field";

// Entrada discreta del técnico: no aparece en ningún menú.
const ATAJO_TECNICO = (e: KeyboardEvent) => e.ctrlKey && e.altKey && e.key.toLowerCase() === "t";
const TECNICO = "__tecnico";

type Elegible = Pick<Usuario, "id" | "nombre" | "rol">;

export default function Login({ nombreNegocio, onEntrar }: { nombreNegocio: string; onEntrar(u: Usuario, minutosInactividad: number): void }) {
  const [usuarios, setUsuarios] = useState<Elegible[]>([]);
  const [elegido, setElegido] = useState<Elegible | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);
  const primero = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    usuariosParaEntrar().then(setUsuarios, (e) => setError(textoError(e)));
  }, []);
  useEffect(() => {
    if (!elegido) primero.current?.focus();
  }, [usuarios, elegido]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!ATAJO_TECNICO(e)) return;
      e.preventDefault();
      elegir({ id: TECNICO, nombre: "Técnico", rol: "tecnico" });
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  function elegir(u: Elegible | null) {
    setElegido(u);
    setPin("");
    setError("");
    setTimeout(() => pinRef.current?.focus(), 0);
  }

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    if (!elegido || !pin) return;
    setOcupado(true);
    setError("");
    try {
      const r = elegido.id === TECNICO ? await iniciarSesionTecnico(pin) : await iniciarSesion(elegido.id, pin);
      if (r.ok) return onEntrar(r.usuario, r.minutosInactividad);
      setPin("");
      // Rust responde igual si el usuario no existe: no se dice cuál de las dos cosas falló.
      if (r.esperaMs) setError(`PIN incorrecto o demasiados intentos. Espere ${formatoEspera(r.esperaMs)} y vuelva a intentar.`);
      else if (r.intentos) setError(`PIN incorrecto. Revise y vuelva a escribirlo (intento ${r.intentos} de ${INTENTOS_LIBRES} antes de tener que esperar).`);
      else setError("PIN incorrecto.");
    } catch (err) {
      setError(textoError(err));
    } finally {
      setOcupado(false);
      pinRef.current?.focus();
    }
  }

  return (
    <main className="centro">
      <div className="card login-card">
        <h1>{nombreNegocio || "Punto de venta"}</h1>
        {!elegido ? (
          <>
            <p className="muted">¿Quién está en la caja?</p>
            {usuarios.length === 0 && <Alert tono="aviso">Todavía no hay usuarios. Pida al técnico que los cree.</Alert>}
            <div className="usuarios-grid">
              {usuarios.map((u, i) => (
                <button key={u.id} ref={i === 0 ? primero : undefined} className="usuario-btn" onClick={() => elegir(u)}>
                  <UserRound size={24} aria-hidden />
                  <strong>{u.nombre}</strong>
                  <span>{ROL_NOMBRE[u.rol]}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <form onSubmit={entrar}>
            <p className="big">
              <strong>{elegido.nombre}</strong> <span className="muted">· {ROL_NOMBRE[elegido.rol]}</span>
            </p>
            <Field label="PIN">
              <input
                ref={pinRef}
                className="pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            {error && <Alert tono="error">{error}</Alert>}
            <div className="fila-botones">
              <Button icono={ArrowLeft} onClick={() => elegir(null)}>
                Cambiar usuario
              </Button>
              <span className="separador" />
              <Button type="submit" variante="primario" tamano="lg" icono={LogIn} atajo="Enter" disabled={ocupado || !pin}>
                Entrar
              </Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
