// Venta: ventas en espera, cobro, consecutivo, reimpresión, corrección de pago, anulación,
// pendientes de factura y cierre del día.
//
// Consecutivo sin saltos: el número se toma DENTRO de la transacción del cobro
// (INSERT … SELECT consecutivo_siguiente + UPDATE de la caja). Si el cobro falla, no se gasta
// número; las ventas en espera no tienen número hasta que se cobran. sql_lote usa BEGIN IMMEDIATE,
// así que dos cobros a la vez se ponen en fila.
import type { Actor, EstadoEspera, PagoEntrada, TipoFormaPago, Venta, VentaEspera, VentaLinea, VentaPago } from "../tipos";
import { puede, SinPermiso } from "../lib/permisos";
import { ahoraIso, diaLocal } from "../lib/texto";
import { ulid } from "../lib/ulid";
import { calcularTotales, importeLinea, necesitaAutorizacion, topeDescuento, validarLinea } from "../lib/venta/calculo";
import { calcularPagos } from "../lib/venta/pagos";
import { bitacora } from "./bitacora";
import { CAJA_1 } from "./cajas";
import { bool, db, textoONull, type Sentencia } from "./conexion";
import { leerConfig } from "./config";
import { listarFormasPago } from "./formasPago";
import { autorizarDueno } from "./usuarios";

function exigir(actor: Actor, p: Parameters<typeof puede>[1], que: string) {
  if (!puede(actor.rol, p)) throw new SinPermiso(que);
}

/**
 * Ganchos para fases siguientes (inventario, turnos): cada uno devuelve sentencias que se
 * agregan a la MISMA transacción del cobro o de la anulación. Hoy no hay ninguno registrado.
 */
export const ganchosVenta: {
  alCobrar: ((ventaId: string, e: EstadoEspera) => Sentencia[])[];
  alAnular: ((ventaId: string) => Sentencia[])[];
} = { alCobrar: [], alAnular: [] };

// ─────────── Ventas en espera ───────────

function aEspera(f: Record<string, unknown>): VentaEspera {
  return {
    id: String(f.id),
    numero: Number(f.numero),
    usuarioId: String(f.usuario_id),
    estado: JSON.parse(String(f.datos)) as EstadoEspera,
    actualizadoEn: String(f.actualizado_en),
  };
}

export async function listarEsperas(cajaId = CAJA_1): Promise<VentaEspera[]> {
  const filas = await db().select("SELECT * FROM ventas_espera WHERE caja_id = ? AND eliminado_en IS NULL ORDER BY numero", [cajaId]);
  return filas.map(aEspera);
}

/**
 * Nueva pestaña: toma el número libre más bajo (1, 2, 3…). Se calcula DENTRO del INSERT
 * (misma transacción): dos pestañas creadas a la vez no reciben el mismo número.
 */
export async function crearEspera(actor: Actor, estado: EstadoEspera, cajaId = CAJA_1): Promise<VentaEspera> {
  exigir(actor, "venta", "vender");
  const id = ulid();
  const ahora = ahoraIso();
  const activas = "SELECT numero FROM ventas_espera WHERE caja_id = ? AND eliminado_en IS NULL";
  await db().lote([
    {
      sql: `INSERT INTO ventas_espera (id, sucursal_id, caja_id, usuario_id, numero, datos, creado_en, actualizado_en)
            SELECT ?, c.sucursal_id, c.id, ?,
              (SELECT MIN(n + 1) FROM (SELECT 0 AS n UNION ALL ${activas}) WHERE n + 1 NOT IN (${activas})),
              ?, ?, ?
            FROM cajas c WHERE c.id = ?`,
      params: [id, actor.id, cajaId, cajaId, JSON.stringify(estado), ahora, ahora, cajaId],
    },
  ]);
  const numero = Number((await db().select("SELECT numero FROM ventas_espera WHERE id = ?", [id]))[0].numero);
  return { id, numero, usuarioId: actor.id, estado, actualizadoEn: ahora };
}

