import { isTauri } from "@tauri-apps/api/core";
import {
  Boxes,
  FileText,
  Landmark,
  Moon,
  Package,
  ReceiptText,
  Settings2,
  ShoppingCart,
  Sun,
  UserRoundCog,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { crearSesion, SesionCtx } from "./app/sesion";
import ErrorPantalla from "./components/ErrorPantalla";
import { MARCA_TECNICA, mostrarDetalleTecnico, textoError } from "./components/Mensaje";
import { estadoCaja, type EstadoCaja } from "./db/caja";
import { guardarConfig, leerConfig, type ConfigApp } from "./db/config";
import { iniciarBase } from "./db/iniciar";
import { cerrarSesion, estadoSistema, tocarSesion } from "./db/usuarios";
import { alertasInventario } from "./db/inventario";
import { pendientesFactura } from "./db/ventas";
import { alPerderSesion, SESION_EXPIRADA } from "./lib/invocar";
import { puede, type Permiso } from "./lib/permisos";
import { fechaHora } from "./lib/tickets";
import Administracion from "./screens/Administracion";
import Caja from "./screens/Caja";
import CambiarPinObligatorio from "./screens/CambiarPinObligatorio";
import Clientes from "./screens/Clientes";
import Inventario from "./screens/Inventario";
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
import { ToastProvider } from "./ui/Toast";
import { aplicarTema } from "./ui/tema";

export type Pagina = "venta" | "caja" | "ventas" | "productos" | "inventario" | "clientes" | "facturas" | "admin" | "config";

interface Seccion {
  id: Pagina;
  texto: string;
  icono: LucideIcon;
  permisos: Permiso[]; // basta uno
}

// Lo del día a día. Lo avanzado va aparte, abajo.
const PRINCIPAL: Seccion[] = [
  { id: "venta", texto: "Venta", icono: ShoppingCart, permisos: ["venta"] },
  { id: "caja", texto: "Caja", icono: Landmark, permisos: ["caja"] },
  { id: "ventas", texto: "Ventas del día", icono: ReceiptText, permisos: ["venta"] },
  { id: "productos", texto: "Productos", icono: Package, permisos: ["productos"] },
  { id: "inventario", texto: "Inventario", icono: Boxes, permisos: ["inventario"] },
  { id: "clientes", texto: "Clientes", icono: Users, permisos: ["clientes"] },
  { id: "facturas", texto: "Facturas pendientes", icono: FileText, permisos: ["facturas"] },
];
const AVANZADO: Seccion[] = [
  { id: "admin", texto: "Administración", icono: Settings2, permisos: ["usuarios", "negocio", "departamentos", "respaldo", "impresoras"] },
  { id: "config", texto: "Técnico", icono: Wrench, permisos: ["config.tecnica"] },
];

type Fase =
  | { f: "cargando" }
  | { f: "sinTauri" }
  | { f: "error"; mensaje: string }
  | { f: "primer" }
  | { f: "login" }
  | { f: "dentro"; usuario: Usuario; minutos: number };

export default function App() {
  const [fase, setFase] = useState<Fase>({ f: "cargando" });
  const [config, setConfig] = useState<ConfigApp | null>(null);
  const [nombreNegocio, setNombreNegocio] = useState("");
  const [avisoLogin, setAvisoLogin] = useState("");

  /** Antes de entrar solo se sabe lo que Rust deja ver sin sesión: nombre, tema y si falta el técnico. */
  const cargarSistema = useCallback(async () => {
    const s = await estadoSistema();
    // Al arrancar no hay sesión: se muestra el detalle para que el administrador sepa qué pasó.
    if (s.error) return setFase({ f: "error", mensaje: `${s.error.replace(MARCA_TECNICA, "")} Si no sabe cómo resolverlo, contacte al administrador.` });
    aplicarTema(s.tema === "oscuro" ? "oscuro" : "claro", typeof s.colorAcento === "string" ? s.colorAcento : "");
    setNombreNegocio(s.nombreNegocio);
    setFase(s.necesitaTecnico ? { f: "primer" } : { f: "login" });
  }, []);

  useEffect(() => {
    aplicarTema("claro");
    if (!isTauri()) return setFase({ f: "sinTauri" });
    iniciarBase();
    cargarSistema().catch((e) => setFase({ f: "error", mensaje: textoError(e) }));
  }, []);

  // Rust cerró la sesión (inactividad): de vuelta a la entrada.
  useEffect(
    () =>
      alPerderSesion((m) => {
        if (m !== SESION_EXPIRADA) return;
        setConfig(null);
        setAvisoLogin("La sesión se cerró por inactividad.");
        setFase({ f: "login" });
      }),
    [],
  );

  const entrar = useCallback(async (usuario: Usuario, minutos: number) => {
    setAvisoLogin("");
    // Con PIN pendiente de cambio Rust no deja leer nada: la configuración se carga después del cambio.
    if (!usuario.debeCambiarPin) {
      const c = await leerConfig();
      aplicarTema(c.tema, c.color_acento);
      setConfig(c);
    }
    mostrarDetalleTecnico(usuario.rol === "tecnico");
    setFase({ f: "dentro", usuario, minutos });
  }, []);

  const recargarConfig = useCallback(async () => {
    const c = await leerConfig();
    aplicarTema(c.tema, c.color_acento);
    setConfig(c);
  }, []);
  // Cambio de usuario: se cierra la sesión en Rust (el turno de caja sigue abierto) y se vuelve a
  // la lista de usuarios. Al entrar el siguiente, toda la pantalla se arma de cero según su rol:
  // no queda nada a la vista del anterior (ni totales, ni avisos, ni diálogos).
  const salir = useCallback((aviso = "") => {
    setAvisoLogin(aviso);
    void cerrarSesion()
      .catch(() => undefined)
      .then(() => cargarSistema())
      .catch((e) => setFase({ f: "error", mensaje: textoError(e) }));
    mostrarDetalleTecnico(false);
    setConfig(null);
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
  else if (fase.f === "primer") contenido = <PrimerArranque onListo={(u, m) => void entrar(u, m)} />;
  else if (fase.f === "dentro" && fase.usuario.debeCambiarPin)
    contenido = (
      <CambiarPinObligatorio
        usuario={fase.usuario}
        onSalir={salir}
        onListo={() => void entrar({ ...fase.usuario, debeCambiarPin: false }, fase.minutos).catch((e) => setFase({ f: "error", mensaje: textoError(e) }))}
      />
    );
  else if (fase.f === "login" || !config)
    contenido = (
      <>
        {avisoLogin && (
          <div className="aviso-flotante">
            <Alert tono="info">{avisoLogin}</Alert>
          </div>
        )}
        <Login nombreNegocio={nombreNegocio} onEntrar={(u, m) => entrar(u, m).catch((e) => setFase({ f: "error", mensaje: textoError(e) }))} />
      </>
    );
  else contenido = <Dentro key={fase.usuario.id} usuario={fase.usuario} minutos={fase.minutos} config={config} nombreNegocio={nombreNegocio} recargarConfig={recargarConfig} salir={salir} />;

  // La clave por usuario desmonta avisos y confirmaciones del usuario anterior al cambiar de usuario.
  const clave = fase.f === "dentro" ? fase.usuario.id : "fuera";
  return (
    <ConfirmarProvider key={clave}>
      <ToastProvider>{contenido}</ToastProvider>
    </ConfirmarProvider>
  );
}

function Dentro(p: { usuario: Usuario; minutos: number; config: ConfigApp; nombreNegocio: string; recargarConfig(): Promise<void>; salir(aviso?: string): void }) {
  const usaCaja = puede(p.usuario.rol, "caja");
  const [caja, setCaja] = useState<EstadoCaja | null>(null);
  const recargarCaja = useCallback(async () => {
    if (usaCaja) setCaja(await estadoCaja());
  }, [usaCaja]);
  const [pagina, setPagina] = useState<Pagina>("venta");
  const irA = useCallback((x: string) => setPagina(x as Pagina), []);
  const sesion = useMemo(
    () => crearSesion(p.usuario, p.config, p.recargarConfig, p.salir, caja, recargarCaja, irA),
    [p.usuario, p.config, p.recargarConfig, p.salir, caja, recargarCaja, irA],
  );
  const visible = (s: Seccion) => s.permisos.some((x) => sesion.puede(x));
  const principal = PRINCIPAL.filter(visible);
  const avanzado = AVANZADO.filter(visible);
  // Arranca en la primera sección que el rol puede usar (Venta para cajero y dueño).
  useEffect(() => setPagina(principal[0]?.id ?? avanzado[0]?.id ?? "admin"), []);
  const [facturas, setFacturas] = useState(0);
  // Aviso discreto al dueño (nunca al cajero en la venta): productos en su mínimo o por debajo.
  const [bajoMinimo, setBajoMinimo] = useState(0);
  useEffect(() => {
    if (!sesion.puede("inventario")) return;
    alertasInventario().then(setBajoMinimo, () => setBajoMinimo(0));
  }, [pagina]);

  useEffect(() => {
    void recargarCaja().catch(() => undefined);
  }, [pagina]);

  // Inactividad: cada tanto se avisa a Rust que hubo uso; sin uso por N minutos, se bloquea.
  const ultimo = useRef(Date.now());
  useEffect(() => {
    let avisado = 0;
    const actividad = () => {
      ultimo.current = Date.now();
      if (Date.now() - avisado > 60_000) {
        avisado = Date.now();
        void tocarSesion().catch(() => undefined);
      }
    };
    const t = setInterval(() => {
      if (Date.now() - ultimo.current > p.minutos * 60_000) p.salir("La sesión se cerró por inactividad.");
    }, 15_000);
    window.addEventListener("keydown", actividad, true);
    window.addEventListener("pointerdown", actividad, true);
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", actividad, true);
      window.removeEventListener("pointerdown", actividad, true);
    };
  }, [p.minutos, p.salir]);

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
    caja: <Caja />,
    ventas: <VentasHoy />,
    productos: <Productos />,
    inventario: <Inventario />,
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
      {s.id === "inventario" && bajoMinimo > 0 && (
        <span className="nav-contador" aria-label={`${bajoMinimo} bajo mínimo`}>
          {bajoMinimo}
        </span>
      )}
    </Button>
  );

  return (
    <SesionCtx.Provider value={sesion}>
      <div className="app">
        <aside className="lateral" aria-label="Menú">
          <div className="lateral-marca">{p.nombreNegocio || "Punto de venta"}</div>
          {usaCaja && caja && (
            <button className={caja.turno && !caja.deOtroDia && caja.puedeUsar ? "caja-indicador abierta" : "caja-indicador"} onClick={() => setPagina("caja")}>
              <span className="punto" aria-hidden />
              {caja.turno
                ? caja.deOtroDia
                  ? `Caja abierta desde el ${caja.turno.dia}`
                  : caja.puedeUsar
                    ? `Caja abierta · ${fechaHora(new Date(caja.turno.abiertoEn)).slice(11, 16)}`
                    : `Caja de ${caja.turno.usuarioApertura.split(" ")[0]} · ${fechaHora(new Date(caja.turno.abiertoEn)).slice(11, 16)}`
                : "Caja cerrada"}
            </button>
          )}
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
            <Button
              icono={UserRoundCog}
              className="nav-item"
              title="Entra otra persona con su PIN. La caja sigue abierta."
              onClick={() => p.salir(caja?.turno ? "La caja sigue abierta. ¿Quién entra?" : "")}
            >
              Cambiar usuario
            </Button>
          </div>
        </aside>
        <main className="contenido">
          {/* key: al cambiar de sección, un error anterior no se queda pegado. */}
          <ErrorPantalla key={pagina}>{paginas[pagina]}</ErrorPantalla>
        </main>
      </div>
    </SesionCtx.Provider>
  );
}
