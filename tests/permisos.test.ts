// Permisos en la pantalla (solo muestra; decide Rust). Pruebas espejo con Rust (tests/casos/permisos.json):
// tope de descuento y minutos de bloqueo calculados igual; cada acción que la pantalla nombra existe
// en el catálogo de Rust; frases simples de cada política; el pedido de PIN o motivo se entiende.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { leerPedido } from "../src/lib/invocar";
import { estado, establecerPermisos, puede, topeDescuento } from "../src/lib/permisos";
import { cambios, describir, describirInactividad, lineasTabla, minutosDe, opcionAnulacion } from "../src/lib/seguridad";
import type { Politica } from "../src/generados/Politica";
import type { Datos } from "../src/generados/Datos";
import { CASOS, comoRol } from "./permisosNormal";

const SIN: Politica["limites"] = { montoMax: null, pctMax: null, cantidadTurno: null, soloTurnoAbierto: false, ventanaMin: null, alPasar: "pin" };

describe("espejo con Rust", () => {
  it("tope de descuento", () => {
    for (const c of CASOS.topes) expect(topeDescuento(c.politica), JSON.stringify(c.politica)).toEqual({ pct: c.pct, bloquear: c.bloquear });
  });
  it("minutos de bloqueo por rol (técnico, como máximo 15)", () => {
    for (const c of CASOS.inactividad) for (const rol of ["cajero", "dueno", "tecnico"] as const) expect(minutosDe(c.inactividad, rol)).toBe(c[rol]);
  });
  it("cada acción que nombra la pantalla existe en el catálogo de Rust", () => {
    const raiz = fileURLToPath(new URL("../src/", import.meta.url));
    const archivos: string[] = [];
    const recorrer = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) recorrer(p);
        else if (/\.tsx?$/.test(n)) archivos.push(p);
      }
    };
    recorrer(raiz);
    const malas: string[] = [];
    for (const f of archivos) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/puede\((?:[^,()]*,\s*)?"([a-z_.]+)"\)|politicaDe\("([a-z_.]+)"\)|permisos?: \[([^\]]*)\]|permiso: "([a-z_.]+)"/g)) {
        const ids = m[3] ? [...m[3].matchAll(/"([a-z_.]+)"/g)].map((x) => x[1]) : [m[1] ?? m[2] ?? m[4]];
        for (const id of ids) if (!CASOS.catalogo.includes(id)) malas.push(`${f.slice(raiz.length)}: ${id}`);
      }
    }
    expect(malas).toEqual([]);
  });
  it("cada operación de catálogo (sentencias.json) apunta a una acción que existe", () => {
    const ops = JSON.parse(readFileSync(fileURLToPath(new URL("../src/db/sentencias.json", import.meta.url)), "utf8")) as Record<string, { permiso?: string }>;
    for (const [id, o] of Object.entries(ops)) if (!id.startsWith("_")) expect(CASOS.catalogo, id).toContain(o.permiso);
  });
});

describe("lo que se muestra", () => {
  it("con la Normal, el cajero vende pero no anula ni ve reportes; el técnico no ve clientes", () => {
    comoRol("cajero");
    expect(puede("cajero", "venta.vender")).toBe(true);
    expect(puede("cajero", "ventas.anular")).toBe(false);
    expect(puede("cajero", "reportes.ver")).toBe(false);
    comoRol("tecnico");
    expect(puede("tecnico", "clientes.ver_todos")).toBe(false);
    expect(puede("tecnico", "config.tecnica")).toBe(true);
    comoRol("dueno");
    expect(puede("dueno", "ventas.anular")).toBe(true);
    // Lo que Rust no mandó, no se muestra (acción nueva).
    expect(puede("dueno", "accion.nueva")).toBe(false);
  });
  it("estado de cada nivel", () => {
    expect(estado(undefined)).toBe("oculto");
    expect(estado({ nivel: "no", motivo: false, limites: SIN })).toBe("oculto");
    expect(estado({ nivel: "si", motivo: false, limites: SIN })).toBe("libre");
    expect(estado({ nivel: "motivo", motivo: true, limites: SIN })).toBe("motivo");
    expect(estado({ nivel: "pin", motivo: true, limites: SIN })).toBe("pin");
    establecerPermisos({ "ventas.anular": { nivel: "pin", motivo: true, limites: SIN } });
    expect(puede("cajero", "ventas.anular")).toBe(true);
  });
});

