import { beforeEach, describe, expect, it, vi } from "vitest";
import { listarBitacora } from "../src/db/bitacora";
import { CAJA_1, SUCURSAL_PRINCIPAL } from "../src/db/cajas";
import {
  anonimizarCliente,
  buscarClientesBasico,
  crearCliente,
  datosParaExportar,
  editarCliente,
  listarClientes,
  NOMBRE_ANONIMO,
  obtenerCliente,
  sugerenciasRetencion,
} from "../src/db/clientes";
import { db } from "../src/db/conexion";
import { guardarNegocio, obtenerNegocio } from "../src/db/negocio";
import { cambiosParaNube, COLUMNAS_PERSONALES, filaParaNube, NUBE_LISTA_BLANCA, TABLAS_PROHIBIDAS } from "../src/db/sincronizacion";
import { crearUsuario, crearTecnicoInicial, usarHasher } from "../src/db/usuarios";
import { csvCliente, pdfCliente } from "../src/lib/exportarCliente";
import { ivaIncluido, ivaTotal } from "../src/lib/iva";
import { crearRespaldo } from "../src/lib/respaldoApi";
import type { Actor } from "../src/tipos";
import { baseDePrueba } from "./driverNode";

usarHasher({ hash: async (p) => "h:" + p, verificar: async (p, h) => h === "h:" + p });

const ANA = { nombre: "Ana Quesada Mora", telefono: "8888-1234", cedula: "112340567", correo: "ana@correo.cr", notas: "Prefiere WhatsApp" };
const PERSONALES = [ANA.nombre, "8888-1234", "88881234", ANA.cedula, ANA.correo, ANA.notas];

let tec: Actor, dueno: Actor, cajero: Actor;
beforeEach(async () => {
  baseDePrueba();
  const t = await crearTecnicoInicial("9999");
  tec = { id: t.id, rol: "tecnico" };
  const d = await crearUsuario(tec, { nombre: "Dueña", rol: "dueno", pin: "1111" });
  dueno = { id: d.id, rol: "dueno" };
  const c = await crearUsuario(tec, { nombre: "Cajero", rol: "cajero", pin: "2222" });
  cajero = { id: c.id, rol: "cajero" };
});

/** Todo el texto de toda la base (para buscar rastros de datos personales). */
async function volcadoCompleto(): Promise<string> {
  const tablas = await db().select("SELECT name FROM sqlite_master WHERE type = 'table'");
  let txt = "";
  for (const t of tablas) txt += JSON.stringify(await db().select(`SELECT * FROM "${t.name}"`));
  return txt;
}

/** Venta y apartado (ya pagado) del cliente, insertados directo: la lógica de venta es de la fase 2. */
async function historial(clienteId: string, saldo = 0) {
  await db().lote([
    {
      sql: `INSERT INTO ventas (id, sucursal_id, caja_id, consecutivo, numero, fecha, usuario_id, cliente_id, subtotal, total, iva_total)
            VALUES ('V1', ?, ?, 67791, '67791', '2026-01-10T10:00:00Z', ?, ?, 11300, 11300, 1300)`,
      params: [SUCURSAL_PRINCIPAL, CAJA_1, cajero.id, clienteId],
    },
    {
      sql: `INSERT INTO venta_lineas (id, venta_id, descripcion, departamento_id, cantidad, precio_unitario, total, tasa_iva, iva)
            VALUES ('L1', 'V1', 'Cuaderno', '00000000000000000000000D01', 1, 11300, 11300, 13, 1300)`,
    },
    {
      sql: `INSERT INTO cuentas (id, sucursal_id, caja_id, tipo, cliente_id, usuario_id, fecha, total, saldo, estado, notas)
            VALUES ('K1', ?, ?, 'apartado', ?, ?, '2026-01-05T10:00:00Z', 5000, ?, ?, 'Ana pasa el viernes')`,
      params: [SUCURSAL_PRINCIPAL, CAJA_1, clienteId, cajero.id, saldo, saldo ? "abierta" : "pagada"],
    },
  ]);
}

