// Estado de cuenta de un cliente (solo dueño): sus créditos y apartados abiertos, cada abono con fecha
// y hora real, y el total que debe. En la térmica (impresora de tiquetes) y en PDF carta. Los datos
// vienen de Rust (cuentas::estado_cuenta); aquí solo se formatean.
import type { EstadoCuenta } from "../../db/cuentas";
import type { Negocio } from "../../tipos";
import { EscPos } from "../escpos";
import { escribirEncabezado } from "../impresion";
import type { Bloque } from "../pdf";
import { columnas, fechaHora, lr, lrLargo, monto, sep, sep2, type Doc, type TicketSettings, wrap } from "../tickets";

const fecha = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");
const tipo = (t: string) => (t === "credito" ? "Crédito" : "Apartado");

export function estadoCuentaTermica(n: Negocio, ec: EstadoCuenta, s: TicketSettings): Doc {
  const c = columnas(s);
  const p = new EscPos(s.codePage, { sinModoChino: s.sinModoChino });
  escribirEncabezado(p, n, c);
  p.line(sep2(c));
  p.align("center").bold(true).line("ESTADO DE CUENTA").bold(false).align("left");
  p.line(lr("Fecha:", fechaHora(new Date()), c));
  wrap("Cliente: " + ec.cliente, c).forEach((l) => p.line(l));
  for (const d of ec.cuentas) {
    const k = d.cuenta;
    p.line(sep(c));
    p.bold(true).line(lr(`${tipo(k.tipo)} ${k.numero}`, k.estado === "abierta" ? "" : "pagado", c)).bold(false);
    p.line(lr("Total", monto(k.total), c));
    for (const a of d.abonos.filter((x) => !x.anulado)) {
      const f = fechaHora(new Date(a.fecha)); // dd/mm/aaaa hh:mm:ss
      // Si la forma no cabe junto al monto, el monto baja a la línea siguiente (no se corta).
      lrLargo(`  ${f.slice(0, 5)} ${f.slice(11, 16)} ${a.forma}`, monto(a.monto), c).forEach((l) => p.line(l));
    }
    p.line(lr("Saldo", monto(k.saldo), c));
    if (k.estado === "abierta") p.line(lr(k.tipo === "credito" ? "Pagar antes del" : "Retirar antes del", fecha(k.fechaLimite), c));
  }
  p.line(sep2(c));
  p.bold(true).line(lr("TOTAL ADEUDADO", monto(ec.totalAdeudado), c)).bold(false);
  p.feed(4);
  if (s.cortador) p.cut();
  return { bytes: p.bytes(), missing: [...p.missing] };
}

export function estadoCuentaPdf(ec: EstadoCuenta): Bloque[] {
  const b: Bloque[] = [
    {
      tipo: "resumen",
      items: [
        { etiqueta: "Cliente", valor: ec.cliente },
        { etiqueta: "Total adeudado", valor: monto(ec.totalAdeudado) },
        { etiqueta: "Cuentas", valor: String(ec.cuentas.length) },
      ],
    },
  ];
  for (const d of ec.cuentas) {
    const k = d.cuenta;
    b.push(
      { tipo: "seccion", titulo: `${tipo(k.tipo)} ${k.numero}`, nota: k.descripcion ?? undefined },
      {
        tipo: "datos",
        pares: [
          ["Creado", fecha(k.fecha.slice(0, 10))],
          ["Total", monto(k.total)],
          ["Abonado", monto(k.abonado)],
          ["Saldo", monto(k.saldo)],
          [k.tipo === "credito" ? "Pagar antes del" : "Retirar antes del", k.estado === "abierta" ? fecha(k.fechaLimite) : "Pagado"],
        ],
      },
      {
        tipo: "tabla",
        columnas: [
          { titulo: "Fecha y hora", ancho: 3 },
          { titulo: "Forma de pago", ancho: 3 },
          { titulo: "Monto", ancho: 2, derecha: true },
        ],
        filas: d.abonos.filter((a) => !a.anulado).map((a) => [fechaHora(new Date(a.fecha)), a.forma, monto(a.monto)]),
        vacio: "Sin abonos.",
      },
    );
  }
  return b;
}
