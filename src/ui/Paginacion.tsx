import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef } from "react";
import Button from "./Button";

/** Números a mostrar: primera, última y dos alrededor de la actual; null = "…". */
export function paginasVisibles(actual: number, total: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let p = 1; p <= total; p++) {
    if (p === 1 || p === total || Math.abs(p - actual) <= 2) out.push(p);
    else if (out[out.length - 1] !== null) out.push(null);
  }
  return out;
}

/**
 * Página 1, 2, 3… de una lista. `pagina` empieza en 1. La búsqueda la hace quien la usa sobre TODO
 * (no solo sobre la página): al cambiar el filtro, vuelve a la página 1.
 */
export default function Paginacion(p: { pagina: number; porPagina: number; total: number; onPagina(n: number): void; nombre?: string }) {
  const ref = useRef<HTMLElement>(null);
  const paginas = Math.max(1, Math.ceil(p.total / p.porPagina));
  if (p.total <= p.porPagina) return null;
  const desde = (p.pagina - 1) * p.porPagina + 1;
  const hasta = Math.min(p.total, p.pagina * p.porPagina);
  const ir = (n: number) => {
    if (n < 1 || n > paginas || n === p.pagina) return;
    p.onPagina(n);
    // La página nueva se lee desde arriba, no desde el pie donde quedó el clic.
    ref.current?.parentElement?.scrollIntoView({ block: "start" });
  };
  return (
    <nav ref={ref} className="paginacion" aria-label={`Páginas de ${p.nombre ?? "la lista"}`}>
      <span className="muted">
        {desde.toLocaleString("es-CR")}–{hasta.toLocaleString("es-CR")} de {p.total.toLocaleString("es-CR")}
      </span>
      <span className="separador" />
      <Button variante="fantasma" icono={ChevronLeft} disabled={p.pagina <= 1} onClick={() => ir(p.pagina - 1)}>
        Anterior
      </Button>
      {paginasVisibles(p.pagina, paginas).map((n, i) =>
        n === null ? (
          <span key={`e${i}`} className="muted" aria-hidden>
            …
          </span>
        ) : (
          <button key={n} type="button" className="pagina" aria-current={n === p.pagina ? "page" : undefined} aria-label={`Página ${n}`} onClick={() => ir(n)}>
            {n}
          </button>
        ),
      )}
      <Button variante="fantasma" icono={ChevronRight} disabled={p.pagina >= paginas} onClick={() => ir(p.pagina + 1)}>
        Siguiente
      </Button>
    </nav>
  );
}
