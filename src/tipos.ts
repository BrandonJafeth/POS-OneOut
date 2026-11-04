// Tipos compartidos entre la capa de datos (src/db), la lógica (src/lib) y las pantallas.

export type Rol = "cajero" | "dueno" | "tecnico";

export const ROL_NOMBRE: Record<Rol, string> = { cajero: "Cajero", dueno: "Dueño", tecnico: "Técnico" };

/** Quién hace la acción (para permisos y bitácora). null = el sistema (primer arranque, migraciones). */
export interface Actor {
  id: string;
  rol: Rol;
}

export interface Usuario {
  id: string;
  nombre: string;
  rol: Rol;
  activo: boolean;
  /** Entró con un PIN puesto por otro o más corto que el mínimo: debe cambiarlo antes de seguir. */
  debeCambiarPin: boolean;
  /** true si debeCambiarPin fue por PIN demasiado corto (no porque otro lo asignó). */
  pinCorto?: boolean;
}

export interface Departamento {
  id: string;
  codigo: string;
  nombre: string;
  orden: number;
  activo: boolean;
  /** Color de la píldora en la venta ("#rrggbb"); null = el de la paleta según el orden. */
  color: string | null;
}

export type TipoCodigo = "barras" | "interno" | "manual";

export interface Codigo {
  codigo: string;
  tipo: TipoCodigo;
}

export interface Producto {
  id: string;
  webId: string | null;
  nombre: string;
  departamentoId: string;
  precio: number;
  activo: boolean;
  /** Campos fiscales (preparación; no se emiten facturas). */
  cabys: string | null;
  tasaIva: number;
  exento: boolean;
  /** Aparece como tarjeta en la pantalla de venta. */
  favorito: boolean;
  /** Entró de la web sin categoría o sin mapeo: el dueño debería revisarlo (se limpia al editarlo). */
  revisar: boolean;
  actualizadoEn: string;
}

export interface ProductoConCodigos extends Producto {
  codigos: Codigo[];
}

/** Fila de la lista del catálogo: el producto con sus códigos ya unidos. */
export interface ProductoLista extends Producto {
  codigos: string[];
  departamento: string;
}

export interface Negocio {
  nombreComercial: string;
  razonSocial: string;
  cedula: string;
  direccion: string;
  telefono: string;
  correo: string;
  regimen: string;
  encabezadoExtra: string;
  pieTiquete: string;
  /** Ley 8968: quién responde por los datos personales y qué se le informa al cliente. */
  responsableTratamiento: string;
  avisoPrivacidadTexto: string;
  avisoPrivacidadVersion: string;
  logo: LogoUnBit | null;
  logoUmbral: number | null;
}

/** Imagen de 1 bit lista para GS v 0 (ancho múltiplo de 8, MSB = punto izquierdo). */
export interface LogoUnBit {
  ancho: number;
  alto: number;
  bits: Uint8Array;
}

export interface Caja {
  id: string;
  sucursalId: string;
  nombre: string;
  prefijoTiquete: string;
  consecutivoSiguiente: number;
}

export type AccionBitacora =
  | "login.fallido"
  | "login.bloqueado"
  | "usuario.crear"
  | "usuario.editar"
  | "usuario.pin"
  | "usuario.eliminar"
  | "producto.crear"
  | "producto.editar"
  | "producto.precio"
  | "producto.eliminar"
  | "codigo.asociar"
  | "codigo.mover"
  | "codigo.quitar"
  | "departamento.crear"
  | "departamento.editar"
  | "config.cambiar"
  | "negocio.cambiar"
  | "negocio.logo"
  | "importacion"
  | "cliente.crear"
  | "cliente.ver"
  | "cliente.listar"
  | "cliente.editar"
  | "cliente.exportar"
  | "cliente.anonimizar"
  | "cliente.anonimizar_rechazado"
  | "respaldo.crear"
  | "cliente.copiar"
  | "autorizacion.fallida"
  | "venta.descuento_autorizado"
  | "venta_espera.descartar"
  | "venta.reimprimir"
  | "venta.pago_corregido"
  | "venta.anular"
  | "venta.pedir_factura"
  | "venta.factura_emitida"
  | "forma_pago.guardar"
  | "banco.guardar"
  | "login.ok"
  | "caja.abrir"
  | "caja.entrada"
  | "caja.salida"
  | "caja.cerrar"
  | "caja.diferencia"
  | "caja.diferencia_revisada"
  | "caja.reabrir"
  | "caja.z_reimprimir"
  | "caja.ajuste_pago"
  | "bitacora.alterada"
  | "bd.integridad_fallida"
  | "respaldo.restaurar"
  | "cliente.ver"
  | "cliente.listar"
  | "cliente.editar";

export interface EntradaBitacora {
  id: string;
  fecha: string;
  usuarioId: string | null;
  usuario: string | null;
  accion: AccionBitacora;
  entidad: string;
  entidadId: string | null;
  detalle: unknown;
}

