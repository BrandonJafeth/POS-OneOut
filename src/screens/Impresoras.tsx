// Impresoras (dueño y técnico): cada impresora con su conexión, ancho, code page, cortador y gaveta,
// y a cuál va cada documento. El destino se elige de lo que detecta Windows (Rust lo vuelve a revisar).
import { Pencil, Plus, Printer, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { textoError } from "../components/Mensaje";
import Modal from "../components/Modal";
import {
  aSettings,
  asignarImpresora,
  detectarImpresoras,
  DOCUMENTOS,
  eliminarImpresora,
  guardarImpresora,
  listarImpresoras,
  NOMBRE_CONEXION,
  probarImpresora,
  type Conexion,
  type DatosImpresora,
  type Detectadas,
  type Impresora,
} from "../db/impresoras";
import { CODE_PAGES } from "../lib/codepages";
import { paginaPrueba } from "../lib/impresion";
import Alert from "../ui/Alert";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import { useConfirmar } from "../ui/Confirmar";
import EmptyState from "../ui/EmptyState";
import Field from "../ui/Field";
import { useToast } from "../ui/Toast";
import { useSesion } from "../app/sesion";
import { useEnvio } from "../ui/useEnvio";

const NUEVA: DatosImpresora = { nombre: "", conexion: "windows", destino: "", anchoMm: 58, columnas: 32, codePage: 19, sinModoChino: true, barras: "B", cortador: false, gaveta: false, baudios: 9600 };
const BAUDIOS = [2400, 4800, 9600, 19200, 38400, 57600, 115200];

function opcionesDestino(d: Detectadas | null, conexion: Conexion): { valor: string; texto: string }[] {
  if (!d) return [];
  if (conexion === "windows") return d.windows.map((x) => ({ valor: x, texto: x }));
  if (conexion === "serial") return d.serial.map((x) => ({ valor: x, texto: x }));
  return d.usb.map((x) => ({ valor: x.ruta, texto: x.nombre }));
}

export default function Impresoras() {
  const [lista, setLista] = useState<Impresora[] | null>(null);
  const [detectadas, setDetectadas] = useState<Detectadas | null>(null);
  const [editando, setEditando] = useState<DatosImpresora | null>(null);
  const [error, setError] = useState("");
  const [probando, setProbando] = useState<string | null>(null);
  const toast = useToast();
  const confirmar = useConfirmar();
  // Técnico: agrega, cambia y quita impresoras (soporte). Dueño: las ve, las prueba y asigna documentos.
  const tecnico = useSesion().puede("impresoras");

  const cargar = async () => setLista(await listarImpresoras());
  const buscar = async () => setDetectadas(await detectarImpresoras());
  useEffect(() => {
    void cargar().catch((e) => setError(textoError(e)));
    if (tecnico) void buscar().catch((e) => setError(textoError(e)));
  }, []);

  async function hacer(f: () => Promise<unknown>, ok: string) {
    setError("");
    try {
      await f();
      await cargar();
      if (ok) toast.ok(ok);
    } catch (e) {
      setError(textoError(e));
    }
  }

  async function probar(i: Impresora) {
    setError("");
    setProbando(i.id);
    try {
      await probarImpresora(i.id, paginaPrueba(i.nombre, { ...aSettings(i), anchoMm: i.anchoMm }).bytes);
      toast.ok(`Prueba enviada a ${i.nombre}. Revise el papel.`);
    } catch (e) {
      setError(textoError(e));
      toast.error(`No se imprimió la prueba en ${i.nombre}`, textoError(e));
    } finally {
      setProbando(null);
    }
  }

  const asignada = (doc: string) => lista?.find((i) => i.documentos.includes(doc as never))?.id ?? "";
  const nombreDestino = (i: Impresora) => (i.conexion === "usb" ? (detectadas?.usb.find((u) => u.ruta === i.destino)?.nombre ?? "Impresora USB") : i.destino);
  const disponible = (i: Impresora) => !detectadas || opcionesDestino(detectadas, i.conexion).some((o) => o.valor === i.destino);

  return (
    <div className="screen">
      <h1>Impresoras</h1>
      {error && <Alert tono="error">{error}</Alert>}
      <section className="card">
        <div className="caja-cabeza">
          <h2>Impresoras de esta caja</h2>
          {tecnico && (
            <div className="fila-botones">
              <Button icono={RefreshCw} onClick={() => buscar().then(() => toast.ok("Lista actualizada."), (e) => setError(textoError(e)))}>
                Buscar de nuevo
              </Button>
              <Button variante="primario" icono={Plus} onClick={() => setEditando({ ...NUEVA })}>
                Agregar impresora
              </Button>
            </div>
          )}
        </div>
        {!tecnico && <p className="muted">Puede probarlas y elegir a cuál va cada documento. Para agregar, cambiar o quitar una impresora, llame al técnico.</p>}
        {lista && lista.length === 0 && (
          <EmptyState icono={Printer} titulo="No hay impresoras" texto={tecnico ? "Agregue la de tiquetes y, si tiene, la de etiquetas." : "Pida al técnico que conecte la de tiquetes."} />
        )}
        {lista && lista.length > 0 && (
          <table className="tbl">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Conexión</th>
                <th>Papel</th>
                <th>Documentos</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lista.map((i) => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.nombre}</strong>
                    <div className="muted">{nombreDestino(i)}</div>
                  </td>
                  <td>
                    {NOMBRE_CONEXION[i.conexion]}
                    {!disponible(i) && (
                      <div>
                        <Badge tono="aviso">No se encuentra</Badge>
                      </div>
                    )}
                  </td>
                  <td>
                    {i.anchoMm} mm · {i.columnas} col.
                    <div className="muted">
                      {[i.cortador && "cortador", i.gaveta && "gaveta"].filter(Boolean).join(" · ") || "sin cortador"}
                    </div>
                  </td>
                  <td>{i.documentos.length ? i.documentos.map((d) => DOCUMENTOS.find((x) => x.id === d)?.nombre).join(", ") : <span className="muted">Ninguno</span>}</td>
                  <td>
                    <div className="fila-botones">
                      <Button icono={Printer} disabled={probando === i.id} onClick={() => void probar(i)}>
                        Imprimir prueba
                      </Button>
                      {tecnico && (
                        <>
                          <Button variante="fantasma" icono={Pencil} aria-label={`Editar ${i.nombre}`} title="Editar" onClick={() => setEditando({ ...i })} />
                          <Button
                            variante="fantasma"
                            className="texto-peligro"
                            icono={Trash2}
                            aria-label={`Quitar ${i.nombre}`}
                            title="Quitar"
                            onClick={async () => {
                              if (await confirmar({ titulo: `¿Quitar ${i.nombre}?`, texto: "Los documentos que iban a esta impresora quedan sin asignar.", aceptar: "Quitar", peligro: true }))
                                void hacer(() => eliminarImpresora(i.id), "Impresora quitada.");
                            }}
                          />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {detectadas?.avisos.length ? <p className="muted">{detectadas.avisos.join(" · ")}</p> : null}
      </section>

      <section className="card">
        <h2>¿A qué impresora va cada documento?</h2>
        <p className="muted">Cada documento sale solo en la impresora que se elige aquí. Si una no responde, la venta se guarda igual y se puede reimprimir.</p>
        <div className="destinos">
          {DOCUMENTOS.map((d) => (
            <Field key={d.id} label={d.nombre} ayuda={d.detalle}>
              <select value={asignada(d.id)} onChange={(e) => void hacer(() => asignarImpresora(d.id, e.target.value || null), "Guardado.")}>
                <option value="">— Ninguna —</option>
                {(lista ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.nombre}
                  </option>
                ))}
              </select>
            </Field>
          ))}
        </div>
        {lista && lista.length > 0 && !lista.some((i) => i.gaveta) && (
          <Alert tono="aviso">
            Ninguna impresora tiene la gaveta.{" "}
            {tecnico ? "Márquela en la de tiquetes para que se abra con las ventas en efectivo." : "Pida al técnico que la configure para que se abra con las ventas en efectivo."}
          </Alert>
        )}
      </section>

      {editando && (
        <EditarImpresora
          datos={editando}
          detectadas={detectadas}
          otraConGaveta={lista?.find((i) => i.gaveta && i.id !== editando.id)?.nombre ?? null}
          onCerrar={() => setEditando(null)}
          onGuardar={async (d) => {
            await guardarImpresora(d);
            setEditando(null);
            await cargar();
            toast.ok("Impresora guardada.");
          }}
        />
      )}
    </div>
  );
}

function EditarImpresora(p: { datos: DatosImpresora; detectadas: Detectadas | null; otraConGaveta: string | null; onCerrar(): void; onGuardar(d: DatosImpresora): Promise<void> }) {
  const [d, setD] = useState<DatosImpresora>(p.datos);
  const { ocupado, error, enviar } = useEnvio();
  const set = (patch: Partial<DatosImpresora>) => setD({ ...d, ...patch });
  const opciones = opcionesDestino(p.detectadas, d.conexion);
  // Si se edita y la impresora está desconectada, igual se muestra la guardada (no se pierde).
  const conGuardada = p.datos.id && p.datos.conexion === d.conexion && p.datos.destino && !opciones.some((o) => o.valor === p.datos.destino) ? [{ valor: p.datos.destino, texto: `${p.datos.destino} (no se encuentra ahora)` }, ...opciones] : opciones;
  return (
    <Modal titulo={d.id ? `Editar ${p.datos.nombre}` : "Agregar impresora"} onCerrar={p.onCerrar} ancho={560}>
      <form onSubmit={(e) => (e.preventDefault(), void enviar(() => p.onGuardar(d)))}>
        <Field label="Nombre" ayuda="Como la llaman en el negocio: «Tiquetes», «Etiquetas».">
          <input autoFocus value={d.nombre} maxLength={40} onChange={(e) => set({ nombre: e.target.value })} />
        </Field>
        <Field label="Conexión">
          <select value={d.conexion} onChange={(e) => set({ conexion: e.target.value as Conexion, destino: "" })}>
            {(Object.keys(NOMBRE_CONEXION) as Conexion[]).map((c) => (
              <option key={c} value={c}>
                {NOMBRE_CONEXION[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={d.conexion === "serial" ? "Puerto" : "Impresora"} ayuda="Solo aparecen las que detecta la computadora. Si no está, revise que esté conectada y encendida.">
          <select value={d.destino} onChange={(e) => set({ destino: e.target.value })}>
            <option value="">— Elija —</option>
            {conGuardada.map((o) => (
              <option key={o.valor} value={o.valor}>
                {o.texto}
              </option>
            ))}
          </select>
        </Field>
        {d.conexion === "serial" && (
          <Field label="Velocidad (baudios)">
            <select value={d.baudios} onChange={(e) => set({ baudios: Number(e.target.value) })}>
              {BAUDIOS.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </Field>
        )}
        <div className="row">
          <Field label="Ancho del papel">
            <select value={d.anchoMm} onChange={(e) => set({ anchoMm: Number(e.target.value) as 58 | 80, columnas: Number(e.target.value) === 80 ? 48 : 32 })}>
              <option value={58}>58 mm</option>
              <option value={80}>80 mm</option>
            </select>
          </Field>
          <Field label="Columnas" ayuda="32 en 58 mm, 48 en 80 mm.">
            <input className="small" inputMode="numeric" value={d.columnas} onChange={(e) => set({ columnas: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
          </Field>
          <Field label="Code page">
            <select value={d.codePage} onChange={(e) => set({ codePage: Number(e.target.value) })}>
              {CODE_PAGES.map((c) => (
                <option key={c.escT} value={c.escT}>
                  {c.escT} — {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Código de barras">
            <select value={d.barras} onChange={(e) => set({ barras: e.target.value as "A" | "B" })}>
              <option value="B">Formato B</option>
              <option value="A">Formato A</option>
            </select>
          </Field>
        </div>
        <div className="casillas">
          <label>
            <input type="checkbox" checked={d.cortador} onChange={(e) => set({ cortador: e.target.checked })} /> Tiene cortador
          </label>
          <label>
            <input type="checkbox" checked={d.sinModoChino} onChange={(e) => set({ sinModoChino: e.target.checked })} /> Apagar modo chino (FS .)
          </label>
          <label>
            <input type="checkbox" checked={d.gaveta} onChange={(e) => set({ gaveta: e.target.checked })} /> La gaveta está conectada a esta impresora
          </label>
        </div>
        {d.gaveta && p.otraConGaveta && <Alert tono="aviso">La gaveta deja de estar en «{p.otraConGaveta}»: solo puede haber una.</Alert>}
        {error && <Alert tono="error">{error}</Alert>}
        <div className="fila-botones">
          <Button onClick={p.onCerrar}>Cancelar</Button>
          <span className="separador" />
          <Button type="submit" variante="primario" icono={Save} disabled={!d.nombre.trim() || !d.destino || ocupado}>
            Guardar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
