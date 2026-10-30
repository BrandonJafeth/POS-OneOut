import { useEffect, useRef, useState } from "react";
import { copiar } from "../../lib/copiar";
import { isIsbn13, isValidEan13 } from "../../lib/ean13";

interface KeyLog {
  key: string;
  code: string;
  delta: number | null; // ms desde la tecla anterior (null = primera o ignorada)
  ignorada: boolean; // modificadoras y teclas sin carácter: se registran pero no cuentan para el tiempo
}

/** Solo cuentan para el tiempo los caracteres y el Enter final (Shift, Ctrl, Alt, F1… no). */
function cuenta(key: string): boolean {
  return key.length === 1 || key === "Enter" || key === "Tab";
}

/** Teclas "muertas" o desconocidas: casi siempre indican que la distribución del teclado no coincide. */
function teclaRara(key: string): boolean {
  return key === "Dead" || key === "Unidentified";
}

interface Lectura {
  id: number;
  text: string;
  keys: KeyLog[];
  totalMs: number;
  avgMs: number | null;
  tipo: "ESCANEO" | "TECLEO";
  fin: "Enter" | "Tab"; // tecla que cerró la lectura
  hora: string;
}

const MAX_HISTORIAL = 20;

/** Dígitos y letras (incluye tildes/ñ) son normales; todo lo demás se resalta. */
function esSospechoso(ch: string): boolean {
  return !/^[\p{L}\p{N}]$/u.test(ch);
}

