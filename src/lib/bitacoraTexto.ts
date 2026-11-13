// La bitácora en palabras: cada acción técnica ("venta.anular" + {total: 4500…}) se convierte en una
// frase que el dueño entiende ("Anuló el tiquete A-102 de ¢4.500. Motivo: …"). La técnica sigue
// intacta en Técnico → Bitácora. Una acción nueva sin frase aquí sale igual, con un texto genérico.
import type { EntradaBitacora } from "../tipos";
import { monto } from "./tickets";

export type Grupo = "dinero" | "ventas" | "productos" | "usuarios" | "clientes" | "sistema";

export const GRUPOS: Record<Grupo, string> = {
  dinero: "Caja y dinero",
  ventas: "Ventas",
  productos: "Productos e inventario",
  usuarios: "Usuarios y accesos",
  clientes: "Clientes",
  sistema: "Sistema y respaldos",
};

export interface Frase {
  texto: string;
  grupo: Grupo;
  /** Lo que el dueño debería mirar: anulaciones, diferencias, gaveta, PIN equivocado, alteraciones… */
  importante: boolean;
  /** Pasa muchas veces al día y no cambia nada (entrar, consultar clientes, el tema…): se oculta por defecto. */
  rutina: boolean;
}

const RUTINA = new Set(["login.ok", "cliente.ver", "cliente.listar", "cliente.copiar", "respaldo.automatico"]);

type D = Record<string, unknown>;
const txt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const plata = (v: unknown) => (num(v) === null ? "" : monto(num(v)!));
const motivo = (d: D) => (txt(d.motivo) ? `. Motivo: «${txt(d.motivo)}»` : "");
const rol = (r: unknown) => ({ dueno: "dueño", cajero: "cajero", tecnico: "técnico" })[String(r)] ?? String(r ?? "");

/** `nombres`: id de usuario → nombre, para decir quién autorizó con su PIN. */
export function describir(e: EntradaBitacora, nombres: Record<string, string> = {}): Frase {
  const frase = frasePara(e, nombres);
  const rutina = !frase.importante && (RUTINA.has(e.accion) || (e.accion === "config.cambiar" && e.entidadId === "tema"));
  return { ...frase, rutina };
}

