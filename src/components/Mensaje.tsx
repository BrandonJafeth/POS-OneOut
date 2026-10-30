import Alert from "../ui/Alert";

/** Mensaje de error o éxito debajo de un formulario (con icono y texto, no solo color). Vacío = nada. */
export default function Mensaje({ error, ok }: { error?: string; ok?: string }) {
  if (error) return <Alert tono="error">{error}</Alert>;
  if (ok) return <Alert tono="ok">{ok}</Alert>;
  return null;
}

/** Texto legible de cualquier error (los de Tauri llegan como string). */
export function textoError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
