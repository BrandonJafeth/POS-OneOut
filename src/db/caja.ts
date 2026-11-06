// Turnos de caja: apertura con conteo, entradas/salidas, cortes, cierre con arqueo, reapertura,
// historial y gaveta. Las reglas viven en Rust (src-tauri/src/caja.rs, gaveta.rs); aquí solo se
// llama y se tipa. Con el turno abierto, Rust no le manda al cajero ningún total de ventas.
import { invocar } from "../lib/invocar";

/** Conteo guardado: denominación (en texto) → cantidad, o { total } si se escribió el total de una vez. */
export type Conteo = Record<string, number>;

/** Lo que se cuenta en pantalla: billete por billete, o el total escrito directo (`total`). */
export interface ConteoEntrada {
  cantidades: Record<string, number>;
  /** Si no es null, se usa este total y se ignoran las cantidades. */
  total: number | null;
}

// Por defecto se escribe el total (lo más rápido); contar billete por billete es opcional.
export const CONTEO_VACIO: ConteoEntrada = { cantidades: {}, total: 0 };

export interface Turno {
  id: string;
  cajaId: string;
  caja: string;
  estado: "abierto" | "cerrado";
  dia: string;
  abiertoEn: string;
  cerradoEn: string | null;
  usuarioAperturaId: string;
  usuarioApertura: string;
  usuarioCierreId: string | null;
  usuarioCierre: string | null;
  fondo: number;
  conteoInicial: Conteo | null;
  conteoFinal: Conteo | null;
  /** null mientras el turno está abierto */
  esperado: number | null;
  contado: number | null;
  diferencia: number | null;
  notaCierre: string | null;
  revisadaPor: string | null;
  reimpresiones: number;
}

export interface EstadoCaja {
  turno: Turno | null;
  /** Quedó abierta la caja de un día anterior: hay que cerrarla antes de vender. */
  deOtroDia: boolean;
  /** Otros usuarios pueden vender en el turno abierto (config caja_turno_compartido). */
  compartido: boolean;
  /** Este usuario puede vender y mover efectivo en el turno abierto. */
  puedeUsar: boolean;
  puedeCerrar: boolean;
  denominaciones: number[];
  motivos: { salida: string[]; entrada: string[] };
  salidaMaxSinPin: number;
  umbralDiferencia: number;
  noVentaMotivos: string[];
  noVentaUmbral: number;
  /** Aperturas de gaveta sin venta en el turno abierto. */
  noVentas: number;
  /** Valores por defecto de las casillas del cierre Z. */
  zDetalleCompleto: boolean;
  zPorDepartamento: boolean;
}

export interface Movimiento {
  id: string;
  tipo: "entrada" | "salida";
  monto: number;
  categoria: string;
  motivo: string;
  usuario: string;
  autorizadoPor: string | null;
  fecha: string;
}

export interface PorForma {
  formaPagoId: string;
  nombre: string;
  tipo: string;
  /** Co, Ta, De… (como en el cierre del sistema anterior). */
  codigo: string;
  daVuelto: boolean;
  pagos: number;
  monto: number;
}

export interface Ajuste {
  id: string;
  tipo: "pago" | "anulacion";
  ventaNumero: string;
  monto: number;
  motivo: string;
  antes: Record<string, unknown> | null;
  despues: Record<string, unknown> | null;
  usuario: string;
  fecha: string;
}

export interface PagoElectronico {
  fecha: string;
  ventaNumero: string;
  forma: string;
  tipo: string;
  monto: number;
  ultimos4: string | null;
  banco: string | null;
  referencia: string | null;
}

export interface FormaMonto {
  forma: string;
  codigo: string;
  monto: number;
}

/** Una línea del detalle: mismo producto, precio y forma de pago, agrupados ("IMPRESIONES A COLOR x42"). */
export interface FilaDesglose {
  /** Co, Ta, De… o Mx (venta pagada con varias formas). */
  codigo: string;
  producto: string;
  cantidad: number;
  precio: number;
  monto: number;
  efectivo: number;
}

export interface DepartamentoDesglose {
  departamentoId: string;
  nombre: string;
  cantidad: number;
  monto: number;
  efectivo: number;
  porForma: FormaMonto[];
  filas: FilaDesglose[];
}

