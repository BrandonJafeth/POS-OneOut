// Usuarios, PIN y sesión. El hash lo calcula Rust (Argon2id); aquí se inyecta como Hasher
// para que las pruebas puedan usar uno falso sin Tauri.
import type { Actor, Rol, Usuario } from "../tipos";
import { esperaTrasFallos, esperaRestante, PIN_VALIDO } from "../lib/bloqueo";
import { rolesAdministrables, SinPermiso } from "../lib/permisos";
import { ahoraIso, normalizar } from "../lib/texto";
import { ulid } from "../lib/ulid";
import { bitacora } from "./bitacora";
import { bool, db, textoONull } from "./conexion";

export interface Hasher {
  hash(pin: string): Promise<string>;
  verificar(pin: string, hash: string): Promise<boolean>;
}

let hasher: Hasher | null = null;
export function usarHasher(h: Hasher): void {
  hasher = h;
}
function h(): Hasher {
  if (!hasher) throw new Error("Hasher de PIN no configurado");
  return hasher;
}

function aUsuario(f: Record<string, unknown>): Usuario {
  return {
    id: String(f.id),
    nombre: String(f.nombre),
    rol: f.rol as Rol,
    activo: bool(f.activo),
    intentosFallidos: Number(f.intentos_fallidos ?? 0),
    bloqueadoHasta: textoONull(f.bloqueado_hasta),
  };
}

const ORDEN_ROL = "CASE rol WHEN 'tecnico' THEN 0 WHEN 'dueno' THEN 1 ELSE 2 END";

export async function listarUsuarios(opc: { incluirTecnico?: boolean; soloActivos?: boolean } = {}): Promise<Usuario[]> {
  const filas = await db().select(
    `SELECT * FROM usuarios WHERE eliminado_en IS NULL
     ${opc.incluirTecnico ? "" : "AND rol <> 'tecnico'"} ${opc.soloActivos ? "AND activo = 1" : ""}
     ORDER BY ${ORDEN_ROL}, nombre`,
  );
  return filas.map(aUsuario);
}

export async function obtenerUsuario(id: string): Promise<Usuario | null> {
  const f = (await db().select("SELECT * FROM usuarios WHERE id = ? AND eliminado_en IS NULL", [id]))[0];
  return f ? aUsuario(f) : null;
}

export async function tecnico(): Promise<Usuario | null> {
  const f = (await db().select("SELECT * FROM usuarios WHERE rol = 'tecnico' AND eliminado_en IS NULL LIMIT 1"))[0];
  return f ? aUsuario(f) : null;
}

function validarPin(pin: string) {
  if (!PIN_VALIDO.test(pin)) throw new Error("El PIN debe tener de 4 a 8 números");
}

async function validarNombre(nombre: string, excluirId?: string) {
  if (!nombre.trim()) throw new Error("Escriba el nombre");
  const otros = await listarUsuarios({ incluirTecnico: true });
  if (otros.some((u) => u.id !== excluirId && normalizar(u.nombre) === normalizar(nombre)))
    throw new Error("Ya existe un usuario con ese nombre");
}

/** El usuario técnico del primer arranque (solo si todavía no existe). */
export async function crearTecnicoInicial(pin: string): Promise<Usuario> {
  if (await tecnico()) throw new Error("El usuario técnico ya existe");
  validarPin(pin);
  const id = ulid();
  await db().lote([
    {
      sql: "INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES (?, 'Técnico', 'tecnico', ?)",
      params: [id, await h().hash(pin)],
    },
    bitacora(id, "usuario.crear", "usuario", id, { rol: "tecnico", primerArranque: true }),
  ]);
  return (await obtenerUsuario(id))!;
}

export async function crearUsuario(actor: Actor, datos: { nombre: string; rol: Rol; pin: string }): Promise<Usuario> {
  if (!rolesAdministrables(actor.rol).includes(datos.rol)) throw new SinPermiso("crear ese tipo de usuario");
  await validarNombre(datos.nombre);
  validarPin(datos.pin);
  const id = ulid();
  await db().lote([
    {
      sql: "INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES (?, ?, ?, ?)",
      params: [id, datos.nombre.trim(), datos.rol, await h().hash(datos.pin)],
    },
    bitacora(actor.id, "usuario.crear", "usuario", id, { nombre: datos.nombre.trim(), rol: datos.rol }),
  ]);
  return (await obtenerUsuario(id))!;
}

async function objetivoAdministrable(actor: Actor, id: string): Promise<Usuario> {
  const u = await obtenerUsuario(id);
  if (!u) throw new Error("Usuario no encontrado");
  if (u.id !== actor.id && !rolesAdministrables(actor.rol).includes(u.rol)) throw new SinPermiso("administrar ese usuario");
  return u;
}

