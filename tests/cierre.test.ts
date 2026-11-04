// Cierre Z impreso y en PDF: contenido, casillas (detalle completo / tiquete por departamento),
// cuadre de totales, ancho del papel y lista blanca ESC/POS. Que los números salgan bien de la
// base (reparto exacto, efectivo esperado, permisos) lo prueba Rust: desglose.rs, caja.rs, ventas.rs.
import { beforeEach, describe, expect, it } from "vitest";
import type { Corte, Detalle } from "../src/db/caja";
import { obtenerNegocio } from "../src/db/negocio";
import { pdfCierre } from "../src/lib/caja/pdfZ";
import { comprobanteMovimiento, descuadres, documentosCierre, NOTA_USUARIOS, opcionesPorDefecto, reporteCorte, reporteZ } from "../src/lib/caja/reporteZ";
import { interpret } from "../src/lib/preview";
import { DEFAULT_SETTINGS, lr } from "../src/lib/tickets";
import type { Negocio } from "../src/tipos";
import { baseDePrueba } from "./driverNode";
import { validarEscPos } from "./escposValidar";

beforeEach(() => {
  baseDePrueba();
});

function lineasTexto(bytes: Uint8Array): string[] {
  return interpret(bytes).flatMap((i) => (i.kind === "line" ? [i.spans.map((s) => s.text).join("")] : []));
}

const texto = (b: Uint8Array) => lineasTexto(b).join("\n");

/**
 * Turno de ejemplo (cifras consistentes, como las arma Rust):
 *  V1 42 impresiones a ¢200 por SINPE · V2 1 impresión en efectivo (paga 1000, vuelto 800)
 *  V3 cuaderno ¢1500 + 3 impresiones, descuento ¢105 → ¢1995: ¢1000 SINPE + ¢995 efectivo (paga 2000, vuelto 1005)
 */
