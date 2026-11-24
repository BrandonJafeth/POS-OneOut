# Seguridad del Punto de Venta

Este documento explica cómo se protege la aplicación. También dice qué cosas no cubre y qué debe hacer cada negocio.
Aplica a la versión 0.9.3 (versión de prueba en el negocio), con las migraciones 1 a 25.

## 1. Modelo de amenazas

| Quién | Qué podría intentar | Cómo se frena |
|---|---|---|
| Cajero curioso o deshonesto | Darse más descuento o quitar ventas. Sacar efectivo sin rastro. Ver datos de clientes. Cambiar una forma de pago después del cierre. Ver lo vendido en el turno ("ya vamos bien") y dejar de registrar ventas. Abrir la gaveta sin motivo. Corregir el conteo después de ver el faltante. | Rust valida todo con el usuario de la sesión. El tope de descuento y las salidas grandes piden el PIN del dueño en ese momento. Anular y cambiar la forma de pago son solo del dueño. Con el turno abierto, ningún comando le devuelve totales de ventas al cajero. La gaveta solo abre por venta en efectivo, "no venta" con motivo u orden del dueño, y todo queda registrado. El conteo cerrado no se edita (trigger). Los pagos de un turno cerrado no se pueden modificar (trigger). Todo queda en una bitácora encadenada. |
| Alguien con acceso a la pantalla (por ejemplo, DevTools en una compilación de desarrollo) | Llamar comandos con otro rol o mandar SQL propio. | El usuario siempre sale de la sesión guardada en Rust. Las escrituras solo pasan por operaciones con nombre (`sentencias.json`), cada una con su permiso. La lectura acepta un solo `SELECT`, en modo solo lectura y sin tablas sensibles. |
| Ladrón de la computadora o del disco | Leer clientes y ventas copiando `pos.db`. | La base va cifrada con SQLCipher. La clave de 256 bits se guarda protegida con DPAPI y solo sirve para el usuario de Windows de esa máquina. |
| Alguien que encuentra una memoria USB con el respaldo | Abrir el respaldo o alterarlo. | Va cifrado con AES-256-GCM y la clave sale de la contraseña con Argon2id. GCM detecta cualquier byte alterado, y la restauración además revisa la integridad. |
| Quien edita el archivo de la base con otra herramienta | Borrar o cambiar registros de la bitácora. | Los triggers impiden `UPDATE`/`DELETE`, y cada fila lleva el hash de la anterior. La verificación (al cerrar caja y en Técnico → Sistema) señala la fila rota. |
| Adivinar PINs | Probar PINs en la entrada o en una autorización. | Argon2id. Bloqueo progresivo: 4 intentos libres, después 30 s que se duplican hasta 15 min, guardado en la base. La autorización del dueño usa la misma escalera, contando los fallos de las últimas 24 h. Todo fallo queda en la bitácora. |
| Contenido malicioso (un nombre de producto importado, etc.) | Ejecutar scripts o navegar fuera de la app. | CSP estricta (sin `unsafe-eval` ni scripts inline). No se permite navegar fuera de la app ni abrir ventanas nuevas. React escapa todo el texto. |
| Dependencias comprometidas | Código malicioso en una librería. | Lockfiles fijados, `npm audit`, `cargo audit` y `cargo deny` (licencias, fuentes y avisos). |

## 2. Controles implementados

### Aplicación de escritorio (Tauri)
- **Capacidades mínimas**: solo `core:event:default` y `core:app:default` (`src-tauri/capabilities/default.json`). No hay shell, sistema de archivos, diálogos, HTTP ni updater.
- **CSP** (`tauri.conf.json`): `default-src 'self'`, `script-src 'self'` (sin `unsafe-eval` y sin scripts inline), `object-src`/`frame-src`/`form-action`/`base-uri` en `'none'`.
  - `connect-src` permite solo `ipc:` y `http://ipc.localhost`. Son los canales internos de Tauri para hablar con Rust; sin ellos los comandos no funcionan. **No hay ningún otro destino de red.**
  - La CSP de desarrollo (`devCsp`) solo agrega lo que necesita Vite.
- **Navegación**: la ventana se crea en Rust con `on_navigation` y solo acepta `tauri://`, `http://tauri.localhost` y `blob:` (las descargas de la app). `on_new_window` lo niega todo. Además `main.tsx` anula `window.open`, los enlaces externos y soltar archivos sobre la ventana.
- **DevTools**: apagado en la compilación release (`devtools(cfg!(debug_assertions))`).
- **Sin `console.log`** con datos del negocio: verificado con búsqueda en `src/`.
- `freezePrototype: true`.

### Lógica de negocio en Rust
Todo lo que protege dinero o permisos se valida en el backend: `src-tauri/src/*.rs`.
- **Sesión**: vive en Rust (`sesion.rs`). Cada comando toma el usuario de ahí, nunca de un parámetro. Se **bloquea** por inactividad (sección «Bloqueo por inactividad»).
  - La pantalla también se bloquea sola al vencer el plazo.
- **Permisos**: configurables por rol y por cajero (sección «Permisos configurables»). Un solo lugar decide: `politica::efectiva`. La pantalla recibe la política efectiva del usuario (`sesion_permisos`) y solo muestra u oculta; ya no hay una copia de la tabla en TS.
  - El técnico no vende, no toca la caja y no ve clientes.
- **Dinero**: en colones enteros (`i64`) y en una sola transacción `BEGIN IMMEDIATE`. Rust vuelve a calcular totales, IVA, descuentos y vuelto (`calculo.rs`). El precio de un producto sale de la base, no de la pantalla.
  - **Autorización de descuento**: el PIN del dueño genera un token de un solo uso, válido para esa venta y ese porcentaje durante 30 minutos. Antes la pantalla mandaba el id del dueño y se le creía.
  - **Descuento fijo de producto** (`productos.descuento_pct`, lo pone el dueño): no cuenta contra el tope del rol. Rust lo lee de la base al cobrar; si la línea trae otro % (el dueño lo cambió con la venta en espera), rechaza: «vuelva a agregarlo». Lo que el cajero agregue encima sí cuenta contra su tope. Cada línea guarda aparte la parte del producto (`venta_lineas.descuento_catalogo`) y el Z la muestra separada de los «Descuentos dados» del cajero.
- **SQL parametrizado**: no se concatena SQL con datos. Hay dos lugares que arman SQL con texto, y en ambos el texto sale de constantes del código:
  - `negocio.rs` toma los nombres de columna de una lista fija.
  - `caja.rs`/`ventas.rs` solo concatenan cláusulas constantes.
- **La pantalla no puede pedir SQL arbitrario**:
  - `bd_lote` solo acepta ids de `src/db/sentencias.json`, cada uno con su permiso.
  - `bd_leer` acepta un solo `SELECT`/`WITH`, en un pool `read_only` con `query_only`, y solo sobre una **lista blanca**: `productos`, `codigos`, `departamentos`, `formas_pago`, `bancos`, `config`, `negocio` y `cajas` (`bd::LECTURA_PERMITIDA`). Cualquier otra tabla del esquema se rechaza, incluidas las que se agreguen en el futuro, sin tocar la lista: ventas, pagos, turnos, clientes, usuarios, bitácora, apartados e inventario. También se rechazan `PRAGMA`, `ATTACH`, `pragma_*()`, `sqlite_*`, `_sqlx_migrations`, las palabras de escritura y las columnas `pin_hash` y `nombre_tiquete`. Cada rechazo queda en la bitácora (`lectura.rechazada`).
  - Las lecturas sensibles (totales de ventas, turnos, clientes, usuarios, bitácora, inventario) solo salen por comandos tipados que revisan el rol en Rust.
- **Validación de entradas**: texto con largo máximo y sin caracteres de control (`util::texto`). Hay rangos para montos y cantidades, y el conteo de caja solo acepta las denominaciones configuradas.

### PIN y acceso
- Argon2id (`pin.rs`). El PIN mínimo es de 6 dígitos para dueño y técnico y de 4 para cajero, configurable. Se rechazan los PIN con el mismo dígito repetido.
- Hay que cambiar el PIN en la primera entrada si lo puso otra persona o si es más corto que el mínimo. Hasta hacerlo, Rust responde `DEBE_CAMBIAR_PIN` a todo.
- La entrada no revela si un usuario existe: "no existe", "inactivo" y "PIN incorrecto" dan la misma respuesta.
- Las acciones sensibles piden el PIN cada vez y no guardan la autorización. Son: reabrir caja, salida grande, anular, corregir un pago de un turno cerrado, anonimizar y restaurar. Darle una de estas acciones a un cajero no le quita el PIN del dueño (`usuarios::confirmar_dueno` revisa la acción y siempre pide el PIN).
- Lo que la política pide con «PIN» o «motivo» y el comando no recibe como argumento se autoriza con `seguridad_autorizar`: una autorización de **un solo uso** para esa acción, que vence a los 2 minutos y se gasta en el siguiente comando (aunque falle). Queda en la bitácora (`permiso.autorizado`) con la versión y quién autorizó.
- El técnico entra por una entrada oculta (Ctrl+Alt+T); no aparece en la lista.

### Datos en disco
- La base `pos.db`, su clave `pos.clave` y los respaldos quedan en `%APPDATA%\PuntoDeVenta-Datos` (constante `CARPETA_DATOS` en lib.rs). No depende del `identifier` ni del nombre del programa y el desinstalador no la conoce: aunque se marque «Borrar los datos de la aplicación», los datos se conservan. Las versiones anteriores la tenían en `%APPDATA%\cr.puntodeventa.pos`; al arrancar se traslada sola (`respaldo::trasladar_datos`).
- **SQLCipher**: se evaluó contra cifrar solo los respaldos y se eligió SQLCipher. La clave de 32 bytes es aleatoria y se guarda en `pos.clave`, protegida con DPAPI. No está en el código ni en el repositorio.
  - Una base vieja sin cifrar se convierte sola al primer arranque con `sqlcipher_export`. La copia en claro se borra cuando la cifrada ya existe.
