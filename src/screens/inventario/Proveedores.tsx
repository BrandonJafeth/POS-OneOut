// Proveedores: nombre, teléfono y notas. Si es una persona física, solo lo mínimo (Ley 8968).
import { Plus, Save, Trash2, Truck } from "lucide-react";
import { useEffect, useState } from "react";
import Mensaje, { textoError } from "../../components/Mensaje";
import Modal from "../../components/Modal";
import { eliminarProveedor, guardarProveedor, listarProveedores, type Proveedor } from "../../db/inventario";
import Button from "../../ui/Button";
import { useConfirmar } from "../../ui/Confirmar";
import EmptyState from "../../ui/EmptyState";
import Field from "../../ui/Field";

const VACIO: Proveedor = { id: "", nombre: "", telefono: "", notas: "" };

export default function Proveedores() {
  const confirmar = useConfirmar();
  const [lista, setLista] = useState<Proveedor[]>([]);
  const [editando, setEditando] = useState<Proveedor | null>(null);
  const [error, setError] = useState("");
  const cargar = () => listarProveedores().then(setLista, (e) => setError(textoError(e)));
  useEffect(() => void cargar(), []);
  return (
    <section className="card">
      <Button variante="primario" icono={Plus} onClick={() => setEditando(VACIO)}>
        Nuevo proveedor
      </Button>
      <Mensaje error={error} />
      {lista.length === 0 ? (
        <EmptyState icono={Truck} titulo="Sin proveedores" texto="Son opcionales en la entrada de mercadería." />
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Teléfono</th>
              <th>Notas</th>
              <th>
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lista.map((p) => (
              <tr key={p.id}>
                <td>{p.nombre}</td>
                <td>{p.telefono}</td>
                <td>{p.notas}</td>
                <td>
                  <div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>
                    <Button onClick={() => setEditando(p)} aria-label={`Editar ${p.nombre}`}>
                      Editar
                    </Button>
                    <Button
                      variante="peligro"
                      icono={Trash2}
                      aria-label={`Eliminar ${p.nombre}`}
                      onClick={async () => {
                        if (!(await confirmar({ titulo: `¿Eliminar ${p.nombre}?`, texto: "Las entradas ya registradas lo conservan.", aceptar: "Eliminar", peligro: true }))) return;
                        await eliminarProveedor(p.id).then(cargar, (e) => setError(textoError(e)));
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editando && (
        <Editor
          inicial={editando}
          onCerrar={() => setEditando(null)}
          onGuardar={async (p) => {
            await guardarProveedor(p);
            setEditando(null);
            await cargar();
          }}
        />
      )}
    </section>
  );
}

function Editor(p: { inicial: Proveedor; onCerrar(): void; onGuardar(p: Proveedor): Promise<void> }) {
  const [v, setV] = useState(p.inicial);
  const [error, setError] = useState("");
  return (
    <Modal titulo={p.inicial.id ? "Editar proveedor" : "Nuevo proveedor"} onCerrar={p.onCerrar} ancho={460}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await p.onGuardar(v);
          } catch (err) {
            setError(textoError(err));
          }
        }}
      >
        <Field label="Nombre">
          <input autoFocus maxLength={100} value={v.nombre} onChange={(e) => setV({ ...v, nombre: e.target.value })} />
        </Field>
        <Field label="Teléfono (opcional)">
          <input maxLength={30} value={v.telefono} onChange={(e) => setV({ ...v, telefono: e.target.value })} />
        </Field>
        <Field label="Notas (opcional)" ayuda="Si es una persona, no anote más datos de los necesarios.">
          <input maxLength={300} value={v.notas} onChange={(e) => setV({ ...v, notas: e.target.value })} />
        </Field>
        <Mensaje error={error} />
        <Button type="submit" variante="primario" icono={Save} disabled={!v.nombre.trim()}>
          Guardar
        </Button>
      </form>
    </Modal>
  );
}
