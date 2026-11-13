// Reporte Z (cierre de caja), tiquete por departamento, corte parcial y comprobante de movimiento.
// Formato basado en el cierre del sistema anterior: resumen por forma de pago, efectivo, ventas por
// usuario, totales por departamento, detalle de tarjeta/SINPE/transferencia, movimientos, conteo
// por billetes y monedas, firmas; y al final, si se elige, el detalle completo por departamento
// (Co/Ta/De/Mx, producto, cantidad, precio, monto y efectivo).
//
// El contenido se arma una sola vez como líneas de texto para un ancho dado (32 columnas en 58 mm,
// 48 en 80 mm, ~90 en el PDF carta): la térmica y el PDF dicen exactamente lo mismo.
// Si los números no cuadran entre sí, no se arma nada: se avisa (Rust también lo revisa).
import type { Corte, DepartamentoDesglose, Detalle, Movimiento, Resumen } from "../../db/caja";
import { agruparPorForma } from "../../db/caja";
import type { Negocio } from "../../tipos";
import { EscPos } from "../escpos";
import { diaLocal } from "../texto";
import { columnas, cortar, fechaHora, lr, monto, montoConSigno, sep, sep2, type Doc, type TicketSettings, wrap } from "../tickets";

/** Una línea del reporte, independiente de la impresora. */
export interface LineaDoc {
  t: string;
  b?: boolean;
  centro?: boolean;
  /** Salto de página (solo en el PDF; en la térmica, nada). */
  salto?: boolean;
}

export interface OpcionesZ {
  copia: boolean;
  /** Todas las ventas desglosadas por departamento y producto. */
  detalleCompleto: boolean;
  /** Un comprobante aparte por cada departamento con ventas. */
  porDepartamento: boolean;
  /** Denominaciones configuradas (para listar el conteo completo, también las que fueron 0). */
  denominaciones?: number[];
}

/** Casillas del Z al abrir el cierre: las que el dueño o el técnico dejaron por defecto. */
export function opcionesPorDefecto(e: { zDetalleCompleto: boolean; zPorDepartamento: boolean }): { detalleCompleto: boolean; porDepartamento: boolean } {
  return { detalleCompleto: !!e.zDetalleCompleto, porDepartamento: !!e.zPorDepartamento };
}

export const DENOMINACIONES = [50000, 20000, 10000, 5000, 2000, 1000, 500, 100, 50, 25, 10, 5];
export const LEYENDA_CODIGOS = "Co=Contado Ta=Tarjeta De=Depósito/SINPE/Transf. Mx=Mixto";
export const NOTA_USUARIOS = "Efectivo y diferencia corresponden a la caja, no a cada usuario.";

const hora = (iso: string) => fechaHora(new Date(iso)).slice(11, 16);
/** Hora del cierre; con día/mes si se cerró otro día (un turno que quedó abierto de un día para otro). */
export function horaCierre(t: { dia: string; cerradoEn: string | null }): string {
  if (!t.cerradoEn) return "";
  const d = new Date(t.cerradoEn);
  const f = fechaHora(d);
  return diaLocal(d) === t.dia ? f.slice(11, 16) : `${f.slice(0, 5)} ${f.slice(11, 16)}`;
}
const signo = (n: number) => montoConSigno(n, "-");
const den = (d: number) => (d >= 1000 ? `${d / 1000} mil` : String(d));

