// Clientes (Ley 8968). Reglas:
// - Sin consentimiento no se guarda. Obligatorios solo nombre y teléfono.
// - El cajero ve nombre y teléfono; todo lo demás es del dueño. El técnico no entra.
// - No hay borrado lógico: se ANONIMIZA (el id queda para que el historial cuadre).
// - La bitácora guarda ids, acciones y nombres de campos, NUNCA los datos personales.
import type { Actor, Cliente, ClienteBasico, TipoIdentificacion } from "../tipos";
import { puede, SinPermiso, type Permiso } from "../lib/permisos";
import { ahoraIso, normalizar } from "../lib/texto";
import { ulid } from "../lib/ulid";
import { bitacora } from "./bitacora";
import { bool, db, textoONull, type Sentencia } from "./conexion";
import { iniciarSesion } from "./usuarios";

export const NOMBRE_ANONIMO = "Cliente anonimizado";
export const ADVERTENCIA_NOTAS = "No anote datos de salud, económicos ni sensibles";

export type MotivoAnonimizacion = "solicitud_titular" | "retencion" | "otro";
export const MOTIVOS_ANONIMIZACION: Record<MotivoAnonimizacion, string> = {
  solicitud_titular: "Lo pidió el cliente",
  retencion: "Plazo de retención vencido",
  otro: "Otro motivo",
};

function exigir(actor: Actor, p: Permiso, que: string) {
  if (!puede(actor.rol, p)) throw new SinPermiso(que);
}

function aCliente(f: Record<string, unknown>): Cliente {
  return {
    id: String(f.id),
    nombre: String(f.nombre),
    telefono: textoONull(f.telefono),
    tipoIdentificacion: (f.tipo_identificacion as TipoIdentificacion | null) ?? null,
    cedula: textoONull(f.cedula),
    correo: textoONull(f.correo),
    notas: textoONull(f.notas),
    consentimientoDatos: bool(f.consentimiento_datos),
    consentimientoFecha: textoONull(f.consentimiento_fecha),
    consentimientoVersion: textoONull(f.consentimiento_version),
    anonimizadoEn: textoONull(f.anonimizado_en),
    creadoEn: String(f.creado_en),
    actualizadoEn: String(f.actualizado_en),
  };
}

export interface DatosCliente {
  nombre: string;
  telefono: string;
  tipoIdentificacion?: TipoIdentificacion | null;
  cedula?: string | null;
  correo?: string | null;
  notas?: string | null;
}

const vacioANull = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

function validar(d: DatosCliente) {
  if (!d.nombre.trim()) throw new Error("Escriba el nombre del cliente");
  if (d.nombre.trim() === NOMBRE_ANONIMO) throw new Error("Ese nombre está reservado");
  // Teléfono o cédula: el apartado necesita teléfono (contacto); la factura, cédula.
  const tel = (d.telefono.match(/\d/g) ?? []).length;
  if (tel > 0 && tel < 8) throw new Error("El teléfono debe tener al menos 8 dígitos");
  if (!tel && !d.cedula?.trim()) throw new Error("Escriba el teléfono o la cédula");
  if (d.correo && d.correo.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.correo.trim())) throw new Error("El correo no parece válido");
}

/**
 * Alta de cliente (cajero o dueño). `consentimiento` es la casilla "El cliente fue informado y
 * acepta el uso de sus datos"; `versionAviso`, la versión del aviso que se le mostró.
 */
