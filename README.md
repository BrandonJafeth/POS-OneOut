# Punto de Venta

App de escritorio (Tauri v2 + React + TypeScript + SQLite) para Librería y Bazar Chagui, pensada para reutilizarse en otros negocios: lo que cambia entre negocios es **configuración**, no código.

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| 0. Prototipo de hardware | Lector, POS-58, code pages, gaveta; elegir Tauri (quedó en **Configuración → Hardware**) | ✅ Hecho |
| 1. Base | Base de datos, roles, datos del negocio, catálogo, importación CSV, códigos internos, etiquetas | ✅ Hecho |
| 2. Venta y caja | Venta, cobro mixto, espera, tiquete, caja, cierre Z, gaveta, impresoras, turno compartido, pendientes de factura, seguridad | 🟡 Casi completa |
| 3. Apartados y créditos | Apartados con abonos (Chaguí) y crédito (otros negocios), según banderas por negocio | ⏳ Siguiente |
| 4. Inventario | Existencias, entradas de mercadería, ajustes con motivo, mínimos y alertas, venta sin stock configurable | ⏳ |
| 5. Reportes | Ventas por día, departamento, producto y usuario; stock bajo; inventario valorizado; exportar PDF/CSV | ⏳ |
| 6. Entrega | Pruebas manuales en la PC real, instalador, respaldo configurado, capacitación, instalación final | ⏳ |

Fuera de este alcance (módulos aparte): factura electrónica de Hacienda, sincronización con la nube o varias cajas en red, crédito (fiado) para Chaguí.

## Comandos

```bash
npm install
npm run tauri dev     # app completa
npm test              # pruebas TypeScript (vitest + node:sqlite, mismas migraciones)
cd src-tauri && cargo test   # pruebas Rust (Argon2, migración en sqlx, sql_lote)
```

## Datos

- Archivo: `%APPDATA%\cr.puntodeventa.pos\pos.db` (WAL; respaldar con la app cerrada junto con `-wal`/`-shm`). Nunca dentro del instalador.
- Migraciones: `src/db/migraciones/NNNN_*.sql`, registradas en `src-tauri/src/db.rs`. Agregar una nueva = archivo nuevo + versión siguiente; nunca editar una ya instalada.
- Todo el SQL vive en `src/db`. Las escrituras van por el comando Rust `sql_lote` (transacción real); ver comentario en `src-tauri/src/db.rs`.
- Primer arranque: pide el PIN del técnico. Entrada del técnico en la pantalla de login: **Ctrl+Alt+T**.

## Datos personales (Ley 8968)

- Clientes: solo nombre y teléfono obligatorios; no se guardan sin marcar el consentimiento (con fecha y versión del aviso).
- Cajero: solo nombre y teléfono. Dueño: lista, datos, corrección, exportar (PDF/CSV) y anonimizar (con PIN y motivo). Técnico: sin acceso a clientes ni al respaldo.
- No hay borrado lógico de clientes: se anonimizan (el id queda para el historial). Bloqueado si tienen saldo pendiente.
- La bitácora guarda ids, acciones y nombres de campos, nunca datos personales.
- Respaldo: solo cifrado (AES-256-GCM, clave Argon2id, contraseña ≥ 8), en Documentos\Respaldos POS.
- Nube: no existe sincronización; `src/db/sincronizacion.ts` fija la lista blanca (sin clientes, apartados, usuarios ni bitácora).

## Venta (fase 2)

- Atajos: F2 nueva venta en espera · F3 buscar · F4 precio libre · F6 por departamento · F7 cliente · F8 descuento al total · F12 cobrar · Supr quitar línea · Ctrl+1…9 pestañas · `3*código` = 3 unidades.
- Ventas en espera: se guardan en SQLite en cada cambio (tabla `ventas_espera`).
- Consecutivo: `prefijo de la caja + número`, tomado dentro de la transacción del cobro (`BEGIN IMMEDIATE`): sin saltos ni repetidos.
- Total redondeado al múltiplo de `redondeo_total` (₡5 por defecto, al más cercano). Descuento por rol: `descuento_max_pct`; si se pasa, PIN de dueño.
- Pago dividido: el tiquete (y la COPIA, y el detalle en pantalla) trae una línea por pago con forma, banco (abreviatura, p. ej. BCR), referencia y monto; si hubo efectivo, el recibido y el vuelto.
- Anular o cambiar la forma de pago de una venta cobrada: solo el dueño, con su PIN y motivo. El cajero puede quitar líneas antes de cobrar; desde `caja_quitar_linea_bitacora` colones queda en la bitácora.
- El POS no emite facturas electrónicas: "Pendientes de factura" lista las que se deben hacer en el sistema externo.

