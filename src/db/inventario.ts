// Inventario: todo por comandos Rust tipados (src-tauri/src/inventario.rs). Nada pasa por
// bd_leer: existencias, costos y kardex no están en la lectura de catálogo. Aquí solo se tipa.
import { invocar } from "../lib/invocar";

export type EstadoInventario = "sin_control" | "con_existencia" | "bajo_minimo" | "agotado" | "negativo";
export type FiltroInventario = "" | "bajo_minimo" | "agotados" | "negativos" | "sin_barras" | "sin_costo" | "sin_control";
export type TipoMovimiento = "venta" | "anulacion" | "entrada" | "ajuste" | "inicial";

export const NOMBRE_ESTADO: Record<EstadoInventario, string> = {
  sin_control: "Sin control",
  con_existencia: "Con existencia",
  bajo_minimo: "Bajo mínimo",
  agotado: "Agotado",
  negativo: "Negativo",
};

export const NOMBRE_TIPO: Record<TipoMovimiento, string> = {
  venta: "Venta",
  anulacion: "Anulación",
  entrada: "Entrada",
  ajuste: "Ajuste",
  inicial: "Inventario inicial",
};

export interface FilaInventario {
  productoId: string;
  nombre: string;
  departamento: string;
  codigos: string;
  controla: boolean;
  existencia: number;
  minimo: number;
  costo: number | null;
  estado: EstadoInventario;
}

export interface FilaKardex {
  fecha: string;
  tipo: TipoMovimiento;
  cantidad: number;
  existencia: number;
  costoUnitario: number | null;
  motivo: string;
  referencia: string | null;
  usuario: string;
  producto: string;
}

export interface LineaEntrada {
  productoId: string;
  cantidad: number;
  costoUnitario: number | null;
  precioNuevo?: number | null;
}

export interface Entrada {
  proveedorId: string | null;
  factura: string;
  /** AAAA-MM-DD (día de la factura del proveedor). */
  fecha: string;
  lineas: LineaEntrada[];
  actualizarCosto: boolean;
}

export interface Comprobante {
  id: string;
  factura: string;
  fecha: string;
  creadoEn: string;
  proveedor: string | null;
  usuario: string;
  lineas: { productoId: string; nombre: string; precio: number; codigoBarras: string | null; cantidad: number; costoUnitario: number | null }[];
}

export interface Ajuste {
  productoId: string;
  nueva: number | null;
  diferencia: number | null;
  motivo: string;
  detalle: string;
}

export interface Conteo {
  id: string;
  departamentoId: string | null;
  datos: Record<string, number>;
  actualizadoEn: string;
}

export interface FilaConteo {
  productoId: string;
  nombre: string;
  codigos: string;
  controla: boolean;
  sistema: number;
  contado: number | null;
  diferencia: number | null;
}

export interface FilaInicial {
  fila: number;
  clave: string;
  existencia: string;
  costo: string;
}

export interface PrevistaInicial {
  fila: number;
  productoId: string | null;
  nombre: string;
  actual: number;
  nueva: number | null;
  costo: number | null;
  error: string | null;
}

export interface FilaBajoMinimo {
  productoId: string;
  nombre: string;
  departamento: string;
  existencia: number;
  minimo: number;
  sugerido: number;
}

export interface Valorizado {
  porDepartamento: { departamento: string; unidades: number; valor: number }[];
  total: number;
  sinCosto: { nombre: string; departamento: string; existencia: number }[];
}

export interface Proveedor {
  id: string;
  nombre: string;
  telefono: string;
  notas: string;
}

export const listarInventario = (filtro: { texto?: string; departamentoId?: string; filtro?: FiltroInventario; limite?: number; desplazamiento?: number }) =>
  invocar<{ filas: FilaInventario[]; total: number }>("inventario_lista", { filtro });
