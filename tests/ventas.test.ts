import { beforeEach, describe, expect, it } from "vitest";
import { listarBitacora } from "../src/db/bitacora";
import { obtenerCaja } from "../src/db/cajas";
import { crearCliente, datoParaFactura } from "../src/db/clientes";
import { db } from "../src/db/conexion";
import { obtenerNegocio } from "../src/db/negocio";
import { crearProducto } from "../src/db/productos";
import { crearTecnicoInicial, crearUsuario, usarHasher } from "../src/db/usuarios";
import {
  anularVenta,
  cerrarDia,
  cobrarVenta,
  corregirPago,
  crearEspera,
  descartarEspera,
  efectivoEsperado,
  guardarEspera,
  listarEsperas,
  marcarFacturaEmitida,
  obtenerVenta,
  pendientesFactura,
} from "../src/db/ventas";
import { interpret } from "../src/lib/preview";
import { DEFAULT_SETTINGS } from "../src/lib/tickets";
import { calcularTotales, estadoVacio, redondear } from "../src/lib/venta/calculo";
import { calcularPagos, sugerenciasEfectivo } from "../src/lib/venta/pagos";
import { tiqueteVenta } from "../src/lib/venta/tiquete";
import type { Actor, EstadoEspera, FormaPago, LineaEspera } from "../src/tipos";
import { baseDePrueba } from "./driverNode";

usarHasher({ hash: async (p) => "h:" + p, verificar: async (p, h) => h === "h:" + p });

const EF = "0000000000000000000000FP01";
const TJ = "0000000000000000000000FP02";
const SP = "0000000000000000000000FP03";
const TR = "0000000000000000000000FP04";
const BN = "0000000000000000000000BN01";
const OFICINA = "00000000000000000000000D02";

let tec: Actor, dueno: Actor, cajero: Actor;
beforeEach(async () => {
  baseDePrueba();
  const t = await crearTecnicoInicial("9999");
  tec = { id: t.id, rol: "tecnico" };
  dueno = { id: (await crearUsuario(tec, { nombre: "Dueña", rol: "dueno", pin: "1111" })).id, rol: "dueno" };
  cajero = { id: (await crearUsuario(tec, { nombre: "Luis", rol: "cajero", pin: "2222" })).id, rol: "cajero" };
});

