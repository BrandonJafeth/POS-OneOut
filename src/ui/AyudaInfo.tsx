// Ayuda corta junto a un dato: ícono de información que abre un texto simple. <details> nativo:
// se abre con clic, Enter o Espacio y se lee con lector de pantalla, sin JavaScript propio.
import { Info } from "lucide-react";

export default function AyudaInfo(p: { texto: string; etiqueta?: string }) {
  return (
    <details className="ayuda-info">
      <summary aria-label={p.etiqueta ?? "Más información"} title={p.etiqueta ?? "Más información"}>
        <Info size={16} aria-hidden />
      </summary>
      <p>{p.texto}</p>
    </details>
  );
}
