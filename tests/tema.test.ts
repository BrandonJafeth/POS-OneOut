import { describe, expect, it } from "vitest";
import { combinaciones, contraste, TEMAS, temaConAcento, type NombreTema } from "../src/ui/tema";

describe("contraste WCAG 2.1 AA", () => {
  it("la fórmula da los valores conocidos", () => {
    expect(contraste("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contraste("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  for (const [nombre, tema] of Object.entries(TEMAS)) {
    it(`tema ${nombre}: todas las combinaciones cumplen`, () => {
      const fallas = combinaciones(tema)
        .map(([a, b, min, para]) => ({ para, a, b, min, r: Math.round(contraste(a, b) * 100) / 100 }))
        .filter((x) => x.r < x.min);
      expect(fallas).toEqual([]);
    });
  }

  // Colores que podría poner un negocio (rosa de floristería, amarillo, azul, verde, rojo):
  // después del ajuste automático tienen que cumplir lo mismo que el tema base.
  for (const color of ["#ff69b4", "#ffd400", "#1a4fc4", "#2e7d32", "#e53935", "#8e44ad", "#ffffff", "#000000"]) {
    for (const nombre of ["claro", "oscuro"] as NombreTema[]) {
      it(`color de negocio ${color} en tema ${nombre} cumple`, () => {
        const t = temaConAcento(TEMAS[nombre], nombre, color);
        const fallas = combinaciones(t)
          .map(([a, b, min, para]) => ({ para, r: Math.round(contraste(a, b) * 100) / 100, min }))
          .filter((x) => x.r < x.min);
        expect(fallas).toEqual([]);
      });
    }
  }

  it("un valor inválido deja el grafito", () => {
    expect(temaConAcento(TEMAS.claro, "claro", "rojo")).toEqual(TEMAS.claro);
  });
});

describe("color del negocio parecido al rojo de error", () => {
  it("avisa con rojos y no con otros colores", async () => {
    const { pareceError, alternativasAError } = await import("../src/ui/tema");
    for (const rojo of ["#c62828", "#e53935", "#b71c1c", "#ff3b30"]) expect(pareceError(rojo)).toBe(true);
    for (const otro of ["#24272c", "#1a4fc4", "#2e7d32", "#ffd400", "#8e44ad", "#808080", "#ff69b4"]) expect(pareceError(otro)).toBe(false);
    // Las alternativas que propone ya no avisan.
    for (const a of alternativasAError("#c62828")) expect(pareceError(a.color)).toBe(false);
  });
});