export async function crearCliente(actor: Actor, d: DatosCliente, consentimiento: boolean, versionAviso: string): Promise<ClienteBasico> {
  exigir(actor, "clientes.basico", "registrar clientes");
  if (consentimiento !== true) throw new Error("Sin el consentimiento del cliente no se pueden guardar sus datos");
  validar(d);
  const id = ulid();
  const ahora = ahoraIso();
  await db().lote([
    {
      sql: `INSERT INTO clientes (id, nombre, nombre_busqueda, tipo_identificacion, cedula, telefono, correo, notas,
              consentimiento_datos, consentimiento_fecha, consentimiento_version, creado_en, actualizado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      params: [
        id,
        d.nombre.trim(),
        normalizar(d.nombre),
        d.tipoIdentificacion ?? null,
        vacioANull(d.cedula),
        vacioANull(d.telefono),
        vacioANull(d.correo),
        vacioANull(d.notas),
        ahora,
        versionAviso,
        ahora,
        ahora,
      ],
    },
    bitacora(actor.id, "cliente.crear", "cliente", id, { consentimientoVersion: versionAviso }),
  ]);
  return { id, nombre: d.nombre.trim(), telefono: vacioANull(d.telefono), cedula: vacioANull(d.cedula) };
}

const sinSeparadores = (col: string) => `replace(replace(${col}, '-', ''), ' ', '')`;

/** Para apartado o venta: solo nombre, teléfono y cédula, buscando por nombre, teléfono o cédula. */
export async function buscarClientesBasico(actor: Actor, texto: string, limite = 15): Promise<ClienteBasico[]> {
  exigir(actor, "clientes.basico", "buscar clientes");
  const t = texto.trim();
  if (!t) return [];
  const digitos = t.replace(/\D/g, "");
  const porNumero = digitos.length >= 3;
  const filas = await db().select(
    `SELECT id, nombre, telefono, cedula FROM clientes
     WHERE anonimizado_en IS NULL AND (nombre_busqueda LIKE ?
       ${porNumero ? `OR ${sinSeparadores("telefono")} LIKE ? OR ${sinSeparadores("cedula")} LIKE ?` : ""})
     ORDER BY nombre_busqueda LIMIT ?`,
    porNumero ? [`%${normalizar(t)}%`, `%${digitos}%`, `%${digitos}%`, limite] : [`%${normalizar(t)}%`, limite],
  );
  return filas.map(aBasico);
}

function aBasico(f: Record<string, unknown>): ClienteBasico {
  return { id: String(f.id), nombre: String(f.nombre), telefono: textoONull(f.telefono), cedula: textoONull(f.cedula) };
}

/** Datos básicos de un cliente (para mostrarlo en la venta). */
export async function clienteBasico(actor: Actor, id: string): Promise<ClienteBasico | null> {
  exigir(actor, "clientes.basico", "ver clientes");
  const f = (await db().select("SELECT id, nombre, telefono, cedula FROM clientes WHERE id = ? AND anonimizado_en IS NULL", [id]))[0];
  return f ? aBasico(f) : null;
}

export type CampoFactura = "nombre" | "cedula" | "correo";

/**
 * Un dato para pegar en el facturador externo (botón "Copiar"). La bitácora anota QUÉ campo
 * se copió y de qué cliente, nunca el valor.
 */
export async function datoParaFactura(actor: Actor, clienteId: string, campo: CampoFactura): Promise<string | null> {
  exigir(actor, "clientes.basico", "copiar datos del cliente");
  const col = { nombre: "nombre", cedula: "cedula", correo: "correo" }[campo];
  const f = (await db().select(`SELECT ${col} AS v FROM clientes WHERE id = ? AND anonimizado_en IS NULL`, [clienteId]))[0];
  await db().lote([bitacora(actor.id, "cliente.copiar", "cliente", clienteId, { campo })]);
  return f ? textoONull(f.v) : null;
}

/** Solo si tiene correo (sin mostrarlo): para el botón "Copiar correo". */
export async function tieneCorreo(clienteId: string): Promise<boolean> {
  const f = (await db().select("SELECT correo FROM clientes WHERE id = ?", [clienteId]))[0];
  return !!f?.correo;
}

/** Lista completa (dueño). Cada consulta queda en bitácora, sin el texto buscado (podría ser un nombre). */
export async function listarClientes(actor: Actor, opc: { texto?: string; incluirAnonimizados?: boolean } = {}): Promise<Cliente[]> {
  exigir(actor, "clientes", "ver la lista de clientes");
  const where = [opc.incluirAnonimizados ? "1 = 1" : "anonimizado_en IS NULL"];
  const params: string[] = [];
  if (opc.texto?.trim()) where.push("nombre_busqueda LIKE ?"), params.push(`%${normalizar(opc.texto)}%`);
  const filas = await db().select(`SELECT * FROM clientes WHERE ${where.join(" AND ")} ORDER BY nombre_busqueda LIMIT 500`, params);
  await db().lote([bitacora(actor.id, "cliente.listar", "cliente", null, { resultados: filas.length, filtrado: !!opc.texto?.trim() })]);
  return filas.map(aCliente);
}

/** Todos los datos de un cliente (derecho de acceso). Queda en bitácora. */
export async function obtenerCliente(actor: Actor, id: string): Promise<Cliente | null> {
  exigir(actor, "clientes", "ver los datos del cliente");
  const f = (await db().select("SELECT * FROM clientes WHERE id = ?", [id]))[0];
  if (!f) return null;
  await db().lote([bitacora(actor.id, "cliente.ver", "cliente", id)]);
  return aCliente(f);
}

/** Rectificación (dueño). En bitácora van solo los NOMBRES de los campos cambiados. */
export async function editarCliente(actor: Actor, id: string, d: DatosCliente): Promise<void> {
  exigir(actor, "clientes", "corregir datos del cliente");
  const f = (await db().select("SELECT * FROM clientes WHERE id = ?", [id]))[0];
  if (!f) throw new Error("Cliente no encontrado");
  const c = aCliente(f);
  if (c.anonimizadoEn) throw new Error("El cliente está anonimizado");
  validar(d);
  const nuevo = {
    nombre: d.nombre.trim(),
    telefono: vacioANull(d.telefono),
    tipoIdentificacion: d.tipoIdentificacion ?? null,
    cedula: vacioANull(d.cedula),
    correo: vacioANull(d.correo),
    notas: vacioANull(d.notas),
  };
  const campos = (Object.keys(nuevo) as (keyof typeof nuevo)[]).filter((k) => nuevo[k] !== c[k]);
  if (!campos.length) return;
  await db().lote([
    {
      sql: `UPDATE clientes SET nombre = ?, nombre_busqueda = ?, telefono = ?, tipo_identificacion = ?, cedula = ?, correo = ?,
              notas = ?, actualizado_en = ? WHERE id = ?`,
      params: [nuevo.nombre, normalizar(nuevo.nombre), nuevo.telefono, nuevo.tipoIdentificacion, nuevo.cedula, nuevo.correo, nuevo.notas, ahoraIso(), id],
    },
    bitacora(actor.id, "cliente.editar", "cliente", id, { campos }),
  ]);
}

export interface CuentaResumen {
  id: string;
  tipo: string;
  fecha: string;
  total: number;
  saldo: number;
  estado: string;
}

async function cuentasDe(id: string): Promise<CuentaResumen[]> {
  const filas = await db().select(
    "SELECT id, tipo, fecha, total, saldo, estado FROM cuentas WHERE cliente_id = ? AND eliminado_en IS NULL ORDER BY fecha",
    [id],
  );
  return filas.map((f) => ({ id: String(f.id), tipo: String(f.tipo), fecha: String(f.fecha), total: Number(f.total), saldo: Number(f.saldo), estado: String(f.estado) }));
}

/** Apartados o créditos abiertos con saldo: mientras existan, no se puede anonimizar. */
export async function cuentasConSaldo(id: string): Promise<CuentaResumen[]> {
  return (await cuentasDe(id)).filter((c) => c.estado === "abierta" && c.saldo > 0);
}

export interface ExportacionCliente {
  cliente: Cliente;
  cuentas: CuentaResumen[];
  ventas: { numero: string; fecha: string; total: number }[];
}

/** Datos para "exportar mis datos" (derecho de acceso). Queda en bitácora con el formato. */
export async function datosParaExportar(actor: Actor, id: string, formato: "csv" | "pdf"): Promise<ExportacionCliente> {
  exigir(actor, "clientes", "exportar datos de clientes");
  const f = (await db().select("SELECT * FROM clientes WHERE id = ?", [id]))[0];
  if (!f) throw new Error("Cliente no encontrado");
  const ventas = await db().select("SELECT numero, fecha, total FROM ventas WHERE cliente_id = ? AND eliminado_en IS NULL ORDER BY fecha", [id]);
  await db().lote([bitacora(actor.id, "cliente.exportar", "cliente", id, { formato })]);
  return {
    cliente: aCliente(f),
    cuentas: await cuentasDe(id),
    ventas: ventas.map((v) => ({ numero: String(v.numero), fecha: String(v.fecha), total: Number(v.total) })),
  };
}

/**
 * Anonimiza de verdad: borra nombre, teléfono, correo, cédula, tipo de identificación y notas
 * (también las notas de sus apartados, que podrían mencionarlo). El id, las ventas, apartados y
 * abonos quedan, con sus montos, para que la contabilidad siga cuadrando.
 * Solo el dueño, confirmando con SU PIN y un motivo.
 */
export async function anonimizarCliente(actor: Actor, id: string, pin: string, motivo: MotivoAnonimizacion): Promise<void> {
  exigir(actor, "clientes", "anonimizar clientes");
  if (!(motivo in MOTIVOS_ANONIMIZACION)) throw new Error("Elija el motivo");
  const f = (await db().select("SELECT anonimizado_en FROM clientes WHERE id = ?", [id]))[0];
  if (!f) throw new Error("Cliente no encontrado");
  if (f.anonimizado_en) throw new Error("El cliente ya está anonimizado");
  const login = await iniciarSesion(actor.id, pin);
  if (!login.ok) {
    await db().lote([bitacora(actor.id, "cliente.anonimizar_rechazado", "cliente", id, { razon: "pin" })]);
    throw new Error(login.motivo === "bloqueado" ? "Demasiados intentos de PIN; espere un momento" : "PIN incorrecto");
  }
  const pendientes = await cuentasConSaldo(id);
  if (pendientes.length) {
    await db().lote([bitacora(actor.id, "cliente.anonimizar_rechazado", "cliente", id, { razon: "saldo", cuentas: pendientes.length })]);
    throw new Error(
      `No se puede anonimizar: tiene ${pendientes.length} apartado(s) o crédito(s) con saldo pendiente. Primero liquídelos o cancélelos.`,
    );
  }
  const ahora = ahoraIso();
  const s: Sentencia[] = [
    {
      sql: `UPDATE clientes SET nombre = ?, nombre_busqueda = ?, telefono = NULL, correo = NULL, cedula = NULL, notas = NULL,
              tipo_identificacion = NULL, anonimizado_en = ?, actualizado_en = ? WHERE id = ?`,
      params: [NOMBRE_ANONIMO, normalizar(NOMBRE_ANONIMO), ahora, ahora, id],
    },
    { sql: "UPDATE cuentas SET notas = '', actualizado_en = ? WHERE cliente_id = ?", params: [ahora, id] },
    bitacora(actor.id, "cliente.anonimizar", "cliente", id, { motivo }),
  ];
  await db().lote(s);
}

/**
 * Clientes sin saldos ni movimientos (ventas, apartados, abonos, cambios) en los últimos `meses`.
 * Solo SUGIERE: anonimizar siempre lo decide el dueño.
 */
export async function sugerenciasRetencion(actor: Actor, meses: number, ahora = new Date()): Promise<ClienteBasico[]> {
  exigir(actor, "clientes", "ver clientes");
  const limite = new Date(ahora);
  limite.setMonth(limite.getMonth() - meses);
  const filas = await db().select(
    `SELECT id, nombre, telefono, cedula FROM (
       SELECT c.id, c.nombre, c.telefono, c.cedula, max(
         c.actualizado_en,
         COALESCE((SELECT max(v.fecha) FROM ventas v WHERE v.cliente_id = c.id), ''),
         COALESCE((SELECT max(k.fecha) FROM cuentas k WHERE k.cliente_id = c.id), ''),
         COALESCE((SELECT max(a.fecha) FROM abonos a JOIN cuentas k ON k.id = a.cuenta_id WHERE k.cliente_id = c.id), '')
       ) AS ultimo
       FROM clientes c
       WHERE c.anonimizado_en IS NULL
         AND NOT EXISTS (SELECT 1 FROM cuentas k WHERE k.cliente_id = c.id AND k.eliminado_en IS NULL AND k.estado = 'abierta' AND k.saldo > 0)
     ) WHERE ultimo < ? ORDER BY ultimo`,
    [limite.toISOString()],
  );
  return filas.map(aBasico);
}
