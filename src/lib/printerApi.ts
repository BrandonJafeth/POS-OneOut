// Puente a los 2 comandos Rust de impresión. Fuera de Tauri avisa en vez de romper.
import { invocar } from "./invocar";

export function listPrinters(): Promise<string[]> {
  return invocar<string[]>("list_printers");
}

export async function printRaw(printerName: string, data: Uint8Array): Promise<void> {
  // invoke serializa a JSON: un Uint8Array se convertiría en objeto, por eso se pasa como arreglo.
  await invocar("print_raw", { printerName, data: Array.from(data) });
}
