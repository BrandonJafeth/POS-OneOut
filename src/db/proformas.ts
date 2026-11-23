// Proformas (cotizaciones). Todo lo decide Rust (src-tauri/src/proformas.rs); tipos generados con ts-rs.
import type { AbrirProforma } from "../generados/AbrirProforma";
import type { ProformaDetalle } from "../generados/ProformaDetalle";
import type { ProformaFila } from "../generados/ProformaFila";
import type { ReporteProformas } from "../generados/ReporteProformas";
import { invocar } from "../lib/invocar";
import type { EstadoEspera } from "../tipos";

export type { ProformaDetalle, ProformaFila, ReporteProformas };
export type FiltroProformas = "" | "vigentes" | "vencidas" | "convertidas" | "anuladas";

/** Guarda la venta de la pestaña como proforma; con `reemplaza`, como versión nueva de esa proforma. */
export const guardarProforma = (esperaId: string, estado: EstadoEspera, reemplaza?: string | null) =>
  invocar<ProformaDetalle>("proforma_guardar", { esperaId, estado, reemplaza: reemplaza ?? null });
export const buscarProformas = (texto: string, filtro: FiltroProformas) => invocar<ProformaFila[]>("proforma_buscar", { texto, filtro });
export const obtenerProforma = (id: string) => invocar<ProformaDetalle>("proforma_obtener", { id });
export const imprimirProformaBytes = (id: string, datos: Uint8Array) => invocar<boolean>("proforma_imprimir", { id, datos: Array.from(datos) });
export const anularProforma = (id: string, motivo: string) => invocar<void>("proforma_anular", { id, motivo });
/** Líneas para una venta nueva (precio según la regla) y avisos por línea. */
export const abrirProforma = (id: string) => invocar<Omit<AbrirProforma, "estado"> & { estado: EstadoEspera }>("proforma_abrir", { id });
export const reporteProformas = (desde: string, hasta: string) => invocar<ReporteProformas>("proforma_reporte", { desde, hasta });

/** Prefijo del error de Rust cuando la venta ya no es igual a su proforma (proformas::NO_COINCIDE). */
export const NO_COINCIDE = "La venta ya no coincide con la proforma ";
