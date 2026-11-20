// Tabla de datos ordenable (Modern Web Guidance «sortable-table»): <caption>, un <button> dentro de
// cada <th scope="col">, aria-sort solo en la columna activa, texto con Intl.Collator y números como
// números. El orden se anuncia en una región aria-live. La misma definición de columnas sirve para
// exportar a CSV y PDF (src/lib/reportes/exportar.ts).
import { ArrowDown, ArrowUp } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

export interface Columna<T> {
  titulo: string;
  valor(f: T): string | number;
  /** Cómo se muestra (por defecto, el valor). */
  ver?(f: T): ReactNode;
  numero?: boolean;
}

const COLLATOR = new Intl.Collator("es-CR", { numeric: true, sensitivity: "base" });

export default function TablaOrdenable<T>(p: { titulo: string; columnas: Columna<T>[]; filas: T[]; total?: (string | number)[]; vacio?: string; ocultarTitulo?: boolean }) {
  const [orden, setOrden] = useState<{ i: number; dir: "ascending" | "descending" } | null>(null);
  const [aviso, setAviso] = useState("");
  const id = useId();
  const filas = orden
    ? [...p.filas].sort((a, b) => {
        const c = p.columnas[orden.i];
        const [x, y] = [c.valor(a), c.valor(b)];
        const r = typeof x === "number" && typeof y === "number" ? x - y : COLLATOR.compare(String(x), String(y));
        return orden.dir === "ascending" ? r : -r;
      })
    : p.filas;

  if (!p.filas.length) return <p className="muted">{p.vacio ?? "Sin datos en esas fechas."}</p>;
  return (
    <>
      <table className="tbl tabla-ordenable" aria-describedby={`${id}-orden`}>
        <caption className={p.ocultarTitulo ? "sr-only" : undefined}>{p.titulo}</caption>
        <thead>
          <tr>
            {p.columnas.map((c, i) => (
              <th key={c.titulo} scope="col" className={c.numero ? "num" : undefined} aria-sort={orden?.i === i ? orden.dir : undefined}>
                <button
                  type="button"
                  onClick={() => {
                    // La primera vez, los números de mayor a menor (lo que se busca en un reporte).
                    const dir = orden?.i === i ? (orden.dir === "ascending" ? "descending" : "ascending") : c.numero ? "descending" : "ascending";
                    setOrden({ i, dir });
                    setAviso(`Ordenado por ${c.titulo}, ${dir === "ascending" ? "de menor a mayor" : "de mayor a menor"}.`);
                  }}
                >
                  {c.titulo}
                  {orden?.i === i && (orden.dir === "ascending" ? <ArrowUp size={14} aria-hidden /> : <ArrowDown size={14} aria-hidden />)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filas.map((f, k) => (
            <tr key={k}>
              {p.columnas.map((c) => (
                <td key={c.titulo} className={c.numero ? "num" : undefined}>
                  {c.ver ? c.ver(f) : c.valor(f)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {p.total && (
          <tfoot>
            <tr className="total">
              {p.total.map((t, i) => (
                <td key={i} className={p.columnas[i]?.numero ? "num" : undefined}>
                  {t}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      <p id={`${id}-orden`} className="sr-only" aria-live="polite">
        {aviso}
      </p>
    </>
  );
}
