// Datos del negocio (una sola fila). El dueño edita lo de contacto; lo legal y el logo, solo el técnico.
import type { Actor, LogoUnBit, Negocio } from "../tipos";
import { invocar } from "../lib/invocar";
import { puede } from "../lib/permisos";
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

/** Rust revisa campo por campo quién puede cambiarlo y sube sola la versión del aviso. */
export async function guardarNegocio(_actor: Actor, cambios: Partial<Record<CampoNegocio, string>>): Promise<void> {
  const limpio = Object.fromEntries(Object.entries(cambios).filter(([, v]) => v !== undefined).map(([k, v]) => [k, (v as string).trim()]));
  await invocar("negocio_guardar", { cambios: limpio });
}

export async function guardarLogo(
  _actor: Actor,
  datos: { original: Uint8Array; mime: string; logo: LogoUnBit; umbral: number } | null,
): Promise<void> {
  await invocar("negocio_logo", {
    logo: datos
      ? {
          original: Array.from(datos.original),
          mime: datos.mime,
          bits: Array.from(datos.logo.bits),
          ancho: datos.logo.ancho,
          alto: datos.logo.alto,
          umbral: datos.umbral,
        }
      : null,
  });
}
