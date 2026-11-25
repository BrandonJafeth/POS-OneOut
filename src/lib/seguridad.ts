// Textos de la pantalla Permisos: qué significa cada política en palabras simples, qué cambió y la
// tabla para imprimir y firmar. Solo muestra: lo que vale lo decide Rust (politica.rs).
import type { Datos } from "../generados/Datos";
import type { Inactividad } from "../generados/Inactividad";
import type { Politica } from "../generados/Politica";
import type { AccionInfo } from "../db/seguridad";
import type { Rol } from "../tipos";
import type { LineaReporte } from "./pdf";

const miles = (n: number) => n.toLocaleString("es-CR").replace(/\s|,/g, ".");

export const NIVELES: { valor: Politica["nivel"]; texto: string }[] = [
  { valor: "no", texto: "No" },
  { valor: "si", texto: "Sí" },
  { valor: "motivo", texto: "Sí, con motivo" },
  { valor: "pin", texto: "Con PIN del dueño" },
];

const QUIEN: Record<Rol, string> = { cajero: "El cajero", dueno: "El dueño", tecnico: "El técnico" };

/** "anular una venta" (verbo) o "usar «Salida de efectivo»" (sustantivo), a partir del nombre del catálogo. */
const minuscula = (s: string) => (/^\p{L}+(ar|er|ir)\b/iu.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : `usar «${s}»`);

/** Los límites en palabras: "de hasta ¢10.000, 3 por turno, solo en el turno abierto, dentro de 30 minutos". */
export function textoLimites(p: Politica): string {
  const l = p.limites;
  const partes: string[] = [];
  if (l.montoMax != null) partes.push(`de hasta ¢${miles(l.montoMax)}`);
  if (l.pctMax != null) partes.push(`hasta ${l.pctMax} %`);
  if (l.cantidadTurno != null) partes.push(`${l.cantidadTurno} por turno`);
  if (l.soloTurnoAbierto) partes.push("solo en el turno abierto");
  if (l.ventanaMin != null) partes.push(`dentro de ${l.ventanaMin} minutos`);
  return partes.join(", ");
}

export function hayLimites(p: Politica): boolean {
  return textoLimites(p) !== "";
}

/** "El cajero podrá anular una venta de hasta ¢10.000 sin PIN; si pasa, pedirá el PIN del dueño." */
export function describir(quien: Rol | string, nombre: string, p: Politica | undefined): string {
  const q = QUIEN[quien as Rol] ?? quien;
  const n = minuscula(nombre);
  if (!p || p.nivel === "no") return `${q} no podrá ${n}.`;
  const lim = textoLimites(p);
  const pasa = lim ? (p.limites.alPasar === "bloquear" ? "; si pasa, no se podrá" : "; si pasa, pedirá el PIN del dueño") : "";
  if (p.nivel === "pin") return `${q} podrá ${n} con el PIN del dueño${p.motivo ? " y un motivo" : ""}.`;
  const sin = lim ? " sin PIN" : "";
  const motivo = p.nivel === "motivo" || p.motivo ? ", con motivo" : "";
  return `${q} podrá ${n}${lim ? ` ${lim}` : ""}${sin}${motivo}${pasa}.`;
}

/** "Si nadie toca la caja por 10 minutos, se pide el PIN otra vez." */
export function describirInactividad(min: number): string {
  return `Si nadie toca la caja por ${min} ${min === 1 ? "minuto" : "minutos"}, se pide el PIN otra vez.`;
}

/** Minutos de un rol (igual que Inactividad::minutos en Rust: prueba espejo). */
export function minutosDe(i: Inactividad, rol: Rol): number {
  const propio = rol === "cajero" ? i.cajero : rol === "dueno" ? i.dueno : i.tecnico;
  const m = Math.min(Math.max(propio ?? i.general, 1), 60);
  return rol === "tecnico" ? Math.min(m, 15) : m;
}

