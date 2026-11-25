// Prueba de punta a punta de permisos y bloqueo (WebdriverIO + tauri-driver, la app real):
// 1) la dueña activa la opción C (anular sin PIN hasta ¢10.000) con su PIN → el cajero anula una venta
//    chica sin PIN → intenta una grande y se le pide el PIN → el Z muestra «Anulaciones por cajero sin
//    PIN» → la dueña ve el aviso al entrar.
// 2) con el bloqueo en 1 minuto: aviso antes de bloquear (una tecla lo cierra), la pantalla se bloquea,
//    se vuelve a entrar con el PIN y la venta en espera sigue ahí.
// Reloj fijo (POS_RELOJ_PRUEBA) que la prueba adelanta con prueba_avanzar_reloj (solo desarrollo + POS_E2E).
//
//   npm run e2e   (corre también apartado.e2e.mjs)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { remote } from "webdriverio";

const app = resolve("src-tauri/target/debug/pos.exe");
const driver = process.env.MSEDGEDRIVER ?? resolve("tools/msedgedriver/msedgedriver.exe");
const tauriDriver = join(homedir(), ".cargo", "bin", "tauri-driver.exe");
for (const [que, ruta] of [["app (npm run e2e:build)", app], ["msedgedriver (ver tests/e2e/LEEME.md)", driver], ["tauri-driver", tauriDriver]]) {
  if (!existsSync(ruta)) throw new Error(`Falta ${que}: ${ruta}`);
}

const datos = mkdtempSync(join(tmpdir(), "pos-e2e-"));
const env = { ...process.env, POS_DATOS: datos, POS_E2E: "1", POS_RELOJ_PRUEBA: "2026-11-18T10:00:00-06:00" };
const td = spawn(tauriDriver, ["--native-driver", driver], { env, stdio: ["ignore", "inherit", "inherit"] });
const terminado = new Promise((r) => td.once("exit", r));

async function hasta(fn, ms, que) {
  const fin = Date.now() + ms;
  for (;;) {
    const r = await fn().catch(() => false);
    if (r) return r;
    if (Date.now() > fin) throw new Error(`Se agotó el tiempo esperando ${que}`);
    await new Promise((x) => setTimeout(x, 100));
  }
}
const appViva = () =>
  execFileSync("powershell", ["-NoProfile", "-Command", `@(Get-Process pos -ErrorAction SilentlyContinue | Where-Object Path -eq '${app}').Count`], { encoding: "utf8" }).trim() !== "0";
await hasta(async () => !appViva(), 20000, "a que se cierre la app de la vuelta anterior");
await hasta(async () => (await fetch("http://127.0.0.1:4444/status")).ok, 15000, "a tauri-driver");

let b;
const paso = (t) => console.log(`· ${t}`);
const captura = async (nombre) => process.env.CAPTURAS && (await b.saveScreenshot(join(process.env.CAPTURAS, `${nombre}.png`)));
async function boton(texto, parcial = false) {
  const el = await b.$(`${parcial ? "button*=" : "button="}${texto}`);
  await el.waitForClickable({ timeout: 20000 });
  await el.click();
}
async function ver(texto, ms = 10000) {
  await b.waitUntil(async () => (await b.$("body").getText()).includes(texto), { timeout: ms, timeoutMsg: `No apareció «${texto}»` });
}
async function escribir(selector, texto) {
  const el = await b.$(selector);
  await el.waitForDisplayed({ timeout: 10000 });
  await el.setValue(texto);
}
async function entrar(nombre, pin) {
  await b.waitUntil(
    async () => {
      const el = await b.$(`button.usuario-btn*=${nombre}`);
      return (await el.isExisting()) && (await el.click().then(() => true, () => false)) && (await b.$("input.pin").isExisting());
    },
    { timeout: 30000, interval: 500, timeoutMsg: `No se pudo elegir a ${nombre}` },
  );
  await escribir("input.pin", pin);
  await b.keys(["Enter"]);
}
/** El diálogo genérico «Autorización del dueño» (lib/invocar): PIN y Enter. */
async function pinDelDueno() {
  await ver("PIN del dueño");
  const el = await b.$("dialog[open] input.pin");
  await el.waitForDisplayed({ timeout: 10000 });
  await el.setValue("246813");
  await b.keys(["Enter"]);
}
/** Cierra con Esc los diálogos que queden (venta, aviso) hasta que no haya ninguno. */
const sinDialogos = () =>
  b.waitUntil(
    async () => {
      if ((await b.$$("dialog[open]")).length === 0) return true;
      await b.keys(["Escape"]);
      return false;
    },
    { timeout: 10000, interval: 300, timeoutMsg: "Quedó un diálogo abierto" },
  );
