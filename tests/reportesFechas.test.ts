import { describe, expect, it } from "vitest";
import { diasEntre, haceUnAnio, variacion } from "../src/lib/reportes/fechas";

describe("fechas de reportes", () => {
  it("compara contra la misma fecha del año pasado", () => {
    expect(haceUnAnio("2026-11-19")).toBe("2025-11-19");
    expect(haceUnAnio("2028-02-29")).toBe("2027-02-28");
  });

  it("lista cada día del rango, también al cambiar de mes", () => {
    expect(diasEntre("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(diasEntre("2026-11-20", "2026-11-20")).toEqual(["2026-11-20"]);
  });

  it("dice la variación en texto y su dirección", () => {
    expect(variacion(1200, 1000, "19 nov 2025")).toEqual({ texto: "+20 % vs. 19 nov 2025", dir: 1 });
    expect(variacion(500, 1000, "x")?.dir).toBe(-1);
    expect(variacion(100, 0, "19 nov 2025")?.texto).toContain("Sin ventas para comparar");
    expect(variacion(0, 0, "x")).toBeUndefined();
  });
});
