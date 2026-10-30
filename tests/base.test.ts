import { beforeEach, describe, expect, it } from "vitest";
import { bitacora, listarBitacora, registrar } from "../src/db/bitacora";
import { CAJA_1, obtenerCaja, tomarConsecutivo } from "../src/db/cajas";
import { db } from "../src/db/conexion";
import { guardarConfig, leerConfig } from "../src/db/config";
import type { Actor } from "../src/tipos";
import { baseDePrueba } from "./driverNode";

const TECNICO: Actor = { id: "01TECNICO00000000000000000", rol: "tecnico" };

beforeEach(async () => {
  baseDePrueba();
  await db().execute("INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES (?, 'Técnico', 'tecnico', 'x')", [TECNICO.id]);
});

describe("migración inicial", () => {
  it("siembra sucursal, caja, 12 departamentos y config", async () => {
    expect(await db().select("SELECT nombre FROM sucursales")).toEqual([{ nombre: "Principal" }]);
    const caja = await obtenerCaja();
    expect(caja).toMatchObject({ nombre: "Caja 1", prefijoTiquete: "", consecutivoSiguiente: 67791 });
    const deps = await db().select("SELECT codigo FROM departamentos ORDER BY orden");
    expect(deps.map((d) => d.codigo)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]);
    const c = await leerConfig();
    expect(c).toMatchObject({
      usa_apartados: true,
      usa_credito: false,
      abono_minimo_pct: 50,
      escaner_debounce_ms: 400,
      imprime_tiquete: true,
      imprime_tiquetes_departamento: false,
    });
  });

  it("crea las tablas de fases siguientes", async () => {
    const tablas = (await db().select("SELECT name FROM sqlite_master WHERE type = 'table'")).map((t) => t.name);
    for (const t of ["formas_pago", "bancos", "clientes", "ventas", "venta_lineas", "venta_pagos", "venta_pago_correcciones", "cuentas", "cuenta_lineas", "abonos", "caja_turnos", "caja_movimientos"])
      expect(tablas).toContain(t);
  });

  it("aplica claves foráneas", async () => {
    await expect(
      db().execute("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES ('P', 'x', 'x', 'NO-EXISTE', 1)"),
    ).rejects.toThrow();
  });
});

describe("consecutivo por caja", () => {
  it("entrega números seguidos desde 67791 y avanza la caja", async () => {
    expect(await tomarConsecutivo()).toEqual({ consecutivo: 67791, numero: "67791" });
    expect(await tomarConsecutivo()).toEqual({ consecutivo: 67792, numero: "67792" });
    expect((await obtenerCaja())?.consecutivoSiguiente).toBe(67793);
  });

  it("usa el prefijo de la caja y cada caja numera aparte", async () => {
    await db().execute(
      "INSERT INTO cajas (id, sucursal_id, nombre, prefijo_tiquete, consecutivo_siguiente) VALUES ('C2', '0000000000000000000000S001', 'Caja 2', 'B-', 1)",
    );
    expect((await tomarConsecutivo("C2")).numero).toBe("B-1");
    expect((await tomarConsecutivo(CAJA_1)).numero).toBe("67791");
    expect((await tomarConsecutivo("C2")).numero).toBe("B-2");
  });

  it("falla con una caja inexistente", async () => {
    await expect(tomarConsecutivo("NO")).rejects.toThrow("Caja no encontrada");
  });
});

describe("bitácora", () => {
  it("registrar escribe usuario, acción, entidad y detalle JSON", async () => {
    await registrar(TECNICO.id, "login.fallido", "usuario", TECNICO.id, { intentos: 1 });
    const [e] = await listarBitacora();
    expect(e).toMatchObject({ usuarioId: TECNICO.id, usuario: "Técnico", accion: "login.fallido", entidad: "usuario", detalle: { intentos: 1 } });
    expect(e.id).toHaveLength(26);
  });

  it("se escribe en el mismo lote que el cambio: si el cambio falla, no queda registro", async () => {
    await expect(
      db().lote([bitacora(TECNICO.id, "config.cambiar", "config", "x"), { sql: "INSERT INTO tabla_que_no_existe VALUES (1)" }]),
    ).rejects.toThrow();
    expect(await listarBitacora()).toHaveLength(0);
  });

  it("cambiar config deja antes y después", async () => {
    await guardarConfig(TECNICO, "escaner_debounce_ms", 250);
    expect((await leerConfig()).escaner_debounce_ms).toBe(250);
    const [e] = await listarBitacora();
    expect(e).toMatchObject({ accion: "config.cambiar", entidadId: "escaner_debounce_ms", detalle: { antes: 400, despues: 250 } });
    // Guardar el mismo valor no ensucia la bitácora.
    await guardarConfig(TECNICO, "escaner_debounce_ms", 250);
    expect(await listarBitacora()).toHaveLength(1);
  });
});