describe("consentimiento y minimización", () => {
  it("no se guarda un cliente sin consentimiento", async () => {
    await expect(crearCliente(cajero, ANA, false, "1")).rejects.toThrow("consentimiento");
    expect((await db().select("SELECT COUNT(*) AS n FROM clientes"))[0].n).toBe(0);
  });

  it("solo nombre y teléfono son obligatorios; guarda fecha y versión del aviso", async () => {
    await expect(crearCliente(cajero, { nombre: "Ana", telefono: "" }, true, "1")).rejects.toThrow("teléfono");
    // Para factura alcanza con la cédula.
    await expect(crearCliente(cajero, { nombre: "Ana", telefono: "", cedula: "112340567" }, true, "1")).resolves.toMatchObject({ telefono: null });
    const c = await crearCliente(cajero, { nombre: "Ana", telefono: "8888-1234" }, true, "3");
    const f = (await db().select("SELECT * FROM clientes WHERE id = ?", [c.id]))[0];
    expect(f).toMatchObject({ consentimiento_datos: 1, consentimiento_version: "3", cedula: null, correo: null, notas: null });
    expect(f.consentimiento_fecha).toBeTruthy();
  });
});

describe("permisos", () => {
  it("el cajero busca por nombre, teléfono o cédula y ve solo nombre, teléfono y cédula", async () => {
    await crearCliente(cajero, ANA, true, "1");
    const esperado = [{ id: expect.any(String), nombre: ANA.nombre, telefono: ANA.telefono, cedula: ANA.cedula }];
    expect(await buscarClientesBasico(cajero, "8888 12")).toEqual(esperado);
    expect(await buscarClientesBasico(cajero, "1-1234-0567")).toEqual(esperado);
  });

  it("el cajero no lista, no ve el detalle, no exporta ni anonimiza", async () => {
    const c = await crearCliente(cajero, ANA, true, "1");
    await expect(listarClientes(cajero)).rejects.toThrow("permiso");
    await expect(obtenerCliente(cajero, c.id)).rejects.toThrow("permiso");
    await expect(datosParaExportar(cajero, c.id, "csv")).rejects.toThrow("permiso");
    await expect(anonimizarCliente(cajero, c.id, "2222", "solicitud_titular")).rejects.toThrow("permiso");
    await expect(editarCliente(cajero, c.id, ANA)).rejects.toThrow("permiso");
  });

  it("el técnico no tiene acceso a datos de clientes", async () => {
    await crearCliente(cajero, ANA, true, "1");
    await expect(buscarClientesBasico(tec, "ana")).rejects.toThrow("permiso");
    await expect(listarClientes(tec)).rejects.toThrow("permiso");
    await expect(crearCliente(tec, ANA, true, "1")).rejects.toThrow("permiso");
  });
});

describe("bitácora sin datos personales", () => {
  it("crear, listar, ver, rectificar y exportar quedan registrados sin los datos", async () => {
    const c = await crearCliente(cajero, ANA, true, "1");
    await listarClientes(dueno, { texto: "ana" });
    await obtenerCliente(dueno, c.id);
    await editarCliente(dueno, c.id, { ...ANA, telefono: "8888-9999" });
    await datosParaExportar(dueno, c.id, "pdf");
    const b = await listarBitacora();
    expect(b.map((e) => e.accion).reverse().filter((a) => a.startsWith("cliente"))).toEqual([
      "cliente.crear",
      "cliente.listar",
      "cliente.ver",
      "cliente.editar",
      "cliente.exportar",
    ]);
    expect(b.find((e) => e.accion === "cliente.editar")?.detalle).toEqual({ campos: ["telefono"] });
    const texto = JSON.stringify(await db().select("SELECT * FROM bitacora"));
    for (const p of [...PERSONALES, "8888-9999", "ana"]) expect(texto).not.toContain(p);
  });
});

describe("anonimización", () => {
  it("exige PIN del dueño y bloquea si hay saldo pendiente", async () => {
    const c = await crearCliente(cajero, ANA, true, "1");
    await historial(c.id, 2500);
    await expect(anonimizarCliente(dueno, c.id, "0000", "solicitud_titular")).rejects.toThrow("PIN incorrecto");
    await expect(anonimizarCliente(dueno, c.id, "1111", "solicitud_titular")).rejects.toThrow("saldo pendiente");
    expect((await obtenerCliente(dueno, c.id))?.nombre).toBe(ANA.nombre);
  });

  it("deja el historial intacto y sin rastro de datos personales", async () => {
    const c = await crearCliente(cajero, ANA, true, "1");
    await historial(c.id);
    await anonimizarCliente(dueno, c.id, "1111", "solicitud_titular");

    const cli = (await db().select("SELECT * FROM clientes WHERE id = ?", [c.id]))[0];
    expect(cli).toMatchObject({ nombre: NOMBRE_ANONIMO, telefono: null, correo: null, cedula: null, notas: null });
    // Las ventas, líneas y apartados siguen con sus montos y apuntando al mismo id.
    expect((await db().select("SELECT cliente_id, total, iva_total FROM ventas"))[0]).toEqual({ cliente_id: c.id, total: 11300, iva_total: 1300 });
    expect((await db().select("SELECT total FROM venta_lineas"))[0].total).toBe(11300);
    expect((await db().select("SELECT cliente_id, total, notas FROM cuentas"))[0]).toEqual({ cliente_id: c.id, total: 5000, notas: "" });
    // Ningún dato personal en ninguna tabla (bitácora incluida).
    const todo = await volcadoCompleto();
    for (const p of [...PERSONALES, "Ana pasa"]) expect(todo).not.toContain(p);
    expect((await listarBitacora()).find((e) => e.accion === "cliente.anonimizar")?.detalle).toEqual({ motivo: "solicitud_titular" });
    // Ya no aparece en búsquedas ni se puede editar.
    expect(await buscarClientesBasico(cajero, "ana")).toEqual([]);
    await expect(editarCliente(dueno, c.id, ANA)).rejects.toThrow("anonimizado");
  });
});

