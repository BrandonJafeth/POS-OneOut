import { describe, expect, it } from "vitest";
import { crearDocumento, medir } from "../src/lib/pdf";

const txt = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("PDF de documentos", () => {
  it("varias hojas: cabecera de la tabla en cada una, pie con la página, sin «?» por el signo menos", () => {
    const pdf = txt(
      crearDocumento({
        negocio: "Librería",
        titulo: "Movimientos",
        bloques: [
          { tipo: "resumen", items: [{ etiqueta: "Salieron", valor: "−28" }] },
          { tipo: "tabla", columnas: [{ titulo: "Producto", ancho: 3 }, { titulo: "Cantidad", ancho: 1, derecha: true }], filas: Array.from({ length: 120 }, (_, i) => [`Producto ${i}`, i]) },
        ],
      }),
    );
    const paginas = Number(/\/Count (\d+)/.exec(pdf)![1]);
    expect(paginas).toBeGreaterThan(1);
    expect(pdf.split("(Cantidad)").length - 1).toBe(paginas);
    expect(pdf).toContain(`(Página ${paginas} de ${paginas})`);
    expect(pdf).toContain("(-28)");
    expect(pdf).not.toContain("(?28)");
  });

  it("los dígitos miden lo mismo: los montos quedan alineados a la derecha", () => {
    expect(medir("¢1.000", 9)).toBeCloseTo(medir("¢9.999", 9));
    expect(medir("Útil", 9)).toBeCloseTo(medir("Util", 9));
  });
});
