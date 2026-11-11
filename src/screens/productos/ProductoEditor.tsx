// Crear o editar un producto con sus códigos. En edición, cada código se guarda al agregarlo
// (así el aviso "ya pertenece a otro producto" aparece en el momento).
import { ArrowRightLeft, Barcode, Plus, Save, Tag, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../../app/sesion";
import Modal from "../../components/Modal";
import Mensaje, { textoError } from "../../components/Mensaje";
import {
  asociarCodigo,
  CodigoOcupado,
  crearProducto,
  editarProducto,
  eliminarProducto,
  generarCodigoInterno,
  limpiarCodigo,
  NombreRepetido,
  obtenerProducto,
  productoConNombre,
  quitarCodigo,
} from "../../db/productos";
import { estadoInventario, registrarEntrada } from "../../db/inventario";
import { isValidEan13 } from "../../lib/ean13";
import { leerMontoEntero } from "../../lib/texto";
import { colones, monto } from "../../lib/tickets";
import { useEscaner } from "../../lib/useEscaner";
import type { Codigo, Departamento, ProductoConCodigos, TipoCodigo } from "../../tipos";
import Etiqueta from "./Etiqueta";
import Button from "../../ui/Button";
import { useConfirmar } from "../../ui/Confirmar";
import CampoMonto from "../../ui/CampoMonto";
import Field from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import { useEnvio } from "../../ui/useEnvio";

interface Props {
  /** null = producto nuevo. */
  productoId: string | null;
  departamentos: Departamento[];
  /** Código con el que nace el producto nuevo (p. ej. el que se acaba de escanear). */
  codigoInicial?: Codigo;
  onCerrar(): void;
  onCambio(): void;
}

export default function ProductoEditor({ productoId, departamentos, codigoInicial, onCerrar, onCambio }: Props) {
  const { actor, config, puede } = useSesion();
  const confirmar = useConfirmar();
  const [id, setId] = useState(productoId);
  const [prod, setProd] = useState<ProductoConCodigos | null>(null);
  const [nombre, setNombre] = useState("");
  const [departamentoId, setDepartamentoId] = useState("");
  const [precio, setPrecio] = useState("");
  const [activo, setActivo] = useState(true);
  const [cabys, setCabys] = useState("");
  const [tasaIva, setTasaIva] = useState("13");
  const [exento, setExento] = useState(false);
  const [descuento, setDescuento] = useState("");
  // Solo al crear: unidades con las que empieza (queda como entrada de mercadería en el kardex).
  const [existencia, setExistencia] = useState("");
  const [codigos, setCodigos] = useState<Codigo[]>(codigoInicial ? [codigoInicial] : []);
  const [codigoNuevo, setCodigoNuevo] = useState("");
  const [conflicto, setConflicto] = useState<{ error: CodigoOcupado; tipo: TipoCodigo } | null>(null);
  const [etiqueta, setEtiqueta] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Aviso mientras escribe: el nombre no puede repetirse (sin contar mayúsculas, tildes ni espacios).
  const [repetido, setRepetido] = useState<NombreRepetido | null>(null);
  // Un doble clic en "Crear producto" no crea dos (guardar maneja sus propios errores).
  const { ocupado, enviar } = useEnvio();
  const toast = useToast();

  async function cargar(pid: string) {
    const p = await obtenerProducto(pid);
    if (!p) throw new Error("Producto no encontrado");
    setProd(p);
    setNombre(p.nombre);
    setDepartamentoId(p.departamentoId);
    setPrecio(colones(p.precio));
    setActivo(p.activo);
    setCabys(p.cabys ?? "");
    setTasaIva(String(p.tasaIva));
    setExento(p.exento);
    setDescuento(p.descuentoPct ? String(p.descuentoPct) : "");
    setCodigos(p.codigos);
  }
  useEffect(() => {
    if (productoId) void cargar(productoId).catch((e) => setError(textoError(e)));
  }, [productoId]);

  useEffect(() => {
    const t = setTimeout(() => productoConNombre(nombre, id).then((o) => setRepetido(o && new NombreRepetido(o)), () => setRepetido(null)), 250);
    return () => clearTimeout(t);
  }, [nombre, id]);

  const precioNum = leerMontoEntero(precio);
  const tasaNum = Number(tasaIva.replace(",", "."));
  const descuentoNum = Number(descuento || 0);
  const existenciaNum = Number(existencia || 0);
  const sucio =
    !prod ||
    nombre !== prod.nombre ||
    departamentoId !== prod.departamentoId ||
    precioNum !== prod.precio ||
    activo !== prod.activo ||
    cabys !== (prod.cabys ?? "") ||
    tasaNum !== prod.tasaIva ||
    exento !== prod.exento ||
    descuentoNum !== prod.descuentoPct;

  function limpiarAvisos() {
    setError("");
    setConflicto(null);
  }

  async function guardar(moverCodigos = false) {
    limpiarAvisos();
    if (precioNum === null) return setError("Precio inválido: use solo números (ej. 1500 o 1.500)");
    if (!Number.isFinite(tasaNum)) return setError("Tasa de IVA inválida");
    if (!(descuentoNum <= 100)) return setError("El descuento va de 0 a 100 %");
    // Un 50 % o más casi siempre es un dedo (5 → 50); se vende así sin pedir PIN, por eso se confirma.
    if (descuentoNum >= 50 && descuentoNum !== prod?.descuentoPct && !(await confirmar({ titulo: `¿Descuento de ${descuentoNum} %?`, texto: "Se aplica solo en cada venta de este producto, sin pedir PIN.", aceptar: `Guardar con ${descuentoNum} %`, peligro: true })))
      return;
    if (precioNum === 0 && prod?.precio !== 0 && !(await confirmar({ titulo: "¿Precio ¢0?", texto: "El producto se venderá gratis cada vez que se escanee o se toque.", aceptar: "Guardar en ¢0", peligro: true })))
      return;
    const datos = { nombre, departamentoId, precio: precioNum, activo, cabys: cabys.trim() || null, tasaIva: tasaNum, exento, descuentoPct: descuentoNum };
    try {
      if (id) await editarProducto(actor, id, datos);
      else {
        const nuevoId = await crearProducto(actor, datos, codigos, { moverCodigos });
        setId(nuevoId);
        await cargar(nuevoId);
        if (existenciaNum > 0)
          await registrarEntrada({
            proveedorId: null,
            factura: "",
            fecha: new Date().toLocaleDateString("sv-SE"),
            lineas: [{ productoId: nuevoId, cantidad: existenciaNum, costoUnitario: null }],
            actualizarCosto: false,
          }).catch((e) => {
            onCambio();
            throw new Error(`El producto se creó, pero las unidades no se cargaron: ${textoError(e)}. Cárguelas en Inventario → Entrada.`);
          });
        setExistencia("");
      }
      if (id) await cargar(id);
      toast.ok("Producto guardado.");
      onCambio();
    } catch (e) {
      if (e instanceof CodigoOcupado) setConflicto({ error: e, tipo: codigos.find((c) => c.codigo === e.codigo)?.tipo ?? "manual" });
      else setError(textoError(e));
    }
  }

  /** Agrega un código: en un producto nuevo queda pendiente hasta guardar; en uno existente se guarda ya. */
  async function agregarCodigo(texto: string, tipo: TipoCodigo, mover = false) {
    limpiarAvisos();
    try {
      const c = limpiarCodigo(texto);
      if (codigos.some((x) => x.codigo.toLowerCase() === c.toLowerCase())) return toast.ok(`El código ${c} ya está en este producto.`);
      if (!id) setCodigos([...codigos, { codigo: c, tipo }]);
      else {
        await asociarCodigo(actor, id, c, tipo, { mover });
        await cargar(id);
        onCambio();
        toast.ok(mover ? `Código ${c} movido a este producto.` : `Código ${c} agregado.`);
      }
      setCodigoNuevo("");
    } catch (e) {
      if (e instanceof CodigoOcupado) setConflicto({ error: e, tipo });
      else setError(textoError(e));
    }
  }

  async function quitar(c: string) {
    limpiarAvisos();
    if (!id) return setCodigos(codigos.filter((x) => x.codigo !== c));
    try {
      await quitarCodigo(actor, c);
      await cargar(id);
      onCambio();
    } catch (e) {
      setError(textoError(e));
    }
  }

  /** Para productos sin etiqueta de fábrica: EAN-13 200… y abre la impresión de la etiqueta. */
  async function generarInterno() {
    if (!id) return;
    limpiarAvisos();
    try {
      const c = await generarCodigoInterno(actor, id);
      await cargar(id);
      onCambio();
      setEtiqueta(c);
    } catch (e) {
      setError(textoError(e));
    }
  }

  async function eliminar() {
    if (!id) return;
    // Si tiene unidades, que el dueño sepa que dejan de contarse en el inventario.
    const inv = puede("inventario") ? (await estadoInventario([id]).catch(() => []))[0] : undefined;
    const conUnidades = inv?.controla && inv.existencia !== 0 ? ` Tiene ${inv.existencia} unidad(es) en inventario: dejan de contarse en el inventario valorizado (su kardex se conserva).` : "";
    if (!(await confirmar({ titulo: `¿Eliminar "${nombre}"?`, texto: `Deja de aparecer en el catálogo y en la venta. Las ventas anteriores no cambian.${conUnidades}`, aceptar: "Eliminar producto", peligro: true }))) return;
    try {
      await eliminarProducto(actor, id);
      onCambio();
      onCerrar();
    } catch (e) {
      setError(textoError(e));
    }
  }

  // Con el editor abierto, escanear agrega el código a ESTE producto.
  useEscaner((c) => void agregarCodigo(c, "barras"), { activo: !etiqueta, debounceMs: config.escaner_debounce_ms });

  return (
    <Modal
      titulo={id ? "Editar producto" : "Nuevo producto"}
      onCerrar={onCerrar}
      ancho={620}
      pie={
        <>
          {id && (
            <Button variante="fantasma" className="texto-peligro" icono={Trash2} onClick={eliminar}>
              Eliminar
            </Button>
          )}
          <span className="separador" />
          <Button onClick={onCerrar}>{sucio ? "Cancelar" : "Cerrar"}</Button>
          <Button type="submit" form="form-producto" variante="primario" icono={Save} disabled={!sucio || !!repetido || ocupado}>
            {id ? "Guardar cambios" : "Crear producto"}
          </Button>
        </>
      }
    >
      <form
        id="form-producto"
        onSubmit={(e) => {
          e.preventDefault();
          void enviar(() => guardar());
        }}
      >
        <label className="campo">
          Nombre
          <input autoFocus={!id} value={nombre} aria-invalid={!!repetido} aria-describedby={repetido ? "nombre-repetido" : undefined} onChange={(e) => setNombre(e.target.value)} />
          {repetido && (
            <span id="nombre-repetido" className="campo-error" role="alert">
              {repetido.message}
            </span>
          )}
        </label>
        <div className="row">
          <label className="campo" style={{ flex: 1 }}>
            Departamento
            <select value={departamentoId} onChange={(e) => setDepartamentoId(e.target.value)}>
              <option value="">— Elija —</option>
              {departamentos.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.codigo} · {d.nombre}
                </option>
              ))}
            </select>
          </label>
          <label className="campo">
            Precio
            <CampoMonto valor={precio} onCambio={setPrecio} />
          </label>
          <label className="campo">
            Descuento %
            <input className="small" inputMode="numeric" placeholder="0" value={descuento} onChange={(e) => setDescuento(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </label>
          {!id && puede("inventario") && (
            <label className="campo">
              Unidades que hay
              <input className="small" inputMode="numeric" placeholder="0" value={existencia} onChange={(e) => setExistencia(e.target.value.replace(/\D/g, "").slice(0, 6))} />
            </label>
          )}
        </div>
        {descuentoNum > 0 && precioNum ? (
          <p className="muted">Se vende a {monto(precioNum - Math.round((precioNum * descuentoNum) / 100))} ({descuentoNum} % menos), sin pedir PIN.</p>
        ) : null}
        <label className="check">
          <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} /> Activo (aparece en la venta)
        </label>
        <details className="fiscal">
          <summary>Datos fiscales (opcional, para facturación futura)</summary>
          <div className="row">
            <label className="campo">
              CAByS (13 dígitos)
              <input className="mono" inputMode="numeric" value={cabys} onChange={(e) => setCabys(e.target.value.replace(/\D/g, "").slice(0, 13))} />
            </label>
            <label className="campo">
              IVA %
              <input className="small" inputMode="decimal" value={tasaIva} disabled={exento} onChange={(e) => setTasaIva(e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={exento} onChange={(e) => setExento(e.target.checked)} /> Exento
            </label>
          </div>
        </details>
      </form>

      <h3 className="editor-seccion">Códigos</h3>
      <p className="muted">Escanee con el lector para agregar, o escriba el código (letras o números).</p>
      <div className="chips">
        {codigos.length === 0 && <span className="muted">Sin códigos.</span>}
        {codigos.map((c) => (
          <span key={c.codigo} className="chip chip-codigo" title={c.tipo}>
            <span className="mono">{c.codigo}</span>
            {isValidEan13(c.codigo) && id && (
              <button onClick={() => setEtiqueta(c.codigo)} aria-label={`Imprimir etiqueta de ${c.codigo}`}>
                <Tag size={16} aria-hidden /> Etiqueta
              </button>
            )}
            <button className="peligro" onClick={() => quitar(c.codigo)} aria-label={`Quitar código ${c.codigo}`}>
              <X size={16} aria-hidden /> Quitar
            </button>
          </span>
        ))}
      </div>
      <form
        className="row abajo"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (codigoNuevo.trim()) void agregarCodigo(codigoNuevo, "manual");
        }}
      >
        <Field label="Código nuevo" className="sin-margen">
          <input className="mono" value={codigoNuevo} onChange={(e) => setCodigoNuevo(e.target.value)} />
        </Field>
        <Button type="submit" icono={Plus}>
          Agregar código
        </Button>
        <Button
          variante={codigos.length ? "normal" : "primario"}
          icono={Barcode}
          disabled={!id}
          title={id ? "" : "Primero cree el producto"}
          onClick={generarInterno}
        >
          Generar código interno
        </Button>
      </form>

      {conflicto && (
        <div className="note" role="alert" style={{ marginTop: 10 }}>
          <p>
            El código <strong className="mono">{conflicto.error.codigo}</strong> ya pertenece a{" "}
            <strong>"{conflicto.error.producto.nombre}"</strong>. Un código solo puede ser de un producto.
          </p>
          <div className="row">
            <Button
              variante="primario"
              icono={ArrowRightLeft}
              onClick={() => (id ? agregarCodigo(conflicto.error.codigo, conflicto.tipo, true) : enviar(() => guardar(true)))}
            >
              Moverlo a este producto
            </Button>
            <button
              onClick={() => {
                if (!id) setCodigos(codigos.filter((x) => x.codigo !== conflicto.error.codigo));
                setConflicto(null);
              }}
            >
              {id ? "Dejarlo donde está" : "Quitarlo de este producto"}
            </button>
          </div>
        </div>
      )}
      <Mensaje error={error} />
      {etiqueta && prod && <Etiqueta producto={prod} codigo={etiqueta} onCerrar={() => setEtiqueta(null)} />}
    </Modal>
  );
}
