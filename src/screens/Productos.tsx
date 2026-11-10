import { FileUp, PackagePlus, PackageSearch, Search, Star } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSesion } from "../app/sesion";
import { useConfirmar } from "../ui/Confirmar";
import Mensaje, { textoError } from "../components/Mensaje";
import { listarDepartamentos } from "../db/departamentos";
import { estadoInventario, type FilaInventario } from "../db/inventario";
import { buscarProductos, marcarFavorito, marcarFavoritos, productoPorCodigo } from "../db/productos";
import { monto } from "../lib/tickets";
import { useEscaner } from "../lib/useEscaner";
import type { Codigo, Departamento, ProductoLista } from "../tipos";
import Button from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import Field from "../ui/Field";
import FilaClic from "../ui/FilaClic";
import Paginacion from "../ui/Paginacion";
import CodigoNuevo from "./productos/CodigoNuevo";
import Importar, { type FiltroProductosImportados } from "./productos/Importar";
import { EstadoBadge } from "./inventario/Existencias";
import ProductoEditor from "./productos/ProductoEditor";

const POR_PAGINA = 50;

type Dialogo = { tipo: "editar"; id: string | null; codigo?: Codigo } | { tipo: "codigoNuevo"; codigo: string } | null;

export default function Productos() {
  const { actor, config, puede } = useSesion();
  const confirmar = useConfirmar();
  const [departamentos, setDepartamentos] = useState<Departamento[]>([]);
  const [texto, setTexto] = useState("");
  const [depto, setDepto] = useState("");
  const [inactivos, setInactivos] = useState(false);
  const [mostrar, setMostrar] = useState<"" | FiltroProductosImportados>("");
  const [filas, setFilas] = useState<ProductoLista[]>([]);
  const [total, setTotal] = useState<number | null>(null); // null: todavía cargando
  const [pagina, setPagina] = useState(1);
  const [dialogo, setDialogo] = useState<Dialogo>(null);
  const [importando, setImportando] = useState(false);
  const [error, setError] = useState("");
  const consulta = useRef(0);
  // Existencia, mínimo y estado: solo para quien maneja inventario (el técnico no; el cajero no entra aquí).
  const verInventario = puede("inventario");
  const [inv, setInv] = useState<Record<string, FilaInventario>>({});
  useEffect(() => {
    if (!verInventario || !filas.length) return;
    estadoInventario(filas.map((f) => f.id)).then((l) => setInv(Object.fromEntries(l.map((x) => [x.productoId, x]))), () => undefined);
  }, [filas]);

  useEffect(() => {
    listarDepartamentos().then(setDepartamentos, (e) => setError(textoError(e)));
  }, []);

  /** Carga una página (la búsqueda es sobre todo el catálogo). Descarta respuestas viejas si se siguió escribiendo. */
  const cargar = useCallback(
    async (nPagina = pagina) => {
      const n = ++consulta.current;
      try {
        const r = await buscarProductos({
          texto,
          departamentoId: depto || undefined,
          incluirInactivos: inactivos,
          sinBarras: mostrar === "sinBarras",
          paraRevisar: mostrar === "revisar",
          limite: POR_PAGINA,
          desplazamiento: (nPagina - 1) * POR_PAGINA,
        });
        if (n !== consulta.current) return;
        if (!r.filas.length && nPagina > 1) return void cargar(1); // se borró lo último de la página
        setFilas(r.filas);
        setTotal(r.total);
        setPagina(nPagina);
      } catch (e) {
        setError(textoError(e));
      }
    },
    [texto, depto, inactivos, mostrar, pagina],
  );

  // Búsqueda instantánea (con una pausa mínima para no consultar en cada tecla del lector).
  useEffect(() => {
    const t = setTimeout(() => void cargar(1), 100);
    return () => clearTimeout(t);
  }, [texto, depto, inactivos, mostrar]);

  async function abrirPorCodigo(codigo: string) {
    setError("");
    try {
      const p = await productoPorCodigo(codigo);
      setDialogo(p ? { tipo: "editar", id: p.id } : { tipo: "codigoNuevo", codigo });
    } catch (e) {
      setError(textoError(e));
    }
  }

  // En esta pantalla, escanear abre el producto o pregunta por el código nuevo.
  useEscaner((c) => void abrirPorCodigo(c), { activo: dialogo === null && !importando, debounceMs: config.escaner_debounce_ms });

  async function enterEnBuscador(e: React.KeyboardEvent) {
    // Código tecleado a mano + Enter: si existe, abre el producto.
    if (e.key !== "Enter" || !texto.trim()) return;
    const p = await productoPorCodigo(texto);
    if (p) setDialogo({ tipo: "editar", id: p.id });
  }

  /** Todos los que coinciden con la búsqueda (no solo la página cargada) pasan a favoritos, o salen. */
  async function favoritosEnBloque(favorito: boolean) {
    setError("");
    const ok = await confirmar({
      titulo: favorito ? "Marcar como favoritos" : "Quitar de favoritos",
      texto: favorito
        ? `Los ${total} productos de esta búsqueda aparecerán como tarjetas en Venta.`
        : `Los ${total} productos de esta búsqueda dejarán de aparecer como tarjetas en Venta.`,
      aceptar: favorito ? "Marcar" : "Quitar",
    });
    if (!ok) return;
    try {
      const todos = await buscarProductos({ texto, departamentoId: depto || undefined, incluirInactivos: inactivos, limite: 1000 });
      await marcarFavoritos(actor, todos.filas.filter((p) => p.favorito !== favorito).map((p) => p.id), favorito);
      await cargar();
    } catch (e) {
      setError(textoError(e));
    }
  }

  if (importando)
    return (
      <Importar
        onSalir={(filtro) => {
          setImportando(false);
          // Mismo filtro = el efecto no corre: se recarga a mano.
          if ((filtro ?? "") === mostrar) void cargar();
          else setMostrar(filtro ?? "");
        }}
      />
    );

  return (
    <div className="screen">
      <div className="encabezado">
        <h1>Productos</h1>
        <div className="row">
          {puede("productos.importar") && (
            <Button icono={FileUp} onClick={() => setImportando(true)}>
              Importar productos
            </Button>
          )}
          <Button variante="primario" icono={PackagePlus} onClick={() => setDialogo({ tipo: "editar", id: null })}>
            Nuevo producto
          </Button>
        </div>
      </div>
      <div className="row arriba">
        <Field label="Buscar o escanear" flex={1}>
          <div className="buscador-entrada">
            <Search size={20} aria-hidden />
            <input className="grande-venta" style={{ minHeight: 48, fontSize: 17 }} autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} onKeyDown={enterEnBuscador} />
          </div>
        </Field>
        <Field label="Departamento">
          <select value={depto} onChange={(e) => setDepto(e.target.value)}>
            <option value="">Todos</option>
            {departamentos.map((d) => (
              <option key={d.id} value={d.id}>
                {d.nombre}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Mostrar">
          <select value={mostrar} onChange={(e) => setMostrar(e.target.value as typeof mostrar)}>
            <option value="">Todos</option>
            <option value="sinBarras">Sin código de barras</option>
            <option value="revisar">Para revisar (importados)</option>
          </select>
        </Field>
        <label className="check" style={{ marginTop: 28 }}>
          <input type="checkbox" checked={inactivos} onChange={(e) => setInactivos(e.target.checked)} /> Ver inactivos
        </label>
      </div>
      <Mensaje error={error} />
      <section className="card">
        {total === null ? (
          <p className="muted">Cargando…</p>
        ) : total === 0 ? (
          <EmptyState
            icono={PackageSearch}
            titulo={texto || depto || mostrar ? "No hay productos que coincidan" : "Todavía no hay productos"}
            texto={texto || depto || mostrar ? "Revise lo escrito o cambie los filtros." : "Cree uno con «Nuevo producto» o impórtelos desde la web."}
          />
        ) : (
        <>
        <div className="row between">
          <p className="muted">{`${total.toLocaleString("es-CR")} productos`}</p>
          {(texto.trim() || depto) && (
            <div className="row">
              <Button icono={Star} onClick={() => void favoritosEnBloque(true)}>
                Marcar los {total.toLocaleString("es-CR")} como favoritos
              </Button>
              <Button variante="fantasma" onClick={() => void favoritosEnBloque(false)}>
                Quitar de favoritos
              </Button>
            </div>
          )}
        </div>
        <table className="tbl tbl-grande">
          <thead>
            <tr>
              <th>
                <span className="sr-only">Favorito</span>
              </th>
              <th>Nombre</th>
              <th className="col-sec">Departamento</th>
              <th className="num">Precio</th>
              <th className="col-sec">Códigos</th>
              {verInventario && (
                <>
                  <th className="num">Existencia</th>
                  <th className="num">Mínimo</th>
                  <th>Estado</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {filas.map((p) => (
              <FilaClic key={p.id} etiqueta={`Editar ${p.nombre}`} className={p.activo ? "" : "inactivo"} onAbrir={() => setDialogo({ tipo: "editar", id: p.id })}>
                <td style={{ width: 52 }}>
                  <button
                    className="tile-estrella"
                    style={{ position: "static" }}
                    aria-pressed={p.favorito}
                    aria-label={p.favorito ? `Quitar ${p.nombre} de favoritos` : `Marcar ${p.nombre} como favorito`}
                    title={p.favorito ? "Favorito (aparece en Venta)" : "Marcar como favorito"}
                    onClick={(e) => {
                      e.stopPropagation();
                      marcarFavorito(actor, p.id, !p.favorito).then(
                        () => setFilas((l) => l.map((x) => (x.id === p.id ? { ...x, favorito: !p.favorito } : x))),
                        (err) => setError(textoError(err)),
                      );
                    }}
                  >
                    <Star size={18} aria-hidden />
                  </button>
                </td>
                <td className="nombre-celda">{p.nombre}</td>
                <td className="col-sec">{p.departamento}</td>
                <td className="num">{monto(p.precio)}</td>
                <td className="mono muted col-sec">{p.codigos.join(" ")}</td>
                {verInventario && (
                  <>
                    <td className="num">{inv[p.id]?.controla ? inv[p.id].existencia : "—"}</td>
                    <td className="num">{inv[p.id]?.minimo || "—"}</td>
                    <td>{inv[p.id] && <EstadoBadge estado={inv[p.id].estado} />}</td>
                  </>
                )}
              </FilaClic>
            ))}
          </tbody>
        </table>
        <Paginacion nombre="productos" pagina={pagina} porPagina={POR_PAGINA} total={total} onPagina={(n) => void cargar(n)} />
        </>
        )}
      </section>

      {dialogo?.tipo === "editar" && (
        <ProductoEditor
          key={dialogo.id ?? "nuevo"}
          productoId={dialogo.id}
          codigoInicial={dialogo.codigo}
          departamentos={departamentos}
          onCerrar={() => setDialogo(null)}
          onCambio={() => void cargar()}
        />
      )}
      {dialogo?.tipo === "codigoNuevo" && (
        <CodigoNuevo
          codigo={dialogo.codigo}
          onCerrar={() => setDialogo(null)}
          onAsociado={(id) => {
            void cargar();
            setDialogo({ tipo: "editar", id });
          }}
          onCrear={() => setDialogo({ tipo: "editar", id: null, codigo: { codigo: dialogo.codigo, tipo: "barras" } })}
        />
      )}
    </div>
  );
}
