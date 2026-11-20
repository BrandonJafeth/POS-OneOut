// Generado desde Rust (src-tauri/src/tipos_ts.rs). No editar a mano.
import type { Anulacion } from "./Anulacion";
import type { Diferencia } from "./Diferencia";
import type { EnCurso } from "./EnCurso";
import type { Fila } from "./Fila";
import type { PorCobrar } from "./PorCobrar";
import type { PorDia } from "./PorDia";
import type { PorForma } from "./PorForma";
import type { PorHora } from "./PorHora";
import type { PorUsuario } from "./PorUsuario";
import type { Tardia } from "./Tardia";
import type { Totales } from "./Totales";
import type { Utilidad } from "./Utilidad";
export type Reporte = { desde: string, hasta: string, anteriorDesde: string, anteriorHasta: string, turnos: number, totales: Totales, anterior: Totales, 
/**
 * Las mismas fechas del año pasado.
 */
anioDesde: string, anioHasta: string, anio: Totales, 
/**
 * Ventas por día del año pasado (solo día, tiquetes y ventas), para comparar día con día.
 */
porDiaAnio: Array<PorDia>, porDia: Array<PorDia>, porDepartamento: Array<Fila>, porProducto: Array<Fila>, 
/**
 * Activos que controlan inventario y no se vendieron en el rango.
 */
sinVentas: number, porUsuario: Array<PorUsuario>, porForma: Array<PorForma>, porHora: Array<PorHora>, anulaciones: Array<Anulacion>, descuentosAutorizados: number, descuentosCatalogo: number, despuesDelCierre: Array<Tardia>, diferencias: Array<Diferencia>, porCobrar: Array<PorCobrar>, 
/**
 * Apartados abiertos hoy y lo que los clientes ya abonaron en ellos (dinero recibido que todavía no es venta).
 */
apartadosAbiertos: number, abonadoEnApartados: number, utilidad: Array<Utilidad>, 
/**
 * Productos vendidos sin costo: no entran en la utilidad.
 */
sinCosto: Array<string>, enCurso: Array<EnCurso>, 
/**
 * Turnos cuyo total en vivo no coincide con su Z congelado (no debería pasar nunca).
 */
noCoinciden: Array<string>, };
