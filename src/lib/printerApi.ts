// Puente a los 2 comandos Rust. Fuera de Tauri (npm run dev en el navegador) avisa en vez de romper.
import { invoke, isTauri } from "@tauri-apps/api/core";

const SIN_TAURI = "No se está ejecutando dentro de Tauri (abra la app con npm run tauri dev).";

export async function listPrinters(): Promise<string[]> {
  if (!isTauri()) throw new Error(SIN_TAURI);
  return invoke<string[]>("list_printers");
}

export async function printRaw(printerName: string, data: Uint8Array): Promise<void> {
  if (!isTauri()) throw new Error(SIN_TAURI);
  // invoke serializa a JSON: un Uint8Array se convertiría en objeto, por eso se pasa como arreglo.
  await invoke("print_raw", { printerName, data: Array.from(data) });
}
