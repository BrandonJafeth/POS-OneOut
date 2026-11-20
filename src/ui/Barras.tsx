// Barras de una sola serie (ventas por día, por hora). Barra fina, extremo redondeado de 4 px anclado
// a la línea base, 2 px de separación, en `--muted` (un dato no es una acción: el acento no se usa).
// Pasar el puntero o enfocar una barra muestra su valor. La tabla de al lado es la vista accesible.
import { useState } from "react";
import { monto } from "../lib/tickets";

export default function Barras(p: { titulo: string; datos: { etiqueta: string; valor: number }[] }) {
  const [activo, setActivo] = useState<number | null>(null);
  const max = Math.max(1, ...p.datos.map((d) => d.valor));
  const alto = 160;
  if (!p.datos.length) return null;
  const sel = activo != null ? p.datos[activo] : null;
  return (
    <figure className="barras">
      <figcaption>
        {p.titulo}
        <span className="barras-valor" aria-live="polite">
          {sel ? `${sel.etiqueta}: ${monto(sel.valor)}` : `Máximo ${monto(max)}`}
        </span>
      </figcaption>
      <div className="barras-area" style={{ height: alto }} onPointerLeave={() => setActivo(null)}>
        {p.datos.map((d, i) => (
          <button
            key={d.etiqueta}
            type="button"
            className={activo === i ? "barra activa" : "barra"}
            aria-label={`${d.etiqueta}: ${monto(d.valor)}`}
            onPointerEnter={() => setActivo(i)}
            onFocus={() => setActivo(i)}
            onBlur={() => setActivo(null)}
          >
            <span style={{ height: `${Math.max(d.valor > 0 ? 2 : 0, (d.valor / max) * 100)}%` }} />
          </button>
        ))}
      </div>
      <div className="barras-ejes" aria-hidden>
        <span>{p.datos[0].etiqueta}</span>
        <span>{p.datos[p.datos.length - 1].etiqueta}</span>
      </div>
    </figure>
  );
}
