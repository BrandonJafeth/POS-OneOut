// Pantalla de venta: catálogo (favoritos, departamentos, búsqueda) a la izquierda y el tiquete a
// la derecha. Pensada para teclado y lector: el foco vuelve al buscador.
// Atajos: F2 nueva venta en espera · F3 buscar · F4 venta simple (precio libre) · F7 cliente ·
// F8 descuento al total · F12 cobrar · Supr quitar línea · Ctrl+1…9 pestañas · ↑↓ elegir.
// "3*código" agrega 3 unidades.
// Las pestañas viven en useEsperas, el catálogo en useCatalogo y las reglas de dinero en
// lib/venta/calculo.ts; aquí queda lo que une todo con la pantalla.
import { Banknote, Check, Inbox, Landmark, LockOpen, Plus, Printer, ReceiptText, ScanBarcode, Search, ShoppingCart, Star, Trash2, UserRound, X, Percent, Minus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSesion } from "../app/sesion";
import { textoError } from "../components/Mensaje";
import Modal from "../components/Modal";
import PinDueno from "../components/PinDueno";
import { listarDepartamentos } from "../db/departamentos";
import { listarBancos, listarFormasPago } from "../db/formasPago";
import { ORDENES_PRODUCTOS, productoPorCodigo, type OrdenProductos } from "../db/productos";
import { autorizarDescuento, cobrarVenta, type ResultadoCobro } from "../db/ventas";
import { conMiles, plural } from "../lib/texto";
import { monto } from "../lib/tickets";
import { ulid } from "../lib/ulid";
import { useEscaner } from "../lib/useEscaner";
import { bruto, calcularTotales, conLinea, estadoVacio, importeLinea, leerDescuento, necesitaAutorizacion, topeDescuento } from "../lib/venta/calculo";
import { abrirGavetaVenta, imprimirVenta } from "../lib/venta/imprimir";
import type { Banco, Departamento, EstadoEspera, FormaPago, LineaEspera, PagoEntrada, Producto, VentaEspera } from "../tipos";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import CampoMonto from "../ui/CampoMonto";
import { useToast } from "../ui/Toast";
import Field from "../ui/Field";
import ClienteVenta from "./venta/ClienteVenta";
import Cobro from "./venta/Cobro";
import PrecioLibre from "./venta/PrecioLibre";
import { FAVORITOS, useCatalogo } from "./venta/useCatalogo";
import { useEsperas } from "./venta/useEsperas";
import { AbrirCaja, NoVenta } from "./caja/Dialogos";
import { fondoPildora, textoSobre } from "../ui/departamentos";

type Dialogo = "cobro" | "libre" | "cliente" | "descuento" | "noventa" | null;

