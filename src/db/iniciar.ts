import { usarDriver } from "./conexion";
import { crearDriverTauri } from "./driverTauri";

/** La base la abre Rust al arrancar (cifrada, con migraciones y revisión de integridad). */
export function iniciarBase(): void {
  usarDriver(crearDriverTauri());
}
