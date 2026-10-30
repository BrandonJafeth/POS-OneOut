import { isTauri } from "@tauri-apps/api/core";
import {
  FileText,
  LogOut,
  Moon,
  Package,
  ReceiptText,
  Settings2,
  ShoppingCart,
  Sun,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { crearSesion, SesionCtx } from "./app/sesion";
import { textoError } from "./components/Mensaje";
import { guardarConfig, leerConfig, type ConfigApp } from "./db/config";
import { iniciarBase } from "./db/iniciar";
import { obtenerNegocio } from "./db/negocio";
import { tecnico, usarHasher } from "./db/usuarios";
import { pendientesFactura } from "./db/ventas";
import type { Permiso } from "./lib/permisos";
import { hasherTauri } from "./lib/pinApi";
import Administracion from "./screens/Administracion";
import Clientes from "./screens/Clientes";
import ConfigTecnica from "./screens/ConfigTecnica";
import Login from "./screens/Login";
import PendientesFactura from "./screens/PendientesFactura";
import PrimerArranque from "./screens/PrimerArranque";
import Productos from "./screens/Productos";
import Venta from "./screens/Venta";
import VentasHoy from "./screens/VentasHoy";
import { ROL_NOMBRE, type Usuario } from "./tipos";
import Alert from "./ui/Alert";
import Button from "./ui/Button";
import { ConfirmarProvider } from "./ui/Confirmar";
import { aplicarTema } from "./ui/tema";

export type Pagina = "venta" | "ventas" | "productos" | "clientes" | "facturas" | "admin" | "config";

interface Seccion {
  id: Pagina;
  texto: string;
  icono: LucideIcon;
  permisos: Permiso[]; // basta uno
}

// Lo del día a día (máximo 5). Lo avanzado va aparte, abajo.
const PRINCIPAL: Seccion[] = [
  { id: "venta", texto: "Venta", icono: ShoppingCart, permisos: ["venta"] },
  { id: "ventas", texto: "Ventas del día", icono: ReceiptText, permisos: ["venta"] },
  { id: "productos", texto: "Productos", icono: Package, permisos: ["productos"] },
  { id: "clientes", texto: "Clientes", icono: Users, permisos: ["clientes"] },
  { id: "facturas", texto: "Facturas pendientes", icono: FileText, permisos: ["facturas"] },
];
const AVANZADO: Seccion[] = [
  { id: "admin", texto: "Administración", icono: Settings2, permisos: ["usuarios", "negocio", "departamentos", "respaldo"] },
  { id: "config", texto: "Técnico", icono: Wrench, permisos: ["config.tecnica"] },
];

type Fase =
  | { f: "cargando" }
  | { f: "sinTauri" }
  | { f: "error"; mensaje: string }
  | { f: "primer" }
  | { f: "login" }
  | { f: "dentro"; usuario: Usuario };

export default function App() {
  const [fase, setFase] = useState<Fase>({ f: "cargando" });
  const [config, setConfig] = useState<ConfigApp | null>(null);
  const [nombreNegocio, setNombreNegocio] = useState("");

  useEffect(() => {
    aplicarTema("claro");
    if (!isTauri()) return setFase({ f: "sinTauri" });
    (async () => {
      await iniciarBase();
      usarHasher(hasherTauri);
      const c = await leerConfig();
      aplicarTema(c.tema, c.color_acento);
      setConfig(c);
      setNombreNegocio((await obtenerNegocio()).nombreComercial);
      setFase((await tecnico()) ? { f: "login" } : { f: "primer" });
    })().catch((e) => setFase({ f: "error", mensaje: textoError(e) }));
  }, []);

  const recargarConfig = useCallback(async () => {
    const c = await leerConfig();
    aplicarTema(c.tema, c.color_acento);
    setConfig(c);
  }, []);
  const salir = useCallback(() => {
    void obtenerNegocio().then((n) => setNombreNegocio(n.nombreComercial));
    setFase({ f: "login" });
  }, []);

  let contenido: ReactNode;
  if (fase.f === "cargando") contenido = <div className="centro muted">Abriendo la base de datos…</div>;
  else if (fase.f === "sinTauri")
    contenido = (
      <div className="centro">
        <Alert tono="aviso" titulo="Falta Tauri">
          Esta app necesita la base de datos y la impresora. Ábrala con: npm run tauri dev
        </Alert>
      </div>
    );
  else if (fase.f === "error")
    contenido = (
      <div className="centro">
        <Alert tono="error" titulo="No se pudo iniciar">
          {fase.mensaje}
        </Alert>
      </div>
    );
  else if (fase.f === "primer") contenido = <PrimerArranque onListo={(usuario) => setFase({ f: "dentro", usuario })} />;
  else if (fase.f === "login" || !config) contenido = <Login nombreNegocio={nombreNegocio} onEntrar={(usuario) => setFase({ f: "dentro", usuario })} />;
  else contenido = <Dentro usuario={fase.usuario} config={config} nombreNegocio={nombreNegocio} recargarConfig={recargarConfig} salir={salir} />;

  return <ConfirmarProvider>{contenido}</ConfirmarProvider>;
}

function Dentro(p: { usuario: Usuario; config: ConfigApp; nombreNegocio: string; recargarConfig(): Promise<void>; salir(): void }) {
  const sesion = useMemo(() => crearSesion(p.usuario, p.config, p.recargarConfig, p.salir), [p.usuario, p.config, p.recargarConfig, p.salir]);
  const visible = (s: Seccion) => s.permisos.some((x) => sesion.puede(x));
  const principal = PRINCIPAL.filter(visible);
  const avanzado = AVANZADO.filter(visible);
  // Todos entran a Venta: es la pantalla principal.
  const [pagina, setPagina] = useState<Pagina>(principal[0]?.id ?? "admin");
  const [facturas, setFacturas] = useState(0);

  // Contador de facturas pendientes en el menú: que no se olvide ninguna.
  useEffect(() => {
    if (!sesion.puede("facturas")) return;
    pendientesFactura(sesion.actor).then((l) => setFacturas(l.length), () => setFacturas(0));
  }, [pagina]);

  async function cambiarTema() {
    await guardarConfig(sesion.actor, "tema", p.config.tema === "oscuro" ? "claro" : "oscuro");
    await p.recargarConfig();
  }

  const paginas: Record<Pagina, ReactNode> = {
    venta: <Venta />,
    ventas: <VentasHoy />,
    productos: <Productos />,
    clientes: <Clientes />,
    facturas: <PendientesFactura />,
    admin: <Administracion />,
    config: <ConfigTecnica />,
  };

  const boton = (s: Seccion) => (
    <Button
      key={s.id}
      icono={s.icono}
      className={pagina === s.id ? "nav-item activo" : "nav-item"}
      aria-current={pagina === s.id ? "page" : undefined}
      onClick={() => setPagina(s.id)}
    >
      {s.texto}
      {s.id === "facturas" && facturas > 0 && (
        <span className="nav-contador" aria-label={`${facturas} pendientes`}>
          {facturas}
        </span>
      )}
    </Button>
  );

  return (
    <SesionCtx.Provider value={sesion}>
      <div className="app">
        <aside className="lateral" aria-label="Menú">
          <div className="lateral-marca">{p.nombreNegocio || "Punto de venta"}</div>
          <nav aria-label="Principal">{principal.map(boton)}</nav>
          {avanzado.length > 0 && (
            <nav className="avanzado" aria-label="Avanzado">
              {avanzado.map(boton)}
            </nav>
          )}
          <div className="lateral-pie">
            <div className="lateral-usuario">
              <strong>{p.usuario.nombre}</strong>
              <div className="muted">{ROL_NOMBRE[p.usuario.rol]}</div>
            </div>
            <Button icono={p.config.tema === "oscuro" ? Sun : Moon} className="nav-item" onClick={cambiarTema}>
              {p.config.tema === "oscuro" ? "Tema claro" : "Tema oscuro"}
            </Button>
            <Button icono={LogOut} className="nav-item" onClick={p.salir}>
              Salir
            </Button>
          </div>
        </aside>
        <main className="contenido">{paginas[pagina]}</main>
      </div>
    </SesionCtx.Provider>
  );
}