export async function editarUsuario(actor: Actor, id: string, cambios: { nombre?: string; activo?: boolean }): Promise<void> {
  const u = await objetivoAdministrable(actor, id);
  if (cambios.activo === false && u.id === actor.id) throw new Error("No puede desactivarse a sí mismo");
  if (cambios.nombre !== undefined) await validarNombre(cambios.nombre, id);
  const nombre = cambios.nombre?.trim() ?? u.nombre;
  const activo = cambios.activo ?? u.activo;
  await db().lote([
    {
      sql: "UPDATE usuarios SET nombre = ?, activo = ?, actualizado_en = ? WHERE id = ?",
      params: [nombre, activo, ahoraIso(), id],
    },
    bitacora(actor.id, "usuario.editar", "usuario", id, { antes: { nombre: u.nombre, activo: u.activo }, despues: { nombre, activo } }),
  ]);
}

export async function cambiarPin(actor: Actor, id: string, pin: string): Promise<void> {
  await objetivoAdministrable(actor, id);
  validarPin(pin);
  await db().lote([
    {
      sql: "UPDATE usuarios SET pin_hash = ?, intentos_fallidos = 0, bloqueado_hasta = NULL, actualizado_en = ? WHERE id = ?",
      params: [await h().hash(pin), ahoraIso(), id],
    },
    bitacora(actor.id, "usuario.pin", "usuario", id),
  ]);
}

/** Borrado lógico: el usuario queda en ventas y bitácora, pero ya no aparece ni puede entrar. */
export async function eliminarUsuario(actor: Actor, id: string): Promise<void> {
  const u = await objetivoAdministrable(actor, id);
  if (u.id === actor.id) throw new Error("No puede eliminarse a sí mismo");
  const ahora = ahoraIso();
  await db().lote([
    { sql: "UPDATE usuarios SET eliminado_en = ?, activo = 0, actualizado_en = ? WHERE id = ?", params: [ahora, ahora, id] },
    bitacora(actor.id, "usuario.eliminar", "usuario", id, { nombre: u.nombre, rol: u.rol }),
  ]);
}

export type ResultadoLogin =
  | { ok: true; usuario: Usuario }
  | { ok: false; motivo: "bloqueado"; esperaMs: number }
  | { ok: false; motivo: "pin"; esperaMs: number; intentos: number }
  | { ok: false; motivo: "inexistente" };

export async function iniciarSesion(usuarioId: string, pin: string, ahora = Date.now()): Promise<ResultadoLogin> {
  const u = await obtenerUsuario(usuarioId);
  if (!u || !u.activo) return { ok: false, motivo: "inexistente" };
  const espera = esperaRestante(u.bloqueadoHasta, ahora);
  if (espera > 0) return { ok: false, motivo: "bloqueado", esperaMs: espera };

  const hashGuardado = (await db().select("SELECT pin_hash FROM usuarios WHERE id = ?", [u.id]))[0]?.pin_hash;
  if (await h().verificar(pin, String(hashGuardado ?? ""))) {
    if (u.intentosFallidos > 0 || u.bloqueadoHasta)
      await db().execute("UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?", [u.id]);
    return { ok: true, usuario: { ...u, intentosFallidos: 0, bloqueadoHasta: null } };
  }

  const intentos = u.intentosFallidos + 1;
  const esperaMs = esperaTrasFallos(intentos);
  const hasta = esperaMs ? new Date(ahora + esperaMs).toISOString() : null;
  await db().lote([
    { sql: "UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = ? WHERE id = ?", params: [intentos, hasta, u.id] },
    bitacora(u.id, esperaMs ? "login.bloqueado" : "login.fallido", "usuario", u.id, { intentos, esperaMs }),
  ]);
  return { ok: false, motivo: "pin", esperaMs, intentos };
}

/**
 * Autorización del dueño "en el momento" (descuento alto, anulación, corrección con efectivo):
 * basta el PIN de cualquier dueño activo. Devuelve ese dueño, o null si el PIN no es de ninguno.
 * Cada fallo queda en bitácora; con 5 fallos en un minuto se frena un rato.
 */
export async function autorizarDueno(pin: string, contexto: string, actorId: string | null, ahora = Date.now()): Promise<Usuario | null> {
  const desde = new Date(ahora - 60_000).toISOString();
  const recientes = Number(
    (await db().select("SELECT COUNT(*) AS n FROM bitacora WHERE accion = 'autorizacion.fallida' AND fecha >= ?", [desde]))[0].n,
  );
  if (recientes >= 5) throw new Error("Demasiados PIN incorrectos. Espere un minuto.");
  const duenos = await db().select("SELECT * FROM usuarios WHERE rol = 'dueno' AND activo = 1 AND eliminado_en IS NULL");
  for (const d of duenos) if (await h().verificar(pin, String(d.pin_hash))) return aUsuario(d);
  await db().lote([bitacora(actorId, "autorizacion.fallida", "usuario", null, { contexto })]);
  return null;
}