describe("retención", () => {
  it("sugiere (sin anonimizar) a quien no tiene movimientos en el plazo ni saldo", async () => {
    const viejo = await crearCliente(cajero, { nombre: "Viejo", telefono: "22223333" }, true, "1");
    const conSaldo = await crearCliente(cajero, { nombre: "Debe", telefono: "22224444" }, true, "1");
    await crearCliente(cajero, { nombre: "Reciente", telefono: "22225555" }, true, "1");
    await db().execute("UPDATE clientes SET actualizado_en = '2020-01-01T00:00:00Z' WHERE id IN (?, ?)", [viejo.id, conSaldo.id]);
    await db().execute(
      `INSERT INTO cuentas (id, sucursal_id, caja_id, tipo, cliente_id, usuario_id, fecha, total, saldo)
       VALUES ('K9', ?, ?, 'apartado', ?, ?, '2020-01-01T00:00:00Z', 100, 100)`,
      [SUCURSAL_PRINCIPAL, CAJA_1, conSaldo.id, cajero.id],
    );
    const s = await sugerenciasRetencion(dueno, 36);
    expect(s.map((x) => x.nombre)).toEqual(["Viejo"]);
    expect((await db().select("SELECT nombre FROM clientes WHERE id = ?", [viejo.id]))[0].nombre).toBe("Viejo");
  });
});

describe("exportación del titular", () => {
  it("CSV con BOM y PDF válido con tildes", async () => {
    const c = await crearCliente(cajero, ANA, true, "1");
    await historial(c.id);
    const e = await datosParaExportar(dueno, c.id, "csv");
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(csvCliente(e));
    expect(csv.startsWith("\uFEFFCampo,Valor")).toBe(true);
    expect(csv).toContain("Teléfono,8888-1234");
    const pdf = pdfCliente(e, "Librería Chagui");
    const txt = new TextDecoder("latin1").decode(pdf);
    expect(txt.startsWith("%PDF-1.4")).toBe(true);
    expect(txt.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(txt).toContain("(Tel\xe9fono: 8888-1234)");
    // startxref apunta a la tabla xref.
    const xref = Number(/startxref\n(\d+)/.exec(txt)![1]);
    expect(txt.slice(xref, xref + 4)).toBe("xref");
  });
});

describe("aviso de privacidad", () => {
  it("la migración trae un texto base completo y la versión sube al cambiarlo", async () => {
    const n = await obtenerNegocio();
    for (const frase of ["nombre y teléfono", "apartados", "No los compartimos con terceros", "en el equipo de este negocio", "ver, corregir o eliminar"])
      expect(n.avisoPrivacidadTexto).toContain(frase);
    expect(n.avisoPrivacidadVersion).toBe("1");
    await guardarNegocio(dueno, { avisoPrivacidadTexto: n.avisoPrivacidadTexto + " Gracias." });
    expect((await obtenerNegocio()).avisoPrivacidadVersion).toBe("2");
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
      const reales = (await db().select(`PRAGMA table_info("${t}")`)).map((c) => c.name);
      expect(reales.length, t).toBeGreaterThan(0);
      for (const c of cols) expect(reales, `${t}.${c}`).toContain(c);
    }
  });

  it("los cambios a subir nunca traen clientes, aunque haya clientes y ventas con cliente", async () => {
    const c = await crearCliente(cajero, ANA, true, "1");
    await historial(c.id);
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
    expect(invocar).toHaveBeenCalledWith("respaldo_crear", { contrasena: "contrasena-1", marca: expect.stringMatching(/^\d{8}-\d{6}$/) });
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
