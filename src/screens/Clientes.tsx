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
import Paginacion from "../ui/Paginacion";
import DatosCliente from "./clientes/DatosCliente";
import { plural } from "../lib/texto";
import NuevoCliente from "./clientes/NuevoCliente";

const POR_PAGINA = 50;

export default function Clientes() {
  const { actor, config } = useSesion();
  const [texto, setTexto] = useState("");
  const [lista, setLista] = useState<Cliente[] | null>(null); // null: todavía cargando
  const [sugeridos, setSugeridos] = useState<ClienteBasico[]>([]);
  const [abierto, setAbierto] = useState<{ id: string; retencion?: boolean } | null>(null);
  const [nuevo, setNuevo] = useState(false);
  const [error, setError] = useState("");
  const [pagina, setPagina] = useState(1);

  // La búsqueda la hace Rust sobre todos; aquí solo se parte en páginas.
  const cargar = () => listarClientes(actor, { texto }).then((l) => (setLista(l), setPagina((n) => Math.min(n, Math.max(1, Math.ceil(l.length / POR_PAGINA))))), (e) => setError(textoError(e)));
  useEffect(() => {
    const t = setTimeout(() => (setPagina(1), void cargar()), 300);
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
        <Alert tono="aviso" titulo={`${plural(sugeridos.length, "cliente", "clientes")} sin movimientos ni saldos en ${config.retencion_clientes_meses} meses`}>
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
        {!lista ? (
          <p className="muted">Cargando…</p>
        ) : lista.length === 0 ? (
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
            {lista.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA).map((c) => (
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
        {lista && <Paginacion nombre="clientes" pagina={pagina} porPagina={POR_PAGINA} total={lista.length} onPagina={setPagina} />}
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
