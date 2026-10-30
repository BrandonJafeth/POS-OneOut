// Administración (dueño/técnico): fuera del flujo del cajero. Tarjetas grandes → subpantalla.
import { ArrowLeft, Building2, DatabaseBackup, FolderTree, UserCog, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useSesion } from "../app/sesion";
import type { Permiso } from "../lib/permisos";
import Button from "../ui/Button";
import Departamentos from "./Departamentos";
import Negocio from "./Negocio";
import Respaldo from "./Respaldo";
import Usuarios from "./Usuarios";

type Sub = "usuarios" | "departamentos" | "negocio" | "respaldo";

const ACCESOS: { id: Sub; texto: string; detalle: string; icono: LucideIcon; permiso: Permiso; pantalla: ReactNode }[] = [
  { id: "usuarios", texto: "Usuarios", detalle: "Cajeros, PIN y accesos", icono: UserCog, permiso: "usuarios", pantalla: <Usuarios /> },
  { id: "departamentos", texto: "Departamentos", detalle: "Nombres y orden de los departamentos", icono: FolderTree, permiso: "departamentos", pantalla: <Departamentos /> },
  { id: "negocio", texto: "Datos del negocio", detalle: "Teléfono, logo, pie del tiquete y aviso de privacidad", icono: Building2, permiso: "negocio", pantalla: <Negocio /> },
  { id: "respaldo", texto: "Respaldo", detalle: "Copia cifrada de toda la información", icono: DatabaseBackup, permiso: "respaldo", pantalla: <Respaldo /> },
];

export default function Administracion() {
  const { puede } = useSesion();
  const [sub, setSub] = useState<Sub | null>(null);
  const accesos = ACCESOS.filter((a) => puede(a.permiso));
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