/** Copia de caja.rs::revisar_cuadre: si algo no suma, el Z no se imprime. */
export function descuadres(r: Resumen): string[] {
  const d: string[] = [];
  const formas = r.porForma.reduce((s, f) => s + f.monto, 0);
  if (formas !== r.totalVentas) d.push(`formas de pago ${monto(formas)} ≠ ventas ${monto(r.totalVentas)}`);
  if (r.conDesglose) {
    const deps = r.desglose.departamentos.reduce((s, x) => s + x.monto, 0);
    const filas = r.desglose.departamentos.flatMap((x) => x.filas).reduce((s, f) => s + f.monto, 0);
    const ef = r.desglose.departamentos.reduce((s, x) => s + x.efectivo, 0);
    if (deps !== r.totalVentas) d.push(`departamentos ${monto(deps)} ≠ ventas ${monto(r.totalVentas)}`);
    if (filas !== r.totalVentas) d.push(`detalle ${monto(filas)} ≠ ventas ${monto(r.totalVentas)}`);
    if (ef !== r.ventasEfectivo) d.push(`efectivo por departamento ${monto(ef)} ≠ efectivo cobrado ${monto(r.ventasEfectivo)}`);
    for (const x of r.desglose.departamentos) {
      const porForma = x.porForma.reduce((s, f) => s + f.monto, 0);
      if (porForma !== x.monto) d.push(`${x.nombre}: formas de pago ${monto(porForma)} ≠ ${monto(x.monto)}`);
    }
  }
  if (r.efectivoEsperado !== r.fondo + r.recibidoEfectivo - r.vueltos + r.entradas - r.salidas) d.push("efectivo esperado");
  if (!r.cuadra) d.push(...r.descuadres);
  return [...new Set(d)];
}

export function exigirCuadre(r: Resumen): void {
  const d = descuadres(r);
  if (d.length) throw new Error(`Los totales del cierre no cuadran (${d.join("; ")}). No se imprime para no dar números inconsistentes: avise al técnico.`);
}

// ─── Piezas ───

/** Título de sección en UNA línea ("-- EFECTIVO -------"): el separador aparte gastaba papel. */
function titulo(l: LineaDoc[], texto: string, cols: number) {
  l.push({ t: `-- ${texto} `.padEnd(cols, "-"), b: true });
}

function filaDetalle(f: DepartamentoDesglose["filas"][number], cols: number): LineaDoc[] {
  if (cols >= 60) {
    const w = cols - 3 - 6 - 10 - 11 - 11;
    return [{ t: `${f.codigo.padEnd(3)}${cortar(f.producto, w).padEnd(w)}${String(f.cantidad).padStart(6)}${monto(f.precio).padStart(10)}${monto(f.monto).padStart(11)}${monto(f.efectivo).padStart(11)}` }];
  }
  // 80 mm: una línea por producto (el precio sale de monto / cantidad).
  if (cols >= 40) {
    const w = cols - 3 - 5 - 10 - 10;
    return [{ t: `${f.codigo.padEnd(3)}${cortar(f.producto, w).padEnd(w)}${String(f.cantidad).padStart(5)}${monto(f.monto).padStart(10)}${monto(f.efectivo).padStart(10)}` }];
  }
  const cant = `x${f.cantidad}`;
  return [{ t: lr(`${f.codigo} ${cortar(f.producto, cols - cant.length - 4)}`, cant, cols) }, { t: lr(`   ${monto(f.precio)}`, `${monto(f.monto)} ef ${monto(f.efectivo)}`, cols) }];
}

function encabezadoDetalle(cols: number): LineaDoc[] {
  if (cols >= 60) {
    const w = cols - 3 - 6 - 10 - 11 - 11;
    return [{ t: `${"".padEnd(3)}${"Producto".padEnd(w)}${"Cant".padStart(6)}${"Precio".padStart(10)}${"Monto".padStart(11)}${"Efectivo".padStart(11)}`, b: true }];
  }
  if (cols >= 40) {
    const w = cols - 3 - 5 - 10 - 10;
    return [{ t: `${"".padEnd(3)}${"Producto".padEnd(w)}${"Cant".padStart(5)}${"Monto".padStart(10)}${"Efect.".padStart(10)}`, b: true }];
  }
  return [{ t: lr("Tipo Producto", "Cant", cols) }, { t: lr("   Precio", "Monto ef Efectivo", cols) }];
}

function lineasDepto(x: DepartamentoDesglose, cols: number, conFormas: boolean): LineaDoc[] {
  const l: LineaDoc[] = [];
  titulo(l, cortar(x.nombre, cols - 4), cols);
  for (const f of x.filas) l.push(...filaDetalle(f, cols));
  l.push({ t: lr(`Subtotal (${x.cantidad})`, monto(x.monto), cols), b: true }, { t: lr("  en efectivo", monto(x.efectivo), cols) });
  if (conFormas) for (const f of x.porForma) l.push({ t: lr(`  ${cortar(f.forma, cols - 14)}`, monto(f.monto), cols) });
  return l;
}