- WAL activo y `quick_check` al arrancar y cada 6 horas. Un fallo queda en la bitácora.
- Antes de cada migración se copia la base a `respaldos-automaticos\`. Esa copia también va cifrada, porque es el archivo cifrado.
- **No se actualiza con la caja abierta**: si hay migraciones pendientes y un turno abierto, la app no abre y explica cómo volver a la versión anterior para cerrar la caja. Una base de una versión más nueva tampoco se abre (no se "desmigra").
- **Respaldos sin copias en claro**:
  - La base se exporta a una base en memoria y se serializa (`sqlite3_serialize`). Se cifra con AES-256-GCM y Argon2id, y recién entonces se escribe.
  - La restauración descifra, revisa la integridad y la versión, **aplica en memoria las migraciones que le falten** (cada una en su transacción), vuelve a correr `integrity_check` y verifica la cadena de la bitácora. Solo si todo pasa escribe `pos.db.nuevo` ya cifrado; si algo falla, la base actual no se toca y el mensaje lo dice. Ese archivo se activa al reiniciar y la base anterior queda guardada.
  - No se restaura con la caja abierta.
  - Cada intento fallido con el PIN del dueño ya dado (contraseña equivocada, archivo alterado, no se pudo poner al día) queda en la bitácora como `respaldo.restaurar_fallido`, con el motivo técnico. La pantalla solo muestra un mensaje claro.
  - **Formato versionado**: `POSBAK02` lleva en el encabezado la versión del programa y la última migración. El encabezado va en claro (para rechazar un respaldo de una versión más nueva antes de pedir nada) pero autenticado por GCM: cambiarlo hace fallar el descifrado. El lector sigue aceptando `POSBAK01` (sin encabezado). Un formato nuevo agrega un lector; no reemplaza los anteriores.
  - `tests/fixtures/` guarda un respaldo de prueba por versión (sin datos reales). La prueba que los restaura todos no se borra.
- Los archivos temporales y el registro no llevan datos personales ni PIN. No hay archivo de log de la app.

### Bitácora
- Solo se puede agregar. Hay triggers contra `UPDATE`/`DELETE` y contra insertar sin hash.
- Cadena SHA-256: cada fila guarda el hash de la anterior. Se escribe dentro de `BEGIN IMMEDIATE` para que la cadena no se bifurque.
- `verificar()` corre en cada cierre de caja. Si la cadena está rota, el reporte Z lo imprime y queda la entrada `bitacora.alterada`.
- No guarda datos personales: solo ids, acciones y nombres de campos.

### Venta: sin pérdidas ni gaveta sin rastro
- Si la tarjeta, SINPE o transferencia ya pagan todo, no se acepta efectivo además: volvería entero como vuelto y abriría la gaveta sin dinero real.
- Una venta de ¢0 (regalo, descuento total) se registra sin pagos. Si trae dinero «recibido», se rechaza: si no, el efectivo abriría la gaveta sin una venta real (`calculo::pagos` y `lib/venta/pagos.ts`).
- Las ventas en espera se guardan en la base en cada cambio y en orden (una cola en `useEsperas`): un guardado viejo no pisa a uno nuevo ni deja en la bitácora una «línea quitada» que no pasó.
- Si una pantalla falla al dibujarse, `ErrorPantalla` muestra un aviso con «Volver a intentar» en vez de dejar la ventana en blanco. Lo cobrado y lo que está en espera ya está en la base.
- En la versión final un `panic` de Rust cierra el programa (`panic = "abort"`). El código fuera de las pruebas no usa `unwrap` sobre datos de afuera, y cada índice o división se revisa antes. Un cierre a la mitad de un cobro no deja nada a medias: todo va en una transacción.

### Impresión y gaveta
- Cada envío a una impresora tiene un tiempo límite de 10 s (`impresoras::con_limite`). Se imprime dentro de la transacción: sin límite, una USB trabada (sin papel) dejaba la base tomada y ningún cobro se guardaba.
- Mientras una impresora siga trabada con un trabajo, el siguiente se rechaza al instante con un aviso claro (no se acumulan hilos esperando al driver).
- Si el pulso de la gaveta no contesta a tiempo, pudo llegar tarde y abrirla: la apertura se registra igual y se avisa. Si la impresora no recibió nada (apagada, sin gaveta), no queda registro.

### Clientes y facturas
- El consentimiento vale para el aviso de privacidad vigente: si el aviso cambió, Rust rechaza el registro con la versión vieja.
- El borrador de una entrada de mercadería (lleva costos) vive en la memoria de la ventana mientras esté abierta y se borra al guardar, al cerrar el programa o cuando entra un usuario sin permiso de inventario.
- El cajero no puede guardar notas del cliente (solo el dueño), aunque llame al comando directo.
- No se anonimiza un cliente con ventas pendientes de factura electrónica (Hacienda necesita sus datos): primero se hace la factura y se marca.
- Anonimizar también borra el nombre impreso en sus tiquetes (`ventas.nombre_tiquete`) y en las ventas en espera.
- Una venta anulada no se puede marcar como facturada. Si se anula una venta que ya tenía factura, la bitácora guarda la referencia de la factura (falta la nota de crédito en el sistema de facturación; la pantalla lo avisa).

### Inventario
- Un producto nuevo (a mano o importado) empieza sin control; su primer código de barras lo pone bajo control (migración 12). Así un servicio nuevo no queda bloqueado en la venta si se apaga «vender sin existencia».
- La existencia solo cambia agregando un movimiento al kardex (`inventario::mover`), dentro de la transacción de la venta, la anulación, la entrada, el ajuste o el conteo. Un trigger revisa que la existencia resultante sea la anterior más la cantidad y la copia a `existencias`: la existencia guardada siempre es la suma del kardex.
- El kardex no se edita ni se borra (triggers `inventario_movimientos_sin_update` y `_sin_delete`).
- El costo vive en `producto_costos`, fuera de `productos`, para que la lectura de catálogo nunca lo vea.
- Permiso `inventario` solo para el dueño. El técnico no tiene acceso. El cajero mueve inventario solo vendiendo y, si `venta_mostrar_existencia` está activo, ve cuántas unidades hay (`inventario_existencia`, sin costo).
- Ajustes, conteos y carga inicial piden el PIN del dueño en el momento. El ajuste exige un motivo de la lista configurable. Vender sin existencia con `permitir_vender_sin_existencia` apagado pide el PIN del dueño (`venta.sin_existencia` en la bitácora).
- Proveedores: solo nombre, teléfono y notas. La bitácora no guarda el teléfono ni las notas (si el proveedor es una persona, son datos personales). Al eliminar un proveedor se borran su teléfono y sus notas; el nombre queda porque las compras ya registradas lo necesitan como respaldo contable.
- Si `venta_mostrar_existencia` está apagado, el aviso de venta sin existencia le dice al cajero qué producto falta, pero no cuántas unidades hay.
- La carga por CSV no acepta decimales disfrazados: «2.5» es un error, no 25. Solo valen separadores de miles bien puestos («1.250»).

### Caja
- Hay un solo turno abierto por caja (índice único). Sin un turno abierto de hoy no se cobra.
- El turno es de la caja (`caja_turno_compartido`, por defecto sí). Cada venta, pago, movimiento, corte, apertura de gaveta y anulación guarda su usuario y su turno. Sin la opción, solo quien abrió vende y mueve efectivo en ese turno (el dueño puede cerrarlo).
- **Totales ocultos al cajero con el turno abierto** (`caja::ve_totales`): `caja_detalle` le manda solo fondo, movimientos y aperturas sin venta; `caja_turnos` le manda las ventas y el total en `null`; `venta_listar_dia`, `venta_obtener`, `venta_imprimir` y `venta_pendientes_factura` le dan los tiquetes de todos los cajeros, uno por uno y sin sumas (para atender un reclamo aunque no esté quien cobró; el riesgo aceptado es que sume a mano tiquete por tiquete); `caja_z` falla con el turno abierto; `caja_corte` es del dueño; y `bd_leer` no deja leer `ventas` ni `venta_lineas` a nadie. Una salida rechazada por falta de efectivo queda en la bitácora (`caja.salida_rechazada`), para que el mensaje no sirva para adivinar lo esperado sin dejar rastro.
- **Conteo ciego y bloqueado**: el cajero cuenta (total o billete por billete) sin ver lo esperado; al confirmar se cierra el turno y el trigger `caja_turnos_conteo_bloqueado` impide cambiar conteo, contado, esperado, diferencia o totales de un turno cerrado. Solo `reabrir` (dueño, PIN, motivo, mismo día, último turno) vuelve a abrirlo; el cierre anterior queda en la bitácora.
- **Cierre Z**: los totales congelados se revisan otra vez al leerlos (departamentos, detalle, formas de pago y efectivo deben cuadrar). Si no cuadran, Rust no imprime. La reimpresión exige el PIN del dueño y la marca "*** COPIA ***" en cada papel.
- **Anular y corregir pagos**: según la política `ventas.anular` / `ventas.cambiar_pago` (por defecto, solo el dueño con su PIN y motivo). La venta anulada no se borra. Anulación por el cajero: sección «Anulación por el cajero».
- Los pagos y los montos de una venta de un turno cerrado no se pueden cambiar (triggers). Una corrección posterior queda como `caja_ajustes` en el turno actual, la hace solo el dueño con PIN, y una devolución de efectivo entra como salida.

### Apartados y crédito
- Todo lo decide `cuentas.rs` en una transacción `BEGIN IMMEDIATE`: abono mínimo, plazo, saldo, límite de crédito, estados, existencia reservada y fechas (reloj de `util`). Un comando llamado directo rechaza lo inválido (la pantalla solo avisa).
- El apartado y el crédito exigen un cliente con consentimiento vigente. El cajero ve el saldo de la cuenta que atiende, nunca totales ni el límite de crédito: `credito_disponible` responde solo cuánto crédito le queda al cliente (límite − lo que debe, nunca negativo). El límite, el estado de cuenta y las opciones de crédito son solo del dueño; cambiar límites, opciones o una fecha límite (prorrogar) pide su PIN. El estado de cuenta se imprime por la impresora de tiquetes con el documento `estado_cuenta` (solo dueño).
- Cada abono va al turno abierto donde se recibe; sin turno, se rechaza. `abonos.operacion_id` evita que un doble clic o un reintento cree dos abonos. Un abono no se modifica ni se borra (triggers): se anula, con PIN del dueño y motivo.
- `cuenta_eventos` es solo-agregar (triggers) y el saldo nunca queda negativo (trigger). La prueba `el_z_cuadra_con_apartados_en_muchos_turnos` compara el efectivo esperado con un modelo independiente y comprueba que cada abono está en exactamente un Z; se verificó que detecta un error puesto a propósito en el cálculo de abonos.
- Lo apartado no se vende sin el PIN del dueño (aunque se permita vender sin existencia).
- Cancelar, ajustar, condonar, anular un abono y el límite de crédito: solo el dueño, con PIN y motivo. La bitácora guarda ids, montos de la operación y motivo; **no** guarda el límite de crédito ni la lista de pagos de un cliente.
- No se anonimiza un cliente con saldo pendiente ni con un apartado pagado sin entregar.

### Proformas (0.9.2)
- `proformas.rs` decide todo. Una proforma no mueve dinero, no abre la gaveta, no toca ni reserva inventario y no entra al Z ni a las ventas (prueba `una_proforma_no_toca_dinero_inventario_ni_z…`).
- Permisos: `proformas` (cajero y dueño: crear, buscar, imprimir, pasar a venta), `proformas.anular` y `proformas.admin` (solo dueño). El técnico no entra.
- Se convierte dentro de la transacción del cobro o del apartado, solo si la venta coincide con la proforma; índices únicos en `ventas.proforma_id` y `cuentas.proforma_id`: nunca dos veces, ni con doble clic ni reabriéndola. El precio de la proforma solo se acepta si está vigente y la opción lo permite; si no, el del catálogo.
- Ley 8968: el nombre escrito (sin cliente guardado) queda solo en la proforma y se borra solo a los N días (`proforma_retencion_nombre_dias`); no va a la bitácora ni a los reportes. Un cliente guardado necesita su consentimiento.

### Reportes de ventas
- Permiso nuevo `reportes.ventas`, solo del dueño. El técnico conserva `reportes` para la bitácora, pero no ve ventas (llevan nombres de clientes). El cajero nunca.
- Los reportes leen solo turnos cerrados; los abiertos van aparte. Cada turno se compara con su Z congelado y la pantalla avisa si no coincide.
- CSV sin fórmulas (`csvSeguro`) y PDF con texto escapado. Se guardan con `guardar_descarga` en la carpeta fija `Reportes\AAAA-MM` (lista blanca en Rust).

### Gaveta e impresoras
- La gaveta solo se abre por `gaveta_venta` (venta con efectivo del turno abierto, una sola vez: `ventas.gaveta_abierta_en`), `gaveta_no_venta` (motivo de la lista; "Otro" pide texto) , `gaveta_dueno` (PIN del dueño) o `gaveta_cierre` (una vez por turno, quien puede cerrarlo, para contar; no cuenta como "sin venta") o `gaveta_abono` (abono de apartado o crédito en efectivo, de su turno abierto, una vez por operación: `abonos.gaveta_abierta_en`). Las tres últimas quedan en `gaveta_aperturas` (solo añadir, triggers) y en la bitácora; si el pulso no llega, no queda registro.
- **Todo lo que se imprime pasa por una lista blanca** (`escpos::validar`): texto, saltos, negrita, tamaño, alineación, tabla de caracteres, código de barras, logo (sus datos se saltan por su largo) y corte. `ESC p`, `DLE DC4` y cualquier otro control se rechazan: ni un tiquete, ni el diagnóstico del técnico, ni una prueba de impresora pueden abrir la gaveta.
- Las impresoras se eligen de lo que detecta Windows (impresoras, puertos COM, dispositivos USB de impresora); Rust lo vuelve a revisar al guardar y al imprimir. No se aceptan rutas escritas a mano (`\\otra-pc\cola`).
- El tiquete original sale una vez (`ventas.impreso_en`); después solo como COPIA marcada, y cada copia queda en la bitácora.

### Exportaciones e impresión
- El CSV de clientes antepone `'` a las celdas que empiezan con `= + - @`, tabulador o retorno, para evitar fórmulas.
  - El PDF no ejecuta fórmulas: el texto va escapado como cadena PDF.
