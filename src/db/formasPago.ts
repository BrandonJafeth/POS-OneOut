// Formas de pago y bancos: configuración de cada negocio (nada fijo en el código).
import type { Actor, Banco, FormaPago, TipoFormaPago } from "../tipos";
import { puede, SinPermiso } from "../lib/permisos";
import { ahoraIso } from "../lib/texto";
import { ulid } from "../lib/ulid";
import { bitacora } from "./bitacora";
import { bool, db } from "./conexion";

function aForma(f: Record<string, unknown>): FormaPago {
  return {
    id: String(f.id),
    codigo: String(f.codigo),
    nombre: String(f.nombre),
    tipo: f.tipo as TipoFormaPago,
    requiereBanco: bool(f.requiere_banco),
    requiereReferencia: bool(f.requiere_referencia),
    daVuelto: bool(f.da_vuelto),
    pideUltimos4: bool(f.pide_ultimos4),
    orden: Number(f.orden),
    activo: bool(f.activo),
  };
}

export async function listarFormasPago(opc: { incluirInactivas?: boolean } = {}): Promise<FormaPago[]> {
  const filas = await db().select(
    `SELECT * FROM formas_pago WHERE eliminado_en IS NULL ${opc.incluirInactivas ? "" : "AND activo = 1"} ORDER BY orden, nombre`,
  );
  return filas.map(aForma);
}

export async function listarBancos(opc: { incluirInactivos?: boolean } = {}): Promise<Banco[]> {
  const filas = await db().select(
    `SELECT * FROM bancos WHERE eliminado_en IS NULL ${opc.incluirInactivos ? "" : "AND activo = 1"} ORDER BY orden, nombre`,
  );
  return filas.map((f) => ({ id: String(f.id), nombre: String(f.nombre), orden: Number(f.orden), activo: bool(f.activo) }));
}

function exigir(actor: Actor) {
  if (!puede(actor.rol, "config.tecnica")) throw new SinPermiso("configurar formas de pago");
}

export async function guardarFormaPago(actor: Actor, f: Omit<FormaPago, "id"> & { id?: string }): Promise<string> {
  exigir(actor);
  if (!f.nombre.trim()) throw new Error("Escriba el nombre");
  if (!/^[A-Z0-9]{1,6}$/i.test(f.codigo)) throw new Error("Código: 1 a 6 letras o números");
  const id = f.id ?? ulid();
  const ahora = ahoraIso();
  await db().lote([
    {
      sql: `INSERT INTO formas_pago (id, codigo, nombre, tipo, requiere_banco, requiere_referencia, da_vuelto, pide_ultimos4, orden, activo, creado_en, actualizado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET codigo = excluded.codigo, nombre = excluded.nombre, tipo = excluded.tipo,
              requiere_banco = excluded.requiere_banco, requiere_referencia = excluded.requiere_referencia, da_vuelto = excluded.da_vuelto,
              pide_ultimos4 = excluded.pide_ultimos4, orden = excluded.orden, activo = excluded.activo, actualizado_en = excluded.actualizado_en`,
      params: [id, f.codigo.toUpperCase(), f.nombre.trim(), f.tipo, f.requiereBanco, f.requiereReferencia, f.daVuelto, f.pideUltimos4, f.orden, f.activo, ahora, ahora],
    },
    bitacora(actor.id, "forma_pago.guardar", "forma_pago", id, { ...f, id }),
  ]);
  return id;
}

export async function guardarBanco(actor: Actor, b: Omit<Banco, "id"> & { id?: string }): Promise<string> {
  exigir(actor);
  if (!b.nombre.trim()) throw new Error("Escriba el nombre del banco");
  const id = b.id ?? ulid();
  const ahora = ahoraIso();
  await db().lote([
    {
      sql: `INSERT INTO bancos (id, nombre, orden, activo, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET nombre = excluded.nombre, orden = excluded.orden, activo = excluded.activo, actualizado_en = excluded.actualizado_en`,
      params: [id, b.nombre.trim(), b.orden, b.activo, ahora, ahora],
    },
    bitacora(actor.id, "banco.guardar", "banco", id, { ...b, id }),
  ]);
  return id;
}
