// Entrada de mercadería (dueño): proveedor y factura opcionales, líneas por lector, código o
// búsqueda. Todo se guarda en una transacción en Rust; después se puede imprimir el comprobante
// y las etiquetas de lo recibido.
import { PackagePlus, Printer, Tag, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../../app/sesion";
import Mensaje, { textoError } from "../../components/Mensaje";
import { listarProveedores, obtenerEntrada, registrarEntrada, type Comprobante, type Proveedor } from "../../db/inventario";
import { buscarProductos, productoPorCodigo } from "../../db/productos";
import { imprimirComprobanteEntrada, imprimirEtiquetasEntrada } from "../../lib/inventario";
import { monto } from "../../lib/tickets";
import { useEscaner } from "../../lib/useEscaner";
import type { ProductoLista } from "../../tipos";
import Alert from "../../ui/Alert";
import Button from "../../ui/Button";
import { useConfirmar } from "../../ui/Confirmar";
import Field from "../../ui/Field";
import { useToast } from "../../ui/Toast";

interface Linea {
  productoId: string;
  nombre: string;
  precio: number;
  cantidad: string;
  costo: string;
  precioNuevo: string;
}

const hoy = () => new Date().toLocaleDateString("sv-SE");

// Borrador de la entrada a medio digitar: si la sesión se cierra por inactividad, no se pierde.
// sessionStorage vive mientras la ventana esté abierta (se borra al cerrar el programa).
export const BORRADOR = "inventario.entrada.borrador";
interface Borrador {
  proveedor: string;
  factura: string;
  fecha: string;
  lineas: Linea[];
  actualizarCosto: boolean;
}
function leerBorrador(): Partial<Borrador> {
  try {
    return JSON.parse(sessionStorage.getItem(BORRADOR) ?? "{}");
  } catch {
    return {};
  }
}

export default function EntradaMercaderia() {
  const { config } = useSesion();
  const toast = useToast();
  const confirmar = useConfirmar();
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [borrador] = useState(leerBorrador);
  const [proveedor, setProveedor] = useState(borrador.proveedor ?? "");
  const [factura, setFactura] = useState(borrador.factura ?? "");
  const [fecha, setFecha] = useState(borrador.fecha ?? hoy());
  const [lineas, setLineas] = useState<Linea[]>(borrador.lineas ?? []);
  const [actualizarCosto, setActualizarCosto] = useState(borrador.actualizarCosto ?? true);
  const [buscar, setBuscar] = useState("");
  const [opciones, setOpciones] = useState<ProductoLista[]>([]);
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [hecha, setHecha] = useState<Comprobante | null>(null);

  useEffect(() => void listarProveedores().then(setProveedores, (e) => setError(textoError(e))), []);
  useEffect(() => {
    try {
      if (lineas.length || factura) sessionStorage.setItem(BORRADOR, JSON.stringify({ proveedor, factura, fecha, lineas, actualizarCosto } satisfies Borrador));
      else sessionStorage.removeItem(BORRADOR);
    } catch {
      /* sin almacenamiento: se sigue sin borrador */
    }
  }, [proveedor, factura, fecha, lineas, actualizarCosto]);

  function agregar(p: { id: string; nombre: string; precio: number }) {
    setLineas((ls) => {
      const i = ls.findIndex((l) => l.productoId === p.id);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, cantidad: String((Number(l.cantidad) || 0) + 1) } : l));
      return [...ls, { productoId: p.id, nombre: p.nombre, precio: p.precio, cantidad: "1", costo: "", precioNuevo: "" }];
    });
    setBuscar("");
    setOpciones([]);
  }

  async function porCodigo(codigo: string) {
    setError("");
    try {
      const p = await productoPorCodigo(codigo);
      if (p) agregar(p);
      else setError(`No hay ningún producto con el código ${codigo}. Créelo en Productos.`);
    } catch (e) {
      setError(textoError(e));
    }
  }
  useEscaner((c) => void porCodigo(c), { activo: !hecha, debounceMs: config.escaner_debounce_ms });

  useEffect(() => {
    if (buscar.trim().length < 2) return setOpciones([]);
    const t = setTimeout(() => buscarProductos({ texto: buscar, limite: 8 }).then((r) => setOpciones(r.filas), (e) => setError(textoError(e))), 150);
    return () => clearTimeout(t);
  }, [buscar]);

  const set = (i: number, patch: Partial<Linea>) => setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const cambiosPrecio = lineas.filter((l) => l.precioNuevo.trim() !== "" && Number(l.precioNuevo) !== l.precio);

  async function guardar() {
    setError("");
    if (cambiosPrecio.length) {
      const ok = await confirmar({
        titulo: "¿Cambiar precios de venta?",
        texto: cambiosPrecio.map((l) => `${l.nombre}: ${monto(l.precio)} → ${monto(Number(l.precioNuevo))}`).join(". "),
        aceptar: "Cambiar precios y guardar",
      });
      if (!ok) return;
    }
    setOcupado(true);
    try {
      const id = await registrarEntrada({
        proveedorId: proveedor || null,
        factura,
        fecha,
        actualizarCosto,
        lineas: lineas.map((l) => ({
          productoId: l.productoId,
          cantidad: Number(l.cantidad),
          costoUnitario: l.costo.trim() === "" ? null : Number(l.costo),
          precioNuevo: l.precioNuevo.trim() === "" ? null : Number(l.precioNuevo),
        })),
      });
      setHecha(await obtenerEntrada(id));
      setLineas([]);
      setFactura("");
      toast.ok("Entrada guardada.");
    } catch (e) {
      setError(textoError(e));
    } finally {
      setOcupado(false);
    }
  }

  async function imprimir(que: "comprobante" | "etiquetas") {
    if (!hecha) return;
    setError("");
    try {
      if (que === "comprobante") toast.ok(`Enviado a ${await imprimirComprobanteEntrada(hecha)}.`);
      else {
        const r = await imprimirEtiquetasEntrada(hecha);
        toast.ok(`${r.impresas} etiquetas enviadas.${r.sinCodigo ? ` ${r.sinCodigo} producto(s) sin código de barras no llevan etiqueta.` : ""}`);
      }
    } catch (e) {
      setError(textoError(e));
    }
  }

  if (hecha)
    return (
      <section className="card">
        <Alert tono="ok" titulo="Entrada guardada">
          {hecha.lineas.length} producto(s), {hecha.lineas.reduce((a, l) => a + l.cantidad, 0)} unidades.
        </Alert>
        <div className="row">
          <Button icono={Printer} onClick={() => imprimir("comprobante")}>
            Imprimir comprobante
          </Button>
          <Button icono={Tag} onClick={() => imprimir("etiquetas")}>
            Imprimir etiquetas ({hecha.lineas.filter((l) => l.codigoBarras).reduce((a, l) => a + l.cantidad, 0)})
          </Button>
          <Button variante="primario" icono={PackagePlus} onClick={() => setHecha(null)}>
            Nueva entrada
          </Button>
        </div>
        <Mensaje error={error} />
      </section>
    );

  return (
    <section className="card">
      <div className="row">
        <Field label="Proveedor (opcional)" flex={2}>
          <select value={proveedor} onChange={(e) => setProveedor(e.target.value)}>
            <option value="">Sin proveedor</option>
            {proveedores.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </select>
        </Field>
        <Field label="N.º de factura (opcional)" flex={1}>
          <input value={factura} maxLength={40} onChange={(e) => setFactura(e.target.value)} />
        </Field>
        <Field label="Fecha de la factura" flex={1}>
          <input type="date" value={fecha} max={hoy()} onChange={(e) => setFecha(e.target.value)} />
        </Field>
      </div>
      {borrador.lineas?.length ? <Alert tono="info">Se recuperó la entrada que estaba a medias ({borrador.lineas.length} producto(s)).</Alert> : null}
      <Field label="Agregar producto" ayuda="Escanee el código, o escriba el nombre o el código y elija.">
        <input
          type="search"
          value={buscar}
          onChange={(e) => setBuscar(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && buscar.trim()) {
              e.preventDefault();
              if (opciones.length === 1) agregar(opciones[0]);
              else void porCodigo(buscar.trim());
            }
          }}
        />
      </Field>
      {opciones.length > 0 && (
        <ul className="lista-opciones" aria-label="Productos encontrados">
          {opciones.map((o) => (
            <li key={o.id}>
              <Button onClick={() => agregar(o)}>
                {o.nombre} · {monto(o.precio)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {lineas.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Producto</th>
              <th className="num">Cantidad</th>
              <th className="num">Costo unitario (¢)</th>
              <th className="num">Precio de venta nuevo (¢)</th>
              <th>
                <span className="sr-only">Quitar</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lineas.map((l, i) => (
              <tr key={l.productoId}>
                <td>
                  <strong>{l.nombre}</strong>
                  <div className="muted">Precio actual {monto(l.precio)}</div>
                </td>
                <td className="num">
                  <input className="small" inputMode="numeric" aria-label={`Cantidad de ${l.nombre}`} value={l.cantidad} onChange={(e) => set(i, { cantidad: e.target.value.replace(/\D/g, "") })} />
                </td>
                <td className="num">
                  <input className="small" inputMode="numeric" aria-label={`Costo de ${l.nombre}`} value={l.costo} onChange={(e) => set(i, { costo: e.target.value.replace(/\D/g, "") })} />
                </td>
                <td className="num">
                  <input className="small" inputMode="numeric" aria-label={`Precio nuevo de ${l.nombre}`} placeholder="Igual" value={l.precioNuevo} onChange={(e) => set(i, { precioNuevo: e.target.value.replace(/\D/g, "") })} />
                </td>
                <td>
                  <Button variante="fantasma" icono={Trash2} aria-label={`Quitar ${l.nombre}`} onClick={() => setLineas(lineas.filter((_, j) => j !== i))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <label className="row">
        <input type="checkbox" checked={actualizarCosto} onChange={(e) => setActualizarCosto(e.target.checked)} /> Guardar el costo de cada línea como último costo del producto
      </label>
      <Mensaje error={error} />
      <Button variante="primario" icono={PackagePlus} disabled={ocupado || !lineas.length || lineas.some((l) => !(Number(l.cantidad) > 0))} onClick={guardar}>
        Guardar entrada
      </Button>
    </section>
  );
}
