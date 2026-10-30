// Pantalla de venta: catálogo (favoritos, departamentos, búsqueda) a la izquierda y el tiquete a
// la derecha. Pensada para teclado y lector: el foco vuelve al buscador.
// Atajos: F2 nueva venta en espera · F3 buscar · F4 venta simple (precio libre) · F7 cliente ·
// F8 descuento al total · F12 cobrar · Supr quitar línea · Ctrl+1…9 pestañas · ↑↓ elegir.
// "3*código" agrega 3 unidades.
import { Banknote, Plus, Printer, ReceiptText, ScanBarcode, Search, ShoppingCart, Star, Trash2, UserRound, X, Percent, Minus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSesion } from "../app/sesion";
import { textoError } from "../components/Mensaje";
import Modal from "../components/Modal";
import PinDueno from "../components/PinDueno";
import { listarDepartamentos } from "../db/departamentos";
import { listarBancos, listarFormasPago } from "../db/formasPago";
import { buscarProductos, marcarFavorito, productoPorCodigo } from "../db/productos";
import { cobrarVenta, crearEspera, descartarEspera, guardarEspera, listarEsperas, type ResultadoCobro } from "../db/ventas";
import { leerMontoEntero } from "../lib/texto";
import { monto } from "../lib/tickets";
import { ulid } from "../lib/ulid";
import { useEscaner } from "../lib/useEscaner";
import { bruto, calcularTotales, estadoVacio, importeLinea, necesitaAutorizacion, topeDescuento } from "../lib/venta/calculo";
import { imprimirVenta } from "../lib/venta/imprimir";
import type { Banco, Departamento, EstadoEspera, FormaPago, LineaEspera, PagoEntrada, Producto, ProductoLista, VentaEspera } from "../tipos";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import { useConfirmar } from "../ui/Confirmar";
import Field from "../ui/Field";
import ClienteVenta from "./venta/ClienteVenta";
import Cobro from "./venta/Cobro";
import PrecioLibre from "./venta/PrecioLibre";

type Dialogo = "cobro" | "libre" | "cliente" | "descuento" | null;
const FAVORITOS = "★";

/** Monto en colones a partir de "500" (¢) o "10" (%) sobre `base`. */
function leerDescuento(texto: string, base: number, modo: "¢" | "%"): number | null {
  const t = texto.trim();
  if (!t) return 0;
  if (modo === "%") {
    const n = Number(t.replace(",", "."));
    return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round((base * n) / 100) : null;
  }
  return leerMontoEntero(t);
}

