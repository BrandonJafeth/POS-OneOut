// Turnos de caja: apertura con conteo, entradas/salidas, cierre con arqueo, reapertura e historial.
// Las reglas viven en Rust (src-tauri/src/caja.rs); aquí solo se llama y se tipa.
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
  /** null en cierre ciego para el cajero */
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
  cierreCiego: boolean;
  denominaciones: number[];
  motivos: { salida: string[]; entrada: string[] };
  salidaMaxSinPin: number;
  umbralDiferencia: number;
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
  /** Quién vendió en el turno (si el dueño ayudó en la caja de un cajero, aparece aquí). */
  porUsuario: { usuario: string; ventas: number; total: number }[];
}

export interface Detalle {
  turno: Turno;
  resumen: Resumen;
  /** false en cierre ciego para el cajero: no se muestra esperado ni diferencia. */
  veEsperado: boolean;
  bitacoraOk: boolean | null;
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
  ventas: number;
  total: number;
  pendienteRevision: boolean;
}

/** Cierre con diferencia sobre el umbral y sin nota: Rust lo rechaza con este prefijo. */
export const NOTA_REQUERIDA = "NOTA_REQUERIDA";

/** Pagos electrónicos agrupados por forma (Tarjeta, SINPE…) con su subtotal. */
export function agruparPorForma(pagos: PagoElectronico[]): { forma: string; total: number; pagos: PagoElectronico[] }[] {
  const g = new Map<string, PagoElectronico[]>();
  for (const p of pagos) g.set(p.forma, [...(g.get(p.forma) ?? []), p]);
  return [...g.entries()].map(([forma, l]) => ({ forma, total: l.reduce((s, x) => s + x.monto, 0), pagos: l }));
}

/** El turno es de quien lo abrió: otro cajero no opera en él (el dueño sí). */
export function esMiTurno(t: Turno, usuarioId: string, esDueno: boolean): boolean {
  return t.usuarioAperturaId === usuarioId || esDueno;
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

/** Datos del reporte Z y si esta impresión es COPIA (la primera es el original). */
export function datosReporteZ(turnoId: string): Promise<{ detalle: Detalle; copia: boolean }> {
  return invocar("caja_z", { turnoId });
}

export function listarTurnos(desde: string, hasta: string): Promise<TurnoFila[]> {
  return invocar<TurnoFila[]>("caja_turnos", { desde, hasta });
}
