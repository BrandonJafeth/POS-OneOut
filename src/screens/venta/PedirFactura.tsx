// El cliente vuelve y pide factura de una venta ya cobrada: se elige (o crea) el cliente y la
// venta pasa a "Pendientes de factura". La factura se hace en el otro sistema.
import { FileText, Search, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import Mensaje, { textoError } from "../../components/Mensaje";
import { buscarClientesBasico } from "../../db/clientes";
import { pedirFactura } from "../../db/ventas";
import type { ClienteBasico } from "../../tipos";
import Button from "../../ui/Button";
import Field from "../../ui/Field";
import NuevoCliente from "../clientes/NuevoCliente";

export default function PedirFactura(p: { ventaId: string; numero: string; clienteActual: ClienteBasico | null; onCerrar(): void; onListo(): void }) {
  const { actor } = useSesion();
  const [texto, setTexto] = useState("");
  const [lista, setLista] = useState<ClienteBasico[]>([]);
  const [buscado, setBuscado] = useState(false);
  const [elegido, setElegido] = useState<ClienteBasico | null>(p.clienteActual);
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      if (texto.trim().length < 2) return setLista([]), setBuscado(false);
      buscarClientesBasico(actor, texto).then((l) => (setLista(l), setBuscado(true)), (e) => setError(textoError(e)));
    }, 150);
    return () => clearTimeout(t);
  }, [texto]);

  async function confirmar() {
    if (!elegido) return;
    setOcupado(true);
    setError("");
    try {
      await pedirFactura(actor, p.ventaId, elegido.id);
      p.onListo();
    } catch (e) {
      setError(textoError(e));
      setOcupado(false);
    }
  }

  if (creando) return <NuevoCliente onCerrar={() => setCreando(false)} onCreado={(c) => (setElegido(c), setCreando(false))} />;

  return (
    <Modal
      titulo={`Factura del tiquete ${p.numero}`}
      onCerrar={p.onCerrar}
      ancho={620}
      pie={
        <>
          <Button onClick={p.onCerrar}>Cancelar</Button>
          <span className="separador" />
          <Button variante="primario" icono={FileText} disabled={!elegido || ocupado} onClick={() => void confirmar()}>
            {ocupado ? "Guardando…" : "Dejar pendiente de factura"}
          </Button>
        </>
      }
    >
      <p className="muted">Queda en «Pendientes de factura» con el cliente que elija. La factura se hace en el sistema de facturación.</p>
      {elegido && (
        <div className="cliente-elegido" aria-live="polite">
          <strong>{elegido.nombre}</strong>
          <span className="muted">{elegido.cedula ?? elegido.telefono ?? ""}</span>
        </div>
      )}
      <Field label={elegido ? "Buscar otro cliente" : "Nombre, cédula o teléfono"}>
        <div className="buscador-entrada">
          <Search size={20} aria-hidden />
          <input autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} />
        </div>
      </Field>
      {lista.length > 0 && (
        <div className="lista-clientes" role="listbox" aria-label="Clientes">
          {lista.map((c) => (
            <button key={c.id} type="button" role="option" aria-selected={elegido?.id === c.id} onClick={() => (setElegido(c), setTexto(""))}>
              <strong>{c.nombre}</strong>
              <span className="muted">{[c.cedula, c.telefono].filter(Boolean).join(" · ")}</span>
            </button>
          ))}
        </div>
      )}
      {buscado && lista.length === 0 && <p className="muted">No hay clientes con «{texto}».</p>}
      <Button icono={UserPlus} onClick={() => setCreando(true)}>
        Nuevo cliente
      </Button>
      <Mensaje error={error} />
    </Modal>
  );
}
