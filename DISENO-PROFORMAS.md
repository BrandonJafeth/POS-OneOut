# Diseño: proformas (cotizaciones)

_Borrador para aprobar antes de programar. 2026-11-23._

**Para qué:** dar al cliente un precio por escrito sin registrar una venta (lista escolar, arreglo para un evento).
**Regla de oro:** una proforma no mueve dinero, no abre la gaveta, no toca el inventario (ni lo reserva) y no entra
al Z ni a las ventas de los reportes. Vender sigue siendo igual: nada de esto agrega pasos a una venta normal.

## 1. Flujos

**Crear (cajero o dueño), desde la pantalla de venta.** Se arma igual que una venta: productos, cantidades, precio
libre (F4), descuentos por línea y al total con los mismos topes por rol y PIN del dueño. Se guarda con:
- Botón **«Proforma»** en la fila de acciones del tiquete (junto a Descuento y Apartar), no compite con Cobrar.
- Atajo **F11** (libre; F5 recarga la ventana en desarrollo y F6 queda para departamentos).

Al guardar: pide **Cliente** solo si no hay (opcional: «Sin nombre», cliente guardado o un nombre para imprimir),
imprime la proforma y la pestaña de esa venta se cierra (como al apartar). Aviso con «Reimprimir».

**Buscar y reimprimir (cajero o dueño):** pantalla **Proformas** (menú lateral). Busca por número (P-0012 o 12),
nombre del cliente guardado o producto. Filtros: vigentes, vencidas, convertidas, anuladas. Reimprimir sale **COPIA**
(Rust lo cuenta, como el Z).

**Convertir en venta o en apartado (cajero o dueño):** desde Proformas → «Pasar a venta». Abre una pestaña nueva de
venta con las líneas, el cliente y el descuento; desde ahí se **cobra (F12)** o se **aparta (F9)** como siempre.
La proforma pasa a **convertida** en la MISMA transacción del cobro o del apartado (no al abrir la pestaña): si la
pestaña se descarta, la proforma sigue vigente.

**Editar una vigente:** «Editar» abre la venta con sus líneas; al guardar crea la **versión 2** con el mismo número y
sufijo (**P-0012-2**). La versión anterior queda **reemplazada** (se ve y se reimprime, no se convierte). Recomiendo
esto, como pediste, porque el cliente puede tener en la mano la primera versión y tiene que verse cuál vale.

**Anular (solo dueño):** con motivo (sin PIN: no mueve dinero ni cambia algo ya prometido como un apartado).

## 2. Estados

`vigente` → `convertida` (a venta o apartado) · `anulada` · `reemplazada` (hay una versión nueva).
**Vencida** no se guarda: es vigente con `vence < hoy` (reloj de `util`). Así no hace falta un proceso que la cambie.

## 3. Tablas (migración 24)

```
proformas
  id, sucursal_id, caja_id, consecutivo INTEGER, version INTEGER (1, 2…), numero TEXT ("P-0012" / "P-0012-2")
  cliente_id NULL            -- cliente guardado (con consentimiento); el nombre libre NO se guarda
  usuario_id, fecha (ISO real), vence (AAAA-MM-DD)
  subtotal, descuento, redondeo, total, descuento_autorizado_por NULL
  condiciones TEXT           -- copia de proforma_condiciones al emitir (lo que se le prometió)
  estado CHECK (vigente | convertida | anulada | reemplazada)
  venta_id NULL, cuenta_id NULL, convertida_en NULL
  anulada_en, anulada_por, anulada_motivo, reimpresiones, creado_en, actualizado_en
  UNIQUE (caja_id, consecutivo, version)

proforma_lineas  -- mismas columnas que cuenta_lineas (producto, código, descripción, departamento,
                 -- cantidad, precio, descuento, descuento de catálogo, IVA)

ventas.proforma_id NULL  + índice ÚNICO parcial (WHERE proforma_id IS NOT NULL)
cuentas.proforma_id NULL + índice ÚNICO parcial
cajas.proforma_siguiente INTEGER NOT NULL DEFAULT 1
```
Los índices únicos hacen imposible convertir dos veces aunque fallara todo lo demás.

## 4. Numeración

**P-0001** consecutivo propio por caja (`cajas.proforma_siguiente`), aparte del de tiquetes: nunca choca ni salta
(se toma y se suma en la misma transacción que guarda, como el consecutivo de cuentas). Una versión nueva usa el mismo
consecutivo con `version + 1`.

## 5. Vigencia y configuración

