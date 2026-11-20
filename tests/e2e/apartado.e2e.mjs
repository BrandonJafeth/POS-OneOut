// Prueba de punta a punta de la interfaz (WebdriverIO + tauri-driver, la app real con Rust y la base
// cifrada): crear apartado (F9) → abonar y liquidar (F10) → cerrar la caja (el abono y la venta en
// el Z) → el reporte del día (dueño). Corre a cualquier hora: reloj fijo (POS_RELOJ_PRUEBA, solo en
// compilación de desarrollo) y una carpeta de datos nueva (POS_DATOS) con la semilla POS_E2E.
//
//   npm run e2e          (compila la app de desarrollo y corre esto)
// Requisitos: `cargo install tauri-driver` y msedgedriver de la MISMA versión que WebView2
// (variable MSEDGEDRIVER o %TEMP%\edgedriver157\msedgedriver.exe).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { remote } from "webdriverio";

const app = resolve("src-tauri/target/debug/pos.exe");
const driver = process.env.MSEDGEDRIVER ?? join(tmpdir(), "edgedriver157", "msedgedriver.exe");
const tauriDriver = join(homedir(), ".cargo", "bin", "tauri-driver.exe");
for (const [que, ruta] of [["app (npm run e2e:build)", app], ["msedgedriver", driver], ["tauri-driver", tauriDriver]]) {
  if (!existsSync(ruta)) throw new Error(`Falta ${que}: ${ruta}`);
}

const datos = mkdtempSync(join(tmpdir(), "pos-e2e-"));
const env = { ...process.env, POS_DATOS: datos, POS_E2E: "1", POS_RELOJ_PRUEBA: "2026-11-18T10:00:00-06:00" };
const td = spawn(tauriDriver, ["--native-driver", driver], { env, stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 1500));

let b;
const paso = (t) => console.log(`· ${t}`);
// CAPTURAS=<carpeta>: guarda una imagen de cada pantalla clave (revisión visual del diseño).
const captura = async (nombre) => process.env.CAPTURAS && (await b.saveScreenshot(join(process.env.CAPTURAS, `${nombre}.png`)));
async function boton(texto, parcial = false) {
  const el = await b.$(`${parcial ? "button*=" : "button="}${texto}`);
  await el.waitForClickable({ timeout: 20000 });
  await el.click();
}
async function ver(texto) {
  await b.waitUntil(async () => (await b.$("body").getText()).includes(texto), { timeout: 10000, timeoutMsg: `No apareció «${texto}»` });
}
async function escribir(selector, texto) {
  const el = await b.$(selector);
  await el.waitForDisplayed({ timeout: 10000 });
  await el.setValue(texto);
}
async function entrar(nombre, pin) {
  // La lista de usuarios aparece al volver de "Cambiar usuario": se reintenta el clic hasta que entra.
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

try {
  b = await remote({ hostname: "127.0.0.1", port: 4444, logLevel: "warn", capabilities: { browserName: "wry", "tauri:options": { application: app } } });

  paso("el cajero entra y abre la caja");
  await entrar("Luis", "2580");
  await boton("Abrir caja");
  await boton("Abrir con", true);
  await b.$("input[placeholder='Buscar o escanear producto']").waitForDisplayed({ timeout: 10000 });

  paso("agrega el producto y lo aparta (F9): cliente nuevo, abono mínimo en efectivo");
  await escribir("input[placeholder='Buscar o escanear producto']", "7501234567893");
  await b.keys(["Enter"]);
  await ver("Retablo tallado");
  await b.keys(["F9"]);
  await boton("Nuevo cliente");
  const campos = await b.$$("dialog input:not([type=checkbox])");
  await campos[0].setValue("Marta Solís");
  await campos[1].setValue("88887777");
  await b.$("label.consentimiento input").click();
  await boton("Guardar cliente");
  await ver("Abono mínimo");
  await captura("1-apartar");
  await b.keys(["Enter"]); // abona el mínimo (¢10.000)
  await ver("Abono del apartado");
  await b.keys(["Enter"]); // efectivo exacto
  await ver("Apartado A-0001 creado");
  await captura("2-apartado-creado");
  await b.keys(["Enter"]);

  paso("busca el apartado (F10), abona el saldo y se lo lleva");
  await b.keys(["F10"]);
  const fila = await b.$("tr*=A-0001");
  await fila.waitForClickable({ timeout: 10000 });
  await fila.click();
  await ver("Saldo");
  await captura("3-abonar");
  await b.keys(["Enter"]); // abona todo el saldo
  await ver("Abono A-0001");
  await b.keys(["Enter"]);
  await ver("A-0001 liquidado");
  await b.keys(["Enter"]);

  paso("cierra la caja: el abono y la venta del apartado salen en el Z");
  await boton("Caja", true);
  await boton("Cerrar caja");
  await boton("Escribir el total");
  await b.keys(["2", "0", "0", "0", "0"]);
  await boton("Listo, revisar el conteo");
  await boton("Confirmar y cerrar");
  await ver("Apartados y crédito");
  await ver("Ventas pagadas con abonos");
  await ver("Total abonos (dinero)");
  await b.execute(() => document.querySelector("dialog .modal-cuerpo h3:last-of-type, dialog section:has(h3)")?.scrollIntoView());
  const secc = await b.$("h3=Apartados y crédito");
  await secc.scrollIntoView();
  await captura("4-z-apartados");

  paso("la dueña ve el día en Reportes");
  await b.keys(["Escape"]);
  await boton("Cambiar usuario", true);
  await entrar("Ana", "246813");
  await boton("Reportes", true);
  await boton("Hoy");
  await ver("Abonos (dinero)");
  await ver("¢20.000");
  await captura("5-reporte-resumen");
  for (const [t, n] of [["Por día", "6-reporte-dias"], ["Departamentos", "7-reporte-departamentos"], ["Formas de pago", "8-reporte-formas"], ["Cierres de caja", "9-reporte-cierres"]]) {
    await boton(t);
    await new Promise((r) => setTimeout(r, 600));
    await captura(n);
  }
  await boton("Apartados", true);
  await boton("Entregados y cancelados");
  await new Promise((r) => setTimeout(r, 600));
  await captura("10-apartados-dueno");
  await (await b.$("tr*=A-0001")).click();
  await ver("Historial");
  await captura("11-apartado-detalle");
  console.log("OK: apartado → abono → liquidación → Z → reporte");
} catch (e) {
  if (b) await b.saveScreenshot(join(tmpdir(), "pos-e2e-fallo.png")).catch(() => undefined);
  if (b)
    console.error(
      await b
        .execute(() => {
          const btn = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("Ana"));
          const r = btn?.getBoundingClientRect();
          const encima = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
          return JSON.stringify({ dialogos: document.querySelectorAll("dialog").length, abiertos: document.querySelectorAll("dialog[open]").length, encima: encima?.outerHTML.slice(0, 160), inerte: btn?.closest("[inert]") != null });
        })
        .catch((x) => String(x)),
      await b
        .$("button*=Ana")
        .then(async (el) => [await el.getHTML().then((h) => h.slice(0, 200)), await el.isDisplayed(), await el.isEnabled(), await el.isDisplayed({ withinViewport: true })])
        .catch((x) => String(x)),
    );
  console.error(`FALLÓ: ${e.message}\nCaptura: ${join(tmpdir(), "pos-e2e-fallo.png")}`);
  process.exitCode = 1;
} finally {
  await b?.deleteSession().catch(() => undefined);
  td.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(datos, { recursive: true, force: true });
}