- ESC/POS: el texto se codifica a la code page y los caracteres de control se reemplazan por `?`. Un nombre de producto no puede cortar el papel, abrir la gaveta ni reiniciar la impresora (hay una prueba para esto).

### Cadena de suministro
- `package-lock.json` y `Cargo.lock` están fijados. Se quitó `tauri-plugin-sql`, que ya no se usa.
- `npm audit --omit=dev`: 0 vulnerabilidades. Las alertas de `npm audit` completo vienen de `webdriverio` (solo para la prueba de punta a punta; no va en el instalador). `cargo deny check`: advisories, bans, licenses y sources en ok.
- `cargo audit`: sin hallazgos aplicables. Hay 3 excepciones justificadas en `src-tauri/.cargo/audit.toml`:
  - `rsa`: viene por el driver MySQL opcional de sqlx, que no se compila.
  - `glib` y `proc-macro-error`: son dependencias de Linux.
  - Se verificó con `cargo tree -i <crate> --target all`.
- Compilación release: LTO, `codegen-units = 1`, `panic = "abort"`, `strip = true`.
- Instalador **sin firmar**. Cada entrega se publica con su SHA-256 (ver la sección 6).

### Datos que sobreviven (auditoría 0.9.0)
- **Carpeta de datos fija**: `%APPDATA%\PuntoDeVenta-Datos` (ver «Datos en disco»). El `identifier` de `tauri.conf.json` (`cr.puntodeventa.pos`) igual no se cambia: `build.rs` frena el build si alguien lo cambia (JSON no admite comentarios y Tauri rechaza claves desconocidas, así que el aviso vive en `build.rs`).
- **Instalador**: solo NSIS, por usuario (`installMode: currentUser`), coherente con la clave DPAPI atada al usuario de Windows.
- **Nunca una base vacía encima**: si falta `pos.db` pero existe `pos.clave` (o al revés, con cifrado), la app NO crea nada nuevo y ofrece «Restaurar desde respaldo» (`bd::revisar_instalacion`).
- **Restaurar sin sesión** cuando la base no abre (`sistema_restaurar`): solo en ese estado; lo protege la contraseña del respaldo. La base que no abría queda aparte con fecha; si la clave no se puede leer, queda como `pos.clave.resguardo-<fecha>` y se crea otra.
- **Migraciones y saltos de línea**: sqlx guarda una suma de cada migración aplicada. Un build hecho desde un clon con CRLF dejaba de abrir las bases (encontrado en la simulación de la actualización futura). Ahora el SQL se normaliza a LF (`bd::sin_cr`), las sumas guardadas con CRLF se pasan a la normalizada si el contenido es idéntico (`bd::reparar_sumas`) y `.gitattributes` fija LF en los `.sql`.
- **Migraciones futuras**: desde la 13 no pueden borrar tablas ni filas salvo marcado explícito (`tests/migraciones.test.ts`).
- **Restauración atómica**: el respaldo se exporta a `pos.db.nuevo.parcial` y recién al final pasa a `pos.db.nuevo`; un corte a medias no reemplaza la base.
- **Una sola instancia** por usuario (mutex con nombre de Windows): dos ventanas serían dos escritores.
- **Reloj atrasado**: además de al abrir la caja, se revisa al cobrar y al cerrar.

### Respaldo automático y diagnóstico
- El dueño elige la contraseña una vez (con su PIN); se guarda protegida con DPAPI (`respaldo-automatico.clave`). Los automáticos usan esa contraseña, así se abren en otra computadora. Uno al día y uno al cerrar cada turno, en segundo plano; quedan los últimos N (`respaldo_auto_cantidad`, 30); cada uno se relee del disco y se verifica (descifrar + integridad + bitácora). Recordatorio semanal al dueño de copiarlos a la USB.
- **Contraseña perdida = respaldos perdidos.** No hay recuperación posible (es el punto del cifrado). La pantalla lo advierte con casilla de «entendido» al hacer un respaldo y al activar el automático.
- Registro local de errores técnicos `errores.log` (rota a los 512 KB): origen y mensaje técnico, sin control, máx. 400 caracteres y toda secuencia de 6+ dígitos cambiada por «#». También los cierres inesperados de Rust (panic). «Exportar diagnóstico» (solo técnico) arma un `.txt` en Descargas con versión, base, integridad, bitácora, conteos (nunca nombres) y las últimas líneas del registro.