const avanzar = (minutos) => b.execute((s) => window.__TAURI_INTERNALS__.invoke("prueba_avanzar_reloj", { segundos: s }), Math.round(minutos * 60));
const BUSCAR = "input[placeholder='Buscar o escanear producto']";
async function vender(codigo, nombre) {
  await escribir(BUSCAR, codigo);
  await b.keys(["Enter"]);
  await ver(nombre);
  await b.keys(["F12"]);
  await ver("Confirmar cobro");
  await b.keys(["Enter"]);
  await ver("cobrada");
  await b.keys(["Escape"]);
  await sinDialogos();
}
async function anular(total) {
  await boton("Ventas del día", true);
  const fila = await b.$(`tr*=${total}`);
  await fila.waitForClickable({ timeout: 10000 });
  await fila.click();
  await boton("Anular venta");
  await ver("Motivo");
  await (await b.$("dialog[open] select")).selectByVisibleText("Error de digitación");
  await boton("Anular definitivamente");
}

try {
  b = await remote({ hostname: "127.0.0.1", port: 4444, logLevel: "warn", capabilities: { browserName: "wry", "tauri:options": { application: app } } });

  paso("la dueña activa la opción C (anular sin PIN hasta ¢10.000, 3 por turno, 30 minutos) con su PIN");
  await entrar("Ana", "246813");
  await boton("Administración", true);
  await boton("Permisos", true);
  await boton("Anulación por el cajero");
  await b.waitUntil(async () => (await b.$$("input[type=radio][name=anulacion]")).length === 3, { timeout: 10000, timeoutMsg: "No aparecieron las opciones A, B y C" });
  const radios = await b.$$("input[type=radio][name=anulacion]");
  await radios[2].click();
  await ver("de hasta ¢10.000");
  await captura("p1-opcion-c");
  await boton("Guardar");
  await pinDelDueno();
  await ver("Permisos guardados");

  paso("el cajero vende y anula una venta chica sin PIN");
  await boton("Cambiar usuario", true);
  await entrar("Luis", "2580");
  await boton("Abrir caja");
  await boton("Abrir con", true);
  await b.$(BUSCAR).waitForDisplayed({ timeout: 10000 });
  await vender("7501234567800", "Lápiz de grafito");
  await vender("7501234567893", "Retablo tallado");
  await anular("¢2.000");
  await ver("Venta anulada");
  await captura("p2-anulada-sin-pin");
  await b.keys(["Escape"]);
  await sinDialogos();

  paso("la grande (¢20.000) pasa el límite: se le pide el PIN del dueño");
  await anular("¢20.000");
  await ver("pasa de ¢10.000");
  await captura("p3-pide-pin");
  await pinDelDueno();
  await ver("Venta anulada");
  await b.keys(["Escape"]);
  await sinDialogos();

  paso("el Z muestra la sección de anulaciones por cajero sin PIN");
  await boton("Caja", true);
  await boton("Cerrar caja");
  await boton("Escribir el total");
  await b.keys(["0"]);
  await boton("Listo, revisar el conteo");
  await boton("Confirmar y cerrar");
  await ver("Anulaciones por cajero sin PIN");
  await ver("Error de digitación");
  await captura("p4-z");
  await b.keys(["Escape"]);

  paso("la dueña ve el aviso al entrar");
  await boton("Cambiar usuario", true);
  await entrar("Ana", "246813");
  await ver("Hubo 1 anulación sin PIN");
  await captura("p5-aviso");
  await boton("Entendido");

  paso("bloqueo en 1 minuto (bajarlo no pide PIN)");
  await boton("Administración", true);
  await boton("Permisos", true);
  await boton("Bloqueo por inactividad");
  const general = await b.$("input[inputmode=numeric]");
  await general.waitForDisplayed({ timeout: 10000 });
  await general.setValue("1");
  await ver("Si nadie toca la caja por 1 minuto");
  await boton("Guardar");
  await ver("Permisos guardados");

  paso("el cajero deja una venta en espera; aviso antes de bloquear y una tecla lo cierra");
  await boton("Cambiar usuario", true);
  await entrar("Luis", "2580");
  await boton("Abrir caja");
  await boton("Hoy"); // ya se cerró hoy: la regla de fechas pregunta para qué día
  await boton("Abrir con", true);
  await escribir(BUSCAR, "7501234567800");
  await b.keys(["Enter"]);
  await ver("Lápiz de grafito");
  await avanzar(0.6);
  await ver("Se bloquea en 1 minuto", 15000);
  await captura("p6-aviso-bloqueo");
  await b.keys(["Shift"]);
  await b.waitUntil(async () => !(await b.$("body").getText()).includes("Se bloquea en 1 minuto"), { timeout: 5000, timeoutMsg: "El aviso no se cerró con una tecla" });

  paso("se bloquea; vuelve a entrar y la venta en espera sigue ahí");
  await avanzar(2);
  await ver("Pantalla bloqueada", 15000);
  await captura("p7-bloqueada");
  // Luis aparece primero en el velo; su PIN va en el campo del velo (la pantalla de abajo sigue montada).
  await (await b.$("dialog.velo-bloqueo").$("button*=Luis")).click();
  await escribir("dialog.velo-bloqueo input.pin", "2580");
  await b.keys(["Enter"]);
  await b.waitUntil(async () => (await b.$$("dialog.velo-bloqueo[open]")).length === 0, { timeout: 10000, timeoutMsg: "No se quitó el velo" });
  await ver("Lápiz de grafito");
  await captura("p8-sigue");

  /** Bloquea por inactividad y vuelve a entrar con el mismo usuario (la pantalla de abajo sigue montada). */
  async function bloquearYVolver(nombre, pin) {
    await avanzar(2);
    await ver("Pantalla bloqueada", 15000);
    await (await b.$("dialog.velo-bloqueo").$(`button*=${nombre}`)).click();
    await escribir("dialog.velo-bloqueo input.pin", pin);
    await b.keys(["Enter"]);
    await b.waitUntil(async () => (await b.$$("dialog.velo-bloqueo[open]")).length === 0, { timeout: 10000, timeoutMsg: "No se quitó el velo" });
  }

  paso("conteo de caja a medias: se bloquea y al volver sigue el monto escrito");
  await sinDialogos();
  await boton("Caja", true);
  await boton("Cerrar caja");
  await boton("Escribir el total");
  const total = await b.$(".conteo-directo input");
  await total.waitForDisplayed({ timeout: 10000 });
  await total.setValue("4321");
  await bloquearYVolver("Luis", "2580");
  await b.waitUntil(async () => (await b.$(".conteo-directo input").getValue()).replace(/\D/g, "") === "4321", { timeout: 10000, timeoutMsg: "Se perdió el conteo a medias" });
  await captura("p9-conteo-sigue");
  await b.keys(["Escape"]);
  await sinDialogos();

  paso("borrador de entrada de mercadería: se bloquea y al volver sigue");
  await boton("Cambiar usuario", true);
  await entrar("Ana", "246813");
  await boton("Inventario", true);
  await boton("Entrada de mercadería", true);
  await escribir("input[maxlength='40']", "F-777");
  await bloquearYVolver("Ana", "246813");
  await b.waitUntil(async () => (await b.$("input[maxlength='40']").getValue()) === "F-777", { timeout: 10000, timeoutMsg: "Se perdió el borrador de la entrada" });
  await captura("p10-entrada-sigue");
  console.log("OK: opción C, PIN al pasar el límite, Z, aviso al dueño, bloqueo y desbloqueo sin perder la venta, el conteo de caja ni el borrador de entrada");
} catch (e) {
  if (b) await b.saveScreenshot(join(tmpdir(), "pos-e2e-permisos-fallo.png")).catch(() => undefined);
  console.error(`FALLÓ: ${e.message}\nCaptura: ${join(tmpdir(), "pos-e2e-permisos-fallo.png")}`);
  process.exitCode = 1;
} finally {
  await b?.deleteSession().catch(() => undefined);
  td.kill();
  await terminado;
  await hasta(async () => !appViva(), 20000, "a que se cierre la app").catch(() => undefined);
  await hasta(async () => (rmSync(datos, { recursive: true, force: true }), true), 10000, "borrar los datos de prueba").catch(() => undefined);
}
