import Alert from "../ui/Alert";

/** Mensaje de error o éxito debajo de un formulario (con icono y texto, no solo color). Vacío = nada. */
export default function Mensaje({ error, ok }: { error?: string; ok?: string }) {
  if (error) return <Alert tono="error">{error}</Alert>;
  if (ok) return <Alert tono="ok">{ok}</Alert>;
  return null;
}

/** Marca que pone Rust a los errores de base de datos, archivos o sistema (util::TECNICO). */
export const MARCA_TECNICA = "ERROR_TECNICO: ";
export const MENSAJE_GENERAL = "No se pudo completar la acción. Intente de nuevo; si vuelve a pasar, contacte al administrador.";

// Errores técnicos que sí tienen una explicación para el usuario.
const CONOCIDOS: [RegExp, string][] = [
  [/turno cerrado: el pago/i, "La caja de esa venta ya se cerró: el pago no se puede cambiar. Si hace falta, el dueño lo corrige como ajuste en la caja de hoy."],
  [/turno cerrado: los montos/i, "La caja de esa venta ya se cerró: sus montos no se pueden cambiar."],
  [/la bitácora no se puede/i, "La bitácora no se puede modificar ni borrar."],
  [/Cierre la caja antes de cambiar «Da vuelto»/i, "Cierre la caja antes de cambiar «Da vuelto»: cambiaría el efectivo esperado de las ventas ya cobradas en el turno abierto."],
  [/UNIQUE constraint failed: codigos/i, "Ese código ya pertenece a otro producto."],
  [/UNIQUE constraint failed: departamentos/i, "Ya existe un departamento con ese código."],
  [/database is locked|database table is locked|busy/i, "El sistema está terminando otra operación. Espere unos segundos e intente de nuevo."],
  [/FOREIGN KEY constraint failed/i, "Uno de los datos ya no existe (quizás se borró en otra pantalla). Vuelva a cargar e intente de nuevo."],
  [/disk is full|no space/i, "El disco de la computadora está lleno. Avise al administrador."],
  [/respaldo_migracion/i, "No se pudo poner el respaldo al día con esta versión del programa. La base actual no se tocó. Avise al técnico (el detalle quedó en la bitácora)."],
  [/movimientos de inventario no se pueden/i, "Los movimientos de inventario no se pueden modificar ni borrar. Para corregir, haga un ajuste."],
  [/no cuadra con el kardex/i, "La existencia cambió mientras tanto. Vuelva a cargar e intente de nuevo."],
];

let verDetalle = false;
/** El técnico ve también el detalle técnico de cada error (los demás, solo el mensaje general). */
export function mostrarDetalleTecnico(si: boolean): void {
  verDetalle = si;
}

function esTecnico(e: unknown, m: string): boolean {
  if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError) return true;
  return m.startsWith(MARCA_TECNICA) || /invalid (args|type)|missing (required )?(key|field)|command .* not found|unknown variant/i.test(m);
}

/**
 * Texto para mostrarle al usuario. Los errores de negocio ya vienen explicados desde Rust
 * ("No tiene permiso para…", "Todavía faltan ¢500…"); los técnicos se cambian por un mensaje
 * general, sin datos internos, salvo para el técnico.
 */
export function textoError(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).trim();
  const detalle = m.startsWith(MARCA_TECNICA) ? m.slice(MARCA_TECNICA.length) : m;
  for (const [patron, texto] of CONOCIDOS) if (patron.test(detalle)) return texto;
  if (esTecnico(e, m)) return verDetalle ? `${MENSAJE_GENERAL} (Detalle técnico: ${detalle})` : MENSAJE_GENERAL;
  return m || MENSAJE_GENERAL;
}