function frasePara(e: EntradaBitacora, nombres: Record<string, string>): Omit<Frase, "rutina"> {
  const d: D = e.detalle && typeof e.detalle === "object" ? (e.detalle as D) : {};
  const quien = (id: unknown) => nombres[String(id)] ?? "";
  const autorizo = txt(d.autorizadoPor) ? ` (autorizó ${quien(d.autorizadoPor) || "el dueño"} con su PIN)` : "";
  const f = (grupo: Grupo, texto: string, importante = false) => ({ grupo, texto, importante });
  const antes = (d.antes ?? {}) as D;
  const despues = (d.despues ?? {}) as D;

  switch (e.accion as string) {
    // ── Caja y dinero
    case "caja.abrir":
      return f("dinero", `Abrió la caja con un fondo de ${plata(d.fondo)}.`);
    case "caja.cerrar": {
      const dif = num(d.diferencia) ?? 0;
      const cuadre = dif === 0 ? "Cuadró." : dif < 0 ? `Faltaron ${monto(-dif)}.` : `Sobraron ${monto(dif)}.`;
      return f("dinero", `Cerró la caja: ${num(d.ventas) ?? 0} ventas por ${plata(d.total)}. Esperado ${plata(d.esperado)}, contado ${plata(d.contado)}. ${cuadre}`, dif !== 0);
    }
    case "caja.diferencia":
      return f("dinero", `El cierre quedó con una diferencia de ${plata(d.diferencia)}, más de lo permitido: hay que revisarlo.`, true);
    case "caja.diferencia_revisada":
      return f("dinero", "Marcó como revisada la diferencia de un cierre.");
    case "caja.nota_cierre":
      return f("dinero", `Agregó una nota al cierre: «${txt(d.nota)}».`);
    case "caja.reabrir":
      return f("dinero", `Reabrió una caja ya cerrada${motivo(d)}${autorizo}.`, true);
    case "caja.entrada":
      return f("dinero", `Registró una entrada de efectivo de ${plata(d.monto)} (${txt(d.categoria)})${txt(d.nota) ? `: «${txt(d.nota)}»` : ""}.`);
    case "caja.salida":
      return f("dinero", `Sacó ${plata(d.monto)} de la caja (${txt(d.categoria)})${txt(d.nota) ? `: «${txt(d.nota)}»` : ""}${autorizo}.`, !!txt(d.autorizadoPor));
    case "caja.salida_rechazada":
      return f("dinero", `Intentó sacar ${plata(d.monto)} de la caja, pero no había tanto efectivo.`, true);
    case "caja.corte":
      return f("dinero", `Hizo un corte de caja: ${num(d.ventas) ?? 0} ventas por ${plata(d.total)}${num(d.retiro) ? ` y retiró ${plata(d.retiro)}` : ""}.`, !!num(d.retiro));
    case "caja.z_imprimir":
      return f("dinero", "Imprimió el cierre Z.");
    case "caja.z_reimprimir":
      return f("dinero", `Reimprimió el cierre Z (copia)${autorizo}.`);
    case "caja.consecutivo":
      return f("dinero", `Cambió el número del próximo tiquete de ${String(d.antes ?? "")} a ${String(d.despues ?? "")}.`, true);
    case "caja.ajuste_pago":
      return f("dinero", `Corrigió la forma de pago de una venta de un día ya cerrado (${plata(d.monto)}): de ${txt(antes.forma)} a ${txt(despues.forma)}${motivo(d)}.`, true);
    case "gaveta.no_venta":
      return f("dinero", `Abrió la gaveta sin vender (${txt(d.motivo)})${txt(d.nota) ? `: «${txt(d.nota)}»` : ""}.`, true);
    case "gaveta.orden_dueno":
      return f("dinero", `Abrió la gaveta por orden del dueño${motivo(d)}${autorizo}.`, true);

    // ── Ventas
    case "venta.anular": {
      const dev = num(d.devolucionEfectivo) ? ` Devolvió ${plata(d.devolucionEfectivo)} en efectivo.` : "";
      const fac = "facturaEmitida" in d ? " Tenía factura electrónica: falta la nota de crédito." : "";
      return f("ventas", `Anuló el tiquete ${txt(d.numero)} de ${plata(d.total)}${motivo(d)}${autorizo}.${dev}${fac}`, true);
    }
    case "venta.pago_corregido":
      return f("ventas", `Corrigió un pago de ${plata(d.monto)}: de ${txt(antes.forma)} a ${txt(despues.forma)}${num(d.redondeo) ? ` (redondeado ${plata(d.redondeo)})` : ""}${autorizo}.`, true);
    case "venta.descuento_autorizado":
      return f("ventas", `Dio un descuento de ${num(d.pct) ?? ""} %, más de lo que le permite su rol${autorizo}.`, true);
    case "venta.sin_existencia":
      return f("ventas", `Vendió sin existencia en el inventario: ${Array.isArray(d.productos) ? d.productos.join(", ") : ""}${autorizo}.`, true);
    case "venta.referencia_repetida":
      return f("ventas", "Cobró con un comprobante de SINPE o transferencia que ya se había usado en otro tiquete: revise que el dinero sí entró.", true);
    case "venta.reimprimir":
      return f("ventas", "Reimprimió un tiquete (copia).");
    case "venta.pedir_factura":
      return f("ventas", "Marcó una venta para factura electrónica.");
    case "venta.factura_emitida":
      return f("ventas", `Registró la factura electrónica ${txt(d.referencia)}.`);
    case "venta_espera.descartar":
      return f("ventas", `Descartó la venta ${String(d.numero ?? "")} sin cobrar (${num(d.lineas) ?? 0} productos por ${plata(d.total)}).`, (num(d.total) ?? 0) > 0);
    case "venta_espera.quitar_linea":
      return f("ventas", `Quitó «${txt(d.descripcion)}» (${num(d.cantidad) ?? 1} por ${plata(d.monto)}) de una venta antes de cobrar.`);

    // ── Productos e inventario
    case "producto.crear":
      return f("productos", `Creó el producto «${txt(d.nombre)}» a ${plata(d.precio)}.`);
    case "producto.precio":
      return f("productos", `Cambió el precio de «${txt(d.nombre)}» de ${plata(d.antes)} a ${plata(d.despues)}.`);
    case "producto.editar":
      if (txt(d.favoritos)) return f("productos", `${d.favoritos === "marcar" ? "Marcó" : "Quitó"} ${num(d.cantidad) ?? 0} productos ${d.favoritos === "marcar" ? "como" : "de"} favoritos.`);
      if ("favorito" in despues) return f("productos", despues.favorito ? "Marcó un producto como favorito." : "Quitó un producto de favoritos.");
      return f("productos", `Editó un producto (${Object.keys(despues).map((k) => CAMPO[k] ?? k).join(", ")}).`);
    case "producto.eliminar":
      return f("productos", `Eliminó el producto «${txt(d.nombre)}» (${plata(d.precio)}).`);
    case "codigo.asociar":
      return f("productos", `Agregó el código ${e.entidadId ?? ""} a un producto.`);
    case "codigo.mover":
      return f("productos", `Pasó el código ${e.entidadId ?? ""} de «${txt(d.deNombre)}» a otro producto.`);
    case "codigo.quitar":
      return f("productos", `Quitó el código ${e.entidadId ?? ""} de «${txt(d.nombre)}».`);
    case "importacion":
      return f("productos", "Importó productos desde un archivo.");
    case "departamento.crear":
      return f("productos", `Creó el departamento «${txt(d.nombre)}».`);
    case "departamento.editar":
      return f("productos", "Cambió un departamento.");
    case "inventario.ajuste":
      return f("productos", `Ajustó la existencia de «${txt(d.nombre)}» de ${String(d.antes ?? "")} a ${String(d.despues ?? "")}${motivo(d)}${autorizo}.`, true);
    case "inventario.entrada":
      return f("productos", "Registró una entrada de mercadería.");
    case "inventario.conteo":
      return f("productos", `Aplicó un conteo físico: ${num(d.contados) ?? 0} productos contados, ${num(d.ajustados) ?? 0} con diferencia${autorizo}.`, (num(d.ajustados) ?? 0) > 0);
    case "inventario.conteo_descartado":
      return f("productos", "Descartó un conteo físico sin aplicarlo.");
    case "inventario.inicial":
      return f("productos", `Cargó el inventario inicial (${num(d.filas) ?? 0} productos)${autorizo}.`);
    case "inventario.producto":
      return f("productos", `Cambió el mínimo o el costo de «${txt(d.nombre)}».`);
    case "proveedor.guardar":
      return f("productos", "Creó o cambió un proveedor.");
    case "proveedor.eliminar":
      return f("productos", "Eliminó un proveedor.");

    // ── Usuarios y accesos
    case "login.ok":
      return f("usuarios", "Entró al sistema.");
    case "login.fallido":
      return f("usuarios", "Escribió mal su PIN al entrar.");
    case "login.bloqueado":
      return f("usuarios", "Se equivocó de PIN varias veces seguidas: la entrada quedó en espera.", true);
    case "autorizacion.fallida":
      return f("usuarios", `Se escribió mal el PIN del dueño para autorizar: ${txt(d.contexto)}.`, true);
    case "usuario.crear":
      return f("usuarios", `Creó el usuario «${txt(d.nombre)}» (${rol(d.rol)}).`);
    case "usuario.editar":
      if (antes.activo !== despues.activo) return f("usuarios", `${despues.activo ? "Activó" : "Desactivó"} al usuario «${txt(despues.nombre)}».`);
      return f("usuarios", `Cambió el nombre de «${txt(antes.nombre)}» a «${txt(despues.nombre)}».`);
    case "usuario.pin":
      return f("usuarios", "Cambió un PIN.");
    case "usuario.eliminar":
      return f("usuarios", `Eliminó al usuario «${txt(d.nombre)}» (${rol(d.rol)}).`, true);

    // ── Clientes (nunca datos personales: solo qué se hizo)
    case "cliente.crear":
      return f("clientes", "Registró un cliente nuevo.");
    case "cliente.editar":
      return f("clientes", "Corrigió los datos de un cliente.");
    case "cliente.exportar":
      return f("clientes", "Exportó los datos de un cliente para entregárselos.");
    case "cliente.anonimizar":
      return f("clientes", "Anonimizó a un cliente (borró sus datos personales).", true);
    case "cliente.anonimizar_rechazado":
      return f("clientes", "Intentó anonimizar a un cliente con saldo pendiente.");
    case "cliente.ver":
    case "cliente.listar":
      return f("clientes", "Consultó la lista o los datos de clientes.");
    case "cliente.copiar":
      return f("clientes", "Copió un dato de cliente para la factura electrónica.");

    // ── Sistema y respaldos
    case "respaldo.crear":
      return f("sistema", "Hizo un respaldo a mano.");
    case "respaldo.automatico":
      return f("sistema", d.verificado === false ? "El respaldo automático se hizo pero no se pudo verificar." : "Se hizo el respaldo automático.", d.verificado === false);
    case "respaldo.automatico_fallido":
      return f("sistema", "El respaldo automático falló.", true);
    case "respaldo.auto_configurado":
      return f("sistema", "Configuró el respaldo automático.");
    case "respaldo.usb_confirmado":
      return f("sistema", "Confirmó que copió los respaldos a la memoria USB.");
    case "respaldo.restaurar":
    case "respaldo.restaurado":
      if (d.noSePudoLeerLaBaseAnterior)
        return f("sistema", "Restauró un respaldo, pero no se pudo leer la base que reemplazó: los números de tiquete pueden repetir los ya entregados. Avise al técnico.", true);
      if (Number(d.ventasQueNoEstanEnElRespaldo) > 0)
        return f("sistema", `Restauró un respaldo: ${d.ventasQueNoEstanEnElRespaldo} venta(s) posteriores a esa copia no están. Los números de tiquete siguen sin repetirse.`, true);
      return f("sistema", "Restauró un respaldo: los datos volvieron a como estaban en esa copia.", true);
    case "respaldo.restaurar_fallido":
      return f("sistema", "Intentó restaurar un respaldo y no se pudo.", true);
    case "config.cambiar":
      if (e.entidadId === "tema") return f("sistema", `Cambió el tema de la pantalla a ${d.despues === "oscuro" ? "oscuro" : "claro"}.`);
      return f("sistema", `Cambió la configuración «${CONFIG[e.entidadId ?? ""] ?? e.entidadId ?? ""}».`);
    case "negocio.cambiar":
      return f("sistema", "Cambió los datos del negocio.");
    case "negocio.logo":
      return f("sistema", "Cambió el logo del tiquete.");
    case "forma_pago.guardar":
      return f("sistema", `Guardó la forma de pago «${txt(d.nombre)}».`);
    case "banco.guardar":
      return f("sistema", `Guardó el banco «${txt(d.nombre)}».`);
    case "impresora.guardar":
    case "impresora.eliminar":
    case "impresora.asignar":
      return f("sistema", "El técnico cambió la configuración de impresoras.");
    case "lectura.rechazada":
      return f("sistema", "El sistema bloqueó una consulta no permitida.", true);
    case "bitacora.alterada":
      return f("sistema", "ALERTA: alguien modificó la bitácora directamente en el archivo. Avise al técnico.", true);
    case "bd.integridad_fallida":
      return f("sistema", "La revisión de la base de datos encontró un problema. Avise al técnico.", true);
  }
  return f("sistema", `Acción del sistema (${e.accion}).`);
}

// Las claves de configuración que más cambia el dueño, con su nombre en pantalla.
const CONFIG: Record<string, string> = {
  departamentos_color: "colores de los departamentos",
  color_fondo: "color de fondo",
  caja_turno_compartido: "turno compartido",
  caja_umbral_diferencia: "diferencia permitida al cerrar",
  caja_salida_max_sin_pin: "salida máxima sin PIN",
  permitir_vender_sin_existencia: "vender sin existencia",
  venta_mostrar_existencia: "mostrar la existencia en la venta",
  descuento_max_pct: "descuento máximo por rol",
  redondeo_total: "redondeo del total",
};

const CAMPO: Record<string, string> = {
  nombre: "nombre",
  departamentoId: "departamento",
  precio: "precio",
  activo: "activo",
  cabys: "CABYS",
  tasaIva: "IVA",
  exento: "exento",
  descuentoPct: "descuento",
};
