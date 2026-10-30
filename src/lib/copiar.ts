/** Copia texto (separado por tabulaciones) para pegarlo en la tabla de pruebas, Excel o Word. */
export async function copiar(texto: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    window.prompt("Copie el texto:", texto);
  }
}