### Permisos configurables (0.9.3, DISENO-PERMISOS.md)
- **Modelo**: cada comando corresponde a una acción del catálogo (`acciones.rs`). Para cada acción y rol hay una política: no · sí · sí con motivo · con PIN del dueño (y motivo), con límites opcionales (monto, %, cantidad por turno, solo el turno abierto, minutos desde la venta) y qué pasa al pasarlos (pide PIN o no deja). Excepciones por cajero. Política efectiva (un solo lugar, `politica::efectiva`): reglas fijas → excepción del usuario → su rol → **no** (lo que no tiene política se niega).
- **Puerta común** (`App::comando` en lib.rs): bloqueo por inactividad, cambio de PIN pendiente y la política del comando. Un comando sin acción en `acciones::COMANDOS` se niega. Las acciones con límites los revisan dentro de su transacción (`politica::aplicar`), con los datos de esa misma transacción.
- **Guardado**: `seguridad_versiones` (migración 25), solo agregar: triggers contra `UPDATE` y `DELETE`, cada fila con el hash de la anterior (como la bitácora) y el JSON validado contra un esquema en Rust al leer (`deny_unknown_fields` + `politica::validar`). Vigente = la última de la cadena sana. Se verifica **al abrir la app y al cerrar la caja**: si está rota se usa la última válida, queda en la bitácora (`seguridad.alterada`) y el dueño ve el aviso al entrar.
- **En memoria**: la vigente vive en `App.seguridad` y se vuelve a leer solo al agregar una versión (`seguridad_guardar`, `seguridad_inactividad`, `seguridad_volver` o al cerrar la caja si la cadena se rompió). Cada comando toma una copia (`Actor.seg`): un cambio aplica en el siguiente comando, sin cerrar sesión; la pantalla recibe el evento `seguridad-cambiada` y vuelve a pedir sus permisos.
- **Quién edita**: dueño y técnico (`seguridad.editar`, fija). Lo que **da más permiso** sobre dinero, caja, clientes o anulaciones (o sube el bloqueo de 10 min) pide además el PIN de un dueño, aunque lo haga el técnico o el mismo dueño (`politica::mas_permisivo`). Volver a una versión anterior: siempre con PIN; crea una versión nueva con los datos de la vieja (el historial no se reescribe).
- **Reglas fijas** (Rust las aplica al calcular y al validar; la pantalla las muestra deshabilitadas):
  1. La fila del dueño es fija e igual a la 0.9.2 (incluido su PIN donde se pedía). En «vender sin existencia» y «salida de efectivo» el tope es del negocio: el dueño sigue el del cajero (con PIN al pasar), como antes.
  2. Siempre queda al menos un dueño activo **con su PIN propio** (sin cambio pendiente): no se desactiva ni se elimina el último (`usuarios::no_quedar_sin_dueno`). No hay comando para cambiar el rol de un usuario.
  3. Editar permisos e inactividad: fijo para dueño y técnico; nadie se lo quita.
  4. La bitácora no se apaga ni se edita (no hay acción para eso; triggers).
  5. El técnico nunca tiene una acción protegida (🔒: clientes, ventas, dinero; Ley 8968), aunque venga en los datos: la versión se rechaza.
  6. El cajero nunca tiene «editar permisos», «tiempo de bloqueo», «usuarios», «configuración técnica» ni «preparar» (ni por excepción).
  7. «Ver totales con el turno abierto» para el cajero solo se guarda con la advertencia confirmada.
  8. El bloqueo por inactividad no se desactiva (1 a 60 min; técnico hasta 15).
- **Plantillas**: Estricto, Normal (= 0.9.2) y Flexible (anular C hasta ¢10.000, 3 por turno, 30 min; descuento 15 %; salida hasta ¢30.000). Antes de aplicar se ve la lista de diferencias.
- Los topes que antes eran claves de configuración (`descuento_max_pct`, `caja_salida_max_sin_pin`, `permitir_vender_sin_existencia`, `venta_mostrar_existencia`, `sesion_inactividad_min`) pasaron a la versión 1 de los permisos con su valor; `config_guardar` ya no los acepta. `caja_no_venta_umbral` sigue como el aviso del Z; el PIN desde cierta cantidad es el límite de `caja.no_venta`.

### Anulación por el cajero (0.9.3)
- Opción A (solo el dueño, como antes), B (cajero con PIN del dueño) o C (cajero sin PIN, con motivo de la lista configurable y límites: monto, cantidad por turno, solo el turno abierto, minutos desde la venta; al pasar uno, PIN o no deja). Todo en la transacción de `ventas::anular`.
- Siempre con PIN aunque cumpla los límites: turno cerrado, venta con factura electrónica, devolución de más dinero que el monto permitido. Las ventas que liquidan un apartado o un crédito con abonos no se anulan desde Ventas del día con ninguna opción.
- `ventas.anulada_actor`, `anulada_politica` (A/B/C) y `anulada_version`; `anulada_por` es quien autorizó. Bitácora con la política, la versión, si fue sin PIN y el límite que pidió el PIN.
- Comprobante (número, monto, motivo, usuario, fecha y hora real de Rust, firma del cajero) obligatorio en C; en A y B según la opción (apagada por defecto). Se reimprime desde la venta.
- Z: sección «Anulaciones por cajero sin PIN» aparte (papel, PDF y pantalla). El dueño ve al entrar «Hubo N anulaciones sin PIN»; un día con más que el umbral sale marcado en Cierres de caja. Dinero, inventario y Z se ajustan igual en las tres opciones.

### Bloqueo por inactividad (0.9.3)
- Lo decide Rust con el reloj de `util::ahora` (inyectable): `Sesion` guarda la última actividad real. Solo `sesion_tocar` la renueva: la pantalla lo llama con teclado (incluido el lector de código de barras), mouse o táctil, a lo sumo cada 10 s. **Los comandos no renuevan** (una pantalla que recarga sola no mantiene viva la sesión). Si la pantalla deja de informar, el siguiente comando choca igual.
- Al vencer, la sesión queda **bloqueada** (no se cierra): ningún comando corre (`SESION_BLOQUEADA`), aunque se llame directo. Un comando que ya empezó (cobro, impresión) termina: el guardia `en_curso` evita bloquear a la mitad y el bloqueo cae en el siguiente.
- Mientras está bloqueada, lo de abajo no escucha el teclado: el lector de códigos y los atajos de la venta escuchan en `window` y se apagan con el velo puesto (`pantallaBloqueada`).
- Desbloquear: el mismo usuario con su PIN (misma escalera de intentos y bitácora `sesion.desbloqueo`) sigue donde estaba (la pantalla quedó montada detrás de un velo opaco: venta en espera, conteo de caja a medias, entrada de mercadería, proforma). Otro usuario empieza de cero: la sesión anterior se descarta y la pantalla se vuelve a armar (borra el borrador de la entrada, que lleva costos).
- Tiempo: general y opcional por rol, de 1 a 60 min (técnico hasta 15); 10 por defecto; no existe «nunca». Bajarlo, sin PIN; subirlo de 10, con PIN del dueño. Queda en la bitácora (antes, después, PIN) y en el historial de versiones. Aviso «Se bloquea en 1 minuto por inactividad» (con 1 minuto, a los 30 s); cualquier tecla lo cierra.

### Tabla de permisos (comando × rol)
Con la plantilla Normal (versión 1 después de actualizar), cada comando responde igual que en la 0.9.2. Lo prueban dos tablas:
- `tabla_comandos::tabla_comandos_igual_que_la_foto`: llama **por IPC** (runtime simulado de Tauri, como la pantalla) los 161 comandos —203 variantes: cada clave de configuración, operación de catálogo, documento y carpeta— sin sesión, como cajero, dueño y técnico, y compara con `tests/casos/permisos_antes.json`, la foto tomada con el código de la 0.9.2 antes de tocar una validación. Los únicos cambios a propósito están listados en el código (`DELIBERADOS`: las 5 claves de configuración que pasaron a Permisos).
- `tabla_permisos::cada_comando_con_cada_rol_respeta_la_tabla` (la tabla de abajo, por módulo). «Permitido» = el comando no responde con falta de permiso (puede fallar por otra cosa).
- `permisos_tests::cada_comando_cada_rol_cada_politica`: cada comando con acción, como cajero y como técnico, con cada política (no, sí, motivo, PIN): se niega, pasa, pide el motivo o el PIN y pasa con la autorización (de un solo uso).

#### Acciones y política Normal por rol (plantilla «Normal» = 0.9.2)

🔒 = protegida (el técnico nunca). «fija» = no se cambia desde la pantalla. Fuente: `acciones.rs` + `tests/casos/permisos.json` (lo calcula Rust).

