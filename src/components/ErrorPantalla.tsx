// Si una pantalla falla al dibujarse, React la desmonta entera y queda la ventana en blanco (el
// cajero cree que se cerró la app). Esto muestra un aviso claro y deja seguir sin perder nada:
// lo cobrado y las ventas en espera ya están guardados en la base.
import { RefreshCw, RotateCcw } from "lucide-react";
import { Component, type ReactNode } from "react";
import Button from "../ui/Button";

export default class ErrorPantalla extends Component<{ children: ReactNode; todo?: boolean }, { error: boolean }> {
  state = { error: false };

  static getDerivedStateFromError() {
    return { error: true };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="screen" role="alert">
        <h1>Esta pantalla tuvo un problema</h1>
        <p>No se perdió nada: las ventas cobradas y las ventas en espera están guardadas.</p>
        <p className="muted">Si vuelve a pasar, anote qué estaba haciendo y avise al administrador.</p>
        <div className="row">
          {!this.props.todo && (
            <Button variante="primario" icono={RotateCcw} onClick={() => this.setState({ error: false })}>
              Volver a intentar
            </Button>
          )}
          <Button variante={this.props.todo ? "primario" : "normal"} icono={RefreshCw} onClick={() => window.location.reload()}>
            Recargar el programa
          </Button>
        </div>
      </div>
    );
  }
}