/** Se llama en cada cambio de la venta: si se va la luz, queda lo último. */
export async function guardarEspera(id: string, estado: EstadoEspera): Promise<void> {
  await db().execute("UPDATE ventas_espera SET datos = ?, actualizado_en = ? WHERE id = ? AND eliminado_en IS NULL", [
    JSON.stringify(estado),
    ahoraIso(),
    id,
  ]);
}

export async function descartarEspera(actor: Actor, id: string, paso = 1): Promise<void> {
  exigir(actor, "venta", "descartar ventas");
  const f = (await db().select("SELECT * FROM ventas_espera WHERE id = ? AND eliminado_en IS NULL", [id]))[0];
  if (!f) return;
  const e = aEspera(f);
  const ahora = ahoraIso();
  await db().lote([
    { sql: "UPDATE ventas_espera SET eliminado_en = ?, actualizado_en = ? WHERE id = ?", params: [ahora, ahora, id] },
    bitacora(actor.id, "venta_espera.descartar", "venta_espera", id, {
      numero: e.numero,
      lineas: e.estado.lineas.length,
      total: calcularTotales(e.estado, paso).total,
    }),
  ]);
}

// ─────────── Cobro ───────────

export interface ResultadoCobro {
  ventaId: string;
  numero: string;
  vuelto: number;
  hayEfectivo: boolean;
}

/**
 * Cobra la venta en espera `esperaId`. Todo se vuelve a validar aquí (aunque la pantalla ya lo
 * haya hecho): líneas, descuentos y su autorización, pagos. Venta, líneas, pagos, consecutivo y
 * cierre de la espera van en UNA transacción.
 */
