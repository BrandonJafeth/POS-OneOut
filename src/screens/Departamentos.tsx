import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import { guardarConfig } from "../db/config";
import { colorDepartamento, crearDepartamento, editarDepartamento, listarDepartamentos, moverDepartamento } from "../db/departamentos";
import type { Departamento } from "../tipos";
import { colorDe, esColor, PALETA_DEPARTAMENTOS, textoSobre } from "../ui/departamentos";
import { useToast } from "../ui/Toast";
import { useEnvio } from "../ui/useEnvio";

/** Color de la píldora: los 12 de la paleta o uno propio. El texto (blanco o negro) se elige solo. */
function ColorDepto(p: { d: Departamento; posicion: number; onCambio(c: string | null): void }) {
  const actual = colorDe(p.d, p.posicion);
  const dePaleta = PALETA_DEPARTAMENTOS.find((x) => x.color === actual);
  return (
    <div className="depto-color">
      <span className="depto-muestra" style={{ background: actual, color: textoSobre(actual) }}>
        {p.d.nombre}
      </span>
      <select aria-label={`Color de ${p.d.nombre}`} value={dePaleta ? actual : "propio"} onChange={(e) => e.target.value !== "propio" && p.onCambio(e.target.value)}>
        {PALETA_DEPARTAMENTOS.map((x) => (
          <option key={x.color} value={x.color}>
            {x.nombre}
          </option>
        ))}
        <option value="propio">Otro color…</option>
      </select>
      <input type="color" aria-label={`Elegir otro color para ${p.d.nombre}`} value={actual} onChange={(e) => p.onCambio(e.target.value)} />
    </div>
  );
}

/** Cómo se ven las píldoras en la venta: cada departamento con su color, todos de un color o sin color. */
function ModoColores(p: { modo: string; onCambio(m: string): Promise<void> }) {
  const unico = esColor(p.modo) ? p.modo.toLowerCase() : null;
  const [color, setColor] = useState(unico ?? PALETA_DEPARTAMENTOS[0].color);
  const dePaleta = PALETA_DEPARTAMENTOS.find((x) => x.color === color);
  const opcion = (valor: string, titulo: string, ayuda: string) => (
    <label className={`opcion ${(valor === "uno" ? !!unico : p.modo === valor) ? "elegida" : ""}`}>
      <input type="radio" name="modo-color" checked={valor === "uno" ? !!unico : p.modo === valor} onChange={() => void p.onCambio(valor === "uno" ? color : valor)} />
      <span>
        <strong>{titulo}</strong>
        <span className="ayuda">{ayuda}</span>
      </span>
    </label>
  );
  return (
    <section className="card">
      <h2>Colores en la venta</h2>
      <fieldset className="opciones-modo">
        <legend className="sr-only">Colores de los departamentos</legend>
        {opcion("cada_uno", "Cada departamento con su color", "Se elige abajo, en cada fila.")}
        {opcion("uno", "Todos del mismo color", "El departamento elegido se marca con borde y ✓.")}
        {opcion("ninguno", "Sin color", "Píldoras sencillas, del color del tema.")}
      </fieldset>
      {unico && (
        <div className="depto-color">
          <span className="depto-muestra" style={{ background: color, color: textoSobre(color) }}>
            Departamento
          </span>
          <select aria-label="Color de todos los departamentos" value={dePaleta ? color : "propio"} onChange={(e) => e.target.value !== "propio" && (setColor(e.target.value), void p.onCambio(e.target.value))}>
            {PALETA_DEPARTAMENTOS.map((x) => (
              <option key={x.color} value={x.color}>
                {x.nombre}
              </option>
            ))}
            <option value="propio">Otro color…</option>
          </select>
          <input type="color" aria-label="Elegir otro color para todos" value={color} onChange={(e) => (setColor(e.target.value), void p.onCambio(e.target.value))} />
        </div>
      )}
    </section>
  );
}

/** Lista editable. El dueño cambia nombre, orden, color y activo; el técnico además crea y cambia códigos. */
export default function Departamentos({ embebido = false }: { embebido?: boolean }) {
  const { actor, puede, config, recargarConfig } = useSesion();
  const cadaUno = !esColor(config.departamentos_color) && config.departamentos_color !== "ninguno";
  const estructura = puede("departamentos.estructura");
  const [lista, setLista] = useState<Departamento[]>([]);
  const [edicion, setEdicion] = useState<Record<string, { codigo: string; nombre: string }>>({});
  const [nuevo, setNuevo] = useState({ codigo: "", nombre: "" });
  const [error, setError] = useState("");
  const toast = useToast();

  const cargar = async () => {
    const l = await listarDepartamentos({ incluirInactivos: true });
    setLista(l);
    setEdicion(Object.fromEntries(l.map((d) => [d.id, { codigo: d.codigo, nombre: d.nombre }])));
  };
  useEffect(() => void cargar().catch((e) => setError(textoError(e))), []);

  async function hacer(f: () => Promise<unknown>, mensaje = "") {
    setError("");
    try {
      await f();
      await cargar();
      toast.ok(mensaje);
    } catch (e) {
      setError(textoError(e));
    }
  }
  // Crear va con candado: un doble clic no crea dos. (Colores no: el selector manda muchos cambios
  // seguidos y con candado se perdería el último.)
  const envio = useEnvio();

  return (
    <div className="screen">
      {!embebido && <h1>Departamentos</h1>}
      <Mensaje error={error} />
      <ModoColores
        modo={config.departamentos_color}
        onCambio={(m) => hacer(async () => (await guardarConfig(actor, "departamentos_color", m), await recargarConfig()), "Colores guardados.")}
      />
      <section className="card">
        <table className="tbl tbl-grande">
          <thead>
            <tr>
              <th>Código</th>
              <th>Nombre</th>
              {cadaUno && <th>Color en la venta</th>}
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
                  {cadaUno && (
                    <td>
                      <ColorDepto d={d} posicion={i} onCambio={(c) => void hacer(() => colorDepartamento(actor, d.id, c), "Color guardado.")} />
                    </td>
                  )}
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
              void envio.enviar(() =>
                hacer(async () => {
                  await crearDepartamento(actor, nuevo);
                  setNuevo({ codigo: "", nombre: "" });
                }, "Departamento creado."),
              );
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
            <button className="primary" disabled={envio.ocupado}>
              Crear departamento
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
