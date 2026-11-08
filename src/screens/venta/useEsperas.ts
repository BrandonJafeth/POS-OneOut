// Ventas en espera (las pestañas del tiquete). Viven en SQLite: sobreviven a un apagón.
// Copia "al instante" en refs: dos lecturas del lector en el mismo milisegundo no deben pisarse
// (React todavía no volvió a dibujar entre una y otra).
import { useCallback, useEffect, useRef, useState } from "react";
import { useSesion } from "../../app/sesion";
import { textoError } from "../../components/Mensaje";
import { crearEspera, descartarEspera, guardarEspera, listarEsperas } from "../../db/ventas";
import { estadoVacio } from "../../lib/venta/calculo";
import type { EstadoEspera, VentaEspera } from "../../tipos";

export function useEsperas(onError: (msg: string) => void) {
  const { actor } = useSesion();
  const [esperas, setEsperas] = useState<VentaEspera[]>([]);
  const [activaId, setActivaId] = useState<string | null>(null);
  const esperasRef = useRef<VentaEspera[]>([]);
  const activaRef = useRef<string | null>(null);
  activaRef.current = activaId;
  const poner = (l: VentaEspera[]) => {
    esperasRef.current = l;
    setEsperas(l);
  };

  // El ref evita que React (StrictMode en desarrollo) la corra dos veces y cree dos pestañas.
  const iniciado = useRef(false);
  useEffect(() => {
    if (iniciado.current) return;
    iniciado.current = true;
    (async () => {
      let l = await listarEsperas();
      if (!l.length) l = [await crearEspera(actor, estadoVacio())];
      poner(l);
      setActivaId(l[0].id);
    })().catch((e) => onError(textoError(e)));
  }, []);

  const actual = (): EstadoEspera => esperasRef.current.find((e) => e.id === activaRef.current)?.estado ?? estadoVacio();

  /** Aplica un cambio a la venta activa y lo guarda en la base de inmediato, en fila (en orden). */
  const cola = useRef<Promise<void>>(Promise.resolve());
  const actualizar = useCallback((nuevo: EstadoEspera) => {
    const id = activaRef.current;
    if (!id) return;
    poner(esperasRef.current.map((e) => (e.id === id ? { ...e, estado: nuevo } : e)));
    cola.current = cola.current.then(() =>
      guardarEspera(id, nuevo).catch((e) => onError("No se pudo guardar la venta en espera: " + textoError(e))),
    );
  }, []);

  async function nueva(): Promise<boolean> {
    try {
      const e = await crearEspera(actor, estadoVacio());
      poner([...esperasRef.current, e].sort((a, b) => a.numero - b.numero));
      setActivaId(e.id);
      return true;
    } catch (err) {
      onError(textoError(err));
      return false;
    }
  }

  /** Saca una pestaña (cobrada o descartada). Si era la última, deja una vacía. */
  async function quitar(id: string) {
    let resto = esperasRef.current.filter((x) => x.id !== id);
    poner(resto);
    try {
      if (!resto.length) poner((resto = [await crearEspera(actor, estadoVacio())]));
    } catch (err) {
      onError(textoError(err));
    }
    if (activaRef.current === id) setActivaId(resto[0]?.id ?? null);
  }

  async function descartar(e: VentaEspera): Promise<boolean> {
    try {
      await descartarEspera(actor, e.id);
    } catch (err) {
      onError(textoError(err));
      return false;
    }
    await quitar(e.id);
    return true;
  }

  /** Vuelve a poner una venta descartada: en una pestaña vacía si hay, si no en una nueva. */
  async function recuperar(e: VentaEspera): Promise<boolean> {
    try {
      const vacia = esperasRef.current.find((x) => !x.estado.lineas.length);
      if (vacia) {
        await guardarEspera(vacia.id, e.estado);
        poner(esperasRef.current.map((x) => (x.id === vacia.id ? { ...x, estado: e.estado } : x)));
        setActivaId(vacia.id);
      } else {
        const n = await crearEspera(actor, e.estado);
        poner([...esperasRef.current, n]);
        setActivaId(n.id);
      }
      return true;
    } catch (err) {
      onError(textoError(err));
      return false;
    }
  }

  const activa = esperas.find((e) => e.id === activaId) ?? null;
  return { esperas, activa, activaId, setActivaId, actual, actualizar, nueva, quitar, descartar, recuperar };
}