export default function Venta() {
  const { actor, usuario, config, puede, caja, recargarCaja, irA } = useSesion();
  const toast = useToast();
  const [abrirCaja, setAbrirCaja] = useState(false);
  const [departamentos, setDepartamentos] = useState<Departamento[]>([]);
  const [formas, setFormas] = useState<FormaPago[]>([]);
  const [bancos, setBancos] = useState<Banco[]>([]);
  const [texto, setTexto] = useState("");
  const [filtro, setFiltro] = useState<string>(FAVORITOS); // ★ o id de departamento
  const [lineaSel, setLineaSel] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState<Dialogo>(null);
  const [pendiente, setPendiente] = useState<EstadoEspera | null>(null); // cambio que espera PIN de dueño
  const [cobrada, setCobrada] = useState<(ResultadoCobro & { errorImpresion?: string; errorGaveta?: string }) | null>(null);
  const [aviso, setAviso] = useState("");
  const [error, setError] = useState("");
  const buscador = useRef<HTMLInputElement>(null);
  const tabs = useEsperas(setError);
  const { esperas, activa, activaId, setActivaId, actual, actualizar } = tabs;
  const { productos, total: totalCatalogo, cargando, buscando, sel, setSel, orden, cambiarOrden, grilla, finGrilla, alternarFavorito } = useCatalogo(texto, filtro, setError);

  const estado = activa?.estado ?? estadoVacio();
  const t = useMemo(() => calcularTotales(estado, config.redondeo_total), [estado, config.redondeo_total]);
  const tope = topeDescuento(actor.rol, config.descuento_max_pct);
  const modal = dialogo !== null || pendiente !== null || cobrada !== null;

  useEffect(() => {
    (async () => {
      setDepartamentos(await listarDepartamentos());
      setFormas(await listarFormasPago());
      setBancos(await listarBancos());
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

  /** Igual que actualizar, pero si el descuento pasa el tope del rol, pide antes el PIN del dueño. */
  function actualizarConTope(nuevo: EstadoEspera) {
    const pct = calcularTotales(nuevo, config.redondeo_total).pctDescuento;
    if (necesitaAutorizacion(nuevo, pct, tope)) setPendiente(nuevo);
    else actualizar(nuevo);
  }

  function agregarLinea(l: LineaEspera) {
    setAviso("");
    actualizar(conLinea(actual(), l));
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

  // ── Pestañas
  async function nuevaEspera() {
    if (!(await tabs.nueva())) return;
    setTexto("");
    alBuscador();
  }

  // Descartar no pregunta: se hace al instante y el aviso ofrece "Deshacer" unos segundos
  // (menos diálogos, y un toque equivocado se recupera). Queda anotado en la bitácora igual.
  async function descartar(e: VentaEspera) {
    if (!(await tabs.descartar(e))) return;
    alBuscador();
    if (!e.estado.lineas.length) return;
    toast.mostrar({
      tono: "info",
      titulo: `Venta ${e.numero} descartada`,
      texto: `${plural(e.estado.lineas.length, "producto", "productos")} · ${monto(calcularTotales(e.estado, config.redondeo_total).total)}`,
      accion: { texto: "Deshacer", onClick: () => void recuperar(e) },
    });
  }

  async function recuperar(e: VentaEspera) {
    if (!(await tabs.recuperar(e))) return;
    toast.ok("Venta recuperada");
    alBuscador();
  }

  // ── Líneas
  const setLinea = (id: string, patch: Partial<LineaEspera>) => {
    const e = actual();
    actualizarConTope({ ...e, lineas: e.lineas.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  };
  // Con tope: quitar una línea sube el % del descuento al total (¢1.000 de ¢10.000 → de ¢5.000).
  const quitarLinea = (id: string) => {
    const e = actual();
    actualizarConTope({ ...e, lineas: e.lineas.filter((l) => l.id !== id) });
    setLineaSel(null);
    alBuscador();
  };

  // ── Cobro
  // La venta ya quedó guardada al cobrar: si la impresora o la gaveta fallan, se avisa y se sigue.
  async function cobrar(pagos: PagoEntrada[]) {
    if (!activa) return;
    const r = await cobrarVenta(actor, activa.id, estado, pagos);
    let errorImpresion: string | undefined;
    let errorGaveta: string | undefined;
    if (config.imprime_tiquete) {
      try {
        await imprimirVenta(r.ventaId, config);
      } catch (e) {
        errorImpresion = textoError(e);
      }
    }
    if (r.abrirGaveta) {
      try {
        await abrirGavetaVenta(r.ventaId);
      } catch (e) {
        errorGaveta = textoError(e);
      }
    }
    setDialogo(null);
    setCobrada({ ...r, errorImpresion, errorGaveta });
    // La venta cobrada sale de las pestañas; las demás quedan como estaban.
    await tabs.quitar(activa.id);
  }


  async function reimprimir() {
    if (!cobrada) return;
    try {
      await imprimirVenta(cobrada.ventaId, config);
      setCobrada({ ...cobrada, errorImpresion: undefined });
      toast.ok("Tiquete enviado a la impresora.");
    } catch (e) {
      setCobrada({ ...cobrada, errorImpresion: textoError(e) });
    }
  }

  async function reintentarGaveta() {
    if (!cobrada) return;
    try {
      await abrirGavetaVenta(cobrada.ventaId);
      setCobrada({ ...cobrada, errorGaveta: undefined });
      toast.ok("Gaveta abierta.");
    } catch (e) {
      setCobrada({ ...cobrada, errorGaveta: textoError(e) });
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

  // Sin caja abierta de hoy, o con un turno que este usuario no puede usar (turno por persona), no se
  // vende (Rust también lo rechaza al cobrar). Con turno compartido, cualquiera vende en el abierto.
  const ajena = !!caja?.turno && !caja.puedeUsar;
  if (caja && (!caja.turno || caja.deOtroDia || ajena))
    return (
      <div className="screen centro">
        <section className="card login-card">
          {ajena ? (
            <>
              <h1>La caja la tiene abierta {caja.turno?.usuarioApertura}</h1>
              <p className="muted">
                En este negocio cada persona usa su propio turno. {caja.turno?.usuarioApertura} debe cerrar su caja con el conteo (o el dueño)
                y después usted abre la suya.
              </p>
            </>
          ) : caja.deOtroDia ? (
            <>
              <h1>Quedó abierta la caja del {caja.turno?.dia}</h1>
              <p className="muted">Ciérrela con el conteo del efectivo antes de vender hoy.</p>
              <Button variante="primario" tamano="lg" icono={Landmark} ancho onClick={() => irA("caja")}>
                Ir a cerrar la caja
              </Button>
            </>
          ) : (
            <>
              <h1>La caja está cerrada</h1>
              <p className="muted">Ábrala contando el fondo para empezar a vender.</p>
              {puede("caja") ? (
                <Button variante="primario" tamano="lg" icono={LockOpen} ancho onClick={() => setAbrirCaja(true)}>
                  Abrir caja
                </Button>
              ) : (
                <Alert tono="aviso">Pida a un cajero o al dueño que abra la caja.</Alert>
              )}
            </>
          )}
        </section>
        {abrirCaja && <AbrirCaja estado={caja} onCerrar={() => setAbrirCaja(false)} onAbierta={() => (setAbrirCaja(false), void recargarCaja())} />}
      </div>
    );

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

        {/* Píldoras: cada departamento con su color (texto blanco o negro según el contraste). La elegida
            se marca también con un borde grueso y un ✓, no solo con el color. */}
        <div className="deptos" role="group" aria-label="Filtrar por departamento">
          <button className="pildora pildora-fav" aria-pressed={!buscando && filtro === FAVORITOS} onClick={() => (setFiltro(FAVORITOS), setTexto(""), alBuscador())}>
            {!buscando && filtro === FAVORITOS ? <Check size={18} aria-hidden strokeWidth={3} /> : <Star size={18} aria-hidden />} Favoritos
          </button>
          {departamentos.map((d, i) => {
            const fondo = fondoPildora(d, i, config.departamentos_color);
            const activo = !buscando && filtro === d.id;
            return (
              <button
                key={d.id}
                className={fondo ? "pildora" : "pildora pildora-neutra"}
                style={fondo ? { background: fondo, color: textoSobre(fondo) } : undefined}
                aria-pressed={activo}
                onClick={() => (setFiltro(d.id), setTexto(""), alBuscador())}
              >
                {activo && <Check size={18} aria-hidden strokeWidth={3} />}
                {d.nombre}
              </button>
            );
          })}
        </div>

        <div className="catalogo-barra">
          <span className="muted" aria-live="polite">
            {cargando && !productos.length
              ? "Cargando…"
              : totalCatalogo === 1
                ? "1 producto"
                : `${totalCatalogo.toLocaleString("es-CR")} productos`}
          </span>
          <span style={{ flex: 1 }} />
          {caja?.puedeUsar && (
            <Button variante="fantasma" icono={Inbox} onClick={() => setDialogo("noventa")} title="Abrir la gaveta sin vender (cambio de billetes…). Queda anotado.">
              No venta
            </Button>
          )}
          <label className="catalogo-orden">
            <span>Ordenar</span>
            <select value={orden} onChange={(e) => (cambiarOrden(e.target.value as OrdenProductos), alBuscador())}>
              {Object.entries(ORDENES_PRODUCTOS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>

        {aviso && <Alert tono="aviso">{aviso}</Alert>}
        {error && <Alert tono="error">{error}</Alert>}

        <div className="grilla" ref={grilla} aria-busy={cargando}>
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
          {/* Marca del final: al verse, carga la siguiente tanda (scroll continuo, sin páginas). */}
          <div ref={finGrilla} className={productos.length < totalCatalogo ? "grilla-fin" : "grilla-fin oculto"} aria-hidden>
            {productos.length < totalCatalogo && "Cargando más productos…"}
          </div>
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
                {e.usuarioId !== usuario.id && <span className="muted"> · {e.usuario.split(" ")[0]}</span>}
                {e.id !== activaId && e.estado.lineas.length > 0 && <span className="muted"> · {monto(calcularTotales(e.estado, config.redondeo_total).total)}</span>}
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
      {dialogo === "noventa" && caja && (
        <NoVenta motivos={caja.noVentaMotivos} onCerrar={() => (setDialogo(null), alBuscador())} onListo={() => (setDialogo(null), toast.ok("Gaveta abierta. Quedó anotado."), alBuscador())} />
      )}
      {dialogo === "cobro" && <Cobro total={t.total} formas={formas} bancos={bancos} onCerrar={() => setDialogo(null)} onCobrar={cobrar} />}
      {pendiente && (
        <PinDueno
          motivo={`El descuento (${calcularTotales(pendiente, config.redondeo_total).pctDescuento.toFixed(1)} %) pasa su máximo de ${tope} %.`}
          onCerrar={() => setPendiente(null)}
          onPin={async (pin) => {
            if (!activaId) return;
            // Rust verifica el PIN y emite un permiso de un solo uso para esta venta y este %.
            const a = await autorizarDescuento(activaId, calcularTotales(pendiente, config.redondeo_total).pctDescuento, pin);
            actualizar({ ...pendiente, autorizacion: a });
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
          {cobrada.errorGaveta && (
            <>
              <Alert tono="aviso" titulo="La gaveta no abrió">
                {cobrada.errorGaveta}
              </Alert>
              <Button icono={Inbox} onClick={reintentarGaveta}>
                Reintentar abrir la gaveta
              </Button>
            </>
          )}
          {cobrada.errorImpresion ? (
            <>
              <Alert tono="error" titulo="No se imprimió el tiquete">
                {cobrada.errorImpresion} La venta sí quedó guardada: puede reintentar ahora o reimprimirla después desde Ventas del día.
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
  const [desc, setDesc] = useState(conMiles(String(l.descuento)));
  useEffect(() => {
    setModo("¢");
    setDesc(conMiles(String(l.descuento)));
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
                <button type="button" aria-pressed={modo === "¢"} onClick={() => (setModo("¢"), setDesc("0"))}>
                  ¢
                </button>
                <button type="button" aria-pressed={modo === "%"} onClick={() => (setModo("%"), setDesc("0"))}>
                  %
                </button>
              </span>
              {modo === "¢" ? (
                <CampoMonto autoFocus valor={desc} onCambio={setDesc} onBlur={aplicarDescuento} onKeyDown={(e) => e.key === "Enter" && aplicarDescuento()} />
              ) : (
                <CampoPorcentaje autoFocus valor={desc} onCambio={setDesc} onBlur={aplicarDescuento} onKeyDown={(e) => e.key === "Enter" && aplicarDescuento()} />
              )}
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

/** Porcentaje 0–100 con % fijo; igual que CampoMonto: valor real, seleccionado al tocarlo. */
function CampoPorcentaje({ valor, onCambio, ...rest }: { valor: string; onCambio(t: string): void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <span className="monto-campo porcentaje">
      <input
        className="precio"
        inputMode="decimal"
        autoComplete="off"
        value={valor}
        onFocus={(e) => e.target.select()}
        onChange={(e) => onCambio(e.target.value.replace(/[^\d.,]/g, ""))}
        {...rest}
      />
      <span aria-hidden>%</span>
    </span>
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
  const [texto, setTexto] = useState(conMiles(String(p.actual)));
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
              <button type="button" aria-pressed={modo === "¢"} onClick={() => (setModo("¢"), setTexto("0"), setError(""))}>
                ¢
              </button>
              <button type="button" aria-pressed={modo === "%"} onClick={() => (setModo("%"), setTexto("0"), setError(""))}>
                %
              </button>
            </span>
            {modo === "¢" ? (
              <CampoMonto autoFocus valor={texto} onCambio={(t) => (setTexto(t), setError(""))} />
            ) : (
              <CampoPorcentaje autoFocus valor={texto} onCambio={(t) => (setTexto(t), setError(""))} />
            )}
          </span>
        </Field>
        <div className="fila-botones modal-acciones">
          {p.actual > 0 && (
            <Button variante="fantasma" className="texto-peligro" icono={X} onClick={() => p.onAplicar(0)}>
              Quitar descuento
            </Button>
          )}
          <span className="separador" />
          <Button type="submit" variante="primario" atajo="Enter">
            Aplicar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