export async function cobrarVenta(actor: Actor, esperaId: string, e: EstadoEspera, pagos: PagoEntrada[], cajaId = CAJA_1): Promise<ResultadoCobro> {
  exigir(actor, "venta", "vender");
  const config = await leerConfig();
  if (!e.lineas.length) throw new Error("La venta no tiene productos");
  for (const l of e.lineas) {
    const err = validarLinea(l);
    if (err) throw new Error(err);
  }
  const t = calcularTotales(e, config.redondeo_total);
  const tope = topeDescuento(actor.rol, config.descuento_max_pct);
  if (necesitaAutorizacion(e, t.pctDescuento, tope)) throw new Error("El descuento pasa su tope: necesita el PIN del dueño");
  let autorizadoPor: string | null = null;
  if (t.pctDescuento > tope + 1e-9) {
    const d = (await db().select("SELECT id FROM usuarios WHERE id = ? AND rol = 'dueno' AND activo = 1 AND eliminado_en IS NULL", [e.autorizacion!.duenoId]))[0];
    if (!d) throw new Error("La autorización del descuento no es válida");
    autorizadoPor = String(d.id);
  }
  if (e.requiereFactura && !e.cliente) throw new Error("Para factura electrónica, elija o cree el cliente");
  if (e.cliente) {
    const c = (await db().select("SELECT id FROM clientes WHERE id = ? AND anonimizado_en IS NULL", [e.cliente.id]))[0];
    if (!c) throw new Error("El cliente ya no existe");
  }

  const formas = await listarFormasPago();
  const rp = calcularPagos(t.total, pagos, formas);
  if (rp.errores.length) throw new Error(rp.errores.join(". "));
  if (rp.faltante > 0) throw new Error("Falta pagar " + rp.faltante);
  const efectivo = new Set(formas.filter((f) => f.daVuelto).map((f) => f.id));

  const ventaId = ulid();
  const ahora = new Date();
  const fecha = ahora.toISOString();
  const s: Sentencia[] = [
    {
      // El JOIN con la espera activa hace que un doble clic en "Cobrar" no cree dos ventas:
      // la segunda vez la espera ya está cerrada, no se inserta la venta y las líneas fallan por FK.
      sql: `INSERT INTO ventas (id, sucursal_id, caja_id, consecutivo, numero, fecha, dia, usuario_id, cliente_id, nombre_tiquete,
              subtotal, descuento, redondeo, total, iva_total, requiere_factura, descuento_autorizado_por, creado_en, actualizado_en)
            SELECT ?, c.sucursal_id, c.id, c.consecutivo_siguiente, c.prefijo_tiquete || c.consecutivo_siguiente, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?
            FROM cajas c JOIN ventas_espera e ON e.id = ? AND e.caja_id = c.id AND e.eliminado_en IS NULL
            WHERE c.id = ? AND c.eliminado_en IS NULL`,
      params: [
        ventaId,
        fecha,
        diaLocal(ahora),
        actor.id,
        e.cliente?.id ?? null,
        e.nombreTiquete?.trim() || null,
        t.subtotal,
        t.descuento,
        t.redondeo,
        t.total,
        t.iva,
        e.requiereFactura,
        autorizadoPor,
        fecha,
        fecha,
        esperaId,
        cajaId,
      ],
    },
    { sql: "UPDATE cajas SET consecutivo_siguiente = consecutivo_siguiente + 1, actualizado_en = ? WHERE id = ?", params: [fecha, cajaId] },
    ...e.lineas.map((l, i) => ({
      sql: `INSERT INTO venta_lineas (id, venta_id, producto_id, codigo, descripcion, departamento_id, cantidad, precio_unitario,
              descuento, total, tasa_iva, iva, orden, creado_en, actualizado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [ulid(), ventaId, l.productoId, l.codigo, l.descripcion, l.departamentoId, l.cantidad, l.precioUnitario, l.descuento, importeLinea(l), l.exento ? 0 : l.tasaIva, t.ivaLineas[i], i, fecha, fecha],
    })),
    ...rp.aplicados.map((a) => ({
      sql: `INSERT INTO venta_pagos (id, venta_id, forma_pago_id, banco_id, monto, recibido, vuelto, referencia, ultimos4, creado_en, actualizado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [ulid(), ventaId, a.formaPagoId, a.bancoId ?? null, a.aplicado, a.recibido, a.vuelto, a.referencia?.trim() || null, a.ultimos4 || null, fecha, fecha],
    })),
    {
      sql: "UPDATE ventas_espera SET eliminado_en = ?, venta_id = ?, datos = ?, actualizado_en = ? WHERE id = ?",
      params: [fecha, ventaId, JSON.stringify(e), fecha, esperaId],
    },
    ...ganchosVenta.alCobrar.flatMap((g) => g(ventaId, e)),
  ];
  if (autorizadoPor)
    s.push(bitacora(actor.id, "venta.descuento_autorizado", "venta", ventaId, { pct: Math.round(t.pctDescuento * 10) / 10, autorizadoPor }));
  try {
    await db().lote(s);
  } catch (err) {
    if (/FOREIGN KEY/i.test(String(err))) throw new Error("Esta venta ya se cobró o se descartó");
    throw err;
  }
  const numero = String((await db().select("SELECT numero FROM ventas WHERE id = ?", [ventaId]))[0].numero);
  return { ventaId, numero, vuelto: rp.vuelto, hayEfectivo: rp.aplicados.some((a) => efectivo.has(a.formaPagoId)) };
}

// ─────────── Consultas ───────────

export async function obtenerVenta(id: string): Promise<Venta | null> {
  const f = (
    await db().select(
      `SELECT v.*, u.nombre AS cajero, c.nombre AS cliente FROM ventas v
       JOIN usuarios u ON u.id = v.usuario_id LEFT JOIN clientes c ON c.id = v.cliente_id
       WHERE v.id = ? AND v.eliminado_en IS NULL`,
      [id],
    )
  )[0];
  if (!f) return null;
  const lineas = await db().select("SELECT * FROM venta_lineas WHERE venta_id = ? AND eliminado_en IS NULL ORDER BY orden", [id]);
  const pagos = await db().select(
    `SELECT p.*, f.nombre AS forma, f.tipo, b.nombre AS banco FROM venta_pagos p
     JOIN formas_pago f ON f.id = p.forma_pago_id LEFT JOIN bancos b ON b.id = p.banco_id
     WHERE p.venta_id = ? AND p.eliminado_en IS NULL ORDER BY p.creado_en, p.id`,
    [id],
  );
  return {
    id: String(f.id),
    cajaId: String(f.caja_id),
    consecutivo: Number(f.consecutivo),
    numero: String(f.numero),
    fecha: String(f.fecha),
    dia: String(f.dia ?? String(f.fecha).slice(0, 10)),
    usuarioId: String(f.usuario_id),
    cajero: String(f.cajero),
    clienteId: textoONull(f.cliente_id),
    cliente: textoONull(f.cliente),
    nombreTiquete: textoONull(f.nombre_tiquete),
    subtotal: Number(f.subtotal),
    descuento: Number(f.descuento),
    redondeo: Number(f.redondeo ?? 0),
    total: Number(f.total),
    ivaTotal: Number(f.iva_total ?? 0),
    estado: f.estado as Venta["estado"],
    anuladaMotivo: textoONull(f.anulada_motivo),
    requiereFactura: bool(f.requiere_factura),
    facturaEmitida: bool(f.factura_emitida),
    facturaReferencia: textoONull(f.factura_referencia),
    reimpresiones: Number(f.reimpresiones ?? 0),
    lineas: lineas.map(
      (l): VentaLinea => ({
        id: String(l.id),
        productoId: textoONull(l.producto_id),
        codigo: textoONull(l.codigo),
        descripcion: String(l.descripcion),
        departamentoId: String(l.departamento_id),
        cantidad: Number(l.cantidad),
        precioUnitario: Number(l.precio_unitario),
        descuento: Number(l.descuento),
        total: Number(l.total),
        tasaIva: Number(l.tasa_iva),
        iva: Number(l.iva),
      }),
    ),
    pagos: pagos.map(
      (p): VentaPago => ({
        id: String(p.id),
        formaPagoId: String(p.forma_pago_id),
        forma: String(p.forma),
        tipo: p.tipo as TipoFormaPago,
        monto: Number(p.monto),
        recibido: p.recibido == null ? null : Number(p.recibido),
        vuelto: p.vuelto == null ? null : Number(p.vuelto),
        bancoId: textoONull(p.banco_id),
        banco: textoONull(p.banco),
        referencia: textoONull(p.referencia),
        ultimos4: textoONull(p.ultimos4),
      }),
    ),
  };
}

export interface VentaResumen {
  id: string;
  numero: string;
  fecha: string;
  total: number;
  estado: string;
  cajero: string;
  requiereFactura: boolean;
  facturaEmitida: boolean;
  formas: string;
}

export async function listarVentasDia(dia = diaLocal(), cajaId = CAJA_1): Promise<VentaResumen[]> {
  const filas = await db().select(
    `SELECT v.id, v.numero, v.fecha, v.total, v.estado, v.requiere_factura, v.factura_emitida, u.nombre AS cajero,
       (SELECT group_concat(f.nombre, ' + ') FROM venta_pagos p JOIN formas_pago f ON f.id = p.forma_pago_id
        WHERE p.venta_id = v.id AND p.eliminado_en IS NULL) AS formas
     FROM ventas v JOIN usuarios u ON u.id = v.usuario_id
     WHERE v.caja_id = ? AND v.dia = ? AND v.eliminado_en IS NULL ORDER BY v.consecutivo DESC`,
    [cajaId, dia],
  );
  return filas.map((f) => ({
    id: String(f.id),
    numero: String(f.numero),
    fecha: String(f.fecha),
    total: Number(f.total),
    estado: String(f.estado),
    cajero: String(f.cajero),
    requiereFactura: bool(f.requiere_factura),
    facturaEmitida: bool(f.factura_emitida),
    formas: String(f.formas ?? ""),
  }));
}

export async function registrarReimpresion(actor: Actor, ventaId: string): Promise<void> {
  exigir(actor, "venta", "reimprimir");
  await db().lote([
    { sql: "UPDATE ventas SET reimpresiones = reimpresiones + 1 WHERE id = ?", params: [ventaId] },
    bitacora(actor.id, "venta.reimprimir", "venta", ventaId),
  ]);
}

/** Efectivo que debería haber en caja por ventas del día (lo cobrado en efectivo, ya sin vuelto). Gancho para el arqueo. */
export async function efectivoEsperado(dia = diaLocal(), cajaId = CAJA_1): Promise<number> {
  const f = (
    await db().select(
      `SELECT COALESCE(SUM(p.monto), 0) AS n FROM venta_pagos p JOIN ventas v ON v.id = p.venta_id JOIN formas_pago f ON f.id = p.forma_pago_id
       WHERE v.caja_id = ? AND v.dia = ? AND v.estado = 'completada' AND v.eliminado_en IS NULL AND p.eliminado_en IS NULL AND f.da_vuelto = 1`,
      [cajaId, dia],
    )
  )[0];
  return Number(f.n);
}

// ─────────── Día ───────────

export async function diaCerrado(dia: string, cajaId = CAJA_1): Promise<boolean> {
  return (await db().select("SELECT 1 FROM cierres_dia WHERE caja_id = ? AND dia = ? AND eliminado_en IS NULL", [cajaId, dia])).length > 0;
}

/** Abierto = es hoy y todavía no se cerró. Un día anterior se considera cerrado aunque nadie lo cerrara. */
export async function diaAbierto(dia: string, cajaId = CAJA_1, hoy = diaLocal()): Promise<boolean> {
  return dia === hoy && !(await diaCerrado(dia, cajaId));
}

export async function cerrarDia(actor: Actor, cajaId = CAJA_1, dia = diaLocal()): Promise<void> {
  exigir(actor, "dia.cerrar", "cerrar el día");
  if (await diaCerrado(dia, cajaId)) throw new Error("El día ya está cerrado");
  const esperas = (await listarEsperas(cajaId)).length;
  const ahora = ahoraIso();
  const id = ulid();
  await db().lote([
    {
      sql: "INSERT INTO cierres_dia (id, sucursal_id, caja_id, dia, usuario_id, cerrado_en) SELECT ?, sucursal_id, id, ?, ?, ? FROM cajas WHERE id = ?",
      params: [id, dia, actor.id, ahora, cajaId],
    },
    bitacora(actor.id, "dia.cerrar", "cierre_dia", id, { dia, esperasAbiertas: esperas, efectivoEsperado: await efectivoEsperado(dia, cajaId) }),
  ]);
}

// ─────────── Corrección de forma de pago ───────────

export interface CambioPago {
  formaPagoId: string;
  bancoId?: string | null;
  referencia?: string | null;
  ultimos4?: string | null;
}

/**
 * Cambia la forma de pago de un pago ya registrado (p. ej. se marcó Tarjeta y era SINPE).
 * El monto no cambia, así que el total de la venta se mantiene. Solo con el día abierto.
 * Si entra o sale efectivo, pide el PIN del dueño (cambia lo esperado en caja).
 */
export async function corregirPago(actor: Actor, pagoId: string, cambio: CambioPago, motivo: string, pinDueno?: string): Promise<void> {
  exigir(actor, "venta", "corregir pagos");
  if (motivo.trim().length < 5) throw new Error("Escriba el motivo de la corrección");
  const p = (
    await db().select(
      `SELECT p.*, v.dia, v.caja_id, v.estado, f.da_vuelto, f.nombre AS forma FROM venta_pagos p
       JOIN ventas v ON v.id = p.venta_id JOIN formas_pago f ON f.id = p.forma_pago_id
       WHERE p.id = ? AND p.eliminado_en IS NULL`,
      [pagoId],
    )
  )[0];
  if (!p) throw new Error("Pago no encontrado");
  if (p.estado !== "completada") throw new Error("La venta está anulada");
  if (!(await diaAbierto(String(p.dia), String(p.caja_id)))) throw new Error("El día de esa venta ya se cerró: no se puede corregir el pago");

  const nueva = (await listarFormasPago()).find((f) => f.id === cambio.formaPagoId);
  if (!nueva) throw new Error("Forma de pago no disponible");
  if (nueva.requiereBanco && !cambio.bancoId) throw new Error(`${nueva.nombre}: elija el banco`);
  if (nueva.requiereReferencia && !cambio.referencia?.trim()) throw new Error(`${nueva.nombre}: escriba la referencia`);
  if (cambio.ultimos4 && !/^\d{4}$/.test(cambio.ultimos4)) throw new Error("Los últimos 4 dígitos son 4 números");
  const n = {
    banco: nueva.requiereBanco ? (cambio.bancoId ?? null) : null,
    referencia: cambio.referencia?.trim() || null,
    ultimos4: nueva.pideUltimos4 ? cambio.ultimos4 || null : null,
  };
  if (cambio.formaPagoId === p.forma_pago_id && n.banco === (p.banco_id ?? null) && n.referencia === (p.referencia ?? null) && n.ultimos4 === (p.ultimos4 ?? null))
    throw new Error("No hay cambios");

  let autorizadoPor: string | null = null;
  // De efectivo a otra forma, o al revés: cambia lo que debería haber en la gaveta.
  if (bool(p.da_vuelto) !== nueva.daVuelto) {
    const d = pinDueno ? await autorizarDueno(pinDueno, "corregir pago con efectivo", actor.id) : null;
    if (!d) throw new Error("El cambio afecta el efectivo de la caja: necesita el PIN del dueño");
    autorizadoPor = d.id;
  }
  const monto = Number(p.monto);
  const ahora = ahoraIso();
  const correccionId = ulid();
  await db().lote([
    {
      sql: `INSERT INTO venta_pago_correcciones (id, venta_pago_id, forma_pago_anterior_id, forma_pago_nueva_id, banco_anterior_id, banco_nuevo_id,
              referencia_anterior, referencia_nueva, ultimos4_anterior, ultimos4_nuevo, motivo, usuario_id, autorizado_por, fecha)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [correccionId, pagoId, String(p.forma_pago_id), nueva.id, textoONull(p.banco_id), n.banco, textoONull(p.referencia), n.referencia, textoONull(p.ultimos4), n.ultimos4, motivo.trim(), actor.id, autorizadoPor, ahora],
    },
    {
      // Al pasar a efectivo, lo recibido es el monto (sin vuelto); al salir del efectivo, se borra recibido/vuelto.
      sql: "UPDATE venta_pagos SET forma_pago_id = ?, banco_id = ?, referencia = ?, ultimos4 = ?, recibido = ?, vuelto = ?, actualizado_en = ? WHERE id = ?",
      params: [nueva.id, n.banco, n.referencia, n.ultimos4, nueva.daVuelto ? (bool(p.da_vuelto) ? Number(p.recibido ?? monto) : monto) : null, nueva.daVuelto ? (bool(p.da_vuelto) ? Number(p.vuelto ?? 0) : 0) : null, ahora, pagoId],
    },
    bitacora(actor.id, "venta.pago_corregido", "venta", String(p.venta_id), {
      pagoId,
      correccionId,
      monto,
      antes: { forma: String(p.forma), banco: textoONull(p.banco_id), referencia: textoONull(p.referencia), ultimos4: textoONull(p.ultimos4) },
      despues: { forma: nueva.nombre, banco: n.banco, referencia: n.referencia, ultimos4: n.ultimos4 },
      autorizadoPor,
    }),
  ]);
}

export async function correccionesDe(ventaId: string) {
  return db().select(
    `SELECT c.fecha, c.motivo, fa.nombre AS antes, fn.nombre AS despues, u.nombre AS usuario FROM venta_pago_correcciones c
     JOIN venta_pagos p ON p.id = c.venta_pago_id JOIN formas_pago fa ON fa.id = c.forma_pago_anterior_id
     JOIN formas_pago fn ON fn.id = c.forma_pago_nueva_id JOIN usuarios u ON u.id = c.usuario_id
     WHERE p.venta_id = ? ORDER BY c.fecha`,
    [ventaId],
  );
}

// ─────────── Anulación ───────────

/** Solo con PIN de dueño y motivo. La venta queda (estado anulada) y conserva su consecutivo. */
export async function anularVenta(actor: Actor, ventaId: string, pinDueno: string, motivo: string): Promise<void> {
  exigir(actor, "venta", "anular ventas");
  if (motivo.trim().length < 5) throw new Error("Escriba el motivo de la anulación");
  const v = (await db().select("SELECT numero, total, estado FROM ventas WHERE id = ? AND eliminado_en IS NULL", [ventaId]))[0];
  if (!v) throw new Error("Venta no encontrada");
  if (v.estado === "anulada") throw new Error("La venta ya está anulada");
  const d = await autorizarDueno(pinDueno, "anular venta", actor.id);
  if (!d) throw new Error("PIN de dueño incorrecto");
  const ahora = ahoraIso();
  await db().lote([
    {
      sql: "UPDATE ventas SET estado = 'anulada', anulada_por = ?, anulada_motivo = ?, anulada_en = ?, actualizado_en = ? WHERE id = ?",
      params: [d.id, motivo.trim(), ahora, ahora, ventaId],
    },
    ...ganchosVenta.alAnular.flatMap((g) => g(ventaId)), // inventario: devolver existencias (fase siguiente)
    bitacora(actor.id, "venta.anular", "venta", ventaId, { numero: String(v.numero), total: Number(v.total), motivo: motivo.trim(), autorizadoPor: d.id }),
  ]);
}

// ─────────── Factura electrónica externa ───────────

export interface PendienteFactura {
  ventaId: string;
  numero: string;
  fecha: string;
  total: number;
  clienteId: string;
  cliente: string;
  cedula: string | null;
  tieneCorreo: boolean;
}

export async function pendientesFactura(actor: Actor): Promise<PendienteFactura[]> {
  exigir(actor, "facturas", "ver pendientes de factura");
  const filas = await db().select(
    `SELECT v.id, v.numero, v.fecha, v.total, c.id AS cliente_id, c.nombre, c.cedula, c.correo IS NOT NULL AS tiene_correo
     FROM ventas v JOIN clientes c ON c.id = v.cliente_id
     WHERE v.requiere_factura = 1 AND v.factura_emitida = 0 AND v.estado = 'completada' AND v.eliminado_en IS NULL
     ORDER BY v.fecha`,
  );
  return filas.map((f) => ({
    ventaId: String(f.id),
    numero: String(f.numero),
    fecha: String(f.fecha),
    total: Number(f.total),
    clienteId: String(f.cliente_id),
    cliente: String(f.nombre),
    cedula: textoONull(f.cedula),
    tieneCorreo: bool(f.tiene_correo),
  }));
}

export async function marcarFacturaEmitida(actor: Actor, ventaId: string, referencia: string): Promise<void> {
  exigir(actor, "facturas", "marcar facturas");
  if (!referencia.trim()) throw new Error("Escriba el número o la clave de la factura");
  const pendiente = await db().select("SELECT 1 FROM ventas WHERE id = ? AND requiere_factura = 1 AND factura_emitida = 0", [ventaId]);
  if (!pendiente.length) throw new Error("Esa venta no está pendiente de factura");
  const ahora = ahoraIso();
  await db().lote([
    {
      sql: `UPDATE ventas SET factura_emitida = 1, factura_referencia = ?, factura_marcada_por = ?, factura_marcada_en = ?, actualizado_en = ?
            WHERE id = ?`,
      params: [referencia.trim(), actor.id, ahora, ahora, ventaId],
    },
    bitacora(actor.id, "venta.factura_emitida", "venta", ventaId, { referencia: referencia.trim() }),
  ]);
}
