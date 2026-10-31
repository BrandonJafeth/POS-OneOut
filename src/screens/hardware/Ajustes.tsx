import { CODE_PAGES } from "../../lib/codepages";
import type { TicketSettings } from "../../lib/tickets";

interface Props {
  settings: TicketSettings;
  onSettings: (s: TicketSettings) => void;
}

/** Ajustes del tiquete, compartidos por Impresora y Sin hardware (mismos bytes en ambas). */
export default function Ajustes({ settings, onSettings }: Props) {
  const set = (patch: Partial<TicketSettings>) => onSettings({ ...settings, ...patch });
  
  return (
    <div className="row">
      <label>
        Code page (ESC t n):{" "}
        <select value={settings.codePage} onChange={(e) => set({ codePage: Number(e.target.value) })}>
          {CODE_PAGES.map((c) => (
            <option key={c.escT} value={c.escT}>
              {c.escT} — {c.name}
            </option>
          ))}
        </select>
      </label>
      <label title="GS k formato B (m=67) es el moderno; si no sale el código de barras, pruebe el A (m=2).">
        Código de barras:{" "}
        <select value={settings.barras} onChange={(e) => set({ barras: e.target.value as "A" | "B" })}>
          <option value="B">Formato B (m=67)</option>
          <option value="A">Formato A (m=2)</option>
        </select>
      </label>
      <label title="Manda FS . al inicio. Si las tildes salen como caracteres chinos, debe estar marcado.">
        <input type="checkbox" checked={settings.sinModoChino} onChange={(e) => set({ sinModoChino: e.target.checked })} />{" "}
        Apagar modo chino (FS .)
      </label>
      <label>
        <input type="checkbox" checked={settings.cortador} onChange={(e) => set({ cortador: e.target.checked })} /> La
        impresora tiene cortador
      </label>
    </div>
  );
}
