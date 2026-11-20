// Reportes de ventas (dueño). Rango de FECHAS DE NEGOCIO con atajos (hoy es el día de negocio actual,
// que da Rust); los turnos abiertos van aparte, "en curso". Cada pestaña es una o más tablas
// ordenables; lo mismo se exporta a CSV y a PDF carta en Documentos\Punto de venta\Reportes\AAAA-MM.
// También el historial de cierres de caja (antes en Caja → Turnos). Rust calcula todo (reportes.rs).
import { FileDown, FileSpreadsheet } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import { obtenerNegocio } from "../db/negocio";
import type { Rangos } from "../generados/Rangos";
import type { Reporte } from "../generados/Reporte";
import type { Totales } from "../generados/Totales";
import { invocar } from "../lib/invocar";
import { descargar } from "../lib/exportarCliente";
import { csvReporte, nombreArchivo, pdfReporte, type SeccionExport } from "../lib/reportes/exportar";
import { fechaHora, monto, montoConSigno } from "../lib/tickets";
import Alert from "../ui/Alert";
import Badge from "../ui/Badge";
import Barras from "../ui/Barras";
import Button from "../ui/Button";
import Field from "../ui/Field";
import { flechasPestanas } from "../ui/pestanas";
import TablaOrdenable, { type Columna } from "../ui/TablaOrdenable";
import { useToast } from "../ui/Toast";
import { DetalleTurno, Historial } from "./Caja";

type Tab = "resumen" | "dias" | "departamentos" | "productos" | "usuarios" | "formas" | "horas" | "control" | "cobrar" | "utilidad" | "cierres";
const TABS: [Tab, string][] = [
  ["resumen", "Resumen"],
  ["dias", "Por día"],
  ["departamentos", "Departamentos"],
  ["productos", "Productos"],
  ["usuarios", "Usuarios"],
  ["formas", "Formas de pago"],
  ["horas", "Por hora"],
  ["control", "Anulaciones y control"],
  ["cobrar", "Por cobrar"],
  ["utilidad", "Utilidad"],
  ["cierres", "Cierres de caja"],
];

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
/** "mié 18 nov". Sin fecha (todavía cargando): vacío, no un error. */
const fechaCorta = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? FORMATO_DIA.format(new Date(`${d}T00:00:00Z`)) : "");
const suma = <T,>(l: T[], f: (x: T) => number) => l.reduce((s, x) => s + f(x), 0);
const PORCENTAJE = new Intl.NumberFormat("es-CR", { style: "percent", maximumFractionDigits: 1 });

/** "+12 % contra el período anterior" (texto, no solo color). */
function variacion(ahora: number, antes: number): string {
  if (!antes) return ahora ? "sin datos del período anterior" : "";
  const p = Math.round(((ahora - antes) / antes) * 100);
  return `${p > 0 ? "+" : p < 0 ? "−" : "±"}${Math.abs(p)} % contra el período anterior`;
}