const igual = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Lo que cambia entre dos configuraciones, en frases (para la lista antes de guardar o aplicar una plantilla). */
export function cambios(viejo: Datos, nuevo: Datos, catalogo: AccionInfo[], nombres: Record<string, string> = {}): string[] {
  const out: string[] = [];
  for (const a of catalogo) {
    for (const rol of ["cajero", "tecnico"] as const) {
      if (!igual(viejo[rol][a.id], nuevo[rol][a.id])) out.push(describir(rol, a.nombre, nuevo[rol][a.id]));
    }
  }
  const usuarios = new Set([...Object.keys(viejo.usuarios), ...Object.keys(nuevo.usuarios)]);
  for (const u of usuarios) {
    for (const a of catalogo) {
      const v = viejo.usuarios[u]?.[a.id];
      const n = nuevo.usuarios[u]?.[a.id];
      if (igual(v, n)) continue;
      const quien = nombres[u] ?? "Un cajero";
      out.push(n ? describir(quien, a.nombre, n) : `${quien}: «${a.nombre}» vuelve a ser como su rol.`);
    }
  }
  if (!igual(viejo.motivosAnulacion, nuevo.motivosAnulacion)) out.push(`Motivos de anulación: ${nuevo.motivosAnulacion.join(", ")}.`);
  if (viejo.umbralAvisoAnulaciones !== nuevo.umbralAvisoAnulaciones) out.push(`El día se marca con más de ${nuevo.umbralAvisoAnulaciones} anulaciones sin PIN.`);
  if (viejo.comprobanteAnulacionAb !== nuevo.comprobanteAnulacionAb)
    out.push(nuevo.comprobanteAnulacionAb ? "Toda anulación imprime comprobante." : "Solo las anulaciones sin PIN imprimen comprobante.");
  for (const rol of ["cajero", "dueno", "tecnico"] as const) {
    const a = minutosDe(viejo.inactividad, rol);
    const b = minutosDe(nuevo.inactividad, rol);
    if (a !== b) out.push(`${QUIEN[rol]}: se bloquea a los ${b} min (antes ${a}).`);
  }
  return out;
}

/** Opción de anulación del cajero (A/B/C) según su política. */
export function opcionAnulacion(p: Politica | undefined): "A" | "B" | "C" {
  if (!p || p.nivel === "no") return "A";
  return p.nivel === "pin" ? "B" : "C";
}

/** La tabla vigente para imprimir y firmar (PDF carta, Courier). */
export function lineasTabla(d: Datos, version: number, catalogo: AccionInfo[], cajeros: { id: string; nombre: string }[]): LineaReporte[] {
  const L: LineaReporte[] = [];
  const nivel = (p: Politica | undefined) => (NIVELES.find((n) => n.valor === (p?.nivel ?? "no"))?.texto ?? "No") + (p && p.nivel !== "no" && hayLimites(p) ? "*" : "");
  const col = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  L.push({ texto: `Versión ${version} de los permisos`, negrita: true });
  L.push({ texto: "" });
  let area = "";
  for (const a of catalogo) {
    if (a.area !== area) {
      area = a.area;
      L.push({ texto: "" });
      L.push({ texto: `${col(area, 52)}${col("Cajero", 13)}${col("Técnico", 13)}Dueño`, negrita: true });
    }
    const t = a.protegida ? "No (fijo)" : nivel(d.tecnico[a.id]);
    const c = a.noDelegable ? "No (fijo)" : nivel(d.cajero[a.id]);
    const due = a.duenoSigueCajero ? "Tope del negocio" : nivel(a.dueno);
    L.push({ texto: `${col(a.nombre, 52)}${col(c, 13)}${col(t, 13)}${due}` });
    for (const [rol, p] of [["cajero", d.cajero[a.id]], ["tecnico", d.tecnico[a.id]]] as const) {
      if (p && p.nivel !== "no" && hayLimites(p)) L.push({ texto: `   * ${rol === "cajero" ? "Cajero" : "Técnico"}: ${textoLimites(p)}${p.limites.alPasar === "bloquear" ? " (al pasar: no)" : " (al pasar: PIN)"}` });
    }
  }
  const excepciones = Object.entries(d.usuarios).filter(([, m]) => m && Object.keys(m).length);
  if (excepciones.length) {
    L.push({ texto: "" });
    L.push({ texto: "Excepciones por usuario", negrita: true });
    for (const [u, m] of excepciones) {
      const nombre = cajeros.find((c) => c.id === u)?.nombre ?? u;
      for (const [id, p] of Object.entries(m ?? {})) {
        const a = catalogo.find((x) => x.id === id);
        if (a && p) L.push({ texto: `  ${describir(nombre, a.nombre, p)}` });
      }
    }
  }
  L.push({ texto: "" });
  L.push({ texto: "Bloqueo por inactividad", negrita: true });
  for (const rol of ["cajero", "dueno", "tecnico"] as const) L.push({ texto: `  ${QUIEN[rol]}: ${minutosDe(d.inactividad, rol)} minutos` });
  L.push({ texto: `Motivos de anulación: ${d.motivosAnulacion.join(", ")}` });
  L.push({ texto: "" });
  L.push({ texto: "" });
  L.push({ texto: "Firma del dueño: ______________________________   Fecha: ____________" });
  return L;
}
