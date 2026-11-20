# Diseño fase 3: apartados y crédito

_Aprobado el 2026-11-19 con las recomendaciones marcadas (→) e implementado el mismo día. Política de cancelación de Chaguí: «devolver» por defecto hasta que el dueño la cambie en Apartados → Opciones._

Cada punto con varias opciones trae la recomendación marcada con **→**. Las preguntas que necesitan respuesta del dueño o del contador están al final (sección 16).

---

## 0. Lo que ya existe (punto de partida)

**Esquema** (migración 0001, sin uso todavía):
- `cuentas`: tipo (`apartado` | `credito`), cliente (obligatorio), caja, usuario, fecha, `fecha_entrega`, `total`, `saldo`, estado (`abierta` | `pagada` | `entregada` | `cancelada`) y `notas`.
- `cuenta_lineas`: producto, descripción, cantidad, precio unitario y total.
  - **No guarda** departamento, código, descuento, IVA ni exento. Sin eso, el Z no puede repartir por departamento.
- `abonos`: cuenta, caja, `turno_id`, fecha, usuario, forma de pago, banco, monto (> 0) y referencia.
  - **No guarda** recibido, vuelto, últimos 4, pagador ni anulación.
- `ventas.cuenta_id` (columna vacía).
- Config `usa_apartados = true`, `usa_credito = false`, `abono_minimo_pct = 50`.

**Ya usado:**
- `clientes.rs` lee `cuentas` para el expediente y bloquea anonimizar con saldo > 0.
- `bd_leer` rechaza `cuentas` y `abonos`.
- La nube las tiene prohibidas.
- `impresion.ts` ya tiene la línea del aviso de privacidad para el tiquete del apartado.

**Restricciones que salen del código actual:**
- `inventario_movimientos.tipo` tiene un CHECK con 5 valores (`venta`, `anulacion`, `entrada`, `ajuste`, `inicial`). Agregar un tipo obliga a reconstruir la tabla del kardex: `DROP TABLE` marcado `PERMITIDO`, triggers nuevos, sobre datos reales.
- `caja_ajustes.venta_id` es `NOT NULL` y su `tipo` solo admite `pago` | `anulacion`. No sirve para abonos sin reconstruirla.
- El Z se congela al cerrar (`caja_turnos.totales`, JSON) y `revisar_cuadre` exige:
  - formas de pago = total de ventas;
  - departamentos = detalle = total;
  - efectivo esperado = fondo + recibido − vueltos + entradas − salidas.
- El precio y el descuento de catálogo se validan contra el producto al cobrar (`"el precio cambió, vuelva a agregarlo"`).
- El técnico tiene el permiso `reportes` (para la bitácora). Ver fase 5.

---

## 1. Configuración por negocio

Claves nuevas en `config`, validadas en `config.rs` (`validar`). Ninguna necesita migración.

| Clave | Tipo | Chaguí | Por defecto | Notas |
|---|---|---|---|---|
| `usa_apartados` | bool | sí | sí | Ya existe. |
| `usa_credito` | bool | **no** | no | Ya existe. |
| `abono_minimo_pct` | entero 0–100 | 50 | 50 | Ya existe. Aplica solo al **primer** abono. |
| `apartado_plazo_dias` | entero 1–365 | 30 | 30 | |
| `apartado_plazo_tipo` | `calendario` \| `laborables` | calendario | calendario | Ver §8. |
| `apartado_cancelacion` | `devolver` \| `retener` \| `saldo_favor` | (preguntar) | `devolver` | Ver §7. |
| `apartado_retencion_pct` | entero 0–100 | (preguntar) | 0 | Solo con `retener`. |
| `apartado_condiciones` | texto ≤ 300 | (preguntar) | "" | Se imprime en el comprobante. |
| `credito_limite_defecto` | entero ≥ 0 | — | 0 | 0 = sin crédito hasta que el dueño ponga un límite al cliente. |
| `credito_plazo_dias` | entero 1–365 | — | 30 | Solo para marcar "vencido". |

