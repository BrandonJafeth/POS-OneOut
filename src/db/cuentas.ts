// Apartados y crédito. Todo lo decide Rust (src-tauri/src/cuentas.rs); los tipos salen de Rust
// (src/generados, ts-rs). La pantalla solo avisa mientras se escribe y muestra el error de Rust.
import type { AbonoFila } from "../generados/AbonoFila";
import type { CuentaDetalle } from "../generados/CuentaDetalle";
import type { CuentaFila } from "../generados/CuentaFila";
import type { Reglas } from "../generados/Reglas";
import type { ResultadoAbono } from "../generados/ResultadoAbono";
import { invocar } from "../lib/invocar";
import { ulid } from "../lib/ulid";
import type { EstadoEspera, PagoEntrada } from "../tipos";

export type { AbonoFila, CuentaDetalle, CuentaFila, Reglas, ResultadoAbono };

export const reglasCuentas = () => invocar<Reglas>("cuentas_reglas");

/** Id de operación para un abono: se genera al abrir el diálogo, así un doble clic no crea dos. */
export const nuevaOperacion = () => ulid();

/** La venta en espera pasa a ser un apartado con su primer abono (`monto`, pagado con `pagos`). */
export const crearApartado = (esperaId: string, estado: EstadoEspera, monto: number, pagos: PagoEntrada[], operacionId: string) =>
  invocar<ResultadoAbono>("cuenta_crear_apartado", { esperaId, estado, monto, pagos, operacionId });

/** Abono; si deja el saldo en 0, el apartado se liquida (se crea la venta) y, con `entregar`, se entrega. */
export const abonar = (cuentaId: string, monto: number, pagos: PagoEntrada[], operacionId: string, entregar: boolean) =>
  invocar<ResultadoAbono>("cuenta_abonar", { cuentaId, monto, pagos, operacionId, entregar });

export const entregarApartado = (cuentaId: string) => invocar<void>("cuenta_entregar", { cuentaId });
export const buscarCuentas = (texto: string) => invocar<CuentaFila[]>("cuenta_buscar", { texto });
export const obtenerCuenta = (id: string) => invocar<CuentaDetalle>("cuenta_obtener", { id });
export const imprimirCuenta = (cuentaId: string, datos: Uint8Array) => invocar<boolean>("cuenta_imprimir", { cuentaId, datos: Array.from(datos) });

export type FiltroCuentas = "abiertas" | "vencidas" | "pagadas" | "cerradas" | "credito";
export const listarCuentas = (filtro: FiltroCuentas) => invocar<CuentaFila[]>("cuenta_listar", { filtro });
export const cuentasVencidas = () => invocar<number>("cuenta_vencidas");

/** `devuelto`: lo que se le devuelve (el resto queda retenido); `enEfectivo`: la parte que sale de la gaveta. */
export const cancelarApartado = (cuentaId: string, pin: string, motivo: string, devuelto: number, enEfectivo: number) =>
  invocar<void>("cuenta_cancelar", { cuentaId, pin, motivo, devuelto, enEfectivo });
export const ajustarCuenta = (cuentaId: string, cambio: number, pin: string, motivo: string) => invocar<void>("cuenta_ajustar", { cuentaId, cambio, pin, motivo });
export const condonarCuenta = (cuentaId: string, pin: string, motivo: string, entregar: boolean) => invocar<string | null>("cuenta_condonar", { cuentaId, pin, motivo, entregar });
export const prorrogarCuenta = (cuentaId: string, fechaLimite: string, motivo: string) => invocar<void>("cuenta_prorrogar", { cuentaId, fechaLimite, motivo });
export const anularAbono = (abonoId: string, pin: string, motivo: string, devolucionEfectivo: number) => invocar<void>("abono_anular", { abonoId, pin, motivo, devolucionEfectivo });
export const fijarLimiteCredito = (clienteId: string, limite: number | null, pin: string) => invocar<void>("cliente_limite_credito", { clienteId, limite, pin });
/** El cajero solo sabe si alcanza; nunca el límite ni lo que debe el cliente. */
export const creditoAlcanza = (clienteId: string, monto: number) => invocar<boolean>("credito_alcanza", { clienteId, monto });
