import { beforeEach, describe, expect, it } from "vitest";
import { listarBitacora } from "../src/db/bitacora";
import { db } from "../src/db/conexion";
import { aplicarImportacion, productosParaImportar } from "../src/db/importacion";
import { buscarProductos, crearProducto, eliminarProducto } from "../src/db/productos";
import { detectarSeparador, leerCsv } from "../src/lib/csv";
import { categoriasSinMapear, crearPlan, leerPrecio } from "../src/lib/importar/plan";
import { leerCsvWeb } from "../src/lib/importar/web";
import type { Actor } from "../src/tipos";
import { baseDePrueba } from "./driverNode";

const OTROS = "00000000000000000000000D12";
const PAPELERIA = "00000000000000000000000D03";
const DUENO: Actor = { id: "D", rol: "dueno" };

describe("lector CSV", () => {
  it("detecta coma o punto y coma", () => {
    expect(detectarSeparador("id,nombre,precio")).toBe(",");
    expect(detectarSeparador("id;nombre;precio")).toBe(";");
    expect(detectarSeparador('"a,b";c;d')).toBe(";");
  });

  it("quita el BOM, respeta comillas, comillas dobles, saltos dentro de comillas y CRLF", () => {
    const t = '﻿id;nombre\r\n1;"Lápiz ""HB""; negro"\r\n2;"Dos\nlíneas"\r\n\r\n';
    expect(leerCsv(t).filas).toEqual([
      ["id", "nombre"],
      ["1", 'Lápiz "HB"; negro'],
      ["2", "Dos\nlíneas"],
    ]);
  });

  it("última línea sin salto", () => {
    expect(leerCsv("a,b\n1,2").filas).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("CSV de la web", () => {
  it("acepta encabezados con tildes/mayúsculas en cualquier orden", () => {
    const f = leerCsvWeb("Precio,ID,Categoría,Nombre\n1500,w1,Cuadernos,Cuaderno");
    expect(f.filas).toEqual([{ fila: 2, webId: "w1", nombre: "Cuaderno", precio: "1500", categoria: "Cuadernos" }]);
  });

  it("avisa si faltan columnas", () => {
    expect(() => leerCsvWeb("id,nombre\n1,x")).toThrow("Faltan columnas: precio, categoria");
  });
});

describe("precio", () => {
  it.each([
    ["1500", 1500],
    ["1500.00", 1500],
    ["1500,50", 1501],
    ["1.500", 1500],
    ["12.500,00", 12500],
    ["¢ 2 000", 2000],
    ["abc", null],
    ["-5", null],
    ["", null],
  ])("%s → %s", (s, n) => expect(leerPrecio(s)).toBe(n));
});

describe("plan de importación", () => {
  const csv = [
    "id,nombre,precio,categoria",
    "1,Cuaderno cosido,1250,Cuadernos",
    "2,Lápiz HB,350,Escritura",
    "3,,100,Cuadernos",
    "4,Borrador,,Escritura",
    "5,Regla,diez,Escritura",
    "6,LAPIZ hb,400,Escritura",
    "1,Otro,1,Cuadernos",
  ].join("\n");

  it("cuenta nuevos y errores, con duplicados por nombre normalizado e id", () => {
    const fuente = leerCsvWeb(csv);
    const plan = crearPlan(fuente, [], { Cuadernos: PAPELERIA }, OTROS);
    expect(plan.total).toBe(7);
    expect(plan.nuevos.map((n) => [n.nombre, n.departamentoId])).toEqual([
      ["Cuaderno cosido", PAPELERIA],
      ["Lápiz HB", OTROS],
    ]);
    expect(plan.errores.map((e) => [e.fila, e.mensaje])).toEqual([
      [4, "Nombre vacío"],
      [5, "Precio vacío"],
      [6, 'Precio no numérico: "diez"'],
      [7, "Nombre repetido (igual que la fila 3)"],
      [8, "Id repetido (igual que la fila 2)"],
    ]);
    expect(categoriasSinMapear(fuente, { Cuadernos: PAPELERIA })).toEqual(["Escritura"]);
  });

  it("separa actualizar, sin cambios, eliminados y homónimos", () => {
    const fuente = leerCsvWeb("id,nombre,precio,categoria\nA,Uno,100,x\nB,Dos nuevo,250,x\nC,Tres,1,x\nD,Manual,5,x");
    const plan = crearPlan(
      fuente,
      [
        { id: "p1", webId: "A", nombre: "Uno", precio: 100, eliminado: false },
        { id: "p2", webId: "B", nombre: "Dos", precio: 200, eliminado: false },
        { id: "p3", webId: "C", nombre: "Tres", precio: 1, eliminado: true },
        { id: "p4", webId: null, nombre: "manual", precio: 5, eliminado: false },
      ],
      {},
      OTROS,
    );
    expect(plan.sinCambios).toBe(1);
    expect(plan.actualizar).toMatchObject([{ productoId: "p2", nombre: "Dos nuevo", precio: 250, antes: { nombre: "Dos", precio: 200 } }]);
    expect(plan.omitidos).toHaveLength(1);
    expect(plan.errores[0].mensaje).toContain("Ya existe otro producto");
    expect(plan.nuevos).toHaveLength(0);
  });
});

describe("aplicar importación", () => {
  beforeEach(async () => {
    const { driver } = baseDePrueba();
    await driver.execute("INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES ('D', 'Dueño', 'dueno', 'x')");
  });

  async function importar(csv: string) {
    const plan = crearPlan(leerCsvWeb(csv), await productosParaImportar(), {}, OTROS);
    return { plan, r: await aplicarImportacion(DUENO, plan) };
  }

  it("se puede repetir sin duplicar y actualiza nombre y precio", async () => {
    const csv = "id;nombre;precio;categoria\n10;Goma;300;x\n11;Tijera;900;x";
    expect((await importar(csv)).r).toEqual({ creados: 2, actualizados: 0 });
    expect((await importar(csv)).plan.sinCambios).toBe(2);
    const { r } = await importar("id;nombre;precio;categoria\n10;Goma blanca;350;x\n11;Tijera;900;x");
    expect(r).toEqual({ creados: 0, actualizados: 1 });
    const { filas, total } = await buscarProductos();
    expect(total).toBe(2);
    expect(filas.find((p) => p.webId === "10")).toMatchObject({ nombre: "Goma blanca", precio: 350 });
    const imp = (await listarBitacora()).filter((e) => e.accion === "importacion");
    expect(imp).toHaveLength(3);
    expect(imp[0].detalle).toMatchObject({ actualizados: 1, cambiosPrecio: [{ antes: 300, despues: 350 }] });
  });

  it("no resucita lo eliminado", async () => {
    await importar("id,nombre,precio,categoria\n1,Uno,1,x");
    const [p] = (await buscarProductos()).filas;
    await eliminarProducto(DUENO, p.id);
    const { plan } = await importar("id,nombre,precio,categoria\n1,Uno,1,x");
    expect(plan.omitidos).toHaveLength(1);
    expect((await buscarProductos()).total).toBe(0);
  });

  it("es una transacción: si algo falla no entra nada", async () => {
    const plan = crearPlan(leerCsvWeb("id,nombre,precio,categoria\n1,Uno,1,x\n2,Dos,2,x"), [], {}, "DEPARTAMENTO-INEXISTENTE");
    await expect(aplicarImportacion(DUENO, plan)).rejects.toThrow();
    expect((await db().select("SELECT COUNT(*) AS n FROM productos"))[0].n).toBe(0);
    expect(await listarBitacora()).toHaveLength(0);
  });

  it("escala a varios miles de filas", async () => {
    const filas = Array.from({ length: 5000 }, (_, i) => `${i},Producto ${i},${100 + i},Cat ${i % 7}`);
    const t0 = performance.now();
    const { r } = await importar(["id,nombre,precio,categoria", ...filas].join("\n"));
    expect(r.creados).toBe(5000);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect((await buscarProductos({ texto: "producto 4999" })).total).toBe(1);
  });

  it("detecta homónimo con un producto creado a mano", async () => {
    await crearProducto(DUENO, { nombre: "Cartulina", departamentoId: OTROS, precio: 200 });
    const { plan } = await importar("id,nombre,precio,categoria\n9,CARTULINA,250,x");
    expect(plan.errores).toHaveLength(1);
  });
});
