import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Bookmark,
  Boxes,
  ChartColumn,
  FileText,
  Info,
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
import AcercaDe from "./components/AcercaDe";
import AvisoRespaldo from "./components/AvisoRespaldo";
import ErrorPantalla from "./components/ErrorPantalla";
import RestaurarSinBase from "./components/RestaurarSinBase";
import { MARCA_TECNICA, mostrarDetalleTecnico, textoError } from "./components/Mensaje";
import { estadoCaja, type EstadoCaja } from "./db/caja";
import { guardarConfig, leerConfig, type ConfigApp } from "./db/config";
import { iniciarBase } from "./db/iniciar";
import { cerrarSesion, estadoSistema, tocarSesion } from "./db/usuarios";
import { alertasInventario } from "./db/inventario";
import { cuentasVencidas } from "./db/cuentas";
import { pendientesFactura } from "./db/ventas";
import { alPedirAutorizacion, alPerderSesion, SESION_BLOQUEADA, SESION_EXPIRADA, type PedidoAutorizacion } from "./lib/invocar";
import { establecerPermisos, puede, type Permiso } from "./lib/permisos";
import { anulacionesVistas, avisosDueno, estadoSesion, permisosSesion, type Avisos } from "./db/seguridad";
import { AvisoInactividad, PedirAutorizacion, VeloBloqueo } from "./components/Seguridad";
import { fechaHora } from "./lib/tickets";
import Administracion from "./screens/Administracion";
import Caja from "./screens/Caja";
import CambiarPinObligatorio from "./screens/CambiarPinObligatorio";
import Apartados from "./screens/Apartados";
import Proformas from "./screens/Proformas";
import Clientes from "./screens/Clientes";
import Inventario from "./screens/Inventario";
import { BORRADOR as BORRADOR_ENTRADA } from "./screens/inventario/Entrada";
import ConfigTecnica from "./screens/ConfigTecnica";
import Login from "./screens/Login";
import PendientesFactura from "./screens/PendientesFactura";
import PrimerArranque from "./screens/PrimerArranque";
import Productos from "./screens/Productos";
import Reportes from "./screens/Reportes";
import Venta from "./screens/Venta";
import VentasHoy from "./screens/VentasHoy";
import { ROL_NOMBRE, type Usuario } from "./tipos";
import Alert from "./ui/Alert";
import Button from "./ui/Button";
import { ConfirmarProvider } from "./ui/Confirmar";
import { ToastProvider } from "./ui/Toast";
import { aplicarTema } from "./ui/tema";

export type Pagina = "venta" | "caja" | "ventas" | "apartados" | "proformas" | "reportes" | "productos" | "inventario" | "clientes" | "facturas" | "admin" | "config";

interface Seccion {
  id: Pagina;
  texto: string;
  icono: LucideIcon;
  permisos: Permiso[]; // basta uno
}

// Lo del día a día. Lo avanzado va aparte, abajo.
const PRINCIPAL: Seccion[] = [
  { id: "venta", texto: "Venta", icono: ShoppingCart, permisos: ["venta.vender"] },
  { id: "caja", texto: "Caja", icono: Landmark, permisos: ["caja.ver"] },
  { id: "ventas", texto: "Ventas del día", icono: ReceiptText, permisos: ["ventas.ver"] },
  { id: "apartados", texto: "Apartados", icono: Bookmark, permisos: ["cuentas.ver_todas"] },
  { id: "proformas", texto: "Proformas", icono: FileText, permisos: ["proformas.crear"] },
  { id: "productos", texto: "Productos", icono: Package, permisos: ["productos.editar", "productos.crear"] },
  { id: "inventario", texto: "Inventario", icono: Boxes, permisos: ["inventario.ver"] },
  { id: "reportes", texto: "Reportes", icono: ChartColumn, permisos: ["reportes.ver"] },
  { id: "clientes", texto: "Clientes", icono: Users, permisos: ["clientes.ver_todos"] },
  { id: "facturas", texto: "Facturas pendientes", icono: FileText, permisos: ["facturas.ver"] },
];
const AVANZADO: Seccion[] = [
  { id: "admin", texto: "Administración", icono: Settings2, permisos: ["usuarios.administrar", "negocio.contacto", "departamentos.editar", "respaldo.crear", "impresoras.asignar", "bitacora.ver", "seguridad.editar"] },
  { id: "config", texto: "Técnico", icono: Wrench, permisos: ["config.tecnica"] },
];