export default function Reportes() {
  const { config, caja, recargarCaja } = useSesion();
  const toast = useToast();
  const [rangos, setRangos] = useState<Rangos | null>(null);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [tab, setTab] = useState<Tab>("resumen");
  const [r, setR] = useState<Reporte | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const [verTurno, setVerTurno] = useState<string | null>(null);

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
  const rango = desde === hasta ? fechaCorta(desde) : `${fechaCorta(desde)} al ${fechaCorta(hasta)}`;
  const vista = r && tab !== "cierres" ? armar(tab, r, config.usa_apartados || config.usa_credito) : null;

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
      const bytes = ext === "csv" ? csvReporte(s, `${desde} a ${hasta}`) : pdfReporte(await obtenerNegocio(), s, `Fechas de negocio: ${rango}`);
      const ruta = await descargar(nombreArchivo(vista.titulo, desde, hasta, ext), bytes, "Reportes", hasta.slice(0, 7));
      toast.guardado(ext === "csv" ? "CSV guardado." : "PDF guardado.", ruta);
    } catch (e) {
      toast.error("No se pudo exportar", textoError(e));
    }
  }

  return (
    <div className="screen reportes">
      <h1>Reportes</h1>
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
      </div>
      <div className="tabs" role="tablist" aria-label="Reportes" onKeyDown={flechasPestanas}>
        {TABS.filter(([id]) => id !== "cobrar" || config.usa_apartados || config.usa_credito).map(([id, t]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
            {t}
          </button>
        ))}
      </div>
      <Mensaje error={error} />
      {r && r.noCoinciden.length > 0 && (
        <Alert tono="error" titulo="Hay cierres que no coinciden con el reporte">
          {r.noCoinciden.join(", ")}. Avise al técnico antes de usar estos números.
        </Alert>
      )}
      {tab === "cierres" ? (
        <>
          <Historial admin onVer={setVerTurno} desde={desde} hasta={hasta} />
          {verTurno && caja && <DetalleTurno turnoId={verTurno} estado={caja} onCerrar={() => setVerTurno(null)} onCambio={recargarCaja} />}
        </>
      ) : vista ? (
        <section aria-busy={cargando} className={cargando ? "reportes-cuerpo cargando" : "reportes-cuerpo"}>
          <div className="reportes-cabeza">
            <h2>
              {vista.titulo} <span className="muted">· {rango}</span>
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
          {vista.resumen && (
            <dl className="cifras reportes-cifras">
              {vista.resumen.map((x) => (
                <div key={x.etiqueta}>
                  <dt>{x.etiqueta}</dt>
                  <dd>{x.valor}</dd>
                  {x.nota && <dd className="nota">{x.nota}</dd>}
                </div>
              ))}
            </dl>
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
  );
}

interface Vista {
  titulo: string;
  resumen?: { etiqueta: string; valor: string; nota?: string }[];
  extra?: ReactNode;
  tablas: Tabla[];
}

function resumenDe(t: Totales, a: Totales) {
  const prom = (x: Totales) => (x.tiquetes ? Math.round(x.ventas / x.tiquetes) : 0);
  return [
    { etiqueta: "Ventas", valor: monto(t.ventas), nota: variacion(t.ventas, a.ventas) },
    { etiqueta: "Tiquetes", valor: String(t.tiquetes), nota: variacion(t.tiquetes, a.tiquetes) },
    { etiqueta: "Tiquete promedio", valor: monto(prom(t)), nota: variacion(prom(t), prom(a)) },
    { etiqueta: "Descuentos", valor: monto(t.descuentos) },
    { etiqueta: "Anulaciones de días anteriores", valor: monto(t.anulacionesPosteriores) },
    { etiqueta: "Neto", valor: monto(t.neto) },
    { etiqueta: "Abonos (dinero)", valor: monto(t.abonos) },
    { etiqueta: "Retenido de apartados", valor: monto(t.otrosIngresos) },
  ];
}

function armar(tab: Exclude<Tab, "cierres">, r: Reporte, conCuentas: boolean): Vista {
  const total = r.totales.ventas;
  const parte = (m: number) => (total ? m / total : 0);
  const pct = <T,>(f: (x: T) => number): Columna<T> => ({ titulo: "Del total", valor: (x) => parte(f(x)), ver: (x) => (total ? PORCENTAJE.format(parte(f(x))) : "—"), numero: true });
  switch (tab) {
    case "resumen":
      return {
        titulo: "Resumen de ventas",
        resumen: resumenDe(r.totales, r.anterior).filter((x) => conCuentas || !/Abonos|apartados/.test(x.etiqueta)),
        extra: (
          <>
            <p className="muted">
              {r.turnos} {r.turnos === 1 ? "cierre" : "cierres"} de caja. Comparado con {r.anteriorDesde === r.anteriorHasta ? fechaCorta(r.anteriorDesde) : `${fechaCorta(r.anteriorDesde)} al ${fechaCorta(r.anteriorHasta)}`}. Los fondos de caja no se suman.
            </p>
            {r.enCurso.length > 0 && (
              <Alert tono="info" titulo="En curso (no se suma)">
                {r.enCurso.map((t) => `Caja de ${t.abrio} (día ${fechaCorta(t.dia)}): ${t.tiquetes} tiquetes, ${monto(t.ventas)}`).join(" · ")}
              </Alert>
            )}
            {r.porDia.length > 1 && <Barras titulo="Ventas por día" datos={r.porDia.map((d) => ({ etiqueta: fechaCorta(d.dia), valor: d.ventas }))} />}
          </>
        ),
        tablas: [],
      };
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
