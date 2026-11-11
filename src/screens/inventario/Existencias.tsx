// Existencias con filtros, ajuste manual (PIN del dueño), kardex y ficha (control, mínimo, costo).
import { ClipboardList, History, Save, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSesion } from "../../app/sesion";
import Mensaje, { textoError } from "../../components/Mensaje";
import Modal from "../../components/Modal";
import PinDueno from "../../components/PinDueno";
import { listarDepartamentos } from "../../db/departamentos";
import {
  ajustarInventario,
  guardarInventarioProducto,
  kardex,
  listarInventario,
  NOMBRE_ESTADO,
  NOMBRE_TIPO,
  rangoDias,
  type EstadoInventario,
  type FilaInventario,
  type FilaKardex,
  type FiltroInventario,
} from "../../db/inventario";
import { CABECERA_KARDEX, exportarCsv, exportarPdf, filaKardex, pdfMovimientos } from "../../lib/inventario";
import { monto } from "../../lib/tickets";
import type { Departamento } from "../../tipos";
import Badge, { type Tono } from "../../ui/Badge";
import Button from "../../ui/Button";
import EmptyState from "../../ui/EmptyState";
import Field from "../../ui/Field";
import Paginacion from "../../ui/Paginacion";
import { useToast } from "../../ui/Toast";
import { useEnvio } from "../../ui/useEnvio";

const POR_PAGINA = 100;

export const TONO_ESTADO: Record<EstadoInventario, Tono> = { sin_control: "info", con_existencia: "ok", bajo_minimo: "aviso", agotado: "aviso", negativo: "error" };

export function EstadoBadge({ estado }: { estado: EstadoInventario }) {
  return <Badge tono={TONO_ESTADO[estado]}>{NOMBRE_ESTADO[estado]}</Badge>;
}

const FILTROS: [FiltroInventario, string][] = [
  ["con_control", "Con control"],
  ["", "Todos"],
  ["bajo_minimo", "Bajo mínimo"],
  ["agotados", "Agotados"],
  ["negativos", "Negativos"],
  ["sin_barras", "Sin código de barras"],
  ["sin_costo", "Sin costo"],
  ["sin_control", "Sin control"],
];

