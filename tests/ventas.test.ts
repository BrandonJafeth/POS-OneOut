// Cobro, consecutivo, turnos, descuentos con tope, corrección y anulación se prueban en Rust
// (src-tauri/src/ventas.rs y caja.rs). Aquí: el cálculo que muestra la pantalla y el tiquete impreso.
// El cierre Z está en tests/cierre.test.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { obtenerNegocio } from "../src/db/negocio";
import { EscPos } from "../src/lib/escpos";
import { interpret } from "../src/lib/preview";
import { DEFAULT_SETTINGS, lr } from "../src/lib/tickets";
import { calcularTotales, conCantidad, conLinea, estadoVacio, redondear } from "../src/lib/venta/calculo";
import { paginasVisibles } from "../src/ui/Paginacion";
import { calcularPagos, sugerenciasEfectivo } from "../src/lib/venta/pagos";
import { lineasPago, tiqueteVenta } from "../src/lib/venta/tiquete";
import type { EstadoEspera, FormaPago, LineaEspera, Venta } from "../src/tipos";
import { baseDePrueba } from "./driverNode";
import { validarEscPos } from "./escposValidar";

const EF = "0000000000000000000000FP01";
const TJ = "0000000000000000000000FP02";
const SP = "0000000000000000000000FP03";
const TR = "0000000000000000000000FP04";
const BN = "0000000000000000000000BN01";
const OFICINA = "00000000000000000000000D02";

beforeEach(() => {
  baseDePrueba();
});

let n = 0;
function linea(precio: number, cantidad = 1, descuento = 0): LineaEspera {
  return { id: String(++n), productoId: null, codigo: null, descripcion: `Artículo ${n}`, departamentoId: OFICINA, cantidad, precioUnitario: precio, descuento, tasaIva: 13, exento: false };
}
function venta(...lineas: LineaEspera[]): EstadoEspera {
  return { ...estadoVacio(), lineas };
}

const FORMAS: FormaPago[] = [
  { id: EF, codigo: "EF", nombre: "Efectivo", tipo: "efectivo", requiereBanco: false, requiereReferencia: false, daVuelto: true, pideUltimos4: false, orden: 1, activo: true },
  { id: TJ, codigo: "TJ", nombre: "Tarjeta", tipo: "tarjeta", requiereBanco: false, requiereReferencia: false, daVuelto: false, pideUltimos4: true, orden: 2, activo: true },
  { id: TR, codigo: "TR", nombre: "Transferencia", tipo: "transferencia", requiereBanco: true, requiereReferencia: true, daVuelto: false, pideUltimos4: false, orden: 3, activo: true },
];

describe("descuento fijo del producto", () => {
  const conCatalogo = (pct: number, cantidad = 1): LineaEspera => {
    const l = { ...linea(1000, cantidad), productoId: "P", descuentoCatalogo: pct };
    return { ...l, descuento: Math.round((1000 * cantidad * pct) / 100) };
  };

  it("no cuenta contra el tope; lo que se agregue encima sí", () => {
    expect(calcularTotales(venta(conCatalogo(30, 2)), 1)).toMatchObject({ total: 1400, pctDescuento: 0 });
    expect(calcularTotales(venta({ ...conCatalogo(30, 2), descuento: 900 }), 1).pctDescuento).toBeCloseTo(15);
  });

  it("al sumar cantidad se recalcula; un descuento a mano se respeta", () => {
    expect(conCantidad(conCatalogo(10), 3).descuento).toBe(300);
    expect(conCantidad({ ...conCatalogo(10), descuento: 50 }, 3).descuento).toBe(50);
    const e = conLinea(venta(conCatalogo(10)), conCatalogo(10));
    expect(e.lineas.map((l) => [l.cantidad, l.descuento])).toEqual([[2, 200]]);
  });
});

describe("paginación", () => {
  it("primera, última y dos alrededor de la actual", () => {
    expect(paginasVisibles(1, 3)).toEqual([1, 2, 3]);
    expect(paginasVisibles(6, 15)).toEqual([1, null, 4, 5, 6, 7, 8, null, 15]);
  });
});

describe("totales y redondeo", () => {
  it("redondea al múltiplo de 5 más cercano y guarda la diferencia", () => {
    expect([1502, 1503, 1500, 2].map((x) => redondear(x, 5))).toEqual([1500, 1505, 1500, 0]);
    expect(redondear(1502, 1)).toBe(1502);
    const t = calcularTotales({ ...venta(linea(1001, 2), linea(500, 1, 100)), descuentoTotal: 200 }, 5);
    expect(t).toMatchObject({ bruto: 2502, descuentoLineas: 100, subtotal: 2402, descuento: 200, total: 2200, redondeo: -2 });
    expect(t.pctDescuento).toBeCloseTo((300 / 2502) * 100);
  });

  it("el descuento al total no puede pasar del subtotal", () => {
    expect(calcularTotales({ ...venta(linea(1000)), descuentoTotal: 5000 }, 5).total).toBe(0);
  });
});

