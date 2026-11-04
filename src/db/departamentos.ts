import type { Actor, Departamento } from "../tipos";
import { puede, SinPermiso } from "../lib/permisos";
import { ahoraIso, normalizar } from "../lib/texto";
import { ulid } from "../lib/ulid";
import { bitacora } from "./bitacora";
import { bool, db } from "./conexion";

function aDepartamento(f: Record<string, unknown>): Departamento {
  return { id: String(f.id), codigo: String(f.codigo), nombre: String(f.nombre), orden: Number(f.orden), activo: bool(f.activo), color: f.color == null ? null : String(f.color) };
}

/** Color de la píldora del departamento (lo valida también la base con un CHECK). null = el de la paleta. */
export async function colorDepartamento(actor: Actor, id: string, color: string | null): Promise<void> {
  if (!puede(actor.rol, "departamentos")) throw new SinPermiso("cambiar colores de departamentos");
  if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Color inválido");
  await db().lote([
    { id: "departamento.color", params: [color ? color.toLowerCase() : null, ahoraIso(), id] },
    bitacora(actor.id, "departamento.editar", "departamento", id, { color }),
  ]);
}

export async function listarDepartamentos(opc: { incluirInactivos?: boolean } = {}): Promise<Departamento[]> {
  const filas = await db().select(
    `SELECT * FROM departamentos WHERE eliminado_en IS NULL ${opc.incluirInactivos ? "" : "AND activo = 1"} ORDER BY orden, nombre`,
  );
  return filas.map(aDepartamento);
}

async function validar(datos: { codigo: string; nombre: string }, excluirId?: string) {
  if (!datos.nombre.trim()) throw new Error("Escriba el nombre del departamento");
  if (!/^[0-9A-Za-z]{1,6}$/.test(datos.codigo)) throw new Error("El código del departamento: 1 a 6 letras o números");
  const todos = await listarDepartamentos({ incluirInactivos: true });
  for (const d of todos) {
    if (d.id === excluirId) continue;
    if (d.codigo.toLowerCase() === datos.codigo.toLowerCase()) throw new Error(`El código ${datos.codigo} ya es de "${d.nombre}"`);
    if (normalizar(d.nombre) === normalizar(datos.nombre)) throw new Error(`Ya existe el departamento "${d.nombre}"`);
  }
}

export async function crearDepartamento(actor: Actor, datos: { codigo: string; nombre: string }): Promise<string> {
  if (!puede(actor.rol, "departamentos.estructura")) throw new SinPermiso("crear departamentos");
  await validar(datos);
  const id = ulid();
  const orden = Number((await db().select("SELECT COALESCE(MAX(orden), 0) + 1 AS o FROM departamentos"))[0].o);
  await db().lote([
    {
      id: "departamento.crear",
      params: [id, datos.codigo, datos.nombre.trim(), orden],
    },
    bitacora(actor.id, "departamento.crear", "departamento", id, datos),
  ]);
  return id;
}

export async function editarDepartamento(
  actor: Actor,
  id: string,
  cambios: Partial<Pick<Departamento, "codigo" | "nombre" | "orden" | "activo">>,
): Promise<void> {
  if (!puede(actor.rol, "departamentos")) throw new SinPermiso("editar departamentos");
  const d = (await listarDepartamentos({ incluirInactivos: true })).find((x) => x.id === id);
  if (!d) throw new Error("Departamento no encontrado");
  if (cambios.codigo !== undefined && cambios.codigo !== d.codigo && !puede(actor.rol, "departamentos.estructura"))
    throw new SinPermiso("cambiar el código de un departamento");
  const n = { ...d, ...cambios, nombre: (cambios.nombre ?? d.nombre).trim() };
  await validar(n, id);
  const ahora = ahoraIso();
  await db().lote([
    // El código va aparte: solo lo cambia quien tiene departamentos.estructura (Rust lo vuelve a revisar).
    ...(n.codigo !== d.codigo ? [{ id: "departamento.cambiar_codigo", params: [n.codigo, ahora, id] }] : []),
    { id: "departamento.editar", params: [n.nombre, n.orden, n.activo, ahora, id] },
    bitacora(actor.id, "departamento.editar", "departamento", id, { antes: d, despues: n }),
  ]);
}

/** Intercambia el orden con el vecino de arriba (-1) o de abajo (+1). */
export async function moverDepartamento(actor: Actor, id: string, dir: -1 | 1): Promise<void> {
  if (!puede(actor.rol, "departamentos")) throw new SinPermiso("ordenar departamentos");
  const lista = await listarDepartamentos({ incluirInactivos: true });
  const i = lista.findIndex((d) => d.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= lista.length) return;
  const ahora = ahoraIso();
  // Se renumera toda la lista para que el orden quede 1, 2, 3… aunque hubiera repetidos.
  [lista[i], lista[j]] = [lista[j], lista[i]];
  await db().lote([
    ...lista.map((d, k) => ({ id: "departamento.orden", params: [k + 1, ahora, d.id] })),
    bitacora(actor.id, "departamento.editar", "departamento", id, { orden: dir < 0 ? "arriba" : "abajo" }),
  ]);
}