/** El nombre del negocio ya va en el encabezado; solo se repite si el logo lo reemplaza. */
function nombreSiHayLogo(n: Negocio): string {
  return n.logo ? n.nombreComercial : "";
}

function cabeceraTurno(d: Detalle, cols: number, nombreNegocio: string): LineaDoc[] {
  const t = d.turno;
  const l: LineaDoc[] = [];
  if (nombreNegocio) l.push({ t: lr("Negocio:", cortar(nombreNegocio, cols - 9), cols) });
  l.push({ t: lr("Caja:", cortar(t.caja || "Caja", cols - 6), cols) }, { t: lr("Día:", t.dia, cols) });
  l.push({ t: lr("Abrió:", `${cortar(t.usuarioApertura, cols - 14)} ${hora(t.abiertoEn)}`, cols) });
  if (t.cerradoEn) l.push({ t: lr("Cerró:", `${cortar(t.usuarioCierre ?? "", cols - 9 - horaCierre(t).length)} ${horaCierre(t)}`, cols) });
  return l;
}

// ─── Reporte Z ───

const diaCorto = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

/** Control por usuario, lectura del día (promedio, semana anterior, horas) y más vendidos. */
export function lineasLectura(r: Resumen, cols: number): LineaDoc[] {
  const x = r.estadisticas;
  const l: LineaDoc[] = [];
  if (x.control.length) {
    titulo(l, "CONTROL POR USUARIO", cols);
    const libre = x.control.reduce((s, c) => s + c.montoPrecioLibre, 0);
    if (r.totalVentas > 0 && libre > 0) l.push({ t: lr("Venta simple / ventas", `${Math.round((libre / r.totalVentas) * 100)} %`, cols), b: true });
    for (const c of x.control) {
      l.push({ t: cortar(c.usuario, cols), b: true });
      if (c.precioLibre) l.push({ t: lr(`  Venta simple (${c.precioLibre})`, monto(c.montoPrecioLibre), cols) });
      if (c.descuentos) l.push({ t: lr("  Descuentos dados", monto(c.descuentos), cols) });
      if (c.descuentosProducto) l.push({ t: lr("  Desc. de producto", monto(c.descuentosProducto), cols) });
      if (c.lineasQuitadas) l.push({ t: lr(`  Quitado antes de cobrar (${c.lineasQuitadas})`, monto(c.montoQuitado), cols) });
    }
    if (x.control.some((c) => c.lineasQuitadas)) wrap(`Quitado: solo líneas de ${monto(x.umbralQuitar)} o más.`, cols).forEach((y) => l.push({ t: y }));
  }
  if (x.porHora.length) {
    titulo(l, "LECTURA DEL DÍA", cols);
    l.push({ t: lr("Tiquete promedio", monto(x.tiquetePromedio), cols) });
    const { hoy, semanaAnterior: antes } = x;
    l.push({ t: lr(`Hoy ${diaCorto(hoy.dia)} (${hoy.ventas})`, monto(hoy.total), cols) });
    l.push({ t: lr(`${diaCorto(antes.dia)} sem. pasada (${antes.ventas})`, monto(antes.total), cols) });
    if (antes.total > 0) l.push({ t: lr("  Diferencia", `${montoConSigno(hoy.total - antes.total, "-")} (${Math.round(((hoy.total - antes.total) / antes.total) * 100)} %)`, cols) });
    l.push({ t: "Hasta la misma hora, toda la caja." });
    l.push({ t: "VENTAS POR HORA" });
    const max = Math.max(...x.porHora.map((h) => h.total), 1);
    const ancho = Math.max(4, cols - 24);
    for (const h of x.porHora) {
      const barra = "#".repeat(Math.max(1, Math.round((h.total / max) * ancho)));
      l.push({ t: lr(`${String(h.hora).padStart(2, "0")}h ${barra}`, `${h.ventas} ${monto(h.total)}`, cols) });
    }
  }
  if (x.topProductos.length) {
    titulo(l, "MÁS VENDIDOS", cols);
    x.topProductos.forEach((p, i) => l.push({ t: lr(`${String(i + 1).padStart(2)} ${cortar(p.producto, cols - 18)}`, `${p.cantidad} ${monto(p.monto)}`, cols) }));
  }
  return l;
}