function detalle(): Detalle {
  return {
    veTotales: true,
    bitacoraOk: true,
    turno: {
      id: "T1", cajaId: "C1", caja: "Caja 1", estado: "cerrado", dia: "2026-11-03", abiertoEn: "2026-11-03T14:00:00Z", cerradoEn: "2026-11-03T23:50:00Z",
      usuarioAperturaId: "U1", usuarioApertura: "Juarez", usuarioCierreId: "U2", usuarioCierre: "Isaias", fondo: 10000, conteoInicial: null,
      conteoFinal: { "10000": 1, "2000": 1, "1000": 1, "500": 1, "100": 1, "50": 1, "25": 1, "10": 1, "5": 1 }, esperado: 13695, contado: 13690, diferencia: -5,
      notaCierre: null, revisadaPor: null, reimpresiones: 0,
    },
    resumen: {
      fondo: 10000, ventas: 3, totalVentas: 10595, descuentos: 105, anuladas: 1, totalAnuladas: 700,
      porForma: [
        { formaPagoId: "EF", nombre: "Efectivo", tipo: "efectivo", codigo: "Co", daVuelto: true, pagos: 2, monto: 1195 },
        { formaPagoId: "SP", nombre: "SINPE Móvil", tipo: "sinpe", codigo: "De", daVuelto: false, pagos: 2, monto: 9400 },
      ],
      recibidoEfectivo: 3000, vueltos: 1805, ventasEfectivo: 1195, entradas: 3000, salidas: 500, efectivoEsperado: 13695,
      movimientos: [
        { id: "M1", tipo: "entrada", monto: 3000, categoria: "Ingreso de cambio", motivo: "", usuario: "Juarez", autorizadoPor: null, fecha: "2026-11-03T15:00:00Z" },
        { id: "M2", tipo: "salida", monto: 500, categoria: "Gasto menor", motivo: "Agua", usuario: "Juarez", autorizadoPor: null, fecha: "2026-11-03T18:00:00Z" },
      ],
      ajustes: [],
      pagosElectronicos: [
        { fecha: "2026-11-03T16:05:00Z", ventaNumero: "67979", forma: "SINPE Móvil", tipo: "sinpe", monto: 8400, ultimos4: null, banco: "BCR", referencia: "69898" },
        { fecha: "2026-11-03T20:05:00Z", ventaNumero: "67981", forma: "SINPE Móvil", tipo: "sinpe", monto: 1000, ultimos4: null, banco: null, referencia: "777" },
      ],
      porUsuario: [
        { usuario: "Juarez", ventas: 2, total: 8600 },
        { usuario: "Isaias", ventas: 1, total: 1995 },
      ],
      noVentas: [
        { fecha: "2026-11-03T17:00:00Z", usuario: "Juarez", causa: "no_venta", motivo: "Cambio de billetes", nota: null, autorizadoPor: null },
        { fecha: "2026-11-03T19:00:00Z", usuario: "Juarez", causa: "dueno", motivo: "Poner fondo", nota: null, autorizadoPor: "Isaias" },
      ],
      noVentaUmbral: 2,
      cortes: [{ id: "K1", fecha: "2026-11-03T19:30:00Z", usuario: "Isaias", ventas: 2, total: 8600, efectivoEsperado: 14000, retiro: 0 }],
      conDesglose: true,
      cuadra: true,
      descuadres: [],
      desglose: {
        cantidad: 47,
        total: 10595,
        efectivo: 1195,
        ventasDescuadradas: [],
        departamentos: [
          {
            departamentoId: "D1", nombre: "Librería", cantidad: 1, monto: 1425, efectivo: 711,
            porForma: [{ forma: "Efectivo", codigo: "Co", monto: 711 }, { forma: "SINPE Móvil", codigo: "De", monto: 714 }],
            filas: [{ codigo: "Mx", producto: "Cuaderno cosido 100 hojas cuadriculado universitario", cantidad: 1, precio: 1500, monto: 1425, efectivo: 711 }],
          },
          {
            departamentoId: "D7", nombre: "Fotocopias", cantidad: 46, monto: 9170, efectivo: 484,
            porForma: [{ forma: "Efectivo", codigo: "Co", monto: 484 }, { forma: "SINPE Móvil", codigo: "De", monto: 8686 }],
            filas: [
              { codigo: "Co", producto: "IMPRESIONES A COLOR", cantidad: 1, precio: 200, monto: 200, efectivo: 200 },
              { codigo: "De", producto: "IMPRESIONES A COLOR", cantidad: 42, precio: 200, monto: 8400, efectivo: 0 },
              { codigo: "Mx", producto: "IMPRESIONES A COLOR", cantidad: 3, precio: 200, monto: 570, efectivo: 284 },
            ],
          },
        ],
      },
    },
  };
}

const SIN: { copia: boolean; detalleCompleto: boolean; porDepartamento: boolean } = { copia: false, detalleCompleto: false, porDepartamento: false };

