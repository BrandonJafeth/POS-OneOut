// Lista de clientes (solo dueño). Cada vez que se abre o filtra queda en bitácora (sin el texto buscado).
import { Search, UserPlus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import { listarClientes, sugerenciasRetencion } from "../db/clientes";
import type { Cliente, ClienteBasico } from "../tipos";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import Field from "../ui/Field";
import FilaClic from "../ui/FilaClic";
import DatosCliente from "./clientes/DatosCliente";
import NuevoCliente from "./clientes/NuevoCliente";

export default function Clientes() {
  const { actor, config } = useSesion();
  const [texto, setTexto] = useState("");
  const [lista, setLista] = useState<Cliente[]>([]);
  const [sugeridos, setSugeridos] = useState<ClienteBasico[]>([]);
  const [abierto, setAbierto] = useState<{ id: string; retencion?: boolean } | null>(null);
  const [nuevo, setNuevo] = useState(false);
  const [error, setError] = useState("");

  const cargar = () => listarClientes(actor, { texto }).then(setLista, (e) => setError(textoError(e)));
  useEffect(() => {
    const t = setTimeout(() => void cargar(), 300);
    return () => clearTimeout(t);
  }, [texto]);
  const cargarSugeridos = () => sugerenciasRetencion(actor, config.retencion_clientes_meses).then(setSugeridos, (e) => setError(textoError(e)));
  useEffect(() => void cargarSugeridos(), [config.retencion_clientes_meses]);

  const recargar = () => {
    void cargar();
    void cargarSugeridos();
  };

  return (
    <div className="screen">
      <div className="encabezado">
        <h1>Clientes</h1>
        <Button variante="primario" icono={UserPlus} onClick={() => setNuevo(true)}>
          Nuevo cliente
        </Button>
      </div>
      <Mensaje error={error} />
      {sugeridos.length > 0 && (
        <Alert tono="aviso" titulo={`${sugeridos.length} cliente(s) sin movimientos ni saldos en ${config.retencion_clientes_meses} meses`}>
          La ley pide no guardar datos más tiempo del necesario. Revise si conviene anonimizarlos (no se hace solo).
          <div className="chips" style={{ marginTop: 8 }}>
            {sugeridos.map((s) => (
              <button key={s.id} onClick={() => setAbierto({ id: s.id, retencion: true })}>
                {s.nombre}
              </button>
            ))}
          </div>
        </Alert>
      )}
      <Field label="Buscar por nombre">
        <div className="buscador-entrada">
          <Search size={20} aria-hidden />
          <input className="grande-venta" style={{ minHeight: 48, fontSize: 17 }} value={texto} onChange={(e) => setTexto(e.target.value)} />
        </div>
      </Field>
      <section className="card">
        {lista.length === 0 ? (
          <EmptyState icono={Users} titulo={texto ? "Ningún cliente coincide" : "Todavía no hay clientes"} texto="Los clientes se crean desde la venta (botón Cliente) o con «Nuevo cliente»." />
        ) : (
        <table className="tbl tbl-grande">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Teléfono</th>
              <th>Correo</th>
              <th>Registrado</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((c) => (
              <FilaClic key={c.id} etiqueta={`Abrir datos de ${c.nombre}`} onAbrir={() => setAbierto({ id: c.id })}>
                <td>{c.nombre}</td>
                <td>{c.telefono}</td>
                <td className="muted">{c.correo}</td>
                <td className="muted">{new Date(c.creadoEn).toLocaleDateString("es-CR")}</td>
              </FilaClic>
            ))}
          </tbody>
        </table>
        )}
      </section>
      {nuevo && (
        <NuevoCliente
          onCerrar={() => setNuevo(false)}
          onCreado={() => {
            setNuevo(false);
            recargar();
          }}
        />
      )}
      {abierto && (
        <DatosCliente
          clienteId={abierto.id}
          motivoSugerido={abierto.retencion ? "retencion" : undefined}
          onCerrar={() => setAbierto(null)}
          onCambio={recargar}
        />
      )}
    </div>
  );
}