describe("frases simples", () => {
  const c: Politica = { nivel: "motivo", motivo: true, limites: { montoMax: 10000, pctMax: null, cantidadTurno: 3, soloTurnoAbierto: true, ventanaMin: 30, alPasar: "pin" } };
  it("cada política en palabras", () => {
    expect(describir("cajero", "Anular una venta", c)).toBe(
      "El cajero podrá anular una venta de hasta ¢10.000, 3 por turno, solo en el turno abierto, dentro de 30 minutos sin PIN, con motivo; si pasa, pedirá el PIN del dueño.",
    );
    expect(describir("cajero", "Anular una venta", { ...c, limites: { ...c.limites, alPasar: "bloquear" } })).toContain("si pasa, no se podrá");
    expect(describir("cajero", "Anular una venta", { nivel: "pin", motivo: true, limites: SIN })).toBe("El cajero podrá anular una venta con el PIN del dueño y un motivo.");
    expect(describir("cajero", "Anular una venta", undefined)).toBe("El cajero no podrá anular una venta.");
    expect(describir("Fabricio", "Anular una venta", { nivel: "si", motivo: false, limites: SIN })).toBe("Fabricio podrá anular una venta.");
    expect(describir("cajero", "Salida de efectivo", { nivel: "si", motivo: false, limites: { ...SIN, montoMax: 20000 } })).toBe("El cajero podrá usar «Salida de efectivo» de hasta ¢20.000 sin PIN; si pasa, pedirá el PIN del dueño.");
    expect(describirInactividad(10)).toBe("Si nadie toca la caja por 10 minutos, se pide el PIN otra vez.");
    expect(describirInactividad(1)).toContain("1 minuto,");
  });
  it("opción de anulación y lista de cambios", () => {
    expect(opcionAnulacion(undefined)).toBe("A");
    expect(opcionAnulacion({ nivel: "pin", motivo: true, limites: SIN })).toBe("B");
    expect(opcionAnulacion(c)).toBe("C");
    const base = { cajero: {}, tecnico: {}, usuarios: {}, motivosAnulacion: ["Otro"], umbralAvisoAnulaciones: 3, comprobanteAnulacionAb: false, verTotalesConfirmado: false, inactividad: { general: 10, cajero: null, dueno: null, tecnico: null } } as Datos;
    const nuevo: Datos = { ...base, cajero: { "ventas.anular": c }, inactividad: { ...base.inactividad, general: 5 } };
    const cat = [{ id: "ventas.anular", area: "Ventas", nombre: "Anular una venta", sensible: true, protegida: true, noDelegable: false, limites: 29, dueno: c, duenoSigueCajero: false, normalCajero: c, normalTecnico: c }];
    const l = cambios(base, nuevo, cat);
    expect(l[0]).toMatch(/^El cajero podrá anular una venta de hasta ¢10\.000/);
    expect(l).toContain("El cajero: se bloquea a los 5 min (antes 10).");
    expect(l).toContain("El técnico: se bloquea a los 5 min (antes 10).");
    // La tabla para firmar lleva la versión, los límites y la línea de firma.
    const t = lineasTabla(nuevo, 7, cat, []).map((x) => x.texto).join("\n");
    expect(t).toContain("Versión 7");
    expect(t).toContain("de hasta ¢10.000");
    expect(t).toContain("Firma del dueño");
  });
});

describe("pedido de PIN o motivo", () => {
  it("se entiende lo que manda Rust", () => {
    expect(leerPedido("NECESITA_PIN:ventas.anular:pasa de ¢10.000")).toEqual({ accion: "ventas.anular", tipo: "pin", por: "pasa de ¢10.000" });
    expect(leerPedido("NECESITA_MOTIVO:venta.descartar_espera")).toEqual({ accion: "venta.descartar_espera", tipo: "motivo", por: "" });
    expect(leerPedido("No tiene permiso para anular ventas")).toBeNull();
  });
});