| Clave | Por defecto | Quién |
|---|---|---|
| `proforma_vigencia_dias` | 8 | dueño |
| `proforma_vigencia_tipo` | `laborables` | dueño (misma regla que apartado y crédito: nunca vence en día no laborable) |
| `proforma_precio_al_convertir` | `proforma` | dueño (`proforma` o `actual`) |
| `proforma_condiciones` | vacío | dueño (hasta 300 letras) |

Se editan en la pantalla Proformas → Opciones (dueño). Sin `usa_*`: la proforma está siempre disponible (no cambia
nada para quien no la use).

## 6. Precios al convertir — recomendación

| Proforma | Precio de cada línea |
|---|---|
| Vigente y `proforma_precio_al_convertir = proforma` (**recomendado**) | El de la proforma: se respeta lo prometido por escrito. |
| Vigente y `= actual` | El de hoy; si cambió, aviso por línea («Cuaderno: ¢1.500 → ¢1.700»). |
| Vencida | Siempre el de hoy, con aviso por línea y un aviso arriba («Vencida el 20/11: precios de hoy»). El cajero lo confirma antes de abrir la venta. |

- **Producto inactivo o eliminado:** esa línea no se carga; se lista en el aviso para que el cajero decida.
- **Precio libre** (sin producto): se carga igual.
- **Descuento:** con precios de la proforma vigente, el descuento autorizado con PIN en la proforma vale (Rust lo
  acepta por `proforma_id`). Con precios de hoy, el tope se revisa de nuevo (puede pedir PIN).
- **Existencia:** como cualquier venta (aviso antes de cobrar si no alcanza). La proforma nunca reservó.

## 7. Impresión

Térmica (impresora de tiquetes) y PDF carta. Logo, datos del negocio, **PROFORMA P-0012-2**, fecha y hora real,
**Válida hasta el …**, cliente (o el nombre escrito), detalle con descuentos, total, `proforma_condiciones` y la
leyenda fija: **«Proforma. No es una factura ni un comprobante de pago. Precios sujetos a existencia.»**
Sin CODE128 (no hace falta escanearla: se busca por número).

## 8. Permisos

| Permiso | Cajero | Dueño | Técnico |
|---|---|---|---|
| `proformas`: crear, buscar, imprimir, editar (nueva versión), convertir | ✔ | ✔ | — |
| `proformas.admin`: anular, opciones, reporte | — | ✔ | — |

## 9. Reporte del dueño

Reportes → Ventas → **Proformas**, por rango de fecha de **emisión** (no hay turno): emitidas, convertidas, vencidas
sin convertir, anuladas, monto de cada grupo y % convertido; tabla por proforma (número, fecha, cliente, total,
estado, venta/apartado). No suma a ventas ni al Z.

## 10. Ley 8968

Cliente guardado: el mismo de la venta (con consentimiento). Nombre libre: se imprime y **no se guarda** (la
reimpresión sale «Cliente: no registrado»). La bitácora guarda número, total y estado; nunca nombres.

## 11. Respaldo

Migración 24 nueva (no edita las anteriores), fixture `respaldo-v0.9.2-m24.posbak` y la prueba que restaura todos
los anteriores.

## 12. Pruebas

1. Crear una proforma no cambia el Z, el inventario, las ventas ni los reportes de ventas.
2. Consecutivo P sin saltos ni choques con el de tiquetes; versión 2 con el mismo número.
3. Convertir respeta la regla de precios (vigente/proforma, vigente/actual, vencida) y avisa por línea.
4. No se convierte dos veces: dos cobros de la misma proforma (incluido doble clic) → uno solo; índice único.
5. Una vencida no se convierte sin el aviso confirmado; una anulada o reemplazada no se convierte.
6. Permisos (cajero, dueño, técnico) en la tabla de SEGURIDAD.md.
7. Restaurar respaldos viejos con la migración 24.
8. e2e: proforma → imprimir → convertir en venta → cobrar.

## Decisiones que necesito de ti

1. **Atajo F11** y botón «Proforma» en la fila de Descuento/Apartar. (¿Otro?)
2. **Al guardar, la pestaña se cierra** (como al apartar). Alternativa: dejarla abierta por si el cliente compra ya.
3. **Precio al convertir una vigente: el de la proforma** por defecto (configurable).
4. **Nombre libre no se guarda** (reimpresión sin nombre). Alternativa: guardarlo, pero entonces entra en Ley 8968.
5. **No hace falta la caja abierta** para crear ni imprimir una proforma (no mueve dinero). Para convertir, sí (es una venta).
6. **Anular sin PIN** (solo motivo, solo dueño).