export default function Venta() {
  const { actor, config, puede } = useSesion();
  const confirmar = useConfirmar();
  const [esperas, setEsperas] = useState<VentaEspera[]>([]);
  const [activaId, setActivaId] = useState<string | null>(null);
  const [departamentos, setDepartamentos] = useState<Departamento[]>([]);
  const [formas, setFormas] = useState<FormaPago[]>([]);
  const [bancos, setBancos] = useState<Banco[]>([]);
  const [texto, setTexto] = useState("");
  const [filtro, setFiltro] = useState<string>(FAVORITOS); // ★ o id de departamento
  const [productos, setProductos] = useState<ProductoLista[]>([]);
  const [cargando, setCargando] = useState(true);
  const [sel, setSel] = useState(0); // tarjeta resaltada (teclado)
  const [lineaSel, setLineaSel] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState<Dialogo>(null);
  const [pendiente, setPendiente] = useState<EstadoEspera | null>(null); // cambio que espera PIN de dueño
  const [cobrada, setCobrada] = useState<(ResultadoCobro & { errorImpresion?: string }) | null>(null);
  const [aviso, setAviso] = useState("");
  const [error, setError] = useState("");
  const buscador = useRef<HTMLInputElement>(null);

  const activa = esperas.find((e) => e.id === activaId) ?? null;
  const estado = activa?.estado ?? estadoVacio();
  const t = useMemo(() => calcularTotales(estado, config.redondeo_total), [estado, config.redondeo_total]);
  const tope = topeDescuento(actor.rol, config.descuento_max_pct);
  const modal = dialogo !== null || pendiente !== null || cobrada !== null;
  const buscando = texto.replace(/^\d+\*/, "").trim().length >= 2;

  // ── Carga inicial: las ventas en espera vienen de SQLite (sobreviven a un apagón).
  // El ref evita que React (StrictMode en desarrollo) la corra dos veces y cree dos pestañas.
  const iniciado = useRef(false);
  useEffect(() => {
    if (iniciado.current) return;
    iniciado.current = true;
    (async () => {
      setDepartamentos(await listarDepartamentos());
      setFormas(await listarFormasPago());
      setBancos(await listarBancos());
      let l = await listarEsperas();
      if (!l.length) l = [await crearEspera(actor, estadoVacio())];
      ponerEsperas(l);
      setActivaId(l[0].id);
    })().catch((e) => setError(textoError(e)));
  }, []);

  // ── El foco vuelve al buscador cuando nada tiene el foco; navegar con Tab no se interrumpe.
  useEffect(() => {
    if (modal) return;
    const i = setInterval(() => {
      const a = document.activeElement;
      if (!a || a === document.body) buscador.current?.focus();
    }, 300);
    buscador.current?.focus();
    return () => clearInterval(i);
  }, [modal, activaId]);
  const alBuscador = () => setTimeout(() => buscador.current?.focus(), 0);

  // Copia "al instante" de las pestañas: dos lecturas del lector en el mismo milisegundo
  // no deben pisarse (React todavía no volvió a dibujar entre una y otra).
  const esperasRef = useRef<VentaEspera[]>([]);
  const activaRef = useRef<string | null>(null);
  activaRef.current = activaId;
  const ponerEsperas = (l: VentaEspera[]) => {
    esperasRef.current = l;
    setEsperas(l);
  };
  const actual = (): EstadoEspera => esperasRef.current.find((e) => e.id === activaRef.current)?.estado ?? estadoVacio();

  /** Aplica un cambio a la venta activa y lo guarda en la base de inmediato. */
  const actualizar = useCallback((nuevo: EstadoEspera) => {
    const id = activaRef.current;
    if (!id) return;
    ponerEsperas(esperasRef.current.map((e) => (e.id === id ? { ...e, estado: nuevo } : e)));
    guardarEspera(id, nuevo).catch((e) => setError("No se pudo guardar la venta en espera: " + textoError(e)));
  }, []);

  /** Igual que actualizar, pero si el descuento pasa el tope del rol, pide antes el PIN del dueño. */
  function actualizarConTope(nuevo: EstadoEspera) {
    const pct = calcularTotales(nuevo, config.redondeo_total).pctDescuento;
    if (necesitaAutorizacion(nuevo, pct, tope)) setPendiente(nuevo);
    else actualizar(nuevo);
  }

  function agregarLinea(l: LineaEspera) {
    setAviso("");
    // Mismo producto sin descuento: suma cantidad en vez de repetir la línea.
    const e = actual();
    const igual = l.productoId ? e.lineas.find((x) => x.productoId === l.productoId && !x.descuento && x.precioUnitario === l.precioUnitario) : null;
    const lineas = igual ? e.lineas.map((x) => (x === igual ? { ...x, cantidad: x.cantidad + l.cantidad } : x)) : [...e.lineas, l];
    actualizar({ ...e, lineas });
    setLineaSel(null);
  }

  function agregarProducto(p: Producto, cantidad = 1, codigo: string | null = null) {
    agregarLinea({
      id: ulid(),
      productoId: p.id,
      codigo,
      descripcion: p.nombre,
      departamentoId: p.departamentoId,
      cantidad,
      precioUnitario: p.precio,
      descuento: 0,
      tasaIva: p.tasaIva,
      exento: p.exento,
    });
  }

  async function porCodigo(codigo: string, cantidad = 1): Promise<boolean> {
    const p = await productoPorCodigo(codigo);
    if (!p) return false;
    if (!p.activo) {
      setAviso(`"${p.nombre}" está desactivado.`);
      return true;
    }
    agregarProducto(p, cantidad, codigo);
    return true;
  }

  // ── Lector: en cualquier parte de la pantalla (salvo con un diálogo abierto).
  useEscaner(
    async (c) => {
      if (!(await porCodigo(c))) setAviso(`El código ${c} no está registrado. Use Venta simple o asócielo en Productos.`);
    },
    { activo: !modal && !!activa, debounceMs: config.escaner_debounce_ms },
  );

  // ── Catálogo: búsqueda, favoritos o un departamento.
  const consulta = useRef(0);
  const cargarCatalogo = useCallback(async () => {
    const n = ++consulta.current;
    const q = texto.replace(/^\d+\*/, "").trim();
    setCargando(true);
    try {
      const r = await buscarProductos({
        texto: q.length >= 2 ? q : undefined,
        soloFavoritos: q.length < 2 && filtro === FAVORITOS,
        departamentoId: q.length < 2 && filtro !== FAVORITOS ? filtro : undefined,
        limite: q.length >= 2 ? 60 : 240,
      });
      if (n !== consulta.current) return;
      setProductos(r.filas);
      setSel(0);
    } catch (e) {
      setError(textoError(e));
    } finally {
      if (n === consulta.current) setCargando(false);
    }
  }, [texto, filtro]);
  useEffect(() => {
    const h = setTimeout(() => void cargarCatalogo(), buscando ? 120 : 0);
    return () => clearTimeout(h);
  }, [cargarCatalogo]);

  async function enterBuscador() {
    const m = /^(\d+)\*(.+)$/.exec(texto.trim());
    const cantidad = m ? Math.max(1, Number(m[1])) : 1;
    const q = (m ? m[2] : texto).trim();
    if (!q) return;
    // Código escrito a mano (alfanumérico, p. ej. 07toc) → directo.
    if (await porCodigo(q, cantidad)) return setTexto("");
    if (buscando && productos[sel]) {
      agregarProducto(productos[sel], cantidad);
      setTexto("");
    } else setAviso(`Nada coincide con "${q}".`);
  }

  async function alternarFavorito(p: ProductoLista) {
    try {
      await marcarFavorito(actor, p.id, !p.favorito);
      if (filtro === FAVORITOS && !buscando) setProductos((l) => l.filter((x) => x.id !== p.id));
      else setProductos((l) => l.map((x) => (x.id === p.id ? { ...x, favorito: !p.favorito } : x)));
    } catch (e) {
      setError(textoError(e));
    }
  }

  // ── Pestañas
  async function nuevaEspera() {
    try {
      const e = await crearEspera(actor, estadoVacio());
      ponerEsperas([...esperasRef.current, e].sort((a, b) => a.numero - b.numero));
      setActivaId(e.id);
      setTexto("");
      alBuscador();
    } catch (err) {
      setError(textoError(err));
    }
  }

  async function descartar(e: VentaEspera) {
    // Confirmación solo si hay algo que perder.
    if (
      e.estado.lineas.length &&
      !(await confirmar({
        titulo: `¿Descartar la venta ${e.numero}?`,
        texto: `${e.estado.lineas.length} producto(s) por ${monto(calcularTotales(e.estado, config.redondeo_total).total)}. Queda anotado en la bitácora.`,
        aceptar: "Descartar",
        peligro: true,
      }))
    )
      return;
    await descartarEspera(actor, e.id, config.redondeo_total);
    const resto = esperasRef.current.filter((x) => x.id !== e.id);
    if (!resto.length) resto.push(await crearEspera(actor, estadoVacio()));
    ponerEsperas(resto);
    if (activaId === e.id) setActivaId(resto[0].id);
    alBuscador();
  }

  // ── Líneas
  const setLinea = (id: string, patch: Partial<LineaEspera>) => {
    const e = actual();
    actualizarConTope({ ...e, lineas: e.lineas.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  };
  const quitarLinea = (id: string) => {
    const e = actual();
    actualizar({ ...e, lineas: e.lineas.filter((l) => l.id !== id) });
    setLineaSel(null);
    alBuscador();
  };

  // ── Cobro
  async function cobrar(pagos: PagoEntrada[]) {
    if (!activa) return;
    const r = await cobrarVenta(actor, activa.id, estado, pagos);
    let errorImpresion: string | undefined;
    if (config.imprime_tiquete) {
      try {
        await imprimirVenta(actor, r.ventaId, config, { abrirGaveta: r.hayEfectivo && config.abrir_gaveta_efectivo });
      } catch (e) {
        errorImpresion = textoError(e);
      }
    }
    setDialogo(null);
    setCobrada({ ...r, errorImpresion });
    // La venta cobrada sale de las pestañas; las demás quedan como estaban.
    const resto = esperasRef.current.filter((e) => e.id !== activa.id);
    if (!resto.length) resto.push(await crearEspera(actor, estadoVacio()));
    ponerEsperas(resto);
    setActivaId(resto[0].id);
  }

  async function reimprimir() {
    if (!cobrada) return;
    try {
      await imprimirVenta(actor, cobrada.ventaId, config, { abrirGaveta: cobrada.hayEfectivo && config.abrir_gaveta_efectivo });
      setCobrada({ ...cobrada, errorImpresion: undefined });
    } catch (e) {
      setCobrada({ ...cobrada, errorImpresion: textoError(e) });
    }
  }

  // ── Atajos de teclado
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (cobrada && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        return setCobrada(null);
      }
      if (modal) return;
      const atajos: Record<string, () => void> = {
        F2: () => void nuevaEspera(),
        F3: () => buscador.current?.select(),
        F4: () => setDialogo("libre"),
        F7: () => puede("clientes.basico") && setDialogo("cliente"),
        F8: () => estado.lineas.length && setDialogo("descuento"),
        F12: () => estado.lineas.length && setDialogo("cobro"),
      };
      if (atajos[e.key]) {
        e.preventDefault();
        return atajos[e.key]();
      }
      if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
        const x = esperas[Number(e.key) - 1];
        if (x) e.preventDefault(), setActivaId(x.id);
        return;
      }
      const enBuscador = document.activeElement === buscador.current;
      if (e.key === "Delete" && lineaSel && (!enBuscador || !texto)) {
        e.preventDefault();
        quitarLinea(lineaSel);
      }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && enBuscador && buscando && productos.length) {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setSel((s) => (s + d + productos.length) % productos.length);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const nombreDepto = (id: string) => departamentos.find((d) => d.id === id)?.nombre ?? "";
  const enVenta = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of estado.lineas) if (l.productoId) m.set(l.productoId, (m.get(l.productoId) ?? 0) + l.cantidad);
    return m;
  }, [estado.lineas]);
  const articulos = estado.lineas.reduce((s, l) => s + l.cantidad, 0);
  const puedeFavoritos = puede("productos");

  return (
    <div className="venta">
      {/* ─── Catálogo ─── */}
      <section className="catalogo" aria-label="Productos">
        <div className="busqueda">
          <label className="busqueda-campo">
            <span className="sr-only">Buscar o escanear producto</span>
            <Search size={20} aria-hidden />
            <input
              ref={buscador}
              placeholder="Buscar o escanear producto"
              aria-keyshortcuts="F3"
              value={texto}
              onChange={(e) => (setTexto(e.target.value), setAviso(""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault(), void enterBuscador();
                if (e.key === "Escape") setTexto("");
              }}
            />
          </label>
        </div>

        <div className="deptos" role="group" aria-label="Filtrar">
          <button className="tab" aria-pressed={!buscando && filtro === FAVORITOS} onClick={() => (setFiltro(FAVORITOS), setTexto(""), alBuscador())}>
            <Star size={16} aria-hidden /> Favoritos
          </button>
          {departamentos.map((d) => (
            <button key={d.id} className="tab" aria-pressed={!buscando && filtro === d.id} onClick={() => (setFiltro(d.id), setTexto(""), alBuscador())}>
              {d.nombre}
            </button>
          ))}
        </div>

        {aviso && <Alert tono="aviso">{aviso}</Alert>}
        {error && <Alert tono="error">{error}</Alert>}

        <div className="grilla" aria-busy={cargando}>
          {!buscando && (
            <button className="tile tile-libre" onClick={() => setDialogo("libre")} title="Atajo: F4">
              <Banknote size={30} aria-hidden strokeWidth={1.75} />
              <span>Venta simple</span>
            </button>
          )}
          {productos.map((p, i) => (
            <div key={p.id} style={{ position: "relative" }}>
              <button
                className={["tile", buscando && i === sel ? "sel" : "", enVenta.has(p.id) ? "en-venta" : ""].join(" ")}
                onClick={() => (agregarProducto(p), alBuscador())}
                aria-label={`Agregar ${p.nombre}, ${monto(p.precio)}`}
              >
                <span className="tile-nombre">{p.nombre}</span>
                <span className="tile-pie">
                  <span className="tile-dep">{p.departamento}</span>
                  <span className="tile-precio">{monto(p.precio)}</span>
                </span>
              </button>
              {enVenta.has(p.id) && <span className="tile-cant" aria-hidden>{enVenta.get(p.id)}</span>}
              {puedeFavoritos && (
                <button
                  className="tile-estrella"
                  aria-pressed={p.favorito}
                  aria-label={p.favorito ? `Quitar ${p.nombre} de favoritos` : `Agregar ${p.nombre} a favoritos`}
                  title={p.favorito ? "Quitar de favoritos" : "Marcar como favorito"}
                  onClick={() => alternarFavorito(p)}
                >
                  <Star size={18} aria-hidden />
                </button>
              )}
            </div>
          ))}
          {!cargando && productos.length === 0 && (
            <p className="grilla-aviso">
              {buscando
                ? `Nada coincide con "${texto.trim()}". Pruebe con otra palabra o escanee el código.`
                : filtro === FAVORITOS
                  ? puedeFavoritos
                    ? "Sin favoritos todavía. Elija un departamento y toque la estrella de los productos que más vende."
                    : "Sin favoritos todavía. Busque arriba o elija un departamento."
                  : "Este departamento no tiene productos."}
            </p>
          )}
        </div>
      </section>

      {/* ─── Tiquete ─── */}
      <aside className="tiquete" aria-label="Tiquete">
        <div className="tiquete-cab" role="tablist" aria-label="Ventas en espera">
          {esperas.map((e, i) => (
            <div key={e.id} className={e.id === activaId ? "pestana activa" : "pestana"}>
              <button
                role="tab"
                aria-selected={e.id === activaId}
                onClick={() => (setActivaId(e.id), alBuscador())}
                aria-keyshortcuts={i < 9 ? `Control+${i + 1}` : undefined}
                title={i < 9 ? `Ctrl+${i + 1}` : undefined}
              >
                Venta {e.numero}
                {e.id !== activaId && e.estado.lineas.length > 0 && <span className="muted">· {monto(calcularTotales(e.estado, config.redondeo_total).total)}</span>}
              </button>
              {(esperas.length > 1 || e.estado.lineas.length > 0) && (
                <button className="pestana-cerrar" onClick={() => descartar(e)} aria-label={`Descartar venta ${e.numero}`} title="Descartar">
                  <X size={16} aria-hidden />
                </button>
              )}
            </div>
          ))}
          <button className="pestana-nueva" onClick={nuevaEspera} aria-label="Nueva venta en espera" title="Nueva venta (F2)">
            <Plus size={20} aria-hidden />
          </button>
        </div>

        {puede("clientes.basico") && (
          <div className="tiquete-cliente">
            <Button
              icono={UserRound}
              className={estado.cliente || estado.nombreTiquete ? "cliente-boton con-cliente" : "cliente-boton"}
              atajo="F7"
              onClick={() => setDialogo("cliente")}
            >
              {estado.cliente?.nombre ?? estado.nombreTiquete ?? "Cliente de contado"}
              {estado.requiereFactura && " · factura"}
            </Button>
          </div>
        )}

        {estado.lineas.length === 0 ? (
          <div className="tiquete-vacio">
            <ScanBarcode size={40} aria-hidden strokeWidth={1.5} />
            <strong>Venta vacía</strong>
            Escanee o toque un producto.
          </div>
        ) : (
          <ul className="lineas">
            {estado.lineas.map((l) => (
              <LineaTiquete
                key={l.id}
                linea={l}
                abierta={l.id === lineaSel}
                subtitulo={l.productoId ? null : nombreDepto(l.departamentoId)}
                onAbrir={() => setLineaSel(l.id === lineaSel ? null : l.id)}
                onCambio={(patch) => setLinea(l.id, patch)}
                onQuitar={() => quitarLinea(l.id)}
                onError={setAviso}
              />
            ))}
          </ul>
        )}

        <div className="tiquete-pie">
          {(config.mostrar_iva || t.descuentoLineas > 0 || t.descuento > 0 || t.redondeo !== 0) && (
            <div className="totales" aria-live="polite">
              {(config.mostrar_iva || t.descuentoLineas > 0 || t.descuento > 0) && <Fila k="Subtotal" v={monto(t.bruto)} />}
              {t.descuentoLineas + t.descuento > 0 && <Fila k="Descuentos" v={"-" + monto(t.descuentoLineas + t.descuento)} />}
              {t.redondeo !== 0 && <Fila k="Redondeo" v={(t.redondeo < 0 ? "-" : "") + monto(Math.abs(t.redondeo))} />}
              {config.mostrar_iva && <Fila k="IVA incluido" v={monto(t.iva)} />}
            </div>
          )}
          <Button variante="primario" tamano="xl" className="cobrar" atajo="F12" disabled={!estado.lineas.length} onClick={() => setDialogo("cobro")}>
            Cobrar
            <span className="cobrar-monto">{monto(t.total)}</span>
          </Button>
          <div className="tiquete-acciones">
            <Button icono={Percent} atajo="F8" disabled={!estado.lineas.length} onClick={() => setDialogo("descuento")}>
              Descuento
            </Button>
            <span className="muted" style={{ alignSelf: "center", fontSize: 14 }}>
              {articulos} art.
            </span>
            {activa && estado.lineas.length > 0 && (
              <Button variante="peligro" icono={Trash2} onClick={() => descartar(activa)}>
                Descartar
              </Button>
            )}
          </div>
        </div>
      </aside>

      {dialogo === "libre" && (
        <PrecioLibre departamentos={departamentos} onCerrar={() => setDialogo(null)} onAgregar={(l) => (agregarLinea(l), setDialogo(null))} />
      )}
      {dialogo === "cliente" && (
        <ClienteVenta estado={estado} onCerrar={() => setDialogo(null)} onCambio={(c) => (actualizar({ ...actual(), ...c }), setDialogo(null))} />
      )}
      {dialogo === "descuento" && (
        <DescuentoTotal
          subtotal={t.subtotal}
          actual={estado.descuentoTotal}
          tope={tope}
          onCerrar={() => setDialogo(null)}
          onAplicar={(d) => (setDialogo(null), actualizarConTope({ ...actual(), descuentoTotal: d }))}
        />
      )}
      {dialogo === "cobro" && <Cobro total={t.total} formas={formas} bancos={bancos} onCerrar={() => setDialogo(null)} onCobrar={cobrar} />}
      {pendiente && (
        <PinDueno
          contexto="descuento"
          motivo={`El descuento (${calcularTotales(pendiente, config.redondeo_total).pctDescuento.toFixed(1)} %) pasa su máximo de ${tope} %.`}
          onCerrar={() => setPendiente(null)}
          onAutorizado={(d) => {
            actualizar({ ...pendiente, autorizacion: { duenoId: d.id, pct: calcularTotales(pendiente, config.redondeo_total).pctDescuento } });
            setPendiente(null);
          }}
        />
      )}
      {cobrada && (
        <Modal titulo={`Venta ${cobrada.numero} cobrada`} onCerrar={() => setCobrada(null)} ancho={460}>
          {cobrada.vuelto > 0 && (
            <div className="cobro-resumen ok">
              <Banknote size={24} aria-hidden /> Vuelto <strong>{monto(cobrada.vuelto)}</strong>
            </div>
          )}
          {cobrada.errorImpresion ? (
            <>
              <Alert tono="error" titulo="No se imprimió el tiquete">
                {/impresora elegida/.test(cobrada.errorImpresion)
                  ? `${cobrada.errorImpresion}.`
                  : `${cobrada.errorImpresion}. Revise que la impresora esté encendida y con papel.`}{" "}
                La venta sí quedó guardada.
              </Alert>
              <Button icono={Printer} onClick={reimprimir}>
                Reintentar impresión
              </Button>
            </>
          ) : (
            config.imprime_tiquete && (
              <p className="muted">
                <ReceiptText size={16} aria-hidden /> Tiquete enviado a la impresora.
              </p>
            )
          )}
          <div className="fila-botones">
            <Button variante="primario" tamano="lg" icono={ShoppingCart} atajo="Enter" onClick={() => setCobrada(null)} autoFocus>
              Siguiente venta
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Fila({ k, v }: { k: string; v: string }) {
  return (
    <div className="fila">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}

/** Una línea del tiquete. Clic para abrir: cantidad exacta, descuento (¢ o %) y quitar. */
function LineaTiquete(p: {
  linea: LineaEspera;
  abierta: boolean;
  subtitulo: string | null;
  onAbrir(): void;
  onCambio(patch: Partial<LineaEspera>): void;
  onQuitar(): void;
  onError(msg: string): void;
}) {
  const l = p.linea;
  const [modo, setModo] = useState<"¢" | "%">("¢");
  const [desc, setDesc] = useState(l.descuento ? String(l.descuento) : "");
  useEffect(() => {
    setModo("¢");
    setDesc(l.descuento ? String(l.descuento) : "");
  }, [p.abierta]);

  const aplicarDescuento = () => {
    const d = leerDescuento(desc, bruto(l), modo);
    if (d === null || d > bruto(l)) return p.onError(modo === "%" ? "El porcentaje va de 0 a 100." : `El descuento no puede pasar de ${monto(bruto(l))}.`);
    if (d !== l.descuento) p.onCambio({ descuento: d });
  };
  const cantidad = (c: number) => c >= 1 && p.onCambio({ cantidad: c, descuento: Math.min(l.descuento, c * l.precioUnitario) });

  return (
    <li className={p.abierta ? "linea sel" : "linea"}>
      <div className="linea-fila" onClick={p.onAbrir}>
        <div
          role="button"
          tabIndex={0}
          aria-expanded={p.abierta}
          aria-label={`${l.descripcion}: descuento y quitar`}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), p.onAbrir())}
        >
          <div className="linea-nombre">{l.descripcion}</div>
          <div className="linea-sub">
            {monto(l.precioUnitario)}
            {p.subtitulo && ` · ${p.subtitulo}`}
            {l.descuento > 0 && <span className="linea-desc"> · −{monto(l.descuento)}</span>}
          </div>
        </div>
        <div className="paso" onClick={(e) => e.stopPropagation()}>
          {l.cantidad <= 1 ? (
            <button className="paso-quitar" aria-label={`Quitar ${l.descripcion}`} title="Quitar (Supr)" onClick={p.onQuitar}>
              <Trash2 size={16} aria-hidden />
            </button>
          ) : (
            <button aria-label={`Una menos de ${l.descripcion}`} onClick={() => cantidad(l.cantidad - 1)}>
              <Minus size={16} aria-hidden />
            </button>
          )}
          <CampoNumero etiqueta={`Cantidad de ${l.descripcion}`} valor={String(l.cantidad)} onListo={(v) => (Number.isInteger(Number(v)) && Number(v) >= 1 ? cantidad(Number(v)) : p.onError("La cantidad debe ser 1 o más."))} />
          <button aria-label={`Una más de ${l.descripcion}`} onClick={() => cantidad(l.cantidad + 1)}>
            <Plus size={16} aria-hidden />
          </button>
        </div>
        <div className="linea-importe">{monto(importeLinea(l))}</div>
      </div>
      {p.abierta && (
        <div className="linea-editor">
          <label className="campo">
            Descuento
            <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
              <span className="segmento" role="group" aria-label="Tipo de descuento">
                <button aria-pressed={modo === "¢"} onClick={() => setModo("¢")}>
                  ¢
                </button>
                <button aria-pressed={modo === "%"} onClick={() => setModo("%")}>
                  %
                </button>
              </span>
              <input
                inputMode="decimal"
                value={desc}
                autoFocus
                placeholder="0"
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setDesc(e.target.value)}
                onBlur={aplicarDescuento}
                onKeyDown={(e) => e.key === "Enter" && aplicarDescuento()}
              />
            </span>
          </label>
          <span style={{ flex: 1 }} />
          {/* Con cantidad 1 la papelera ya está en el lugar del −: un solo control para quitar. */}
          {l.cantidad > 1 && (
            <Button variante="peligro" icono={Trash2} onClick={p.onQuitar} atajo="Supr">
              Quitar
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** Campo que aplica su valor al salir o con Enter (no en cada tecla). */
function CampoNumero(p: { valor: string; etiqueta: string; onListo(v: string): void }) {
  const [v, setV] = useState(p.valor);
  useEffect(() => setV(p.valor), [p.valor]);
  return (
    <input
      aria-label={p.etiqueta}
      inputMode="numeric"
      value={v}
      onChange={(e) => setV(e.target.value.replace(/\D/g, ""))}
      onBlur={() => v !== p.valor && p.onListo(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") setV(p.valor);
      }}
    />
  );
}

function DescuentoTotal(p: { subtotal: number; actual: number; tope: number; onAplicar(d: number): void; onCerrar(): void }) {
  const [modo, setModo] = useState<"¢" | "%">("¢");
  const [texto, setTexto] = useState(p.actual ? String(p.actual) : "");
  const [error, setError] = useState("");
  const vista = leerDescuento(texto, p.subtotal, modo);
  return (
    <Modal titulo="Descuento al total" onCerrar={p.onCerrar} ancho={420}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (vista === null || vista > p.subtotal) return setError(modo === "%" ? "El porcentaje va de 0 a 100." : `No puede pasar de ${monto(p.subtotal)}.`);
          p.onAplicar(vista);
        }}
      >
        <Field label="Monto" ayuda={modo === "%" && vista !== null ? `= ${monto(vista)} de ${monto(p.subtotal)}` : `Subtotal ${monto(p.subtotal)} · máximo sin autorización ${p.tope} %`} error={error}>
          <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
            <span className="segmento" role="group" aria-label="Tipo de descuento">
              <button type="button" aria-pressed={modo === "¢"} onClick={() => setModo("¢")}>
                ¢
              </button>
              <button type="button" aria-pressed={modo === "%"} onClick={() => setModo("%")}>
                %
              </button>
            </span>
            <input autoFocus className="big" inputMode="decimal" style={{ flex: 1 }} value={texto} onChange={(e) => (setTexto(e.target.value), setError(""))} />
          </span>
        </Field>
        <div className="fila-botones">
          <Button type="submit" variante="primario" atajo="Enter">
            Aplicar
          </Button>
          {p.actual > 0 && (
            <Button variante="peligro" icono={X} onClick={() => p.onAplicar(0)}>
              Quitar descuento
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