| Área | Acción | id | Cajero | Dueño | Técnico |
|---|---|---|:---:|:---:|:---:|
| Venta | Vender y cobrar 🔒 | `venta.vender` | ✔ | ✔ | — |
| Venta | Descuento por línea y al total 🔒 | `venta.descuento` | ✔ (≤ 10 %, al pasar: PIN) | ✔ | — |
| Venta | Precio libre (F4) 🔒 | `venta.precio_libre` | ✔ | ✔ | — |
| Venta | Vender sin existencia 🔒 | `venta.sin_existencia` | ✔ | ✔ (tope del negocio = el del cajero) | — |
| Venta | Vender unidades apartadas 🔒 | `venta.apartadas` | PIN | PIN | — |
| Venta | Quitar líneas de una venta abierta 🔒 | `venta.quitar_linea` | ✔ | ✔ | — |
| Venta | Descartar una venta en espera 🔒 | `venta.descartar_espera` | ✔ | ✔ | — |
| Venta | Ver existencias al vender 🔒 | `venta.ver_existencia` | — | ✔ | — |
| Ventas cobradas | Ver tiquetes del día 🔒 | `ventas.ver` | ✔ | ✔ | — |
| Ventas cobradas | Reimprimir tiquete 🔒 | `ventas.reimprimir` | ✔ | ✔ | — |
| Ventas cobradas | Anular una venta 🔒 | `ventas.anular` | — | PIN | — |
| Ventas cobradas | Cambiar la forma de pago 🔒 | `ventas.cambiar_pago` | — | PIN | — |
| Ventas cobradas | Pendientes de factura 🔒 | `facturas.ver` | ✔ | ✔ | — |
| Ventas cobradas | Marcar factura emitida 🔒 | `facturas.marcar` | ✔ | ✔ | — |
| Caja | Ver la caja y su turno 🔒 | `caja.ver` | ✔ | ✔ | — |
| Caja | Abrir caja 🔒 | `caja.abrir` | ✔ | ✔ | — |
| Caja | Cerrar caja (conteo y Z) 🔒 | `caja.cerrar` | ✔ | ✔ | — |
| Caja | Cerrar el turno de otro (de un día anterior) 🔒 | `caja.cerrar_otro` | ✔ | ✔ | — |
| Caja | Ver totales con el turno abierto 🔒 | `caja.ver_totales` | — | ✔ | — |
| Caja | Reabrir un turno 🔒 | `caja.reabrir` | — | PIN | — |
| Caja | Entrada de efectivo 🔒 | `caja.entrada` | ✔ | ✔ | — |
| Caja | Salida de efectivo 🔒 | `caja.salida` | ✔ (≤ ¢20.000, al pasar: PIN) | ✔ (≤ ¢20.000, al pasar: PIN) (tope del negocio = el del cajero) | — |
| Caja | Corte con retiro 🔒 | `caja.corte` | — | ✔ | — |
| Caja | No venta (abrir la gaveta con motivo) 🔒 | `caja.no_venta` | ✔ | ✔ | — |
| Caja | Abrir la gaveta con orden del dueño 🔒 | `caja.gaveta_sin_venta` | PIN | PIN | — |
| Caja | Historial de cierres y aperturas de gaveta 🔒 | `caja.historial` | — | ✔ | — |
| Caja | Reimprimir un cierre Z 🔒 | `caja.reimprimir_z` | PIN | PIN | — |
| Caja | Corregir la fecha de negocio 🔒 | `caja.corregir_dia` | — | PIN | — |
| Caja | Número inicial del consecutivo | `caja.consecutivo` | — | ✔ | ✔ |
| Caja | Opciones de caja y cierre | `caja.opciones` | — | ✔ | ✔ |
| Apartados y crédito | Crear y buscar apartados 🔒 | `cuentas.crear` | ✔ | ✔ | — |
| Apartados y crédito | Recibir abonos y entregar 🔒 | `cuentas.abonar` | ✔ | ✔ | — |
| Apartados y crédito | Ver todas las cuentas y estados de cuenta 🔒 | `cuentas.ver_todas` | — | ✔ | — |
| Apartados y crédito | Cancelar un apartado 🔒 | `cuentas.cancelar` | — | PIN | — |
| Apartados y crédito | Anular un abono 🔒 | `cuentas.anular_abono` | — | PIN | — |
| Apartados y crédito | Ajustar el saldo 🔒 | `cuentas.ajustar` | — | PIN | — |
| Apartados y crédito | Condonar el saldo 🔒 | `cuentas.condonar` | — | PIN | — |
| Apartados y crédito | Prorrogar la fecha límite 🔒 | `cuentas.prorrogar` | — | PIN | — |
| Apartados y crédito | Vender a crédito 🔒 | `credito.vender` | ✔ | ✔ | — |
| Apartados y crédito | Límites y opciones de crédito 🔒 | `credito.limite` | — | PIN | — |
| Apartados y crédito | Opciones de apartados y crédito | `cuentas.opciones` | — | ✔ | ✔ |
| Proformas | Crear, buscar e imprimir proformas 🔒 | `proformas.crear` | ✔ | ✔ | — |
| Proformas | Pasar una proforma a venta 🔒 | `proformas.convertir` | ✔ | ✔ | — |
| Proformas | Anular una proforma 🔒 | `proformas.anular` | — | ✔ | — |
| Proformas | Reporte de proformas 🔒 | `proformas.admin` | — | ✔ | — |
| Proformas | Opciones de proformas | `proformas.opciones` | — | ✔ | ✔ |
| Productos | Crear productos y códigos | `productos.crear` | — | ✔ | ✔ |
| Productos | Editar productos | `productos.editar` | — | ✔ | ✔ |
| Productos | Desactivar productos | `productos.desactivar` | — | ✔ | ✔ |
| Productos | Favoritos | `productos.favoritos` | — | ✔ | ✔ |
| Productos | Imprimir etiquetas | `productos.etiquetas` | — | ✔ | ✔ |
| Productos | Importar CSV | `productos.importar` | — | ✔ | ✔ |
| Productos | Editar departamentos (nombre, orden, color) | `departamentos.editar` | — | ✔ | ✔ |
| Productos | Crear departamentos y cambiar su código | `departamentos.estructura` | — | — | ✔ |
| Inventario | Ver existencias y kardex 🔒 | `inventario.ver` | — | ✔ | — |
| Inventario | Entradas de mercadería y proveedores 🔒 | `inventario.entradas` | — | ✔ | — |
| Inventario | Ajustes de inventario 🔒 | `inventario.ajustes` | — | ✔ | — |
| Inventario | Conteo físico y carga inicial 🔒 | `inventario.conteo` | — | ✔ | — |
| Inventario | Reportes de inventario 🔒 | `inventario.reportes` | — | ✔ | — |
| Inventario | Opciones de inventario 🔒 | `inventario.opciones` | — | ✔ | — |
| Clientes | Buscar y crear clientes (nombre, teléfono, cédula) 🔒 | `clientes.crear` | ✔ | ✔ | — |
| Clientes | Ver la lista y los datos completos 🔒 | `clientes.ver_todos` | — | ✔ | — |
| Clientes | Editar clientes 🔒 | `clientes.editar` | — | ✔ | — |
| Clientes | Exportar los datos de un cliente 🔒 | `clientes.exportar` | — | ✔ | — |
| Clientes | Anonimizar un cliente 🔒 | `clientes.anonimizar` | — | PIN | — |
| Reportes | Reportes de ventas 🔒 | `reportes.ver` | — | ✔ | — |
| Reportes | Exportar reportes y cierres 🔒 | `reportes.exportar` | — | ✔ | — |
| Administración | Usuarios (fija) | `usuarios.administrar` | — | ✔ | ✔ |
| Administración | Datos de contacto del negocio | `negocio.contacto` | — | ✔ | ✔ |
| Administración | Datos legales y logo | `negocio.legal` | — | — | ✔ |
| Administración | Formas de pago y bancos | `pagos.formas` | — | — | ✔ |
| Administración | Configurar impresoras y gaveta | `impresoras.configurar` | — | — | ✔ |
| Administración | Asignar y probar impresoras | `impresoras.asignar` | — | ✔ | ✔ |
| Administración | Configuración técnica (fija) | `config.tecnica` | — | — | ✔ |
| Administración | Respaldo 🔒 | `respaldo.crear` | — | ✔ | — |
| Administración | Restaurar un respaldo 🔒 | `respaldo.restaurar` | — | PIN | — |
| Administración | Ver la bitácora | `bitacora.ver` | — | ✔ | ✔ |
| Administración | Editar permisos (fija) | `seguridad.editar` | — | ✔ | ✔ |
| Administración | Tiempo de bloqueo por inactividad (fija) | `seguridad.inactividad` | — | ✔ | ✔ |
| Administración | Preparar para el cliente y diagnóstico (fija) | `sistema.preparar` | — | — | ✔ |

#### Comando → acción

Fuente: `acciones::COMANDOS`. La prueba `todo_comando_tiene_accion_y_lo_desconocido_se_niega` falla si un comando registrado no está aquí. «Según argumento»: la acción sale de la clave de configuración (`config::accion_de`), la operación (`sentencias.json`), el documento (`imprimir`), los campos (`negocio_guardar`), el usuario destino (`usuarios_*`: además la jerarquía fija) o el movimiento (`caja_movimiento`: entrada o salida).