Rust las expone por un solo comando tipado `cuentas_reglas` (mínimo, plazo, tipo de plazo, política). TS no copia ningún número a mano (§13).

---

## 2. Cuándo se reconoce la venta (decisión central)

### Apartado

| Opción | Qué pasa | Z y reportes | Consecutivo | Inventario | Factura pendiente |
|---|---|---|---|---|---|
| A. Al crear el apartado | Venta completa hoy. Los abonos van pagando una cuenta por cobrar. | La venta sale hoy aunque falte el dinero. "Formas = total" no cuadra sin una forma ficticia "por cobrar". | Gasta un número de tiquete aunque el apartado se cancele: la cancelación queda como anulación. | Sale del inventario hoy, aunque el producto sigue en la tienda (bolsa con nombre). El conteo físico no cuadra. | Se lista hoy. Si se cancela, la factura ya hecha necesita nota de crédito. |
| **→ B. Al liquidar (último abono), y se entrega en ese momento** | El apartado es un compromiso con anticipos. Al pagarse todo se crea **una venta normal** con las líneas y precios del apartado. | Cada abono entra como **dinero** al turno donde se recibe, en su sección "Abonos". La venta entra a "Ventas" el día que se liquida. Ningún colón se cuenta dos veces. | Solo las ventas reales gastan número de tiquete. El apartado tiene su propia serie (`A-0001`). | Reserva al apartar y kardex `venta` al liquidar (§5). Cancelar no deja rastro falso. | Se lista al liquidar, con el cliente del apartado. |
| C. Al entregar (puede ser días después de pagar) | Como B, pero la venta nace al entregar. | Como B. Un apartado pagado y no entregado no es venta. | Como B. | Como B. | Se lista al entregar. |

**→ Recomiendo B.** La definición de Chaguí ("se los lleva cuando paga todo") hace que liquidar y entregar sean el mismo momento.
- Se mantiene el estado `pagada` (sin entregar) para el caso raro de un pago completo por SINPE con retiro otro día. En ese caso la venta nace al pagar y la entrega solo cambia el estado.
- **Hay que confirmarlo con el contador:** si los anticipos necesitan comprobante propio en Hacienda (§16). El POS no factura, pero el momento en que la venta aparece en "Pendientes de factura" depende de esto.

### Crédito (fiado)

El producto sale hoy. **→ La venta se reconoce al crearla** (no hay otra opción razonable):
- Lleva `cuenta_id`.
- Sus pagos son la prima, si la hay, por la forma real. El resto queda "a crédito".
- Los abonos posteriores entran como dinero, igual que en el apartado.

### Cómo se registra una venta pagada con abonos (sin forma de pago ficticia)

| Opción | Cómo funciona | Riesgo |
|---|---|---|
| X. Forma de pago de sistema "Apartado" / "Crédito" en `formas_pago` | La venta trae un pago con esa forma. | Aparece en cada lista, configuración y `bd_leer` de formas. Hay que filtrarla en todos lados. |
| **→ Y. Sin forma ficticia** | La venta de liquidación no lleva `venta_pagos` por lo ya abonado: solo `ventas.cuenta_id`. Lo pagado con abonos = total − pagos de la venta. El Z muestra "Ventas de apartados liquidados ¢X (pagadas con abonos)" y "Ventas a crédito, por cobrar ¢Y". `revisar_cuadre` pasa a: formas + aplicado de cuentas = total de ventas. | Un cambio en `revisar_cuadre` y en el Z. Nada más. |

Para que el dinero de este turno siga cuadrando, el **último abono** (el que liquida) se registra como abono, no como pago de la venta.

---

## 3. Flujos del cajero (dentro de la pantalla de venta)

Atajos nuevos, sin chocar con los actuales (F1–F4, F6–F8, F12):