describe("reporte Z", () => {
  it("resumen, efectivo, usuarios, departamentos, pagos electrónicos, movimientos, conteo y firmas", async () => {
    const neg = await obtenerNegocio();
    const doc = reporteZ(neg, detalle(), DEFAULT_SETTINGS, SIN);
    const l = lineasTexto(doc.bytes);
    const t = l.join("\n");
    for (const s of ["CIERRE DE CAJA (Z)", "Caja 1", "2026-11-03", "Juarez", "Isaias", "VENTAS POR FORMA DE PAGO", "VENTAS POR USUARIO", "POR DEPARTAMENTO", "DETALLE TARJETA/SINPE/TRANSF.", "MOVIMIENTOS DE EFECTIVO", "APERTURAS SIN VENTA", "CORTES", "CONTEO", "BILLETES", "MONEDAS", "Cajero: Isaias", "Supervisor:"])
      expect(t).toContain(s);
    expect(l).toContain(lr("Co Efectivo (2)", "¢1.195"));
    expect(l).toContain(lr("De SINPE Móvil (2)", "¢9.400"));
    expect(l).toContain(lr("TOTAL VENTAS (3)", "¢10.595"));
    // Efectivo esperado = fondo + contado + entradas − salidas − vueltos.
    expect(l).toContain(lr("Efectivo esperado", "¢13.695"));
    expect(l).toContain(lr("Efectivo contado", "¢13.690"));
    expect(l).toContain(lr("Faltante", "-¢5"));
    expect(l).toContain(lr("Descuentos", "¢105"));
    expect(l).toContain(lr("Anulaciones (1)", "¢700"));
    expect(l).toContain(lr("Aperturas sin venta", "2"));
    expect(t.replace(/\n/g, " ")).toContain("ATENCION: muchas aperturas sin venta (umbral 2)");
    expect(l).toContain(lr("Cortes realizados", "1"));
    expect(l).toContain(lr("Juarez (2 tiq.)", "¢8.600"));
    expect(t.replace(/\n/g, " ")).toContain(NOTA_USUARIOS);
    expect(l).toContain(lr("Fotocopias (46)", "¢9.170"));
    expect(l).toContain(lr("  en efectivo", "¢484"));
    // La referencia completa: en la misma línea si cabe; si no, en la siguiente.
    expect(t).toMatch(/67979[\s\S]{0,40}BCR ref 69898/);
    expect(t).toMatch(/67981 ref 777 +¢1\.000/);
    expect(t.replace(/\n/g, " ")).toContain("Orden del dueño: Poner fondo");
    // El conteo lista todas las denominaciones, también las que fueron 0.
    expect(t).toMatch(/50 mil +0 +¢0/);
    expect(t).toMatch(/5 +1 +¢5/);
    // Sin la casilla, no va el detalle completo.
    expect(t).not.toContain("DETALLE DE VENTAS");
    expect(l.every((x) => x.length <= 32)).toBe(true);
    validarEscPos(doc.bytes);
  });

  it("las casillas imprimen solo lo elegido; la reimpresión sale COPIA en cada papel", async () => {
    const neg = await obtenerNegocio();
    expect(documentosCierre(neg, detalle(), DEFAULT_SETTINGS, SIN)).toHaveLength(1);

    const conDetalle = documentosCierre(neg, detalle(), DEFAULT_SETTINGS, { ...SIN, detalleCompleto: true });
    expect(conDetalle).toHaveLength(1);
    const d = lineasTexto(conDetalle[0].bytes);
    expect(d.join("\n")).toContain("DETALLE DE VENTAS");
    expect(d).toContain(lr("De IMPRESIONES A COLOR", "x42"));
    expect(d).toContain(lr("   ¢200", "¢8.400 ef ¢0"));
    expect(d).toContain(lr("TOTAL GENERAL (47)", "¢10.595"));
    // Nombre largo cortado de forma ordenada (termina en ".") y sin pasar de 32 columnas.
    expect(d.some((x) => x.startsWith("Mx Cuaderno cosido") && x.includes(". ") && x.endsWith("x1"))).toBe(true);
    expect(d.every((x) => x.length <= 32)).toBe(true);

    const porDep = documentosCierre(neg, detalle(), DEFAULT_SETTINGS, { ...SIN, porDepartamento: true });
    expect(porDep).toHaveLength(3); // el Z + Librería + Fotocopias
    const foto = texto(porDep[2].bytes);
    for (const s of ["VENTAS POR DEPARTAMENTO", "Fotocopias", "2026-11-03", "Caja 1", "POR FORMA DE PAGO"]) expect(foto).toContain(s);
    expect(lineasTexto(porDep[2].bytes)).toContain(lr("TOTAL Fotocopias (46)", "¢9.170"));
    expect(lineasTexto(porDep[2].bytes)).toContain(lr("De SINPE Móvil", "¢8.686"));
    expect(foto).not.toContain("Cuaderno");
    expect(texto(porDep[0].bytes)).not.toContain("DETALLE DE VENTAS");

    const copias = documentosCierre(neg, detalle(), DEFAULT_SETTINGS, { copia: true, detalleCompleto: true, porDepartamento: true });
    for (const c of copias) {
      expect(texto(c.bytes)).toContain("*** COPIA ***");
      validarEscPos(c.bytes);
    }
  });

  it("las casillas arrancan con los valores por defecto de la configuración", () => {
    expect(opcionesPorDefecto({ zDetalleCompleto: true, zPorDepartamento: false })).toEqual({ detalleCompleto: true, porDepartamento: false });
    expect(opcionesPorDefecto({ zDetalleCompleto: false, zPorDepartamento: true })).toEqual({ detalleCompleto: false, porDepartamento: true });
  });

  it("si los departamentos, el detalle o el efectivo no cuadran, no se imprime", async () => {
    const neg = await obtenerNegocio();
    expect(descuadres(detalle().resumen)).toEqual([]);
    const mal = detalle();
    mal.resumen.desglose.departamentos[1].monto -= 5;
    expect(() => documentosCierre(neg, mal, DEFAULT_SETTINGS, SIN)).toThrow(/no cuadran/);
    const fila = detalle();
    fila.resumen.desglose.departamentos[1].filas[1].monto += 1;
    expect(() => documentosCierre(neg, fila, DEFAULT_SETTINGS, SIN)).toThrow(/detalle/);
    const esperado = detalle();
    esperado.resumen.efectivoEsperado += 100;
    expect(() => documentosCierre(neg, esperado, DEFAULT_SETTINGS, SIN)).toThrow(/efectivo esperado/);
    expect(() => pdfCierre(neg, mal, { copia: false })).toThrow(/no cuadran/);
  });

  it("80 mm: 48 columnas", async () => {
    const l = lineasTexto(reporteZ(await obtenerNegocio(), detalle(), { ...DEFAULT_SETTINGS, columnas: 48 }, { ...SIN, detalleCompleto: true }).bytes);
    expect(l.every((x) => x.length <= 48)).toBe(true);
    expect(l).toContain(lr("TOTAL VENTAS (3)", "¢10.595", 48));
  });
});