export function lineasZ(n: Negocio, d: Detalle, cols: number, o: OpcionesZ): LineaDoc[] {
  const { turno: t, resumen: r } = d;
  const l: LineaDoc[] = [{ t: sep2(cols) }, { t: "CIERRE DE CAJA (Z)", b: true, centro: true }];
  if (o.copia) l.push({ t: "*** COPIA ***", b: true, centro: true });
  l.push(...cabeceraTurno(d, cols, nombreSiHayLogo(n)));

  titulo(l, "VENTAS POR FORMA DE PAGO", cols);
  for (const f of r.porForma) l.push({ t: lr(`${f.codigo} ${cortar(f.nombre, cols - 18)} (${f.pagos})`, monto(f.monto), cols) });
  if (!r.porForma.length) l.push({ t: "  Sin ventas" });
  l.push({ t: lr(`TOTAL VENTAS (${r.ventas})`, monto(r.totalVentas), cols), b: true });

  titulo(l, "EFECTIVO", cols);
  l.push({ t: lr("Fondo inicial", monto(r.fondo), cols) });
  l.push({ t: lr("Contado (recibido)", "+" + monto(r.recibidoEfectivo), cols) });
  l.push({ t: lr("Entradas", "+" + monto(r.entradas), cols) });
  l.push({ t: lr("Salidas", "-" + monto(r.salidas), cols) });
  l.push({ t: lr("Vueltos", "-" + monto(r.vueltos), cols) });
  l.push({ t: lr("Efectivo esperado", monto(r.efectivoEsperado), cols), b: true });
  if (t.contado != null) l.push({ t: lr("Efectivo contado", monto(t.contado), cols), b: true });
  if (t.diferencia != null) l.push({ t: lr(t.diferencia === 0 ? "Diferencia: cuadra" : t.diferencia > 0 ? "Sobrante" : "Faltante", signo(t.diferencia), cols), b: true });
  if (t.notaCierre) wrap("Nota: " + t.notaCierre, cols).forEach((x) => l.push({ t: x }));

  titulo(l, "OTROS", cols);
  l.push({ t: lr("Descuentos", monto(r.descuentos), cols) });
  l.push({ t: lr(`Anulaciones (${r.anuladas})`, monto(r.totalAnuladas), cols) });
  l.push({ t: lr("Aperturas sin venta", String(r.noVentas.length), cols) });
  if (r.noVentaUmbral > 0 && r.noVentas.length >= r.noVentaUmbral)
    wrap(`ATENCION: muchas aperturas sin venta (umbral ${r.noVentaUmbral})`, cols).forEach((x) => l.push({ t: x, b: true }));
  l.push({ t: lr("Cortes realizados", String(r.cortes.length), cols) });

  titulo(l, "VENTAS POR USUARIO", cols);
  for (const u of r.porUsuario) l.push({ t: lr(`${cortar(u.usuario, cols - 18)} (${u.ventas} tiq.)`, monto(u.total), cols) });
  if (!r.porUsuario.length) l.push({ t: "  Sin ventas" });
  wrap(NOTA_USUARIOS, cols).forEach((x) => l.push({ t: x }));
  l.push(...lineasLectura(r, cols));

  if (r.conDesglose && r.desglose.departamentos.length) {
    titulo(l, "POR DEPARTAMENTO", cols);
    for (const x of r.desglose.departamentos) {
      l.push({ t: lr(`${cortar(x.nombre, cols - 18)} (${x.cantidad})`, monto(x.monto), cols) });
      l.push({ t: lr("  en efectivo", monto(x.efectivo), cols) });
    }
    l.push({ t: lr(`Total (${r.desglose.cantidad})`, monto(r.desglose.total), cols), b: true });
  }

  const grupos = agruparPorForma(r.pagosElectronicos ?? []);
  if (grupos.length) {
    titulo(l, "DETALLE TARJETA/SINPE/TRANSF.", cols);
    for (const g of grupos) {
      l.push({ t: lr(`${cortar(g.forma, cols - 14)} (${g.pagos.length})`, monto(g.total), cols), b: true });
      for (const x of g.pagos) {
        const dato = x.ultimos4 ? `****${x.ultimos4}` : [x.banco, x.referencia && `ref ${x.referencia}`, x.telefono && `tel ${x.telefono}`].filter(Boolean).join(" ");
        const izq = `${hora(x.fecha)} ${x.ventaNumero}`;
        const cabe = cols - monto(x.monto).length - 1 - izq.length - 1;
        // Si la referencia no cabe en la misma línea, va completa en la siguiente (no se corta).
        if (dato.length <= cabe) l.push({ t: lr(`${izq} ${dato}`.trimEnd(), monto(x.monto), cols) });
        else l.push({ t: lr(izq, monto(x.monto), cols) }, ...wrap(dato, cols - 2).map((y) => ({ t: `  ${y}` })));
      }
    }
  }

  // Sin movimientos no va la sección: EFECTIVO ya dice entradas +0 y salidas -0.
  if (r.movimientos.length) titulo(l, "MOVIMIENTOS DE EFECTIVO", cols);
  for (const m of r.movimientos) {
    l.push({ t: lr(`${m.tipo === "salida" ? "-" : "+"} ${cortar(m.categoria, cols - 14)}`, monto(m.monto), cols) });
    l.push({ t: `  ${hora(m.fecha)} ${cortar([m.usuario, m.motivo].filter(Boolean).join(" · "), cols - 8)}` });
  }

  if (r.noVentas.length) {
    titulo(l, "APERTURAS SIN VENTA", cols);
    for (const x of r.noVentas) {
      const que = x.causa === "dueno" ? `Orden del dueño: ${x.motivo}` : x.nota ? `${x.motivo}: ${x.nota}` : x.motivo;
      wrap(`${hora(x.fecha)} ${x.usuario} · ${que}`, cols).forEach((y) => l.push({ t: y }));
    }
  }

  if (r.cortes.length) {
    titulo(l, "CORTES", cols);
    for (const k of r.cortes) {
      l.push({ t: lr(`${hora(k.fecha)} ${cortar(k.usuario, cols - 20)}`, monto(k.total), cols) });
      if (k.retiro) l.push({ t: lr("  retiro", "-" + monto(k.retiro), cols) });
    }
  }

  if (r.ajustes.length) {
    titulo(l, "AJUSTES DE TURNOS ANTERIORES", cols);
    for (const a of r.ajustes) l.push({ t: lr(`${a.tipo === "anulacion" ? "Anula" : "Pago"} ${a.ventaNumero}`, monto(a.monto), cols) });
  }

  titulo(l, "CONTEO", cols);
  const c = t.conteoFinal;
  if (c && "total" in c) l.push({ t: lr("Total escrito, sin detalle", monto(Number(c.total)), cols) });
  else {
    const lista = (o.denominaciones?.length ? o.denominaciones : DENOMINACIONES).slice().sort((a, b) => b - a);
    for (const [nombre, filtro] of [["BILLETES", (x: number) => x >= 1000], ["MONEDAS", (x: number) => x < 1000]] as const) {
      // Solo lo que se contó: 12 renglones de "0 ¢0" eran papel perdido.
      const contadas = lista.filter(filtro).filter((x) => Number(c?.[String(x)] ?? 0) > 0);
      if (contadas.length) l.push({ t: nombre });
      for (const x of contadas) {
        const cant = Number(c?.[String(x)] ?? 0);
        l.push({ t: lr(`  ${den(x).padEnd(7)} ${String(cant).padStart(4)}`, monto(cant * x), cols) });
      }
    }
    if (t.contado != null) l.push({ t: lr("Total contado", monto(t.contado), cols), b: true });
  }

  if (d.bitacoraOk === false) l.push({ t: sep(cols) }, { t: "ATENCION: BITACORA ALTERADA", b: true });

  if (o.detalleCompleto && r.conDesglose) {
    l.push({ t: sep2(cols), salto: true }, { t: "DETALLE DE VENTAS", b: true, centro: true });
    wrap(LEYENDA_CODIGOS, cols).forEach((x) => l.push({ t: x }));
    l.push(...encabezadoDetalle(cols));
    for (const x of r.desglose.departamentos) l.push(...lineasDepto(x, cols, false));
    l.push({ t: sep2(cols) }, { t: lr(`TOTAL GENERAL (${r.desglose.cantidad})`, monto(r.desglose.total), cols), b: true }, { t: lr("  en efectivo", monto(r.desglose.efectivo), cols) });
  }

  // Firmas: nombre arriba y raya abajo, con un solo renglón libre para firmar.
  l.push({ t: sep2(cols) }, { t: `Cajero: ${cortar(t.usuarioCierre ?? "", cols - 8)}` }, { t: "" }, { t: "_".repeat(Math.min(cols, 32)) }, { t: `Supervisor: ${cortar(r.supervisor, cols - 12)}`.trimEnd() }, { t: "" }, { t: "_".repeat(Math.min(cols, 32)) });
  return l;
}

