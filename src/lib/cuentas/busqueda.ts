// F10 (D3): qué búsqueda de apartados se manda a Rust. Mismas reglas que cuentas::buscar.
/** Igual que cuentas::buscar en Rust: número del apartado, teléfono (8 dígitos) o 3 letras. */
export function busquedaValida(texto: string): boolean {
  const t = texto.trim();
  const numero = /^\d{1,7}$/.test(t.replace(/^[AaCc]/, "").replace(/^-/, ""));
  const telefono = t.replace(/\D/g, "").length >= 8 && /^[\d\s\-+()]+$/.test(t);
  return numero || telefono || (t.match(/\p{L}/gu) ?? []).length >= 3;
}
