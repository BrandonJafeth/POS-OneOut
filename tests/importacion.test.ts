// Importador de la web: lectura de columnas, reglas (categoría y palabras), plan y consultas.
// La lectura de bytes y la escritura en la base las prueba Rust (src-tauri/src/importacion.rs).
import { beforeEach, describe, expect, it } from "vitest";
import { codigosExistentes, favoritosActuales, productosParaImportar, resumenCatalogo } from "../src/db/importacion";
import { buscarProductos, crearProducto } from "../src/db/productos";
import { celdaSegura, detectarSeparador, leerCsv } from "../src/lib/csv";
import { cambiosDePrecio, categoriasSinMapear, crearPlan, leerPrecio, type Contexto, type Opciones, type ProductoExistente } from "../src/lib/importar/plan";
import { codigoBase, codigoLibre, contienePalabra, pluralesSinRegla, porCategorias, porPalabras, REGLAS_DEFECTO, reglasValidas, sugerenciaNombre } from "../src/lib/importar/reglas";
import { leerCsvWeb } from "../src/lib/importar/web";
import { puede } from "../src/lib/permisos";
import type { Actor } from "../src/tipos";
import { baseDePrueba } from "./driverNode";

const D = (n: string) => `00000000000000000000000D${n}`;
const NOMBRES = ["Librería", "Oficina", "Papelería", "Fotografía", "Portarretratos", "Tecnología", "Fotocopias", "Bazar", "Trabajos manuales", "Cartón", "Lapicero y lápiz", "Otros"];
const DEPS = NOMBRES.map((nombre, i) => {
  const codigo = String(i + 1).padStart(2, "0");
  return { id: D(codigo), codigo, nombre, activo: true };
});
const DUENO: Actor = { id: "D", rol: "dueno" };

function ctx(existentes: ProductoExistente[] = [], extra: Partial<Contexto> = {}): Contexto {
  return { existentes, codigos: [], favoritosActuales: 0, departamentos: DEPS, departamentoDefecto: D("12"), ...extra };
}

describe("códigos internos en la importación", () => {
  it("por defecto no se genera ninguno (el código de barras se escanea después)", () => {
    const plan = crearPlan(leerCsvWeb(csvWeb()), ctx(), op());
    expect(plan.nuevos.length).toBe(719);
    expect(plan.nuevos.every((i) => i.codigo === null)).toBe(true);
    expect(plan.actualizar.every((i) => !i.cambios.includes("codigo"))).toBe(true);
  });
});

function op(extra: Partial<Opciones> = {}): Opciones {
  return { reglas: REGLAS_DEFECTO, respuestas: {}, sugerenciasAceptadas: new Set(), limitarFavoritos: true, pisar: { departamento: false, favorito: false }, ...extra };
}

const CAB = "id,slug,nombre,precio,estado,tipo,destacado,descuento_activo,precio_oferta,categorias";

