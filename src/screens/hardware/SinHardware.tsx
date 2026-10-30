import { useMemo, useState } from "react";
import Ajustes from "./Ajustes";
import Papel from "../../components/Papel";
import { hexDump, interpret } from "../../lib/preview";
import { colon, gaveta, textoSimple, tiquete, todosCodePages, type Doc, type TicketSettings } from "../../lib/tickets";

const DOCS: { id: string; label: string; build: (s: TicketSettings) => Doc }[] = [
  { id: "tiquete", label: "Tiquete de prueba", build: (s) => tiquete(s) },
  { id: "simple", label: "Texto simple", build: textoSimple },
  { id: "codepages", label: "Todos los code pages", build: todosCodePages },
  { id: "colon", label: "₡ / CRC", build: colon },
  { id: "gaveta", label: "Abrir gaveta", build: gaveta },
];

interface Props {
  settings: TicketSettings;
  onSettings: (s: TicketSettings) => void;
}

export default function SinHardware({ settings, onSettings }: Props) {
  const [docId, setDocId] = useState("tiquete");
  const [version, setVersion] = useState(0); // para regenerar (fecha/hora) a pedido
  const def = DOCS.find((d) => d.id === docId) ?? DOCS[0];
  const doc = useMemo(() => def.build(settings), [def, settings, version]);
  const items = useMemo(() => interpret(doc.bytes), [doc]);
  const hex = useMemo(() => hexDump(doc.bytes), [doc]);

  function guardar() {
    // Blob + <a download>: en Tauri lo guarda WebView2 en la carpeta Descargas.
    const blob = new Blob([doc.bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${def.id}-cp${settings.codePage}.bin`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="screen">
      <section className="card">
        <div className="row">
          <label>
            Documento:{" "}
            <select value={docId} onChange={(e) => setDocId(e.target.value)}>
              {DOCS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => setVersion((v) => v + 1)}>Regenerar</button>
          <button className="primary" onClick={guardar}>
            Guardar bytes (.bin)
          </button>
          <span className="muted">{doc.bytes.length} bytes</span>
        </div>
        <Ajustes settings={settings} onSettings={onSettings} />
        {doc.missing.length > 0 && (
          <p className="note">
            Sin carácter en este code page (se envía "?" y se resalta en amarillo): {[...new Set(doc.missing)].join(" ")}
          </p>
        )}
      </section>

      <div className="cols">
        <section className="card">
          <h2>Vista previa (58 mm · 32 columnas)</h2>
          <p className="muted">Generada interpretando los mismos bytes que se mandan a la impresora.</p>
          <Papel items={items} />
        </section>
        <section className="card">
          <h2>Bytes (hex)</h2>
          <pre className="hex mono">{hex}</pre>
        </section>
      </div>
    </div>
  );
}
