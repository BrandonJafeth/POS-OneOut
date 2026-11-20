import { describe, expect, it } from "vitest";
import { destino, type Casilla } from "./teclado";

const c = (vacia: boolean, opcional = false): Casilla => ({ vacia, opcional });

describe("destino", () => {
  it("Enter salta a la siguiente casilla vacía", () => {
    expect(destino([c(false), c(false), c(true)], 0, "Enter")).toBe(2);
  });
  it("Enter sin casillas vacías después deja guardar", () => {
    expect(destino([c(true), c(false), c(false)], 1, "Enter")).toBe(-1);
  });
  it("Enter no se detiene en casillas opcionales", () => {
    expect(destino([c(false), c(true, true)], 0, "Enter")).toBe(-1);
  });
  it("flechas van a la anterior y la siguiente sin dar la vuelta", () => {
    const l = [c(false), c(false)];
    expect(destino(l, 0, "ArrowDown")).toBe(1);
    expect(destino(l, 1, "ArrowDown")).toBe(-1);
    expect(destino(l, 0, "ArrowUp")).toBe(-1);
    expect(destino(l, 1, "ArrowUp")).toBe(0);
  });
});