type Fase =
  | { f: "cargando" }
  | { f: "sinTauri" }
  | { f: "error"; mensaje: string; carpeta?: string; version?: string }
  | { f: "primer" }
  | { f: "login" }
  | { f: "dentro"; usuario: Usuario; minutos: number };

/** Al cerrar sesión o bloquearse: no quedan costos de una entrada a medias en la memoria de la ventana. */
function borrarBorradores() {
  try {
    sessionStorage.removeItem(BORRADOR_ENTRADA);
  } catch {
    /* sin almacenamiento: no hay borrador */
  }
}

export default function App() {
  const [fase, setFase] = useState<Fase>({ f: "cargando" });
  const [config, setConfig] = useState<ConfigApp | null>(null);
  const [nombreNegocio, setNombreNegocio] = useState("");
  const [avisoLogin, setAvisoLogin] = useState("");
  // Bloqueo por inactividad: la pantalla sigue montada debajo del velo (no se pierde nada).
  const [bloqueo, setBloqueo] = useState<{ id: string; nombre: string } | null>(null);
  const [, setVersionPermisos] = useState(0);
  const [pedido, setPedido] = useState<{ p: PedidoAutorizacion; listo(r: { pin?: string; motivo?: string } | null): void } | null>(null);
  const faseRef = useRef(fase);
  faseRef.current = fase;

  /** La política efectiva del usuario (Rust): con esto se muestra u oculta. */
  const cargarPermisos = useCallback(async () => {
    const r = await permisosSesion();
    establecerPermisos(r.acciones, r.motivosAnulacion, r.umbralAvisoAnulaciones);
    setVersionPermisos(r.version);
  }, []);

  /** Antes de entrar solo se sabe lo que Rust deja ver sin sesión: nombre, tema y si falta el técnico. */
  const cargarSistema = useCallback(async () => {
    const s = await estadoSistema();
    // Al arrancar no hay sesión: se muestra el detalle para que el administrador sepa qué pasó.
    if (s.error) return setFase({ f: "error", mensaje: `${s.error.replace(MARCA_TECNICA, "")} Si no sabe cómo resolverlo, contacte al administrador.`, carpeta: s.carpeta, version: s.version });
    aplicarTema(s.tema === "oscuro" ? "oscuro" : "claro", typeof s.colorAcento === "string" ? s.colorAcento : "", s.colorFondo);
    setNombreNegocio(s.nombreNegocio);
    setFase(s.necesitaTecnico ? { f: "primer" } : { f: "login" });
  }, []);

  useEffect(() => {
    aplicarTema("claro");
    if (!isTauri()) return setFase({ f: "sinTauri" });
    iniciarBase();
    cargarSistema().catch((e) => setFase({ f: "error", mensaje: textoError(e) }));
  }, []);

  // Rust bloqueó la sesión (inactividad): velo encima, sin desmontar nada. Si la cerró: a la entrada.
  useEffect(
    () =>
      alPerderSesion((m) => {
        const f = faseRef.current;
        if (m === SESION_BLOQUEADA && f.f === "dentro") return setBloqueo({ id: f.usuario.id, nombre: f.usuario.nombre });
        if (m !== SESION_EXPIRADA) return;
        borrarBorradores();
        setBloqueo(null);
        setConfig(null);
        setAvisoLogin("La sesión se cerró.");
        setFase({ f: "login" });
      }),
    [],
  );
  // Una acción pide PIN del dueño o motivo (política): diálogo y lib/invocar reintenta.
  useEffect(() => alPedirAutorizacion((p) => new Promise((listo) => setPedido({ p, listo: (r) => (setPedido(null), listo(r)) }))), []);
  // Se bloqueó con ese diálogo abierto (M10): se cancela (no queda encima del velo ni lo completa
  // otro usuario); al volver, la acción se repite.
  useEffect(() => {
    if (bloqueo && pedido) pedido.listo(null);
  }, [bloqueo, pedido]);
  // Cambiaron los permisos (otra persona guardó): se vuelven a pedir sin cerrar sesión.
  useEffect(() => {
    if (!isTauri()) return;
    const quitar = listen("seguridad-cambiada", () => {
      if (faseRef.current.f === "dentro" && !faseRef.current.usuario.debeCambiarPin) void cargarPermisos().catch(() => undefined);
    });
    return () => void quitar.then((f) => f());
  }, []);

  const entrar = useCallback(async (usuario: Usuario, minutos: number, continua = false) => {
    setAvisoLogin("");
    const f = faseRef.current;
    // Mismo usuario después del bloqueo: sigue donde estaba (Rust lo confirmó con `continua`).
    if (continua && f.f === "dentro" && f.usuario.id === usuario.id) {
      setBloqueo(null);
      await cargarPermisos();
      return;
    }
    // Otra persona: nada de la pantalla anterior (ni el borrador de la entrada, que lleva costos).
    if (f.f === "dentro") borrarBorradores();
    setBloqueo(null);
    if (!usuario.debeCambiarPin) await cargarPermisos();
    // Con PIN pendiente de cambio Rust no deja leer nada: la configuración se carga después del cambio.
    if (!usuario.debeCambiarPin) {
      const c = await leerConfig();
      aplicarTema(c.tema, c.color_acento, c.color_fondo);
      setConfig(c);
    }
    mostrarDetalleTecnico(usuario.rol === "tecnico");
    setFase({ f: "dentro", usuario, minutos });
  }, []);

  const recargarConfig = useCallback(async () => {
    const c = await leerConfig();
    aplicarTema(c.tema, c.color_acento, c.color_fondo);
    setConfig(c);
  }, []);
  // Cambio de usuario: se cierra la sesión en Rust (el turno de caja sigue abierto) y se vuelve a
  // la lista de usuarios. Al entrar el siguiente, toda la pantalla se arma de cero según su rol:
  // no queda nada a la vista del anterior (ni totales, ni avisos, ni diálogos).
  const salir = useCallback((aviso = "") => {
    borrarBorradores();
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
        <div className="screen" style={{ maxWidth: 640 }}>
          <Alert tono="error" titulo="No se pudo iniciar">
            {fase.mensaje}
          </Alert>
          {/* Solo cuando Rust sí arrancó y la base no abrió: ofrecer el respaldo (nunca una base vacía). */}
          {fase.carpeta && <RestaurarSinBase carpeta={fase.carpeta} />}
          {fase.version && <p className="muted">Punto de Venta, versión {fase.version}</p>}
        </div>
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
  else
    contenido = (
      <>
        <Dentro key={fase.usuario.id} usuario={fase.usuario} minutos={fase.minutos} config={config} nombreNegocio={nombreNegocio} recargarConfig={recargarConfig} salir={salir} bloqueada={!!bloqueo} />
        {bloqueo && <VeloBloqueo nombreNegocio={nombreNegocio} usuario={bloqueo} onEntrar={(u, m, c) => void entrar(u, m, c).catch((e) => setFase({ f: "error", mensaje: textoError(e) }))} />}
      </>
    );

  // La clave por usuario desmonta avisos y confirmaciones del usuario anterior al cambiar de usuario.
  const clave = fase.f === "dentro" ? fase.usuario.id : "fuera";
  return (
    <ConfirmarProvider key={clave}>
      <ToastProvider>
        {contenido}
        {pedido && <PedirAutorizacion pedido={pedido.p} onListo={pedido.listo} />}
      </ToastProvider>
    </ConfirmarProvider>
  );
}

function Dentro(p: { usuario: Usuario; minutos: number; config: ConfigApp; nombreNegocio: string; recargarConfig(): Promise<void>; salir(aviso?: string): void; bloqueada: boolean }) {
  const usaCaja = puede(p.usuario.rol, "caja.ver");
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
  // Apartados solo si el negocio los usa (o vende a crédito).
  const visible = (s: Seccion) => s.permisos.some((x) => sesion.puede(x)) && (s.id !== "apartados" || p.config.usa_apartados || p.config.usa_credito);
  const principal = PRINCIPAL.filter(visible);
  const avanzado = AVANZADO.filter(visible);
  // Arranca en la primera sección que el rol puede usar (Venta para cajero y dueño).
  useEffect(() => setPagina(principal[0]?.id ?? avanzado[0]?.id ?? "admin"), []);
  const [facturas, setFacturas] = useState(0);
  const [acercaDe, setAcercaDe] = useState(false);
  // Aviso discreto al dueño (nunca al cajero en la venta): productos en su mínimo o por debajo.
  const [bajoMinimo, setBajoMinimo] = useState(0);
  useEffect(() => {
    if (!sesion.puede("inventario.ver")) return;
    alertasInventario().then(setBajoMinimo, () => setBajoMinimo(0));
  }, [pagina]);

  // Apartados o créditos vencidos: aviso al dueño (sin acción automática).
  const [vencidas, setVencidas] = useState(0);
  useEffect(() => {
    if (!sesion.puede("cuentas.ver_todas") || !(p.config.usa_apartados || p.config.usa_credito)) return;
    cuentasVencidas().then(setVencidas, () => setVencidas(0));
  }, [pagina]);

  useEffect(() => {
    void recargarCaja().catch(() => undefined);
  }, [pagina]);

  // Inactividad (lo decide Rust con su reloj): la pantalla solo informa la actividad real
  // (teclado, incluido el lector; mouse; táctil) y pregunta cuánto falta, sin renovar el plazo.
  const [avisoBloqueo, setAvisoBloqueo] = useState(false);
  useEffect(() => {
    if (p.bloqueada) return;
    let avisado = 0;
    const actividad = () => {
      setAvisoBloqueo(false);
      if (Date.now() - avisado > 10_000) {
        avisado = Date.now();
        void tocarSesion().catch(() => undefined);
      }
    };
    const revisar = () =>
      void estadoSesion()
        .then((e) => {
          if (!e) return;
          // Bloqueada: el siguiente comando lo confirma y lib/invocar pone el velo.
          if (e.bloqueada) return void tocarSesion().catch(() => undefined);
          // Un minuto antes (con un tiempo de 1 minuto, a la mitad).
          setAvisoBloqueo(e.restanteMs <= Math.min(60_000, (e.minutos * 60_000) / 2));
        })
        .catch(() => undefined);
    const t = setInterval(revisar, 5_000);
    window.addEventListener("keydown", actividad, true);
    window.addEventListener("pointerdown", actividad, true);
    window.addEventListener("touchstart", actividad, true);
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", actividad, true);
      window.removeEventListener("pointerdown", actividad, true);
      window.removeEventListener("touchstart", actividad, true);
    };
  }, [p.bloqueada]);

  // Aviso al dueño: anulaciones sin PIN desde la última vez y cambios alterados en los permisos.
  const [avisos, setAvisos] = useState<Avisos | null>(null);
  useEffect(() => {
    if (p.usuario.rol !== "dueno") return;
    avisosDueno().then(setAvisos, () => setAvisos(null));
  }, []);

  // Contador de facturas pendientes en el menú: que no se olvide ninguna.
  useEffect(() => {
    if (!sesion.puede("facturas.ver")) return;
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
    apartados: <Apartados />,
    proformas: <Proformas />,
    reportes: <Reportes />,
    productos: <Productos />,
    inventario: <Inventario />,
    clientes: <Clientes />,
    facturas: <PendientesFactura />,
    admin: <Administracion />,
    config: <ConfigTecnica />,
  };

  const textoCaja = !caja?.turno
    ? "Caja cerrada"
    : caja.deOtroDia
      ? `Abierta desde el ${caja.turno.dia}`
      : caja.puedeUsar
        ? `Caja abierta · ${fechaHora(new Date(caja.turno.abiertoEn)).slice(11, 16)}`
        : `Caja de ${caja.turno.usuarioApertura.split(" ")[0]} · ${fechaHora(new Date(caja.turno.abiertoEn)).slice(11, 16)}`;

  const boton = (s: Seccion) => (
    <Button
      key={s.id}
      icono={s.icono}
      className={pagina === s.id ? "nav-item activo" : "nav-item"}
      aria-current={pagina === s.id ? "page" : undefined}
      title={s.texto}
      onClick={() => setPagina(s.id)}
    >
      {s.texto}
      {s.id === "facturas" && facturas > 0 && (
        <span className="nav-contador" aria-label={`${facturas} pendientes`}>
          {facturas}
        </span>
      )}
      {s.id === "apartados" && vencidas > 0 && (
        <span className="nav-contador" aria-label={`${vencidas} vencidos`}>
          {vencidas}
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
      <div className="app" inert={p.bloqueada}>
        <aside className="lateral" aria-label="Menú">
          <div className="lateral-marca">{p.nombreNegocio || "Punto de venta"}</div>
          {usaCaja && caja && (
            <button
              className={caja.turno && !caja.deOtroDia && caja.puedeUsar ? "caja-indicador abierta" : "caja-indicador"}
              title={textoCaja}
              onClick={() => setPagina("caja")}
            >
              <span className="punto" aria-hidden />
              <span className="caja-texto">{textoCaja}</span>
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
            <Button icono={p.config.tema === "oscuro" ? Sun : Moon} className="nav-item" title={p.config.tema === "oscuro" ? "Tema claro" : "Tema oscuro"} onClick={cambiarTema}>
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
            <Button icono={Info} className="nav-item" title="Acerca de" onClick={() => setAcercaDe(true)}>
              Acerca de
            </Button>
          </div>
        </aside>
        <main className="contenido">
          {avisoBloqueo && !p.bloqueada && <AvisoInactividad />}
          {avisos && avisos.seguridadAlterada && (
            <Alert tono="error" titulo="Los permisos fueron alterados">
              Alguien cambió la configuración de permisos fuera del programa. Se usa la última versión válida. Avise al técnico.
            </Alert>
          )}
          {avisos && avisos.anulacionesSinPin > 0 && (
            <Alert tono="aviso" titulo={avisos.anulacionesSinPin === 1 ? "Hubo 1 anulación sin PIN" : `Hubo ${avisos.anulacionesSinPin} anulaciones sin PIN`}>
              <div className="fila">
                <Button onClick={() => (setPagina("reportes"), void anulacionesVistas().then(() => setAvisos({ ...avisos, anulacionesSinPin: 0 })))}>
                  Ver el detalle
                </Button>
                <Button variante="fantasma" onClick={() => void anulacionesVistas().then(() => setAvisos({ ...avisos, anulacionesSinPin: 0 }))}>
                  Entendido
                </Button>
              </div>
            </Alert>
          )}
          {acercaDe && <AcercaDe onCerrar={() => setAcercaDe(false)} />}
          {sesion.puede("respaldo.crear") && <AvisoRespaldo pagina={pagina} />}
          {/* key: al cambiar de sección, un error anterior no se queda pegado. */}
          <ErrorPantalla key={pagina}>{paginas[pagina]}</ErrorPantalla>
        </main>
      </div>
    </SesionCtx.Provider>
  );
}