describe("pago mixto y vuelto", () => {
  it("tarjeta + efectivo: el vuelto sale del efectivo", () => {
    const r = calcularPagos(8000, [{ formaPagoId: TJ, monto: 3000 }, { formaPagoId: EF, monto: 10000 }], FORMAS);
    expect(r).toMatchObject({ ok: true, pagado: 13000, faltante: 0, vuelto: 5000 });
    expect(r.aplicados.map((a) => [a.formaPagoId, a.aplicado, a.recibido, a.vuelto])).toEqual([
      [TJ, 3000, null, null],
      [EF, 5000, 10000, 5000],
    ]);
  });

  it("solo el efectivo da vuelto; faltante; datos obligatorios por forma", () => {
    expect(calcularPagos(8000, [{ formaPagoId: TJ, monto: 9000 }], FORMAS).errores[0]).toContain("no dan vuelto");
    expect(calcularPagos(8000, [{ formaPagoId: EF, monto: 5000 }], FORMAS)).toMatchObject({ ok: false, faltante: 3000 });
    const t = calcularPagos(8000, [{ formaPagoId: TR, monto: 8000 }], FORMAS);
    expect(t.errores).toEqual(["Transferencia: elija el banco", "Transferencia: escriba la referencia"]);
    expect(calcularPagos(8000, [{ formaPagoId: TR, monto: 8000, bancoId: BN, referencia: "123" }], FORMAS).ok).toBe(true);
    expect(calcularPagos(100, [{ formaPagoId: TJ, monto: 100, ultimos4: "12a4" }], FORMAS).ok).toBe(false);
  });

  it("denominaciones rápidas", () => {
    expect(sugerenciasEfectivo(3250, [1000, 2000, 5000, 10000, 20000, 50000])).toEqual([3250, 4000, 5000, 10000, 20000, 50000]);
  });
});

function lineasTexto(bytes: Uint8Array): string[] {
  return interpret(bytes).flatMap((i) => (i.kind === "line" ? [i.spans.map((s) => s.text).join("")] : i.kind === "event" ? [i.text] : []));
}

const VENTA: Venta = {
  id: "V1", cajaId: "C1", turnoId: "T1", turnoAbierto: true, turnoUsuarioId: "U", consecutivo: 67791, numero: "67791", fecha: "2026-10-29T15:30:00Z", dia: "2026-10-29",
  usuarioId: "U", cajero: "Luis", esperaCreadaPor: "Luis", anuladaPor: null, impreso: false, clienteId: null, cliente: null, nombreTiquete: null,
  subtotal: 2400, descuento: 50, redondeo: 0, total: 2350, ivaTotal: 270,
  estado: "completada", anuladaMotivo: null, requiereFactura: false, facturaEmitida: false, facturaReferencia: null, reimpresiones: 0,
  lineas: [{ id: "L1", productoId: null, codigo: null, descripcion: "Cuaderno", departamentoId: OFICINA, cantidad: 2, precioUnitario: 1250, descuento: 100, total: 2400, tasaIva: 13, iva: 270 }],
  pagos: [
    { id: "P1", formaPagoId: TJ, forma: "Tarjeta", tipo: "tarjeta", monto: 1000, recibido: null, vuelto: null, bancoId: null, banco: null, referencia: null, ultimos4: "4321" },
    { id: "P2", formaPagoId: EF, forma: "Efectivo", tipo: "efectivo", monto: 1350, recibido: 5000, vuelto: 3650, bancoId: null, banco: null, referencia: null, ultimos4: null },
  ],
};

/** Como el tiquete viejo de la foto: ¢500, ¢200 por SINPE (BCR, ref 69898) y ¢300 en efectivo. */
const DIVIDIDA: Venta = {
  ...VENTA,
  numero: "67979",
  subtotal: 500,
  descuento: 0,
  total: 500,
  ivaTotal: 0,
  lineas: [{ id: "L1", productoId: null, codigo: null, descripcion: "IMPRESIONES A COLOR", departamentoId: OFICINA, cantidad: 1, precioUnitario: 200, descuento: 0, total: 200, tasaIva: 13, iva: 0 }, { id: "L2", productoId: null, codigo: null, descripcion: "ESCANEO Y ENVIO", departamentoId: OFICINA, cantidad: 1, precioUnitario: 300, descuento: 0, total: 300, tasaIva: 13, iva: 0 }],
  pagos: [
    { id: "P1", formaPagoId: SP, forma: "SINPE Móvil", tipo: "sinpe", monto: 200, recibido: null, vuelto: null, bancoId: BN, banco: "BCR", referencia: "69898", ultimos4: null },
    { id: "P2", formaPagoId: EF, forma: "Efectivo", tipo: "efectivo", monto: 300, recibido: 1000, vuelto: 700, bancoId: null, banco: null, referencia: null, ultimos4: null },
  ],
};

