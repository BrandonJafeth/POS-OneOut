import { useEffect, useState } from "react";
import Ajustes from "./Ajustes";
import { copiar } from "../../lib/copiar";
import { CODE_PAGES } from "../../lib/codepages";
import { listPrinters, printRaw } from "../../lib/printerApi";
import { colon, gaveta, textoSimple, tiquete, todosCodePages, type Doc, type TicketSettings } from "../../lib/tickets";

interface LogEntry {
  id: number;
  hora: string;
  prueba: string;
  ok: boolean;
  bytes: number;
  ms: number;
  ajustes: string;
  detalle: string;
}

interface Props {
  settings: TicketSettings;
  onSettings: (s: TicketSettings) => void;
}

let nextId = 1;

const ES_POS58 = /POS-?58/i;

export default function Impresora({ settings, onSettings }: Props) {
  const [printers, setPrinters] = useState<string[]>([]);
  const [printer, setPrinter] = useState("");
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  async function refresh() {
    setListError("");
    try {
      const list = await listPrinters();
      setPrinters(list);
      setPrinter((cur) => (list.includes(cur) ? cur : (list.find((p) => ES_POS58.test(p)) ?? list[0] ?? "")));
    } catch (e) {
      setPrinters([]);
      setListError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Se anotan los ajustes de cada impresión para saber después cuál combinación funcionó.
  const ajustes = `CP ${settings.codePage} · barras ${settings.barras}${settings.sinModoChino ? " · FS ." : ""}${settings.cortador ? " · corte" : ""}`;

  function addLog(e: Omit<LogEntry, "id" | "hora" | "ajustes">) {
    setLog((l) => [{ ...e, ajustes, id: nextId++, hora: new Date().toLocaleTimeString("es-CR") }, ...l].slice(0, 100));
  }

  function copiarRegistro() {
    const filas = [...log]
      .reverse()
      .map((l) => [l.hora, printer, l.prueba, l.ok ? "OK" : "ERROR", `${l.bytes} B`, `${l.ms} ms`, l.ajustes, l.detalle].join("\t"));
    // Separado por tabulaciones: se pega directo en Excel o en una tabla de Word.
    const encabezado = ["Hora", "Impresora", "Prueba", "Resultado", "Bytes", "Tiempo", "Ajustes", "Detalle"].join("\t");
    void copiar([encabezado, ...filas].join("\n"));
  }

  /** Manda un documento y registra resultado, bytes y tiempo. Devuelve si salió bien. */
  async function send(prueba: string, doc: Doc): Promise<boolean> {
    const t0 = performance.now();
    try {
      if (!printer) throw new Error("No hay impresora seleccionada");
      await printRaw(printer, doc.bytes);
      const faltan = doc.missing.length ? `Sin carácter en el code page (salió "?"): ${[...new Set(doc.missing)].join(" ")}` : "";
      addLog({ prueba, ok: true, bytes: doc.bytes.length, ms: Math.round(performance.now() - t0), detalle: faltan });
      return true;
    } catch (e) {
      addLog({ prueba, ok: false, bytes: doc.bytes.length, ms: Math.round(performance.now() - t0), detalle: String(e) });
      return false;
    }
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  async function diezSeguidos() {
    const t0 = performance.now();
    let ok = 0;
    let bytes = 0;
    for (let i = 1; i <= 10; i++) {
      const doc = tiquete(settings, `Copia ${i} de 10`);
      bytes += doc.bytes.length;
      if (await send(`Tiquete ${i}/10`, doc)) ok++;
    }
    addLog({
      prueba: "10 seguidos (total)",
      ok: ok === 10,
      bytes,
      ms: Math.round(performance.now() - t0),
      detalle: `${ok}/10 aceptados por el spooler. Revise en papel que salgan las copias 1 a 10 y cronometre.`,
    });
  }

  const cpName = CODE_PAGES.find((c) => c.escT === settings.codePage)?.name ?? "";

  return (
    <div className="screen">
      <section className="card">
        <h2>Impresora</h2>
        <div className="row">
          <select value={printer} onChange={(e) => setPrinter(e.target.value)} disabled={!printers.length}>
            {printers.length === 0 && <option value="">(sin impresoras)</option>}
            {printers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button onClick={() => void refresh()}>Actualizar lista</button>
          {printer && !ES_POS58.test(printer) && (
            <span className="badge warn">La seleccionada no parece la POS-58</span>
          )}
        </div>
        {listError && <p className="badge err">{listError}</p>}
      </section>

      <section className="card">
        <h2>Ajustes</h2>
        <Ajustes settings={settings} onSettings={onSettings} />
      </section>

      <section className="card">
        <h2>Pruebas</h2>
        <div className="row">
          <button disabled={busy} onClick={() => void run(() => send("Texto simple", textoSimple(settings)))}>
            Texto simple
          </button>
          <button className="primary" disabled={busy} onClick={() => void run(() => send(`Tiquete (${cpName})`, tiquete(settings)))}>
            Imprimir tiquete de prueba
          </button>
          <button disabled={busy} onClick={() => void run(() => send("Todos los code pages", todosCodePages(settings)))}>
            Probar todos los code pages
          </button>
          <button disabled={busy} onClick={() => void run(() => send(`₡ y CRC (${cpName})`, colon(settings)))}>
            Probar ₡1.500 / CRC 1.500
          </button>
          <button disabled={busy} onClick={() => void run(diezSeguidos)}>
            Imprimir 10 tiquetes seguidos
          </button>
          <button disabled={busy} onClick={() => void run(() => send("Abrir gaveta", gaveta(settings)))}>
            Abrir gaveta
          </button>
        </div>
        <p className="note">
          "Abrir gaveta" solo hace algo si hay una gaveta conectada al puerto RJ11 de la impresora. Sin gaveta,
          el resultado "OK" solo significa que el spooler recibió los bytes.
        </p>
        <p className="muted">
          "OK" = Windows aceptó el trabajo. Confirme siempre en el papel; si algo no sale, revise la cola de impresión
          de Windows.
        </p>
      </section>

      <section className="card">
        <div className="row between">
          <h2>Registro de impresiones</h2>
          <div className="row">
            <button onClick={copiarRegistro} disabled={!log.length}>
              Copiar registro
            </button>
            <button onClick={() => setLog([])} disabled={!log.length}>
              Limpiar
            </button>
          </div>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Hora</th>
              <th>Prueba</th>
              <th>Resultado</th>
              <th>Bytes</th>
              <th>Tiempo</th>
              <th>Ajustes</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {log.map((l) => (
              <tr key={l.id}>
                <td>{l.hora}</td>
                <td>{l.prueba}</td>
                <td className={l.ok ? "ok" : "err"}>{l.ok ? "OK" : "ERROR"}</td>
                <td>{l.bytes}</td>
                <td>{l.ms} ms</td>
                <td>{l.ajustes}</td>
                <td>{l.detalle}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