/** Mismo perfil que el CSV real: 719 filas simples, 1 agotada, 281 destacadas, 40 con varias categorías. */
function csvWeb(): string {
  const cats = ["Escolar", "Arte y Manualidades", "Oficina", "Papeleria ", "Fotografia ", "Bazar", "Tecnología", "Cuadernos", "Libros ", "Figuras", "Carpetas", "sublimacion y DTF", "Agendas"];
  const filas = [CAB];
  for (let i = 0; i < 719; i++) {
    const c = i < 40 ? "Bazar | Escolar" : cats[i % cats.length];
    filas.push(`id-${i},prod-${i}," Artículo  ${i} - Marca ",${150 + i * 75},${i === 7 ? "agotado" : "disponible"},simple,${i < 281},true,null,${c}`);
  }
  return filas.join("\n");
}

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

  it("neutraliza fórmulas al exportar", () => {
    expect(celdaSegura("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(celdaSegura("+1")).toBe("'+1");
    expect(celdaSegura("-5")).toBe("'-5");
    expect(celdaSegura("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(celdaSegura("Lápiz")).toBe("Lápiz");
  });
});

describe("columnas del CSV de la web", () => {
  it("lee categorias en plural, estado, destacado, slug y limpia espacios y caracteres de control", () => {
    const f = leerCsvWeb(`${CAB}\nA1,tijera-8,"  TIjera  8""\u001b - Merletto ",2800,agotado,simple,true,true,null,Bazar | Escolar `);
    expect(f.columnas).toEqual(["slug", "estado", "tipo", "destacado", "precio_oferta"]);
    expect(f.filas[0]).toMatchObject({
      fila: 2,
      webId: "A1",
      slug: "tijera-8",
      nombre: 'TIjera 8" - Merletto',
      estado: "agotado",
      destacado: true,
      categorias: ["Bazar", "Escolar"],
    });
  });

  it("también acepta el formato viejo (categoria en singular) en cualquier orden", () => {
    const f = leerCsvWeb("Precio;ID;Categoría;Nombre\n1500;w1;Cuadernos;Cuaderno");
    expect(f.filas[0]).toMatchObject({ webId: "w1", nombre: "Cuaderno", precio: "1500", categorias: ["Cuadernos"], destacado: false });
  });

  it("avisa si faltan columnas", () => {
    expect(() => leerCsvWeb("id,nombre\n1,x")).toThrow("Faltan columnas: precio, categorias");
  });
});

describe("precio", () => {
  it.each([
    ["1500", 1500],
    ["1500.00", 1500],
    ["1500,50", 1501],
    ["1.500", 1500],
    ["54.000", 54000],
    ["¢ 2 000", 2000],
    ["abc", null],
    ["-5", null],
    ["", null],
  ])("%s → %s", (s, n) => expect(leerPrecio(s)).toBe(n));
});

describe("reglas", () => {
  it("varias categorías: gana la de más prioridad, sin importar espacios, tildes ni mayúsculas", () => {
    const r = REGLAS_DEFECTO.categorias;
    expect(porCategorias(["Bazar", "Escolar"], r)?.departamentoId).toBe(D("01"));
    expect(porCategorias(["Bazar", "Oficina"], r)?.departamentoId).toBe(D("02"));
    expect(porCategorias(["Fotografia "], r)?.departamentoId).toBe(D("04"));
    expect(porCategorias(["tecnologia"], r)?.departamentoId).toBe(D("06"));
    expect(porCategorias(["Desconocida"], r)).toBeNull();
  });

  it("palabras completas: «marcador» no es «marco», «portaminas» sí, «porta retrato» es frase", () => {
    expect(contienePalabra("Marcador doble punta", "marco")).toBe(false);
    expect(contienePalabra("Marco de madera", "marco")).toBe(true);
    expect(contienePalabra("Lápiz HB", "lapiz")).toBe(true);
    expect(contienePalabra("Lapicero azul", "lapiz")).toBe(false);
    expect(contienePalabra("Porta Retrato 4x6", "porta retrato")).toBe(true);
    expect(contienePalabra("Portada", "porta retrato")).toBe(false);
    expect(porPalabras("Cartulina de colores", REGLAS_DEFECTO.palabras)).toEqual({ indice: 2, palabra: "cartulina" });
    expect(porPalabras("Marcador permanente", REGLAS_DEFECTO.palabras)).toEqual({ indice: 3, palabra: "marcador" });
  });

  it("código interno: departamento + 3 letras, con número si choca", () => {
    expect(codigoBase("07", "Tóner HP")).toBe("07ton");
    expect(codigoBase("01", "12 Crayones")).toBe("01cra");
    expect(codigoBase("12", "A4")).toBe("12a4x");
    const usados = new Set(["05por"]);
    expect([codigoLibre("05por", usados), codigoLibre("05por", usados), codigoLibre("01cua", usados)]).toEqual(["05por2", "05por3", "01cua"]);
  });

  it("sugiere solo mayúsculas evidentes", () => {
    expect(sugerenciaNombre('TIjera 8" - Merletto')).toBe('Tijera 8" - Merletto');
    expect(sugerenciaNombre("Papel DTF A4 USB")).toBeNull();
    expect(sugerenciaNombre("Cuaderno Scribe")).toBeNull();
  });

  it("muestra plurales que la regla no toma", () => {
    const p = pluralesSinRegla(["12 Lapices de colores", "Lapiceros Bic", "Lápiz HB", "Porta Retratos 5x7"], REGLAS_DEFECTO.palabras);
    expect(p).toEqual([
      { indice: 0, forma: "lapiceros", productos: 1 },
      { indice: 0, forma: "lapices", productos: 1 },
      { indice: 1, forma: "porta retratos", productos: 1 },
    ]);
  });

  it("completa una configuración vieja o rota", () => {
    expect(reglasValidas(null)).toEqual(REGLAS_DEFECTO);
    expect(reglasValidas({ favoritosMax: 10 }).favoritosMax).toBe(10);
  });
});

describe("plan de importación", () => {
  it("el CSV completo: 719 a crear, 718 activos, 1 inactivo, códigos únicos, 40 favoritos", () => {
    const plan = crearPlan(leerCsvWeb(csvWeb()), ctx(), op({ codigosInternos: true }));
    expect(plan.total).toBe(719);
    expect(plan.nuevos).toHaveLength(719);
    expect(plan.errores).toEqual([]);
    expect(plan.avisos).toEqual([]); // "null" en precio_oferta no es una oferta
    expect(plan.nuevos.filter((i) => i.activo)).toHaveLength(718);
    expect(plan.nuevos.find((i) => !i.activo)?.webId).toBe("id-7");
    const codigos = plan.nuevos.map((i) => i.codigo);
    expect(new Set(codigos).size).toBe(719);
    expect(codigos.every((c) => /^\d{2}[a-z0-9]{3}\d*$/.test(c!))).toBe(true);
    expect(plan.favoritos).toEqual({ destacados: 281, marcados: 40, cupo: 40 });
    // Varias categorías ("Bazar | Escolar") → Librería por prioridad.
    expect(plan.nuevos.filter((i) => i.categorias.length > 1).every((i) => i.departamentoId === D("01"))).toBe(true);
    // Nadie cae en Fotocopias.
    expect(plan.porDepartamento.find((c) => c.departamentoId === D("07"))).toBeUndefined();
    expect(plan.nuevos[0].nombre).toBe("Artículo 0 - Marca");
  });

  it("palabras sobrescriben la categoría; «marcador» espera la respuesta del dueño", () => {
    const csv = [
      CAB,
      "1,a,Lapicero azul,300,disponible,simple,false,true,,Escolar",
      "2,b,Marcador doble punta,900,disponible,simple,false,true,,Escolar",
      "3,c,Marco madera,2500,disponible,simple,false,true,,Bazar",
      "4,d,Cartulina,150,disponible,simple,false,true,,Papeleria",
      "5,e,Cosa rara,100,disponible,simple,false,true,,",
      "6,f,Taza,1000,disponible,simple,false,true,1500,Nueva",
    ].join("\n");
    const fuente = leerCsvWeb(csv);
    let plan = crearPlan(fuente, ctx(), op());
    const dep = (id: string) => plan.validos.find((i) => i.webId === id)!;
    expect(dep("1")).toMatchObject({ departamentoId: D("11"), via: "regla", departamentoCategoria: D("01") });
    expect(dep("3").departamentoId).toBe(D("05"));
    expect(dep("4").departamentoId).toBe(D("10"));
    expect(dep("5")).toMatchObject({ departamentoId: D("12"), via: "defecto", revisar: true });
    expect(dep("6")).toMatchObject({ departamentoId: D("12"), revisar: true });
    expect(plan.cambiadosPorRegla.map((i) => i.webId)).toEqual(["1", "3", "4"]);
    // Marcador: no se decide solo.
    expect(dep("2").departamentoId).toBe(D("01"));
    expect(plan.pendientes).toBe(1);
    expect(plan.preguntas[0].items.map((i) => i.webId)).toEqual(["2"]);
    expect(plan.avisos).toMatchObject([{ fila: 7 }]);
    expect(categoriasSinMapear(fuente, REGLAS_DEFECTO)).toEqual(["Nueva"]);

    plan = crearPlan(fuente, ctx(), op({ respuestas: { 3: "mover" } }));
    expect(plan.pendientes).toBe(0);
    expect(plan.validos.find((i) => i.webId === "2")?.departamentoId).toBe(D("11"));
    plan = crearPlan(fuente, ctx(), op({ respuestas: { 3: "dejar" } }));
    expect(plan.validos.find((i) => i.webId === "2")?.departamentoId).toBe(D("01"));
  });

  it("valida precio, nombre, estado, tipo, id, slug y repetidos", () => {
    const csv = [
      CAB,
      "1,a,Uno,0,disponible,simple,false,true,,Escolar",
      "2,b,,100,disponible,simple,false,true,,Escolar",
      `3,c,${"x".repeat(121)},100,disponible,simple,false,true,,Escolar`,
      "4,d,Cuatro,100,vendido,simple,false,true,,Escolar",
      "5,e,Cinco,100,disponible,variable,false,true,,Escolar",
      "6 6,f,Seis,100,disponible,simple,false,true,,Escolar",
      "7,a b,Siete,100,disponible,simple,false,true,,Escolar",
      "8,h,Ocho,diez,disponible,simple,false,true,,Escolar",
      "9,i,Nueve,100,disponible,simple,false,true,,Escolar",
      "10,i,Diez,100,disponible,simple,false,true,,Escolar",
      "11,k,NUEVE,100,disponible,simple,false,true,,Escolar",
    ].join("\n");
    const plan = crearPlan(leerCsvWeb(csv), ctx(), op());
    expect(plan.errores.map((e) => [e.fila, e.mensaje])).toEqual([
      [2, "El precio debe ser mayor que cero"],
      [3, "Nombre vacío"],
      [4, "Nombre de más de 120 caracteres"],
      [5, 'Estado no admitido: "vendido"'],
      [6, 'Tipo no admitido: "variable" (solo "simple")'],
      [7, "El id tiene caracteres no válidos"],
      [8, "El slug tiene caracteres no válidos"],
      [9, 'Precio no numérico: "diez"'],
      [11, "Slug repetido (igual que la fila 10)"],
      [12, "Nombre repetido (igual que la fila 10)"],
    ]);
    expect(plan.nuevos.map((i) => i.webId)).toEqual(["9"]);
  });

  it("sugerencias de nombre solo si el dueño las acepta", () => {
    const fuente = leerCsvWeb(`${CAB}\n1,a,TIjera 8,2800,disponible,simple,false,true,,Escolar`);
    expect(crearPlan(fuente, ctx(), op()).nuevos[0]).toMatchObject({ nombre: "TIjera 8", sugerencia: "Tijera 8" });
    expect(crearPlan(fuente, ctx(), op({ sugerenciasAceptadas: new Set([2]) })).nuevos[0].nombre).toBe("Tijera 8");
  });

  it("favoritos: límite, criterio y cupo descontando los que ya hay", () => {
    const filas = ["Zeta", "Alfa", "Beta", "Gama"].map((n, i) => `${i},s${i},${n},${(4 - i) * 100},disponible,simple,true,true,,Escolar`);
    const fuente = leerCsvWeb([CAB, ...filas].join("\n"));
    const fav = (o: Partial<Opciones>, c?: Partial<Contexto>) =>
      crearPlan(fuente, ctx([], c), op(o)).nuevos.filter((i) => i.favorito).map((i) => i.nombre);
    const reglas = (criterio: "alfabetico" | "archivo" | "precio") => ({ ...REGLAS_DEFECTO, favoritosMax: 2, criterioFavoritos: criterio });
    expect(fav({ reglas: reglas("alfabetico") })).toEqual(["Alfa", "Beta"]);
    expect(fav({ reglas: reglas("archivo") })).toEqual(["Zeta", "Alfa"]);
    expect(fav({ reglas: reglas("precio") })).toEqual(["Beta", "Gama"]);
    expect(fav({ reglas: reglas("alfabetico") }, { favoritosActuales: 1 })).toEqual(["Alfa"]);
    expect(fav({ reglas: reglas("alfabetico"), limitarFavoritos: false })).toHaveLength(4);
  });

  it("reimportar: sin cambios no toca nada y no pisa departamento ni favorito del dueño", () => {
    const fuente = leerCsvWeb(`${CAB}\nw1,lapiz-hb,Lápiz HB,350,disponible,simple,true,true,,Escolar\nw2,goma,Goma,300,agotado,simple,false,true,,Escolar`);
    const base = { slug: null, activo: true, favorito: false, categoriasOrigen: "Escolar", tieneInterno: true, eliminado: false };
    const existentes: ProductoExistente[] = [
      // El dueño lo pasó a Papelería y le quitó el favorito: se respeta.
      { ...base, id: "p1", webId: "w1", slug: "lapiz-hb", nombre: "Lápiz HB", precio: 350, departamentoId: D("03") },
      { ...base, id: "p2", webId: "w2", slug: "goma", nombre: "Goma", precio: 250, departamentoId: D("01") },
    ];
    let plan = crearPlan(fuente, ctx(existentes), op());
    expect(plan.nuevos).toHaveLength(0);
    expect(plan.sinCambios).toBe(1);
    expect(plan.actualizar).toMatchObject([{ productoId: "p2", cambios: ["precio", "activo"], activo: false, codigo: null }]);
    // Pidiéndolo de forma explícita sí se reemplazan.
    plan = crearPlan(fuente, ctx(existentes), op({ pisar: { departamento: true, favorito: true } }));
    expect(plan.actualizar.find((i) => i.productoId === "p1")).toMatchObject({ departamentoId: D("11"), favorito: true, cambios: ["departamento", "favorito"] });
  });

  it("reconoce por slug si el id cambió en la web; no resucita lo eliminado; avisa homónimos", () => {
    const fuente = leerCsvWeb(`${CAB}\nNUEVO-ID,lapiz-hb,Lápiz HB,400,disponible,simple,false,true,,Escolar\nw9,borrado,Borrado,1,disponible,simple,false,true,,Escolar\nw8,x,cartulina,1,disponible,simple,false,true,,Escolar`);
    const base = { activo: true, favorito: false, categoriasOrigen: null, tieneInterno: false, departamentoId: D("01") };
    const plan = crearPlan(
      fuente,
      ctx([
        { ...base, id: "p1", webId: "VIEJO", slug: "lapiz-hb", nombre: "Lápiz HB", precio: 350, eliminado: false },
        { ...base, id: "p9", webId: "w9", slug: "borrado", nombre: "Borrado", precio: 1, eliminado: true },
        { ...base, id: "p3", webId: null, slug: null, nombre: "Cartulina", precio: 1, eliminado: false },
      ]),
      op({ codigosInternos: true }),
    );
    expect(plan.actualizar).toMatchObject([{ productoId: "p1", webId: "NUEVO-ID", codigo: "01lap" }]);
    expect(plan.actualizar[0].cambios).toEqual(["precio", "codigo", "slug", "categorias"]);
    expect(plan.omitidos).toHaveLength(1);
    expect(plan.errores[0].mensaje).toContain("Ya existe otro producto");
  });
});

describe("permisos", () => {
  it("un cajero no puede importar (ni ver Productos)", () => {
    expect(puede("cajero", "productos.importar")).toBe(false);
    expect(puede("cajero", "productos")).toBe(false);
    expect(puede("dueno", "productos.importar")).toBe(true);
    expect(puede("tecnico", "productos.importar")).toBe(true);
  });
});

describe("consultas del importador", () => {
  beforeEach(() => {
    baseDePrueba({ rol: "dueno", usuarioId: DUENO.id });
  });

  it("lee lo que el plan necesita y el resumen del catálogo (lecturas permitidas)", async () => {
    await crearProducto(DUENO, { nombre: "Cartulina", departamentoId: D("10"), precio: 200 }, [{ codigo: "7501031311309", tipo: "barras" }]);
    await crearProducto(DUENO, { nombre: "Goma", departamentoId: D("01"), precio: 100 });
    const [p] = await productosParaImportar();
    expect(p).toMatchObject({ nombre: "Cartulina", slug: null, activo: true, favorito: false, tieneInterno: false, eliminado: false });
    expect(await codigosExistentes()).toEqual(["7501031311309"]);
    expect(await favoritosActuales()).toBe(0);
    const r = await resumenCatalogo();
    expect(r).toMatchObject({ total: 2, sinBarras: 1, favoritos: 0, paraRevisar: 0, inactivos: 0 });
    expect(r.porDepartamento.find((d) => d.departamentoId === D("10"))?.total).toBe(1);
    expect(r.porDepartamento.find((d) => d.departamentoId === D("07"))?.total).toBe(0);
    expect((await buscarProductos({ sinBarras: true })).filas.map((x) => x.nombre)).toEqual(["Goma"]);
    expect((await buscarProductos({ paraRevisar: true })).total).toBe(0);
  });
});

describe("cambios de precio al importar", () => {
  const item = (precio: number, antes?: number) => ({ fila: precio, nombre: "x", precio, antes: antes == null ? undefined : { nombre: "x", precio: antes, activo: true, departamentoId: "D", favorito: false } }) as never;
  it("cuenta lo que sube y baja, y marca lo que baja a menos de la mitad", () => {
    const r = cambiosDePrecio({ actualizar: [item(1300, 1200), item(1100, 1200), item(120, 1200), item(500, 500), item(900)] });
    expect([r.suben, r.bajan, r.fuertes.map((i) => (i as { precio: number }).precio)]).toEqual([1, 2, [120]]);
  });
});