## Caja (turno, cierre Z, gaveta)

- El turno es de la caja: con `caja_turno_compartido` (por defecto sí), cualquier cajero o dueño vende en el turno abierto; cada venta, pago, movimiento, corte y apertura de gaveta guarda quién la hizo. **Cambiar usuario** (menú lateral) cierra la sesión sin cerrar el turno y la pantalla se arma de cero según el rol del que entra.
- Con el turno abierto, el cajero no recibe ningún total de ventas (Rust no se los manda: ni en Caja, ni en Mis turnos, ni en Ventas del día, ni por `bd_leer`). Su conteo de cierre es ciego y por billetes y monedas; al confirmarlo queda bloqueado (trigger) y recién ahí ve el Z completo. Solo el dueño reabre (PIN y motivo).
- Cierre Z (`src/lib/caja/reporteZ.ts`): formas de pago, efectivo (esperado = fondo + contado + entradas − salidas − vueltos), descuentos, anulaciones, aperturas sin venta, cortes, ventas por usuario, por departamento, detalle de tarjeta/SINPE/transferencia, movimientos, conteo y firmas. Casillas al cerrar: detalle completo y un tiquete por departamento (valores por defecto en Administración → Caja y cierre). El reparto por departamento es exacto (`src-tauri/src/desglose.rs`); si algo no cuadra, no se imprime. PDF carta con logo para el dueño. Reimprimir = COPIA con PIN del dueño.
- Corte (dueño): acumulado sin cerrar y, si quiere, retiro con PIN. Queda en la bitácora y en el Z.
- Gaveta: solo con una venta en efectivo (una vez), una "No venta" con motivo o una orden del dueño con PIN. Ningún trabajo de impresión puede abrirla (lista blanca ESC/POS en `src-tauri/src/escpos.rs`).

## Impresoras

- Administración → Impresoras (dueño y técnico): varias impresoras (Windows, puerto serial o USB directo, elegidas de lo que detecta el sistema), 58/80 mm y columnas, code page, cortador y gaveta (una sola). Cada documento (tiquete, cierre y reportes, movimientos, etiquetas) va solo a la impresora asignada; "Imprimir prueba" por impresora.
- Si una impresora no responde, se avisa en palabras simples y la venta queda guardada para reimprimir.
- La migración 8 pasó la impresora única de `config` a la tabla `impresoras` con los cuatro documentos asignados.

## Interfaz

- Componentes en `src/ui/`: `Button` (icono lucide + texto + atajo, ≥ 44 px), `Card`, `Badge`, `Alert`, `Modal` (foco atrapado, Esc), `EmptyState`, `Field` (etiqueta visible), `Confirmar`, `FilaClic` (filas con teclado).
- Departamentos en la venta: píldoras de 44 px con el color de cada departamento (`src/ui/departamentos.ts`, paleta de 12; texto blanco o negro según el contraste). Se cambian en Administración → Departamentos.
- Colores: `src/ui/tema.ts` (claro y oscuro). `tests/tema.test.ts` verifica contraste WCAG 2.1 AA de cada combinación: si se cambia un color y no cumple, la prueba falla.
- Tema por equipo: clave `tema` en config (botón en el menú lateral).

## Estructura

```
src/db/          capa de datos (único lugar con SQL)
src/lib/         lógica pura: ulid, csv, importar/, logo1bit, impresion, permisos, bloqueo, useEscaner
                 + escpos.ts, tickets.ts, preview.ts del prototipo (sin cambios de comportamiento)
src/screens/     pantallas; hardware/ = prototipo
src/tipos.ts     tipos compartidos
tests/           pruebas vitest
src-tauri/src/   lib.rs (comandos), bd.rs (migraciones + lote), pin.rs (Argon2id), printer.rs (spooler, serial, USB),
                 impresoras.rs, escpos.rs (lista blanca), gaveta.rs, caja.rs, desglose.rs (reparto del Z), ventas.rs
```

