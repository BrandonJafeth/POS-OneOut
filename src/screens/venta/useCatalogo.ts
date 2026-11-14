// Catálogo de la pantalla de venta: búsqueda, favoritos o un departamento, con scroll continuo.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSesion } from "../../app/sesion";
import { textoError } from "../../components/Mensaje";
import { buscarProductos, marcarFavorito, ORDENES_PRODUCTOS, type OrdenProductos } from "../../db/productos";
import type { ProductoLista } from "../../tipos";

export const FAVORITOS = "★";
const POR_PAGINA = 60;

/** Lo buscado sin el "3*" de cantidad. Con menos de 2 letras no se busca: se muestra el filtro. */
export const textoBuscado = (texto: string) => texto.replace(/^\d+\*/, "").trim();

/**
 * Lectura del lector con "3*" escrito antes en el buscador: cuántas y qué código. Con una pausa, el
 * lector lee solo el código y el "3*" queda en el buscador; escaneando enseguida del "*", la ráfaga
 * trae "3*7501234…" pegado.
 */
export function lecturaConCantidad(codigo: string, texto: string): { codigo: string; cantidad: number } {
  const pegado = /^(\d+)\*(.+)$/.exec(codigo.trim());
  if (pegado) return { codigo: pegado[2].trim(), cantidad: Math.max(1, Number(pegado[1])) };
  const antes = /^(\d+)\*/.exec(texto.trim());
  return { codigo, cantidad: antes ? Math.max(1, Number(antes[1])) : 1 };
}

/** Orden elegido en este equipo (comodidad del cajero; si no se puede leer, A–Z). */
function ordenGuardado(): OrdenProductos {
  try {
    const o = localStorage.getItem("venta.orden");
    return o && o in ORDENES_PRODUCTOS ? (o as OrdenProductos) : "nombre";
  } catch {
    return "nombre";
  }
}

/** `filtro`: FAVORITOS o el id de un departamento. */
export function useCatalogo(texto: string, filtro: string, onError: (msg: string) => void) {
  const { actor } = useSesion();
  const [productos, setProductos] = useState<ProductoLista[]>([]);
  const [total, setTotal] = useState(0);
  const [orden, setOrden] = useState<OrdenProductos>(ordenGuardado);
  const [cargando, setCargando] = useState(true);
  const [sel, setSel] = useState(0); // tarjeta resaltada (teclado)
  const grilla = useRef<HTMLDivElement>(null);
  const buscando = textoBuscado(texto).length >= 2;

  const consulta = useRef(0);
  const cargar = useCallback(async (mas = false) => {
    const n = ++consulta.current;
    const q = textoBuscado(texto);
    setCargando(true);
    try {
      const r = await buscarProductos({
        texto: q.length >= 2 ? q : undefined,
        soloFavoritos: q.length < 2 && filtro === FAVORITOS,
        departamentoId: q.length < 2 && filtro !== FAVORITOS ? filtro : undefined,
        orden,
        limite: POR_PAGINA,
        desplazamiento: mas ? productos.length : 0,
      });
      if (n !== consulta.current) return;
      setProductos(mas ? [...productos, ...r.filas] : r.filas);
      setTotal(r.total);
      if (!mas) setSel(0), grilla.current?.scrollTo({ top: 0 });
    } catch (e) {
      onError(textoError(e));
    } finally {
      if (n === consulta.current) setCargando(false);
    }
  }, [texto, filtro, orden, productos]);
  useEffect(() => {
    const h = setTimeout(() => void cargar(), buscando ? 120 : 0);
    return () => clearTimeout(h);
    // Solo al cambiar lo buscado, el filtro o el orden (no al agregar páginas).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texto, filtro, orden]);

  // Scroll continuo: cuando el final de la grilla se acerca a la vista, se trae la siguiente tanda.
  const cargarMas = useRef(() => {});
  cargarMas.current = () => {
    if (!cargando && productos.length < total) void cargar(true);
  };
  // Callback ref: la grilla no existe mientras la caja está cerrada; se observa cuando aparece.
  const observador = useRef<IntersectionObserver | null>(null);
  const fin = useRef<HTMLDivElement | null>(null);
  const finGrilla = useCallback((el: HTMLDivElement | null) => {
    observador.current?.disconnect();
    fin.current = el;
    if (!el) return;
    observador.current = new IntersectionObserver((e) => e[0]?.isIntersecting && cargarMas.current(), {
      root: el.parentElement,
      rootMargin: "0px 0px 600px 0px",
    });
    observador.current.observe(el);
  }, []);
  // Si después de una tanda el final sigue a la vista, volver a observar hace que avise otra vez.
  useEffect(() => {
    if (!fin.current || !observador.current || cargando) return;
    observador.current.unobserve(fin.current);
    observador.current.observe(fin.current);
  }, [productos.length, cargando]);

  const cambiarOrden = (o: OrdenProductos) => {
    setOrden(o);
    try {
      localStorage.setItem("venta.orden", o);
    } catch {
      /* sin almacenamiento: solo dura esta sesión */
    }
  };

  async function alternarFavorito(p: ProductoLista) {
    try {
      await marcarFavorito(actor, p.id, !p.favorito);
      if (filtro === FAVORITOS && !buscando) setProductos((l) => l.filter((x) => x.id !== p.id)), setTotal((t) => t - 1);
      else setProductos((l) => l.map((x) => (x.id === p.id ? { ...x, favorito: !p.favorito } : x)));
    } catch (e) {
      onError(textoError(e));
    }
  }

  return { productos, total, cargando, buscando, sel, setSel, orden, cambiarOrden, grilla, finGrilla, alternarFavorito };
}
