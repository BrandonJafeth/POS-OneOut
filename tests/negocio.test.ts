import { beforeEach, describe, expect, it } from "vitest";
import { listarBitacora } from "../src/db/bitacora";
import { guardarLogo, guardarNegocio, obtenerNegocio } from "../src/db/negocio";
import { aUnBit, medidasLogo, umbralSugerido } from "../src/lib/logo1bit";
import { muestraEncabezado } from "../src/lib/impresion";
import { interpret } from "../src/lib/preview";
import { DEFAULT_SETTINGS } from "../src/lib/tickets";
import type { Actor } from "../src/tipos";
import { baseDePrueba } from "./driverNode";

const TEC: Actor = { id: "T", rol: "tecnico" };
const DUENO: Actor = { id: "D", rol: "dueno" };

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

describe("datos del negocio", () => {
  beforeEach(async () => {
    const { driver } = baseDePrueba();
    for (const a of [TEC, DUENO]) await driver.execute("INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES (?, ?, ?, 'x')", [a.id, a.id, a.rol]);
  });

  it("el dueño edita contacto; lo legal solo el técnico", async () => {
    await guardarNegocio(DUENO, { telefono: "4080-7942", pieTiquete: "¡Gracias!" });
    await expect(guardarNegocio(DUENO, { cedula: "503210821" })).rejects.toThrow("permiso");
    await guardarNegocio(TEC, { cedula: "503210821", nombreComercial: "Librería Chagui" });
    expect(await obtenerNegocio()).toMatchObject({ telefono: "4080-7942", cedula: "503210821", nombreComercial: "Librería Chagui" });
    const b = await listarBitacora();
    expect(b.map((e) => e.accion)).toEqual(["negocio.cambiar", "negocio.cambiar"]);
    expect(b[1].detalle).toEqual({ antes: { telefono: "", pieTiquete: "¡Gracias por preferirnos!" }, despues: { telefono: "4080-7942", pieTiquete: "¡Gracias!" } });
  });

  it("guarda el logo como BLOB y la vista previa lo dibuja con GS v 0", async () => {
    const { rgba, ancho, alto } = imagen(["##..", "..##"]);
    const logo = aUnBit(rgba, ancho, alto);
    await expect(guardarLogo(DUENO, { original: new Uint8Array([1]), mime: "image/png", logo, umbral: 128 })).rejects.toThrow("permiso");
    await guardarLogo(TEC, { original: new Uint8Array([1, 2, 3]), mime: "image/png", logo, umbral: 128 });
    const n = await obtenerNegocio();
    expect(n.logo).toMatchObject({ ancho: 8, alto: 2 });
    expect([...n.logo!.bits]).toEqual([0b11000000, 0b00110000]);
    const items = interpret(muestraEncabezado(n, DEFAULT_SETTINGS).bytes);
    expect(items.find((i) => i.kind === "image")).toMatchObject({ width: 8, height: 2 });
  });
});
