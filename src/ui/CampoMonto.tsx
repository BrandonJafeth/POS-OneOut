import { forwardRef, type InputHTMLAttributes } from "react";
import { conMiles } from "../lib/texto";

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
const CampoMonto = forwardRef<HTMLInputElement, Props>(function CampoMonto({ valor, onCambio, grande, className = "", onFocus, ...rest }, ref) {
  return (
    <span className={`monto-campo ${grande ? "grande" : ""}`}>
      <span aria-hidden>¢</span>
      <input
        ref={ref}
        className={`precio ${className}`}
        inputMode="numeric"
        autoComplete="off"
        value={valor}
        onFocus={(e) => (e.target.select(), onFocus?.(e))}
        onChange={(e) => onCambio(conMiles(e.target.value))}
        {...rest}
      />
    </span>
  );
});

export default CampoMonto;
