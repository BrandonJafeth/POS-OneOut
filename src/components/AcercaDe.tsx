// «Acerca de»: versión del programa (la misma que va en el encabezado de cada respaldo), versión de
// la base y dónde están los datos. Es lo primero que pide el técnico cuando algo falla.
import { useEffect, useState } from "react";
import { estadoSistema, type EstadoSistema } from "../db/usuarios";
import Modal from "./Modal";
import { textoError } from "./Mensaje";

export default function AcercaDe(p: { onCerrar(): void }) {
  const [e, setE] = useState<EstadoSistema | null>(null);
  const [error, setError] = useState("");
  useEffect(() => void estadoSistema().then(setE, (x) => setError(textoError(x))), []);
  return (
    <Modal titulo="Acerca de Punto de Venta" onCerrar={p.onCerrar} ancho={480}>
      {error && <p className="muted">{error}</p>}
      {e && (
        <dl className="datos-lista">
          <dt>Versión</dt>
          <dd className="mono">{e.version}</dd>
          <dt>Versión de la base</dt>
          <dd className="mono">{e.migracion}</dd>
          <dt>Base de datos</dt>
          <dd>{e.cifrada ? "Cifrada" : "Sin cifrar (versión de desarrollo)"}</dd>
          <dt>Carpeta de datos</dt>
          <dd className="mono" style={{ wordBreak: "break-all" }}>
            {e.carpeta}
          </dd>
        </dl>
      )}
    </Modal>
  );
}
