import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import { crearDepartamento, editarDepartamento, listarDepartamentos, moverDepartamento } from "../db/departamentos";
import type { Departamento } from "../tipos";

/** Lista editable. El dueño cambia nombre, orden y activo; el técnico además crea y cambia códigos. */
export default function Departamentos({ embebido = false }: { embebido?: boolean }) {
  const { actor, puede } = useSesion();
  const estructura = puede("departamentos.estructura");
  const [lista, setLista] = useState<Departamento[]>([]);
  const [edicion, setEdicion] = useState<Record<string, { codigo: string; nombre: string }>>({});
  const [nuevo, setNuevo] = useState({ codigo: "", nombre: "" });
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const cargar = async () => {
    const l = await listarDepartamentos({ incluirInactivos: true });
    setLista(l);
    setEdicion(Object.fromEntries(l.map((d) => [d.id, { codigo: d.codigo, nombre: d.nombre }])));
  };
  useEffect(() => void cargar().catch((e) => setError(textoError(e))), []);

  async function hacer(f: () => Promise<unknown>, mensaje = "") {
    setError("");
    setOk("");
    try {
      await f();
      await cargar();
      setOk(mensaje);
    } catch (e) {
      setError(textoError(e));
    }
  }

  return (
    <div className="screen">
      {!embebido && <h1>Departamentos</h1>}
      <Mensaje error={error} ok={ok} />
      <section className="card">
        <table className="tbl tbl-grande">
          <thead>
            <tr>
              <th>Código</th>
              <th>Nombre</th>
              <th>Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lista.map((d, i) => {
              const e = edicion[d.id] ?? d;
              const sucio = e.codigo !== d.codigo || e.nombre !== d.nombre;
              const set = (patch: Partial<typeof e>) => setEdicion({ ...edicion, [d.id]: { ...e, ...patch } });
              return (
                <tr key={d.id} className={d.activo ? "" : "inactivo"}>
                  <td>
                    <input className="small" aria-label={`Código de ${d.nombre}`} value={e.codigo} disabled={!estructura} onChange={(x) => set({ codigo: x.target.value })} />
                  </td>
                  <td>
                    <input aria-label={`Nombre de ${d.nombre}`} value={e.nombre} onChange={(x) => set({ nombre: x.target.value })} />
                  </td>
                  <td>{d.activo ? "Activo" : "Inactivo"}</td>
                  <td className="acciones">
                    {sucio && (
                      <button className="primary" onClick={() => hacer(() => editarDepartamento(actor, d.id, e), "Guardado.")}>
                        Guardar
                      </button>
                    )}
                    <button disabled={i === 0} onClick={() => hacer(() => moverDepartamento(actor, d.id, -1))} aria-label="Subir">
                      ↑
                    </button>
                    <button disabled={i === lista.length - 1} onClick={() => hacer(() => moverDepartamento(actor, d.id, 1))} aria-label="Bajar">
                      ↓
                    </button>
                    <button onClick={() => hacer(() => editarDepartamento(actor, d.id, { activo: !d.activo }))}>
                      {d.activo ? "Desactivar" : "Activar"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      {estructura && (
        <section className="card">
          <h2>Nuevo departamento</h2>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void hacer(async () => {
                await crearDepartamento(actor, nuevo);
                setNuevo({ codigo: "", nombre: "" });
              }, "Departamento creado.");
            }}
          >
            <label className="campo">
              Código
              <input className="small" value={nuevo.codigo} onChange={(e) => setNuevo({ ...nuevo, codigo: e.target.value })} />
            </label>
            <label className="campo">
              Nombre
              <input value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} />
            </label>
            <button className="primary">Crear departamento</button>
          </form>
        </section>
      )}
    </div>
  );
}
