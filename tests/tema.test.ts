import { describe, expect, it } from "vitest";
import { combinaciones, contraste, TEMAS, temaConAcento, temaConFondo, type NombreTema } from "../src/ui/tema";

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

  // Fondo propio del tema claro (con y sin color de negocio encima): sigue cumpliendo.
  for (const fondo of ["#e8f0fe", "#ffd400", "#1a4fc4", "#000000", "#c8e6c9"]) {
    it(`fondo ${fondo} en tema claro cumple`, () => {
      for (const acento of ["", "#ff69b4"]) {
        const t = temaConAcento(temaConFondo(TEMAS.claro, fondo), "claro", acento);
        const fallas = combinaciones(t).filter(([a, b, min]) => contraste(a, b) < min);
        expect(fallas).toEqual([]);
      }
    });
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

describe("colores de departamento", () => {
  it("los 12 de la paleta son distintos y su texto (blanco o negro) cumple 4,5:1", async () => {
    const { PALETA_DEPARTAMENTOS, textoSobre } = await import("../src/ui/departamentos");
    expect(PALETA_DEPARTAMENTOS).toHaveLength(12);
    expect(new Set(PALETA_DEPARTAMENTOS.map((x) => x.color)).size).toBe(12);
    const fallas = PALETA_DEPARTAMENTOS.map((x) => ({ ...x, r: contraste(textoSobre(x.color), x.color) })).filter((x) => x.r < 4.5);
    expect(fallas).toEqual([]);
  });

  it("cualquier color que elija el negocio también cumple (texto blanco o negro)", async () => {
    const { textoSobre } = await import("../src/ui/departamentos");
    let semilla = 7;
    const azar = () => ((semilla = (semilla * 1103515245 + 12345) % 2 ** 31), semilla / 2 ** 31);
    for (let i = 0; i < 2000; i++) {
      const c = "#" + Array.from({ length: 3 }, () => Math.floor(azar() * 256).toString(16).padStart(2, "0")).join("");
      expect(contraste(textoSobre(c), c)).toBeGreaterThanOrEqual(4.5);
    }
    for (const c of ["#777777", "#767676", "#808080", "#00ff00", "#ff0000", "#0000ff"]) expect(contraste(textoSobre(c), c)).toBeGreaterThanOrEqual(4.5);
  });

  it("sin color guardado, cada departamento toma el de la paleta según su posición", async () => {
    const { colorDe, PALETA_DEPARTAMENTOS } = await import("../src/ui/departamentos");
    expect(colorDe({ color: null }, 0)).toBe(PALETA_DEPARTAMENTOS[0].color);
    expect(colorDe({ color: null }, 13)).toBe(PALETA_DEPARTAMENTOS[1].color);
    expect(colorDe({ color: "#ABCDEF" }, 3)).toBe("#abcdef");
    expect(colorDe({ color: "rojo" }, 2)).toBe(PALETA_DEPARTAMENTOS[2].color);
  });
});

describe("modo de color de los departamentos", () => {
  it("cada uno con su color, todos de uno o sin color", async () => {
    const { fondoPildora, PALETA_DEPARTAMENTOS } = await import("../src/ui/departamentos");
    const propio = { color: "#123456" };
    const sin = { color: null };
    expect(fondoPildora(propio, 0, "cada_uno")).toBe("#123456");
    expect(fondoPildora(sin, 1, "cada_uno")).toBe(PALETA_DEPARTAMENTOS[1].color);
    expect(fondoPildora(propio, 0, "#ABCDEF")).toBe("#abcdef");
    expect(fondoPildora(propio, 0, "ninguno")).toBeNull();
    // Un valor raro guardado a mano no rompe la venta: cae a "cada uno".
    expect(fondoPildora(propio, 0, "azul")).toBe("#123456");
  });
});
