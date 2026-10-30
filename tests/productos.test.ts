import { beforeEach, describe, expect, it } from "vitest";
import { listarBitacora } from "../src/db/bitacora";
import { db } from "../src/db/conexion";
import { crearDepartamento, editarDepartamento, listarDepartamentos } from "../src/db/departamentos";
import {
  asociarCodigo,
  buscarProductos,
  CodigoOcupado,
  crearProducto,
  editarProducto,
  eliminarProducto,
  obtenerProducto,
  productoPorCodigo,
  quitarCodigo,
} from "../src/db/productos";
import type { Actor } from "../src/tipos";
import { baseDePrueba } from "./driverNode";

const DUENO: Actor = { id: "D", rol: "dueno" };
const CAJERO: Actor = { id: "C", rol: "cajero" };
const LIBRERIA = "00000000000000000000000D01";
const OFICINA = "00000000000000000000000D02";

beforeEach(async () => {
  const { driver } = baseDePrueba();
  for (const a of [DUENO, CAJERO]) await driver.execute("INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES (?, ?, ?, 'x')", [a.id, a.id, a.rol]);
});

describe("productos", () => {
  it("busca por nombre sin tildes ni mayúsculas y por código", async () => {
    await crearProducto(DUENO, { nombre: "Lápiz HB Mongol", departamentoId: OFICINA, precio: 350 }, [{ codigo: "07TOC", tipo: "manual" }]);
    await crearProducto(DUENO, { nombre: "Cuaderno cosido", departamentoId: LIBRERIA, precio: 1250 });
    expect((await buscarProductos({ texto: "LAPIZ mon" })).filas.map((p) => p.nombre)).toEqual(["Lápiz HB Mongol"]);
    expect((await buscarProductos({ texto: "07toc" })).filas[0]).toMatchObject({ nombre: "Lápiz HB Mongol", codigos: ["07TOC"], departamento: "Oficina" });
    expect((await buscarProductos({ departamentoId: LIBRERIA })).total).toBe(1);
    expect((await buscarProductos({ texto: "100%" })).total).toBe(0);
  });

  it("encuentra el código sin distinguir mayúsculas", async () => {
    const id = await crearProducto(DUENO, { nombre: "Tijera", departamentoId: OFICINA, precio: 900 }, [{ codigo: "07toc", tipo: "manual" }]);
    expect((await productoPorCodigo("07TOC"))?.id).toBe(id);
    expect(await productoPorCodigo("nada")).toBeNull();
  });

  it("un código no puede ser de dos productos: avisa y permite moverlo", async () => {
    const a = await crearProducto(DUENO, { nombre: "A", departamentoId: OFICINA, precio: 1 }, [{ codigo: "7501", tipo: "barras" }]);
    const b = await crearProducto(DUENO, { nombre: "B", departamentoId: OFICINA, precio: 1 });
    const err = await asociarCodigo(DUENO, b, "7501", "barras").catch((e) => e);
    expect(err).toBeInstanceOf(CodigoOcupado);
    expect(err.producto).toEqual({ id: a, nombre: "A" });
    await asociarCodigo(DUENO, b, "7501", "barras", { mover: true });
    expect((await productoPorCodigo("7501"))?.id).toBe(b);
    expect((await obtenerProducto(a))?.codigos).toEqual([]);
    expect((await listarBitacora())[0]).toMatchObject({ accion: "codigo.mover", entidadId: "7501" });
    // Mayúsculas distintas = mismo código.
    await expect(crearProducto(DUENO, { nombre: "C", departamentoId: OFICINA, precio: 1 }, [{ codigo: "07TOC", tipo: "manual" }])).resolves.toBeTruthy();
    await expect(asociarCodigo(DUENO, a, "07toc", "manual")).rejects.toBeInstanceOf(CodigoOcupado);
  });

  it("si crear falla por un código ocupado no queda el producto a medias", async () => {
    await crearProducto(DUENO, { nombre: "A", departamentoId: OFICINA, precio: 1 }, [{ codigo: "X1", tipo: "manual" }]);
    await expect(crearProducto(DUENO, { nombre: "B", departamentoId: OFICINA, precio: 1 }, [{ codigo: "X1", tipo: "manual" }])).rejects.toThrow();
    expect((await buscarProductos()).total).toBe(1);
  });

  it("registra el cambio de precio aparte con antes y después", async () => {
    const id = await crearProducto(DUENO, { nombre: "Goma", departamentoId: OFICINA, precio: 500 });
    await editarProducto(DUENO, id, { precio: 650, nombre: "Goma blanca" });
    const b = await listarBitacora();
    expect(b.find((e) => e.accion === "producto.precio")?.detalle).toMatchObject({ antes: 500, despues: 650 });
    expect(b.find((e) => e.accion === "producto.editar")?.detalle).toEqual({ antes: { nombre: "Goma" }, despues: { nombre: "Goma blanca" } });
  });

  it("valida precio entero y permisos", async () => {
    await expect(crearProducto(DUENO, { nombre: "X", departamentoId: OFICINA, precio: 10.5 })).rejects.toThrow("entero");
    await expect(crearProducto(CAJERO, { nombre: "X", departamentoId: OFICINA, precio: 10 })).rejects.toThrow("permiso");
  });
});