---

# Prototipo de hardware (referencia)

## Requisitos (máquina de desarrollo)

- Node.js 20 o más reciente
- Rust (toolchain `stable-x86_64-pc-windows-msvc`)
- Visual Studio (o Build Tools) con el workload **"Desarrollo para el escritorio con C++"** (MSVC + Windows SDK)
- WebView2 Runtime (ya viene con Windows 10/11 actualizados)

La PC del cliente **no** necesita nada de esto: basta con el instalador.

## Cómo correr

```bash
npm install
npm run tauri dev
```

La primera compilación de Rust tarda varios minutos; después es rápida.

`npm run dev` (solo navegador) también abre la UI en http://localhost:1420, pero ahí no se puede imprimir: la pantalla 2 muestra un aviso.

## Cómo generar el instalador

```bash
npm run tauri build
```

La primera vez, Tauri descarga NSIS y WiX (en la carpeta de usuario, no globales). Tarda unos 3 minutos. Los instaladores quedan en:

- `src-tauri/target/release/bundle/nsis/Prueba Hardware POS_0.1.0_x64-setup.exe` (≈ 1,4 MB) ← el más simple para llevar a la PC del cliente
- `src-tauri/target/release/bundle/msi/Prueba Hardware POS_0.1.0_x64_en-US.msi` (≈ 2 MB)
- El ejecutable suelto está en `src-tauri/target/release/pos.exe`

Windows SmartScreen puede avisar "Windows protegió su PC" porque el instalador no está firmado: **Más información → Ejecutar de todas formas**.

## Estructura

```
src/
  App.tsx                 pestañas
  components/Ajustes.tsx  ajustes del tiquete (code page, formato de barras, modo chino, cortador)
  screens/Lector.tsx      Pantalla 1: lector de código de barras
  screens/Impresora.tsx   Pantalla 2: impresora real
  screens/SinHardware.tsx Pantalla 3: vista previa, hex y .bin
  lib/escpos.ts           constructor ESC/POS (ESC @, FS ., ESC t, ESC a, ESC E, GS !, GS k, GS V, ESC p)
  lib/codepages.ts        tablas propias CP437, CP850, WPC1252, CP858
  lib/tickets.ts          documentos de prueba (tiquete, code pages, ₡, gaveta)
  lib/preview.ts          intérprete de bytes → vista previa + volcado hexadecimal
  lib/ean13.ts            validación EAN-13 / ISBN-13 y barras para la vista previa
  lib/printerApi.ts       llamadas a Rust
  lib/copiar.ts           copiar historial/registro al portapapeles
herramientas/
  simular-lector.ahk      simulador del lector con AutoHotkey v2
src-tauri/src/
  lib.rs                  los 2 comandos: list_printers, print_raw
  printer.rs              implementación con la API del spooler de Windows
```

## Cómo se imprime

`print_raw` abre la impresora por su **nombre de Windows** y le manda los bytes con el tipo de dato **RAW** (OpenPrinterW → StartDocPrinterW → StartPagePrinter → WritePrinter → EndPagePrinter → EndDocPrinter → ClosePrinter). Con RAW el driver no toca los bytes, así que los comandos ESC/POS llegan tal cual.

"OK" en el registro significa que **el spooler de Windows aceptó el trabajo**, no que ya salió en papel. Si algo no sale, abra la cola de impresión ("Configuración → Impresoras → POS-58-Series → Abrir cola").

Pruebas de Rust sin hardware: `cd src-tauri && cargo test -- --nocapture` (lista las impresoras de la PC y comprueba el mensaje de error de una impresora inexistente).

## Simular el lector sin hardware (AutoHotkey v2)

Abra `herramientas/simular-lector.ahk` con doble clic (requiere AutoHotkey v2), ponga la app en la pestaña 1 y use **Ctrl+Alt+1…8** (ver la cabecera del script). **Ctrl+Alt+Esc** cierra el script. No reemplaza la prueba con el lector real.

