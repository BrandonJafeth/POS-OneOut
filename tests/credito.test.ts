// Venta a crédito: comprobante (además del tiquete) y estado de cuenta en papel.
import { describe, expect, it } from "vitest";
import type { CuentaDetalle, EstadoCuenta } from "../src/db/cuentas";
import { comprobanteCuenta } from "../src/lib/cuentas/comprobante";
import { estadoCuentaPdf, estadoCuentaTermica } from "../src/lib/cuentas/estadoCuenta";
import { interpret } from "../src/lib/preview";
import { DEFAULT_SETTINGS, lr } from "../src/lib/tickets";
import { imprimirTrasCobro } from "../src/lib/venta/trasCobro";
import type { Negocio } from "../src/tipos";

const negocio: Negocio = {
  nombreComercial: "Librería y Bazar Chagui", razonSocial: "", cedula: "", direccion: "", telefono: "", correo: "", regimen: "", encabezadoExtra: "", pieTiquete: "",
  responsableTratamiento: "", avisoPrivacidadTexto: "", avisoPrivacidadVersion: "1", logo: null, logoUmbral: null,
};

function credito(): CuentaDetalle {
  return {
    cuenta: {
      id: "K1", numero: "C-0001", tipo: "credito", estado: "abierta", clienteId: "C1", cliente: "Marta Solís", telefono: null,
      fecha: "2026-11-16T16:00:00Z", fechaLimite: "2026-11-27", descripcion: null, total: 20000, saldo: 20000, abonado: 0, vencida: false, diasAtraso: 0,
    },
    subtotal: 0, descuento: 0, redondeo: 0, condonado: 0, devuelto: 0, retenido: 0, ventaTotal: 30000, ventaId: "V1", ventaNumero: "001-0001", usuario: "Luis",
    lineas: [{ productoId: "P1", descripcion: "Mochila escolar", cantidad: 1, precioUnitario: 30000, descuento: 0, total: 30000 }],
    abonos: [], eventos: [],
  };
}

const texto = (b: Uint8Array) =>
  interpret(b)
    .filter((x) => x.kind === "line")
    .map((x) => ("spans" in x ? x.spans.map((s) => s.text).join("") : ""));

describe("venta a crédito", () => {
  it("el comprobante dice cuenta, total, pagado, saldo, fecha límite, condiciones y firma (no «pagaré»)", () => {
    const l = texto(comprobanteCuenta(negocio, credito(), DEFAULT_SETTINGS, { tipo: "credito", condiciones: "Pague antes de la fecha." }).bytes);
    const t = l.join("\n");
    expect(t).toContain("C-0001");
    expect(t).toContain("CRÉDITO");
    expect(l).toContain(lr("TOTAL", "¢30.000"));
    expect(l).toContain(lr("Pagado hoy", "¢10.000"));
    expect(l).toContain(lr("SALDO", "¢20.000"));
    expect(l).toContain(lr("Pagar antes del:", "27/11/2026"));
    expect(t).toContain("Pague antes de la fecha.");
    expect(t).toContain("Firma del cliente");
    expect(t.toLowerCase()).not.toContain("pagaré");
  });

  it("después de cobrar a crédito se imprime el tiquete y además el comprobante; una venta normal, solo el tiquete", async () => {
    const hechos: string[] = [];
    const imp = { venta: async (id: string) => void hechos.push(`venta ${id}`), comprobanteCredito: async (id: string) => void hechos.push(`credito ${id}`) };
    expect(await imprimirTrasCobro({ ventaId: "V1", cuentaId: "K1" }, imp)).toBeUndefined();
    expect(hechos).toEqual(["venta V1", "credito K1"]);
    hechos.length = 0;
    await imprimirTrasCobro({ ventaId: "V2", cuentaId: null }, imp);
    expect(hechos).toEqual(["venta V2"]);
  });

  it("si falla el tiquete, igual sale el comprobante (y se avisa el error)", async () => {
    const hechos: string[] = [];
    const err = await imprimirTrasCobro(
      { ventaId: "V1", cuentaId: "K1" },
      { venta: async () => Promise.reject(new Error("Sin papel")), comprobanteCredito: async (id) => void hechos.push(id) },
    );
    expect(err).toBe("Sin papel");
    expect(hechos).toEqual(["K1"]);
  });

  it("estado de cuenta: cada cuenta con sus abonos y el total adeudado", () => {
    const c = credito();
    c.abonos = [{ id: "A1", fecha: "2026-11-18T15:30:00Z", forma: "Efectivo", monto: 5000, recibido: 5000, vuelto: 0, referencia: null, usuario: "Luis", anulado: false, operacionId: "O1" }];
    c.cuenta.saldo = 15000;
    const ap: CuentaDetalle = { ...credito(), cuenta: { ...credito().cuenta, id: "K2", numero: "A-0003", tipo: "apartado", saldo: 8000, total: 16000 }, ventaTotal: null };
    const ec: EstadoCuenta = { cliente: "Marta Solís", cuentas: [c, ap], totalAdeudado: 23000 };
    const t = texto(estadoCuentaTermica(negocio, ec, DEFAULT_SETTINGS).bytes).join("\n");
    for (const s of ["ESTADO DE CUENTA", "Crédito C-0001", "Apartado A-0003", "Efectivo", lr("TOTAL ADEUDADO", "¢23.000")]) expect(t).toContain(s);
    const pdf = estadoCuentaPdf(ec);
    expect(pdf.filter((b) => b.tipo === "tabla")).toHaveLength(2);
  });
});
