import { Plus, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useSesion } from "../../app/sesion";
import Mensaje, { textoError } from "../../components/Mensaje";
import { guardarBanco, guardarFormaPago, listarBancos, listarFormasPago } from "../../db/formasPago";
import type { Banco, FormaPago, TipoFormaPago } from "../../tipos";
import Button from "../../ui/Button";
import { useToast } from "../../ui/Toast";

const TIPOS: TipoFormaPago[] = ["efectivo", "tarjeta", "sinpe", "transferencia", "otro"];
const NUEVA: Omit<FormaPago, "id"> = { codigo: "", nombre: "", tipo: "otro", requiereBanco: false, requiereReferencia: false, daVuelto: false, pideUltimos4: false, orden: 99, activo: true };

export function FormasPago() {
  const { actor, caja } = useSesion();
  const [lista, setLista] = useState<(Omit<FormaPago, "id"> & { id?: string })[]>([]);
  const [guardadas, setGuardadas] = useState<FormaPago[]>([]);
  const [error, setError] = useState("");
  const toast = useToast();
  const cargar = () => listarFormasPago({ incluirInactivas: true }).then((l) => (setLista(l), setGuardadas(l)), (e) => setError(textoError(e)));
  useEffect(() => void cargar(), []);

  const set = (i: number, patch: Partial<FormaPago>) => setLista(lista.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const casilla = (i: number, k: "requiereBanco" | "requiereReferencia" | "daVuelto" | "pideUltimos4" | "activo") => (
    <input type="checkbox" aria-label={k} checked={lista[i][k]} onChange={(e) => set(i, { [k]: e.target.checked })} />
  );

  return (
    <section className="card">
      <p className="muted">Solo las que "dan vuelto" (efectivo) pueden pasar del total y abren la gaveta.</p>
      <Mensaje error={error} />
      <div className="tabla-scroll">
      <table className="tbl tbl-compacta">
        <thead>
          <tr>
            <th>Código</th>
            <th>Nombre</th>
            <th>Tipo</th>
            <th>Da vuelto</th>
            <th>Pide banco</th>
            <th>Pide referencia</th>
            <th>Pide últ. 4</th>
            <th>Orden</th>
            <th>Activa</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lista.map((f, i) => (
            <tr key={f.id ?? "nueva" + i}>
              <td>
                <input className="mini" aria-label="Código" value={f.codigo} onChange={(e) => set(i, { codigo: e.target.value })} />
              </td>
              <td>
                <input aria-label="Nombre" style={{ width: 170 }} value={f.nombre} onChange={(e) => set(i, { nombre: e.target.value })} />
              </td>
              <td>
                <select aria-label="Tipo" value={f.tipo} onChange={(e) => set(i, { tipo: e.target.value as TipoFormaPago })}>
                  {TIPOS.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </td>
              <td>{casilla(i, "daVuelto")}</td>
              <td>{casilla(i, "requiereBanco")}</td>
              <td>{casilla(i, "requiereReferencia")}</td>
              <td>{casilla(i, "pideUltimos4")}</td>
              <td>
                <input className="mini" aria-label="Orden" value={f.orden} onChange={(e) => set(i, { orden: Number(e.target.value) || 0 })} />
              </td>
              <td>{casilla(i, "activo")}</td>
              <td>
                <Button
                  variante="primario"
                  icono={Save}
                  onClick={async () => {
                    setError("");
                    // La base también lo impide (migración 10); aquí se explica antes de intentarlo.
                    if (caja?.turno && f.id && guardadas.find((g) => g.id === f.id)?.daVuelto !== f.daVuelto)
                      return setError("Cierre la caja antes de cambiar «Da vuelto»: cambiaría el efectivo esperado de las ventas ya cobradas en el turno abierto.");
                    try {
                      await guardarFormaPago(actor, f);
                      await cargar();
                      toast.ok(`"${f.nombre}" guardada.`);
                    } catch (e) {
                      setError(textoError(e));
                    }
                  }}
                >
                  Guardar
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div className="fila-botones">
        <Button icono={Plus} onClick={() => setLista([...lista, { ...NUEVA }])}>
          Nueva forma de pago
        </Button>
      </div>
    </section>
  );
}

export function Bancos() {
  const { actor } = useSesion();
  const [lista, setLista] = useState<(Omit<Banco, "id"> & { id?: string })[]>([]);
  const [error, setError] = useState("");
  const toast = useToast();
  const cargar = () => listarBancos({ incluirInactivos: true }).then(setLista, (e) => setError(textoError(e)));
  useEffect(() => void cargar(), []);
  const set = (i: number, patch: Partial<Banco>) => setLista(lista.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  return (
    <section className="card">
      <Mensaje error={error} />
      <p className="muted">La abreviatura es lo que sale en el tiquete y en el cierre (por ejemplo «BCR»). Vacía = el nombre.</p>
      <table className="tbl">
        <thead>
          <tr>
            <th>Banco</th>
            <th>Abreviatura</th>
            <th>Orden</th>
            <th />
            <th />
          </tr>
        </thead>
        <tbody>
          {lista.map((b, i) => (
            <tr key={b.id ?? "nuevo" + i}>
              <td>
                <input aria-label="Nombre del banco" value={b.nombre} onChange={(e) => set(i, { nombre: e.target.value })} />
              </td>
              <td>
                <input className="small" aria-label="Abreviatura en el tiquete" placeholder="BCR" maxLength={12} value={b.abreviatura} onChange={(e) => set(i, { abreviatura: e.target.value })} />
              </td>
              <td>
                <input className="mini" aria-label="Orden" value={b.orden} onChange={(e) => set(i, { orden: Number(e.target.value) || 0 })} />
              </td>
              <td>
                <label>
                  <input type="checkbox" checked={b.activo} onChange={(e) => set(i, { activo: e.target.checked })} /> Activo
                </label>
              </td>
              <td>
                <Button
                  variante="primario"
                  icono={Save}
                  onClick={async () => {
                    setError("");
                    try {
                      await guardarBanco(actor, b);
                      await cargar();
                      toast.ok(`"${b.nombre}" guardado.`);
                    } catch (e) {
                      setError(textoError(e));
                    }
                  }}
                >
                  Guardar
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fila-botones">
        <Button icono={Plus} onClick={() => setLista([...lista, { nombre: "", abreviatura: "", orden: 99, activo: true }])}>
          Nuevo banco
        </Button>
      </div>
    </section>
  );
}
