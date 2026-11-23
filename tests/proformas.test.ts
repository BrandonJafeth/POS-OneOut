// Proformas: la regla "la venta coincide con su proforma" y la numeración (espejo de Rust, mismos casos)
// y lo que sale en papel.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProformaDetalle } from "../src/db/proformas";
import { interpret } from "../src/lib/preview";
import { coincide, LEYENDA_PROFORMA, proformaPdf, proformaTermica, siguienteVersion } from "../src/lib/proformas";
import { DEFAULT_SETTINGS, lr } from "../src/lib/tickets";
import type { Negocio } from "../src/tipos";

const casos = JSON.parse(readFileSync(new URL("./casos/proformas.json", import.meta.url), "utf8"));
type L = [string | null, string, number, number];
const aLineas = (l: L[]) => l.map(([productoId, descripcion, cantidad, descuento]) => ({ productoId, descripcion, cantidad, descuento }));

describe("reglas de proformas (iguales que en Rust)", () => {
  it("coincide", () => {
    for (const c of casos.coincide) {
      const venta = { lineas: aLineas(c.venta).map((l, i) => ({ ...l, id: String(i), codigo: null, departamentoId: "D", precioUnitario: 1, tasaIva: 13, exento: false })), descuentoTotal: c.ventaDesc };
      expect(coincide(venta, { lineas: aLineas(c.proforma), descuento: c.proformaDesc }), c.nombre).toBe(c.ok);
    }
  });

  it("número de la versión siguiente", () => {
    for (const c of casos.numero.filter((x: { version: number }) => x.version > 1)) {
      const anterior = c.version === 2 ? c.esperado.replace(/-\d+$/, "") : c.esperado.replace(/-(\d+)$/, (_: string, n: string) => `-${Number(n) - 1}`);
      expect(siguienteVersion(anterior)).toBe(c.esperado);
    }
  });
});

const negocio: Negocio = {
  nombreComercial: "Librería y Bazar Chagui", razonSocial: "", cedula: "", direccion: "", telefono: "", correo: "", regimen: "", encabezadoExtra: "", pieTiquete: "",
  responsableTratamiento: "", avisoPrivacidadTexto: "", avisoPrivacidadVersion: "1", logo: null, logoUmbral: null,
};

function detalle(cliente: string | null): ProformaDetalle {
  return {
    proforma: { id: "PF1", numero: "P-0012-2", estado: "vigente", clienteId: null, cliente, fecha: "2026-11-23T16:00:00Z", vence: "2026-12-03", total: 5500, usuario: "Luis", convertidaEn: null },
    subtotal: 6000, descuento: 500, condiciones: "Precios con IVA.", reimpresiones: 0,
    lineas: [{ productoId: "P1", codigo: null, descripcion: "Cuaderno cosido", cantidad: 4, precioUnitario: 1500, descuento: 0, total: 6000 }],
  };
}

const texto = (b: Uint8Array) =>
  interpret(b)
    .filter((x) => x.kind === "line")
    .map((x) => ("spans" in x ? x.spans.map((s) => s.text).join("") : ""));

describe("proforma en papel", () => {
  it("número, validez, cliente, detalle, total, condiciones y la leyenda", () => {
    const l = texto(proformaTermica(negocio, detalle("Pedro Vargas"), DEFAULT_SETTINGS).bytes);
    const t = l.join("\n");
    for (const s of ["PROFORMA", "P-0012-2", "Pedro Vargas", "Cuaderno cosido", "Precios con IVA."]) expect(t).toContain(s);
    expect(l).toContain(lr("Válida hasta el:", "03/12/2026"));
    expect(l).toContain(lr("TOTAL", "¢5.500"));
    expect(t.replace(/\n/g, " ")).toContain(LEYENDA_PROFORMA);
    expect(t).not.toContain("COPIA");
  });

  it("sin nombre (o ya borrado): «no registrado»; la reimpresión sale COPIA", () => {
    const t = texto(proformaTermica(negocio, detalle(null), DEFAULT_SETTINGS, { copia: true }).bytes).join("\n");
    expect(t).toContain("Cliente: no registrado");
    expect(t).toContain("*** COPIA ***");
    expect(proformaPdf(detalle(null)).some((b) => b.tipo === "texto" && b.texto === LEYENDA_PROFORMA)).toBe(true);
  });
});