describe("PDF del cierre", () => {
  it("carta con logo, detalle completo y cada departamento en su página", async () => {
    const neg: Negocio = { ...(await obtenerNegocio()), nombreComercial: "Librería Chagui", logo: { ancho: 16, alto: 2, bits: new Uint8Array([0xff, 0x00, 0x0f, 0xf0]) } };
    const pdf = new TextDecoder("latin1").decode(pdfCierre(neg, detalle(), { copia: false }));
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("/Subtype /Image");
    expect(pdf).toContain("/Im1 Do");
    expect(pdf).toContain("/MediaBox [0 0 612 792]");
    expect(pdf).toContain("(DETALLE DE VENTAS)");
    expect(pdf).toContain("(VENTAS POR DEPARTAMENTO)");
    // Z + detalle + 2 departamentos: al menos 4 páginas.
    expect(Number(/\/Count (\d+)/.exec(pdf)?.[1])).toBeGreaterThanOrEqual(4);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });
});

describe("corte y comprobantes", () => {
  it("el corte muestra lo acumulado por forma de pago sin cerrar, con el retiro", async () => {
    const d = detalle();
    const k: Corte = { id: "K", fecha: "2026-11-03T19:30:00Z", usuario: "Isaias", turno: { ...d.turno, estado: "abierto", cerradoEn: null }, resumen: d.resumen, retiro: 10000, efectivoDespues: 3695 };
    const doc = reporteCorte(await obtenerNegocio(), k, DEFAULT_SETTINGS);
    const l = lineasTexto(doc.bytes);
    for (const s of ["CORTE DE CAJA", "(el turno sigue abierto)"]) expect(l.join("\n")).toContain(s);
    expect(l).toContain(lr("TOTAL VENTAS (3)", "¢10.595"));
    expect(l).toContain(lr("Retiro", "-¢10.000"));
    expect(l).toContain(lr("Queda en la caja", "¢3.695"));
    validarEscPos(doc.bytes);
  });

  it("el comprobante de movimiento pasa la lista blanca", async () => {
    const m = detalle().resumen.movimientos[1];
    const doc = comprobanteMovimiento(await obtenerNegocio(), { ...m, autorizadoPor: "Isaias" }, DEFAULT_SETTINGS);
    expect(texto(doc.bytes)).toContain("SALIDA DE EFECTIVO");
    validarEscPos(doc.bytes);
  });
});
