# Diseño fase 5: reportes de ventas

_Aprobado el 2026-11-19 con las recomendaciones marcadas (→) e implementado el mismo día. Además, a pedido: el historial de cierres de caja pasó de Caja a Reportes._

Cada punto con varias opciones trae la recomendación marcada con **→**.

---

## 0. Punto de partida

**Lo que ya hay:**
- Los reportes de inventario: bajo mínimo, valorizado y movimientos.
- `estadisticas.rs`: por hora, tiquete promedio, mismo día de la semana anterior y más vendidos, **por turno**.
- El Z congelado en `caja_turnos.totales`.
- `pdf.ts` y `csv.ts` (sin fórmulas).
- `guardar_descarga`, que ya guarda en `Documentos\Punto de venta\<carpeta>\AAAA-MM\`.

**Índices que ya existen:**
- `caja_turnos(caja_id, dia)`;
- `ventas(turno_id)`, `ventas(turno_id, usuario_id)`, `ventas(caja_id, dia)`;
- `venta_lineas(venta_id)`, `venta_pagos(venta_id)`.

**Hallazgos que cambian el diseño:**
1. **El técnico tiene el permiso `reportes`** (lo usa para la bitácora). Las ventas llevan nombres de clientes (Ley 8968) y el pedido dice "solo el dueño". **→ Permiso nuevo `reportes.ventas`**, solo para el dueño. El técnico conserva `reportes` para la bitácora.
2. **No hay costo histórico.** `producto_costos` guarda solo el último costo y `venta_lineas` no guarda el costo del momento de la venta. Ver §1.3.
3. **Una venta anulada después de cerrar su turno cambia `ventas.estado`, pero su Z congelado no cambia.** Una consulta "en vivo" ingenua no coincidiría con el Z. Ver §2.

---

## 1. Reportes

Todos por **rango de fechas de negocio** (`caja_turnos.dia`, la fecha del turno; regla `ventas::DIA_NEGOCIO`). Solo cuentan turnos **cerrados**. Los turnos abiertos van en un bloque aparte, "En curso", que no suma al total del rango.

| Reporte | Agrupa por | Columnas | Nota |
|---|---|---|---|
| Ventas por día | fecha de negocio | tiquetes, ventas, descuentos, anuladas en el día, neto, promedio | Nunca suma fondos. Marca los días con caja tardía o con varios turnos. |
| Por departamento | departamento | monto, % del total, unidades | Mismo reparto exacto que el Z (`desglose`). |
| Por producto | producto | unidades, monto, % | Los más y los menos vendidos (estos últimos entre los activos con control). Precio libre agrupado por departamento. |
| Por usuario | quien cobró | tiquetes, monto, descuentos dados, anulaciones | En turno compartido el efectivo es de la caja, no del usuario: se dice en la cabecera. |
| Por forma de pago | forma | ventas por forma + abonos por forma, por separado | Explica el dinero. |
| Por hora del día | hora **real** (`ventas.fecha`) | tiquetes, monto promedio por día | Es el único que usa la hora real, como se pidió. |
| Descuentos y anulaciones | tipo | descuentos del cajero, de catálogo, autorizados con PIN; anulaciones del mismo turno y posteriores | Con usuario y motivo. |
| Ventas después del cierre | venta | fecha y hora real, tiquete, usuario, día al que contó | Regla `VENTA_TARDIA` que ya existe. |
| Diferencias de caja | turno | diferencia de apertura, diferencia de cierre, nota y revisada | Lo mismo que hoy está en Turnos, en un rango. |
| Apartados y crédito | cuenta | saldo, antigüedad (0–30, 31–60, 61–90, > 90 días desde la fecha límite), vencidos | Cuentas por cobrar a la fecha final del rango. |
| Utilidad bruta | producto o departamento | venta, costo, utilidad, margen | Solo con costo; los productos sin costo aparte (§1.3). |

**Comparativo:** cada reporte de montos muestra el período anterior de la misma duración (el mes anterior para "este mes"; los 7 días anteriores para una semana) y la variación en ¢ y %. No hay comparativo en saldos ni en diferencias de caja.

### 1.3 Costo para la utilidad bruta

| Opción | Exactitud | Costo |
|---|---|---|
| A. Usar el último costo actual | Falsa si el costo cambió. Ensucia todo el historial. | Nada |
| **→ B. Guardar `venta_lineas.costo_unitario` al cobrar desde ahora** (columna nueva, nullable) y usar el último costo solo para ventas viejas, marcadas "costo aproximado" | Exacta desde la migración | Una columna y una línea en `cobrar_con` |

**→ B**, y la columna se agrega en la migración de la **fase 3**. Así empieza a juntar datos un mes antes de que salga el reporte.
- Productos sin costo: fila aparte, "sin costo: no entran en la utilidad".
- El costo solo lo ve el dueño (ya es así).

---

## 2. Consistencia con los cierres Z

**Regla:** la suma de un reporte en un rango = la suma de los Z de los turnos de esas fechas de negocio.

| Opción | Cómo | Pros | Contras |
|---|---|---|---|
| A. Leer el JSON congelado de los Z | Suma `totales` de cada turno cerrado | Coincide por definición | Solo lo que el Z guardó. Los Z viejos (antes de la migración 9) no tienen desglose. Sin ranking por producto entre turnos viejos. Lento si se parsean miles de JSON. |
| **→ B. SQL en vivo con la regla "como al cerrar"**, más un control contra el JSON | Una venta cuenta en su turno si `estado = 'completada'` **o** se anuló en **otro** turno (`anulada_turno_id <> turno_id`). Eso es exactamente lo que vio el Z al cerrar. | Cualquier agrupación, rápido con índices | Hay que mantener la regla en un solo lugar (`reportes::VENTA_EN_SU_Z`) |

**→ B.** Además, cada reporte compara el total en vivo de cada turno con `totales.totalVentas` del JSON. Si algún turno no coincide, avisa en un recuadro ("El turno del 12-nov no coincide con su Z: revisar") en vez de esconderlo. Es lo mismo que hace `revisar_cuadre` en el Z.

### Cómo se trata cada caso

| Caso | Dónde aparece |
|---|---|
| Venta anulada en su mismo turno | No suma en ningún lado. Sale en "Anulaciones" del día, como en el Z. |
| Venta anulada después de cerrar su turno | Suma en su día original, como en su Z. La anulación sale como **"Anulaciones de días anteriores"** en el día del turno donde se anuló (`anulada_turno_id`). El neto del rango las resta, y se muestran por separado. |
| Corrección de forma de pago de un turno cerrado (`caja_ajustes 'pago'`) | No cambia las ventas. En "por forma de pago" sale como ajuste en el día del turno actual. |
| Devolución de efectivo (anulación o apartado) | Es una salida de caja, no un cambio de ventas. Sale en "Dinero" y en "Diferencias", no en "Ventas". |
| Abonos | Son **dinero**, no ventas. Van en "por forma de pago (abonos)" el día del turno donde se recibieron. La venta del apartado entra a "Ventas" el día que se liquida (fase 3, opción B). |
| Retenido de un apartado cancelado | "Otros ingresos", aparte de las ventas. |
| Caja tardía (sábado que cuenta para el lunes) | Va al día del turno: **lunes**. "Ventas después del cierre" la lista con su hora real del sábado. "Por hora" la cuenta en su hora real. |
| Días con varios turnos | Suma de los turnos de ese día. Los fondos no se suman nunca (el reporte no lee fondos). |
| Turno abierto | Bloque "En curso", aparte, sin entrar al total, y solo para el dueño. |
| Turno reabierto y vuelto a cerrar | Cuenta su último cierre (el JSON se reemplaza al cerrar de nuevo). |

### Prueba de consistencia (al implementar)
Datos de prueba con el reloj fijo que incluyen:
- anulaciones del mismo turno y posteriores;
- correcciones de pago y devoluciones;
- abonos, liquidaciones y cancelaciones;
- la caja del sábado que cuenta para el lunes;
- un día con tres turnos.

Se verifica, para cada reporte de montos: suma del reporte = suma de `totales` de los Z del rango.

---

## 3. Permisos

| Comando | Cajero | Dueño | Técnico |
|---|:---:|:---:|:---:|
| `reporte_ventas_*` (todos los de §1) | — | ✔ | — |
| `reporte_utilidad` | — | ✔ | — |
| `reporte_cuentas_por_cobrar` | — | ✔ | — |

Permiso `reportes.ventas` (§0). Rust lo revisa en cada comando, y la prueba `cada_comando_con_cada_rol_respeta_la_tabla` suma las filas. El cajero nunca: tampoco ve totales del turno abierto (`ve_totales`).

---

## 4. Exportación

- **CSV:** con `csv.ts`.
  - UTF-8 con BOM, para que Excel lea las tildes.
  - Celdas que empiezan con `= + - @`, tabulador o retorno, con `'` antepuesto (ya existe).
  - Montos como enteros sin punto de miles, para que Excel los sume.
  - Fecha como `AAAA-MM-DD`.