| Comando | Acción |
|---|---|
| `sistema_estado` | sin sesión |
| `sistema_crear_tecnico` | sin sesión |
| `sistema_restaurar` | sin sesión |
| `diagnostico_anotar` | sin sesión |
| `app_reiniciar` | sin sesión |
| `sesion_usuarios` | sin sesión |
| `sesion_iniciar` | sin sesión |
| `sesion_tecnico` | sin sesión |
| `sesion_actual` | sin sesión |
| `sesion_cerrar` | sin sesión |
| `sesion_tocar` | sin sesión |
| `sesion_estado` | sin sesión |
| `sesion_permisos` | cualquier sesión |
| `prueba_avanzar_reloj` | sin sesión |
| `seguridad_autorizar` | cualquier sesión |
| `avisos_dueno` | cualquier sesión |
| `avisos_anulaciones_vistas` | cualquier sesión |
| `seguridad_obtener` | `seguridad.editar` |
| `seguridad_diferencias` | `seguridad.editar` |
| `seguridad_plantilla` | `seguridad.editar` |
| `seguridad_guardar` | `seguridad.editar` |
| `seguridad_historial` | `seguridad.editar` |
| `seguridad_version` | `seguridad.editar` |
| `seguridad_volver` | `seguridad.editar` |
| `seguridad_inactividad` | `seguridad.inactividad` |
| `bd_leer` | cualquier sesión |
| `bd_lote` | según argumento |
| `impresora_ajustes` | cualquier sesión |
| `usuarios_listar` | `usuarios.administrar` |
| `usuarios_crear` | `usuarios.administrar` |
| `usuarios_editar` | según argumento |
| `usuarios_cambiar_pin` | según argumento |
| `usuarios_eliminar` | según argumento |
| `config_guardar` | según argumento |
| `negocio_guardar` | según argumento |
| `negocio_logo` | `negocio.legal` |
| `bitacora_listar` | `bitacora.ver` |
| `bitacora_verificar` | `bitacora.ver` |
| `caja_estado` | `caja.ver` |
| `caja_abrir` | `caja.abrir` |
| `caja_queda` | `caja.cerrar` |
| `caja_corregir_dia` | `caja.corregir_dia` |
| `caja_movimiento` | según argumento |
| `caja_detalle` | `caja.ver` |
| `caja_necesita_nota` | `caja.cerrar` |
| `caja_cerrar` | `caja.cerrar` |
| `caja_reabrir` | `caja.reabrir` |
| `caja_consecutivo` | `caja.consecutivo` |
| `caja_revisada` | `caja.historial` |
| `caja_z` | `caja.cerrar` |
| `caja_z_imprimir` | `caja.cerrar` |
| `caja_nota_cierre` | `caja.cerrar` |
| `caja_corte` | `caja.corte` |
| `caja_turnos` | `caja.ver` |
| `gaveta_venta` | `venta.vender` |
| `gaveta_abono` | `cuentas.abonar` |
| `gaveta_no_venta` | `caja.no_venta` |
| `gaveta_cierre` | `caja.cerrar` |
| `gaveta_dueno` | `caja.gaveta_sin_venta` |
| `gaveta_aperturas` | `caja.historial` |
| `venta_esperas` | `venta.vender` |
| `venta_espera_crear` | `venta.vender` |
| `venta_espera_guardar` | `venta.vender` |
| `venta_espera_descartar` | `venta.descartar_espera` |
| `venta_autorizar_descuento` | `venta.descuento` |
| `venta_faltantes` | `venta.vender` |
| `venta_referencia_usada` | `venta.vender` |
| `venta_cobrar` | `venta.vender` |
| `venta_obtener` | `ventas.ver` |
| `venta_listar_dia` | `ventas.ver` |
| `venta_listar_turno` | `ventas.ver` |
| `venta_imprimir` | `ventas.reimprimir` |
| `venta_correcciones` | `ventas.ver` |
| `venta_corregir_pago` | `ventas.cambiar_pago` |
| `venta_anular` | `ventas.anular` |
| `venta_pendientes_factura` | `facturas.ver` |
| `venta_pedir_factura` | `facturas.ver` |
| `venta_marcar_factura` | `facturas.marcar` |
| `cliente_crear` | `clientes.crear` |
| `cliente_buscar` | `clientes.crear` |
| `cliente_basico` | `clientes.crear` |
| `cliente_dato_factura` | `facturas.ver` |
| `cliente_tiene_correo` | `facturas.ver` |
| `cliente_listar` | `clientes.ver_todos` |
| `cliente_obtener` | `clientes.ver_todos` |
| `cliente_editar` | `clientes.editar` |
| `cliente_cuentas_saldo` | `clientes.ver_todos` |
| `cliente_exportar` | `clientes.exportar` |
| `cliente_anonimizar` | `clientes.anonimizar` |
| `cliente_retencion` | `clientes.ver_todos` |
| `cuentas_reglas` | `cuentas.crear` |
| `cuenta_crear_apartado` | `cuentas.crear` |
| `cuenta_abonar` | `cuentas.abonar` |
| `cuenta_entregar` | `cuentas.abonar` |
| `cuenta_buscar` | `cuentas.crear` |
| `cuenta_obtener` | `cuentas.crear` |
| `cuenta_imprimir` | `cuentas.crear` |
| `cuenta_listar` | `cuentas.ver_todas` |
| `cuenta_vencidas` | `cuentas.ver_todas` |
| `cuenta_cancelar` | `cuentas.cancelar` |
| `cuenta_ajustar` | `cuentas.ajustar` |
| `cuenta_condonar` | `cuentas.condonar` |
| `cuenta_prorrogar` | `cuentas.prorrogar` |
| `abono_anular` | `cuentas.anular_abono` |
| `cliente_limite_credito` | `credito.limite` |
| `cliente_limite_obtener` | `credito.limite` |
| `cliente_estado_cuenta` | `cuentas.ver_todas` |
| `credito_disponible` | `credito.vender` |
| `credito_opciones` | `credito.limite` |
| `credito_guardar_opciones` | `credito.limite` |
| `proforma_guardar` | `proformas.crear` |
| `proforma_buscar` | `proformas.crear` |
| `proforma_obtener` | `proformas.crear` |
| `proforma_imprimir` | `proformas.crear` |
| `proforma_anular` | `proformas.anular` |
| `proforma_abrir` | `proformas.crear` |
| `proforma_reporte` | `proformas.admin` |
| `reporte_rangos` | `reportes.ver` |
| `reporte_ventas` | `reportes.ver` |
| `respaldo_crear` | `respaldo.crear` |
| `respaldo_ultimo` | `respaldo.crear` |
| `respaldo_auto_configurar` | `respaldo.crear` |
| `respaldo_auto_estado` | `respaldo.crear` |
| `respaldo_auto_ahora` | `respaldo.crear` |
| `respaldo_usb_confirmado` | `respaldo.crear` |
| `respaldo_restaurar` | `respaldo.restaurar` |
| `guardar_descarga` | según argumento |
| `diagnostico_exportar` | `sistema.preparar` |
| `sistema_preparacion` | `sistema.preparar` |
| `importacion_leer` | `productos.importar` |
| `importacion_aplicar` | `productos.importar` |
| `inventario_lista` | `inventario.ver` |
| `inventario_estado` | `inventario.ver` |
| `inventario_existencia` | `venta.ver_existencia` |
| `inventario_alertas` | `inventario.ver` |
| `inventario_producto` | `inventario.ver` |
| `inventario_kardex` | `inventario.ver` |
| `inventario_entrada` | `inventario.entradas` |
| `inventario_entrada_obtener` | `inventario.entradas` |
| `inventario_ajustar` | `inventario.ajustes` |
| `inventario_conteo_abierto` | `inventario.conteo` |
| `inventario_conteo_guardar` | `inventario.conteo` |
| `inventario_conteo_diferencias` | `inventario.conteo` |
| `inventario_conteo_aplicar` | `inventario.conteo` |
| `inventario_conteo_descartar` | `inventario.conteo` |
| `inventario_inicial` | `inventario.conteo` |
| `inventario_reporte_bajo_minimo` | `inventario.reportes` |
| `inventario_reporte_valorizado` | `inventario.reportes` |
| `inventario_reporte_movimientos` | `inventario.reportes` |
| `proveedores_listar` | `inventario.entradas` |
| `proveedor_guardar` | `inventario.entradas` |
| `proveedor_eliminar` | `inventario.entradas` |
| `impresoras_listar` | `impresoras.asignar` |
| `impresoras_detectar` | `impresoras.configurar` |
| `impresora_guardar` | `impresoras.configurar` |
| `impresora_eliminar` | `impresoras.configurar` |
| `impresora_asignar` | `impresoras.asignar` |
| `impresora_probar` | `impresoras.asignar` |
| `imprimir` | según argumento |
| `list_printers` | `impresoras.configurar` |
| `print_raw` | `impresoras.configurar` |

#### Tabla por módulo (0.9.2, sigue igual con la Normal)


