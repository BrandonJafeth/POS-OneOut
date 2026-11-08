// Archivos de "exportar mis datos" (derecho de acceso, Ley 8968): CSV y PDF.
import type { ExportacionCliente } from "../db/clientes";
import { TIPO_IDENTIFICACION } from "../tipos";
import { celdaSegura } from "./csv";
import { invocar } from "./invocar";
import type { Negocio } from "../tipos";
import { crearDocumento } from "./pdf";
import { monto } from "./tickets";

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleString("es-CR") : "");

function campos(e: ExportacionCliente): [string, string][] {
  const c = e.cliente;
  return [
    ["Nombre", c.nombre],
    ["Teléfono", c.telefono ?? ""],
    ["Tipo de identificación", c.tipoIdentificacion ? TIPO_IDENTIFICACION[c.tipoIdentificacion] : ""],
    ["Cédula", c.cedula ?? ""],
    ["Correo", c.correo ?? ""],
    ["Notas", c.notas ?? ""],
    ["Consentimiento", c.consentimientoDatos ? "Sí" : "No"],
    ["Fecha del consentimiento", fecha(c.consentimientoFecha)],
    ["Versión del aviso aceptado", c.consentimientoVersion ?? ""],
    ["Registrado", fecha(c.creadoEn)],
    ["Última modificación", fecha(c.actualizadoEn)],
  ];
}

const celda = celdaSegura;

/** CSV (UTF-8 con BOM para que Excel muestre bien las tildes). */
export function csvCliente(e: ExportacionCliente): Uint8Array {
  const filas: string[][] = [["Campo", "Valor"], ...campos(e)];
  filas.push([], ["Apartados / créditos", "Fecha", "Total", "Saldo", "Estado"]);
  for (const k of e.cuentas) filas.push([k.tipo, fecha(k.fecha), String(k.total), String(k.saldo), k.estado]);
  filas.push([], ["Compras (tiquete)", "Fecha", "Total"]);
  for (const v of e.ventas) filas.push([v.numero, fecha(v.fecha), String(v.total)]);
  const texto = "﻿" + filas.map((f) => f.map(celda).join(",")).join("\r\n") + "\r\n";
  return new TextEncoder().encode(texto);
}

export function pdfCliente(e: ExportacionCliente, n: Pick<Negocio, "nombreComercial" | "responsableTratamiento" | "logo">): Uint8Array {
  const saldo = e.cuentas.reduce((s, k) => s + k.saldo, 0);
  return crearDocumento({
    negocio: n.nombreComercial || "Punto de venta",
    titulo: "Datos personales registrados",
    subtitulo: `Responsable del tratamiento: ${n.responsableTratamiento || n.nombreComercial || "—"} · Ley 8968`,
    logo: n.logo,
    bloques: [
      {
        tipo: "resumen",
        items: [
          { etiqueta: "Compras", valor: String(e.ventas.length) },
          { etiqueta: "Apartados y créditos", valor: String(e.cuentas.length) },
          { etiqueta: "Saldo pendiente", valor: monto(saldo) },
        ],
      },
      { tipo: "seccion", titulo: "Datos de la persona" },
      { tipo: "datos", pares: campos(e) },
      { tipo: "seccion", titulo: "Apartados y créditos" },
      {
        tipo: "tabla",
        columnas: [
          { titulo: "Fecha", ancho: 3 },
          { titulo: "Tipo", ancho: 2 },
          { titulo: "Estado", ancho: 2 },
          { titulo: "Total", ancho: 2, derecha: true },
          { titulo: "Saldo", ancho: 2, derecha: true },
        ],
        filas: e.cuentas.map((k) => [fecha(k.fecha), k.tipo, k.estado, monto(k.total), monto(k.saldo)]),
        vacio: "No tiene apartados ni créditos.",
      },
      { tipo: "seccion", titulo: "Compras" },
      {
        tipo: "tabla",
        columnas: [
          { titulo: "Tiquete", ancho: 2 },
          { titulo: "Fecha", ancho: 4 },
          { titulo: "Total", ancho: 2, derecha: true },
        ],
        filas: e.ventas.map((v) => [v.numero, fecha(v.fecha), monto(v.total)]),
        total: e.ventas.length ? ["Total", "", monto(e.ventas.reduce((s, v) => s + v.total, 0))] : undefined,
        vacio: "No tiene compras registradas a su nombre.",
      },
      { tipo: "texto", texto: "Documento entregado al titular de los datos (derecho de acceso). Puede pedir que se corrijan o que se anonimicen.", tenue: true },
    ],
  });
}

/** Descarga (WebView2 lo guarda en Descargas). */
/** Rust lo guarda en Descargas (sin pisar otro) y devuelve la ruta real, para decírsela al usuario. */
export async function descargar(nombre: string, bytes: Uint8Array): Promise<string> {
  return String(await invocar("guardar_descarga", { nombre, datos: Array.from(bytes) }));
}
