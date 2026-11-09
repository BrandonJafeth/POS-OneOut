// Cuando la base no abre no hay forma de entrar: se ofrece restaurar un respaldo con su contraseña.
// La base que no abría no se borra: al reiniciar queda guardada aparte, con fecha.
import { DatabaseBackup, RotateCw } from "lucide-react";
import { useState } from "react";
import { restaurarSinBase } from "../db/usuarios";
import { invocar } from "../lib/invocar";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Field from "../ui/Field";
import { textoError } from "./Mensaje";

export default function RestaurarSinBase(p: { carpeta: string }) {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [contrasena, setContrasena] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [listo, setListo] = useState(false);

  if (listo)
    return (
      <section className="card">
        <Alert tono="ok" titulo="Respaldo verificado y listo">
          Al reiniciar, el programa abre con los datos del respaldo. La base anterior queda guardada aparte, con fecha.
        </Alert>
        <Button variante="primario" icono={RotateCw} onClick={() => void invocar("app_reiniciar")}>
          Reiniciar ahora
        </Button>
      </section>
    );

  return (
    <section className="card">
      <h2>Restaurar desde respaldo</h2>
      <p className="muted">
        Elija el archivo <span className="mono">.posbak</span> (por ejemplo, de la memoria USB) y escriba la contraseña con que se hizo. Sin esa contraseña el respaldo no
        se puede abrir. Nada se borra: la base actual queda guardada aparte.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!archivo) return;
          setError("");
          setOcupado(true);
          try {
            await restaurarSinBase(new Uint8Array(await archivo.arrayBuffer()), contrasena);
            setListo(true);
          } catch (err) {
            setError(textoError(err));
          } finally {
            setOcupado(false);
          }
        }}
      >
        <Field label="Archivo de respaldo">
          <input type="file" accept=".posbak" onChange={(e) => setArchivo(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="Contraseña del respaldo">
          <input type="password" autoComplete="off" value={contrasena} onChange={(e) => setContrasena(e.target.value)} />
        </Field>
        {error && <Alert tono="error">{error}</Alert>}
        <Button type="submit" variante="primario" icono={DatabaseBackup} disabled={!archivo || !contrasena || ocupado}>
          Restaurar
        </Button>
      </form>
      <p className="muted">
        Carpeta de datos: <span className="mono">{p.carpeta}</span>
      </p>
    </section>
  );
}
