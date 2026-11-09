// Inventario (solo el dueño): existencias, entradas de mercadería, conteo físico, reportes,
// proveedores, carga inicial y opciones. Rust decide todo (src-tauri/src/inventario.rs).
import { flechasPestanas } from "../ui/pestanas";
import { useEffect, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import { guardarConfig } from "../db/config";
import { alertasInventario, type FiltroInventario } from "../db/inventario";
import Button from "../ui/Button";
import Field from "../ui/Field";
import { useToast } from "../ui/Toast";
import Conteo from "./inventario/Conteo";
import EntradaMercaderia from "./inventario/Entrada";
import Existencias from "./inventario/Existencias";
import Inicial from "./inventario/Inicial";
import Proveedores from "./inventario/Proveedores";
import Reportes from "./inventario/Reportes";

const TABS = [
  ["existencias", "Existencias"],
  ["entrada", "Entrada de mercadería"],
  ["conteo", "Conteo físico"],
  ["reportes", "Reportes"],
  ["proveedores", "Proveedores"],
  ["inicial", "Carga inicial"],
  ["opciones", "Opciones"],
] as const;
type Tab = (typeof TABS)[number][0];

export default function Inventario() {
  const { puede } = useSesion();
  const [tab, setTab] = useState<Tab>("existencias");
  const [alertas, setAlertas] = useState(0);
  const [filtro, setFiltro] = useState<FiltroInventario>("con_control");
  useEffect(() => void alertasInventario().then(setAlertas, () => setAlertas(0)), [tab]);
  const tabs = TABS.filter(([id]) => id !== "reportes" || puede("reportes"));
  return (
    <div className="screen">
      <h1>Inventario</h1>
      {alertas > 0 && tab === "existencias" && filtro !== "bajo_minimo" && (
        <div className="row">
          <span className="muted">{alertas === 1 ? "1 producto está" : `${alertas} productos están`} en su mínimo o por debajo.</span>
          <Button variante="fantasma" onClick={() => setFiltro("bajo_minimo")}>
            Ver {alertas === 1 ? "cuál" : "cuáles"}
          </Button>
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Inventario" onKeyDown={flechasPestanas}>
        {tabs.map(([id, t]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "existencias" && <Existencias filtroInicial={filtro} onFiltro={setFiltro} />}
      {tab === "entrada" && <EntradaMercaderia />}
      {tab === "conteo" && <Conteo />}
      {tab === "reportes" && <Reportes />}
      {tab === "proveedores" && <Proveedores />}
      {tab === "inicial" && <Inicial onConteo={() => setTab("conteo")} />}
      {tab === "opciones" && <Opciones />}
    </div>
  );
}

function Opciones() {
  const { actor, config, recargarConfig } = useSesion();
  const toast = useToast();
  const [motivos, setMotivos] = useState(config.inventario_motivos_ajuste.join("\n"));
  const [error, setError] = useState("");
  async function guardar(clave: string, valor: unknown) {
    setError("");
    try {
      await guardarConfig(actor, clave, valor);
      await recargarConfig();
      toast.ok("Guardado.");
    } catch (e) {
      setError(textoError(e));
    }
  }
  return (
    <section className="card">
      <label className="row">
        <input type="checkbox" checked={config.permitir_vender_sin_existencia} onChange={(e) => guardar("permitir_vender_sin_existencia", e.target.checked)} />
        Vender aunque no haya existencia (queda negativa y se marca para revisión). Si se apaga, hace falta el PIN del dueño.
      </label>
      <label className="row">
        <input type="checkbox" checked={config.venta_mostrar_existencia} onChange={(e) => guardar("venta_mostrar_existencia", e.target.checked)} />
        Mostrar la existencia en las tarjetas de la venta (el cajero la ve, nunca el costo)
      </label>
      <Field label="Motivos de ajuste (uno por línea)" ayuda="«Otro» pide escribir el motivo.">
        <textarea rows={6} value={motivos} onChange={(e) => setMotivos(e.target.value)} />
      </Field>
      <Button
        variante="primario"
        onClick={() =>
          guardar(
            "inventario_motivos_ajuste",
            motivos.split("\n").map((m) => m.trim()).filter(Boolean),
          )
        }
      >
        Guardar motivos
      </Button>
      <Mensaje error={error} />
    </section>
  );
}
