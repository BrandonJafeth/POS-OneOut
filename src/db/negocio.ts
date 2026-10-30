// Datos del negocio (una sola fila). El dueño edita lo de contacto; lo legal y el logo, solo el técnico.
import type { Actor, LogoUnBit, Negocio } from "../tipos";
import { puede, SinPermiso } from "../lib/permisos";
import { ahoraIso } from "../lib/texto";
import { bitacora } from "./bitacora";
import { bytes, db, texto } from "./conexion";

export type CampoNegocio = Exclude<keyof Negocio, "logo" | "logoUmbral">;

const COLUMNA: Record<CampoNegocio, string> = {
  nombreComercial: "nombre_comercial",
  razonSocial: "razon_social",
  cedula: "cedula",
  direccion: "direccion",
  telefono: "telefono",
  correo: "correo",
  regimen: "regimen",
  encabezadoExtra: "encabezado_extra",
  pieTiquete: "pie_tiquete",
  responsableTratamiento: "responsable_tratamiento",
  avisoPrivacidadTexto: "aviso_privacidad_texto",
  avisoPrivacidadVersion: "aviso_privacidad_version",
};

/** Lo que puede editar el permiso "negocio" (dueño). El resto pide "negocio.legal" (técnico). */
export const CAMPOS_CONTACTO: readonly CampoNegocio[] = [
  "telefono",
  "correo",
  "encabezadoExtra",
  "pieTiquete",
  "responsableTratamiento",
  "avisoPrivacidadTexto",
  "avisoPrivacidadVersion",
];

export function puedeEditarCampo(actor: Actor, campo: CampoNegocio): boolean {
  return puede(actor.rol, CAMPOS_CONTACTO.includes(campo) ? "negocio" : "negocio.legal");
}

export async function obtenerNegocio(): Promise<Negocio> {
  const f = (await db().select("SELECT * FROM negocio WHERE id = 1"))[0] ?? {};
  const bits = bytes(f.logo_bits);
  const logo: LogoUnBit | null = bits && f.logo_ancho ? { ancho: Number(f.logo_ancho), alto: Number(f.logo_alto), bits } : null;
  const n = Object.fromEntries(Object.entries(COLUMNA).map(([k, col]) => [k, texto(f[col])])) as Record<CampoNegocio, string>;
  return { ...n, logo, logoUmbral: f.logo_umbral == null ? null : Number(f.logo_umbral) };
}

/** Logo original tal como se subió (para volver a convertirlo con otro umbral). */
export async function obtenerLogoOriginal(): Promise<{ datos: Uint8Array; mime: string } | null> {
  const f = (await db().select("SELECT logo_original, logo_mime FROM negocio WHERE id = 1"))[0];
  const datos = bytes(f?.logo_original);
  return datos ? { datos, mime: texto(f?.logo_mime) } : null;
}

export async function guardarNegocio(actor: Actor, cambios: Partial<Record<CampoNegocio, string>>): Promise<void> {
  const actual = await obtenerNegocio();
  const antes: Record<string, string> = {};
  const despues: Record<string, string> = {};
  for (const [k, v] of Object.entries(cambios) as [CampoNegocio, string][]) {
    if (!(k in COLUMNA) || v === undefined) continue;
    const nuevo = v.trim();
    if (nuevo === actual[k]) continue;
    if (!puedeEditarCampo(actor, k)) throw new SinPermiso(`cambiar "${k}"`);
    antes[k] = actual[k];
    despues[k] = nuevo;
  }
  // Si cambió el texto del aviso y nadie tocó la versión, se sube sola: así cada cliente queda
  // asociado a la versión exacta que se le mostró.
  if ("avisoPrivacidadTexto" in despues && !("avisoPrivacidadVersion" in despues) && /^\d+$/.test(actual.avisoPrivacidadVersion)) {
    antes.avisoPrivacidadVersion = actual.avisoPrivacidadVersion;
    despues.avisoPrivacidadVersion = String(Number(actual.avisoPrivacidadVersion) + 1);
  }
  const campos = Object.keys(despues) as CampoNegocio[];
  if (!campos.length) return;
  await db().lote([
    {
      sql: `UPDATE negocio SET ${campos.map((c) => `${COLUMNA[c]} = ?`).join(", ")}, actualizado_en = ? WHERE id = 1`,
      params: [...campos.map((c) => despues[c]), ahoraIso()],
    },
    bitacora(actor.id, "negocio.cambiar", "negocio", "1", { antes, despues }),
  ]);
}

export async function guardarLogo(
  actor: Actor,
  datos: { original: Uint8Array; mime: string; logo: LogoUnBit; umbral: number } | null,
): Promise<void> {
  if (!puede(actor.rol, "negocio.legal")) throw new SinPermiso("cambiar el logo");
  await db().lote([
    {
      sql: `UPDATE negocio SET logo_original = ?, logo_mime = ?, logo_bits = ?, logo_ancho = ?, logo_alto = ?,
            logo_umbral = ?, actualizado_en = ? WHERE id = 1`,
      params: datos
        ? [datos.original, datos.mime, datos.logo.bits, datos.logo.ancho, datos.logo.alto, datos.umbral, ahoraIso()]
        : [null, null, null, null, null, null, ahoraIso()],
    },
    bitacora(
      actor.id,
      "negocio.logo",
      "negocio",
      "1",
      datos ? { ancho: datos.logo.ancho, alto: datos.logo.alto, umbral: datos.umbral, bytesOriginal: datos.original.length } : { quitado: true },
    ),
  ]);
}
