// Las 3 pantallas del prototipo de hardware, ahora dentro de Configuración técnica → Hardware.
import { useState } from "react";
import Lector from "./Lector";
import Impresora from "./Impresora";
import SinHardware from "./SinHardware";
import { DEFAULT_SETTINGS, type TicketSettings } from "../../lib/tickets";

type Tab = "lector" | "impresora" | "sinhw";

const TABS: { id: Tab; label: string }[] = [
  { id: "lector", label: "Lector de código" },
  { id: "impresora", label: "Impresora" },
  { id: "sinhw", label: "Sin hardware" },
];

export default function Diagnostico({ ajustes = DEFAULT_SETTINGS }: { ajustes?: TicketSettings }) {
  const [tab, setTab] = useState<Tab>("impresora");
  const [settings, setSettings] = useState<TicketSettings>(ajustes);

  return (
    <div className="screen">
      <nav className="row">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "tab active" : "tab"} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {/* Montadas siempre (solo se ocultan) para no perder historial al cambiar de pestaña. */}
      <div hidden={tab !== "lector"}>
        <Lector active={tab === "lector"} />
      </div>
      <div hidden={tab !== "impresora"}>
        <Impresora settings={settings} onSettings={setSettings} />
      </div>
      <div hidden={tab !== "sinhw"}>
        <SinHardware settings={settings} onSettings={setSettings} />
      </div>
    </div>
  );
}
