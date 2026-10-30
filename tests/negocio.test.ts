// Quién edita qué del negocio lo prueba Rust (src-tauri/src/negocio.rs). Aquí: logo a 1 bit y vista previa.
import { describe, expect, it } from "vitest";
import { aUnBit, medidasLogo, umbralSugerido } from "../src/lib/logo1bit";
import { muestraEncabezado } from "../src/lib/impresion";
import { interpret } from "../src/lib/preview";
import { DEFAULT_SETTINGS } from "../src/lib/tickets";
import type { Negocio } from "../src/tipos";

const NEGOCIO_VACIO: Negocio = {
  nombreComercial: "Librería", razonSocial: "", cedula: "", direccion: "", telefono: "", correo: "", regimen: "", encabezadoExtra: "",
  pieTiquete: "", responsableTratamiento: "", avisoPrivacidadTexto: "", avisoPrivacidadVersion: "1", logo: null, logoUmbral: null,
};

/** Imagen RGBA de prueba a partir de una cuadrícula: "#" negro, "." blanco, " " transparente. */
function imagen(filas: string[]) {
  const alto = filas.length;
  const ancho = filas[0].length;
  const rgba = new Uint8Array(ancho * alto * 4);
  filas.forEach((f, y) =>
    [...f].forEach((c, x) => {
      const p = (y * ancho + x) * 4;
      const v = c === "#" ? 0 : 255;
      rgba.set([v, v, v, c === " " ? 0 : 255], p);
    }),
  );
  return { rgba, ancho, alto };
}

describe("logo a 1 bit", () => {
  it("negro = 1, MSB a la izquierda, ancho redondeado a 8", () => {
    const { rgba, ancho, alto } = imagen(["#.........", ".#......##"]);
    const l = aUnBit(rgba, ancho, alto);
    expect(l.ancho).toBe(16);
    expect(l.alto).toBe(2);
    expect([...l.bits]).toEqual([0b10000000, 0, 0b01000000, 0b11000000]);
  });

  it("lo transparente es papel y el umbral decide los grises", () => {
    const gris = new Uint8Array([100, 100, 100, 255, 0, 0, 0, 0]);
    expect(aUnBit(gris, 2, 1, 128).bits[0]).toBe(0b10000000);
    expect(aUnBit(gris, 2, 1, 90).bits[0]).toBe(0);
  });

  it("invertir pinta lo claro (logo blanco sobre fondo negro)", () => {
    const { rgba } = imagen(["#."]);
    expect(aUnBit(rgba, 2, 1, 128, true).bits[0]).toBe(0b01000000);
  });

  it("escala a 368 puntos como máximo y sugiere umbral", () => {
    expect(medidasLogo(736, 200)).toEqual({ ancho: 368, alto: 100 });
    expect(medidasLogo(200, 50)).toEqual({ ancho: 200, alto: 50 });
    expect(umbralSugerido(imagen(["#."]).rgba)).toBe(128);
  });
});

describe("logo en la vista previa", () => {
  it("la vista previa dibuja el logo con GS v 0", () => {
    const { rgba, ancho, alto } = imagen(["##..", "..##"]);
    const logo = aUnBit(rgba, ancho, alto);
    expect([...logo.bits]).toEqual([0b11000000, 0b00110000]);
    const items = interpret(muestraEncabezado({ ...NEGOCIO_VACIO, logo }, DEFAULT_SETTINGS).bytes);
    expect(items.find((i) => i.kind === "image")).toMatchObject({ width: 8, height: 2 });
  });
});
