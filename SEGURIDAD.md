# Seguridad del Punto de Venta

Este documento explica cómo se protege la aplicación. También dice qué cosas no cubre y qué debe hacer cada negocio.
Aplica a la versión 0.1.0, con las migraciones 1 a 12.

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
- **Sesión**: vive en Rust (`sesion.rs`). Cada comando toma el usuario de ahí, nunca de un parámetro, y vence por inactividad (`sesion_inactividad_min`, 10 min por defecto).
  - La pantalla también se bloquea sola al vencer el plazo.
- **Permisos**: tabla fija en `permisos.rs`. `src/lib/permisos.ts` es una copia que solo sirve para mostrar u ocultar botones.
  - El técnico no vende, no toca la caja y no ve clientes.
- **Dinero**: en colones enteros (`i64`) y en una sola transacción `BEGIN IMMEDIATE`. Rust vuelve a calcular totales, IVA, descuentos y vuelto (`calculo.rs`). El precio de un producto sale de la base, no de la pantalla.
  - **Autorización de descuento**: el PIN del dueño genera un token de un solo uso, válido para esa venta y ese porcentaje durante 30 minutos. Antes la pantalla mandaba el id del dueño y se le creía.
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
- Las acciones sensibles piden el PIN cada vez y no guardan la autorización. Son: reabrir caja, salida grande, anular, corregir un pago de un turno cerrado, anonimizar y restaurar.
- El técnico entra por una entrada oculta (Ctrl+Alt+T); no aparece en la lista.

### Datos en disco
- La base `pos.db` y los respaldos quedan en la carpeta de la app: `%APPDATA%\cr.puntodeventa.pos`.
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
- Si el pulso de la gaveta no contesta a tiempo, pudo llegar tarde y abrirla: la apertura se registra igual y se avisa. Si la impresora no recibió nada (apagada, sin gaveta), no queda registro.

### Clientes y facturas
- El consentimiento vale para el aviso de privacidad vigente: si el aviso cambió, Rust rechaza el registro con la versión vieja.
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
- **Totales ocultos al cajero con el turno abierto** (`caja::ve_totales`): `caja_detalle` le manda solo fondo, movimientos y aperturas sin venta; `caja_turnos` le manda las ventas y el total en `null`; `venta_listar_dia`, `venta_obtener`, `venta_imprimir` y `venta_pendientes_factura` solo le dan sus propios tiquetes; `caja_z` falla con el turno abierto; `caja_corte` es del dueño; y `bd_leer` no deja leer `ventas` ni `venta_lineas` a nadie. Una salida rechazada por falta de efectivo queda en la bitácora (`caja.salida_rechazada`), para que el mensaje no sirva para adivinar lo esperado sin dejar rastro.
- **Conteo ciego y bloqueado**: el cajero cuenta (total o billete por billete) sin ver lo esperado; al confirmar se cierra el turno y el trigger `caja_turnos_conteo_bloqueado` impide cambiar conteo, contado, esperado, diferencia o totales de un turno cerrado. Solo `reabrir` (dueño, PIN, motivo, mismo día, último turno) vuelve a abrirlo; el cierre anterior queda en la bitácora.
- **Cierre Z**: los totales congelados se revisan otra vez al leerlos (departamentos, detalle, formas de pago y efectivo deben cuadrar). Si no cuadran, Rust no imprime. La reimpresión exige el PIN del dueño y la marca "*** COPIA ***" en cada papel.
- **Anular y corregir pagos**: solo el dueño, con su PIN y motivo (`confirmar_dueno`). La venta anulada no se borra.
- Los pagos y los montos de una venta de un turno cerrado no se pueden cambiar (triggers). Una corrección posterior queda como `caja_ajustes` en el turno actual, la hace solo el dueño con PIN, y una devolución de efectivo entra como salida.

### Gaveta e impresoras
- La gaveta solo se abre por `gaveta_venta` (venta con efectivo del turno abierto, una sola vez: `ventas.gaveta_abierta_en`), `gaveta_no_venta` (motivo de la lista; "Otro" pide texto) o `gaveta_dueno` (PIN del dueño). Las dos últimas quedan en `gaveta_aperturas` (solo añadir, triggers) y en la bitácora; si el pulso no llega, no queda registro.
- **Todo lo que se imprime pasa por una lista blanca** (`escpos::validar`): texto, saltos, negrita, tamaño, alineación, tabla de caracteres, código de barras, logo (sus datos se saltan por su largo) y corte. `ESC p`, `DLE DC4` y cualquier otro control se rechazan: ni un tiquete, ni el diagnóstico del técnico, ni una prueba de impresora pueden abrir la gaveta.
- Las impresoras se eligen de lo que detecta Windows (impresoras, puertos COM, dispositivos USB de impresora); Rust lo vuelve a revisar al guardar y al imprimir. No se aceptan rutas escritas a mano (`\\otra-pc\cola`).
- El tiquete original sale una vez (`ventas.impreso_en`); después solo como COPIA marcada, y cada copia queda en la bitácora.

### Exportaciones e impresión
- El CSV de clientes antepone `'` a las celdas que empiezan con `= + - @`, tabulador o retorno, para evitar fórmulas.
  - El PDF no ejecuta fórmulas: el texto va escapado como cadena PDF.
- ESC/POS: el texto se codifica a la code page y los caracteres de control se reemplazan por `?`. Un nombre de producto no puede cortar el papel, abrir la gaveta ni reiniciar la impresora (hay una prueba para esto).

### Cadena de suministro
- `package-lock.json` y `Cargo.lock` están fijados. Se quitó `tauri-plugin-sql`, que ya no se usa.
- `npm audit`: 0 vulnerabilidades. `cargo deny check`: advisories, bans, licenses y sources en ok.
- `cargo audit`: sin hallazgos aplicables. Hay 3 excepciones justificadas en `src-tauri/.cargo/audit.toml`:
  - `rsa`: viene por el driver MySQL opcional de sqlx, que no se compila.
  - `glib` y `proc-macro-error`: son dependencias de Linux.
  - Se verificó con `cargo tree -i <crate> --target all`.
- Compilación release: LTO, `codegen-units = 1`, `panic = "abort"`, `strip = true`.
- Instalador **sin firmar**. Cada entrega se publica con su SHA-256 (ver la sección 6).

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

## 4. Recomendaciones para cada negocio

1. **Usuario de Windows con contraseña** y bloqueo de pantalla. Nadie debe usar la cuenta de administrador para vender.
2. **BitLocker** encendido en el disco: suma protección a la de SQLCipher.
3. **Respaldo semanal** (Administración → Respaldo). Copie el archivo `.posbak` a una memoria USB que se guarde **fuera del local**. Anote la contraseña en un lugar separado.
4. **Si cambia de computadora o de usuario de Windows**: haga primero un respaldo. La base nueva no abre sin la clave DPAPI del usuario anterior.
5. **PIN**: cada persona tiene el suyo, sin compartirlo, y se cambia si alguien se va del negocio. El dueño usa 6 dígitos o más.
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

Cómo correrlas:
- Rust: `cd src-tauri && cargo test --lib` (86 pruebas, con SQLCipher; las impresoras se simulan). Antes ponga Strawberry Perl en el PATH; ver la sección 6.
- TypeScript: `npm test` (153 pruebas).

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
