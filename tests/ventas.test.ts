// Cobro, consecutivo, turnos, descuentos con tope, corrección y anulación se prueban en Rust
// (src-tauri/src/ventas.rs y caja.rs). Aquí: el cálculo que muestra la pantalla y lo impreso.
import { beforeEach, describe, expect, it } from "vitest";
import type { Detalle } from "../src/db/caja";
import { obtenerNegocio } from "../src/db/negocio";
import { reporteZ } from "../src/lib/caja/reporteZ";
import { EscPos } from "../src/lib/escpos";
import { interpret } from "../src/lib/preview";
import { DEFAULT_SETTINGS } from "../src/lib/tickets";
import { calcularTotales, estadoVacio, redondear } from "../src/lib/venta/calculo";
import { calcularPagos, sugerenciasEfectivo } from "../src/lib/venta/pagos";
import { tiqueteVenta } from "../src/lib/venta/tiquete";
import type { EstadoEspera, FormaPago, LineaEspera, Venta } from "../src/tipos";
import { baseDePrueba } from "./driverNode";

const EF = "0000000000000000000000FP01";
const TJ = "0000000000000000000000FP02";
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
  id: "V1", cajaId: "C1", turnoId: "T1", turnoAbierto: true, consecutivo: 67791, numero: "67791", fecha: "2026-10-29T15:30:00Z", dia: "2026-10-29",
  usuarioId: "U", cajero: "Luis", clienteId: null, cliente: null, nombreTiquete: null, subtotal: 2400, descuento: 50, redondeo: 0, total: 2350, ivaTotal: 270,
  estado: "completada", anuladaMotivo: null, requiereFactura: false, facturaEmitida: false, facturaReferencia: null, reimpresiones: 0,
  lineas: [{ id: "L1", productoId: null, codigo: null, descripcion: "Cuaderno", departamentoId: OFICINA, cantidad: 2, precioUnitario: 1250, descuento: 100, total: 2400, tasaIva: 13, iva: 270 }],
  pagos: [
    { id: "P1", formaPagoId: TJ, forma: "Tarjeta", tipo: "tarjeta", monto: 1000, recibido: null, vuelto: null, bancoId: null, banco: null, referencia: null, ultimos4: "4321" },
    { id: "P2", formaPagoId: EF, forma: "Efectivo", tipo: "efectivo", monto: 1350, recibido: 5000, vuelto: 3650, bancoId: null, banco: null, referencia: null, ultimos4: null },
  ],
};

describe("tiquete", () => {
  it("consecutivo, cajero, descuentos, pagos, vuelto, ¢ y leyenda; COPIA sin gaveta", async () => {
    const neg = await obtenerNegocio();
    const t = lineasTexto(tiqueteVenta(neg, VENTA, DEFAULT_SETTINGS, { textoNoFactura: "Este tiquete no es una factura electrónica", abrirGaveta: true }).bytes).join("\n");
    for (const s of ["67791", "Luis", "-¢100", "-¢50", "TOTAL", "¢2.350", "Tarjeta ****4321", "Vuelto", "¢3.650", "Este tiquete no es una factura", "electrónica"]) expect(t).toContain(s);
    expect(t).toContain("ESC p: pulso a gaveta");
    const copia = lineasTexto(tiqueteVenta(neg, VENTA, DEFAULT_SETTINGS, { copia: true, abrirGaveta: true }).bytes).join("\n");
    expect(copia).toContain("*** COPIA ***");
    expect(copia).not.toContain("gaveta");
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

describe("reporte Z", () => {
  const detalle = (ve: boolean): Detalle => ({
    veEsperado: ve,
    bitacoraOk: true,
    turno: {
      id: "T1", cajaId: "C1", estado: "cerrado", dia: "2026-10-29", abiertoEn: "2026-10-29T14:00:00Z", cerradoEn: "2026-10-30T00:00:00Z",
      usuarioAperturaId: "U", usuarioApertura: "Luis", usuarioCierreId: "U", usuarioCierre: "Luis", fondo: 27000, conteoInicial: null,
      conteoFinal: { "10000": 2, "1000": 4 }, esperado: ve ? 25000 : null, contado: 24000, diferencia: ve ? -1000 : null, notaCierre: "Faltan mil", revisadaPor: null, reimpresiones: 0,
    },
    resumen: {
      fondo: 27000, ventas: 3, totalVentas: 8000, descuentos: 0, anuladas: 1, totalAnuladas: 500,
      porForma: [{ formaPagoId: EF, nombre: "Efectivo", tipo: "efectivo", daVuelto: true, pagos: 2, monto: 3000 }, { formaPagoId: TJ, nombre: "Tarjeta", tipo: "tarjeta", daVuelto: false, pagos: 1, monto: 5000 }],
      recibidoEfectivo: 5000, vueltos: 2000, ventasEfectivo: 3000, entradas: 0, salidas: 5000, efectivoEsperado: 25000,
      movimientos: [{ id: "M1", tipo: "salida", monto: 5000, categoria: "Pago a proveedor", motivo: "", usuario: "Luis", autorizadoPor: null, fecha: "2026-10-29T18:00:00Z" }],
      ajustes: [],
      pagosElectronicos: [
        { fecha: "2026-10-29T16:05:00Z", ventaNumero: "67795", forma: "Tarjeta", tipo: "tarjeta", monto: 5000, ultimos4: "4321", banco: null, referencia: null },
      ],
    },
  });

  it("totales por forma, efectivo esperado, contado y faltante; la reimpresión dice COPIA", async () => {
    const neg = await obtenerNegocio();
    const t = lineasTexto(reporteZ(neg, detalle(true), DEFAULT_SETTINGS, { copia: false }).bytes).join("\n");
    for (const s of ["CIERRE DE CAJA (Z)", "Efectivo (2)", "¢3.000", "Tarjeta (1)", "¢5.000", "Esperado", "¢25.000", "Contado", "¢24.000", "Faltante", "-¢1.000", "Pago a proveedor", "Faltan mil"])
      expect(t).toContain(s);
    expect(t).not.toContain("COPIA");
    // Detalle de tarjeta para cuadrar con el cierre del datáfono.
    expect(t).toContain("DETALLE TARJETA/SINPE/TRANSF.");
    expect(t).toMatch(/67795 \*\*\*\*4321/);
    expect(lineasTexto(reporteZ(neg, detalle(true), DEFAULT_SETTINGS, { copia: true }).bytes).join("\n")).toContain("*** COPIA ***");
  });

  it("en cierre ciego no sale lo esperado ni la diferencia", async () => {
    const t = lineasTexto(reporteZ(await obtenerNegocio(), detalle(false), DEFAULT_SETTINGS, { copia: false }).bytes).join("\n");
    expect(t).toContain("Contado");
    expect(t).not.toContain("Esperado");
    expect(t).not.toContain("Faltante");
    // La tarjeta no es efectivo: también sale en cierre ciego.
    expect(t).toContain("****4321");
  });
});
