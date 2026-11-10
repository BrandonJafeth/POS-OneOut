// Conteo físico: elegir departamento (o todos), escanear (suma 1) o escribir lo contado, guardar
// a medias, ver diferencias contra el sistema y aplicar todo de una vez (PIN del dueño).
import { CheckCircle2, ClipboardCheck, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../../app/sesion";
import Mensaje, { textoError } from "../../components/Mensaje";
import PinDueno from "../../components/PinDueno";
import { listarDepartamentos } from "../../db/departamentos";
import { aplicarConteo, conteoAbierto, descartarConteo, diferenciasConteo, guardarConteo, type Conteo as ConteoGuardado, type FilaConteo } from "../../db/inventario";
import { normalizar } from "../../lib/texto";
import { useEscaner } from "../../lib/useEscaner";
import type { Departamento } from "../../tipos";
import Button from "../../ui/Button";
import { useConfirmar } from "../../ui/Confirmar";
import Field from "../../ui/Field";
import Paginacion from "../../ui/Paginacion";
import { useToast } from "../../ui/Toast";

const POR_PAGINA = 50;

export default function Conteo() {
  const { config } = useSesion();
  const toast = useToast();
  const confirmar = useConfirmar();
  const [departamentos, setDepartamentos] = useState<Departamento[]>([]);
  const [depto, setDepto] = useState("");
  const [conteo, setConteo] = useState<ConteoGuardado | null | undefined>(undefined);
  const [filas, setFilas] = useState<FilaConteo[]>([]);
  const [contado, setContado] = useState<Record<string, string>>({});
  const [soloDiferencias, setSoloDiferencias] = useState(false);
  const [buscar, setBuscar] = useState("");
  const [pagina, setPagina] = useState(1);
  const [pidePin, setPidePin] = useState(false);
  const [error, setError] = useState("");

  async function abrir(c: ConteoGuardado | null) {
    setConteo(c);
    if (!c) return;
    setFilas(await diferenciasConteo(c.id));
    setContado(Object.fromEntries(Object.entries(c.datos).map(([k, v]) => [k, String(v)])));
  }
  useEffect(() => {
    listarDepartamentos().then(setDepartamentos, (e) => setError(textoError(e)));
    conteoAbierto().then(abrir, (e) => setError(textoError(e)));
  }, []);

  const datos = () => Object.fromEntries(Object.entries(contado).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, Number(v)]));

  /** Devuelve si quedó guardado: aplicar sin guardar usaría lo de antes, no lo que se ve. */
  async function guardar(avisar = true): Promise<boolean> {
    if (!conteo) return false;
    setError("");
    try {
      await guardarConteo(conteo.id, null, datos());
      setFilas(await diferenciasConteo(conteo.id));
      if (avisar) toast.ok("Conteo guardado. Puede seguir después.");
      return true;
    } catch (e) {
      setError(textoError(e));
      return false;
    }
  }

  // Lo contado se guarda solo, al ratito de cada cambio: si la sesión se cierra por inactividad
  // mientras se cuenta en los estantes, no se pierde nada.
  useEffect(() => {
    if (!conteo) return;
    const t = setTimeout(() => void guardarConteo(conteo.id, null, datos()).catch((e) => setError(textoError(e))), 1500);
    return () => clearTimeout(t);
  }, [contado]);

  // Escanear suma 1 al producto de ese código.
  useEscaner(
    (codigo) => {
      const f = filas.find((x) => x.codigos.split(" ").some((c) => c.toLowerCase() === codigo.toLowerCase()));
      if (!f) return setError(`El código ${codigo} no es de un producto de este conteo.`);
      setError("");
      setContado((c) => ({ ...c, [f.productoId]: String((Number(c[f.productoId]) || 0) + 1) }));
      // Que se vea lo que se acaba de escanear aunque esté en otra página.
      const i = visibles.indexOf(f);
      if (i >= 0) setPagina(Math.floor(i / POR_PAGINA) + 1);
    },
    { activo: !!conteo && !pidePin, debounceMs: config.escaner_debounce_ms },
  );

  if (conteo === undefined) return null;
  if (!conteo)
    return (
      <section className="card">
        <p>Cuente lo que hay en el estante. Lo contado se guarda solo: puede seguir otro día. Al aplicar, las diferencias quedan como ajustes con motivo «Conteo».</p>
        <Field label="Departamento a contar">
          <select value={depto} onChange={(e) => setDepto(e.target.value)}>
            <option value="">Todos</option>
            {departamentos.map((d) => (
              <option key={d.id} value={d.id}>
                {d.nombre}
              </option>
            ))}
          </select>
        </Field>
        <Mensaje error={error} />
        <Button
          variante="primario"
          icono={ClipboardCheck}
          onClick={async () => {
            setError("");
            try {
              const id = await guardarConteo(null, depto || null, {});
              await abrir(await conteoAbierto().then((c) => c ?? { id, departamentoId: depto || null, datos: {}, actualizadoEn: "" }));
            } catch (e) {
              setError(textoError(e));
            }
          }}
        >
          Empezar conteo
        </Button>
      </section>
    );

  const cuenta = (f: FilaConteo) => (contado[f.productoId]?.trim() ? Number(contado[f.productoId]) : null);
  // La búsqueda es sobre todo el conteo, no solo la página que se ve.
  const palabras = normalizar(buscar).split(" ").filter(Boolean);
  const visibles = filas.filter(
    (f) =>
      (!soloDiferencias || (cuenta(f) != null && cuenta(f) !== f.sistema)) &&
      palabras.every((w) => normalizar(f.nombre).includes(w) || f.codigos.toLowerCase().includes(w)),
  );
  const paginaVisible = Math.min(pagina, Math.max(1, Math.ceil(visibles.length / POR_PAGINA)));
  const contados = filas.filter((f) => cuenta(f) != null).length;

  return (
    <section className="card">
      <p className="muted">
        {departamentos.find((d) => d.id === conteo.departamentoId)?.nombre ?? "Todos los departamentos"} · contados {contados} de {filas.length}. Escanee para sumar 1 o escriba la cantidad; se guarda solo.
      </p>
      <div className="row abajo">
        <Field label="Buscar en el conteo" flex={1}>
          <input type="search" value={buscar} placeholder="Nombre o código" onChange={(e) => (setBuscar(e.target.value), setPagina(1))} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={soloDiferencias} onChange={(e) => (setSoloDiferencias(e.target.checked), setPagina(1))} /> Ver solo diferencias
        </label>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Producto</th>
            <th className="num">Sistema</th>
            <th className="num">Contado</th>
            <th className="num">Diferencia</th>
          </tr>
        </thead>
        <tbody>
          {visibles.slice((paginaVisible - 1) * POR_PAGINA, paginaVisible * POR_PAGINA).map((f) => {
            const c = cuenta(f);
            const d = c == null ? null : c - f.sistema;
            return (
              <tr key={f.productoId}>
                <td>
                  <strong>{f.nombre}</strong>
                  {!f.controla && <div className="muted">Sin control: al contarlo queda bajo control</div>}
                </td>
                <td className="num">{f.sistema}</td>
                <td className="num">
                  <input className="small" inputMode="numeric" aria-label={`Contado de ${f.nombre}`} value={contado[f.productoId] ?? ""} onChange={(e) => setContado({ ...contado, [f.productoId]: e.target.value.replace(/\D/g, "") })} />
                </td>
                <td className="num">{d == null ? "—" : d > 0 ? `+${d}` : d}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {visibles.length === 0 && <p className="muted">Nada coincide con la búsqueda.</p>}
      <Paginacion nombre="el conteo" pagina={paginaVisible} porPagina={POR_PAGINA} total={visibles.length} onPagina={setPagina} />
      <Mensaje error={error} />
      <div className="row">
        <Button icono={Save} onClick={() => void guardar()}>
          Guardar a medias
        </Button>
        <Button
          variante="primario"
          icono={CheckCircle2}
          disabled={!contados}
          onClick={async () => {
            if (await guardar(false)) setPidePin(true);
          }}
        >
          Aplicar conteo
        </Button>
        <Button
          variante="peligro"
          icono={Trash2}
          onClick={async () => {
            if (!(await confirmar({ titulo: "¿Descartar el conteo?", texto: "Se pierde lo contado. El inventario no cambia.", aceptar: "Descartar", peligro: true }))) return;
            try {
              await descartarConteo(conteo.id);
              setConteo(null);
              setContado({});
              toast.ok("Conteo descartado. El inventario no cambió.");
            } catch (e) {
              setError(textoError(e));
            }
          }}
        >
          Descartar
        </Button>
      </div>
      {pidePin && (
        <PinDueno
          motivo={`Se ajustan ${filas.filter((f) => cuenta(f) != null && cuenta(f) !== f.sistema).length} producto(s) a lo contado.`}
          onCerrar={() => setPidePin(false)}
          onPin={async (pin) => {
            const n = await aplicarConteo(conteo.id, pin);
            setPidePin(false);
            setConteo(null);
            setContado({});
            toast.ok(`Conteo aplicado: ${n} producto(s) ajustados.`);
          }}
        />
      )}
    </section>
  );
}
