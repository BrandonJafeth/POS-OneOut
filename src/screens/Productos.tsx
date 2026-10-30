import { ChevronDown, FileUp, PackagePlus, PackageSearch, Search, Star } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import { listarDepartamentos } from "../db/departamentos";
import { buscarProductos, marcarFavorito, productoPorCodigo } from "../db/productos";
import { monto } from "../lib/tickets";
import { useEscaner } from "../lib/useEscaner";
import type { Codigo, Departamento, ProductoLista } from "../tipos";
import Button from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import Field from "../ui/Field";
import FilaClic from "../ui/FilaClic";
import CodigoNuevo from "./productos/CodigoNuevo";
import Importar from "./productos/Importar";
import ProductoEditor from "./productos/ProductoEditor";

const POR_PAGINA = 50;

type Dialogo = { tipo: "editar"; id: string | null; codigo?: Codigo } | { tipo: "codigoNuevo"; codigo: string } | null;

export default function Productos() {
  const { actor, config, puede } = useSesion();
  const [departamentos, setDepartamentos] = useState<Departamento[]>([]);
  const [texto, setTexto] = useState("");
  const [depto, setDepto] = useState("");
  const [inactivos, setInactivos] = useState(false);
  const [filas, setFilas] = useState<ProductoLista[]>([]);
  const [total, setTotal] = useState(0);
  const [dialogo, setDialogo] = useState<Dialogo>(null);
  const [importando, setImportando] = useState(false);
  const [error, setError] = useState("");
  const consulta = useRef(0);

  useEffect(() => {
    listarDepartamentos().then(setDepartamentos, (e) => setError(textoError(e)));
  }, []);

  /** Carga la primera página (o agrega la siguiente). Descarta respuestas viejas si se siguió escribiendo. */
  const cargar = useCallback(
    async (mas = false) => {
      const n = ++consulta.current;
      try {
        const r = await buscarProductos({
          texto,
          departamentoId: depto || undefined,
          incluirInactivos: inactivos,
          limite: POR_PAGINA,
          desplazamiento: mas ? filas.length : 0,
        });
        if (n !== consulta.current) return;
        setFilas(mas ? [...filas, ...r.filas] : r.filas);
        setTotal(r.total);
      } catch (e) {
        setError(textoError(e));
      }
    },
    [texto, depto, inactivos, filas],
  );

  // Búsqueda instantánea (con una pausa mínima para no consultar en cada tecla del lector).
  useEffect(() => {
    const t = setTimeout(() => void cargar(), 100);
    return () => clearTimeout(t);
  }, [texto, depto, inactivos]);

  async function abrirPorCodigo(codigo: string) {
    setError("");
    const p = await productoPorCodigo(codigo);
    setDialogo(p ? { tipo: "editar", id: p.id } : { tipo: "codigoNuevo", codigo });
  }

  // En esta pantalla, escanear abre el producto o pregunta por el código nuevo.
  useEscaner((c) => void abrirPorCodigo(c), { activo: dialogo === null && !importando, debounceMs: config.escaner_debounce_ms });

  async function enterEnBuscador(e: React.KeyboardEvent) {
    // Código tecleado a mano + Enter: si existe, abre el producto.
    if (e.key !== "Enter" || !texto.trim()) return;
    const p = await productoPorCodigo(texto);
    if (p) setDialogo({ tipo: "editar", id: p.id });
  }

  if (importando) return <Importar onSalir={() => (setImportando(false), void cargar())} />;

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
        <label className="check" style={{ marginTop: 28 }}>
          <input type="checkbox" checked={inactivos} onChange={(e) => setInactivos(e.target.checked)} /> Ver inactivos
        </label>
      </div>
      <Mensaje error={error} />
      <section className="card">
        {total === 0 ? (
          <EmptyState
            icono={PackageSearch}
            titulo={texto || depto ? "No hay productos que coincidan" : "Todavía no hay productos"}
            texto={texto || depto ? "Revise lo escrito o elija otro departamento." : "Cree uno con «Nuevo producto» o impórtelos desde la web."}
          />
        ) : (
        <>
        <p className="muted">{`${filas.length} de ${total.toLocaleString("es-CR")} productos`}</p>
        <table className="tbl tbl-grande">
          <thead>
            <tr>
              <th>
                <span className="sr-only">Favorito</span>
              </th>
              <th>Nombre</th>
              <th>Departamento</th>
              <th className="num">Precio</th>
              <th>Códigos</th>
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
                <td>{p.nombre}</td>
                <td>{p.departamento}</td>
                <td className="num">{monto(p.precio)}</td>
                <td className="mono muted">{p.codigos.join(" ")}</td>
              </FilaClic>
            ))}
          </tbody>
        </table>
        {filas.length < total && (
          <div className="fila-botones">
            <Button icono={ChevronDown} onClick={() => cargar(true)}>
              Ver {Math.min(POR_PAGINA, total - filas.length)} más
            </Button>
          </div>
        )}
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
