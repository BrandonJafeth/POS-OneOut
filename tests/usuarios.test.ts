import { beforeEach, describe, expect, it } from "vitest";
import { listarBitacora } from "../src/db/bitacora";
import {
  cambiarPin,
  crearTecnicoInicial,
  crearUsuario,
  eliminarUsuario,
  iniciarSesion,
  listarUsuarios,
  tecnico,
  usarHasher,
} from "../src/db/usuarios";
import { esperaTrasFallos, esperaRestante } from "../src/lib/bloqueo";
import type { Actor } from "../src/tipos";
import { baseDePrueba } from "./driverNode";

// Hasher falso: el real (Argon2id) se prueba en Rust (src-tauri/src/pin.rs).
usarHasher({ hash: async (p) => "h:" + p, verificar: async (p, h) => h === "h:" + p });

let tec: Actor;
beforeEach(async () => {
  baseDePrueba();
  const t = await crearTecnicoInicial("9999");
  tec = { id: t.id, rol: t.rol };
});

describe("primer arranque y roles", () => {
  it("crea el técnico una sola vez", async () => {
    expect((await tecnico())?.rol).toBe("tecnico");
    await expect(crearTecnicoInicial("1111")).rejects.toThrow("ya existe");
  });

  it("el técnico no aparece en la lista normal de usuarios", async () => {
    await crearUsuario(tec, { nombre: "Ana", rol: "dueno", pin: "1234" });
    expect((await listarUsuarios()).map((u) => u.nombre)).toEqual(["Ana"]);
    expect(await listarUsuarios({ incluirTecnico: true })).toHaveLength(2);
  });

  it("el dueño solo crea cajeros", async () => {
    const d = await crearUsuario(tec, { nombre: "Ana", rol: "dueno", pin: "1234" });
    const dueno: Actor = { id: d.id, rol: "dueno" };
    await expect(crearUsuario(dueno, { nombre: "Otro", rol: "dueno", pin: "1234" })).rejects.toThrow("permiso");
    await expect(crearUsuario(dueno, { nombre: "Luis", rol: "cajero", pin: "1234" })).resolves.toMatchObject({ rol: "cajero" });
  });

  it("valida PIN y nombre repetido", async () => {
    await expect(crearUsuario(tec, { nombre: "Ana", rol: "cajero", pin: "12" })).rejects.toThrow("PIN");
    await crearUsuario(tec, { nombre: "Ana", rol: "cajero", pin: "1234" });
    await expect(crearUsuario(tec, { nombre: " ana ", rol: "cajero", pin: "1234" })).rejects.toThrow("Ya existe");
  });
});

describe("login con límite de intentos", () => {
  it("entra con el PIN correcto", async () => {
    expect(await iniciarSesion(tec.id, "9999")).toMatchObject({ ok: true });
  });

  it("registra cada fallo en bitácora y bloquea desde el 5.º", async () => {
    const t0 = Date.parse("2026-10-29T12:00:00Z");
    for (let i = 1; i <= 4; i++) expect(await iniciarSesion(tec.id, "0000", t0)).toMatchObject({ ok: false, motivo: "pin", esperaMs: 0 });
    expect(await iniciarSesion(tec.id, "0000", t0)).toMatchObject({ ok: false, motivo: "pin", esperaMs: 30_000 });
    // Bloqueado: ni el PIN correcto entra hasta que pase la espera.
    expect(await iniciarSesion(tec.id, "9999", t0 + 10_000)).toMatchObject({ ok: false, motivo: "bloqueado" });
    expect(await iniciarSesion(tec.id, "9999", t0 + 31_000)).toMatchObject({ ok: true });
    const b = await listarBitacora();
    expect(b.filter((e) => e.accion === "login.fallido")).toHaveLength(4);
    expect(b.filter((e) => e.accion === "login.bloqueado")).toHaveLength(1);
  });

  it("la espera se duplica y tiene tope", () => {
    expect([4, 5, 6, 7].map(esperaTrasFallos)).toEqual([0, 30_000, 60_000, 120_000]);
    expect(esperaTrasFallos(50)).toBe(15 * 60_000);
    expect(esperaRestante(null)).toBe(0);
  });

  it("cambiar el PIN desbloquea", async () => {
    for (let i = 0; i < 6; i++) await iniciarSesion(tec.id, "0000");
    await cambiarPin(tec, tec.id, "4321");
    expect(await iniciarSesion(tec.id, "4321")).toMatchObject({ ok: true });
  });
});

describe("borrado lógico de usuarios", () => {
  it("el eliminado no aparece ni puede entrar, pero sigue en la base", async () => {
    const c = await crearUsuario(tec, { nombre: "Luis", rol: "cajero", pin: "1234" });
    await eliminarUsuario(tec, c.id);
    expect(await listarUsuarios()).toHaveLength(0);
    expect(await iniciarSesion(c.id, "1234")).toEqual({ ok: false, motivo: "inexistente" });
    await expect(eliminarUsuario(tec, tec.id)).rejects.toThrow();
  });
});