describe("borrado lógico", () => {
  it("lo eliminado no aparece en búsquedas ni por código, pero sigue en la base", async () => {
    const id = await crearProducto(DUENO, { nombre: "Borrable", departamentoId: OFICINA, precio: 1 }, [{ codigo: "B1", tipo: "manual" }]);
    await eliminarProducto(DUENO, id);
    expect((await buscarProductos({ texto: "borrable" })).total).toBe(0);
    expect((await buscarProductos({ incluirInactivos: true })).total).toBe(0);
    expect(await productoPorCodigo("B1")).toBeNull();
    expect(await obtenerProducto(id)).toBeNull();
    expect(await obtenerProducto(id, { incluirEliminados: true })).toMatchObject({ nombre: "Borrable" });
    expect((await db().select("SELECT COUNT(*) AS n FROM productos"))[0].n).toBe(1);
    // Su código queda libre para otro producto sin preguntar.
    const otro = await crearProducto(DUENO, { nombre: "Nuevo", departamentoId: OFICINA, precio: 1 }, [{ codigo: "B1", tipo: "manual" }]);
    expect((await productoPorCodigo("b1"))?.id).toBe(otro);
  });

  it("los inactivos se ocultan salvo que se pidan", async () => {
    const id = await crearProducto(DUENO, { nombre: "Inactivo", departamentoId: OFICINA, precio: 1 });
    await editarProducto(DUENO, id, { activo: false });
    expect((await buscarProductos()).total).toBe(0);
    expect((await buscarProductos({ incluirInactivos: true })).total).toBe(1);
  });

  it("quitar un código lo libera y queda en bitácora", async () => {
    const id = await crearProducto(DUENO, { nombre: "Q", departamentoId: OFICINA, precio: 1 }, [{ codigo: "Q1", tipo: "manual" }]);
    await quitarCodigo(DUENO, "Q1");
    expect((await obtenerProducto(id))?.codigos).toEqual([]);
    expect((await listarBitacora())[0].accion).toBe("codigo.quitar");
  });
});

describe("departamentos", () => {
  it("el dueño renombra pero no crea ni cambia códigos", async () => {
    await expect(crearDepartamento(DUENO, { codigo: "13", nombre: "Flores" })).rejects.toThrow("permiso");
    await expect(editarDepartamento(DUENO, OFICINA, { codigo: "99" })).rejects.toThrow("permiso");
    await editarDepartamento(DUENO, OFICINA, { nombre: "Oficina y escuela" });
    expect((await listarDepartamentos()).find((d) => d.id === OFICINA)?.nombre).toBe("Oficina y escuela");
    await expect(editarDepartamento(DUENO, OFICINA, { nombre: "librería" })).rejects.toThrow("Ya existe");
  });
});
