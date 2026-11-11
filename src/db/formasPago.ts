// Formas de pago y bancos: configuración de cada negocio (nada fijo en el código).
import type { Actor, Banco, FormaPago, TipoFormaPago } from "../tipos";
import { puede, SinPermiso } from "../lib/permisos";
import { ahoraIso, limpiarNombre } from "../lib/texto";
import { ulid } from "../lib/ulid";
import { bitacora } from "./bitacora";
import { bool, db } from "./conexion";
import { exigirNombreLibre } from "./unicos";

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
  return filas.map((f) => ({ id: String(f.id), nombre: String(f.nombre), abreviatura: String(f.abreviatura ?? ""), orden: Number(f.orden), activo: bool(f.activo) }));
}

function exigir(actor: Actor) {
  if (!puede(actor.rol, "config.tecnica")) throw new SinPermiso("configurar formas de pago");
}

export async function guardarFormaPago(actor: Actor, f: Omit<FormaPago, "id"> & { id?: string }): Promise<string> {
  exigir(actor);
  if (!f.nombre.trim()) throw new Error("Escriba el nombre");
  if (!/^[A-Z0-9]{1,6}$/i.test(f.codigo)) throw new Error("Código: 1 a 6 letras o números");
  await exigirNombreLibre("formas_pago", f.nombre, f.id, "la forma de pago");
  const id = f.id ?? ulid();
  const ahora = ahoraIso();
  await db().lote([
    {
      id: "forma_pago.guardar",
      params: [id, f.codigo.toUpperCase(), limpiarNombre(f.nombre), f.tipo, f.requiereBanco, f.requiereReferencia, f.daVuelto, f.pideUltimos4, f.orden, f.activo, ahora, ahora],
    },
    bitacora(actor.id, "forma_pago.guardar", "forma_pago", id, { ...f, id }),
  ]);
  return id;
}

export async function guardarBanco(actor: Actor, b: Omit<Banco, "id"> & { id?: string }): Promise<string> {
  exigir(actor);
  if (!b.nombre.trim()) throw new Error("Escriba el nombre del banco");
  await exigirNombreLibre("bancos", b.nombre, b.id, "el banco");
  const id = b.id ?? ulid();
  const ahora = ahoraIso();
  await db().lote([
    {
      id: "banco.guardar",
      params: [id, limpiarNombre(b.nombre), limpiarNombre(b.abreviatura).slice(0, 12), b.orden, b.activo, ahora, ahora],
    },
    bitacora(actor.id, "banco.guardar", "banco", id, { ...b, id }),
  ]);
  return id;
}