| Comando | Cajero | Dueño | Técnico |
|---|:---:|:---:|:---:|
| `usuarios_listar` | — | ✔ | ✔ |
| `usuarios_crear (cajero)` | — | ✔ | ✔ |
| `usuarios_editar` | — | ✔ | ✔ |
| `usuarios_cambiar_pin (de otro)` | — | ✔ | ✔ |
| `usuarios_eliminar` | — | ✔ | ✔ |
| `config_guardar (tema)` | ✔ | ✔ | ✔ |
| `config_guardar (técnica)` | — | — | ✔ |
| `config_guardar (caja_*)` | — | ✔ | ✔ |
| `config_guardar (inventario)` | — | ✔ | — |
| `negocio_guardar (contacto)` | — | ✔ | ✔ |
| `negocio_logo` | — | — | ✔ |
| `bitacora_listar / verificar` | — | ✔ | ✔ |
| `caja_estado` | ✔ | ✔ | — |
| `caja_abrir` | ✔ | ✔ | — |
| `caja_queda` | ✔ | ✔ | — |
| `caja_corregir_dia` | — | ✔ | — |
| `caja_movimiento` | ✔ | ✔ | — |
| `caja_detalle` | ✔ | ✔ | — |
| `caja_necesita_nota` | ✔ | ✔ | — |
| `caja_cerrar` | ✔ | ✔ | — |
| `caja_reabrir` | — | ✔ | — |
| `caja_revisada` | — | ✔ | — |
| `caja_consecutivo (antes de la 1.ª venta)` | — | ✔ | ✔ |
| `caja_z` | ✔ | ✔ | — |
| `caja_z_imprimir` | ✔ | ✔ | — |
| `caja_nota_cierre` | ✔ | ✔ | — |
| `caja_corte` | — | ✔ | — |
| `caja_turnos` | ✔ | ✔ | — |
| `gaveta_venta` | ✔ | ✔ | — |
| `gaveta_abono` | ✔ | ✔ | — |
| `gaveta_no_venta` | ✔ | ✔ | — |
| `gaveta_cierre` | ✔ | ✔ | — |
| `gaveta_dueno` | ✔ | ✔ | — |
| `gaveta_aperturas` | — | ✔ | — |
| `venta_esperas / crear / guardar` | ✔ | ✔ | — |
| `venta_espera_descartar` | ✔ | ✔ | — |
| `venta_autorizar_descuento` | ✔ | ✔ | — |
| `venta_faltantes` | ✔ | ✔ | — |
| `venta_referencia_usada` | ✔ | ✔ | — |
| `venta_cobrar` | ✔ | ✔ | — |
| `venta_obtener` | ✔ | ✔ | — |
| `venta_listar_dia` | ✔ | ✔ | — |
| `venta_listar_turno` | ✔ | ✔ | — |
| `venta_imprimir` | ✔ | ✔ | — |
| `venta_correcciones` | ✔ | ✔ | — |
| `venta_corregir_pago` | — | ✔ | — |
| `venta_anular` | — | ✔ | — |
| `venta_pendientes_factura` | ✔ | ✔ | — |
| `venta_pedir_factura` | ✔ | ✔ | — |
| `venta_marcar_factura` | ✔ | ✔ | — |
| `cliente_crear` | ✔ | ✔ | — |
| `cliente_buscar` | ✔ | ✔ | — |
| `cliente_basico` | ✔ | ✔ | — |
| `cliente_dato_factura` | ✔ | ✔ | — |
| `cliente_tiene_correo` | ✔ | ✔ | — |
| `cliente_listar` | — | ✔ | — |
| `cliente_obtener` | — | ✔ | — |
| `cliente_editar` | — | ✔ | — |
| `cliente_cuentas_saldo` | — | ✔ | — |
| `cliente_exportar` | — | ✔ | — |
| `cliente_anonimizar` | — | ✔ | — |
| `cliente_retencion` | — | ✔ | — |
| `cuentas_reglas` | ✔ | ✔ | — |
| `cuenta_crear_apartado` | ✔ | ✔ | — |
| `cuenta_buscar` | ✔ | ✔ | — |
| `cuenta_obtener` | ✔ | ✔ | — |
| `cuenta_abonar / liquidar` | ✔ | ✔ | — |
| `cuenta_entregar` | ✔ | ✔ | — |
| `cuenta_imprimir` | ✔ | ✔ | — |
| `credito_disponible` | ✔ | ✔ | — |
| `cuenta_listar / vencidas` | — | ✔ | — |
| `cuenta_cancelar` | — | ✔ | — |
| `cuenta_ajustar / condonar` | — | ✔ | — |
| `abono_anular` | — | ✔ | — |
| `cuenta_prorrogar` | — | ✔ | — |
| `cliente_limite_credito` | — | ✔ | — |
| `cliente_limite_obtener` | — | ✔ | — |
| `cliente_estado_cuenta` | — | ✔ | — |
| `credito_opciones / guardar_opciones` | — | ✔ | — |
| `proforma_guardar` | ✔ | ✔ | — |
| `proforma_buscar / obtener / abrir` | ✔ | ✔ | — |
| `proforma_imprimir` | ✔ | ✔ | — |
| `proforma_anular` | — | ✔ | — |
| `proforma_reporte` | — | ✔ | — |
| `reporte_rangos / ventas` | — | ✔ | — |
| `respaldo_crear` | — | ✔ | — |
| `respaldo_restaurar` | — | ✔ | — |
| `respaldo_ultimo` | — | ✔ | — |
| `respaldo_auto_configurar / estado / ahora / usb_confirmado` | — | ✔ | — |
| `importacion_leer` | — | ✔ | ✔ |
| `importacion_aplicar` | — | ✔ | ✔ |
| `inventario_* (lista, kardex, entradas, ajustes, conteos, carga inicial)` | — | ✔ | — |
| `inventario_reporte_*` | — | ✔ | — |
| `inventario_existencia (config apagada)` | — | ✔ | — |
| `proveedores_*` | — | ✔ | — |
| `impresoras_listar / asignar / probar` | — | ✔ | ✔ |
| `impresoras_detectar / guardar / eliminar` | — | — | ✔ |
| `impresora_ajustes (formato, sin destino)` | ✔ | ✔ | ✔ |
| `imprimir (movimiento)` | ✔ | ✔ | — |
| `imprimir (etiqueta)` | — | ✔ | ✔ |
| `imprimir (cierre)` | — | ✔ | — |
| `imprimir (entrada)` | — | ✔ | — |
| `list_printers / print_raw (diagnóstico)` | — | — | ✔ |
| `sistema_preparacion / diagnostico_exportar` | — | — | ✔ |
| `sistema_estado`, `sesion_*`, `sistema_crear_tecnico` (solo si no hay técnico), `sistema_restaurar` (solo si la base NO abre), `diagnostico_anotar`, `app_reiniciar` | sin sesión | sin sesión | sin sesión |
| `bd_leer` (solo catálogo y configuración pública), `guardar_descarga` (.pdf/.csv/.txt ya armados; carpeta solo de una lista fija + mes `AAAA-MM`, validados en Rust) | ✔ | ✔ | ✔ |

Notas: cajero y técnico no administran al dueño (con un usuario real responden «No tiene permiso»). El técnico NO consulta ventas (llevan el nombre del cliente): corregido en esta auditoría. `imprimir` cambia de permiso según el documento.

## 3. Lo que NO cubre

- **Un administrador de Windows o malware que corre como el mismo usuario**. Ese atacante puede pedirle a DPAPI la clave de la base, leer la memoria del proceso o registrar teclas. El cifrado protege el archivo si se lo llevan, no una máquina comprometida.
- **Quien conoce el PIN del dueño**. Puede hacer todo lo que hace el dueño; la bitácora solo deja el rastro.
- **Fraude físico** (no registrar una venta y quedarse el dinero). Solo se detecta con el arqueo diario y la revisión de diferencias.
- **Borrar todo el archivo de la base**. La bitácora no puede protegerse de eso; lo que lo cubre son los respaldos guardados fuera de la computadora.
- **Facturación electrónica de Hacienda**. Se hace en otro sistema; aquí solo se marca como hecha.
- **El instalador no está firmado** con certificado de código. Windows SmartScreen va a avisar. Verifique el SHA-256.
- **Lectura de catálogo**: `bd_leer` sigue existiendo para el catálogo y la configuración pública (lista blanca). Esas tablas no tienen datos personales ni costos.
- **Volver a una versión anterior del programa**: una base ya migrada no abre con el instalador viejo. Hay que restaurar la copia de `respaldos-automaticos` hecha antes de actualizar (ver PRUEBAS-MANUALES.md, sección P).
- **Turno compartido**: si varias personas usan la misma caja en el mismo turno, el faltante o sobrante es de la caja y no se puede atribuir a una persona (el Z lo dice). Para control por cajero, desactive `caja_turno_compartido`.
- **Gaveta abierta a mano** (llave o botón físico de la gaveta): no pasa por el sistema; solo el arqueo lo detecta.
- **Un solo puesto**: no hay red ni sincronización. El módulo de nube existe pero no está activo.

### Riesgos aceptados para la versión de prueba (0.9.0)
| Riesgo | Por qué se acepta | Qué lo mitiga |
|---|---|---|
| Instalador sin firma: SmartScreen avisa | El certificado cuesta y tarda; es una versión de prueba | SHA-256 de cada entrega en ENTREGAS.md; instalar solo desde la USB del técnico |
| Cambiar de usuario de Windows o reinstalar Windows: la base no abre | Es la protección DPAPI (un disco robado no se lee) | «Restaurar desde respaldo» en la pantalla de error + respaldo automático diario con la contraseña del dueño |
| Contraseña de respaldo perdida | Sin ella no se puede descifrar (por diseño) | Advertencia con casilla; anotarla fuera de la computadora |
| Impresora trabada: un hilo espera al driver hasta que contesta | Windows no deja cancelar con seguridad una escritura trabada | Límite de 10 s por envío; la base sigue libre; se puede reintentar al minuto |
| Uso prolongado (12 h) sin medir en la PC real | No se puede medir sin la app gráfica en la PC del negocio | Prueba de aceptación; consultas medidas con 50.000 ventas (búsqueda ~3 ms, Z ~30 ms) |
| `bd_leer` sigue para el catálogo | Las tablas permitidas no tienen datos personales ni costos | Lista blanca + rechazos a la bitácora |

## 4. Recomendaciones para cada negocio

1. **Usuario de Windows con contraseña** y bloqueo de pantalla. Nadie debe usar la cuenta de administrador para vender.
2. **BitLocker** encendido en el disco: suma protección a la de SQLCipher.
3. **Respaldo semanal** (Administración → Respaldo). Copie el archivo `.posbak` a una memoria USB que se guarde **fuera del local**. Anote la contraseña en un lugar separado.
4. **Si cambia de computadora o de usuario de Windows**: haga primero un respaldo. La base nueva no abre sin la clave DPAPI del usuario anterior.
5. **PIN**: cada persona tiene el suyo, sin compartirlo, y se cambia si alguien se va del negocio. El dueño usa 6 dígitos o más.
5b. **Permisos**: revise la tabla con el técnico (Administración → Permisos), imprímala («PDF para firmar»), fírmela y guárdela. Si cambia algo, imprima la versión nueva. Revise el aviso de anulaciones sin PIN cada vez que entra.
6. **Revise las diferencias de caja** cada día (Caja → Turnos, marca "Revisar"), y en Técnico → Sistema use "Verificar ahora" de la bitácora una vez al mes.
7. **Actualice Windows** y no instale programas que no conoce en la computadora de la caja.
8. Verifique el **SHA-256** del instalador antes de instalar (sección 6).

## 5. Pruebas automáticas de seguridad