| Tecla | Qué hace |
|---|---|
| **F9** | Apartar la venta actual |
| **F10** | Buscar un apartado o crédito y abonar |

Se agregan a `ATAJOS` (el diálogo de F1). En la pantalla solo se muestran si la bandera del negocio está activa.

### 3.1 Crear un apartado (la venta en espera se convierte en apartado)

1. El cajero arma la venta como siempre (escanear, cantidades, descuentos con el tope de su rol).
2. **F9 "Apartar".**
   - Sin cliente con consentimiento → abre el mismo diálogo de cliente (F7), con "Nuevo cliente" que ya pide el consentimiento. Al elegir, sigue solo.
3. Diálogo "Apartar":
   - total, abono mínimo, fecha límite y condiciones;
   - campo **"Abona hoy"**, lleno con el mínimo y seleccionado;
   - debajo, el mismo bloque de formas de pago del cobro (F1–F4, Enter, vuelto, referencia de SINPE).
   - **Se reutiliza `Cobro.tsx`** con `total = abono` y el título "Abono del apartado".
4. **Enter** (mínimo en efectivo exacto) → se guarda y se imprime el comprobante.
   - La espera desaparece de las pestañas, igual que al cobrar.
   - La gaveta abre si el abono fue en efectivo.

Mínimo de pulsaciones: **F9 → Enter → Enter**. El cliente lleva tres pasos más si no estaba elegido.

Rust valida en una transacción:
- turno abierto que este usuario puede usar;
- `usa_apartados`;
- cliente con consentimiento;
- precios y descuento de catálogo contra la base (la misma regla de `cobrar_con`);
- tope de descuento;
- abono ≥ mínimo y ≤ total;
- pagos con `calculo::pagos`;
- unidades disponibles (§5).

Se graba en la misma transacción:
- `cuentas`, `cuenta_lineas` (con departamento, IVA y descuentos);
- el abono;
- el evento `creada`;
- la bitácora.

### 3.2 Buscar un apartado

- **F10** → diálogo "Apartados" con un buscador por nombre, teléfono, cédula o número (`A-12` o `12`).
- Lista: número, cliente, saldo, vence (en rojo si venció) y estado.
- Flechas ↑/↓ y Enter (el mismo manejador de teclado de la venta).
- **El lector** también sirve: el comprobante imprime el número en código de barras (Code128 `A-0012`). Leído en el buscador de la venta, abre el apartado directamente.

### 3.3 Recibir un abono

1. Desde el apartado elegido: campo **"Abona"**, lleno con el saldo y seleccionado.
2. Se escribe otro monto o se deja el saldo.
3. Se usa el mismo bloque de cobro.

| Caso | Qué pasa |
|---|---|
| Abono < saldo | Comprobante de abono con el saldo restante. |
| Abono = saldo | Liquida (§3.4). |
| Efectivo > saldo | El excedente es vuelto. Se usa el `recibido`/`vuelto` de `calculo::pagos` con total = saldo. |
| Tarjeta, SINPE o transferencia > saldo | Rechazado, con el mismo mensaje del cobro. |

### 3.4 Liquidar y entregar

Cuando el abono deja el saldo en 0, en la misma transacción:
- se crea la venta (`ventas.cuenta_id`, consecutivo normal, líneas del apartado con sus precios), sin pagos por lo ya abonado;
- la reserva pasa a kardex `venta`;
- la cuenta queda `entregada` (`fecha_entrega` = ahora).

Se imprime el **tiquete final** (tiquete normal + "Liquida apartado A-12 · Abonado antes ¢10.000 · Este pago ¢10.000").

La casilla **"Se lleva los productos"** viene marcada. Desmarcada:
- la cuenta queda `pagada`;
- después, "Entregar" desde F10 solo cambia el estado e imprime un comprobante de entrega.

### 3.5 Crédito (solo si `usa_credito`)

