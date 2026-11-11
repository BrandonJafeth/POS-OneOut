import { useEffect, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import Mensaje, { textoError } from "../../components/Mensaje";
import { asociarCodigo, buscarProductos, CodigoOcupado } from "../../db/productos";
import { monto } from "../../lib/tickets";
import type { ProductoLista } from "../../tipos";
import FilaClic from "../../ui/FilaClic";
import { useEnvio } from "../../ui/useEnvio";

/** Se escaneó un código que no existe: asociarlo a un producto existente o crear uno nuevo. */
export default function CodigoNuevo(p: { codigo: string; onAsociado(productoId: string): void; onCrear(): void; onCerrar(): void }) {
  const { actor } = useSesion();
  const [texto, setTexto] = useState("");
  const [lista, setLista] = useState<ProductoLista[]>([]);
  const [error, setError] = useState("");
  const envio = useEnvio(); // doble clic en la fila: se asocia una vez

  useEffect(() => {
    const t = setTimeout(() => {
      if (!texto.trim()) return setLista([]);
      buscarProductos({ texto, limite: 15, incluirInactivos: true }).then((r) => setLista(r.filas), (e) => setError(textoError(e)));
    }, 120);
    return () => clearTimeout(t);
  }, [texto]);

  async function elegir(prod: ProductoLista) {
    setError("");
    try {
      await asociarCodigo(actor, prod.id, p.codigo, "barras");
      p.onAsociado(prod.id);
    } catch (e) {
      // Alguien lo asoció mientras tanto: muy raro, pero se avisa en vez de moverlo sin preguntar.
      setError(e instanceof CodigoOcupado ? e.message : textoError(e));
    }
  }

  return (
    <Modal titulo="Código nuevo" onCerrar={p.onCerrar} ancho={620}>
      <p>
        El código <strong className="mono big">{p.codigo}</strong> no está en el catálogo. ¿A qué producto pertenece?
      </p>
      <label className="campo">
        Buscar el producto por nombre
        <input autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} />
      </label>
      <table className="tbl tbl-grande" style={{ marginTop: 8 }}>
        <tbody>
          {lista.map((x) => (
            <FilaClic key={x.id} etiqueta={`Asociar a ${x.nombre}`} onAbrir={() => void envio.enviar(() => elegir(x))}>
              <td>{x.nombre}</td>
              <td className="muted">{x.departamento}</td>
              <td className="num">{monto(x.precio)}</td>
              <td className="muted mono">{x.codigos.join(" ")}</td>
            </FilaClic>
          ))}
          {texto.trim() && lista.length === 0 && (
            <tr>
              <td className="muted">Sin resultados.</td>
            </tr>
          )}
        </tbody>
      </table>
      <Mensaje error={error} />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={p.onCrear}>
          Crear producto nuevo con este código
        </button>
        <button onClick={p.onCerrar}>Cancelar</button>
      </div>
    </Modal>
  );
}
