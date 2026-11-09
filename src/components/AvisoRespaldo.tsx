// Aviso discreto al dueño: respaldo automático sin configurar, último sin verificar, o una semana sin
// copiar los respaldos a la USB. No sale en la pantalla de Venta (no estorba para vender).
import { Usb } from "lucide-react";
import { useEffect, useState } from "react";
import { estadoAutomatico, usbConfirmado, type EstadoAutomatico } from "../lib/respaldoApi";
import Alert from "../ui/Alert";
import Button from "../ui/Button";

export default function AvisoRespaldo(p: { pagina: string }) {
  const [e, setE] = useState<EstadoAutomatico | null>(null);
  useEffect(() => void estadoAutomatico().then(setE, () => setE(null)), [p.pagina]);
  if (!e || p.pagina === "venta") return null;
  if (!e.configurado)
    return (
      <Alert tono="aviso" titulo="Sin respaldo automático">
        Si la computadora falla, se pierde todo lo registrado. Actívelo en Administración → Respaldo.
      </Alert>
    );
  if (e.ultimo && e.ultimoVerificado === false)
    return (
      <Alert tono="error" titulo="El último respaldo no se pudo verificar">
        Haga uno en Administración → Respaldo. Si se repite, avise al técnico.
      </Alert>
    );
  if (e.recordarUsb)
    return (
      <Alert tono="info" titulo="Copie los respaldos a la memoria USB">
        Una vez por semana, copie la carpeta de respaldos a una USB que se guarde fuera del negocio. <span className="mono" style={{ wordBreak: "break-all" }}>{e.carpeta}</span>
        <div style={{ marginTop: 8 }}>
          <Button icono={Usb} onClick={() => void usbConfirmado().then(() => estadoAutomatico().then(setE))}>
            Ya lo copié
          </Button>
        </div>
      </Alert>
    );
  return null;
}