- **Crear:** dentro del diálogo de cobro aparece **"A crédito"**, solo si hay cliente con consentimiento y el negocio lo usa.
  - Lo que no se pague hoy queda por cobrar.
  - Rust revisa el límite y responde solo "alcanza" o "no alcanza (pida al dueño)". **Nunca** le dice el límite ni el saldo total al cajero (§10).
- **Abonar:** igual que el apartado (F10, se busca por cliente). La cuenta pasa a `pagada` al llegar a 0.
  - En crédito no hay entrega: el producto ya se llevó.

---

## 4. Flujos del dueño

Nueva pantalla **"Apartados"** en el menú (dueño), con pestañas Abiertos · Vencidos · Pagados sin entregar · Cerrados · Crédito (si está activo):
- Tabla con número, cliente, creado, vence, total, abonado, saldo, días de atraso y estado.
- Ordenable y con filtro.
- Un aviso discreto en el menú cuenta los vencidos, igual que el aviso de inventario.

| Acción | Quién | Exige |
|---|---|---|
| Cancelar un apartado | dueño | PIN, motivo (≥ 5 caracteres), turno abierto si hay devolución en efectivo |
| Ajustar el saldo (corregir un error) | dueño | PIN, motivo. Sube o baja el saldo con evento `ajuste`. |
| Condonar el saldo (perdonarlo) | dueño | PIN, motivo. Saldo a 0 con evento `condonacion`; el apartado se liquida con el descuento. |
| Anular un abono | dueño | PIN, motivo (§12) |
| Límite de crédito por cliente | dueño | PIN. Se guarda en `clientes.limite_credito`; la bitácora no guarda el monto. |
| Prorrogar la fecha límite | dueño | Motivo (sin PIN: no mueve dinero) |

---

## 5. Inventario

| Opción | Al apartar | Al liquidar | Al cancelar | Kardex | Riesgo |
|---|---|---|---|---|---|
| Descontar | Movimiento `apartado` (−) | Nada | Movimiento `apartado_cancelado` (+) | Dos tipos nuevos | Reconstruir `inventario_movimientos` sobre datos reales. El conteo físico no cuadra si cuentan lo que está en bolsas. |
| **→ Reservar** | Nada en el kardex. Las unidades quedan **reservadas**. | Kardex `venta` normal (la venta del apartado), con la hora real | La reserva desaparece. No hay movimiento. | Sin cambios de esquema | Ninguno de migración. |

**→ Reservar**, sin tabla nueva:
- Reservado = suma de `cuenta_lineas.cantidad` de los apartados `abierta` o `pagada` (sin entregar), por producto.
- Disponible para vender = existencia − reservado.
- El kardex del producto muestra las reservas como líneas informativas que no suman a la existencia ("Apartado A-12: 1 reservada · 19-nov 15:04", "Liberada: cancelado"). Se leen de las cuentas, con la hora real.

**Que un apartado no se venda dos veces.** Si una venta deja el disponible por debajo de 0 en un producto con control, Rust responde `RESERVADO:` con el apartado y el cliente:
- "La última unidad está apartada (A-12)."
- Vender igual pide el PIN del dueño **siempre**, aunque `permitir_vender_sin_existencia` esté encendido. Lo apartado ya está prometido.

Es el único diálogo nuevo dentro de la venta, y solo aparece en ese choque.

**Servicios y precio libre:** no reservan nada, igual que hoy.

**Crédito:** la venta sale normal y baja la existencia al crearse.

---

## 6. Caja y Z

### Abonos en la caja
- Cada abono va al **turno abierto donde se recibe**, por su forma de pago, y toma la `fecha_negocio` de ese turno.
  - Incluye la caja tardía que cuenta para el próximo día laborable.
  - Guarda también su fecha y hora real (`abonos.fecha` con `util::ahora()`).
- Sin turno abierto, Rust rechaza el abono con el mismo error de la venta (`turno_para_vender`). Así funciona igual en turno compartido y en turno por cajero.