const tienePulsoGaveta = (b: Uint8Array) => b.some((x, i) => x === 0x1b && b[i + 1] === 0x70) || b.some((x, i) => x === 0x10 && b[i + 1] === 0x14);

describe("tiquete", () => {
  it("consecutivo, cajero, descuentos, cada pago, recibido y vuelto, ¢ y leyenda", async () => {
    const neg = await obtenerNegocio();
    const doc = tiqueteVenta(neg, VENTA, DEFAULT_SETTINGS, { textoNoFactura: "Este tiquete no es una factura electrónica" });
    const t = lineasTexto(doc.bytes).join("\n");
    for (const s of ["67791", "Luis", "-¢100", "-¢50", "TOTAL", "¢2.350", "Este tiquete no es una factura", "electrónica"]) expect(t).toContain(s);
    expect(t).toMatch(/Tarjeta \*\*\*\*4321 +¢1\.000/);
    expect(t).toMatch(/Efectivo +¢1\.350/);
    expect(t).toMatch(/Recibido +¢5\.000/);
    expect(t).toMatch(/Vuelto +¢3\.650/);
    // El tiquete nunca lleva el pulso de la gaveta (la abre Rust) y pasa la lista blanca de Rust.
    expect(tienePulsoGaveta(doc.bytes)).toBe(false);
    validarEscPos(doc.bytes);
  });

  it("pago dividido: una línea por pago con banco, referencia y monto; también en la COPIA", async () => {
    const neg = await obtenerNegocio();
    for (const copia of [false, true]) {
      const doc = tiqueteVenta(neg, DIVIDIDA, DEFAULT_SETTINGS, { copia });
      const l = lineasTexto(doc.bytes);
      const t = l.join("\n");
      expect(t).toMatch(/TOTAL +¢500/);
      expect(l).toContain(lr("SINPE Móvil BCR ref 69898", "¢200"));
      expect(l).toContain(lr("Efectivo", "¢300"));
      expect(l).toContain(lr("  Recibido", "¢1.000"));
      expect(l).toContain(lr("  Vuelto", "¢700"));
      expect(t.includes("*** COPIA ***")).toBe(copia);
      expect(tienePulsoGaveta(doc.bytes)).toBe(false);
      validarEscPos(doc.bytes);
    }
    // Lo mismo que muestra la pantalla en el detalle de la venta.
    expect(lineasPago(DIVIDIDA)).toEqual([
      { texto: "SINPE Móvil BCR ref 69898", monto: 200 },
      { texto: "Efectivo", monto: 300 },
      { texto: "Recibido", monto: 1000, sub: true },
      { texto: "Vuelto", monto: 700, sub: true },
    ]);
  });

  it("si la referencia no cabe junto al monto, se parte sin perder el monto; 80 mm usa 48 columnas", async () => {
    const neg = await obtenerNegocio();
    const larga = { ...DIVIDIDA, pagos: [{ ...DIVIDIDA.pagos[0], forma: "Transferencia", banco: "Davivienda", referencia: "1234567890123456" }, DIVIDIDA.pagos[1]] };
    const l = lineasTexto(tiqueteVenta(neg, larga, DEFAULT_SETTINGS).bytes);
    expect(l.every((x) => x.length <= 32)).toBe(true);
    expect(l.some((x) => x.endsWith("¢200"))).toBe(true);
    // En 80 mm (48 columnas) la misma línea sí cabe completa.
    const media = { ...larga, pagos: [{ ...larga.pagos[0], referencia: "123456789" }, larga.pagos[1]] };
    const ancha = lineasTexto(tiqueteVenta(neg, media, { ...DEFAULT_SETTINGS, columnas: 48 }).bytes);
    expect(ancha).toContain(lr("Transferencia Davivienda ref 123456789", "¢200", 48));
    expect(ancha.every((x) => x.length <= 48)).toBe(true);
  });
});

describe("impresión segura", () => {
  it("un texto con códigos de control no manda comandos a la impresora", () => {
    // ESC @ (reiniciar), GS V (cortar) y ESC p (gaveta) escondidos en un nombre de producto.
    const p = new EscPos(DEFAULT_SETTINGS.codePage);
    p.line("Lapiz\x1b@\x1dV\x00\x1bp\x00\x19\xfa fin");
    const b = p.bytes();
    const cuerpo = b.slice(b.indexOf(0x4c)); // desde la "L" de Lapiz
    expect([...cuerpo].filter((x) => x === 0x1b || x === 0x1d || x === 0x00)).toEqual([]);
    expect(lineasTexto(b).join("")).toContain("Lapiz");
  });
});

