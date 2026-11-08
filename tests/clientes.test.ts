// Clientes (Ley 8968): permisos, consentimiento, bitácora sin datos y anonimización se prueban en
// Rust (src-tauri/src/clientes.rs). Aquí: exportación, nube, respaldo e IVA (lo que vive en TS).
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAJA_1, SUCURSAL_PRINCIPAL } from "../src/db/cajas";
import type { ExportacionCliente } from "../src/db/clientes";
import { cambiosParaNube, COLUMNAS_PERSONALES, filaParaNube, NUBE_LISTA_BLANCA, TABLAS_PROHIBIDAS } from "../src/db/sincronizacion";
import { csvCliente, pdfCliente } from "../src/lib/exportarCliente";
import { ivaIncluido, ivaTotal } from "../src/lib/iva";
import { crearRespaldo } from "../src/lib/respaldoApi";
import { baseDePrueba } from "./driverNode";

const ANA = { nombre: "Ana Quesada Mora", telefono: "8888-1234", cedula: "112340567", correo: "ana@correo.cr", notas: "Prefiere WhatsApp" };
const PERSONALES = [ANA.nombre, "8888-1234", "88881234", ANA.cedula, ANA.correo, ANA.notas];

let sqlite: DatabaseSync;
beforeEach(() => {
  sqlite = baseDePrueba().sqlite;
});

/** Venta y apartado (ya pagado) del cliente, insertados directo en la base de prueba. */
function historial(clienteId: string) {
  sqlite
    .prepare(
      `INSERT INTO ventas (id, sucursal_id, caja_id, consecutivo, numero, fecha, usuario_id, cliente_id, subtotal, total, iva_total)
       VALUES ('V1', ?, ?, 67791, '67791', '2026-01-10T10:00:00Z', 'U-PRUEBA', ?, 11300, 11300, 1300)`,
    )
    .run(SUCURSAL_PRINCIPAL, CAJA_1, clienteId);
  sqlite
    .prepare(
      `INSERT INTO cuentas (id, sucursal_id, caja_id, tipo, cliente_id, usuario_id, fecha, total, saldo, estado, notas)
       VALUES ('K1', ?, ?, 'apartado', ?, 'U-PRUEBA', '2026-01-05T10:00:00Z', 5000, 0, 'pagada', 'Ana pasa el viernes')`,
    )
    .run(SUCURSAL_PRINCIPAL, CAJA_1, clienteId);
}

function exportacion(cambios: Partial<ExportacionCliente["cliente"]> = {}): ExportacionCliente {
  return {
    cliente: {
      id: "C1",
      ...ANA,
      tipoIdentificacion: "fisica",
      consentimientoDatos: true,
      consentimientoFecha: "2026-01-01T10:00:00Z",
      consentimientoVersion: "1",
      anonimizadoEn: null,
      creadoEn: "2026-01-01T10:00:00Z",
      actualizadoEn: "2026-01-01T10:00:00Z",
      ...cambios,
    },
    cuentas: [{ id: "K1", tipo: "apartado", fecha: "2026-01-05T10:00:00Z", total: 5000, saldo: 0, estado: "pagada" }],
    ventas: [{ numero: "67791", fecha: "2026-01-10T10:00:00Z", total: 11300 }],
  };
}

describe("exportación del titular", () => {
  it("CSV con BOM y PDF válido con tildes", () => {
    const e = exportacion();
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(csvCliente(e));
    expect(csv.startsWith("\uFEFFCampo,Valor")).toBe(true);
    expect(csv).toContain("Teléfono,8888-1234");
    const pdf = pdfCliente(e, { nombreComercial: "Librería Chagui", responsableTratamiento: "Chagui S.A.", logo: null });
    const txt = new TextDecoder("latin1").decode(pdf);
    expect(txt.startsWith("%PDF-1.4")).toBe(true);
    expect(txt.trimEnd().endsWith("%%EOF")).toBe(true);
    // Etiqueta y valor van en columnas, con sus tildes en WinAnsi.
    expect(txt).toContain("(Teléfono)");
    expect(txt).toContain("(8888-1234)");
    expect(txt).toContain("(Página 1 de 1)");
    const xref = Number(/startxref\n(\d+)/.exec(txt)![1]);
    expect(txt.slice(xref, xref + 4)).toBe("xref");
  });

  it("el CSV no deja fórmulas ejecutables (= + - @)", () => {
    const csv = new TextDecoder().decode(csvCliente(exportacion({ nombre: '=HYPERLINK("http://x","clic")', notas: "@SUM(A1)", correo: "+1" })));
    expect(csv).not.toMatch(/(^|,)[=+@-]/m);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""clic"")"`);
    expect(csv).toContain("'@SUM(A1)");
  });
});