- **PDF carta:** con `pdf.ts` (logo, cabecera del negocio, rango, "Generado el … por …", número de página). Mismo estilo que el PDF del Z.
- **Destino:** `guardar_descarga` con carpeta `Reportes` (se agrega a `util::carpeta_valida`) y el mes del **final del rango**:
  - `Documentos\Punto de venta\Reportes\AAAA-MM\`
  - nombre: `ventas-por-dia_2026-11-01_2026-11-30.pdf`
- La bitácora registra `reporte.exportar` (tipo y rango, sin datos).

---

## 5. Rendimiento

**Meta:** un mes con 50.000 ventas en total, en menos de 2 s. Ya hay una prueba con 50.000 ventas (`rapido_con_50000_ventas_y_2000_productos`); se amplía con los reportes.

**Plan de consulta:**
1. Turnos del rango por `caja_turnos(caja_id, dia)` (decenas).
2. Ventas por `ventas(turno_id)`.
3. Líneas y pagos por `venta_id`.

Todo en SQL agregado, sin traer filas a Rust.

**Índices nuevos:**
- `ventas(anulada_turno_id)`: anulaciones de días anteriores.
- `venta_lineas(producto_id)`: producto en rango y utilidad.
- `abonos(turno_id)`: viene de la fase 3.
- `cuentas(estado, fecha_limite)`: antigüedad y vencidos (fase 3).

Si una consulta pasa de 2 s en la prueba, se revisa con `EXPLAIN QUERY PLAN` antes de agregar otro índice.

---

## 6. Pantalla

**Menú:** "Reportes" (dueño), con pestañas por reporte. Patrón ARIA tablist con ←/→, `flechasPestanas` (ya existe).

**Filtro de fechas:**
- Dos `<input type="date">` nativos.
- Atajos: **Hoy · Ayer · Esta semana · Este mes · Mes anterior**.
- "Hoy" es el día de negocio actual que da Rust (`EstadoCaja.hoy`), no la fecha de la PC. Con una caja tardía abierta, "hoy" es el lunes.
- La semana empieza el lunes. Los atajos se calculan en Rust (`reporte_rangos`) para usar el reloj inyectable.

**Tablas** (guía `sortable-table`):
- `<table>` con `<caption>`;
- `<button>` dentro de cada `<th scope="col">` ordenable y `aria-sort` solo en la columna activa;
- `Intl.Collator('es-CR', { numeric: true, sensitivity: 'base' })` para el texto y valores crudos en `data-value` para los montos;
- un mensaje `aria-live` con el orden.

**Montos:** con el `monto()` que ya existe (¢ pegado, punto de miles, tabulares, a la derecha). `Intl.NumberFormat('es-CR')` solo para porcentajes. Fechas con `Intl.DateTimeFormat('es-CR')`.

**Gráficos, solo dos:**
- barras de ventas por día;
- barras de ventas por hora.

Cada uno en SVG simple, con la tabla al lado (el gráfico no es la única forma de leer el dato). Al implementar se carga la guía de visualización del proyecto. Sin librerías.

**Diseño:** DESIGN.md, sin colores nuevos fuera de `TEMAS`, con controles de 44 px y foco visible. Los comparativos usan texto ("+12 % contra octubre"), no solo color.

---

## 7. Modern Web Guidance y WebView2

### Escaneo `legacy-scan` (resumen)
22 hallazgos en 3 guías. **Ninguno toca estas fases; quedan como pendientes:**

| Guía | Hallazgos | Lectura |
|---|---|---|
| `autofill-sign-in-form` | 8 | Campos de PIN y contraseña de respaldo sin `autocomplete="current-password"` / `new-password`. En los PIN es discutible: no se quiere que Windows guarde el PIN del dueño. Revisar caso por caso. |
| `ime-safe-enter-submit` | 5 | Enter sin `isComposing` (lector, buscador, cantidades). Bajo riesgo en español. `ui/teclado.ts`, que es nuevo, ya lo revisa. |
| `js/copying-array-methods` | 7 | `[...x].sort()` → `toSorted()`. Cosmético. |
| `js/text-decoder` | 2 | `preview.ts` arma una cadena binaria Latin-1. Probablemente no aplica (regla "Drop"). |

### WebView2
- **Modo de instalación:** `tauri.conf.json` no fija `webviewInstallMode`, así que usa el predeterminado: bootstrapper, runtime **evergreen** que se actualiza con Windows.
- **Versión en la PC de desarrollo:** 157.0.4341.60.
- **Riesgo:** la PC del negocio puede tener una versión vieja si casi no se conecta. **Falta leer la versión en esa PC** (registro `EdgeUpdate\Clients\{F3017226-…}`, valor `pv`).

**→ Propuesta:**
- **Mínimo soportado: WebView2 120.** Cubre `<dialog>`, `:has()`, container queries, popover (116), `toSorted` (110) e `Intl`.
- **No usar** invoker commands (`command`/`commandfor`, 135) ni `closedby` (134) sin una alternativa.
- Agregar la versión de WebView2 a "Preparar para el cliente" (aviso si es menor al mínimo) y documentarla en CONTEXTO.md al implementar.

---

## 8. Prueba de punta a punta (vale para la fase 3 y la 5)

| Opción | Cómo | Pros | Contras |
|---|---|---|---|
| **→ WebdriverIO + tauri-driver** | Prueba la app real (Rust + WebView2) con `msedgedriver` | Camino oficial de Tauri. Prueba la base cifrada, los comandos y los permisos de verdad. | `msedgedriver` debe coincidir con la versión de WebView2; se fija en el script. |
| Playwright por CDP | WebView2 con `--remote-debugging-port` | API cómoda | La depuración remota se activa por una variable de entorno del sistema: en la PC del negocio sería un riesgo si se queda puesta. |

**→ tauri-driver**, con una compilación de prueba que acepta dos variables solo en debug:
- `POS_DATOS_PRUEBA`: carpeta de datos temporal, porque hoy `CARPETA_DATOS` es fija;
- `POS_RELOJ_PRUEBA`: reloj fijo, ya existe.

Flujo: crear apartado → abonar → liquidar → cerrar caja → el abono y la venta aparecen en el Z → el reporte del día coincide.

---

## 9. Decisiones que necesito de usted

1. ¿Permiso nuevo `reportes.ventas` solo del dueño (recomendado), o quitarle `reportes` al técnico y darle otro para la bitácora?
2. ¿Guardar el costo en cada venta desde la fase 3 (recomendado)?
3. ¿SQL en vivo con control contra el Z (recomendado) o solo el JSON congelado?
4. ¿Mínimo WebView2 120? ¿Puede leer la versión en la PC de Chaguí?
5. ¿Gráficos solo de día y hora, o ninguno?
