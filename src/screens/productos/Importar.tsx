// Importar productos desde el CSV de la web, en 3 pasos:
// 1. elegir archivo (lo lee Rust) → 2. revisar: vista previa, mapeo, reglas y decisiones →
// 3. confirmar con PIN (Rust valida y escribe todo en una transacción). Nada se escribe en la
// base antes del paso 3; volver atrás conserva el mapeo y las decisiones.
import { ArrowLeft, ArrowRight, Check, Download, FileUp, RotateCcw, Save, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSesion } from "../../app/sesion";
import Mensaje, { textoError } from "../../components/Mensaje";
import { guardarConfig } from "../../db/config";
import { listarDepartamentos } from "../../db/departamentos";
import {
  aplicarImportacion,
  codigosExistentes,
  favoritosActuales,
  leerArchivo,
  productosParaImportar,
  resumenCatalogo,
  type ModoImportacion,
  type ResultadoImportacion,
  type ResumenCatalogo,
} from "../../db/importacion";
import { csvSeguro } from "../../lib/csv";
import { descargar } from "../../lib/exportarCliente";
import type { ErrorFila, FuenteImportacion } from "../../lib/importar/fuente";
import { cambiosDePrecio, categoriasSinMapear, crearPlan, type Contexto, type ItemPlan, type Plan, type Respuesta } from "../../lib/importar/plan";
import { CRITERIOS_FAVORITOS, pluralesSinRegla, REGLAS_DEFECTO, reglasValidas, type CriterioFavoritos, type ReglasImportacion } from "../../lib/importar/reglas";
import { fuenteDesdeTabla } from "../../lib/importar/web";
import { normalizar } from "../../lib/texto";
import { monto } from "../../lib/tickets";
import type { Departamento } from "../../tipos";
import Alert from "../../ui/Alert";
import Badge from "../../ui/Badge";
import Button from "../../ui/Button";
import Field from "../../ui/Field";
import EditorReglas from "./importar/EditorReglas";

type Paso = "archivo" | "revisar" | "confirmar" | "listo";
type Pestana = "resumen" | "reglas" | "nombres" | "problemas" | "productos";
export type FiltroProductosImportados = "sinBarras" | "revisar";

const PASOS: { id: Paso; texto: string }[] = [
  { id: "archivo", texto: "Elegir archivo" },
  { id: "revisar", texto: "Vista previa y mapeo" },
  { id: "confirmar", texto: "Confirmar" },
];

const n = (x: number) => x.toLocaleString("es-CR");

