// Turnos de caja: apertura con conteo, entradas/salidas, cierre con arqueo, reapertura e historial.
// Las reglas viven en Rust (src-tauri/src/caja.rs); aquí solo se llama y se tipa.
import { invocar } from "../lib/invocar";

/** denominación (en texto) → cantidad de billetes o monedas */
export type Conteo = Record<string, number>;

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

export function totalConteo(c: Conteo): number {
  return Object.entries(c).reduce((s, [d, n]) => s + Number(d) * (n || 0), 0);
}

export function estadoCaja(): Promise<EstadoCaja> {
  return invocar<EstadoCaja>("caja_estado");
}

export function abrirCaja(conteo: Conteo): Promise<Turno> {
  return invocar<Turno>("caja_abrir", { conteo: { cantidades: conteo } });
}

export function registrarMovimiento(m: { tipo: "entrada" | "salida"; monto: number; categoria: string; nota: string }, pinDueno?: string): Promise<string> {
  return invocar<string>("caja_movimiento", { movimiento: m, pinDueno: pinDueno ?? null });
}

export function detalleTurno(turnoId: string): Promise<Detalle> {
  return invocar<Detalle>("caja_detalle", { turnoId });
}

export function necesitaNota(conteo: Conteo): Promise<boolean> {
  return invocar<boolean>("caja_necesita_nota", { conteo: { cantidades: conteo } });
}

export function cerrarCaja(conteo: Conteo, nota: string): Promise<ResultadoCierre> {
  return invocar<ResultadoCierre>("caja_cerrar", { conteo: { cantidades: conteo }, nota });
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