describe("aviso de privacidad", () => {
  it("la migración trae un texto base completo", () => {
    const n = sqlite.prepare("SELECT aviso_privacidad_texto AS t, aviso_privacidad_version AS v FROM negocio").get() as { t: string; v: string };
    for (const frase of ["nombre y teléfono", "apartados", "No los compartimos con terceros", "en el equipo de este negocio", "ver, corregir o eliminar"])
      expect(n.t).toContain(frase);
    expect(n.v).toBe("1");
  });
});

describe("nube: nunca clientes ni datos personales", () => {
  it("la lista blanca no incluye tablas prohibidas ni columnas personales", () => {
    for (const t of TABLAS_PROHIBIDAS) expect(NUBE_LISTA_BLANCA).not.toHaveProperty(t);
    for (const cols of Object.values(NUBE_LISTA_BLANCA)) for (const c of COLUMNAS_PERSONALES) expect(cols).not.toContain(c);
    expect(() => filaParaNube("clientes", { id: "x", nombre: "Ana" })).toThrow();
  });

  it("cada tabla y columna de la lista blanca existe en el esquema", async () => {
    for (const [t, cols] of Object.entries(NUBE_LISTA_BLANCA)) {
      const reales = (sqlite.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
      expect(reales.length, t).toBeGreaterThan(0);
      for (const c of cols) expect(reales, `${t}.${c}`).toContain(c);
    }
  });

  it("los cambios a subir nunca traen clientes, aunque haya clientes y ventas con cliente", async () => {
    const c = { id: "CLI-ANA" };
    sqlite
      .prepare("INSERT INTO clientes (id, nombre, nombre_busqueda, telefono, cedula, correo, notas, consentimiento_datos) VALUES (?, ?, 'ana', ?, ?, ?, ?, 1)")
      .run(c.id, ANA.nombre, ANA.telefono, ANA.cedula, ANA.correo, ANA.notas);
    historial(c.id);
    const cambios = await cambiosParaNube("2000-01-01");
    expect(Object.keys(cambios)).not.toContain("clientes");
    expect(cambios.ventas).toHaveLength(1);
    expect(cambios.ventas[0]).not.toHaveProperty("cliente_id");
    const texto = JSON.stringify(cambios);
    for (const p of [...PERSONALES, c.id]) expect(texto).not.toContain(p);
  });
});

describe("respaldo", () => {
  it("sin contraseña (o corta, o distinta) no se genera", async () => {
    const invocar = vi.fn(async () => "C:/x.posbak");
    await expect(crearRespaldo("", "", invocar)).rejects.toThrow("al menos 8");
    await expect(crearRespaldo("1234567", "1234567", invocar)).rejects.toThrow("al menos 8");
    await expect(crearRespaldo("contrasena-1", "contrasena-2", invocar)).rejects.toThrow("no coinciden");
    expect(invocar).not.toHaveBeenCalled();
    await expect(crearRespaldo("contrasena-1", "contrasena-1", invocar)).resolves.toBe("C:/x.posbak");
    expect(invocar).toHaveBeenCalledWith("respaldo_crear", { contrasena: "contrasena-1" });
  });
});

describe("IVA informativo", () => {
  it("IVA incluido en el precio, exento = 0", () => {
    expect(ivaIncluido(11300, 13)).toBe(1300);
    expect(ivaIncluido(1040, 4)).toBe(40);
    expect(ivaIncluido(1000, 13, true)).toBe(0);
    expect(ivaTotal([{ total: 11300, tasaIva: 13 }, { total: 500, tasaIva: 13, exento: true }])).toBe(1300);
  });
});
