// Configuración clave → valor JSON. Lo que cambia entre negocios vive aquí, no en el código.
import type { Actor } from "../tipos";
import { REGLAS_DEFECTO, type ReglasImportacion } from "../lib/importar/reglas";
import { invocar } from "../lib/invocar";
import { db } from "./conexion";

/** Claves conocidas con su tipo. Las que no estén aquí igual se pueden guardar desde Configuración técnica. */
export interface ConfigApp {
  usa_apartados: boolean;
  usa_credito: boolean;
  abono_minimo_pct: number;
  escaner_debounce_ms: number;
  imprime_tiquete: boolean;
  codigo_interno_siguiente: number;
  /** Importación de la web: categoría → departamento (en orden de prioridad), palabras y favoritos. */
  importacion_reglas: ReglasImportacion;
  /** Tasa de IVA (%) y CAByS que reciben los productos importados. */
  producto_tasa_iva_defecto: number;
  producto_cabys_defecto: string;
  /** Departamento para lo que no tiene uno asignado (importación sin mapeo). */
  departamento_defecto: string;
  /** Meses sin saldos ni movimientos tras los que se sugiere anonimizar un cliente. */
  retencion_clientes_meses: number;
  /** Imprimir una línea corta del aviso de privacidad en el tiquete del apartado. */
  aviso_privacidad_en_tiquete: boolean;
  /** Múltiplo al que se redondea el total (1 = sin redondeo). */
  redondeo_total: number;
  /** % máximo de descuento por rol sin PIN de dueño. */
  descuento_max_pct: Record<string, number>;
  denominaciones_rapidas: number[];
  abrir_gaveta_efectivo: boolean;
  /** Se imprime al final del tiquete. Vacío = no se imprime. */
  texto_no_factura: string;
  avisar_espera_al_cerrar: boolean;
  /** Tema de la pantalla en este equipo. */
  tema: "claro" | "oscuro";
  /** Mostrar subtotal e IVA en la venta y el tiquete (false en régimen simplificado). */
  mostrar_iva: boolean;
  /** Color propio del negocio ("#rrggbb"); vacío = grafito. Se ajusta solo para cumplir contraste. */
  color_acento: string;
  /** ¢: desde esta diferencia el cierre de caja exige nota y queda para revisión del dueño. */
  caja_umbral_diferencia: number;
  /** ¢: salidas de efectivo mayores piden el PIN del dueño. */
  caja_salida_max_sin_pin: number;
  /** Otros usuarios pueden vender en el turno abierto por otra persona (el turno es de la caja). */
  caja_turno_compartido: boolean;
  /** Casillas del cierre Z marcadas por defecto. */
  caja_z_detalle_completo: boolean;
  caja_z_por_departamento: boolean;
  /** Motivos de "no venta" (abrir la gaveta sin vender). */
  caja_no_venta_motivos: string[];
  /** Desde esta cantidad de aperturas sin venta, el cierre lo marca. 0 = nunca. */
  caja_no_venta_umbral: number;
  /** ¢: quitar de una venta abierta una línea de este monto o más queda en la bitácora. 0 = nunca. */
  caja_quitar_linea_bitacora: number;
  /** Píldoras de la venta: "cada_uno" (el color de cada departamento), "#rrggbb" (todos iguales) o "ninguno". */
  departamentos_color: string;
  caja_denominaciones: number[];
  caja_motivos: { salida: string[]; entrada: string[] };
  pin_min_dueno: number;
  pin_min_cajero: number;
  /** Minutos sin uso tras los que se bloquea la sesión. */
  sesion_inactividad_min: number;
}

/** Valores por defecto si una clave falta en la base (los mismos que siembra la migración). */
export const CONFIG_DEFECTO: ConfigApp = {
  usa_apartados: true,
  usa_credito: false,
  abono_minimo_pct: 50,
  escaner_debounce_ms: 400,
  imprime_tiquete: true,
  codigo_interno_siguiente: 1,
  importacion_reglas: REGLAS_DEFECTO,
  producto_tasa_iva_defecto: 13,
  producto_cabys_defecto: "",
  departamento_defecto: "00000000000000000000000D12",
  retencion_clientes_meses: 36,
  aviso_privacidad_en_tiquete: false,
  redondeo_total: 5,
  descuento_max_pct: { cajero: 10, dueno: 100, tecnico: 100 },
  denominaciones_rapidas: [1000, 2000, 5000, 10000, 20000],
  abrir_gaveta_efectivo: true,
  texto_no_factura: "Este tiquete no es una factura electrónica",
  avisar_espera_al_cerrar: true,
  tema: "claro",
  mostrar_iva: false,
  color_acento: "",
  caja_umbral_diferencia: 1000,
  caja_salida_max_sin_pin: 20000,
  caja_turno_compartido: true,
  caja_z_detalle_completo: false,
  caja_z_por_departamento: false,
  caja_no_venta_motivos: ["Cambio de billetes", "Devolución", "Otro"],
  caja_no_venta_umbral: 5,
  caja_quitar_linea_bitacora: 5000,
  departamentos_color: "cada_uno",
  caja_denominaciones: [50000, 20000, 10000, 5000, 2000, 1000, 500, 100, 50, 25, 10, 5],
  caja_motivos: { salida: ["Retiro de dinero", "Gasto menor", "Pago a proveedor", "Adelanto"], entrada: ["Ingreso de cambio", "Otro ingreso"] },
  pin_min_dueno: 6,
  pin_min_cajero: 4,
  sesion_inactividad_min: 10,
};

/** Todas las claves tal como están en la base (para el editor técnico). */
export async function leerConfigCruda(): Promise<Record<string, unknown>> {
  const filas = await db().select("SELECT clave, valor FROM config ORDER BY clave");
  const out: Record<string, unknown> = {};
  for (const f of filas) {
    try {
      out[String(f.clave)] = JSON.parse(String(f.valor));
    } catch {
      out[String(f.clave)] = String(f.valor);
    }
  }
  return out;
}

export async function leerConfig(): Promise<ConfigApp> {
  return { ...CONFIG_DEFECTO, ...(await leerConfigCruda()) } as ConfigApp;
}

/** Rust revisa el permiso por clave (el cajero no puede subir su propio tope, etc.) y deja la bitácora. */
export async function guardarConfig(_actor: Actor, clave: string, valor: unknown): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(clave)) throw new Error("La clave solo admite minúsculas, números y _");
  await invocar("config_guardar", { clave, valor });
}