/** Comprobante aparte de un departamento: encabezado, detalle, subtotal por forma de pago y total. */
export function lineasDepartamento(n: Negocio, d: Detalle, x: DepartamentoDesglose, cols: number, o: { copia: boolean }): LineaDoc[] {
  const l: LineaDoc[] = [{ t: sep2(cols) }, { t: "VENTAS POR DEPARTAMENTO", b: true, centro: true }];
  if (o.copia) l.push({ t: "*** COPIA ***", b: true, centro: true });
  l.push(...cabeceraTurno(d, cols, nombreSiHayLogo(n)));
  l.push({ t: lr("Departamento:", cortar(x.nombre, cols - 14), cols), b: true });
  l.push({ t: sep(cols) });
  wrap(LEYENDA_CODIGOS, cols).forEach((y) => l.push({ t: y }));
  l.push(...encabezadoDetalle(cols));
  for (const f of x.filas) l.push(...filaDetalle(f, cols));
  titulo(l, "POR FORMA DE PAGO", cols);
  for (const f of x.porForma) l.push({ t: lr(`${f.codigo} ${cortar(f.forma, cols - 16)}`, monto(f.monto), cols) });
  l.push({ t: lr(`TOTAL ${cortar(x.nombre, cols - 22)} (${x.cantidad})`, monto(x.monto), cols), b: true });
  l.push({ t: lr("  en efectivo", monto(x.efectivo), cols) }, { t: sep2(cols) });
  return l;
}

