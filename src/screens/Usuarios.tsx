import { KeyRound, Pencil, Power, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import Modal from "../components/Modal";
import Mensaje, { textoError } from "../components/Mensaje";
import { cambiarPin, crearUsuario, editarUsuario, eliminarUsuario, listarUsuarios, pinMinimo } from "../db/usuarios";
import { rolesAdministrables } from "../lib/permisos";
import { ROL_NOMBRE, type Rol, type Usuario } from "../tipos";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import { useConfirmar } from "../ui/Confirmar";
import { useEnvio as useEnvioGeneral } from "../ui/useEnvio";

type Dialogo = { tipo: "nuevo" } | { tipo: "pin"; usuario: Usuario } | { tipo: "nombre"; usuario: Usuario } | null;

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
            await crearUsuario(actor, d);
            await cargar();
          }}
        />
      )}
      {dialogo?.tipo === "pin" && (
        <CambiarPin usuario={dialogo.usuario} onCerrar={() => setDialogo(null)} onGuardar={(pin) => cambiarPin(actor, dialogo.usuario.id, pin)} />
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
  const { error, ocupado, enviar } = useEnvio(p.onCerrar);
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
          <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </label>
        <Mensaje error={error} />
        <button className="primary" disabled={ocupado}>
          Crear
        </button>
      </form>
    </Modal>
  );
}

function CambiarPin(p: { usuario: Usuario; onCerrar(): void; onGuardar(pin: string): Promise<void> }) {
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const { error, ocupado, enviar } = useEnvio(p.onCerrar);
  return (
    <Modal titulo={`PIN de ${p.usuario.nombre}`} onCerrar={p.onCerrar}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void enviar(async () => {
            if (pin !== pin2) throw new Error("Los PIN no coinciden");
            await p.onGuardar(pin);
          });
        }}
      >
        <label className="campo">
          PIN nuevo ({pinMinimo(p.usuario.rol)} a 12 números)
          <input autoFocus type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </label>
        <label className="campo">
          Repita el PIN
          <input type="password" inputMode="numeric" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))} />
        </label>
        <Mensaje error={error} />
        <button className="primary" disabled={ocupado}>
          Guardar PIN
        </button>
      </form>
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
