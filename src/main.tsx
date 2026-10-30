import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/public-sans";
import "./styles.css";

// Sin ventanas nuevas ni navegación fuera de la app (Rust también lo bloquea en on_navigation/on_new_window).
window.open = () => null;
document.addEventListener(
  "click",
  (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (a && !a.href.startsWith("blob:") && new URL(a.href, location.href).origin !== location.origin) e.preventDefault();
  },
  true,
);
// Arrastrar un archivo a la ventana no debe abrirlo.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