export interface Desglose {
  departamentos: DepartamentoDesglose[];
  cantidad: number;
  total: number;
  efectivo: number;
  ventasDescuadradas: string[];
}

export interface NoVenta {
  fecha: string;
  usuario: string;
  causa: "no_venta" | "dueno";
  motivo: string;
  nota: string | null;
  autorizadoPor: string | null;
}

export interface CorteResumen {
  id: string;
  fecha: string;
  usuario: string;
  ventas: number;
  total: number;
  efectivoEsperado: number;
  retiro: number;
}

export interface Resumen {
  fondo: number;
  ventas: number;
  totalVentas: number;
  descuentos: number;
  anuladas: number;
  totalAnuladas: number;
  porForma: PorForma[];
  recibidoEfectivo: number;
  vueltos: number;
  ventasEfectivo: number;
  entradas: number;
  salidas: number;
  efectivoEsperado: number;
  movimientos: Movimiento[];
  ajustes: Ajuste[];
  /** Cada pago con tarjeta, SINPE o transferencia (para cuadrar con el datáfono y los comprobantes). */
  pagosElectronicos: PagoElectronico[];
  /** Tiquetes y monto de cada usuario. El efectivo y la diferencia son de la caja. */
  porUsuario: { usuario: string; ventas: number; total: number }[];
  noVentas: NoVenta[];
  noVentaUmbral: number;
  cortes: CorteResumen[];
  desglose: Desglose;
  /** false en cierres de antes de la migración 9 (no traen desglose). */
  conDesglose: boolean;
  /** Departamentos, detalle, formas de pago y efectivo cuadran entre sí (Rust lo revisa). */
  cuadra: boolean;
  descuadres: string[];
  /** Solo informa (no entra en el cuadre). Vacío para el cajero con el turno abierto. */
  estadisticas: Estadisticas;
  /** Dueño que firma como supervisor (el que cerró, o los dueños activos). Vacío en cierres viejos. */
  supervisor: string;
}

/** Lectura del día (estadisticas.rs). */
export interface Estadisticas {
  /** Por usuario: venta simple (precio a mano), descuentos dados y líneas quitadas antes de cobrar. */
  control: { usuario: string; precioLibre: number; montoPrecioLibre: number; descuentos: number; lineasQuitadas: number; montoQuitado: number }[];
  /** Desde qué monto una línea quitada queda anotada. */
  umbralQuitar: number;
  porHora: { hora: number; ventas: number; total: number }[];
  tiquetePromedio: number;
  /** Toda la caja hoy y el mismo día de la semana anterior, los dos hasta la misma hora. */
  hoy: { dia: string; ventas: number; total: number };
  semanaAnterior: { dia: string; ventas: number; total: number };
  topProductos: { producto: string; cantidad: number; monto: number }[];
}

export interface Detalle {
  turno: Turno;
  resumen: Resumen;
  /** false para el cajero con el turno abierto: Rust no manda ningún total de ventas. */
  veTotales: boolean;
  bitacoraOk: boolean | null;
}

export interface Corte {
  id: string;
  fecha: string;
  usuario: string;
  turno: Turno;
  /** Acumulado del turno al momento del corte (antes del retiro). */
  resumen: Resumen;
  retiro: number;
  efectivoDespues: number;
}

export interface AperturaGaveta {
  id: string;
  fecha: string;
  dia: string | null;
  usuarioId: string;
  usuario: string;
  causa: "no_venta" | "dueno";
  motivo: string;
  nota: string | null;
  autorizadoPor: string | null;
  turnoId: string | null;
}

export interface ResultadoCierre {
  turnoId: string;
  diferencia: number | null;
  esperado: number | null;
  contado: number;
  requiereRevision: boolean;
  bitacoraOk: boolean;
  esperasAbiertas: number;
}

export interface TurnoFila extends Turno {
  /** null para el cajero mientras el turno está abierto. */
  ventas: number | null;
  total: number | null;
  pendienteRevision: boolean;
  noVentas: number;
  alertaNoVentas: boolean;
}

/** Cierre con diferencia sobre el umbral y sin nota: Rust lo rechaza con este prefijo. */
export const NOTA_REQUERIDA = "NOTA_REQUERIDA";

