// Campo que se reemplaza al tocarlo: escribir "8" sobre un 1 deja 8, no 18. En WebView2 el clic
// que enfoca pone el cursor al soltar el mouse y deshace el select(); solo ESE clic se ignora (el
// que enfoca el campo), los siguientes ponen el cursor donde se toque (para corregir un dígito).
import type { FocusEvent, MouseEvent } from "react";

export const seleccionarAlTocar = {
  onFocus(e: FocusEvent<HTMLInputElement>) {
    e.target.select();
  },
  onMouseDown(e: MouseEvent<HTMLInputElement>) {
    if (document.activeElement !== e.currentTarget) e.currentTarget.dataset.enfocando = "1";
  },
  onMouseUp(e: MouseEvent<HTMLInputElement>) {
    if (e.currentTarget.dataset.enfocando) e.preventDefault();
    delete e.currentTarget.dataset.enfocando;
  },
};