### Efectivo esperado
`fondo + efectivo neto de ventas + efectivo neto de abonos + entradas − salidas`

- Efectivo neto = recibido − vuelto.
- Las devoluciones en efectivo de apartados entran como **salida** (categoría "Devolución apartado"), igual que la devolución por anulación.
- La diferencia de apertura no cambia.

### Secciones nuevas del Z (separadas de las ventas)
- **Abonos recibidos** por forma de pago (cantidad y monto), y el detalle de los electrónicos (referencia, banco, pagador), igual que `pagos_electronicos`.
- **Apartados:** creados (cantidad, total comprometido), liquidados (pasan a ventas), cancelados (devuelto, retenido, a saldo a favor), abonos anulados.
- **Ventas pagadas con abonos** y **ventas a crédito por cobrar**, como líneas que explican la diferencia entre "ventas" y "dinero".
- El reparto por departamento sigue repartiendo **ventas** (la venta del apartado entra el día que se liquida). Los abonos no se reparten: son dinero, no venta.

### Lo que no cambia
- El cajero no ve totales con el turno abierto, tampoco de abonos. `sin_totales` vacía también las secciones nuevas.
- El cajero sí ve el saldo **de la cuenta que atiende**: es un dato operativo, no un total.
- Los Z viejos se leen igual: los campos nuevos tienen `#[serde(default)]`.

### Pruebas
Se amplían las invariantes: cada abono aparece en exactamente un Z y el Z sigue cuadrando. Se rompe a propósito el cálculo de abonos para confirmar que la prueba lo detecta, y se revierte.

---

## 7. Cancelación de un apartado

Con PIN del dueño, motivo y bitácora (`cuenta.cancelar`). La política está en `apartado_cancelacion`:

| Política | Qué pasa con lo abonado | En la caja |
|---|---|---|
| `devolver` | Se devuelve todo. | Efectivo: salida en el turno actual (pide turno abierto). SINPE, tarjeta o transferencia: se marca "devuelto fuera de caja" con referencia; el efectivo no cambia. |
| `retener` | Se retiene `apartado_retencion_pct` de lo abonado y se devuelve el resto. | Lo retenido queda como **ingreso por apartado cancelado** en el Z y en los reportes, sin ser venta. Lo devuelto en efectivo sale como salida. |
| `saldo_favor` | Todo queda a favor del cliente para otra compra. | Sin movimiento de caja. Necesita un libro de saldo a favor por cliente y una forma de usarlo en la venta (§16: alcance). |

**→ Recomiendo implementar `devolver` y `retener` en la fase 3**, y dejar `saldo_favor` diseñado pero apagado hasta que algún negocio lo pida. Es una mini-funcionalidad aparte: libro, uso al cobrar, reportes y Ley 8968.

El dueño puede cambiar el monto devuelto en el momento (entre 0 y lo abonado), con el motivo. La reserva se libera en la misma transacción.

---

## 8. Vencimiento

- **Fecha límite** = fecha de negocio del turno donde se creó + `apartado_plazo_dias`.
  - Se usa la fecha de negocio para que la caja tardía del sábado no regale ni quite días.
  - Si cae en un día no laborable (`caja_horario`), pasa al próximo laborable con `siguiente_laborable`, que ya existe.
- `calendario` (**→ recomendado**: "30 días" es lo que entiende el cliente y lo que se imprime) o `laborables` (cuenta solo días de trabajo).
- **Vencido** = la fecha real de hoy (`util::ahora()`) es posterior a la fecha límite. Es la fecha impresa que el cliente conoce.
- **Sin acción automática.** El dueño ve el aviso y decide: prorrogar, llamar o cancelar.
- Las pruebas fijan el reloj (`util::fijar_reloj`): sábado tardío, fin de mes y domingo.

---

## 9. Precios

