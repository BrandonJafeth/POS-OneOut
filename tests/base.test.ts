import { beforeEach, describe, expect, it } from "vitest";
import { bitacora } from "../src/db/bitacora";
import { obtenerCaja } from "../src/db/cajas";
import { db } from "../src/db/conexion";
import { leerConfig } from "../src/db/config";
import type { DatabaseSync } from "node:sqlite";
import { baseDePrueba, entradasBitacora } from "./driverNode";

let sqlite: DatabaseSync;
beforeEach(() => {
  sqlite = baseDePrueba({ rol: "tecnico" }).sqlite;
});

describe("migraciones", () => {
  it("siembran sucursal, caja, 12 departamentos y config", async () => {
    expect(await db().select("SELECT nombre FROM sucursales")).toEqual([{ nombre: "Principal" }]);
    expect(await obtenerCaja()).toMatchObject({ nombre: "Caja 1", prefijoTiquete: "", consecutivoSiguiente: 67791 });
    const deps = await db().select("SELECT codigo FROM departamentos ORDER BY orden");
    expect(deps.map((d) => d.codigo)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]);
    expect(await leerConfig()).toMatchObject({ usa_apartados: true, imprime_tiquete: true, caja_umbral_diferencia: 1000, pin_min_dueno: 6 });
  });

  it("crean las tablas de caja y los triggers de seguridad", () => {
    const nombres = (tipo: string) => (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(tipo) as { name: string }[]).map((t) => t.name);
    for (const t of ["ventas", "venta_pagos", "caja_turnos", "caja_movimientos", "caja_ajustes"]) expect(nombres("table")).toContain(t);
    for (const t of ["bitacora_sin_update", "bitacora_sin_delete", "bitacora_con_hash", "venta_pagos_turno_cerrado_upd", "ventas_montos_turno_cerrado"])
      expect(nombres("trigger")).toContain(t);
  });

  it("aplican claves foráneas", () => {
    expect(() => sqlite.prepare("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES ('P', 'x', 'x', 'NO-EXISTE', 1)").run()).toThrow();
  });
});

describe("la pantalla no puede pedir SQL arbitrario", () => {
  it("lectura: un solo SELECT y nunca usuarios, clientes ni bitácora", async () => {
    for (const malo of [
      "DELETE FROM productos",
      "SELECT 1; DROP TABLE ventas",
      "SELECT pin_hash FROM usuarios",
      "SELECT * FROM clientes",
      "SELECT * FROM bitacora",
      "PRAGMA key = 'x'",
      "UPDATE config SET valor = '100' WHERE clave = 'descuento_max_pct'",
    ])
      await expect(db().select(malo)).rejects.toThrow("rechazada");
  });

  it("escritura: solo operaciones del registro, con permiso", async () => {
    await expect(db().lote([{ id: "DELETE FROM ventas" }])).rejects.toThrow("desconocida");
    baseDePrueba({ rol: "cajero" });
    await expect(db().lote([{ id: "producto.crear", params: ["P1", "Lápiz", "lapiz", "00000000000000000000000D01", 350, 1, null, 13, 0, 0, "x", "x"] }])).rejects.toThrow("permiso");
  });
});

describe("bitácora", () => {
  it("se escribe con el usuario de la sesión, encadenada", async () => {
    await db().lote([bitacora("OTRO-USUARIO", "login.fallido", "usuario", "X", { intentos: 1 })]);
    const [e] = await entradasBitacora();
    expect(e).toMatchObject({ usuarioId: "U-PRUEBA", accion: "login.fallido", detalle: { intentos: 1 } });
    expect((sqlite.prepare("SELECT hash FROM bitacora").get() as { hash: string }).hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("va en el mismo lote que el cambio: si el cambio falla, no queda registro", async () => {
    await expect(db().lote([bitacora(null, "config.cambiar", "config", "x"), { id: "no.existe" }])).rejects.toThrow();
    expect(await entradasBitacora()).toHaveLength(0);
  });

  it("no se edita ni se borra, ni se inserta sin hash", () => {
    sqlite.prepare("INSERT INTO bitacora (id, fecha, accion, entidad, detalle, hash) VALUES ('B1', 'x', 'a', 'e', '{}', 'h')").run();
    expect(() => sqlite.prepare("UPDATE bitacora SET detalle = '{\"x\":1}'").run()).toThrow("no se puede modificar");
    expect(() => sqlite.prepare("DELETE FROM bitacora").run()).toThrow("no se puede borrar");
    expect(() => sqlite.prepare("INSERT INTO bitacora (id, fecha, accion, entidad, detalle) VALUES ('B2', 'x', 'a', 'e', '{}')").run()).toThrow();
  });
});