export default function Existencias(p: { filtroInicial?: FiltroInventario; onFiltro?(f: FiltroInventario): void }) {
  const [departamentos, setDepartamentos] = useState<Departamento[]>([]);
  const [texto, setTexto] = useState("");
  const [depto, setDepto] = useState("");
  const [filtro, setFiltroLocal] = useState<FiltroInventario>(p.filtroInicial ?? "con_control");
  const setFiltro = (f: FiltroInventario) => (setFiltroLocal(f), p.onFiltro?.(f));
  // El botón «Ver cuáles» de arriba cambia el filtro sin borrar lo que se buscó.
  useEffect(() => setFiltroLocal(p.filtroInicial ?? "con_control"), [p.filtroInicial]);
  const [filas, setFilas] = useState<FilaInventario[]>([]);
  const [total, setTotal] = useState<number | null>(null); // null: todavía cargando
  const [pagina, setPagina] = useState(1);
  const [error, setError] = useState("");
  const [dialogo, setDialogo] = useState<{ tipo: "ajuste" | "kardex" | "ficha"; fila: FilaInventario } | null>(null);
  const consulta = useRef(0);

  useEffect(() => void listarDepartamentos().then(setDepartamentos, (e) => setError(textoError(e))), []);

  /** Una página; la búsqueda y el filtro son sobre todo el inventario. */
  async function cargar(nPagina = pagina) {
    const n = ++consulta.current;
    try {
      const r = await listarInventario({ texto, departamentoId: depto || undefined, filtro, limite: POR_PAGINA, desplazamiento: (nPagina - 1) * POR_PAGINA });
      if (n !== consulta.current) return;
      if (!r.filas.length && nPagina > 1) return void cargar(1);
      setFilas(r.filas);
      setTotal(r.total);
      setPagina(nPagina);
    } catch (e) {
      setError(textoError(e));
    }
  }
  useEffect(() => {
    const t = setTimeout(() => void cargar(1), 150);
    return () => clearTimeout(t);
  }, [texto, depto, filtro]);

  const cerrar = (recargar: boolean) => (setDialogo(null), recargar && void cargar());

  return (
    <section className="card">
      <div className="row">
        <Field label="Buscar" flex={2}>
          <input type="search" value={texto} placeholder="Nombre o código" onChange={(e) => setTexto(e.target.value)} />
        </Field>
        <Field label="Departamento" flex={1}>
          <select value={depto} onChange={(e) => setDepto(e.target.value)}>
            <option value="">Todos</option>
            {departamentos.map((d) => (
              <option key={d.id} value={d.id}>
                {d.nombre}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Mostrar" flex={1}>
          <select value={filtro} onChange={(e) => setFiltro(e.target.value as FiltroInventario)}>
            {FILTROS.map(([id, t]) => (
              <option key={id} value={id}>
                {t}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Mensaje error={error} />
      {total === null ? (
        <p className="muted">Cargando…</p>
      ) : filas.length === 0 ? (
        filtro === "con_control" && !texto && !depto ? (
          <EmptyState
            icono={ClipboardList}
            titulo="Todavía ningún producto lleva inventario"
            texto="Cargue las existencias en «Carga inicial» o con un conteo físico, o registre una entrada de mercadería. Para ver todo el catálogo, elija «Todos» en Mostrar."
          />
        ) : (
          <EmptyState icono={ClipboardList} titulo="No hay productos con ese filtro" texto="Pruebe con otro filtro o búsqueda." />
        )
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Producto</th>
              <th className="col-sec">Departamento</th>
              <th>Estado</th>
              <th className="num">Existencia</th>
              <th className="num">Mínimo</th>
              <th className="num">Costo</th>
              <th>
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.productoId}>
                <td className="nombre-celda">
                  <strong>{f.nombre}</strong>
                  {f.codigos && <div className="muted mono">{f.codigos}</div>}
                </td>
                <td className="col-sec">{f.departamento}</td>
                <td>
                  <EstadoBadge estado={f.estado} />
                </td>
                <td className="num">{f.controla ? f.existencia : "—"}</td>
                <td className="num">{f.minimo || "—"}</td>
                <td className="num">{f.costo == null ? "—" : monto(f.costo)}</td>
                <td>
                  <div className="acciones">
                    <Button icono={SlidersHorizontal} title="Ajustar existencia" onClick={() => setDialogo({ tipo: "ajuste", fila: f })} aria-label={`Ajustar ${f.nombre}`}>
                      Ajustar
                    </Button>
                    <Button icono={History} title="Kardex" onClick={() => setDialogo({ tipo: "kardex", fila: f })} aria-label={`Kardex de ${f.nombre}`}>
                      Kardex
                    </Button>
                    <Button icono={Save} title="Mínimo y costo" onClick={() => setDialogo({ tipo: "ficha", fila: f })} aria-label={`Mínimo y costo de ${f.nombre}`}>
                      Mínimo y costo
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {total !== null && <Paginacion nombre="existencias" pagina={pagina} porPagina={POR_PAGINA} total={total} onPagina={(n) => void cargar(n)} />}
      {dialogo?.tipo === "ajuste" && <AjusteDialogo fila={dialogo.fila} onCerrar={cerrar} />}
      {dialogo?.tipo === "kardex" && <KardexDialogo fila={dialogo.fila} onCerrar={() => cerrar(false)} />}
      {dialogo?.tipo === "ficha" && <FichaDialogo fila={dialogo.fila} onCerrar={cerrar} />}
    </section>
  );
}

function AjusteDialogo(p: { fila: FilaInventario; onCerrar(recargar: boolean): void }) {
  const { config } = useSesion();
  const toast = useToast();
  const [modo, setModo] = useState<"nueva" | "diferencia">("nueva");
  const [cantidad, setCantidad] = useState("");
  const [motivo, setMotivo] = useState("");
  const [detalle, setDetalle] = useState("");
  const [pidePin, setPidePin] = useState(false);
  const n = Number(cantidad);
  const valido = cantidad.trim() !== "" && Number.isInteger(n) && motivo && (motivo !== "Otro" || detalle.trim().length >= 3);
  return (
    <Modal titulo={`Ajustar: ${p.fila.nombre}`} onCerrar={() => p.onCerrar(false)} ancho={480}>
      <p>
        Existencia en el sistema: <strong>{p.fila.existencia}</strong>
      </p>
      <div className="row" role="radiogroup" aria-label="Tipo de ajuste">
        <label className="row">
          <input type="radio" checked={modo === "nueva"} onChange={() => setModo("nueva")} /> Cantidad nueva
        </label>
        <label className="row">
          <input type="radio" checked={modo === "diferencia"} onChange={() => setModo("diferencia")} /> Diferencia (+ / −)
        </label>
      </div>
      <Field label={modo === "nueva" ? "Cantidad que hay" : "Diferencia (p. ej. -2)"}>
        <input autoFocus inputMode="numeric" value={cantidad} onChange={(e) => setCantidad(e.target.value.replace(/[^\d-]/g, ""))} />
      </Field>
      <Field label="Motivo">
        <select value={motivo} onChange={(e) => setMotivo(e.target.value)}>
          <option value="">Elija…</option>
          {config.inventario_motivos_ajuste.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </Field>
      <Field label={motivo === "Otro" ? "Escriba el motivo" : "Detalle (opcional)"}>
        <input value={detalle} maxLength={200} onChange={(e) => setDetalle(e.target.value)} />
      </Field>
      <Button variante="primario" disabled={!valido} onClick={() => setPidePin(true)}>
        Ajustar
      </Button>
      {pidePin && (
        <PinDueno
          motivo={`Ajuste de inventario de ${p.fila.nombre}.`}
          onCerrar={() => setPidePin(false)}
          onPin={async (pin) => {
            const nueva = await ajustarInventario({ productoId: p.fila.productoId, nueva: modo === "nueva" ? n : null, diferencia: modo === "diferencia" ? n : null, motivo, detalle }, pin);
            toast.ok(`Ajustado. Existencia: ${nueva}.`);
            p.onCerrar(true);
          }}
        />
      )}
    </Modal>
  );
}

const hoy = () => new Date().toLocaleDateString("sv-SE");

function KardexDialogo(p: { fila: FilaInventario; onCerrar(): void }) {
  const toast = useToast();
  const [desde, setDesde] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toLocaleDateString("sv-SE");
  });
  const [hasta, setHasta] = useState(hoy);
  const [filas, setFilas] = useState<FilaKardex[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!desde || !hasta) return;
    kardex(p.fila.productoId, ...rangoDias(desde, hasta)).then(setFilas, (e) => setError(textoError(e)));
  }, [desde, hasta]);
  return (
    <Modal titulo={`Kardex: ${p.fila.nombre}`} onCerrar={p.onCerrar} ancho={900}>
      <div className="row">
        <Field label="Desde">
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </Field>
        <Field label="Hasta">
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </Field>
        <Button
          disabled={!filas.length}
          onClick={async () => {
            try {
              toast.guardado("Archivo guardado.", await exportarCsv(`kardex-${desde}-${hasta}`, [CABECERA_KARDEX, ...filas.map(filaKardex)]));
            } catch (e) {
              setError(textoError(e));
            }
          }}
        >
          Exportar CSV
        </Button>
        <Button
          disabled={!filas.length}
          onClick={async () => {
            try {
              toast.guardado("Archivo guardado.", await exportarPdf(`kardex-${desde}-${hasta}`, `Kardex: ${p.fila.nombre}`, `Del ${desde} al ${hasta}${p.fila.codigos ? ` · ${p.fila.codigos}` : ""}`, pdfMovimientos(filas, false)));
            } catch (e) {
              setError(textoError(e));
            }
          }}
        >
          Exportar PDF
        </Button>
      </div>
      <Mensaje error={error} />
      {filas.length === 0 ? (
        <p className="muted">Sin movimientos en esas fechas.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Tipo</th>
              <th className="num">Cantidad</th>
              <th className="num">Existencia</th>
              <th>Motivo / referencia</th>
              <th>Usuario</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f, i) => (
              <tr key={i}>
                <td style={{ whiteSpace: "nowrap" }}>{new Date(f.fecha).toLocaleString("es-CR", { dateStyle: "short", timeStyle: "short" })}</td>
                <td>{NOMBRE_TIPO[f.tipo]}</td>
                <td className="num">{f.cantidad > 0 ? `+${f.cantidad}` : f.cantidad}</td>
                <td className="num">{f.existencia}</td>
                <td>{[f.motivo, f.referencia].filter(Boolean).join(" · ")}</td>
                <td>{f.usuario}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function FichaDialogo(p: { fila: FilaInventario; onCerrar(recargar: boolean): void }) {
  const [controla, setControla] = useState(p.fila.controla);
  const [minimo, setMinimo] = useState(String(p.fila.minimo));
  const [costo, setCosto] = useState(p.fila.costo == null ? "" : String(p.fila.costo));
  const toast = useToast();
  const { ocupado, error, enviar } = useEnvio();
  return (
    <Modal titulo={p.fila.nombre} onCerrar={() => p.onCerrar(false)} ancho={440}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void enviar(async () => {
            await guardarInventarioProducto(p.fila.productoId, controla, Number(minimo) || 0, costo.trim() === "" ? null : Number(costo));
            toast.ok(`${p.fila.nombre}: guardado.`);
            p.onCerrar(true);
          });
        }}
      >
        <label className="row">
          <input type="checkbox" checked={controla} onChange={(e) => setControla(e.target.checked)} /> Controla inventario (servicios como fotocopias, no)
        </label>
        <Field label="Mínimo (unidades)" ayuda="En este número o menos, el producto sale como «Bajo mínimo».">
          <input inputMode="numeric" value={minimo} onChange={(e) => setMinimo(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Field label="Último costo (¢, opcional)">
          <input inputMode="numeric" value={costo} onChange={(e) => setCosto(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Mensaje error={error} />
        <Button type="submit" variante="primario" icono={Save} disabled={ocupado}>
          Guardar
        </Button>
      </form>
    </Modal>
  );
}