function Resaltado({ text }: { text: string }) {
  return (
    <span className="mono">
      {Array.from(text).map((ch, i) =>
        esSospechoso(ch) ? (
          <mark key={i} title={`U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`}>
            {ch === " " ? "␣" : ch}
          </mark>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </span>
  );
}

export default function Lector({ active }: { active: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [umbral, setUmbral] = useState(40);
  const [value, setValue] = useState("");
  const [keys, setKeys] = useState<KeyLog[]>([]);
  const [historial, setHistorial] = useState<Lectura[]>([]);
  const [bloqMayus, setBloqMayus] = useState(false);
  // El buffer vive en una ref: el lector manda teclas cada pocos ms y no queremos depender del render.
  const keysRef = useRef<KeyLog[]>([]);
  const lastKeyAt = useRef<number | null>(null);
  const firstKeyAt = useRef<number | null>(null);
  const nextId = useRef(1);

  // Recuperar el foco: al perderlo y además cada 500 ms por si algo lo roba.
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => {
      const active = document.activeElement;
      const editandoOtro = active instanceof HTMLInputElement && active !== inputRef.current;
      if (!editandoOtro && active !== inputRef.current) inputRef.current?.focus();
    }, 500);
    inputRef.current?.focus();
    return () => window.clearInterval(t);
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const now = performance.now();
    const ignorada = !cuenta(e.key);
    let delta: number | null = null;
    if (!ignorada) {
      delta = lastKeyAt.current === null ? null : Math.round(now - lastKeyAt.current);
      if (firstKeyAt.current === null) firstKeyAt.current = now;
      lastKeyAt.current = now;
    }
    setBloqMayus(e.getModifierState("CapsLock"));
    const entry: KeyLog = { key: e.key, code: e.code, delta, ignorada };
    keysRef.current.push(entry);
    const allKeys = [...keysRef.current];
    setKeys(allKeys);

    // Enter es lo normal; algunos lectores vienen configurados con Tab (que además sacaría el foco).
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const text = e.currentTarget.value;
      // Promedio de los intervalos entre teclas, incluido el Enter final.
      const deltas = allKeys.map((k) => k.delta).filter((d): d is number => d !== null);
      const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
      const lectura: Lectura = {
        id: nextId.current++,
        text,
        keys: allKeys,
        totalMs: Math.round(now - (firstKeyAt.current ?? now)),
        avgMs: avg,
        tipo: avg !== null && avg < umbral ? "ESCANEO" : "TECLEO",
        fin: e.key,
        hora: new Date().toLocaleTimeString("es-CR"),
      };
      // Un Enter suelto (p. ej. lector que manda CR + LF) no es una lectura.
      if (text !== "") setHistorial((h) => [lectura, ...h].slice(0, MAX_HISTORIAL));
      setValue("");
      setKeys([]);
      keysRef.current = [];
      lastKeyAt.current = null;
      firstKeyAt.current = null;
    }
  }

  function limpiar() {
    setValue("");
    setKeys([]);
    setHistorial([]);
    keysRef.current = [];
    lastKeyAt.current = null;
    firstKeyAt.current = null;
    inputRef.current?.focus();
  }

  function copiarHistorial() {
    const filas = [...historial]
      .reverse()
      .map((l) =>
        [l.hora, l.text, Array.from(l.text).length, l.avgMs?.toFixed(1) ?? "", l.tipo, l.fin, isValidEan13(l.text) ? "válido" : "no"].join("\t"),
      );
    const encabezado = ["Hora", "Código", "Largo", "Prom. ms", "Tipo", "Fin", "EAN-13"].join("\t");
    void copiar([encabezado, ...filas].join("\n"));
  }

  const ultima = historial[0];
  const keysMostradas = ultima && keys.length === 0 ? ultima.keys : keys;

  return (
    <div className="screen">
      <div className="row">
        <span className={`badge ${focused ? "ok" : "err"}`}>{focused ? "● Escuchando lector" : "○ Sin foco"}</span>
        <label>
          Umbral escaneo (ms promedio):{" "}
          <input
            type="number"
            min={1}
            max={500}
            value={umbral}
            onChange={(e) => setUmbral(Number(e.target.value) || 40)}
            className="small"
          />
        </label>
        <button onClick={limpiar}>Limpiar</button>
        <button onClick={copiarHistorial} disabled={!historial.length}>
          Copiar historial
        </button>
        {bloqMayus && <span className="badge warn">Bloq Mayús activado: el lector invertirá mayúsculas/minúsculas</span>}
      </div>

      <input
        ref={inputRef}
        className="scan-input mono"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Escanee un código aquí…"
        autoComplete="off"
        spellCheck={false}
      />

      <section className="card">
        <h2>Última lectura</h2>
        {ultima ? (
          <div className="grid2">
            <div>Código</div>
            <div className="big">
              <Resaltado text={ultima.text} />
            </div>
            <div>Tipo</div>
            <div>
              <span className={`badge ${ultima.tipo === "ESCANEO" ? "ok" : "warn"}`}>{ultima.tipo}</span>
            </div>
            <div>Largo</div>
            <div>{Array.from(ultima.text).length} caracteres</div>
            <div>Tiempo total</div>
            <div>
              {ultima.totalMs} ms (promedio {ultima.avgMs === null ? "—" : `${ultima.avgMs.toFixed(1)} ms`} entre teclas)
            </div>
            <div>Terminó con</div>
            <div>
              {ultima.fin === "Enter" ? (
                "Enter"
              ) : (
                <span className="badge warn">Tab: configure el lector para que termine con Enter</span>
              )}
            </div>
            <div>EAN-13 / ISBN-13</div>
            <div>
              {isValidEan13(ultima.text) ? (
                <span className="badge ok">EAN-13 válido{isIsbn13(ultima.text) ? " · ISBN-13" : ""}</span>
              ) : (
                <span className="badge err">No es EAN-13 válido</span>
              )}
            </div>
          </div>
        ) : (
          <p className="muted">Todavía no hay lecturas. Escanee un código (debe terminar con Enter).</p>
        )}
      </section>

      <div className="cols">
        <section className="card">
          <h2>Teclas {keys.length > 0 ? "(en curso)" : "(última lectura)"}</h2>
          <table className="tbl mono">
            <thead>
              <tr>
                <th>#</th>
                <th>event.key</th>
                <th>event.code</th>
                <th>Δ ms</th>
              </tr>
            </thead>
            <tbody>
              {keysMostradas.map((k, i) => (
                <tr
                  key={i}
                  className={
                    teclaRara(k.key) || (k.key.length === 1 && esSospechoso(k.key))
                      ? "sospechoso"
                      : k.ignorada
                        ? "ignorada"
                        : ""
                  }
                >
                  <td>{i + 1}</td>
                  <td>{k.key === " " ? "␣" : k.key}</td>
                  <td>{k.code}</td>
                  <td>{k.ignorada ? "no cuenta" : (k.delta ?? "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Historial (últimos {MAX_HISTORIAL})</h2>
          <table className="tbl">
            <thead>
              <tr>
                <th>Hora</th>
                <th>Código</th>
                <th>Largo</th>
                <th>Prom. ms</th>
                <th>Tipo</th>
                <th>Fin</th>
                <th>EAN</th>
              </tr>
            </thead>
            <tbody>
              {historial.map((l) => (
                <tr key={l.id}>
                  <td>{l.hora}</td>
                  <td>
                    <Resaltado text={l.text} />
                  </td>
                  <td>{Array.from(l.text).length}</td>
                  <td>{l.avgMs === null ? "—" : l.avgMs.toFixed(1)}</td>
                  <td>{l.tipo}</td>
                  <td>{l.fin}</td>
                  <td>{isValidEan13(l.text) ? "✓" : "✗"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