/**
 * Líneas → bytes ESC/POS. Son reportes internos: sin logo ni dirección/cédula/teléfono (eso es
 * para el cliente y gastaba papel en cada comprobante). Solo el nombre, si el cuerpo no lo trae ya.
 */
export function aEscPos(n: Negocio, cuerpo: LineaDoc[], s: TicketSettings): Doc {
  const cols = columnas(s);
  const p = new EscPos(s.codePage, { sinModoChino: s.sinModoChino });
  const nombre = n.nombreComercial.trim();
  if (nombre && !nombreSiHayLogo(n)) p.align("center").bold(true).line(cortar(nombre, cols)).bold(false).align("left");
  for (const x of cuerpo) {
    if (x.centro) p.align("center");
    if (x.b) p.bold(true);
    p.line(x.t.slice(0, cols));
    if (x.b) p.bold(false);
    if (x.centro) p.align("left");
  }
  p.feed(4);
  if (s.cortador) p.cut();
  return { bytes: p.bytes(), missing: [...p.missing] };
}

export function reporteZ(n: Negocio, d: Detalle, s: TicketSettings, o: OpcionesZ): Doc {
  return aEscPos(n, lineasZ(n, d, columnas(s), o), s);
}

/**
 * Lo que sale al cerrar (o al reimprimir): el Z y, si se eligió, un comprobante por departamento con
 * ventas. Si los totales no cuadran, no devuelve nada: lanza el error.
 */
