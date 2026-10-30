// Archivos de "exportar mis datos" (derecho de acceso, Ley 8968): CSV y PDF.
import type { ExportacionCliente } from "../db/clientes";
import { TIPO_IDENTIFICACION } from "../tipos";
import { crearPdf, type LineaPdf } from "./pdf";
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

function celda(s: string): string {
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

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

export function pdfCliente(e: ExportacionCliente, responsable: string): Uint8Array {
  const l: LineaPdf[] = [
    { texto: "Datos personales registrados", negrita: true },
    { texto: `Responsable: ${responsable}` },
    { texto: `Generado: ${fecha(new Date().toISOString())}` },
    { texto: "" },
    ...campos(e).map(([k, v]) => ({ texto: `${k}: ${v}` })),
    { texto: "" },
    { texto: "Apartados y créditos", negrita: true },
    ...(e.cuentas.length ? e.cuentas.map((k) => ({ texto: `${fecha(k.fecha)} · ${k.tipo} · total ${monto(k.total)} · saldo ${monto(k.saldo)} · ${k.estado}` })) : [{ texto: "Ninguno" }]),
    { texto: "" },
    { texto: "Compras", negrita: true },
    ...(e.ventas.length ? e.ventas.map((v) => ({ texto: `${fecha(v.fecha)} · tiquete ${v.numero} · ${monto(v.total)}` })) : [{ texto: "Ninguna" }]),
  ];
  return crearPdf(l);
}

/** Descarga (WebView2 lo guarda en Descargas). */
export function descargar(nombre: string, bytes: Uint8Array, tipo: string): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: tipo }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
