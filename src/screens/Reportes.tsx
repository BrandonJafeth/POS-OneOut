// Reportes (dueño). Rango de FECHAS DE NEGOCIO con atajos (hoy es el día de negocio actual, que da
// Rust); los turnos abiertos van aparte, "en curso". Menú a la izquierda agrupado como el del POS
// anterior (ventas / caja y control / ganancia / inventario). El resumen compara contra el período
// anterior o contra las mismas fechas del año pasado. Cada reporte es una o más tablas ordenables;
// lo mismo se exporta a CSV y a PDF carta en Documentos\Punto de venta\Reportes\AAAA-MM.
// Rust calcula todo (reportes.rs); inventario y precios usan lo de Inventario y Productos.
import { Bookmark, ChevronRight, FileDown, FileSpreadsheet, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import { obtenerNegocio } from "../db/negocio";
import { buscarProductos } from "../db/productos";
import { reporteProformas, type ReporteProformas } from "../db/proformas";
import type { Rangos } from "../generados/Rangos";
import type { Reporte } from "../generados/Reporte";
import type { Totales } from "../generados/Totales";
import { invocar } from "../lib/invocar";
import { descargar } from "../lib/exportarCliente";
import { csvReporte, nombreArchivo, pdfReporte, type SeccionExport } from "../lib/reportes/exportar";
import { diasEntre, haceUnAnio, variacion } from "../lib/reportes/fechas";
import { AYUDA_ABONOS } from "../lib/caja/reporteZ";
import AyudaInfo from "../ui/AyudaInfo";
import { fechaHora, monto, montoConSigno } from "../lib/tickets";
import type { ProductoLista } from "../tipos";
import Alert from "../ui/Alert";
import Badge from "../ui/Badge";
import Barras from "../ui/Barras";
import Button from "../ui/Button";
import Field from "../ui/Field";
import TablaOrdenable, { type Columna } from "../ui/TablaOrdenable";
import { useToast } from "../ui/Toast";
import { DetalleTurno, Historial } from "./Caja";
import ReportesInventario from "./inventario/Reportes";

type Tab = "resumen" | "dias" | "departamentos" | "productos" | "usuarios" | "formas" | "horas" | "control" | "cobrar" | "utilidad" | "cierres" | "inventario" | "precios" | "proformas";
const GRUPOS: { titulo: string; tabs: [Tab, string][] }[] = [
  {
    titulo: "Ventas",
    tabs: [
      ["resumen", "Resumen"],
      ["dias", "Por día"],
      ["horas", "Por hora"],
      ["departamentos", "Departamentos"],
      ["productos", "Productos"],
      ["formas", "Formas de pago"],
      ["usuarios", "Usuarios"],
      ["proformas", "Proformas"],
    ],
  },
  {
    titulo: "Caja y control",
    tabs: [
      ["cierres", "Cierres de caja"],
      ["control", "Anulaciones y diferencias"],
      ["cobrar", "Apartados y crédito"],
    ],
  },
  { titulo: "Ganancia", tabs: [["utilidad", "Utilidad bruta"]] },
  {
    titulo: "Inventario",
    tabs: [
      ["inventario", "Existencias y movimientos"],
      ["precios", "Lista de precios"],
    ],
  },
];
/** Reportes que no dependen del rango de fechas de ventas. */
const SIN_RANGO: Tab[] = ["inventario", "precios"];
type Compara = "anterior" | "anio";
/** Filas de "formas de pago" que no son dinero recibido (las arma reportes.rs). */
const NO_ES_DINERO = ["Pagadas con abonos", "A crédito (por cobrar)"];

/** Tabla de una pestaña: se ve, se ordena y se exporta con la misma definición. */
interface Tabla<T = any> {
  titulo: string;
  columnas: (Columna<T> & { dinero?: boolean })[];
  filas: T[];
  total?: (string | number)[];
  vacio?: string;
}

const din = <T,>(titulo: string, f: (x: T) => number): Columna<T> & { dinero: boolean } => ({ titulo, valor: f, ver: (x) => monto(f(x)), numero: true, dinero: true });
const num = <T,>(titulo: string, f: (x: T) => number): Columna<T> => ({ titulo, valor: f, numero: true });
const txt = <T,>(titulo: string, f: (x: T) => string, ver?: (x: T) => ReactNode): Columna<T> => ({ titulo, valor: f, ver });
const FORMATO_DIA = new Intl.DateTimeFormat("es-CR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const FORMATO_DIA_ANIO = new Intl.DateTimeFormat("es-CR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const FORMATO_MES = new Intl.DateTimeFormat("es-CR", { month: "short", year: "numeric", timeZone: "UTC" });
const esFecha = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const utc = (d: string) => new Date(`${d}T00:00:00Z`);
/** "mié 18 nov". Sin fecha (todavía cargando): vacío, no un error. */
const fechaCorta = (d: string) => (esFecha(d) ? FORMATO_DIA.format(utc(d)) : "");
const fechaConAnio = (d: string) => (esFecha(d) ? FORMATO_DIA_ANIO.format(utc(d)) : "");
const tramo = (d: string, h: string, f = fechaCorta) => (d === h ? f(d) : `${f(d)} al ${f(h)}`);
const suma = <T,>(l: T[], f: (x: T) => number) => l.reduce((s, x) => s + f(x), 0);
const PORCENTAJE = new Intl.NumberFormat("es-CR", { style: "percent", maximumFractionDigits: 1 });

interface Cifra {
  etiqueta: string;
  valor: string;
  nota?: string;
  dir?: 1 | -1 | 0;
  /** Cifra secundaria: más chica, debajo. */
  menor?: boolean;
}

export default function Reportes() {
  const { config, caja, recargarCaja, irA } = useSesion();
  const toast = useToast();
  const [rangos, setRangos] = useState<Rangos | null>(null);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [tab, setTab] = useState<Tab>("resumen");
  const [compara, setCompara] = useState<Compara>("anterior");
  const [r, setR] = useState<Reporte | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const [verTurno, setVerTurno] = useState<string | null>(null);
  const [precios, setPrecios] = useState<ProductoLista[] | null>(null);
  const conCuentas = config.usa_apartados || config.usa_credito;

  // El detalle del cierre necesita el estado de la caja; si no se había cargado (o falló al
  // entrar), se pide ahora y el error se muestra, en vez de que el clic no haga nada.
  async function verCierre(id: string) {
    setError("");
    if (!caja) {
      try {
        await recargarCaja();
      } catch (e) {
        return setError(`No se pudo abrir el cierre: ${textoError(e)}`);
      }
    }
    setVerTurno(id);
  }

  useEffect(() => {
    if (tab !== "precios" || precios) return;
    buscarProductos({ limite: 10_000 }).then((x) => setPrecios(x.filas), (e) => setError(textoError(e)));
  }, [tab, precios]);
  // Proformas: no son ventas; su propio reporte por fecha de emisión.
  const [rp, setRp] = useState<ReporteProformas | null>(null);
  useEffect(() => {
    if (tab !== "proformas" || !desde || !hasta || desde > hasta) return;
    reporteProformas(desde, hasta).then(setRp, (e) => setError(textoError(e)));
  }, [tab, desde, hasta]);

  useEffect(() => {
    invocar<Rangos>("reporte_rangos").then((x) => (setRangos(x), setDesde(x.mesDesde), setHasta(x.hoy)), (e) => setError(textoError(e)));
  }, []);
  useEffect(() => {
    if (!desde || !hasta || desde > hasta) return;
    setCargando(true);
    setError("");
    invocar<Reporte>("reporte_ventas", { desde, hasta }).then(
      (x) => (setR(x), setCargando(false)),
      (e) => (setError(textoError(e)), setCargando(false)),
    );
  }, [desde, hasta]);

  const atajos: [string, string, string][] = rangos
    ? [
        ["Hoy", rangos.hoy, rangos.hoy],
        ["Ayer", rangos.ayer, rangos.ayer],
        ["Esta semana", rangos.semanaDesde, rangos.hoy],
        ["Este mes", rangos.mesDesde, rangos.hoy],
        ["Mes anterior", rangos.mesAnteriorDesde, rangos.mesAnteriorHasta],
      ]
    : [];
  const rango = tramo(desde, hasta);
  const vista =
    tab === "precios"
      ? precios
        ? listaPrecios(precios)
        : null
      : tab === "proformas"
        ? rp && vistaProformas(rp)
        : r && tab !== "cierres" && tab !== "inventario"
          ? armar(tab, r, conCuentas, compara, setTab)
          : null;
  const conRango = !SIN_RANGO.includes(tab);

  async function exportar(ext: "csv" | "pdf") {
    if (!vista) return;
    const s: SeccionExport = {
      titulo: vista.titulo,
      resumen: vista.resumen,
      tablas: vista.tablas.map((t) => ({
        titulo: t.titulo,
        columnas: t.columnas.map((c) => ({ titulo: c.titulo, numero: c.numero, dinero: c.dinero })),
        filas: t.filas.map((f) => t.columnas.map((c) => c.valor(f))),
        total: t.total,
      })),
    };
    try {
      const hoy = rangos?.hoy ?? hasta;
      const [d, h] = conRango ? [desde, hasta] : [hoy, hoy];
      const bytes = ext === "csv" ? csvReporte(s, `${d} a ${h}`) : pdfReporte(await obtenerNegocio(), s, conRango ? `Fechas de negocio: ${rango}` : `Al ${fechaConAnio(hoy)}`);
      const ruta = await descargar(nombreArchivo(vista.titulo, d, h, ext), bytes, "Reportes", h.slice(0, 7));
      toast.guardado(ext === "csv" ? "CSV guardado." : "PDF guardado.", ruta);
    } catch (e) {
      toast.error("No se pudo exportar", textoError(e));
    }
  }

  return (
    <div className="screen reportes">
      <h1>Reportes</h1>
      <div className="reportes-marco">
        <nav className="reportes-menu" aria-label="Reportes">
          {GRUPOS.map((g) => (
            <div key={g.titulo} className="reportes-grupo">
              <h2>{g.titulo}</h2>
              <ul>
                {g.tabs
                  .filter(([id]) => id !== "cobrar" || conCuentas)
                  .map(([id, t]) => (
                    <li key={id}>
                      <button type="button" aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
                        {t}
                        <ChevronRight size={16} aria-hidden />
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="reportes-principal">
          {conRango && (
            <div className="reportes-filtro">
              <div className="chips" role="group" aria-label="Rango rápido">
                {atajos.map(([t, d, h]) => (
                  <button key={t} type="button" className="tab" aria-pressed={desde === d && hasta === h} onClick={() => (setDesde(d), setHasta(h))}>
                    {t}
                  </button>
                ))}
              </div>
              <Field label="Desde">
                <input type="date" value={desde} max={hasta} onChange={(e) => e.target.value && setDesde(e.target.value)} />
              </Field>
              <Field label="Hasta">
                <input type="date" value={hasta} min={desde} onChange={(e) => e.target.value && setHasta(e.target.value)} />
              </Field>
              {tab === "resumen" && r && (
                <div className="campo">
                  <span className="campo-etiqueta" id="comparar-con">
                    Comparar con
                  </span>
                  <div className="segmento" role="group" aria-labelledby="comparar-con">
                    <button type="button" aria-pressed={compara === "anterior"} onClick={() => setCompara("anterior")} title={tramo(r.anteriorDesde, r.anteriorHasta)}>
                      Período anterior
                    </button>
                    <button type="button" aria-pressed={compara === "anio"} onClick={() => setCompara("anio")} title={tramo(r.anioDesde, r.anioHasta, fechaConAnio)}>
                      Año pasado
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <Mensaje error={error} />
          {conRango && r && r.noCoinciden.length > 0 && (
            <Alert tono="error" titulo="Hay cierres que no coinciden con el reporte">
              {r.noCoinciden.join(", ")}. Avise al técnico antes de usar estos números.
            </Alert>
          )}
          {tab === "cierres" ? (
            <>
              <Historial admin onVer={(id) => void verCierre(id)} onDia={(d) => (setDesde(d), setHasta(d), setTab("resumen"))} desde={desde} hasta={hasta} />
              {verTurno && caja && <DetalleTurno turnoId={verTurno} estado={caja} onCerrar={() => setVerTurno(null)} onCambio={recargarCaja} />}
            </>
          ) : tab === "inventario" ? (
            <ReportesInventario />
          ) : vista ? (
            <section aria-busy={cargando} className={cargando ? "reportes-cuerpo cargando" : "reportes-cuerpo"}>
              <div className="reportes-cabeza">
                <h2>
                  {vista.titulo} {conRango && <span className="muted">· {rango}</span>}
                </h2>
                <div className="row">
                  <Button icono={FileSpreadsheet} onClick={() => exportar("csv")}>
                    CSV
                  </Button>
                  <Button icono={FileDown} onClick={() => exportar("pdf")}>
                    PDF
                  </Button>
                </div>
              </div>
              {vista.resumen && <Cifras items={vista.resumen} />}
              {tab === "resumen" && r && config.usa_apartados && r.apartadosAbiertos > 0 && (
                <div className="reportes-apartados">
                  <Bookmark size={18} aria-hidden />
                  <span>
                    <strong>Apartados abiertos:</strong> {monto(r.abonadoEnApartados)} abonados a nombre de clientes ({r.apartadosAbiertos}{" "}
                    {r.apartadosAbiertos === 1 ? "apartado" : "apartados"}). No es venta todavía.
                  </span>
                  <AyudaInfo texto={AYUDA_ABONOS} etiqueta="¿Qué es un abono?" />
                  <Button variante="fantasma" onClick={() => irA("apartados")}>
                    Ver apartados
                  </Button>
                </div>
              )}
              {vista.extra}
              {vista.tablas.map((t) => (
                <TablaOrdenable key={t.titulo} titulo={t.titulo} columnas={t.columnas} filas={t.filas} total={t.total?.map((v, i) => (t.columnas[i]?.dinero && typeof v === "number" ? monto(v) : v))} vacio={t.vacio} />
              ))}
            </section>
          ) : (
            !error && <p className="muted">Cargando…</p>
          )}
        </div>
      </div>
    </div>
  );
}

interface Vista {
  titulo: string;
  resumen?: Cifra[];
  extra?: ReactNode;
  tablas: Tabla[];
}

/** Cifras del reporte: las principales grandes, las secundarias en una fila aparte más chica. */
function Cifras(p: { items: Cifra[] }) {
  const grupo = (l: Cifra[], menor: boolean) =>
    l.length > 0 && (
      <dl className={menor ? "kpis kpis-menores" : "kpis"}>
        {l.map((x) => {
          const Icono = x.dir === 1 ? TrendingUp : x.dir === -1 ? TrendingDown : Minus;
          return (
            <div key={x.etiqueta}>
              <dt>{x.etiqueta}</dt>
              <dd className="kpi-valor">{x.valor}</dd>
              {x.nota && (
                <dd className={`kpi-nota${x.dir === 1 ? " sube" : x.dir === -1 ? " baja" : ""}`}>
                  {x.dir !== undefined && <Icono size={16} aria-hidden />}
                  {x.nota}
                </dd>
              )}
            </div>
          );
        })}
      </dl>
    );
  return (
    <>
      {grupo(
        p.items.filter((x) => !x.menor),
        false,
      )}
      {grupo(
        p.items.filter((x) => x.menor),
        true,
      )}
    </>
  );
}

/** `sinBase`: no hay nada con qué comparar (ej. el año pasado sin ventas): ese texto en vez de porcentajes. */
function resumenDe(t: Totales, a: Totales, cuando: string, conCuentas: boolean, sinBase?: string): Cifra[] {
  const prom = (x: Totales) => (x.tiquetes ? Math.round(x.ventas / x.tiquetes) : 0);
  const con = (etiqueta: string, valor: string, ahora: number, antes: number): Cifra => {
    if (sinBase) return { etiqueta, valor, nota: sinBase };
    const v = variacion(ahora, antes, cuando);
    return { etiqueta, valor, nota: v?.texto, dir: v?.dir };
  };
  return [
    con("Ventas", monto(t.ventas), t.ventas, a.ventas),
    con("Tiquetes", String(t.tiquetes), t.tiquetes, a.tiquetes),
    con("Tiquete promedio", monto(prom(t)), prom(t), prom(a)),
    con("Descuentos dados", monto(t.descuentos), t.descuentos, a.descuentos),
    // Lo que casi siempre es cero no ocupa una casilla grande.
    ...(t.anulacionesPosteriores
      ? [
          { etiqueta: "Anulaciones de días anteriores", valor: monto(t.anulacionesPosteriores), menor: true },
          { etiqueta: "Neto (ventas − anulaciones)", valor: monto(t.neto), menor: true },
        ]
      : []),
    ...(conCuentas
      ? [
          { etiqueta: "Abonos recibidos (dinero)", valor: monto(t.abonos), menor: true },
          ...(t.otrosIngresos ? [{ etiqueta: "Retenido de apartados", valor: monto(t.otrosIngresos), menor: true }] : []),
        ]
      : []),
  ];
}

/** Ventas del rango para el gráfico: un día por barra (con días sin venta) hasta 62 días; si no, por mes. */
function serie(r: Reporte, compara: Compara) {
  const venta = new Map(r.porDia.map((d) => [d.dia, d.ventas]));
  const antes = new Map(r.porDiaAnio.map((d) => [d.dia, d.ventas]));
  const dias = diasEntre(r.desde, r.hasta);
  const conAntes = compara === "anio";
  if (dias.length <= 62)
    return dias.map((d) => ({ etiqueta: fechaCorta(d), valor: venta.get(d) ?? 0, antes: conAntes ? (antes.get(haceUnAnio(d)) ?? 0) : undefined }));
  const meses = new Map<string, { etiqueta: string; valor: number; antes?: number }>();
  for (const d of dias) {
    const m = meses.get(d.slice(0, 7)) ?? { etiqueta: FORMATO_MES.format(utc(d)), valor: 0, antes: conAntes ? 0 : undefined };
    m.valor += venta.get(d) ?? 0;
    if (conAntes) m.antes = (m.antes ?? 0) + (antes.get(haceUnAnio(d)) ?? 0);
    meses.set(d.slice(0, 7), m);
  }
  return [...meses.values()];
}

/** Los 5 primeros de una lista, con su parte del total como barra (vistazo; la tabla completa está en su reporte). */
function Top(p: { titulo: string; filas: { nombre: string; monto: number }[]; total: number; onVer(): void }) {
  const max = Math.max(1, ...p.filas.map((f) => f.monto));
  return (
    <section className="top">
      <div className="top-cabeza">
        <h3>{p.titulo}</h3>
        <Button variante="fantasma" onClick={p.onVer}>
          Ver todo
        </Button>
      </div>
      {p.filas.length === 0 ? (
        <p className="muted">Sin ventas.</p>
      ) : (
        <ol>
          {p.filas.slice(0, 5).map((f) => (
            <li key={f.nombre}>
              <span className="top-nombre">{f.nombre}</span>
              <span className="top-monto">
                {monto(f.monto)}
                <span className="muted"> · {p.total ? PORCENTAJE.format(f.monto / p.total) : "—"}</span>
              </span>
              <span className="top-barra" aria-hidden>
                <span style={{ width: `${(f.monto / max) * 100}%` }} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Proformas emitidas en el rango (fecha de emisión): cuántas se convirtieron, vencieron o se anularon. */
function vistaProformas(r: ReporteProformas): Vista {
  type F = ReporteProformas["filas"][number];
  const g = (x: { cantidad: number; monto: number }) => `${monto(x.monto)} · ${x.cantidad}`;
  const pct = r.emitidas.cantidad ? PORCENTAJE.format(r.convertidas.cantidad / r.emitidas.cantidad) : "—";
  return {
    titulo: "Proformas",
    resumen: [
      { etiqueta: "Emitidas", valor: g(r.emitidas) },
      { etiqueta: "Convertidas", valor: g(r.convertidas), nota: `${pct} de las emitidas` },
      { etiqueta: "Vencidas sin convertir", valor: g(r.vencidas) },
      { etiqueta: "Anuladas", valor: g(r.anuladas) },
      { etiqueta: "Todavía vigentes", valor: g(r.vigentes), menor: true },
    ],
    extra: <p className="muted">Las proformas no son ventas: no suman a las ventas ni al cierre de caja.</p>,
    tablas: [
      {
        titulo: "Proformas del período",
        columnas: [
          txt("Número", (x: F) => x.numero),
          txt("Emitida", (x: F) => x.fecha, (x: F) => fechaHora(new Date(x.fecha)).slice(0, 16)),
          txt("Cliente", (x: F) => x.cliente ?? ""),
          txt("Estado", (x: F) => x.estado),
          txt("Convertida en", (x: F) => x.convertidaEn ?? ""),
          din("Total", (x: F) => x.total),
        ],
        filas: r.filas,
        vacio: "No hay proformas en estas fechas.",
      },
    ],
  };
}

function listaPrecios(filas: ProductoLista[]): Vista {
  type P = ProductoLista;
  return {
    titulo: "Lista de precios",
    extra: <p className="muted">{filas.length} productos activos, de la A a la Z. Ordene por cualquier columna.</p>,
    tablas: [
      {
        titulo: "Productos activos",
        columnas: [txt("Código", (x: P) => x.codigos[0] ?? ""), txt("Producto", (x: P) => x.nombre), txt("Departamento", (x: P) => x.departamento), din("Precio", (x: P) => x.precio)],
        filas,
        vacio: "No hay productos activos.",
      },
    ],
  };
}

function armar(tab: Exclude<Tab, "cierres" | "inventario" | "precios" | "proformas">, r: Reporte, conCuentas: boolean, compara: Compara, irA: (t: Tab) => void): Vista {
  const total = r.totales.ventas;
  const parte = (m: number) => (total ? m / total : 0);
  const pct = <T,>(f: (x: T) => number): Columna<T> => ({ titulo: "Del total", valor: (x) => parte(f(x)), ver: (x) => (total ? PORCENTAJE.format(parte(f(x))) : "—"), numero: true });
  switch (tab) {
    case "resumen": {
      const anio = compara === "anio";
      const unDia = r.desde === r.hasta;
      // Año pasado = mismas fechas: basta el año ("vs. 2025"); un solo día lleva la fecha.
      const cuando = anio ? (unDia ? fechaConAnio(r.anioDesde) : r.anioDesde.slice(0, 4)) : tramo(r.anteriorDesde, r.anteriorHasta);
      // Sin ventas registradas en esas fechas del año pasado: se dice, sin barras ni porcentajes vacíos.
      const sinAnio = anio && r.anio.tiquetes === 0 && r.anio.ventas === 0;
      const datos = serie(r, sinAnio ? "anterior" : compara);
      const dinero = r.porForma
        .filter((f) => !NO_ES_DINERO.includes(f.forma))
        .map((f) => ({ nombre: f.forma, monto: f.ventas + f.abonos }))
        .filter((f) => f.monto > 0)
        .sort((a, b) => b.monto - a.monto);
      return {
        titulo: "Resumen de ventas",
        resumen: resumenDe(r.totales, anio ? r.anio : r.anterior, cuando, conCuentas, sinAnio ? "Sin datos del año pasado" : undefined),
        extra: (
          <>
            {r.enCurso.length > 0 && (
              <Alert tono="info" titulo="Caja abierta: todavía no se suma">
                {r.enCurso.map((t) => `Caja de ${t.abrio} (día ${fechaCorta(t.dia)}): ${t.tiquetes} tiquetes, ${monto(t.ventas)}`).join(" · ")}. Entra en los reportes al cerrarla.
              </Alert>
            )}
            {unDia ? (
              r.porHora.length > 0 && <Barras titulo="Ventas por hora" datos={r.porHora.map((h) => ({ etiqueta: `${String(h.hora).padStart(2, "0")}:00`, valor: h.monto }))} />
            ) : (
              <Barras titulo={datos.length && diasEntre(r.desde, r.hasta).length > 62 ? "Ventas por mes" : "Ventas por día"} datos={datos} leyenda={[r.desde.slice(0, 4), r.anioDesde.slice(0, 4)]} />
            )}
            <div className="tops">
              <Top titulo="Departamentos" filas={r.porDepartamento.map((d) => ({ nombre: d.nombre, monto: d.monto }))} total={total} onVer={() => irA("departamentos")} />
              <Top titulo="Productos más vendidos" filas={r.porProducto.map((d) => ({ nombre: d.nombre, monto: d.monto }))} total={total} onVer={() => irA("productos")} />
              {/* Dinero que entró por cada forma (ventas + abonos). "Pagadas con abonos" y "A crédito" no son dinero de hoy. */}
              <Top titulo="Dinero por forma de pago" filas={dinero} total={suma(dinero, (f) => f.monto)} onVer={() => irA("formas")} />
            </div>
            <p className="muted">
              {r.turnos} {r.turnos === 1 ? "cierre" : "cierres"} de caja en estas fechas. Los fondos de caja no se suman.
            </p>
          </>
        ),
        tablas: [],
      };
    }
    case "dias":
      return {
        titulo: "Ventas por día",
        tablas: [
          {
            titulo: "Por fecha de negocio",
            columnas: [
              txt("Día", (d) => d.dia, (d) => (
                <>
                  {fechaCorta(d.dia)} {d.turnos > 1 && <Badge tono="info">{d.turnos} cierres</Badge>} {d.despuesDelCierre > 0 && <Badge tono="aviso">caja tardía</Badge>}
                </>
              )),
              num("Tiquetes", (d) => d.tiquetes),
              din("Ventas", (d) => d.ventas),
              din("Descuentos", (d) => d.descuentos),
              din("Anulado después", (d) => d.anulacionesPosteriores),
              din("Neto", (d) => d.neto),
              ...(conCuentas ? [din("Abonos", (d: Reporte["porDia"][number]) => d.abonos)] : []),
            ],
            filas: r.porDia,
            total: ["Total", suma(r.porDia, (d) => d.tiquetes), r.totales.ventas, r.totales.descuentos, r.totales.anulacionesPosteriores, r.totales.neto, ...(conCuentas ? [r.totales.abonos] : [])],
          },
        ],
      };
    case "departamentos":
      return {
        titulo: "Ventas por departamento",
        tablas: [
          {
            titulo: "Departamentos (descuentos al total repartidos como en el cierre)",
            columnas: [txt("Departamento", (x) => x.nombre), num("Unidades", (x) => x.cantidad), din("Ventas", (x) => x.monto), pct((x) => x.monto)],
            filas: r.porDepartamento,
            total: ["Total", suma(r.porDepartamento, (x) => x.cantidad), total, total ? PORCENTAJE.format(1) : "—"],
          },
        ],
      };
    case "productos": {
      type P = Reporte["porProducto"][number];
      const cols = [txt("Producto", (x: P) => x.nombre), num("Unidades", (x: P) => x.cantidad), din("Ventas", (x: P) => x.monto), pct((x: P) => x.monto)];
      return {
        titulo: "Ventas por producto",
        extra: r.sinVentas > 0 ? <p className="muted">{r.sinVentas} productos activos con control de inventario no se vendieron en estas fechas.</p> : undefined,
        tablas: [
          { titulo: "Más vendidos", columnas: cols, filas: r.porProducto.slice(0, 30) },
          { titulo: "Menos vendidos (de los que se vendieron)", columnas: cols, filas: r.porProducto.slice(-30).reverse() },
        ],
      };
    }
    case "usuarios":
      return {
        titulo: "Ventas por usuario",
        extra: notaUsuarios(),
        tablas: [
          {
            titulo: "Quién cobró",
            columnas: [txt("Usuario", (u) => u.usuario), num("Tiquetes", (u) => u.tiquetes), din("Ventas", (u) => u.monto), din("Descuentos dados", (u) => u.descuentos), num("Anuladas después", (u) => u.anuladas)],
            filas: r.porUsuario,
          },
        ],
      };
    case "formas":
      return {
        titulo: "Formas de pago",
        tablas: [
          {
            titulo: "Ventas y abonos por forma de pago",
            columnas: [txt("Forma", (f) => f.forma), din("Ventas", (f) => f.ventas), ...(conCuentas ? [din("Abonos", (f: Reporte["porForma"][number]) => f.abonos)] : [])],
            filas: r.porForma,
            total: ["Total", total, ...(conCuentas ? [r.totales.abonos] : [])],
          },
        ],
      };
    case "horas":
      return {
        titulo: "Ventas por hora",
        extra: r.porHora.length > 1 ? <Barras titulo="Ventas por hora real del cobro" datos={r.porHora.map((h) => ({ etiqueta: `${String(h.hora).padStart(2, "0")}:00`, valor: h.monto }))} /> : undefined,
        tablas: [
          {
            titulo: "Por hora real (una caja tardía cuenta en su hora real)",
            columnas: [txt("Hora", (h) => `${String(h.hora).padStart(2, "0")}:00`), num("Tiquetes", (h) => h.tiquetes), din("Ventas", (h) => h.monto)],
            filas: r.porHora,
          },
        ],
      };
    case "control":
      return {
        titulo: "Anulaciones y control",
        resumen: [
          { etiqueta: "Descuentos dados", valor: monto(r.totales.descuentos - r.descuentosCatalogo) },
          { etiqueta: "Descuentos de producto", valor: monto(r.descuentosCatalogo) },
          { etiqueta: "Descuentos con PIN del dueño", valor: String(r.descuentosAutorizados) },
          { etiqueta: "Ventas después del cierre", valor: String(r.despuesDelCierre.length) },
        ],
        tablas: [
          {
            titulo: "Anulaciones",
            columnas: [
              txt("Anulada", (x) => x.fecha, (x) => (x.fecha ? fechaHora(new Date(x.fecha)).slice(0, 16) : "")),
              txt("Tiquete", (x) => x.numero),
              txt("Día de la venta", (x) => x.diaVenta),
              txt("Cuándo", (x) => (x.posterior ? "Otro día (se resta ese día)" : "Mismo turno")),
              txt("Autorizó", (x) => x.usuario),
              txt("Motivo", (x) => x.motivo),
              din("Monto", (x) => x.monto),
            ],
            filas: r.anulaciones,
            vacio: "Sin anulaciones en estas fechas.",
          },
          {
            titulo: "Ventas después del cierre (hora real)",
            columnas: [txt("Cobrada", (x) => x.fecha, (x) => fechaHora(new Date(x.fecha)).slice(0, 16)), txt("Cuenta para", (x) => x.dia), txt("Tiquete", (x) => x.numero), txt("Usuario", (x) => x.usuario), din("Monto", (x) => x.monto)],
            filas: r.despuesDelCierre,
            vacio: "Ninguna.",
          },
          {
            titulo: "Diferencias de apertura y cierre",
            columnas: [
              txt("Día", (x) => x.dia),
              txt("Abrió / cerró", (x) => `${x.abrio} / ${x.cerro}`),
              { titulo: "Apertura", valor: (x) => x.apertura ?? 0, ver: (x) => (x.apertura ? montoConSigno(x.apertura) : "—"), numero: true, dinero: true },
              { titulo: "Cierre", valor: (x) => x.cierre ?? 0, ver: (x) => (x.cierre ? montoConSigno(x.cierre) : "—"), numero: true, dinero: true },
              txt("Revisada", (x) => (x.revisada ? "Sí" : "No")),
              txt("Nota", (x) => x.nota ?? ""),
            ],
            filas: r.diferencias,
            vacio: "Todas las cajas cuadraron.",
          },
        ],
      };
    case "cobrar":
      return {
        titulo: "Apartados y crédito por cobrar",
        resumen: [
          { etiqueta: "Saldo por cobrar", valor: monto(suma(r.porCobrar, (x) => x.saldo)) },
          { etiqueta: "Al día", valor: monto(suma(r.porCobrar.filter((x) => x.diasAtraso === 0), (x) => x.saldo)) },
          { etiqueta: "Vencido 1–30 días", valor: monto(suma(r.porCobrar.filter((x) => x.diasAtraso > 0 && x.diasAtraso <= 30), (x) => x.saldo)) },
          { etiqueta: "Vencido más de 30 días", valor: monto(suma(r.porCobrar.filter((x) => x.diasAtraso > 30), (x) => x.saldo)) },
        ],
        tablas: [
          {
            titulo: `Saldos abiertos al ${fechaCorta(r.hasta)}`,
            columnas: [txt("Número", (x) => x.numero), txt("Cliente", (x) => x.cliente), txt("Vence", (x) => x.fechaLimite ?? ""), num("Días de atraso", (x) => x.diasAtraso), din("Saldo", (x) => x.saldo)],
            filas: r.porCobrar,
            vacio: "No hay saldos pendientes.",
          },
        ],
      };
    case "utilidad":
      return {
        titulo: "Utilidad bruta",
        extra: (
          <>
            {r.utilidad.some((u) => u.aproximado) && <Alert tono="info">Las filas marcadas «aprox.» usan el costo de hoy: esas ventas son de antes de guardar el costo de cada venta.</Alert>}
            {r.sinCosto.length > 0 && (
              <Alert tono="aviso" titulo={`${r.sinCosto.length} productos vendidos sin costo`}>
                No entran en la utilidad: {r.sinCosto.slice(0, 12).join(", ")}
                {r.sinCosto.length > 12 ? "…" : ""}. Póngales costo en Inventario.
              </Alert>
            )}
          </>
        ),
        tablas: [
          {
            titulo: "Por producto (solo con costo)",
            columnas: [
              txt("Producto", (u) => u.producto, (u) => (
                <>
                  {u.producto} {u.aproximado && <Badge tono="info">aprox.</Badge>}
                </>
              )),
              num("Unidades", (u) => u.cantidad),
              din("Venta", (u) => u.venta),
              din("Costo", (u) => u.costo),
              din("Utilidad", (u) => u.utilidad),
              { titulo: "Margen", valor: (u) => (u.venta ? u.utilidad / u.venta : 0), ver: (u) => (u.venta ? PORCENTAJE.format(u.utilidad / u.venta) : "—"), numero: true },
            ],
            filas: r.utilidad,
            total: ["Total", suma(r.utilidad, (u) => u.cantidad), suma(r.utilidad, (u) => u.venta), suma(r.utilidad, (u) => u.costo), suma(r.utilidad, (u) => u.utilidad), ""],
            vacio: "Ningún producto vendido tiene costo.",
          },
        ],
      };
  }
}

function notaUsuarios() {
  return <p className="muted">En turno compartido el efectivo es de la caja, no de cada persona: aquí solo se ve quién cobró cada tiquete.</p>;
}