export type TipoIdentificacion = "fisica" | "juridica" | "dimex" | "nite" | "extranjero";

export const TIPO_IDENTIFICACION: Record<TipoIdentificacion, string> = {
  fisica: "Cédula física",
  juridica: "Cédula jurídica",
  dimex: "DIMEX",
  nite: "NITE",
  extranjero: "Pasaporte / extranjero",
};

/** Lo único que ve el cajero (apartado o venta): nombre, teléfono y cédula. */
export interface ClienteBasico {
  id: string;
  nombre: string;
  telefono: string | null;
  cedula: string | null;
}

export interface Cliente extends ClienteBasico {
  tipoIdentificacion: TipoIdentificacion | null;
  correo: string | null;
  notas: string | null;
  consentimientoDatos: boolean;
  consentimientoFecha: string | null;
  consentimientoVersion: string | null;
  anonimizadoEn: string | null;
  creadoEn: string;
  actualizadoEn: string;
}

// ─────────── Venta (fase 2) ───────────

export type TipoFormaPago = "efectivo" | "tarjeta" | "transferencia" | "sinpe" | "otro";

export interface FormaPago {
  id: string;
  codigo: string;
  nombre: string;
  tipo: TipoFormaPago;
  requiereBanco: boolean;
  requiereReferencia: boolean;
  /** Solo las que dan vuelto (efectivo) pueden pasar del total. */
  daVuelto: boolean;
  pideUltimos4: boolean;
  orden: number;
  activo: boolean;
}

export interface Banco {
  id: string;
  nombre: string;
  /** Lo que sale en el tiquete ("BCR"). Vacío = el nombre. */
  abreviatura: string;
  orden: number;
  activo: boolean;
}

/** Línea de una venta en curso (precio tomado al agregarla). */
export interface LineaEspera {
  id: string;
  productoId: string | null; // null = precio libre
  codigo: string | null;
  descripcion: string;
  departamentoId: string;
  cantidad: number;
  precioUnitario: number;
  /** Descuento de la línea en colones. */
  descuento: number;
  tasaIva: number;
  exento: boolean;
}

export interface EstadoEspera {
  lineas: LineaEspera[];
  /** Descuento al total en colones. */
  descuentoTotal: number;
  cliente: ClienteBasico | null;
  /** "Nombre en tiquete (no guardar)". */
  nombreTiquete: string | null;
  requiereFactura: boolean;
  /** Dueño que autorizó un descuento por encima del tope, y hasta qué %. */
  /** Descuento sobre el tope autorizado por el dueño: token de un solo uso que emitió Rust. */
  autorizacion: { duenoId: string; pct: number; token?: string } | null;
}

export interface VentaEspera {
  id: string;
  numero: number;
  /** Quién empezó la venta (cualquiera del turno la retoma). */
  usuarioId: string;
  usuario: string;
  estado: EstadoEspera;
  actualizadoEn: string;
}

export interface PagoEntrada {
  formaPagoId: string;
  /** Lo que entrega el cliente con esa forma (en efectivo puede pasar del total: da vuelto). */
  monto: number;
  bancoId?: string | null;
  referencia?: string | null;
  ultimos4?: string | null;
}

export interface VentaPago {
  id: string;
  formaPagoId: string;
  forma: string;
  tipo: TipoFormaPago;
  monto: number;
  recibido: number | null;
  vuelto: number | null;
  bancoId: string | null;
  banco: string | null;
  referencia: string | null;
  ultimos4: string | null;
}

export interface VentaLinea {
  id: string;
  productoId: string | null;
  codigo: string | null;
  descripcion: string;
  departamentoId: string;
  cantidad: number;
  precioUnitario: number;
  descuento: number;
  total: number;
  tasaIva: number;
  iva: number;
}

export interface Venta {
  id: string;
  cajaId: string;
  turnoId: string | null;
  /** El turno de caja de la venta sigue abierto (si no, corregir o anular es un ajuste del dueño). */
  turnoAbierto: boolean;
  /** Quién abrió el turno de la venta. */
  turnoUsuarioId: string | null;
  consecutivo: number;
  numero: string;
  fecha: string;
  dia: string;
  usuarioId: string;
  /** Quién la cobró. */
  cajero: string;
  /** Quién empezó la venta en espera (si fue otra persona). */
  esperaCreadaPor: string | null;
  anuladaPor: string | null;
  /** Ya salió el tiquete original (los siguientes son COPIA). */
  impreso: boolean;
  clienteId: string | null;
  cliente: string | null;
  nombreTiquete: string | null;
  subtotal: number;
  descuento: number;
  redondeo: number;
  total: number;
  ivaTotal: number;
  estado: "completada" | "anulada";
  anuladaMotivo: string | null;
  requiereFactura: boolean;
  facturaEmitida: boolean;
  facturaReferencia: string | null;
  reimpresiones: number;
  lineas: VentaLinea[];
  pagos: VentaPago[];
}
