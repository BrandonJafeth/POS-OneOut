import { forwardRef, type InputHTMLAttributes } from "react";
import { conMiles } from "../lib/texto";
import { seleccionarAlTocar } from "./seleccionarAlTocar";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "placeholder"> {
  /** Texto con punto de miles ("3.500"); leerlo con leerMontoEntero. */
  valor: string;
  onCambio(texto: string): void;
  grande?: boolean;
}

/**
 * Único campo de dinero de la app. El monto se ve como valor real (nunca como texto gris de
 * ejemplo), con ¢ fijo y punto de miles; al tocarlo queda seleccionado, así escribir lo reemplaza.
 */
const CampoMonto = forwardRef<HTMLInputElement, Props>(function CampoMonto({ valor, onCambio, grande, className = "", onFocus, onMouseDown, onMouseUp, ...rest }, ref) {
  return (
    <span className={`monto-campo ${grande ? "grande" : ""}`}>
      <span aria-hidden>¢</span>
      <input
        ref={ref}
        className={`precio ${className}`}
        inputMode="numeric"
        autoComplete="off"
        value={valor}
        onFocus={(e) => (seleccionarAlTocar.onFocus(e), onFocus?.(e))}
        onMouseDown={(e) => (seleccionarAlTocar.onMouseDown(e), onMouseDown?.(e))}
        onMouseUp={(e) => (seleccionarAlTocar.onMouseUp(e), onMouseUp?.(e))}
        onChange={(e) => onCambio(conMiles(e.target.value))}
        {...rest}
      />
    </span>
  );
});

export default CampoMonto;
