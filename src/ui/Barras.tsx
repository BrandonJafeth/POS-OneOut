// Barras de una serie (ventas por día, por hora), con una segunda serie opcional para comparar (el
// año pasado). Barra fina, extremo redondeado de 4 px anclado a la línea base, 2 px de separación, en
// `--muted`; la comparación va detrás, más ancha y en `--hair`/`--line` (un dato no es una acción: el
// acento no se usa). Con dos series hay leyenda. Pasar el puntero o enfocar una barra muestra su valor.
// La tabla de al lado es la vista accesible.
import { useState } from "react";
import { monto } from "../lib/tickets";

export default function Barras(p: { titulo: string; datos: { etiqueta: string; valor: number; antes?: number }[]; leyenda?: [string, string] }) {
  const [activo, setActivo] = useState<number | null>(null);
  const comparar = p.datos.some((d) => d.antes != null);
  const max = Math.max(1, ...p.datos.map((d) => Math.max(d.valor, d.antes ?? 0)));
  const alto = 180;
  if (!p.datos.length) return null;
  const sel = activo != null ? p.datos[activo] : null;
  const alto100 = (v: number) => `${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%`;
  const medio = p.datos.length > 4 ? p.datos[Math.floor(p.datos.length / 2)].etiqueta : null;
  return (
    <figure className="barras">
      <figcaption>
        <span>
          {p.titulo}
          {comparar && p.leyenda && (
            <span className="barras-leyenda">
              <span>
                <i className="muestra ahora" aria-hidden /> {p.leyenda[0]}
              </span>
              <span>
                <i className="muestra antes" aria-hidden /> {p.leyenda[1]}
              </span>
            </span>
          )}
        </span>
        <span className="barras-valor" aria-live="polite">
          {sel ? `${sel.etiqueta}: ${monto(sel.valor)}${comparar ? ` · ${p.leyenda?.[1] ?? "antes"} ${monto(sel.antes ?? 0)}` : ""}` : `Máximo ${monto(max)}`}
        </span>
      </figcaption>
      <div className="barras-area" style={{ height: alto }} onPointerLeave={() => setActivo(null)}>
        {p.datos.map((d, i) => (
          <button
            key={d.etiqueta}
            type="button"
            className={activo === i ? "barra activa" : "barra"}
            aria-label={`${d.etiqueta}: ${monto(d.valor)}${comparar ? `, ${p.leyenda?.[1] ?? "antes"}: ${monto(d.antes ?? 0)}` : ""}`}
            onPointerEnter={() => setActivo(i)}
            onFocus={() => setActivo(i)}
            onBlur={() => setActivo(null)}
          >
            {comparar && <span className="antes" style={{ height: alto100(d.antes ?? 0) }} />}
            <span style={{ height: alto100(d.valor) }} />
          </button>
        ))}
      </div>
      <div className="barras-ejes" aria-hidden>
        <span>{p.datos[0].etiqueta}</span>
        {medio && <span>{medio}</span>}
        <span>{p.datos.length > 1 ? p.datos[p.datos.length - 1].etiqueta : ""}</span>
      </div>
    </figure>
  );
}
