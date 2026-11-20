// "Preparar para el cliente": lo que tiene que estar listo antes de entregar. Rust decide cada punto
// (preparacion.rs); aquí solo se muestra qué falta y dónde se arregla.
import { CheckCircle2, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { textoError } from "../../components/Mensaje";
import { invocar } from "../../lib/invocar";
import Alert from "../../ui/Alert";
import Badge from "../../ui/Badge";
import Button from "../../ui/Button";

interface Punto {
  titulo: string;
  listo: boolean;
  detalle: string;
  /** Sin esto no se entrega. */
  obligatorio: boolean;
}

export default function Preparacion() {
  const [puntos, setPuntos] = useState<Punto[] | null>(null);
  const [error, setError] = useState("");
  const cargar = () => invocar<Punto[]>("sistema_preparacion").then(setPuntos, (e) => setError(textoError(e)));
  useEffect(() => void cargar(), []);
  const faltan = puntos?.filter((p) => !p.listo).length ?? 0;
  const obligatorios = puntos?.filter((p) => !p.listo && p.obligatorio).length ?? 0;
  return (
    <section className="card">
      {puntos &&
        (faltan === 0 ? (
          <Alert tono="ok" titulo="Lista para el cliente" />
        ) : obligatorios > 0 ? (
          <Alert tono="error" titulo={`No se puede entregar: faltan ${obligatorios} punto(s) obligatorio(s)`}>
            {faltan > obligatorios && `Y ${faltan - obligatorios} punto(s) más por revisar.`}
          </Alert>
        ) : (
          <Alert tono="aviso" titulo={`Faltan ${faltan} punto(s) antes de entregar`} />
        ))}
      <ul className="preparacion">
        {puntos?.map((p) => (
          <li key={p.titulo}>
            {p.listo ? <CheckCircle2 size={20} aria-hidden className="ok" /> : <CircleAlert size={20} aria-hidden className="falta" />}
            <div>
              <strong>{p.titulo}</strong> {p.obligatorio && <Badge tono={p.listo ? "ok" : "error"}>Obligatorio</Badge>}
              <span className="sr-only">{p.listo ? ": listo" : ": falta"}</span>
              <div className="muted">{p.detalle}</div>
            </div>
          </li>
        ))}
      </ul>
      {error && <Alert tono="error">{error}</Alert>}
      <Button onClick={() => void cargar()}>Revisar de nuevo</Button>
    </section>
  );
}