export default function Importar({ onSalir }: { onSalir(filtro?: FiltroProductosImportados): void }) {
  const { actor, config, recargarConfig } = useSesion();
  const [paso, setPaso] = useState<Paso>("archivo");
  const [pestana, setPestana] = useState<Pestana>("resumen");
  const [deps, setDeps] = useState<Departamento[]>([]);
  const [archivo, setArchivo] = useState<{ nombre: string; separador: string; codificacion: string } | null>(null);
  const [fuente, setFuente] = useState<FuenteImportacion | null>(null);
  const [ctx, setCtx] = useState<Contexto | null>(null);
  const [reglas, setReglas] = useState<ReglasImportacion>(() => reglasValidas(config.importacion_reglas));
  const [reglasSucias, setReglasSucias] = useState(false);
  const [respuestas, setRespuestas] = useState<Record<number, Respuesta>>({});
  const [aceptadas, setAceptadas] = useState<Set<number>>(new Set());
  const [limitarFavoritos, setLimitarFavoritos] = useState(true);
  const [pisar, setPisar] = useState({ departamento: false, favorito: false });
  const [modo, setModo] = useState<ModoImportacion>("todo");
  const [pin, setPin] = useState("");
  const [resultado, setResultado] = useState<ResultadoImportacion | null>(null);
  const [resumen, setResumen] = useState<ResumenCatalogo | null>(null);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    listarDepartamentos().then(setDeps, (e) => setError(textoError(e)));
  }, []);

  const plan = useMemo<Plan | null>(
    () =>
      fuente && ctx
        ? crearPlan(fuente, ctx, { reglas, respuestas, sugerenciasAceptadas: aceptadas, limitarFavoritos, pisar })
        : null,
    [fuente, ctx, reglas, respuestas, aceptadas, limitarFavoritos, pisar],
  );
  const porCategoria = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of fuente?.filas ?? []) for (const c of new Set(f.categorias.map(normalizar))) m.set(c, (m.get(c) ?? 0) + 1);
    return m;
  }, [fuente]);
  const sinMapear = useMemo(() => (fuente ? categoriasSinMapear(fuente, reglas) : []), [fuente, reglas]);
  const plurales = useMemo(() => (fuente ? pluralesSinRegla(fuente.filas.map((f) => f.nombre), reglas.palabras) : []), [fuente, reglas.palabras]);

  const nombreDep = (id: string) => {
    const d = deps.find((x) => x.id === id);
    return d ? `${d.codigo} ${d.nombre}` : "?";
  };
  const cambiarReglas = (r: ReglasImportacion) => (setReglas(r), setReglasSucias(true));

  async function elegir(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setError("");
    setAviso("");
    setOcupado(true);
    try {
      const t = await leerArchivo(f);
      const fu = fuenteDesdeTabla(t.cabecera, t.filas);
      if (!fu.filas.length) throw new Error("El archivo solo tiene el encabezado");
      const [existentes, codigos, favoritos, departamentos] = await Promise.all([productosParaImportar(), codigosExistentes(), favoritosActuales(), listarDepartamentos({ incluirInactivos: true })]);
      setCtx({ existentes, codigos, favoritosActuales: favoritos, departamentos, departamentoDefecto: config.departamento_defecto });
      setFuente(fu);
      setArchivo({ nombre: f.name, separador: t.separador === ";" ? "punto y coma" : "coma", codificacion: t.codificacion });
      setRespuestas({});
      setAceptadas(new Set());
      setPestana("resumen");
      setPaso("revisar");
    } catch (err) {
      setError(textoError(err));
    } finally {
      setOcupado(false);
    }
  }

  async function guardarReglas() {
    await guardarConfig(actor, "importacion_reglas", reglas);
    await recargarConfig();
    setReglasSucias(false);
  }

  async function confirmar() {
    if (!plan) return;
    setOcupado(true);
    setError("");
    try {
      if (reglasSucias) await guardarReglas();
      const r = await aplicarImportacion(plan, { pin, modo, pisar });
      setPin("");
      setResultado(r);
      setResumen(await resumenCatalogo());
      setPaso("listo");
    } catch (e) {
      setPin("");
      setError(textoError(e));
    } finally {
      setOcupado(false);
    }
  }

  function descargarProblemas(filas: ErrorFila[], nombre: string) {
    const porFila = new Map(fuente?.filas.map((f) => [f.fila, f]));
    descargar(
      nombre,
      csvSeguro([["Fila", "Id", "Nombre", "Problema"], ...filas.map((e) => [String(e.fila), porFila.get(e.fila)?.webId ?? "", e.nombre, e.mensaje])]),
      "text/csv",
    );
  }

  const aImportar = plan ? plan.nuevos.length + plan.actualizar.length : 0;
  const precios = plan ? cambiosDePrecio(plan) : null;
  const problemas = plan ? [...plan.errores, ...plan.omitidos].sort((a, b) => a.fila - b.fila) : [];

  return (
    <div className="screen importar">
      <div className="encabezado">
        <h1>Importar productos</h1>
        <Button icono={ArrowLeft} variante="fantasma" onClick={() => onSalir()}>
          Volver a productos
        </Button>
      </div>

      {paso !== "listo" && (
        <ol className="pasos" aria-label="Pasos de la importación">
          {PASOS.map((p, i) => {
            const actual = PASOS.findIndex((x) => x.id === paso);
            const estado = i < actual ? "hecho" : i === actual ? "actual" : "";
            return (
              <li key={p.id} className={estado} aria-current={estado === "actual" ? "step" : undefined}>
                <span className="pasos-num">{i < actual ? <Check size={16} aria-hidden /> : i + 1}</span>
                {p.texto}
              </li>
            );
          })}
        </ol>
      )}
      <Mensaje error={error} />

      {paso === "archivo" && (
        <section className="card importar-archivo">
          <FileUp size={40} strokeWidth={1.6} aria-hidden className="muted" />
          <div>
            <h2>Archivo CSV exportado de la web</h2>
            <p className="muted">
              Columnas <strong>id, nombre, precio</strong> y <strong>categorias</strong> (varias separadas por «|»); también lee slug, estado, tipo y destacado.
              Coma o punto y coma, UTF-8 o Excel. Hasta 5 MB y 20.000 filas. Nada se guarda hasta el último paso.
            </p>
            <label className="boton-archivo">
              <input type="file" accept=".csv,text/csv" onChange={elegir} className="sr-only" disabled={ocupado} />
              <span>
                <Upload size={18} aria-hidden /> {ocupado ? "Leyendo…" : "Elegir archivo CSV…"}
              </span>
            </label>
            {fuente && archivo && (
              <p className="muted" style={{ marginTop: "var(--e3)" }}>
                Ya hay un archivo leído ({archivo.nombre}).{" "}
                <button type="button" className="enlace" onClick={() => setPaso("revisar")}>
                  Seguir con ese archivo
                </button>
              </p>
            )}
          </div>
        </section>
      )}

      {paso === "revisar" && plan && archivo && (
        <div className="importar-grid">
          <div className="importar-main">
            {plan.preguntas.map((q) => (
              <section key={q.indice} className="card decision" aria-labelledby={`q-${q.indice}`}>
                <h2 id={`q-${q.indice}`}>
                  {q.items.length} {q.items.length === 1 ? "producto dice" : "productos dicen"} «{q.palabras.join(", ")}»: ¿van a {nombreDep(q.departamentoId)}?
                </h2>
                <ul className="lista-nombres">
                  {q.items.map((i) => (
                    <li key={i.fila}>
                      {i.nombre} <span className="muted">· hoy en {nombreDep(i.departamentoCategoria)}</span>
                    </li>
                  ))}
                </ul>
                <div className="segmento" role="group" aria-label="Decisión">
                  <button type="button" aria-pressed={q.respuesta === "mover"} onClick={() => setRespuestas({ ...respuestas, [q.indice]: "mover" })}>
                    Sí, a {nombreDep(q.departamentoId)}
                  </button>
                  <button type="button" aria-pressed={q.respuesta === "dejar"} onClick={() => setRespuestas({ ...respuestas, [q.indice]: "dejar" })}>
                    No, dejarlos donde están
                  </button>
                </div>
              </section>
            ))}

            <section className="card">
              <div className="tabs" role="tablist" aria-label="Vista previa">
                {(
                  [
                    ["resumen", "Departamentos"],
                    ["reglas", reglasSucias ? "Mapeo y reglas (sin guardar)" : "Mapeo y reglas"],
                    ["nombres", `Nombres y favoritos${plan.sugerencias.length ? ` (${plan.sugerencias.length})` : ""}`],
                    ["problemas", `Problemas (${problemas.length + plan.avisos.length})`],
                    ["productos", "Productos"],
                  ] as [Pestana, string][]
                ).map(([id, texto]) => (
                  <button key={id} type="button" role="tab" className={`tab ${pestana === id ? "active" : ""}`} aria-selected={pestana === id} onClick={() => setPestana(id)}>
                    {texto}
                  </button>
                ))}
              </div>

              <div role="tabpanel" className="tab-panel">
                {pestana === "resumen" && <Departamentos plan={plan} deps={deps} nombreDep={nombreDep} />}

                {pestana === "reglas" && (
                  <>
                    <EditorReglas
                      reglas={reglas}
                      onCambio={cambiarReglas}
                      departamentos={deps}
                      departamentoDefecto={config.departamento_defecto}
                      porCategoria={porCategoria}
                      sinMapear={sinMapear}
                      plurales={plurales}
                    />
                    <div className="fila-botones">
                      <Button
                        icono={Save}
                        disabled={!reglasSucias || ocupado}
                        onClick={() => guardarReglas().then(() => setAviso("Reglas guardadas para las próximas importaciones."), (e) => setError(textoError(e)))}
                      >
                        Guardar reglas
                      </Button>
                      <Button variante="fantasma" icono={RotateCcw} onClick={() => cambiarReglas({ ...REGLAS_DEFECTO, favoritosMax: reglas.favoritosMax, criterioFavoritos: reglas.criterioFavoritos })}>
                        Volver a las reglas de fábrica
                      </Button>
                      <span className="muted">{reglasSucias ? "Cambios sin guardar: se guardan al confirmar la importación." : aviso}</span>
                    </div>
                  </>
                )}

                {pestana === "nombres" && (
                  <NombresYFavoritos
                    plan={plan}
                    aceptadas={aceptadas}
                    onAceptadas={setAceptadas}
                    reglas={reglas}
                    onReglas={cambiarReglas}
                    limitar={limitarFavoritos}
                    onLimitar={setLimitarFavoritos}
                    favoritosActuales={ctx?.favoritosActuales ?? 0}
                    pisarFavorito={pisar.favorito}
                  />
                )}

                {pestana === "problemas" && (
                  <>
                    {problemas.length + plan.avisos.length === 0 ? (
                      <Alert tono="ok" titulo="Ninguna fila con problemas" />
                    ) : (
                      <>
                        {problemas.length > 0 && (
                          <>
                            <div className="row between">
                              <p className="muted">Estas filas no se importan. Corríjalas en el archivo y vuelva a cargarlo.</p>
                              <Button icono={Download} onClick={() => descargarProblemas(problemas, "filas-con-problemas.csv")}>
                                Descargar lista (CSV)
                              </Button>
                            </div>
                            <ListaFilas filas={problemas} />
                          </>
                        )}
                        {plan.avisos.length > 0 && (
                          <>
                            <Alert tono="aviso" titulo={`${plan.avisos.length} filas traen precio de oferta`}>
                              Se importan con su precio normal; la oferta no se aplica.
                            </Alert>
                            <ListaFilas filas={plan.avisos} />
                          </>
                        )}
                      </>
                    )}
                  </>
                )}

                {pestana === "productos" && <Productos plan={plan} nombreDep={nombreDep} />}
              </div>
            </section>
          </div>

          <aside className="importar-aside card" aria-label="Resumen de la importación">
            <h2>{archivo.nombre}</h2>
            <p className="muted">
              Separador {archivo.separador} · {archivo.codificacion}
            </p>
            <dl className="cifras">
              <div>
                <dt>Filas</dt>
                <dd>{n(plan.total)}</dd>
              </div>
              <div className="ok">
                <dt>A crear</dt>
                <dd>{n(plan.nuevos.length)}</dd>
              </div>
              <div>
                <dt>A actualizar</dt>
                <dd>{n(plan.actualizar.length)}</dd>
              </div>
              <div>
                <dt>Sin cambios</dt>
                <dd>{n(plan.sinCambios)}</dd>
              </div>
              <div>
                <dt>Omitidas</dt>
                <dd>{n(plan.omitidos.length)}</dd>
              </div>
              <div className={plan.errores.length ? "err" : ""}>
                <dt>Con error</dt>
                <dd>{n(plan.errores.length)}</dd>
              </div>
            </dl>
            <ul className="aside-notas">
              <li>
                {n(plan.favoritos.marcados)} favoritos nuevos de {n(plan.favoritos.destacados)} destacados
              </li>
              <li>{n(plan.cambiadosPorRegla.length)} cambian de departamento por una regla</li>
              {plan.paraRevisar > 0 && <li>{n(plan.paraRevisar)} quedan para revisar (sin categoría o sin mapeo)</li>}
              {plan.sugerencias.length > 0 && (
                <li>
                  {n(plan.sugerencias.length)} nombres con sugerencia ({n(plan.sugerencias.filter((i) => aceptadas.has(i.fila)).length)} aceptadas)
                </li>
              )}
            </ul>
            {plan.pendientes > 0 && <Alert tono="aviso">Responda {plan.pendientes === 1 ? "la pregunta de arriba" : `las ${plan.pendientes} preguntas de arriba`} para continuar.</Alert>}
            <div className="aside-botones">
              <Button variante="primario" icono={ArrowRight} ancho disabled={plan.pendientes > 0 || aImportar === 0} onClick={() => (setError(""), setPaso("confirmar"))}>
                {aImportar === 0 ? "Nada que importar" : "Continuar"}
              </Button>
              <Button variante="fantasma" icono={ArrowLeft} ancho onClick={() => setPaso("archivo")}>
                Otro archivo
              </Button>
            </div>
          </aside>
        </div>
      )}

      {paso === "confirmar" && plan && (
        <section className="card importar-confirmar">
          <h2>
            {plan.nuevos.length && plan.actualizar.length
              ? `Se van a crear ${n(plan.nuevos.length)} y actualizar ${n(plan.actualizar.length)} productos`
              : plan.nuevos.length
                ? `Se van a crear ${n(plan.nuevos.length)} productos`
                : `Se van a actualizar ${n(plan.actualizar.length)} productos`}
          </h2>
          <p className="muted">
            {[
              plan.sinCambios && `${n(plan.sinCambios)} sin cambios`,
              plan.omitidos.length && `${n(plan.omitidos.length)} omitidos`,
              plan.errores.length && `${n(plan.errores.length)} con error (no se importan)`,
            ]
              .filter(Boolean)
              .join(" · ") || "Todas las filas son válidas."}
          </p>

          {precios && (precios.suben > 0 || precios.bajan > 0) && (
            <p>
              Cambian de precio: <strong>{n(precios.suben)}</strong> suben y <strong>{n(precios.bajan)}</strong> bajan.
            </p>
          )}
          {precios && precios.fuertes.length > 0 && (
            <Alert tono="aviso" titulo={`${n(precios.fuertes.length)} bajan a menos de la mitad`}>
              Revise que el precio de la web esté bien antes de importar:
              <ul>
                {precios.fuertes.slice(0, 8).map((i) => (
                  <li key={i.fila}>
                    {i.nombre}: {monto(i.antes!.precio)} → {monto(i.precio)}
                  </li>
                ))}
              </ul>
              {precios.fuertes.length > 8 && `y ${n(precios.fuertes.length - 8)} más.`}
            </Alert>
          )}

          <fieldset className="opciones-modo">
            <legend>Si una fila falla al guardar</legend>
            <label className={`opcion ${modo === "todo" ? "elegida" : ""}`}>
              <input type="radio" name="modo" checked={modo === "todo"} onChange={() => setModo("todo")} />
              <span>
                <strong>Todo o nada</strong>
                <span className="muted">No se importa nada y el catálogo queda como estaba.</span>
              </span>
            </label>
            <label className={`opcion ${modo === "validas" ? "elegida" : ""}`}>
              <input type="radio" name="modo" checked={modo === "validas"} onChange={() => setModo("validas")} />
              <span>
                <strong>Importar las válidas</strong>
                <span className="muted">Entran las que están bien y al final se listan las que fallaron.</span>
              </span>
            </label>
          </fieldset>

          {plan.actualizar.length + plan.sinCambios > 0 && (
            <fieldset className="opciones-pisar">
              <legend>Productos que ya estaban en el POS</legend>
              <p className="muted">Se actualizan nombre, precio y si está activo. Código de barras, costo y stock no se tocan nunca.</p>
              <label className="check">
                <input type="checkbox" checked={pisar.departamento} onChange={(e) => setPisar({ ...pisar, departamento: e.target.checked })} />
                Reemplazar también el departamento con el de las reglas
              </label>
              <label className="check">
                <input type="checkbox" checked={pisar.favorito} onChange={(e) => setPisar({ ...pisar, favorito: e.target.checked })} />
                Reemplazar también los favoritos con los destacados de la web
              </label>
            </fieldset>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void confirmar();
            }}
          >
            <Field label="Su PIN" ayuda="Para confirmar que usted autoriza el cambio del catálogo.">
              <input className="pin" type="password" inputMode="numeric" autoComplete="off" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            </Field>
            <div className="row">
              <Button type="submit" variante="primario" icono={Check} disabled={!pin || ocupado || plan.pendientes > 0}>
                {ocupado ? "Importando…" : `Importar ${n(aImportar)} productos`}
              </Button>
              <Button variante="fantasma" icono={ArrowLeft} onClick={() => setPaso("revisar")} disabled={ocupado}>
                Volver a la vista previa
              </Button>
            </div>
          </form>
        </section>
      )}

      {paso === "listo" && resultado && resumen && (
        <>
          <Alert tono={resultado.fallidos.length ? "aviso" : "ok"} titulo={`Listo: ${[resultado.creados && `${n(resultado.creados)} productos nuevos`, resultado.actualizados && `${n(resultado.actualizados)} actualizados`].filter(Boolean).join(" y ") || "no hubo cambios"}`}>
            {resultado.fallidos.length > 0 && `${resultado.fallidos.length} filas no se importaron (abajo).`}
          </Alert>
          <div className="importar-grid">
            <section className="card">
              <h2>Productos por departamento</h2>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Departamento</th>
                    <th className="num">Productos</th>
                  </tr>
                </thead>
                <tbody>
                  {resumen.porDepartamento.map((d) => (
                    <tr key={d.departamentoId} className={d.total ? "" : "inactivo"}>
                      <td>{nombreDep(d.departamentoId)}</td>
                      <td className="num">{n(d.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <aside className="importar-aside card" aria-label="Catálogo">
              <h2>Catálogo</h2>
              <dl className="cifras">
                <div>
                  <dt>Productos</dt>
                  <dd>{n(resumen.total)}</dd>
                </div>
                <div>
                  <dt>Inactivos</dt>
                  <dd>{n(resumen.inactivos)}</dd>
                </div>
                <div>
                  <dt>Favoritos</dt>
                  <dd>{n(resumen.favoritos)}</dd>
                </div>
                <div className={resumen.paraRevisar ? "warn" : ""}>
                  <dt>Para revisar</dt>
                  <dd>{n(resumen.paraRevisar)}</dd>
                </div>
                <div>
                  <dt>Sin código de barras</dt>
                  <dd>{n(resumen.sinBarras)}</dd>
                </div>
              </dl>
              <div className="aside-botones">
                <Button variante="primario" ancho onClick={() => onSalir("sinBarras")}>
                  Completar códigos de barras
                </Button>
                {resumen.paraRevisar > 0 && (
                  <Button ancho onClick={() => onSalir("revisar")}>
                    Ver los {n(resumen.paraRevisar)} para revisar
                  </Button>
                )}
                <Button variante="fantasma" ancho onClick={() => onSalir()}>
                  Ver productos
                </Button>
              </div>
            </aside>
          </div>
          {resultado.fallidos.length > 0 && (
            <section className="card">
              <div className="row between">
                <h2>Filas que fallaron</h2>
                <Button
                  icono={Download}
                  onClick={() =>
                    descargarProblemas(
                      resultado.fallidos.map((f) => ({ ...f, nombre: fuente?.filas.find((x) => x.fila === f.fila)?.nombre ?? "" })),
                      "filas-fallidas.csv",
                    )
                  }
                >
                  Descargar lista (CSV)
                </Button>
              </div>
              <ListaFilas filas={resultado.fallidos.map((f) => ({ ...f, nombre: fuente?.filas.find((x) => x.fila === f.fila)?.nombre ?? "" }))} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Departamentos({ plan, deps, nombreDep }: { plan: Plan; deps: Departamento[]; nombreDep(id: string): string }) {
  const conteo = new Map(plan.porDepartamento.map((c) => [c.departamentoId, c]));
  const max = Math.max(1, ...plan.porDepartamento.map((c) => c.total));
  return (
    <>
      <table className="tbl tbl-deptos">
        <thead>
          <tr>
            <th>Departamento</th>
            <th className="num">Por categoría</th>
            <th className="num">Por regla</th>
            <th className="num">Sin mapeo</th>
            <th className="num">Total</th>
            <th>
              <span className="sr-only">Proporción</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {deps.map((d) => {
            const c = conteo.get(d.id);
            const cero = (x = 0) => (x ? n(x) : <span className="muted">—</span>);
            return (
              <tr key={d.id} className={c ? "" : "inactivo"}>
                <td>
                  {d.codigo} {d.nombre}
                </td>
                <td className="num">{cero(c?.categoria)}</td>
                <td className="num">{cero(c?.regla)}</td>
                <td className="num">{c?.defecto ? <Badge tono="aviso">{n(c.defecto)}</Badge> : cero()}</td>
                <td className="num">
                  <strong>{cero(c?.total)}</strong>
                </td>
                <td className="barra-celda" aria-hidden>
                  {c && <span className="barra" style={{ width: `${(c.total / max) * 100}%` }} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="seccion-cab" style={{ marginTop: "var(--e5)" }}>
        <h3>Cambian de departamento por una regla ({n(plan.cambiadosPorRegla.length)})</h3>
        <p className="muted">Revíselos antes de confirmar. Si alguno no corresponde, ajuste las palabras en «Mapeo y reglas».</p>
      </div>
      {plan.cambiadosPorRegla.length === 0 ? (
        <p className="muted">Ninguno.</p>
      ) : (
        <div className="tabla-scroll tabla-alta">
          <table className="tbl">
            <thead>
              <tr>
                <th>Producto</th>
                <th>Por categoría</th>
                <th>Palabra</th>
                <th>Queda en</th>
              </tr>
            </thead>
            <tbody>
              {plan.cambiadosPorRegla.map((i) => (
                <tr key={i.fila}>
                  <td>{i.nombre}</td>
                  <td className="muted">{nombreDep(i.departamentoCategoria)}</td>
                  <td>«{i.regla?.palabra}»</td>
                  <td>
                    <strong>{nombreDep(i.departamentoReglas)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NombresYFavoritos(p: {
  plan: Plan;
  aceptadas: Set<number>;
  onAceptadas(s: Set<number>): void;
  reglas: ReglasImportacion;
  onReglas(r: ReglasImportacion): void;
  limitar: boolean;
  onLimitar(v: boolean): void;
  favoritosActuales: number;
  pisarFavorito: boolean;
}) {
  const { plan, aceptadas } = p;
  const todas = plan.sugerencias.length > 0 && plan.sugerencias.every((i) => aceptadas.has(i.fila));
  const alternar = (fila: number) => {
    const s = new Set(aceptadas);
    if (s.has(fila)) s.delete(fila);
    else s.add(fila);
    p.onAceptadas(s);
  };
  return (
    <div className="importar-reglas">
      <section aria-labelledby="t-favoritos">
        <div className="seccion-cab">
          <h3 id="t-favoritos">Favoritos</h3>
          <p className="muted">
            Los destacados de la web pasan a favoritos (tarjetas en Venta). Después se cambian con la estrella en Productos.
            {!p.pisarFavorito && p.favoritosActuales > 0 && ` Ya hay ${n(p.favoritosActuales)} favoritos: cuentan dentro del límite.`}
          </p>
        </div>
        <div className="row abajo">
          <label className="check">
            <input type="checkbox" checked={p.limitar} onChange={(e) => p.onLimitar(e.target.checked)} />
            Limitar favoritos a
          </label>
          <input
            aria-label="Cantidad máxima de favoritos"
            type="number"
            min={0}
            max={500}
            className="num-corto"
            disabled={!p.limitar}
            value={p.reglas.favoritosMax}
            onChange={(e) => p.onReglas({ ...p.reglas, favoritosMax: Math.max(0, Math.min(500, Math.trunc(Number(e.target.value) || 0))) })}
          />
          <Field label="Si hay más destacados, elegir por" className="sin-margen">
            <select disabled={!p.limitar} value={p.reglas.criterioFavoritos} onChange={(e) => p.onReglas({ ...p.reglas, criterioFavoritos: e.target.value as CriterioFavoritos })}>
              {Object.entries(CRITERIOS_FAVORITOS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p>
          <strong>{n(plan.favoritos.marcados)}</strong> de {n(plan.favoritos.destacados)} destacados quedan como favoritos.
        </p>
      </section>

      <section aria-labelledby="t-nombres">
        <div className="seccion-cab">
          <h3 id="t-nombres">Nombres</h3>
          <p className="muted">
            Los espacios de más se quitan solos. Las mayúsculas y la redacción no se cambian, salvo las sugerencias que usted acepte aquí.
          </p>
        </div>
        {plan.sugerencias.length === 0 ? (
          <p className="muted">No hay sugerencias.</p>
        ) : (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={todas}
                onChange={() => p.onAceptadas(todas ? new Set() : new Set(plan.sugerencias.map((i) => i.fila)))}
              />
              Aceptar las {n(plan.sugerencias.length)} sugerencias
            </label>
            <table className="tbl">
              <thead>
                <tr>
                  <th>
                    <span className="sr-only">Aceptar</span>
                  </th>
                  <th>En el archivo</th>
                  <th>Sugerencia</th>
                </tr>
              </thead>
              <tbody>
                {plan.sugerencias.map((i) => (
                  <tr key={i.fila} className={aceptadas.has(i.fila) ? "marcado" : ""}>
                    <td style={{ width: 52 }}>
                      <input type="checkbox" aria-label={`Usar «${i.sugerencia}»`} checked={aceptadas.has(i.fila)} onChange={() => alternar(i.fila)} />
                    </td>
                    <td>{i.nombreArchivo}</td>
                    <td>
                      <strong>{i.sugerencia}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </div>
  );
}

const TOPE_LISTA = 300;

function Productos({ plan, nombreDep }: { plan: Plan; nombreDep(id: string): string }) {
  const [ver, setVer] = useState<"nuevos" | "actualizar">(plan.nuevos.length ? "nuevos" : "actualizar");
  const [texto, setTexto] = useState("");
  const lista: ItemPlan[] = (ver === "nuevos" ? plan.nuevos : plan.actualizar).filter((i) => !texto || normalizar(i.nombre).includes(normalizar(texto)));
  const CAMBIO: Record<string, string> = { nombre: "nombre", precio: "precio", activo: "activo", departamento: "departamento", favorito: "favorito", codigo: "código", slug: "id/slug", categorias: "categorías" };
  return (
    <>
      <div className="row between">
        <div className="segmento" role="group" aria-label="Qué productos ver">
          <button type="button" aria-pressed={ver === "nuevos"} onClick={() => setVer("nuevos")}>
            A crear ({n(plan.nuevos.length)})
          </button>
          <button type="button" aria-pressed={ver === "actualizar"} onClick={() => setVer("actualizar")}>
            A actualizar ({n(plan.actualizar.length)})
          </button>
        </div>
        <input aria-label="Buscar en la lista" placeholder="Buscar por nombre" value={texto} onChange={(e) => setTexto(e.target.value)} />
      </div>
      <div className="tabla-scroll tabla-alta">
        <table className="tbl">
          <thead>
            <tr>
              <th>Código</th>
              <th>Nombre</th>
              <th>Departamento</th>
              <th className="num">Precio</th>
              <th>{ver === "nuevos" ? "Estado" : "Cambia"}</th>
            </tr>
          </thead>
          <tbody>
            {lista.slice(0, TOPE_LISTA).map((i) => (
              <tr key={i.fila} className={i.activo ? "" : "inactivo"}>
                <td className="mono">{i.codigo ?? <span className="muted">—</span>}</td>
                <td>
                  {i.nombre} {i.favorito && <span className="sr-only">(favorito)</span>}
                </td>
                <td className="muted">{nombreDep(i.departamentoId)}</td>
                <td className="num">{i.antes && i.antes.precio !== i.precio ? `${monto(i.antes.precio)} → ${monto(i.precio)}` : monto(i.precio)}</td>
                <td>
                  {ver === "nuevos" ? (
                    <span className="row etiquetas">
                      {!i.activo && <Badge tono="aviso">Agotado: inactivo</Badge>}
                      {i.favorito && <Badge tono="info">Favorito</Badge>}
                      {i.revisar && <Badge tono="aviso">Revisar</Badge>}
                    </span>
                  ) : (
                    <span className="muted">{i.cambios.map((c) => CAMBIO[c]).join(", ")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lista.length > TOPE_LISTA && <p className="muted">Se muestran {TOPE_LISTA} de {n(lista.length)}. Busque por nombre para ver otros.</p>}
    </>
  );
}

function ListaFilas({ filas }: { filas: ErrorFila[] }) {
  return (
    <div className="tabla-scroll tabla-alta">
      <table className="tbl">
        <thead>
          <tr>
            <th className="num">Fila</th>
            <th>Nombre</th>
            <th>Problema</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((e) => (
            <tr key={`${e.fila}-${e.mensaje}`}>
              <td className="num">{e.fila}</td>
              <td>{e.nombre || <span className="muted">(vacío)</span>}</td>
              <td>{e.mensaje}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
