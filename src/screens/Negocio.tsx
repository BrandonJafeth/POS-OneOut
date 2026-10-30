import { ImageUp, Save, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSesion } from "../app/sesion";
import Mensaje, { textoError } from "../components/Mensaje";
import Papel from "../components/Papel";
import { guardarLogo, guardarNegocio, obtenerLogoOriginal, obtenerNegocio, puedeEditarCampo, type CampoNegocio } from "../db/negocio";
import { ajustesImpresora, muestraEncabezado } from "../lib/impresion";
import { aUnBit, LOGO_ANCHO_MAX, medidasLogo, umbralSugerido } from "../lib/logo1bit";
import { interpret } from "../lib/preview";
import type { LogoUnBit, Negocio as TNegocio } from "../tipos";
import Button from "../ui/Button";
import { useConfirmar } from "../ui/Confirmar";
import { guardarConfig } from "../db/config";
import { esColor, TEMAS, temaConAcento } from "../ui/tema";
import { monto } from "../lib/tickets";

const CAMPOS: { k: CampoNegocio; texto: string; multilinea?: boolean }[] = [
  { k: "nombreComercial", texto: "Nombre comercial" },
  { k: "razonSocial", texto: "Razón social / nombre legal" },
  { k: "cedula", texto: "Cédula" },
  { k: "regimen", texto: "Régimen", },
  { k: "direccion", texto: "Dirección" },
  { k: "telefono", texto: "Teléfono" },
  { k: "correo", texto: "Correo" },
  { k: "encabezadoExtra", texto: "Encabezado extra (una línea por renglón)", multilinea: true },
  { k: "pieTiquete", texto: "Pie del tiquete", multilinea: true },
  { k: "responsableTratamiento", texto: "Responsable de los datos personales (Ley 8968)" },
  { k: "avisoPrivacidadTexto", texto: "Aviso de privacidad (se muestra al registrar un cliente)", multilinea: true },
  { k: "avisoPrivacidadVersion", texto: "Versión del aviso (sube sola al cambiar el texto)" },
];

export default function Negocio() {
  const { actor, config, puede } = useSesion();
  const [guardado, setGuardado] = useState<TNegocio | null>(null);
  const [form, setForm] = useState<TNegocio | null>(null);
  const [logoNuevo, setLogoNuevo] = useState<LogoPendiente | null>(null);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const cargar = async () => {
    const n = await obtenerNegocio();
    setGuardado(n);
    setForm(n);
  };
  useEffect(() => void cargar().catch((e) => setError(textoError(e))), []);

  // Vista previa en vivo: con lo que se está escribiendo y el logo pendiente (si hay).
  const items = useMemo(() => {
    if (!form) return [];
    const n = logoNuevo ? { ...form, logo: logoNuevo.logo } : form;
    return interpret(muestraEncabezado(n, ajustesImpresora(config)).bytes);
  }, [form, logoNuevo, config]);

  if (!form || !guardado) return <div className="screen">{error ? <Mensaje error={error} /> : "Cargando…"}</div>;

  const cambiado = CAMPOS.some(({ k }) => form[k] !== guardado[k]);

  async function guardar() {
    setError("");
    setOk("");
    try {
      await guardarNegocio(actor, Object.fromEntries(CAMPOS.map(({ k }) => [k, form![k]])));
      await cargar();
      setOk("Datos guardados.");
    } catch (e) {
      setError(textoError(e));
    }
  }

  return (
    <div className="screen">
      <h1>Datos del negocio</h1>
      <div className="cols">
        <section className="card">
          {/* Primero lo que este usuario puede editar; lo que solo cambia el técnico, al final. */}
          {[...CAMPOS].sort((a, b) => Number(!puedeEditarCampo(actor, a.k)) - Number(!puedeEditarCampo(actor, b.k))).map(({ k, texto, multilinea }) => {
            const editable = puedeEditarCampo(actor, k);
            const props = {
              value: form[k],
              disabled: !editable,
              onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value }),
            };
            return (
              <label key={k} className="campo">
                {texto}
                {multilinea ? <textarea rows={k === "avisoPrivacidadTexto" ? 7 : 3} {...props} /> : <input {...props} />}
                {!editable && <span className="ayuda">Solo lo cambia el técnico.</span>}
              </label>
            );
          })}
          <Mensaje error={error} ok={ok} />
          <div className="row">
            <Button variante="primario" icono={Save} disabled={!cambiado} onClick={guardar}>
              Guardar
            </Button>
            <Button icono={Undo2} disabled={!cambiado} onClick={() => setForm(guardado)}>
              Descartar cambios
            </Button>
          </div>
        </section>

        <section className="card">
          <h2>Vista previa del encabezado</h2>
          <Papel items={items} />
        </section>

        {puede("negocio.legal") && <ColorNegocio />}

        {puede("negocio.legal") && (
          <LogoEditor
            tieneLogo={!!guardado.logo}
            umbralGuardado={guardado.logoUmbral}
            onPendiente={setLogoNuevo}
            onGuardar={async (l) => {
              await guardarLogo(actor, l);
              setLogoNuevo(null);
              await cargar();
            }}
          />
        )}
      </div>
    </div>
  );
}