- Las líneas del apartado guardan precio, descuento de catálogo, descuento del cajero, IVA, exento, departamento y código al crearse.
- Al liquidar, la venta usa **esas** líneas. No pasa por la validación "el precio cambió".
- Si el producto subió o bajó, se respeta lo apartado.
- Prueba: cambiar el precio después de apartar → la venta sale con el precio del apartado.

---

## 10. Tiquetes

Todos con la fecha y hora real, en `lib/impresion` (ESC/POS en TS, lista blanca en Rust). Reimprimir sale con `*** COPIA ***` y suma a `reimpresiones`.

| Documento | Contenido |
|---|---|
| Comprobante de apartado | Número `A-0012` (texto + Code128), cliente (solo nombre), productos, total, abonado, saldo, fecha límite, condiciones (`apartado_condiciones`), línea del aviso de privacidad (ya existe), atendió |
| Comprobante de abono | Número del apartado, monto, forma de pago, recibido y vuelto, **saldo restante**, fecha límite |
| Tiquete final | Tiquete de venta normal + "Liquida apartado A-0012", lo abonado antes y este pago |
| Cancelación | Número, devuelto, retenido, motivo corto, autorizado por |

---

## 11. Clientes y Ley 8968

- El apartado y el crédito **exigen** un cliente con consentimiento vigente. Rust lo revisa con la misma regla que `cliente_crear`.
- No se guarda nada nuevo del cliente salvo `clientes.limite_credito` (solo si el negocio usa crédito).
- El límite de crédito y el historial de pagos revelan la situación económica del cliente:
  - solo el dueño los ve (`cliente_obtener`, que ya es del dueño);
  - el cajero recibe solo "alcanza / no alcanza";
  - la bitácora guarda ids y acciones (`credito.limite`, `cuenta.abono`), nunca el límite ni la lista de pagos como texto.
- **Anonimizar con saldo pendiente se bloquea.** La regla ya existe (`clientes.rs`, estado `abierta` y saldo > 0). Se amplía a `pagada` sin entregar: hay productos del cliente en la tienda.
- Anonimizar borra las notas de las cuentas (ya lo hace) y el nombre en los comprobantes reimpresos.
- La exportación del cliente (ya existe) agrega sus abonos con fecha y monto.

---

## 12. Permisos (validados en Rust)

Dos permisos nuevos en `permisos.rs` y en su copia `src/lib/permisos.ts`: `cuentas` (operar) y `cuentas.admin`.

| Acción (comando) | Cajero | Dueño | Técnico |
|---|:---:|:---:|:---:|
| `cuentas_reglas` | ✔ | ✔ | — |
| `cuenta_crear` (apartado o crédito) | ✔ | ✔ | — |
| `cuenta_buscar` (abiertas y pagadas, sin totales generales) | ✔ | ✔ | — |
| `cuenta_obtener` (una, con su saldo) | ✔ | ✔ | — |
| `cuenta_abonar` / liquidar | ✔ | ✔ | — |
| `cuenta_entregar` | ✔ | ✔ | — |
| `cuenta_imprimir` (original o COPIA) | ✔ | ✔ | — |
| `cuenta_listar` (pantalla del dueño, saldos, vencidos) | — | ✔ | — |
| `cuenta_cancelar` (PIN) | — | ✔ | — |
| `cuenta_ajustar` / `cuenta_condonar` (PIN) | — | ✔ | — |
| `abono_anular` (PIN) | — | ✔ | — |
| `cuenta_prorrogar` | — | ✔ | — |
| `cliente_limite_credito` (PIN) | — | ✔ | — |
| `credito_alcanza` (sí/no) | ✔ | ✔ | — |

- El técnico no entra: hay datos de clientes.
- Cada fila entra en `tabla_permisos.rs`, en la prueba `cada_comando_con_cada_rol_respeta_la_tabla` y en SEGURIDAD.md.

