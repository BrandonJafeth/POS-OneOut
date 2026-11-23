// Prueba de punta a punta de la interfaz (WebdriverIO + tauri-driver, la app real con Rust y la base
// cifrada): crear apartado (F9) → abonar y liquidar (F10) → cerrar la caja (el abono y la venta en
// el Z) → el reporte del día (dueño). Corre a cualquier hora: reloj fijo (POS_RELOJ_PRUEBA, solo en
// compilación de desarrollo) y una carpeta de datos nueva (POS_DATOS) con la semilla POS_E2E.
//
//   npm run e2e          (compila la app de desarrollo y corre esto)
// Requisitos: tests/e2e/LEEME.md (tauri-driver y msedgedriver en tools\msedgedriver\).
// Sin esperas fijas: cada paso espera a que aparezca lo que busca.
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

/** Reintenta `fn` hasta que devuelva algo verdadero (sin pausas fijas largas: 100 ms entre intentos). */
async function hasta(fn, ms, que) {
  const fin = Date.now() + ms;
  for (;;) {
    const r = await fn().catch(() => false);
    if (r) return r;
    if (Date.now() > fin) throw new Error(`Se agotó el tiempo esperando ${que}`);
    await new Promise((x) => setTimeout(x, 100));
  }
}
// La app es de instancia única: si quedó una cerrándose (vuelta anterior), la nueva se cerraría sola y
// el login fallaría. Se espera a que no haya ninguna.
const appViva = () =>
  execFileSync("powershell", ["-NoProfile", "-Command", `@(Get-Process pos -ErrorAction SilentlyContinue | Where-Object Path -eq '${app}').Count`], { encoding: "utf8" }).trim() !== "0";
await hasta(async () => !appViva(), 20000, "a que se cierre la app de la vuelta anterior");
// tauri-driver listo = contesta /status (en vez de esperar 1,5 s y rogar).
await hasta(async () => (await fetch("http://127.0.0.1:4444/status")).ok, 15000, "a tauri-driver");

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

  paso("proforma (F11): se guarda e imprime, la pestaña queda ligada y al cobrar (F12) se convierte");
  await escribir("input[placeholder='Buscar o escanear producto']", "7501234567893");
  await b.keys(["Enter"]);
  await ver("Retablo tallado");
  await b.keys(["F11"]);
  await ver("Guardar como proforma");
  await captura("12-proforma-guardar");
  await b.keys(["Enter"]); // sin nombre: Enter guarda e imprime
  await ver("Proforma P-0001"); // la pestaña (y el aviso) dicen el número
  await b.keys(["F12"]);
  await ver("Confirmar cobro");
  await b.keys(["Enter"]); // efectivo exacto
  await ver("cobrada");
  await b.keys(["Escape"]); // cierra "Venta … cobrada"
  await b.waitUntil(async () => (await b.$$("dialog[open]")).length === 0, { timeout: 10000, timeoutMsg: "No se cerró la venta cobrada" });
  await boton("Proformas", true);
  await boton("Convertidas");
  await (await b.$("tr*=P-0001")).waitForDisplayed({ timeout: 10000 });
  await captura("13-proforma-convertida");
  await boton("Venta", true);

  paso("cierra la caja: el abono y la venta del apartado salen en el Z");
  await boton("Caja", true);
  await boton("Cerrar caja");
  await boton("Escribir el total");
  // ¢20.000 del apartado + ¢20.000 de la venta que convirtió la proforma.
  await b.keys(["4", "0", "0", "0", "0"]);
  await boton("Listo, revisar el conteo");
  await boton("Confirmar y cerrar");
  await ver("Dinero recibido");
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
  await ver("Abonos recibidos (dinero)");
  await ver("¢20.000");
  await captura("5-reporte-resumen");
  // Cada reporte se espera por su título (no por tiempo).
  for (const [t, titulo, n] of [
    ["Por día", "Ventas por día", "6-reporte-dias"],
    ["Departamentos", "Ventas por departamento", "7-reporte-departamentos"],
    ["Formas de pago", "Ventas y abonos por forma de pago", "8-reporte-formas"],
    ["Cierres de caja", "Recibido", "9-reporte-cierres"],
  ]) {
    await boton(t);
    await ver(titulo);
    await captura(n);
  }
  await boton("Apartados", true);
  await boton("Entregados y cancelados");
  await (await b.$("tr*=A-0001")).waitForClickable({ timeout: 10000 });
  await captura("10-apartados-dueno");
  await (await b.$("tr*=A-0001")).click();
  await ver("Historial");
  await captura("11-apartado-detalle");
  await b.keys(["Escape"]);
  console.log("OK: apartado → abono → liquidación → Z → reporte");

  // REVISION=1 (con CAPTURAS): las pantallas clave en tema claro y oscuro, a 1024, 1366 y 1920 px,
  // y un aviso (toast) encima de un diálogo abierto, que se tiene que poder tocar.
  if (process.env.REVISION && process.env.CAPTURAS) {
    paso("revisión visual: temas y anchos");
    for (const tema of ["claro", "oscuro"]) {
      const actual = (await b.$("html").getAttribute("data-tema")) ?? "claro";
      if (actual !== tema) await (await b.$("button[title^='Tema']")).click();
      await b.waitUntil(async () => (await b.$("html").getAttribute("data-tema")) === tema, { timeout: 5000, timeoutMsg: `No cambió al tema ${tema}` });
      for (const [w, h] of [[1024, 768], [1366, 768], [1920, 1080]]) {
        await b.setWindowSize(w, h);
        const n = (x) => `r-${tema}-${w}-${x}`;
        await boton("Reportes", true);
        await boton("Resumen");
        await boton("Hoy");
        await ver("Resumen de ventas");
        await captura(n("1-resumen"));
        await boton("Cierres de caja");
        await ver("Resumen del día");
        await captura(n("2-cierres"));
        await (await b.$("tr.clic")).click();
        await ver("Dinero recibido");
        await captura(n("3-z"));
        // Aviso encima del diálogo del Z: exportar el PDF muestra "PDF guardado" con «Copiar ruta».
        await boton("Exportar PDF", true);
        const cerrar = await b.$(".toast-cerrar");
        await cerrar.waitForClickable({ timeout: 10000 }); // no inerte: se puede tocar
        await captura(n("4-aviso-sobre-dialogo"));
        await cerrar.click();
        await cerrar.waitForExist({ reverse: true, timeout: 5000 });
        await b.keys(["Escape"]);
        await boton("Apartados", true);
        await ver("¿Qué es un abono?").catch(() => undefined);
        await captura(n("5-apartados"));
      }
    }
    console.log("OK: revisión visual");
  }
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
  await terminado;
  // Que la app termine de cerrarse (suelta la base y deja libre la instancia única para la próxima vuelta).
  await hasta(async () => !appViva(), 20000, "a que se cierre la app").catch(() => undefined);
  // La app puede tardar un poco en cerrar la base después de tauri-driver: se reintenta el borrado.
  await hasta(async () => (rmSync(datos, { recursive: true, force: true }), true), 10000, "borrar los datos de prueba").catch(() => undefined);
}
