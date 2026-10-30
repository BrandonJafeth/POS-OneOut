// Confirmación solo cuando hay riesgo. Reemplaza window.confirm: mismo estilo, teclado y foco.
//   const confirmar = useConfirmar();
//   if (!(await confirmar({ titulo: "¿Eliminar?", texto: "…", aceptar: "Eliminar", peligro: true }))) return;
import { AlertTriangle } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import Button from "./Button";
import Modal from "./Modal";

interface Opciones {
  titulo: string;
  texto: ReactNode;
  aceptar?: string;
  peligro?: boolean;
}

const Ctx = createContext<(o: Opciones) => Promise<boolean>>(async () => false);

export function ConfirmarProvider({ children }: { children: ReactNode }) {
  const [abierto, setAbierto] = useState<(Opciones & { responder(v: boolean): void }) | null>(null);
  const confirmar = useCallback((o: Opciones) => new Promise<boolean>((responder) => setAbierto({ ...o, responder })), []);
  const responder = (v: boolean) => {
    abierto?.responder(v);
    setAbierto(null);
  };
  return (
    <Ctx.Provider value={confirmar}>
      {children}
      {abierto && (
        <Modal titulo={abierto.titulo} onCerrar={() => responder(false)} ancho={460}>
          <div className={abierto.peligro ? "confirmar peligro" : "confirmar"}>
            {abierto.peligro && <AlertTriangle size={28} aria-hidden />}
            <div>{abierto.texto}</div>
          </div>
          <div className="fila-botones">
            <Button onClick={() => responder(false)} autoFocus>
              Cancelar
            </Button>
            <Button variante={abierto.peligro ? "peligro-lleno" : "primario"} onClick={() => responder(true)}>
              {abierto.aceptar ?? "Aceptar"}
            </Button>
          </div>
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export function useConfirmar() {
  return useContext(Ctx);
}