export function documentosCierre(n: Negocio, d: Detalle, s: TicketSettings, o: OpcionesZ): Doc[] {
  exigirCuadre(d.resumen);
  const docs = [reporteZ(n, d, s, o)];
  if (o.porDepartamento && d.resumen.conDesglose)
    for (const x of d.resumen.desglose.departamentos) docs.push(aEscPos(n, lineasDepartamento(n, d, x, columnas(s), { copia: o.copia }), s));
  return docs;
}

// ─── Corte parcial ───

export function lineasCorte(n: Negocio, k: Corte, cols: number): LineaDoc[] {
  const r = k.resumen;
  const t = k.turno;
  const l: LineaDoc[] = [{ t: sep2(cols) }, { t: "CORTE DE CAJA", b: true, centro: true }, { t: "(el turno sigue abierto)", centro: true }];
  if (nombreSiHayLogo(n)) l.push({ t: lr("Negocio:", cortar(n.nombreComercial, cols - 9), cols) });
  l.push({ t: lr("Caja:", cortar(t.caja || "Caja", cols - 6), cols) }, { t: lr("Turno:", `${t.dia} ${hora(t.abiertoEn)}`, cols) });
  l.push({ t: lr("Corte:", `${cortar(k.usuario, cols - 14)} ${hora(k.fecha)}`, cols) });
  titulo(l, "ACUMULADO POR FORMA DE PAGO", cols);
  for (const f of r.porForma) l.push({ t: lr(`${f.codigo} ${cortar(f.nombre, cols - 18)} (${f.pagos})`, monto(f.monto), cols) });
  if (!r.porForma.length) l.push({ t: "  Sin ventas" });
  l.push({ t: lr(`TOTAL VENTAS (${r.ventas})`, monto(r.totalVentas), cols), b: true });
  titulo(l, "EFECTIVO", cols);
  l.push({ t: lr("Efectivo esperado", monto(r.efectivoEsperado), cols) });
  if (k.retiro) l.push({ t: lr("Retiro", "-" + monto(k.retiro), cols) });
  l.push({ t: lr("Queda en la caja", monto(k.efectivoDespues), cols), b: true });
  if (k.retiro) l.push({ t: sep2(cols) }, { t: "" }, { t: "Retira:" }, { t: "" }, { t: "_".repeat(Math.min(cols, 32)) });
  else l.push({ t: sep2(cols) });
  return l;
}

export function reporteCorte(n: Negocio, k: Corte, s: TicketSettings): Doc {
  return aEscPos(n, lineasCorte(n, k, columnas(s)), s);
}

// ─── Comprobante de movimiento ───

/** Comprobante de una entrada/salida de efectivo (para firmar y guardar con el dinero). */
export function comprobanteMovimiento(n: Negocio, m: Movimiento, s: TicketSettings): Doc {
  const c = columnas(s);
  const l: LineaDoc[] = [{ t: sep2(c) }, { t: m.tipo === "salida" ? "SALIDA DE EFECTIVO" : "ENTRADA DE EFECTIVO", b: true, centro: true }];
  if (nombreSiHayLogo(n)) l.push({ t: lr("Negocio:", cortar(n.nombreComercial, c - 9), c) });
  l.push({ t: lr("Fecha:", fechaHora(new Date(m.fecha)), c) }, { t: lr("Usuario:", cortar(m.usuario, c - 9), c) }, { t: lr("Motivo:", cortar(m.categoria, c - 8), c) });
  if (m.motivo) wrap("Nota: " + m.motivo, c).forEach((x) => l.push({ t: x }));
  l.push({ t: lr("MONTO", monto(m.monto), c), b: true });
  if (m.autorizadoPor) l.push({ t: `Autorizado por: ${cortar(m.autorizadoPor, c - 16)}` });
  l.push({ t: sep2(c) }, { t: "" }, { t: "Firma: ________________________" });
  return aEscPos(n, l, s);
}