let n = 0;
function linea(precio: number, cantidad = 1, descuento = 0): LineaEspera {
  return { id: String(++n), productoId: null, codigo: null, descripcion: `Artículo ${n}`, departamentoId: OFICINA, cantidad, precioUnitario: precio, descuento, tasaIva: 13, exento: false };
}
function venta(...lineas: LineaEspera[]): EstadoEspera {
  return { ...estadoVacio(), lineas };
}
async function cobrar(e: EstadoEspera, pagos = [{ formaPagoId: EF, monto: calcularTotales(e, 5).total }], quien = cajero) {
  const esp = await crearEspera(quien, e);
  return cobrarVenta(quien, esp.id, e, pagos);
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

describe("cobro y consecutivo", () => {
  it("guarda venta, líneas y pagos y cierra la espera", async () => {
    const r = await cobrar(venta(linea(1250, 2), linea(350)), [{ formaPagoId: EF, monto: 5000 }]);
    expect(r).toMatchObject({ numero: "67791", vuelto: 2150, hayEfectivo: true });
    const v = (await obtenerVenta(r.ventaId))!;
    expect(v).toMatchObject({ consecutivo: 67791, total: 2850, cajero: "Luis", estado: "completada" });
    expect(v.lineas).toHaveLength(2);
    expect(v.pagos).toMatchObject([{ forma: "Efectivo", monto: 2850, recibido: 5000, vuelto: 2150 }]);
    expect(await listarEsperas()).toHaveLength(0);
  });

  it("sin saltos con varias ventas en espera cobradas a la vez, aunque una falle", async () => {
    const esperas = await Promise.all([1, 2, 3, 4, 5].map((i) => crearEspera(cajero, venta(linea(100 * i)))));
    const resultados = await Promise.allSettled(
      esperas.map((e, i) =>
        // La tercera paga de menos: falla y NO debe gastar número.
        cobrarVenta(cajero, e.id, e.estado, [{ formaPagoId: EF, monto: i === 2 ? 1 : 100 * (i + 1) }]),
      ),
    );
    expect(resultados.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"]);
    const numeros = (await db().select("SELECT consecutivo FROM ventas ORDER BY consecutivo")).map((f) => f.consecutivo);
    expect(numeros).toEqual([67791, 67792, 67793, 67794]);
    expect((await obtenerCaja())?.consecutivoSiguiente).toBe(67795);
    // La que falló sigue en espera, intacta.
    expect((await listarEsperas()).map((e) => e.numero)).toEqual([3]);
  });

  it("un doble cobro de la misma espera no crea dos ventas ni gasta número", async () => {
    const e = venta(linea(1000));
    const esp = await crearEspera(cajero, e);
    await cobrarVenta(cajero, esp.id, e, [{ formaPagoId: EF, monto: 1000 }]);
    await expect(cobrarVenta(cajero, esp.id, e, [{ formaPagoId: EF, monto: 1000 }])).rejects.toThrow("ya se cobró");
    expect((await db().select("SELECT COUNT(*) AS n FROM ventas"))[0].n).toBe(1);
    expect((await obtenerCaja())?.consecutivoSiguiente).toBe(67792);
  });
});

describe("ventas en espera", () => {
  it("persisten en SQLite: se retoman tal cual y cobrar una no toca las demás", async () => {
    const a = await crearEspera(cajero, venta(linea(500)));
    const b = await crearEspera(cajero, venta());
    expect([a.numero, b.numero]).toEqual([1, 2]);
    const cambiada = { ...venta(linea(700, 3)), nombreTiquete: "Juan" };
    await guardarEspera(b.id, cambiada);
    // "Se fue la luz": se vuelve a leer todo de la base.
    const leidas = await listarEsperas();
    expect(leidas.find((e) => e.id === b.id)?.estado).toEqual(cambiada);
    await cobrarVenta(cajero, a.id, a.estado, [{ formaPagoId: EF, monto: 500 }]);
    expect((await listarEsperas()).map((e) => [e.numero, e.estado])).toEqual([[2, cambiada]]);
    // La pestaña 1 quedó libre y se reutiliza.
    expect((await crearEspera(cajero, venta())).numero).toBe(1);
  });

  it("descartar queda en bitácora", async () => {
    const a = await crearEspera(cajero, venta(linea(500), linea(250)));
    await descartarEspera(cajero, a.id, 5);
    expect(await listarEsperas()).toHaveLength(0);
    expect((await listarBitacora())[0]).toMatchObject({ accion: "venta_espera.descartar", detalle: { numero: 1, lineas: 2, total: 750 } });
  });
});

describe("descuentos con tope por rol", () => {
  it("el cajero pasa de 10 % solo con autorización de un dueño", async () => {
    const e = { ...venta(linea(10000)), descuentoTotal: 2000 };
    await expect(cobrar(e, [{ formaPagoId: EF, monto: 8000 }])).rejects.toThrow("PIN del dueño");
    await expect(cobrar({ ...e, autorizacion: { duenoId: cajero.id, pct: 20 } }, [{ formaPagoId: EF, monto: 8000 }])).rejects.toThrow("no es válida");
    const r = await cobrar({ ...e, autorizacion: { duenoId: dueno.id, pct: 20 } }, [{ formaPagoId: EF, monto: 8000 }]);
    expect((await obtenerVenta(r.ventaId))?.total).toBe(8000);
    expect((await listarBitacora()).find((x) => x.accion === "venta.descuento_autorizado")?.detalle).toMatchObject({ pct: 20, autorizadoPor: dueno.id });
    // Dentro del tope no pide nada.
    await expect(cobrar({ ...venta(linea(10000)), descuentoTotal: 1000 }, [{ formaPagoId: EF, monto: 9000 }])).resolves.toBeTruthy();
  });
});

describe("corrección de forma de pago", () => {
  it("sin efectivo: solo motivo; el total se mantiene y queda el historial", async () => {
    const r = await cobrar(venta(linea(5000)), [{ formaPagoId: TJ, monto: 5000, ultimos4: "1234" }]);
    const pago = (await obtenerVenta(r.ventaId))!.pagos[0];
    await expect(corregirPago(cajero, pago.id, { formaPagoId: SP, referencia: "998877" }, "")).rejects.toThrow("motivo");
    await corregirPago(cajero, pago.id, { formaPagoId: SP, referencia: "998877" }, "Era SINPE, no tarjeta");
    const v = (await obtenerVenta(r.ventaId))!;
    expect(v.total).toBe(5000);
    expect(v.pagos).toMatchObject([{ forma: "SINPE Móvil", monto: 5000, referencia: "998877", ultimos4: null }]);
    expect((await db().select("SELECT * FROM venta_pago_correcciones"))[0]).toMatchObject({ forma_pago_anterior_id: TJ, forma_pago_nueva_id: SP, ultimos4_anterior: "1234", motivo: "Era SINPE, no tarjeta" });
    expect((await listarBitacora())[0]).toMatchObject({ accion: "venta.pago_corregido", detalle: { antes: { forma: "Tarjeta" }, despues: { forma: "SINPE Móvil" } } });
  });

  it("de o hacia efectivo pide PIN del dueño y cambia lo esperado en caja", async () => {
    const r = await cobrar(venta(linea(4000)), [{ formaPagoId: EF, monto: 5000 }]);
    expect(await efectivoEsperado()).toBe(4000);
    const pago = (await obtenerVenta(r.ventaId))!.pagos[0];
    await expect(corregirPago(cajero, pago.id, { formaPagoId: TJ }, "Pagó con tarjeta")).rejects.toThrow("PIN del dueño");
    await expect(corregirPago(cajero, pago.id, { formaPagoId: TJ }, "Pagó con tarjeta", "2222")).rejects.toThrow("PIN del dueño");
    await corregirPago(cajero, pago.id, { formaPagoId: TJ }, "Pagó con tarjeta", "1111");
    expect(await efectivoEsperado()).toBe(0);
    expect((await obtenerVenta(r.ventaId))!.pagos[0]).toMatchObject({ forma: "Tarjeta", monto: 4000, recibido: null, vuelto: null });
    expect((await db().select("SELECT autorizado_por FROM venta_pago_correcciones"))[0].autorizado_por).toBe(dueno.id);
  });

  it("bloqueada con el día cerrado o en ventas de otro día", async () => {
    const r = await cobrar(venta(linea(1000)), [{ formaPagoId: TJ, monto: 1000 }]);
    const pago = (await obtenerVenta(r.ventaId))!.pagos[0];
    await db().execute("UPDATE ventas SET dia = '2020-01-01' WHERE id = ?", [r.ventaId]);
    await expect(corregirPago(cajero, pago.id, { formaPagoId: SP, referencia: "1" }, "motivo largo")).rejects.toThrow("ya se cerró");
    await db().execute("UPDATE ventas SET dia = (SELECT dia FROM ventas WHERE id <> ? LIMIT 1) WHERE id = ?", [r.ventaId, r.ventaId]);
    const r2 = await cobrar(venta(linea(1000)), [{ formaPagoId: TJ, monto: 1000 }]);
    const p2 = (await obtenerVenta(r2.ventaId))!.pagos[0];
    await cerrarDia(dueno);
    await expect(corregirPago(cajero, p2.id, { formaPagoId: SP, referencia: "1" }, "motivo largo")).rejects.toThrow("ya se cerró");
    await expect(cerrarDia(cajero)).rejects.toThrow("permiso");
  });
});

describe("anulación", () => {
  it("con PIN de dueño y motivo: queda anulada, conserva el consecutivo y sale del efectivo esperado", async () => {
    const r = await cobrar(venta(linea(3000)));
    await expect(anularVenta(cajero, r.ventaId, "1111", "")).rejects.toThrow("motivo");
    await expect(anularVenta(cajero, r.ventaId, "0000", "Cliente devolvió")).rejects.toThrow("PIN");
    await anularVenta(cajero, r.ventaId, "1111", "Cliente devolvió");
    const v = (await obtenerVenta(r.ventaId))!;
    expect(v).toMatchObject({ estado: "anulada", numero: "67791", anuladaMotivo: "Cliente devolvió" });
    expect(await efectivoEsperado()).toBe(0);
    expect((await listarBitacora()).map((b) => b.accion)).toContain("venta.anular");
    expect((await listarBitacora()).map((b) => b.accion)).toContain("autorizacion.fallida");
  });
});

describe("cliente en la venta", () => {
  it("no se puede crear el cliente sin consentimiento", async () => {
    await expect(crearCliente(cajero, { nombre: "Ana", telefono: "", cedula: "112340567" }, false, "1")).rejects.toThrow("consentimiento");
  });

  it("'nombre en tiquete (no guardar)' no crea cliente y sale en el tiquete", async () => {
    const r = await cobrar({ ...venta(linea(1000)), nombreTiquete: "Escuela Lincoln" });
    expect((await db().select("SELECT COUNT(*) AS n FROM clientes"))[0].n).toBe(0);
    const v = (await obtenerVenta(r.ventaId))!;
    expect(v).toMatchObject({ clienteId: null, nombreTiquete: "Escuela Lincoln" });
    const texto = lineasTexto(tiqueteVenta(await obtenerNegocio(), v, DEFAULT_SETTINGS, { nombreCliente: v.nombreTiquete }).bytes);
    expect(texto).toContain("Cliente: Escuela Lincoln");
  });
});

describe("pendientes de factura", () => {
  it("factura sin cliente no se cobra; con cliente queda pendiente hasta marcarla", async () => {
    await expect(cobrar({ ...venta(linea(1000)), requiereFactura: true })).rejects.toThrow("cliente");
    const c = await crearCliente(cajero, { nombre: "Ana", telefono: "", cedula: "112340567", correo: "ana@x.cr" }, true, "1");
    const r = await cobrar({ ...venta(linea(1000)), requiereFactura: true, cliente: c });
    await cobrar(venta(linea(500))); // sin factura: no aparece
    const p = await pendientesFactura(cajero);
    expect(p).toMatchObject([{ ventaId: r.ventaId, cliente: "Ana", cedula: "112340567", tieneCorreo: true }]);
    expect(p[0]).not.toHaveProperty("correo");
    await expect(pendientesFactura(tec)).rejects.toThrow("permiso");
    // Copiar el correo para el facturador: la bitácora dice qué campo, no el valor.
    expect(await datoParaFactura(cajero, c.id, "correo")).toBe("ana@x.cr");
    const copia = (await listarBitacora()).find((b) => b.accion === "cliente.copiar")!;
    expect(copia.detalle).toEqual({ campo: "correo" });
    expect(JSON.stringify(await db().select("SELECT detalle FROM bitacora"))).not.toContain("ana@x.cr");

    await expect(marcarFacturaEmitida(cajero, r.ventaId, " ")).rejects.toThrow("número o la clave");
    await marcarFacturaEmitida(cajero, r.ventaId, "00100001010000000123");
    expect(await pendientesFactura(dueno)).toEqual([]);
    expect((await obtenerVenta(r.ventaId))?.facturaReferencia).toBe("00100001010000000123");
    await expect(marcarFacturaEmitida(cajero, r.ventaId, "otra")).rejects.toThrow("no está pendiente");
  });
});

function lineasTexto(bytes: Uint8Array): string[] {
  return interpret(bytes).flatMap((i) => (i.kind === "line" ? [i.spans.map((s) => s.text).join("")] : i.kind === "event" ? [i.text] : []));
}

describe("tiquete", () => {
  it("consecutivo, cajero, descuentos, pagos, vuelto, ¢ y leyenda; COPIA sin gaveta", async () => {
    const r = await cobrar({ ...venta(linea(1250, 2, 100)), descuentoTotal: 50 }, [{ formaPagoId: TJ, monto: 1000, ultimos4: "4321" }, { formaPagoId: EF, monto: 5000 }]);
    const v = (await obtenerVenta(r.ventaId))!;
    const n = await obtenerNegocio();
    const original = lineasTexto(tiqueteVenta(n, v, DEFAULT_SETTINGS, { textoNoFactura: "Este tiquete no es una factura electrónica", abrirGaveta: true }).bytes);
    const t = original.join("\n");
    for (const s of ["67791", "Luis", "-¢100", "-¢50", "TOTAL", "¢2.350", "Tarjeta ****4321", "Vuelto", "¢3.650", "Este tiquete no es una factura", "electrónica"]) expect(t).toContain(s);
    expect(t).toContain("ESC p: pulso a gaveta");
    const copia = lineasTexto(tiqueteVenta(n, v, DEFAULT_SETTINGS, { copia: true, abrirGaveta: true }).bytes).join("\n");
    expect(copia).toContain("*** COPIA ***");
    expect(copia).not.toContain("gaveta");
  });
});