### Anular un abono
- **Turno del abono abierto:** se marca anulado y el efectivo esperado baja, igual que una venta anulada. Si ese efectivo ya salió, se rechaza con `SIN_EFECTIVO`.
- **Turno cerrado:** el abono se marca anulado y el evento queda en el turno actual. Si se devuelve efectivo, sale como salida. El Z viejo no cambia (está congelado).
- No se anula un abono de una cuenta ya liquidada. Primero se anula la venta de liquidación (con la regla actual), y eso devuelve la cuenta a `abierta`.

---

## 13. Validación en dos capas y tipos generados

- **Rust decide:** mínimo, plazo, saldo, límite, estados, permisos, existencia y fechas, en una transacción `BEGIN IMMEDIATE`. Cada comando rechaza lo inválido aunque lo llamen sin la pantalla.
- **TS ayuda:** avisa mientras se escribe, deshabilita acciones imposibles y traduce el error de Rust. Lee los límites de `cuentas_reglas`.
- Lo que TS ya duplica hoy (`calcularPagos` ↔ `calculo::pagos`) se reutiliza tal cual para los abonos. No se escribe otra versión.

### Generación de tipos

| | tauri-specta | **→ ts-rs** |
|---|---|---|
| Qué genera | Tipos y funciones `invoke` de cada comando | Tipos de cada struct (`#[derive(TS)]`) |
| Cambios al proyecto | Reemplaza `generate_handler!` y anota los ~150 comandos. Versión 2 todavía en RC. | Un `derive` en los structs nuevos. Los comandos quedan como están. |
| Respeta `serde(rename_all = "camelCase")` | sí | sí |
| Riesgo | Cambiar el registro de comandos de toda la app por una dependencia RC, justo antes de la 1.0 | Bajo. Los nombres de comando siguen escritos a mano, en un solo lugar por comando (`src/db/cuentas.ts`). |

**→ ts-rs.** Los `.ts` se generan en `src/tipos/generados/` al correr `cargo test`. Una prueba falla si están desactualizados.

### Pruebas espejo
- Un archivo de casos compartido: `tests/casos/cuentas.json` (mínimo, abono mayor que el saldo, mixto, plazo con sábado y domingo, límite de crédito).
- Lo leen `cargo test` y `vitest`. Los mismos casos en los dos lados, sin copiarlos.

---

## 14. Migraciones, respaldo y fixtures

**Migración `0021_apartados.sql`.** Solo `ALTER TABLE ADD COLUMN`, tablas nuevas, índices y triggers. Nada se borra.

- `cuenta_lineas` + `codigo`, `departamento_id`, `descuento`, `descuento_catalogo`, `tasa_iva`, `exento`, `iva`.
- `cuentas` + `numero`, `consecutivo`, `turno_id`, `fecha_limite`, `subtotal`, `descuento`, `venta_id` (la de liquidación), `cancelada_en`, `cancelada_por`, `cancelada_motivo`, `devuelto`, `retenido`, `reimpresiones`, `requiere_factura`.
  - Índice único `(caja_id, consecutivo)` y `(estado, fecha_limite)`.
- `abonos` + `recibido`, `vuelto`, `ultimos4`, `pagador`, `operacion_id` (UNIQUE: idempotencia), `anulado_en`, `anulado_por`, `anulado_motivo`, `anulado_turno_id`, `reimpresiones`.
  - Índice `abonos(turno_id)`.
- `cajas` + `cuenta_siguiente INTEGER NOT NULL DEFAULT 1`.
- `clientes` + `limite_credito INTEGER`.
- Tabla nueva `cuenta_eventos`, solo para agregar (triggers sin UPDATE ni DELETE, igual que el kardex):
  - columnas: `id`, `cuenta_id`, `tipo` (`creada`, `abono`, `abono_anulado`, `liquidada`, `entregada`, `cancelada`, `ajuste`, `condonacion`, `prorroga`), `monto`, `turno_id`, `usuario_id`, `autorizado_por`, `motivo`, `fecha`;
  - de aquí salen las secciones del Z y el historial de la cuenta.