| Requisito | Prueba |
|---|---|
| El cajero no puede ejecutar comandos del dueño | `caja::tests::abrir_movimientos_y_cerrar` (reabrir), `ventas::tests::turno_cerrado_pagos_inmutables_y_ajustes`, `usuarios::tests::cajero_no_administra_usuarios`, `config::tests::permisos_por_clave`, `clientes::tests::*`, `bd::tests::lote_solo_por_nombre_y_con_permiso` |
| Bloqueo de PIN | `usuarios::tests::bloqueo_progresivo_y_bitacora` |
| Se detecta una fila alterada de la bitácora | `bd::tests::bitacora_detecta_fila_alterada_y_no_se_edita_por_sql`, `tests/base.test.ts` (triggers) |
| Un respaldo alterado no se restaura | `respaldo::tests::respaldo_real_ida_y_vuelta_y_alterado_no_restaura`, `respaldo::tests_disco::base_vieja_se_cifra_y_el_respaldo_restaura_cifrado`, `respaldo::tests::cabecera_autenticada_y_formato_v1_se_sigue_leyendo` |
| Respaldos de versiones anteriores se restauran y se ponen al día (prueba permanente) | `respaldo::tests::respaldos_de_versiones_anteriores_se_restauran` (todos los `tests/fixtures/*.posbak`) |
| Respaldo más nuevo, alterado o con la caja abierta: rechazado sin tocar la base | `respaldo::tests_restaurar::no_restaura_con_caja_abierta_ni_respaldo_mas_nuevo_ni_alterado`, `respaldo::tests::respaldo_con_esquema_mas_nuevo_se_rechaza` |
| No se actualiza con la caja abierta; copia antes de migrar | `respaldo::tests_restaurar::actualizar_exige_caja_cerrada_y_respalda_antes` |
| Inventario: venta, anulación, espera, servicios y precio libre | `inventario::tests::venta_baja_anulacion_devuelve_espera_servicio_y_precio_libre_no` |
| Venta sin existencia bloqueada salvo PIN del dueño | `inventario::tests::sin_existencia_bloquea_salvo_pin_del_dueno` |
| Entrada, ajuste (motivo y PIN), conteo, carga inicial todo o nada | `inventario::tests::entrada_suma_costo_opcional_precio_y_kardex`, `::ajuste_exige_motivo_y_pin`, `::conteo_a_medias_y_aplicar_diferencias`, `::inventario_inicial_todo_o_nada` |
| Existencia = suma del kardex; kardex inmutable | `inventario::tests::kardex_no_se_modifica_ni_se_borra_ni_se_descuadra` (y `cuadra()` en cada prueba de inventario) |
| El cajero no recibe costos ni inventario valorizado; el técnico no entra | `inventario::tests::cajero_no_ve_costos_y_tecnico_no_entra` |
| Sin solicitudes de red | La CSP solo permite `ipc:`, `on_navigation` y `on_new_window` bloquean, y no hay capacidad HTTP (revisión de configuración; ver la lista de la sección 7). |
| La pantalla no puede pedir SQL arbitrario | `bd::tests::lectura_solo_select_y_solo_catalogo`, `bd::tests::lote_solo_por_nombre_y_con_permiso`, `tests/base.test.ts` |
| Precio o descuento manipulados en la pantalla | `ventas::tests::cobro_exige_turno_y_valida_precio_y_descuento` |
| El cajero no recibe totales del turno abierto (ningún comando, ni `bd_leer`) | `ventas::tests::cajero_no_recibe_totales_del_turno_abierto` |
| El cajero no anula ni cambia el pago de una venta cobrada | `ventas::tests::solo_el_dueno_anula_o_cambia_el_pago` |
| Turno compartido y por persona | `ventas::tests::turno_compartido_cada_venta_con_su_usuario`, `ventas::tests::sin_turno_compartido_otro_no_vende`, `caja::tests::turno_por_persona_si_no_es_compartido` |
| El conteo no se edita después de cerrar | `caja::tests::conteo_bloqueado_despues_de_cerrar` |
| La gaveta solo abre por los tres caminos | `gaveta::tests::gaveta_solo_por_los_tres_caminos`, `escpos::tests::rechaza_gaveta_y_controles_raros`, `ventas::tests::dos_impresoras_y_la_venta_no_se_pierde` |
| Cada documento a su impresora; solo destinos detectados | `impresoras::tests::cada_documento_a_su_impresora_y_solo_destinos_detectados` |
| El Z cuadra; si no, no se imprime; COPIA con PIN | `ventas::tests::z_cuadra_por_departamento_y_efectivo_esperado`, `desglose::tests::*`, `tests/cierre.test.ts` |
| ESC/POS sin comandos inyectados; CSV sin fórmulas | `tests/ventas.test.ts` ("impresión segura"), `tests/clientes.test.ts` |
| Apartados: mínimo, reserva, liquidación con el precio apartado, doble clic, sin turno no hay abono, caja tardía | `cuentas::tests::*` |
| Cada abono en exactamente un Z; el esperado igual a un modelo independiente | `cuentas::tests::el_z_cuadra_con_apartados_en_muchos_turnos` |
| Reglas iguales en Rust y en la pantalla | `cuentas::tests::reglas_iguales_que_en_la_pantalla`, `tests/cuentas.test.ts` (mismos casos: `tests/casos/cuentas.json`) |
| Reportes: suma = suma de los cierres Z; solo el dueño; un mes en < 2 s con 50.000 ventas | `reportes::tests::*` |
| Flujo completo en la app real | `npm run e2e` (WebdriverIO + tauri-driver) |
| Cada comando × cada rol igual que en la 0.9.2 (por IPC, con la plantilla Normal) | `tabla_comandos::tabla_comandos_igual_que_la_foto` (foto `tests/casos/permisos_antes.json`) |
| Cada comando × cajero y técnico × cada política (no, sí, motivo, PIN), llamado directo | `permisos_tests::cada_comando_cada_rol_cada_politica`, `::la_autorizacion_solo_con_el_pin_de_un_dueno` |
| Ningún comando sin acción; lo desconocido se niega | `permisos_tests::todo_comando_tiene_accion_y_lo_desconocido_se_niega` |
| Excepciones por usuario ganan solo para esa acción | `politica::tests::efectiva_excepcion_gana_solo_para_su_accion`, `anulacion_tests::opciones_a_y_b_y_el_comprobante_opcional` |
| Cambio de permisos con la sesión abierta aplica ya; PIN si da más; volver a una versión | `permisos_tests::cambio_aplica_de_inmediato_con_pin_si_da_mas_y_se_vuelve_a_una_version` |
| Reglas fijas (sin dueño, técnico con clientes, cajero con permisos o bloqueo, bitácora, bloqueo apagado) | `politica::tests::reglas_fijas_no_se_rompen`, `permisos_tests::reglas_fijas_por_ipc`, `::nunca_sin_un_dueno_activo_con_pin`, `usuarios::tests::siempre_queda_un_dueno_activo` |
| Cadena de versiones alterada o JSON fuera del esquema: se usa la última válida y queda en la bitácora | `politica::tests::cadena_alterada_o_json_invalido_usa_la_ultima_valida_y_queda_en_bitacora` |
| Anulación A/B/C: cada límite, reglas fijas, comprobante, Z, aviso, bitácora | `anulacion_tests::*` |
| Precio libre y quitar líneas según la política | `anulacion_tests::precio_libre_y_quitar_lineas_segun_la_politica` |
| Bloqueo por inactividad con el reloj inyectable; no a la mitad de un comando; el cambio aplica ya | `sesion::tests::*`, `politica::tests::inactividad_rango_y_tecnico` |
| Bloqueada, ningún comando corre; al volver, el trabajo a medias sigue; otro usuario no ve lo anterior | `permisos_tests::bloqueada_no_corre_ningun_comando_y_al_volver_sigue_todo` |
| Espejo Rust/TS (tope de descuento, minutos de bloqueo, acciones que nombra la pantalla) | `permisos_tests::casos_espejo_con_la_pantalla`, `tests/permisos.test.ts` (casos `tests/casos/permisos.json`) |
| Opción C, PIN al pasar, Z, aviso; bloqueo y venta en espera intacta (app real) | `npm run e2e` (`tests/e2e/permisos.e2e.mjs`) |

Cómo correrlas:
- Rust: `cd src-tauri && cargo test --lib` (190 pruebas + 1 ignorada que genera el fixture, con SQLCipher; las impresoras se simulan). Antes ponga Strawberry Perl en el PATH; ver la sección 6.
- TypeScript: `npm test` (226 pruebas).
- Punta a punta: `npm run e2e` (ver CONTEXTO.md, sección 2).

## 6. Compilar y verificar una entrega

```
# Requisitos: Rust (MSVC), Node 22+, Strawberry Perl (para compilar OpenSSL de SQLCipher)
set PATH=C:\Strawberry\perl\bin;%PATH%
npm ci
cd src-tauri && cargo audit && cargo deny check && cd ..
npm audit
npm run tauri build
certutil -hashfile src-tauri\target\release\bundle\nsis\<instalador>.exe SHA256
```

Publique el SHA-256 junto al instalador. Quien instala lo compara con `certutil -hashfile <archivo> SHA256`.

Compilación del 30-oct-2026 (versión 0.1.0):

| Archivo | SHA-256 |
|---|---|
| `Punto de Venta_0.1.0_x64-setup.exe` | `ce41c160c966caa7094db6fa79ddf0dad9e478060ce0f65757ab37ff1e0bc962` |
| `Punto de Venta_0.1.0_x64_en-US.msi` | `93861dac8c6bc1a2f8491dc1be0ccd20e6ab57b7edff3489b277b6f2afab7292` |

Cualquier cambio en el código produce otro hash: recalcúlelo en cada entrega.

## 7. Lista de verificación final

- [x] Sin shell, sistema de archivos, HTTP ni updater en las capacidades
- [x] CSP estricta (sin `unsafe-eval` ni scripts inline; red solo `ipc:`)
- [x] Sin navegación externa ni ventanas nuevas; DevTools apagado en release
- [x] Sin `console.log` con datos del negocio
- [x] Dinero y permisos validados en Rust, con enteros y en una sola transacción
- [x] SQL parametrizado; la pantalla no manda SQL de escritura
- [x] PIN con Argon2id, mínimo 6 para dueño y técnico, bloqueo progresivo en bitácora, sin revelar usuarios, cambio obligatorio, sesión con vencimiento
- [x] Base cifrada con SQLCipher y clave en DPAPI; WAL; revisión de integridad periódica; copia antes de migrar
- [x] Respaldos AES-256-GCM con Argon2id, sin copia en claro; los alterados se rechazan
- [x] Bitácora solo-añadir con cadena de hashes, verificada al cerrar caja
- [x] Triggers contra cambios en pagos de turnos cerrados
- [x] CSV sin fórmulas; ESC/POS sin caracteres de control
- [x] `npm audit`, `cargo audit`, `cargo deny` limpios; lockfiles fijados; dependencia sin uso quitada
- [x] Release con LTO y `strip`; SHA-256 documentado
- [ ] Firma de código del instalador (requiere comprar un certificado)
- [x] `bd_leer` limitado a catálogo y configuración pública (lista blanca, rechazos en bitácora)
- [x] Respaldos versionados: encabezado autenticado, migración al restaurar, fixtures por versión
- [x] Inventario solo por comandos tipados; kardex inmutable y cuadrado con la existencia
