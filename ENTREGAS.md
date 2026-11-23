# Entregas

Cada instalador entregado, con su SHA-256. Antes de instalar, compare (PowerShell, en la carpeta del instalador):

```powershell
Get-FileHash ".\Punto de Venta_0.9.2_x64-setup.exe" -Algorithm SHA256
```

Ningún instalador repite número de versión: con el SHA-256 de una versión anotado aquí, `build.rs` no deja
compilar otro instalador con ese número (hay que subir la versión).

Si el hash no coincide, **no lo instale**: avise al técnico. Los instaladores no están firmados; Windows
SmartScreen avisa «Windows protegió su PC» → **Más información → Ejecutar de todas formas**. No desactive el
antivirus.

## 0.9.2 — crédito completo, huecos de cuentas y proformas (2026-11-23)

| | |
|---|---|
| Archivo | `Punto de Venta_0.9.2_x64-setup.exe` (NSIS, por usuario, 4,56 MiB) |
| SHA-256 | `680c9607da74e5f58a3e641b7961b37533ba3fbdfe241f357df1f04b9083e27e` |
| Commit | `e9d3bc8` (rama `entrega-0.9.1`; el código es el de `02514a3`, los commits siguientes solo tocan `.impeccable/hook.cache.json`) |
| Migraciones | 1 a 24 |
| Respaldo | `POSBAK02` (fixture `tests/fixtures/respaldo-v0.9.2-m24.posbak`) |
| Pruebas | `cargo test --lib` 170 ok (1 ignorada: genera fixture) · `npm test` 217 ok · `tsc` sin errores · e2e 10 de 10 |

Cambios desde 0.9.1:
- Crédito completo (apagado en Chaguí): opciones del dueño con PIN, límite por cliente desde su ficha, estado de cuenta (térmica y PDF), «Crédito disponible» en el cobro, comprobante de crédito además del tiquete, fecha límite con días de trabajo.
- Huecos: prorrogar con PIN, ayuda en «Qué se aparta», mensaje claro al condonar con la caja cerrada, ajuste de crédito sin condonado negativo.
- Proformas (migración 24): F11 o botón «Proforma», P-0001 y versiones, vigencia, pasar a venta o apartado (una sola vez), reimpresión COPIA y PDF, anular (dueño), reporte, nombre escrito que se borra solo.

## 0.9.1 — cierre de apartados y reportes, claridad de abonos (2026-11-20)

| | |
|---|---|
| Archivo | `Punto de Venta_0.9.1_x64-setup.exe` (NSIS, por usuario, 4,50 MiB) |
| SHA-256 | `29278595dea7b629d108f80d24080fd1e4bb2a1588dcbdf56ae71f88945b843b` |
| Commit | `d065a53` (rama `entrega-0.9.1`) |
| Migraciones | 1 a 23 |
| Respaldo | `POSBAK02` (fixture `tests/fixtures/respaldo-v0.9.1-m23.posbak`) |
| Pruebas | `cargo test --lib` 161 ok (1 ignorada: genera fixture) · `npm test` 209 ok · `tsc` sin errores · e2e 10 de 10 |

Cambios desde 0.9.0:
- Apartados y crédito (fase 3) y reportes de ventas (fase 5), con detalle «qué se aparta» (migración 22).
- Z: «Vendido» y «Dinero recibido» arriba; historial «Vendido · Recibido» por día; apartados abiertos en el resumen; ayuda «¿Qué es un abono?».
- Prueba de que liquidar un apartado no cuenta el dinero dos veces.
- Reportes rediseñados (menú agrupado, comparación con el año pasado, inventario y lista de precios); cierres de caja más claros.
- Avisos encima de los diálogos, que se pueden tocar y cerrar con teclado.
- CODE128 en el comprobante de apartado, apagado hasta probarlo en la impresora (migración 23).
- «Preparar para el cliente» con puntos obligatorios (condiciones, WebView2, horario real).
- Correcciones: Enter en Apartar, foco al escribir el total del conteo, rendimiento del desglose del Z.

## 0.9.0 — versión de prueba en el negocio (2026-11-09)

| | |
|---|---|
| Archivo | `Punto de Venta_0.9.0_x64-setup.exe` (NSIS, por usuario, 4,28 MiB) |
| SHA-256 | `d504141d8b79547ac0af811c1ad184a12e837de172cefac02f92236d7ca99981` |
| Migraciones | 1 a 12 |
| Respaldo | `POSBAK02` (fixture `tests/fixtures/respaldo-v0.9.0-m12.posbak`) |
| Pruebas | `cargo test --lib` 114 ok (1 ignorada: genera fixture) · `npm test` 167 ok · `tsc` sin errores |

Cambios principales desde 0.1.0:
- Datos en `%APPDATA%\PuntoDeVenta-Datos` (el desinstalador no los borra); traslado automático desde la carpeta vieja.
- Inventario (existencias, entradas, ajustes, kardex, mínimos, reportes).
- Respaldo automático diario y al cerrar turno, verificado, con rotación y recordatorio de USB.
- «Restaurar desde respaldo» cuando la base no abre; nunca crea una base vacía encima de una instalación.
- Migraciones que no se rompen por saltos de línea (CRLF/LF).
- Una sola instancia, reloj revisado al cobrar y cerrar, impresora trabada no bloquea la caja.
- Número inicial de tiquete configurable antes de la primera venta.
- Registro local de errores y «Exportar diagnóstico»; «Preparar para el cliente».
- El técnico ya no consulta ventas (datos de clientes, Ley 8968).
- PDF y tiquetes rediseñados; pantallas adaptadas a pantallas pequeñas.