- Trigger: `cuentas.saldo` nunca negativo. El saldo lo calcula Rust en la misma transacción, y una invariante comprueba saldo = total − abonos vigentes − condonado ± ajustes.

**Pruebas de la migración:**
- Se aplica sobre una copia de la base con datos de la versión actual (fixture m20 nuevo, generado antes de la migración).
- Fixture nuevo `respaldo-v0.10.0-m21.posbak` con apartados en todos los estados.
- La prueba de restaurar todos los fixtures anteriores sigue y se amplía.

---

## 15. Casos borde

| Caso | Comportamiento |
|---|---|
| Abono mayor que el saldo | Efectivo: el excedente es vuelto. Otras formas: rechazado. |
| Abono con pago mixto | Igual que el cobro mixto (`calculo::pagos`). Cada forma va a su línea del Z. |
| Abono en un turno y liquidación en otro | Cada abono vive en su turno. La venta, en el turno donde se liquida. Cada uno en un solo Z. |
| Abono en una caja tardía (cuenta para el próximo laborable) | El abono toma el día del turno. Fecha real en el comprobante. Prueba con el sábado tardío que cuenta para el lunes. |
| Abono anulado | §12. |
| Producto inactivo o eliminado dentro de un apartado | Se entrega igual (las líneas guardan todo lo necesario). Kardex solo si el producto existe y controla inventario. Aviso al dueño en la lista. |
| Corte de luz a mitad de un abono | Una transacción: o quedó todo (abono, saldo, evento, bitácora) o nada. La impresión se hace después del commit, con reimpresión si falla. Mismo patrón que `corte_de_luz_a_mitad_de_un_cobro`. |
| Doble clic al cobrar un abono | La pantalla genera `operacion_id` (ulid) al abrir el diálogo. Rust hace `INSERT` con `UNIQUE`. El segundo intento devuelve el resultado del primero, sin otro abono. |
| Doble clic al crear el apartado | Se usa la espera, como en el cobro: el `JOIN` con la espera activa impide crear dos. |
| Precio cambia en la espera antes de apartar | La misma regla del cobro: "vuelva a agregarlo". |
| Cliente anonimizado con apartado vacío (saldo 0, entregado) | Permitido. Las cuentas quedan sin notas. |
| Turno reabierto por el dueño con abonos | Igual que las ventas: el Z se vuelve a calcular al cerrar otra vez. |
| Respaldo restaurado de una versión anterior (sin columnas nuevas) | La migración lo pone al día. Las cuentas viejas (no hay) no necesitan relleno. |

---

## 16. Decisiones que necesito de usted

1. **Momento de la venta:** ¿apruebo B (al liquidar) para apartados y "al crear" para crédito?
2. **Inventario:** ¿reservar (recomendado) o descontar?
3. **Cancelación en Chaguí:** ¿devolver todo, retener un % (¿cuánto?) o saldo a favor? ¿Implemento `saldo_favor` en esta fase o lo dejo diseñado?
4. **Plazo de Chaguí:** ¿30 días calendario? ¿Qué condiciones van impresas?
5. **Contador:** ¿los anticipos de un apartado necesitan comprobante propio en Hacienda, o basta la factura al liquidar? (Cambia cuándo sale en "Pendientes de factura".)
6. **Diálogos:** el `Modal` propio usa `role="dialog"` hecho a mano. La guía pide `<dialog>` nativo con `showModal()`. Opciones:
   - (a) cambiar `ui/Modal.tsx` por dentro (todos los diálogos lo heredan, con pruebas manuales de todos);
   - (b) solo los diálogos nuevos con `<dialog>` y convivir con dos sistemas.

   **→ (a)**, al principio de la fase, porque los diálogos nuevos se abren encima de los viejos (la venta). Toca toda la app.
7. **Atajos F9 y F10:** ¿le sirven al cliente o prefiere otros?