/** Pagos electrónicos agrupados por forma (Tarjeta, SINPE…) con su subtotal. */
export function agruparPorForma(pagos: PagoElectronico[]): { forma: string; total: number; pagos: PagoElectronico[] }[] {
  const g = new Map<string, PagoElectronico[]>();
  for (const p of pagos) g.set(p.forma, [...(g.get(p.forma) ?? []), p]);
  return [...g.entries()].map(([forma, l]) => ({ forma, total: l.reduce((s, x) => s + x.monto, 0), pagos: l }));
}

export function totalConteo(c: ConteoEntrada): number {
  if (c.total !== null) return c.total;
  return Object.entries(c.cantidades).reduce((s, [d, n]) => s + Number(d) * (n || 0), 0);
}

/** Lo que recibe Rust: con total escrito no se mandan cantidades. */
const aRust = (c: ConteoEntrada) => (c.total !== null ? { cantidades: {}, total: c.total } : { cantidades: c.cantidades, total: null });

export function estadoCaja(): Promise<EstadoCaja> {
  return invocar<EstadoCaja>("caja_estado");
}

export function abrirCaja(conteo: ConteoEntrada): Promise<Turno> {
  return invocar<Turno>("caja_abrir", { conteo: aRust(conteo) });
}

export function registrarMovimiento(m: { tipo: "entrada" | "salida"; monto: number; categoria: string; nota: string }, pinDueno?: string): Promise<string> {
  return invocar<string>("caja_movimiento", { movimiento: m, pinDueno: pinDueno ?? null });
}

export function detalleTurno(turnoId: string): Promise<Detalle> {
  return invocar<Detalle>("caja_detalle", { turnoId });
}

export function necesitaNota(conteo: ConteoEntrada): Promise<boolean> {
  return invocar<boolean>("caja_necesita_nota", { conteo: aRust(conteo) });
}

export function cerrarCaja(conteo: ConteoEntrada, nota: string): Promise<ResultadoCierre> {
  return invocar<ResultadoCierre>("caja_cerrar", { conteo: aRust(conteo), nota });
}

export async function reabrirCaja(turnoId: string, pin: string, motivo: string): Promise<void> {
  await invocar("caja_reabrir", { turnoId, pin, motivo });
}

export async function marcarRevisada(turnoId: string): Promise<void> {
  await invocar("caja_revisada", { turnoId });
}

/** Datos del reporte Z y si la próxima impresión es COPIA (la primera es el original). */
export function datosReporteZ(turnoId: string): Promise<{ detalle: Detalle; copia: boolean }> {
  return invocar("caja_z", { turnoId });
}

/** Imprime el Z (y los tiquetes por departamento). COPIA: PIN del dueño. Devuelve si fue copia. */
export function imprimirReporteZ(turnoId: string, documentos: Uint8Array[], pin?: string): Promise<boolean> {
  return invocar<boolean>("caja_z_imprimir", { turnoId, documentos: documentos.map((d) => Array.from(d)), pin: pin ?? null });
}

/** Nota del cierre escrita después de ver el resultado (una vez). */
export async function notaCierre(turnoId: string, nota: string): Promise<void> {
  await invocar("caja_nota_cierre", { turnoId, nota });
}

/** Corte parcial (dueño): acumulado sin cerrar y, si se quiere, retiro de efectivo con PIN. */
export function hacerCorte(retiro: { monto: number; categoria: string; nota: string } | null, pin?: string): Promise<Corte> {
  return invocar<Corte>("caja_corte", { retiro, pin: pin ?? null });
}

// ─── Gaveta: solo venta con efectivo (lib/venta/imprimir), "no venta" con motivo u orden del dueño ───

export async function noVenta(motivo: string, nota: string): Promise<void> {
  await invocar("gaveta_no_venta", { motivo, nota });
}

export async function gavetaDueno(pin: string, motivo: string): Promise<void> {
  await invocar("gaveta_dueno", { pin, motivo });
}

export function aperturasGaveta(desde: string, hasta: string, usuarioId: string | null): Promise<AperturaGaveta[]> {
  return invocar<AperturaGaveta[]>("gaveta_aperturas", { desde, hasta, usuarioId });
}

export function listarTurnos(desde: string, hasta: string): Promise<TurnoFila[]> {
  return invocar<TurnoFila[]>("caja_turnos", { desde, hasta });
}
