// Reglas de apartados y crédito para AVISAR en pantalla mientras se escribe. Rust decide
// (src-tauri/src/cuentas.rs); los porcentajes y plazos vienen de cuentas_reglas. Las dos versiones
// se prueban con los mismos casos (tests/casos/cuentas.json).

/** Abono mínimo al apartar: el % del total, redondeado hacia arriba. */
export function abonoMinimo(total: number, pct: number): number {
  if (total <= 0 || pct <= 0) return 0;
  return Math.floor((total * Math.min(pct, 100) + 99) / 100);
}

/** Horario como en `caja_horario`: hora de cierre "HH:MM" de lunes a domingo; null = no se trabaja. */
export type Horario = (string | null)[];

const DIA_MS = 86_400_000;
const aFecha = (s: string) => new Date(`${s}T00:00:00Z`);
const aTexto = (d: Date) => d.toISOString().slice(0, 10);
/** 0 = lunes … 6 = domingo. */
const diaSemana = (d: Date) => (d.getUTCDay() + 6) % 7;

/** Fecha límite (AAAA-MM-DD) desde el día de negocio en que se crea. */
export function fechaLimite(desde: string, dias: number, tipo: string, h: Horario): string {
  const laborable = (d: Date) => h[diaSemana(d)] != null;
  let d = aFecha(desde);
  if (tipo === "laborables") {
    for (let n = 0, i = 0; n < dias && i < dias * 7 + 7; i++) {
      d = new Date(d.getTime() + DIA_MS);
      if (laborable(d)) n++;
    }
    return aTexto(d);
  }
  d = new Date(d.getTime() + dias * DIA_MS);
  for (let i = 0; i < 7 && !laborable(d); i++) d = new Date(d.getTime() + DIA_MS);
  return aTexto(d);
}

/** Texto del problema del abono, o "" si se puede. */
export function validarAbono(saldo: number, monto: number, minimo: number | null): string {
  if (!(monto > 0)) return "Escriba cuánto abona";
  if (monto > saldo) return "El abono pasa del saldo";
  if (minimo != null && monto < minimo) return "El abono mínimo para apartar es mayor";
  return "";
}

export function creditoAlcanza(limite: number, saldo: number, nuevo: number): boolean {
  return limite > 0 && saldo + nuevo <= limite;
}

/** Crédito que le queda al cliente: límite menos lo que debe, nunca negativo. */
export function creditoDisponible(limite: number, saldo: number): number {
  return Math.max(0, limite - saldo);
}
