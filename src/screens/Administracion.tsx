// Administración (dueño/técnico): fuera del flujo del cajero. Tarjetas grandes → subpantalla.
import { ArrowLeft, Building2, DatabaseBackup, FolderTree, Landmark, Printer, ScrollText, UserCog, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useSesion } from "../app/sesion";
import type { Permiso } from "../lib/permisos";
import Button from "../ui/Button";
import ConfigCaja from "./ConfigCaja";
import Departamentos from "./Departamentos";
import Impresoras from "./Impresoras";
import Historial from "./Historial";
import Negocio from "./Negocio";
import Respaldo from "./Respaldo";
import Usuarios from "./Usuarios";

type Sub = "usuarios" | "departamentos" | "negocio" | "impresoras" | "caja" | "respaldo" | "bitacora";

// permisos: basta uno.
const ACCESOS: { id: Sub; texto: string; detalle: string; icono: LucideIcon; permisos: Permiso[]; pantalla: ReactNode }[] = [
  { id: "usuarios", texto: "Usuarios", detalle: "Cajeros, PIN y accesos", icono: UserCog, permisos: ["usuarios"], pantalla: <Usuarios /> },
  { id: "departamentos", texto: "Departamentos", detalle: "Nombres, orden y color en la venta", icono: FolderTree, permisos: ["departamentos"], pantalla: <Departamentos /> },
  { id: "negocio", texto: "Datos del negocio", detalle: "Teléfono, logo, pie del tiquete y aviso de privacidad", icono: Building2, permisos: ["negocio"], pantalla: <Negocio /> },
  { id: "impresoras", texto: "Impresoras", detalle: "Tiquetes, cierres, etiquetas y gaveta", icono: Printer, permisos: ["impresoras.asignar"], pantalla: <Impresoras /> },
  { id: "caja", texto: "Caja y cierre", detalle: "Turno compartido, cierre Z y no venta", icono: Landmark, permisos: ["caja.admin", "config.tecnica"], pantalla: <ConfigCaja /> },
  { id: "respaldo", texto: "Respaldo", detalle: "Copia cifrada de toda la información", icono: DatabaseBackup, permisos: ["respaldo"], pantalla: <Respaldo /> },
  { id: "bitacora", texto: "Bitácora", detalle: "Quién hizo qué y cuándo: anulaciones, gaveta, cambios", icono: ScrollText, permisos: ["reportes"], pantalla: <Historial /> },
];

export default function Administracion() {
  const { puede } = useSesion();
  const [sub, setSub] = useState<Sub | null>(null);
  const accesos = ACCESOS.filter((a) => a.permisos.some((x) => puede(x)));
  const actual = accesos.find((a) => a.id === sub);

  if (actual)
    return (
      <div className="screen">
        <div>
          <Button icono={ArrowLeft} onClick={() => setSub(null)}>
            Volver a Administración
          </Button>
        </div>
        {actual.pantalla}
      </div>
    );

  return (
    <div className="screen">
      <h1>Administración</h1>
      <div className="accesos">
        {accesos.map((a) => (
          <button key={a.id} className="acceso" onClick={() => setSub(a.id)}>
            <a.icono size={30} aria-hidden />
            <strong>{a.texto}</strong>
            <span>{a.detalle}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