## Antes de ir donde el cliente

- [ ] Generar el instalador (`npm run tauri build`) y copiar el `-setup.exe` a una llave USB.
- [ ] Llevar: esta tabla impresa, un libro con ISBN, un producto con código EAN, un rollo de papel de 58 mm de repuesto y el celular para cronometrar.
- [ ] Si la PC del cliente no tiene internet: verificar antes que tenga WebView2 ("Microsoft Edge WebView2 Runtime" en Aplicaciones instaladas). El instalador lo descarga si falta, y para eso necesita internet.

### Orden sugerido en la PC del cliente

1. Instalar y abrir **Prueba de hardware POS**.
2. Pestaña 2: confirmar que aparece la POS-58 → **Texto simple** → **Imprimir tiquete de prueba**.
3. **Probar todos los code pages** → elegir en "Code page" el que imprimió bien las tildes → volver a imprimir el tiquete.
4. Escanear con el lector (pestaña 1) **el código de barras impreso en el tiquete** y luego libros y productos.
5. **Imprimir 10 tiquetes seguidos** (con cronómetro), gaveta si hay.
6. **Copiar registro** y **Copiar historial** → pegar en un correo o en Excel para tener la evidencia.

En el registro, cada impresión guarda los ajustes que usó (code page, formato de barras, FS .), así se sabe qué combinación funcionó.

## Problemas comunes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Las tildes salen como caracteres chinos o pares raros | La impresora está en modo chino | Dejar marcado **Apagar modo chino (FS .)** |
| Las tildes salen como otros símbolos (`ß`, `Ó`, …) | Code page equivocado | **Probar todos los code pages** y elegir el que salga bien |
| Sale todo menos el código de barras | La impresora no entiende el formato B de `GS k` | Cambiar **Código de barras** a **Formato A** |
| "OK" pero no sale nada | La impresora está apagada o sin papel, o el trabajo quedó en la cola de Windows | Abrir la cola de impresión; borrar trabajos trabados y reintentar |
| Error en StartDocPrinter / no sale nada con un driver moderno | Algunos drivers nuevos (v4/XPS) no aceptan RAW | En Windows, agregar otra impresora con el driver **Generic / Text Only** en el **mismo puerto** (USB001) y probar con esa |
| Salen letras de más o basura al inicio | La impresora no es ESC/POS o el driver convierte el texto | Revisar que el puerto sea el correcto y que el tipo de dato sea RAW (o usar Generic / Text Only) |
| El lector escribe al revés mayúsculas/minúsculas | Bloq Mayús activado (la app lo avisa) | Desactivar Bloq Mayús |
| El lector termina con Tab (la app lo avisa) | Configuración del lector | Configurar el sufijo Enter (CR) escaneando el código de configuración del manual del lector |
| Símbolos cambiados (`-` → `'`, `/` → `&`) | El lector está en distribución EE. UU. y Windows en Latinoamérica, o al revés | Configurar el idioma del lector desde su manual, o usar solo códigos numéricos |

## Tabla de pruebas (llenar a mano en la PC del cliente)

Fecha: ____________  PC / Windows: ____________  Lector (marca/modelo): ____________  Impresora: ____________

### Lector de código de barras (Pantalla 1)

| # | Prueba | Resultado esperado | Resultado real | Notas |
|---|--------|--------------------|----------------|-------|
| L1 | Escanear un libro (ISBN) | Aparece el código y se registra solo, sin tocar Enter | | |
| L2 | Tipo detectado | "ESCANEO" (promedio entre teclas < 40 ms) | | Promedio medido: ___ ms |
| L3 | Termina con Enter | Columna "Fin" = `Enter` (si dice `Tab`, la app lo avisa) | | |
| L4 | No pierde caracteres | Largo = 13 en EAN-13/ISBN; el mismo código 10 veces seguidas sale idéntico | | |
| L5 | Dígito verificador | "EAN-13 válido · ISBN-13" en libros | | |
| L6 | Símbolos correctos | Escanear un código con letras/guiones (p. ej. Code 128): no hay caracteres resaltados en amarillo que no estén en la etiqueta | | Si `-` sale como `'` o `?`, la distribución del teclado no coincide con la del lector |
| L7 | Teclado vs. lector | Teclear a mano un código da "TECLEO" | | |
| L8 | Foco | Tras hacer clic en otro lado, el indicador vuelve a "Escuchando lector" en < 1 s | | |
| L9 | Escaneo seguido | 10 escaneos rápidos: aparecen 10 entradas en el historial | | |
| L10 | Código impreso | Escanear el código de barras del tiquete de P7: `9789968000000`, EAN-13 válido | | |

