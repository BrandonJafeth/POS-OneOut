// Cliente en la venta: SIEMPRE opcional. Buscar uno existente, crear uno rápido (con
// consentimiento) o solo poner un nombre en el tiquete sin guardar nada.
import { Check, FileText, Search, UserPlus, UserRound, UserX } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import Mensaje, { textoError } from "../../components/Mensaje";
import { buscarClientesBasico } from "../../db/clientes";
import type { ClienteBasico, EstadoEspera } from "../../tipos";
import Button from "../../ui/Button";
import Field from "../../ui/Field";
import FilaClic from "../../ui/FilaClic";
import NuevoCliente from "../clientes/NuevoCliente";

type Cambio = Pick<EstadoEspera, "cliente" | "nombreTiquete" | "requiereFactura">;

export default function ClienteVenta(p: { estado: EstadoEspera; onCambio(c: Cambio): void; onCerrar(): void }) {
  const { actor } = useSesion();
  const [texto, setTexto] = useState("");
  const [lista, setLista] = useState<ClienteBasico[]>([]);
  const [buscado, setBuscado] = useState(false);
  const [nombreTiquete, setNombreTiquete] = useState(p.estado.nombreTiquete ?? "");
  const [requiereFactura, setRequiereFactura] = useState(p.estado.requiereFactura);
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      if (texto.trim().length < 2) return setLista([]), setBuscado(false);
      buscarClientesBasico(actor, texto).then((l) => (setLista(l), setBuscado(true)), (e) => setError(textoError(e)));
    }, 150);
    return () => clearTimeout(t);
  }, [texto]);

  const elegir = (c: ClienteBasico) => p.onCambio({ cliente: c, nombreTiquete: null, requiereFactura });

  if (creando) return <NuevoCliente onCerrar={() => setCreando(false)} onCreado={elegir} />;

  return (
    <Modal titulo="Cliente" onCerrar={p.onCerrar} ancho={680}>
      {p.estado.cliente && (
        <div className="cliente-venta">
          <UserRound size={22} aria-hidden />
          <div style={{ flex: 1 }}>
            <strong>{p.estado.cliente.nombre}</strong>
            <div className="muted">{p.estado.cliente.cedula ?? p.estado.cliente.telefono}</div>
            <label className="check">
              <input
                type="checkbox"
                checked={requiereFactura}
                onChange={(e) => {
                  setRequiereFactura(e.target.checked);
                  p.onCambio({ cliente: p.estado.cliente, nombreTiquete: null, requiereFactura: e.target.checked });
                }}
              />
              <FileText size={18} aria-hidden /> Pide factura electrónica (se hace en el otro sistema)
            </label>
          </div>
          <Button variante="peligro" icono={UserX} onClick={() => p.onCambio({ cliente: null, nombreTiquete: null, requiereFactura: false })}>
            Quitar cliente
          </Button>
        </div>
      )}
            <Field label="Nombre, cédula o teléfono">
        <div className="buscador-entrada">
          <Search size={20} aria-hidden />
          <input autoFocus className="grande-venta" style={{ minHeight: 48, fontSize: 17 }} value={texto} onChange={(e) => setTexto(e.target.value)} />
        </div>
      </Field>
      {lista.length > 0 && (
        <table className="tbl tbl-grande">
          <tbody>
            {lista.map((c) => (
              <FilaClic key={c.id} etiqueta={`Elegir a ${c.nombre}`} onAbrir={() => elegir(c)}>
                <td>{c.nombre}</td>
                <td className="muted">{c.cedula ?? ""}</td>
                <td className="muted">{c.telefono ?? ""}</td>
              </FilaClic>
            ))}
          </tbody>
        </table>
      )}
      {buscado && lista.length === 0 && <p className="muted">No hay clientes con "{texto}". Puede crearlo.</p>}
      <div className="fila-botones">
        <Button icono={UserPlus} onClick={() => setCreando(true)}>
          Nuevo cliente
        </Button>
      </div>
      <h3>Solo nombre en el tiquete</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          p.onCambio({ cliente: null, nombreTiquete: nombreTiquete.trim() || null, requiereFactura: false });
        }}
      >
        <Field label="Nombre para el tiquete" ayuda="No se guarda como cliente.">
          <input value={nombreTiquete} onChange={(e) => setNombreTiquete(e.target.value)} />
        </Field>
        <Button type="submit" icono={Check}>
          Usar este nombre
        </Button>
      </form>
      <Mensaje error={error} />
    </Modal>
  );
}