export const estadoInventario = (ids: string[]) => invocar<FilaInventario[]>("inventario_estado", { ids });
/** Cajero: solo si la configuración venta_mostrar_existencia lo permite. Nunca trae el costo. */
export const existenciaVenta = (ids: string[]) => invocar<{ productoId: string; existencia: number }[]>("inventario_existencia", { ids });
export const alertasInventario = () => invocar<number>("inventario_alertas");
export const guardarInventarioProducto = (productoId: string, controla: boolean, minimo: number, costo: number | null) =>
  invocar<void>("inventario_producto", { productoId, controla, minimo, costo });
export const kardex = (productoId: string, desde: string, hasta: string) => invocar<FilaKardex[]>("inventario_kardex", { productoId, desde, hasta });
export const registrarEntrada = (entrada: Entrada) => invocar<string>("inventario_entrada", { entrada });
export const obtenerEntrada = (id: string) => invocar<Comprobante>("inventario_entrada_obtener", { id });
export const ajustarInventario = (ajuste: Ajuste, pin: string) => invocar<number>("inventario_ajustar", { ajuste, pin });
export const conteoAbierto = () => invocar<Conteo | null>("inventario_conteo_abierto");
export const guardarConteo = (id: string | null, departamentoId: string | null, datos: Record<string, number>) =>
  invocar<string>("inventario_conteo_guardar", { id, departamentoId, datos });
export const diferenciasConteo = (id: string) => invocar<FilaConteo[]>("inventario_conteo_diferencias", { id });
export const aplicarConteo = (id: string, pin: string) => invocar<number>("inventario_conteo_aplicar", { id, pin });
export const descartarConteo = (id: string) => invocar<void>("inventario_conteo_descartar", { id });
export const inventarioInicial = (filas: FilaInicial[], aplicar: boolean, pin?: string) =>
  invocar<PrevistaInicial[]>("inventario_inicial", { filas, aplicar, pin: pin ?? null });
export const reporteBajoMinimo = () => invocar<FilaBajoMinimo[]>("inventario_reporte_bajo_minimo");
export const reporteValorizado = () => invocar<Valorizado>("inventario_reporte_valorizado");
export const reporteMovimientos = (desde: string, hasta: string, tipo: TipoMovimiento | null) =>
  invocar<FilaKardex[]>("inventario_reporte_movimientos", { desde, hasta, tipo });
export const listarProveedores = () => invocar<Proveedor[]>("proveedores_listar");
export const guardarProveedor = (proveedor: Proveedor) => invocar<string>("proveedor_guardar", { proveedor });
export const eliminarProveedor = (id: string) => invocar<void>("proveedor_eliminar", { id });

/** Día local AAAA-MM-DD → límites ISO para filtrar por fecha (desde incluido, hasta excluido). */
export function rangoDias(desde: string, hasta: string): [string, string] {
  const fin = new Date(`${hasta}T00:00:00`);
  fin.setDate(fin.getDate() + 1);
  return [new Date(`${desde}T00:00:00`).toISOString(), fin.toISOString()];
}

/**
 * CSV de existencias iniciales → filas para Rust. Columnas por nombre (código o id, existencia,
 * costo opcional); sin encabezado reconocible, en ese orden. Rust valida todo de nuevo.
 */
export function filasIniciales(tabla: string[][]): FilaInicial[] {
  if (!tabla.length) return [];
  const cab = tabla[0].map((c) => c.trim().toLowerCase());
  const col = (...n: string[]) => cab.findIndex((c) => n.includes(c));
  const conCabecera = col("codigo", "código", "id", "existencia", "cantidad") >= 0;
  const [iClave, iEx, iCosto] = conCabecera ? [col("codigo", "código", "id"), col("existencia", "cantidad"), col("costo")] : [0, 1, 2];
  if (iClave < 0 || iEx < 0) throw new Error("El archivo necesita las columnas «codigo» (o «id») y «existencia».");
  return tabla
    .slice(conCabecera ? 1 : 0)
    .map((f, i) => ({ fila: i + (conCabecera ? 2 : 1), clave: (f[iClave] ?? "").trim(), existencia: (f[iEx] ?? "").trim(), costo: iCosto >= 0 ? (f[iCosto] ?? "").trim() : "" }))
    .filter((f) => f.clave || f.existencia);
}