### Impresora (Pantalla 2)

| # | Prueba | Resultado esperado | Resultado real | Notas |
|---|--------|--------------------|----------------|-------|
| P1 | Aparece en la lista | "POS-58-Series" seleccionada por defecto | | |
| P2 | Texto simple | Sale "Hola desde Tauri" + fecha/hora | | |
| P3 | Tiquete de prueba | Encabezado grande en negrita, columnas alineadas (32), totales a la derecha | | |
| P4 | Tildes y ñ | "Lápiz", "años", "pequ…", "¡Gracias…!" correctos con el code page elegido | | Code page que funcionó: ___ · FS . sí ☐ no ☐ |
| P5 | Todos los code pages | Por cada ESC t n se lee "áéíóú ñ Ñ ¿ ¡ ü" | | Correctos: 0 ☐ 2 ☐ 16 ☐ 19 ☐ |
| P6 | Símbolo ₡ | "₡1.500" sale "?" (no existe en ningún code page); "CRC 1.500" y "¢1.500" salen bien | | En el POS: montos sin símbolo, como el tiquete de AMPM |
| P7 | Código de barras | Se imprime un EAN-13 (9789968000000) con los números debajo | | Formato que funcionó: B ☐ A ☐ |
| P8 | Corte | Con cortador marcado: corta. Sin cortador: no imprime basura | | |
| P9 | Gaveta | Abre la gaveta (solo si hay una conectada) | | |
| P10 | 10 seguidos | Salen las copias 1 a 10, sin saltos ni tiquetes cortados | | |
| P11 | Velocidad | Tiempo desde clic hasta el último tiquete en papel (cronómetro) | | ___ s total / ___ s por tiquete |
| P12 | Tiempo de spooler | Columna "Tiempo" del registro (aceptación por Windows) | | ___ ms |
| P13 | Impresora apagada | Imprimir con la impresora apagada: ver qué pasa (error o queda en cola) | | |

### Sin hardware (Pantalla 3)

| # | Prueba | Resultado esperado | Resultado real | Notas |
|---|--------|--------------------|----------------|-------|
| S1 | Vista previa | Se parece al papel real de P3 | | |
| S2 | Guardar .bin | Queda el archivo en la carpeta Descargas | | |

## Decisión: ¿seguimos con Tauri o pasamos a Electron?

**Seguimos con Tauri si:**

- El lector se detecta como ESCANEO y no pierde ni cambia caracteres (L1–L9).
- La impresora imprime por su nombre de Windows con RAW (P1–P3) y las tildes salen bien con al menos un code page (P4/P5).
- 10 tiquetes seguidos salen completos y a una velocidad aceptable para la caja (P10–P11).
- El instalador se instala y corre en el Windows 10 del cliente sin pasos raros (WebView2 presente o instalado por el instalador).

**Consideramos Electron si:**

- WebView2 da problemas en la PC del cliente (no se instala, políticas de la empresa, Windows desactualizado).
- La impresión RAW por el spooler falla **incluso con el driver Generic / Text Only** y la única salida es una librería de Node (p. ej. `node-thermal-printer`, `@thiagoelg/node-printer`) que en Tauri obligaría a meter más Rust.
- Mantener el Rust (aunque sean 2 comandos) resulta una carga real para el mantenimiento.

**Otros criterios a anotar:** tamaño del instalador (Tauri ≈ 3–10 MB vs. Electron ≈ 80–150 MB), memoria usada en la PC del cliente (Administrador de tareas), tiempo de arranque.

Si el lector y la impresora pasan las pruebas, el hardware **no** es motivo para cambiar a Electron: lo que se probó aquí (teclado + spooler RAW) funciona igual en ambos.