interface LogoPendiente {
  original: Uint8Array;
  mime: string;
  logo: LogoUnBit;
  umbral: number;
}

interface Imagen {
  original: Uint8Array;
  mime: string;
  rgba: Uint8ClampedArray;
  ancho: number;
  alto: number;
}

/** Decodifica PNG/JPG con el navegador y lo reduce a ≤ 368 puntos de ancho. */
async function decodificar(original: Uint8Array, mime: string): Promise<Imagen> {
  const url = URL.createObjectURL(new Blob([original as Uint8Array<ArrayBuffer>], { type: mime }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const { ancho, alto } = medidasLogo(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = ancho;
    canvas.height = alto;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, ancho, alto);
    return { original, mime, rgba: ctx.getImageData(0, 0, ancho, alto).data, ancho, alto };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function LogoEditor(p: {
  tieneLogo: boolean;
  umbralGuardado: number | null;
  onPendiente(l: LogoPendiente | null): void;
  onGuardar(l: LogoPendiente | null): Promise<void>;
}) {
  const confirmar = useConfirmar();
  const [img, setImg] = useState<Imagen | null>(null);
  const [umbral, setUmbral] = useState(128);
  const [invertir, setInvertir] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const pendiente = useMemo<LogoPendiente | null>(
    () => (img ? { original: img.original, mime: img.mime, umbral, logo: aUnBit(img.rgba, img.ancho, img.alto, umbral, invertir) } : null),
    [img, umbral, invertir],
  );
  useEffect(() => p.onPendiente(pendiente), [pendiente]);

  async function abrir(original: Uint8Array, mime: string, umbralInicial?: number | null) {
    setError("");
    setOk("");
    try {
      const i = await decodificar(original, mime);
      setUmbral(umbralInicial ?? umbralSugerido(i.rgba));
      setImg(i);
    } catch {
      setError("No se pudo leer la imagen. Use un PNG o JPG.");
    }
  }

  async function elegirArchivo(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!/^image\/(png|jpeg)$/.test(f.type)) return setError("El logo debe ser PNG o JPG.");
    await abrir(new Uint8Array(await f.arrayBuffer()), f.type);
  }

  async function reajustarGuardado() {
    const o = await obtenerLogoOriginal();
    if (o) await abrir(o.datos, o.mime, p.umbralGuardado);
  }

  async function ejecutar(l: LogoPendiente | null, mensaje: string) {
    setError("");
    try {
      await p.onGuardar(l);
      setImg(null);
      setOk(mensaje);
    } catch (e) {
      setError(textoError(e));
    }
  }

  return (
    <section className="card">
      <h2>Logo del tiquete</h2>
      <p className="muted">
        PNG o JPG. Se reduce a {LOGO_ANCHO_MAX} puntos de ancho como máximo y se convierte a blanco y negro (1 bit).
      </p>
      <div className="row">
        <label className="boton-archivo">
          <input type="file" accept="image/png,image/jpeg" onChange={elegirArchivo} className="sr-only" />
          <span>
            <ImageUp size={18} aria-hidden /> Subir imagen…
          </span>
        </label>
        {p.tieneLogo && !img && <button onClick={reajustarGuardado}>Ajustar el logo actual</button>}
        {p.tieneLogo && !img && (
          <Button
            variante="peligro"
            icono={Trash2}
            onClick={async () => (await confirmar({ titulo: "¿Quitar el logo?", texto: "El tiquete saldrá con el nombre del negocio en vez del logo.", aceptar: "Quitar logo", peligro: true })) && ejecutar(null, "Logo quitado.")}
          >
            Quitar logo
          </Button>
        )}
      </div>
      {img && pendiente && (
        <>
          <label className="campo">
            Umbral: {umbral} <span className="ayuda">(más alto = más negro)</span>
            <input type="range" min={1} max={254} value={umbral} onChange={(e) => setUmbral(Number(e.target.value))} />
          </label>
          <label>
            <input type="checkbox" checked={invertir} onChange={(e) => setInvertir(e.target.checked)} /> Invertir (logo claro sobre
            fondo oscuro)
          </label>
          <p className="muted">
            {pendiente.logo.ancho} × {pendiente.logo.alto} puntos ({(pendiente.logo.ancho / 8).toFixed(0)} mm de ancho). Revise la vista
            previa del encabezado antes de guardar.
          </p>
          <div className="row">
            <button className="primary" onClick={() => ejecutar(pendiente, "Logo guardado.")}>
              Guardar logo
            </button>
            <button onClick={() => setImg(null)}>Cancelar</button>
          </div>
        </>
      )}
      <Mensaje error={error} ok={ok} />
    </section>
  );
}

/**
 * Color propio del negocio (solo técnico). Se guarda en config color_acento; la app lo ajusta
 * sola para que siempre se lea bien (ver temaConAcento). Vacío = grafito neutro.
 */
function ColorNegocio() {
  const { actor, config, recargarConfig } = useSesion();
  const [color, setColor] = useState(config.color_acento || "#24272c");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const vista = temaConAcento(TEMAS[config.tema], config.tema, color);

  async function guardar(valor: string) {
    setError("");
    setOk("");
    try {
      await guardarConfig(actor, "color_acento", valor);
      await recargarConfig();
      setOk(valor ? "Color guardado." : "Volvió al grafito.");
    } catch (e) {
      setError(textoError(e));
    }
  }

  return (
    <section className="card">
      <h2>Color del negocio</h2>
      <p className="muted">Botón Cobrar, selección y filtros. Si el color no se lee bien, la app lo oscurece o aclara sola.</p>
      <div className="row abajo">
        <label className="campo sin-margen">
          Color
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 64, padding: 4 }} />
        </label>
        <label className="campo sin-margen">
          Código
          <input className="mono" style={{ width: 120 }} value={color} onChange={(e) => setColor(e.target.value.trim())} />
        </label>
        <div
          aria-hidden
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            minWidth: 220,
            minHeight: 52,
            padding: "0 16px",
            borderRadius: 12,
            background: vista.accent,
            color: vista["on-accent"],
            fontWeight: 650,
          }}
        >
          <span>Cobrar</span>
          <span style={{ fontSize: 20 }}>{monto(13225)}</span>
        </div>
      </div>
      <div className="fila-botones">
        <Button variante="primario" icono={Save} disabled={!esColor(color) || color === config.color_acento} onClick={() => guardar(color.toLowerCase())}>
          Guardar color
        </Button>
        {config.color_acento && (
          <Button icono={Undo2} onClick={() => (setColor("#24272c"), guardar(""))}>
            Usar grafito
          </Button>
        )}
      </div>
      {!esColor(color) && <Mensaje error="Use el formato #rrggbb, por ejemplo #2e7d32." />}
      <Mensaje error={error} ok={ok} />
    </section>
  );
}
