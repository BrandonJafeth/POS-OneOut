// Pestañas con teclado (patrón ARIA tablist): ← → pasan a la anterior o la siguiente, Inicio y Fin a
// la primera y la última. La que recibe el foco se activa (como un clic).
import type { KeyboardEvent } from "react";

export function flechasPestanas(e: KeyboardEvent<HTMLElement>): void {
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])')];
  const i = tabs.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  const destino = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (destino === undefined) return;
  e.preventDefault();
  const t = tabs[(destino + tabs.length) % tabs.length];
  t.focus();
  t.click();
}
