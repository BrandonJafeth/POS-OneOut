// Guardar una sola vez a la vez: un doble clic, doble Enter o el mouse rebotando no crean dos
// registros iguales. El candado es un ref (no el estado): el segundo clic llega antes de que React
// vuelva a dibujar el botón deshabilitado.
//   const { ocupado, error, enviar } = useEnvio();
//   <form onSubmit={(e) => (e.preventDefault(), void enviar(() => guardar(datos)))}>
//   <Button type="submit" disabled={ocupado}>Guardar</Button>
import { useRef, useState } from "react";
import { textoError } from "../components/Mensaje";

export function useEnvio() {
  const enCurso = useRef(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");
  /** Corre `f` si no hay otro envío en curso. true si terminó bien; si falla, deja el error en `error`. */
  async function enviar(f: () => Promise<unknown>): Promise<boolean> {
    if (enCurso.current) return false;
    enCurso.current = true;
    setOcupado(true);
    setError("");
    try {
      await f();
      return true;
    } catch (e) {
      setError(textoError(e));
      return false;
    } finally {
      enCurso.current = false;
      setOcupado(false);
    }
  }
  return { ocupado, error, setError, enviar };
}
