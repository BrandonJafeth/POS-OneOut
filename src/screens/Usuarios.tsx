import { KeyRound, Pencil, Power, Printer, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import Modal from "../components/Modal";
import Mensaje, { textoError } from "../components/Mensaje";
import { cambiarPin, crearUsuario, editarUsuario, eliminarUsuario, listarUsuarios, nuevoCodigoRecuperacion, pinMinimo } from "../db/usuarios";
import { imprimirRecuperacion } from "../lib/caja/imprimir";
import { rolesAdministrables } from "../lib/permisos";
import { ROL_NOMBRE, type Rol, type Usuario } from "../tipos";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import { useConfirmar } from "../ui/Confirmar";
import { useEnvio as useEnvioGeneral } from "../ui/useEnvio";

type Dialogo =
  | { tipo: "nuevo" }
  | { tipo: "pin"; usuario: Usuario }
  | { tipo: "nombre"; usuario: Usuario }
  | { tipo: "codigo"; nombre: string; codigo: string }
  | { tipo: "nuevoCodigo" }
  | null;

export default function Usuarios() {
  const { actor, usuario: yo } = useSesion();
  const confirmar = useConfirmar();
  const [lista, setLista] = useState<Usuario[] | null>(null);
  const [dialogo, setDialogo] = useState<Dialogo>(null);
  const [error, setError] = useState("");
  const roles = rolesAdministrables(actor.rol);

  const cargar = () => listarUsuarios().then(setLista, (e) => setError(textoError(e)));
  useEffect(() => void cargar(), []);

  const administrable = (u: Usuario) => u.id === yo.id || roles.includes(u.rol);

  async function accion(f: () => Promise<void>) {
    setError("");
    try {
      await f();
      await cargar();
    } catch (e) {
      setError(textoError(e));
    }
  }

  return (
    <div className="screen">
      <div className="row between">
        <h1>Usuarios</h1>
        <Button variante="primario" icono={UserPlus} onClick={() => setDialogo({ tipo: "nuevo" })}>
          Nuevo usuario
        </Button>
      </div>
      <Mensaje error={error} />
      <section className="card">
        <table className="tbl tbl-grande">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Rol</th>
              <th>Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!lista && !error && (
              <tr>
                <td colSpan={4} className="muted" aria-live="polite">
                  Cargando usuarios…
                </td>
              </tr>
            )}
            {lista?.map((u) => (
              <tr key={u.id} className={u.activo ? "" : "inactivo"}>
                <td>
                  {u.nombre} {u.id === yo.id && <span className="muted">(usted)</span>}
                </td>
                <td>{ROL_NOMBRE[u.rol]}</td>
                <td>{u.activo ? <Badge tono="ok">Activo</Badge> : <Badge tono="aviso">Inactivo</Badge>}</td>
                <td className="acciones">
                  {administrable(u) && (
                    <>
                      <Button icono={Pencil} title="Renombrar" onClick={() => setDialogo({ tipo: "nombre", usuario: u })}>
                        Renombrar
                      </Button>
                      <Button icono={KeyRound} title="Cambiar PIN" onClick={() => setDialogo({ tipo: "pin", usuario: u })}>
                        Cambiar PIN
                      </Button>
                      {u.id === yo.id && u.rol === "dueno" && (
                        <Button icono={ShieldCheck} title="Código de recuperación nuevo" onClick={() => setDialogo({ tipo: "nuevoCodigo" })}>
                          Código de recuperación
                        </Button>
                      )}
                      {u.id !== yo.id && (
                        <>
                          <Button icono={Power} title={u.activo ? "Desactivar" : "Activar"} onClick={() => accion(() => editarUsuario(actor, u.id, { activo: !u.activo }))}>
                            {u.activo ? "Desactivar" : "Activar"}
                          </Button>
                          <Button
                            variante="peligro"
                            icono={Trash2}
                            title="Eliminar"
                            onClick={async () =>
                              (await confirmar({ titulo: `¿Eliminar a ${u.nombre}?`, texto: "Ya no podrá entrar. Sus ventas quedan registradas.", aceptar: "Eliminar usuario", peligro: true })) &&
                              accion(() => eliminarUsuario(actor, u.id))
                            }
                          >
                            Eliminar
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {dialogo?.tipo === "nuevo" && (
        <NuevoUsuario
          roles={roles}
          onCerrar={() => setDialogo(null)}
          onGuardar={async (d) => {
            const u = await crearUsuario(actor, d);
            await cargar();
            setDialogo(u.codigoRecuperacion ? { tipo: "codigo", nombre: u.nombre, codigo: u.codigoRecuperacion } : null);
          }}
        />
      )}
      {dialogo?.tipo === "pin" && (
        <CambiarPin
          usuario={dialogo.usuario}
          propio={dialogo.usuario.id === yo.id}
          onCerrar={() => setDialogo(null)}
          onGuardar={async (pin, extra) => {
            const nuevo = await cambiarPin(actor, dialogo.usuario.id, pin, extra);
            setDialogo(nuevo ? { tipo: "codigo", nombre: dialogo.usuario.nombre, codigo: nuevo } : null);
          }}
        />
      )}
      {dialogo?.tipo === "codigo" && <CodigoRecuperacion nombre={dialogo.nombre} codigo={dialogo.codigo} onCerrar={() => setDialogo(null)} />}
      {dialogo?.tipo === "nuevoCodigo" && (
        <PedirPinPropio
          onCerrar={() => setDialogo(null)}
          onGuardar={async (pin) => {
            const codigo = await nuevoCodigoRecuperacion(pin);
            setDialogo({ tipo: "codigo", nombre: yo.nombre, codigo });
          }}
        />
      )}
      {dialogo?.tipo === "nombre" && (
        <Renombrar
          usuario={dialogo.usuario}
          onCerrar={() => setDialogo(null)}
          onGuardar={async (nombre) => {
            await editarUsuario(actor, dialogo.usuario.id, { nombre });
            await cargar();
          }}
        />
      )}
    </div>
  );
}

/** El envío general (un clic a la vez: doble Enter no crea dos usuarios) y, si salió bien, cierra. */
function useEnvio(onCerrar: () => void) {
  const { error, ocupado, enviar } = useEnvioGeneral();
  return { error, ocupado, enviar: async (f: () => Promise<void>) => void ((await enviar(f)) && onCerrar()) };
}

function NuevoUsuario(p: { roles: Rol[]; onCerrar(): void; onGuardar(d: { nombre: string; rol: Rol; pin: string }): Promise<void> }) {
  const [nombre, setNombre] = useState("");
  const [rol, setRol] = useState<Rol>(p.roles[p.roles.length - 1] ?? "cajero");
  const [pin, setPin] = useState("");
  // No se cierra solo: si es un dueño, arriba se abre el diálogo con su código de recuperación.
  const { error, ocupado, enviar } = useEnvioGeneral();
  return (
    <Modal titulo="Nuevo usuario" onCerrar={p.onCerrar}>
      <form onSubmit={(e) => (e.preventDefault(), enviar(() => p.onGuardar({ nombre, rol, pin })))}>
        <label className="campo">
          Nombre
          <input autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} />
        </label>
        {p.roles.length > 1 && (
          <label className="campo">
            Rol
            <select value={rol} onChange={(e) => setRol(e.target.value as Rol)}>
              {p.roles.map((r) => (
                <option key={r} value={r}>
                  {ROL_NOMBRE[r]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="campo">
          PIN ({pinMinimo(rol)} a 12 números; la persona lo cambia al entrar)
          <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </label>
        <Mensaje error={error} />
        <button className="primary" disabled={ocupado}>
          Crear
        </button>
      </form>
    </Modal>
  );
}

/**
 * Cambiar un PIN. El propio pide el actual (D2). El de otro dueño, su código de recuperación (D1):
 * sin él solo se puede en la instalación, mientras ningún dueño tenga su PIN.
 */
function CambiarPin(p: { usuario: Usuario; propio: boolean; onCerrar(): void; onGuardar(pin: string, extra: { actual?: string; codigo?: string }): Promise<void> }) {
  const [actual, setActual] = useState("");
  const [codigo, setCodigo] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  // No cierra solo: si se generó un código nuevo, la pantalla de arriba muestra ese diálogo.
  const { error, ocupado, enviar } = useEnvioGeneral();
  const duenoAjeno = p.usuario.rol === "dueno" && !p.propio;
  return (
    <Modal titulo={`PIN de ${p.usuario.nombre}`} onCerrar={p.onCerrar}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void enviar(async () => {
            if (pin !== pin2) throw new Error("Los PIN no coinciden");
            await p.onGuardar(pin, { actual: p.propio ? actual : undefined, codigo: duenoAjeno ? codigo : undefined });
          });
        }}
      >
        {p.propio && (
          <label className="campo">
            PIN actual
            <input autoFocus type="password" inputMode="numeric" autoComplete="off" value={actual} onChange={(e) => setActual(e.target.value.replace(/\D/g, ""))} />
          </label>
        )}
        {duenoAjeno && (
          <label className="campo">
            Código de recuperación (el del sobre)
            <input autoFocus autoComplete="off" spellCheck={false} value={codigo} onChange={(e) => setCodigo(e.target.value.toUpperCase())} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" />
          </label>
        )}
        <label className="campo">
          PIN nuevo ({pinMinimo(p.usuario.rol)} a 12 números)
          <input autoFocus={!p.propio && !duenoAjeno} type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </label>
        <label className="campo">
          Repita el PIN
          <input type="password" inputMode="numeric" autoComplete="off" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))} />
        </label>
        {duenoAjeno && <p className="muted">Al entrar, {p.usuario.nombre} tendrá que cambiarlo. El código usado deja de servir y sale uno nuevo para guardar.</p>}
        <Mensaje error={error} />
        <button className="primary" disabled={ocupado}>
          Guardar PIN
        </button>
      </form>
    </Modal>
  );
}

/** El dueño pone su PIN para hacerse un código nuevo. */
function PedirPinPropio(p: { onCerrar(): void; onGuardar(pin: string): Promise<void> }) {
  const [pin, setPin] = useState("");
  const { error, ocupado, enviar } = useEnvioGeneral();
  return (
    <Modal titulo="Código de recuperación nuevo" onCerrar={p.onCerrar}>
      <form onSubmit={(e) => (e.preventDefault(), void enviar(() => p.onGuardar(pin)))}>
        <p>El código anterior deja de servir. Tenga a mano la impresora para guardar el nuevo.</p>
        <label className="campo">
          Su PIN
          <input autoFocus type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </label>
        <Mensaje error={error} />
        <button className="primary" disabled={ocupado}>
          Generar código
        </button>
      </form>
    </Modal>
  );
}

/** Se muestra una sola vez: se imprime y se guarda en un sobre (en la base queda solo su hash). */
function CodigoRecuperacion(p: { nombre: string; codigo: string; onCerrar(): void }) {
  const confirmar = useConfirmar();
  const { error, ocupado, enviar } = useEnvioGeneral();
  const [impreso, setImpreso] = useState(false);
  async function cerrar() {
    if (!impreso && !(await confirmar({ titulo: "¿Ya lo guardó?", texto: "Este código no se vuelve a mostrar. Sin él, un PIN olvidado del dueño solo se recupera restaurando un respaldo.", aceptar: "Sí, ya lo anoté", peligro: true }))) return;
    p.onCerrar();
  }
  return (
    <Modal titulo={`Código de recuperación de ${p.nombre}`} onCerrar={() => void cerrar()}>
      <p>Imprímalo y guárdelo en un sobre cerrado, fuera de la caja. Sirve para restablecer el PIN de {p.nombre} si lo olvida.</p>
      <p className="codigo-recuperacion" aria-label="Código de recuperación">
        <strong>{p.codigo}</strong>
      </p>
      <Mensaje error={error} />
      <div className="fila-botones">
        <Button icono={Printer} disabled={ocupado} onClick={() => void enviar(() => imprimirRecuperacion(p.nombre, p.codigo)).then((ok) => ok && setImpreso(true))}>
          Imprimir
        </Button>
        <span className="separador" />
        <Button variante="primario" onClick={() => void cerrar()}>
          Listo
        </Button>
      </div>
    </Modal>
  );
}

function Renombrar(p: { usuario: Usuario; onCerrar(): void; onGuardar(nombre: string): Promise<void> }) {
  const [nombre, setNombre] = useState(p.usuario.nombre);
  const { error, ocupado, enviar } = useEnvio(p.onCerrar);
  return (
    <Modal titulo="Renombrar usuario" onCerrar={p.onCerrar}>
      <form onSubmit={(e) => (e.preventDefault(), enviar(() => p.onGuardar(nombre)))}>
        <label className="campo">
          Nombre
          <input autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} />
        </label>
        <Mensaje error={error} />
        <button className="primary" disabled={ocupado}>
          Guardar
        </button>
      </form>
    </Modal>
  );
}
