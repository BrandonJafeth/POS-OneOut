# Contexto del proyecto: Punto de Venta (POS) para Librería y Bazar Chagui

_Actualizado: 2026-11-20._

## 1. Qué es

App de escritorio para Windows, local y sin internet, para cobrar en negocios chicos de Costa Rica.
- Cliente actual: Librería y Bazar Chagui. La idea es reutilizarla en otros negocios (floristerías, tiendas de peluches y regalos, bazares): lo que cambia entre negocios es **configuración, no código** (departamentos, formas de pago, IVA, formato del tiquete, opciones de caja y turnos).
- Hardware del mostrador: PC Windows, impresora térmica POS-58 (ESC/POS, 32 columnas, code page CP858), gaveta de dinero y lector de código de barras USB que funciona como teclado.
- Catálogo: unos 719 productos importados de la web, casi todos sin foto; códigos EAN/ISBN y códigos internos alfanuméricos (ej. "07toc").
- Montos: colones enteros, con punto de miles.
- No emite factura electrónica de Hacienda. Esa se hace en otro sistema; el POS solo lista las ventas que quedan "pendientes de factura".
- Ya se probó en el equipo real del negocio (PC, POS-58, gaveta, lector). Las casillas sin marcar de `PRUEBAS-MANUALES.md` no significan que falte probar.

## 2. Tecnología

- **Tauri v2** (Rust) + **React + TypeScript** (Vite) + **SQLite cifrado con SQLCipher**.
- Rust decide todo lo sensible: dinero, permisos, PIN, caja, impresión, inventario. La pantalla (React) solo muestra y pide.
- Todo el SQL está en `src/db` y en Rust. Las escrituras de catálogo pasan por `bd_lote` (operaciones con nombre) en una sola transacción. La lectura con SQL desde la pantalla (`bd_leer`) solo alcanza catálogo y configuración pública (lista blanca); todo lo demás va por comandos tipados.
- Migraciones numeradas en `src/db/migraciones` (van de la **0001 a la 0022**). Nunca se edita una migración ya instalada; agregar una = archivo nuevo + versión siguiente.
- Configuración: tabla `config` (clave → JSON). Rust valida cada clave en `src-tauri/src/config.rs` (`validar`); los valores por defecto de la pantalla están en `CONFIG_DEFECTO` (`src/db/config.ts`). Una clave nueva no necesita migración: si no existe, se usa el valor por defecto.
- Pruebas: `npm test` (vitest con node:sqlite, 205) y `cargo test` (Rust, 157 + 1 ignorada que genera el fixture). Correr desde `C:\Freelance\POS` (con `c:\` en minúscula vitest falla).
  - **Punta a punta** (`npm run e2e`): WebdriverIO + tauri-driver sobre la app real (Rust, base cifrada, WebView2). Compila la app de desarrollo y recorre crear apartado → abonar → liquidar → cierre Z → reporte. Usa una carpeta de datos nueva (`POS_DATOS`), una semilla (`POS_E2E=1`) y el reloj fijo (`POS_RELOJ_PRUEBA`): las tres solo existen en la compilación de desarrollo. Requiere `cargo install tauri-driver` y `msedgedriver` de la misma versión que WebView2 (variable `MSEDGEDRIVER`). Se eligió tauri-driver (camino oficial de Tauri) y no Playwright por CDP, que obliga a dejar activa la depuración remota de WebView2 con una variable del sistema.
  - **Pruebas espejo**: las reglas que se validan en Rust y en TS (abono mínimo, fecha límite, abono, crédito) leen los mismos casos de `tests/casos/cuentas.json`.
- **Tipos de TS generados desde Rust** con `ts-rs` (solo en pruebas): `cargo test` escribe `src/generados/*.ts` para los comandos nuevos (apartados y reportes) y falla una vez si cambiaron. Se eligió ts-rs y no tauri-specta: no cambia el registro de los comandos existentes y no depende de una versión RC; los nombres de comando siguen en un solo lugar por módulo (`src/db/cuentas.ts`).
- **WebView2 mínimo: versión 120** (`preparacion::WEBVIEW2_MINIMO`; «Preparar para el cliente» lo revisa). La app usa `<dialog>` nativo, `:has()`, popover e `Intl`; no usa invoker commands (`command`/`commandfor`, 135) ni `closedby` (134). La PC de desarrollo tiene la 157. El instalador usa el runtime evergreen (se actualiza con Windows Update).
- **Diálogos**: `src/ui/Modal.tsx` es un `<dialog>` nativo con `showModal()` (capa superior, resto inerte, Esc, foco de vuelta). Los avisos (toast) son un popover manual para quedar encima.

Carpetas principales:
```
src/db/          capa de datos (único lugar con SQL)
src/lib/         lógica pura: venta/, caja/, importar/, impresión ESC/POS, permisos
src/screens/     pantallas (venta/, caja/, clientes/, productos/, inventario/, config/, respaldo/, hardware/)
src/ui/          componentes propios (Button, Modal, Field, Card, Alert…)
src-tauri/src/   Rust: ventas, caja, desglose (reparto del Z), estadisticas, usuarios, pin, impresoras,
                 escpos (lista blanca), gaveta, respaldo, bitacora, clientes, importacion,
                 inventario, config, permisos/tabla_permisos
tests/           pruebas vitest (+ tests/fixtures: un respaldo de cada versión)
```

Formularios que guardan: usan `useEnvio`, al guardar cierran y muestran un aviso (toast). No se permiten nombres repetidos (productos, departamentos, etc.; sin contar mayúsculas, tildes ni espacios).

## 3. Usuarios y roles

| Rol | Qué hace |
|---|---|
| **Cajero** | Vende, abre y cierra caja, busca o crea clientes (solo nombre, teléfono y cédula), crea apartados, recibe abonos y entrega (F9, F10), ve los tiquetes de todos en Ventas del día y en Pendientes de factura. **No ve totales de ventas** (ni de abonos) mientras el turno está abierto, ni límites de crédito. |
| **Dueño** | Hace todo lo del cajero, más productos, precios, departamentos, usuarios, datos del negocio, clientes completos, reportes de ventas e historial de cierres, apartados (todos, cancelar, anular abonos, condonar, prorrogar, límite de crédito), respaldo, inventario (existencias, entradas, ajustes, conteos, costos, proveedores), bitácora, opciones de caja, anulaciones y reaperturas (con PIN). Ve las impresoras y las prueba, pero no las configura. |
| **Técnico** | Configura la instalación (impresoras y gaveta, formas de pago, ajustes técnicos). **No ve datos de clientes, no vende, no toca la caja ni el inventario.** |

Acceso: PIN con Argon2id, bloqueo progresivo si falla, cambio de PIN obligatorio la primera vez y sesión con vencimiento. El técnico entra con **Ctrl+Alt+T** en el login.

## 4. Funcionalidades terminadas

### 4.1 Venta (pantalla principal)
- Grilla de productos a la izquierda y tiquete a la derecha (estilo Alegra POS).
- Búsqueda por texto o código, lector de barras, `3*código` para 3 unidades.
- Productos favoritos como tarjetas. Filtro por departamento con píldoras de color.
- **Ventas en espera:** varias ventas abiertas a la vez en pestañas, que se guardan solas en la base en cada cambio.
- Precio libre (F4), venta por departamento (F6), cliente (F7), descuento al total (F8), cobrar (F12). Diálogo de atajos (F1).
- Descuentos por línea o al total, en colones o porcentaje, con un tope por rol. Si se pasa del tope, pide el PIN del dueño.
- **Descuento fijo por producto** (% que pone el dueño en el catálogo): se aplica solo y no cuenta contra el tope del cajero. El Z lo separa de los descuentos que dio el cajero.
- Redondeo del total (₡5 por defecto) solo si hay efectivo; con tarjeta, SINPE o transferencia se cobra exacto.
- **Cobro mixto:** efectivo, tarjeta, SINPE Móvil y transferencia. En SINPE/transferencia el orden de los campos es **N.º de referencia → Banco → Nombre de quien paga** (el nombre se llena con el cliente de la venta si lo hay). Calcula el vuelto; un vuelto grande pide confirmar que se recibió el billete.
- Aviso si una referencia de pago ya se usó en otra venta (comprobante repetido).
- Consecutivo sin saltos ni repetidos (prefijo de la caja + número).
- IVA configurable. Chagui está en régimen simplificado y no lo muestra.
- Tiquete impreso con logo, una línea por pago (forma, banco, referencia), recibido y vuelto, y opción de COPIA.
- Si la impresora falla, la venta queda guardada para reimprimir.

### 4.2 Ventas del día y pendientes de factura
- Lista de las ventas del día (por fecha real de la venta), búsqueda y reimpresión.
- Anular una venta o cambiar su forma de pago: solo el dueño, con PIN y motivo. Si la caja de esa venta ya cerró, el ajuste queda en la caja abierta de hoy.
- "Pendientes de factura": las ventas que hay que facturar en el sistema externo, para marcarlas como hechas.

### 4.3 Caja (turno, movimientos, cierre Z)
- Abrir caja con fondo inicial. Valida si la hora del equipo no cuadra (reloj atrasado).
- **Turno compartido** (`caja_turno_compartido`, activo por defecto): varios usuarios venden en el mismo turno y cada acción guarda quién la hizo. "Cambiar usuario" cierra la sesión sin cerrar el turno. Sin la opción, cada cajero abre y cierra su turno.
- **Regla de fechas** (igual en turno compartido y por cajero; `caja.rs`: `apertura_para` + `decidir_dia`, único lugar):
  1. Cada turno tiene su **fecha de negocio** (`caja_turnos.dia`), decidida una vez al abrir. **"Mañana" = el próximo día laborable** (`caja_horario`: hora de cierre "HH:MM" de cada día, null = no se trabaja; Chaguí: lun–vie 18:30, sáb 17:30, dom no). Primera caja del día → hoy; ya se cerró hoy y es la hora de cierre del día o más tarde → el próximo día laborable, con aviso ("cuenta para el lunes 23"); ya se cerró hoy y es antes → quien abre elige "Hoy" o "Lunes 23" (sin opción marcada); día no laborable → "Hoy es domingo, día no laborable. ¿Abrir igual?" y cuenta para ese día (`no_laborable`, bitácora). Un cierre antes de las 5 a. m. cuenta como de la noche anterior.
  2. El Z va por turno. La venta guarda su fecha y hora real (`ventas.fecha`, `ventas.dia`); su día de negocio sale siempre del turno (`ventas::DIA_NEGOCIO`): Ventas del día, lista de tiquetes del turno y estadísticas usan ese. Las ventas cobradas antes del día de su turno salen en "Ventas después del cierre" (Z e historial).
  3. "Caja olvidada" solo si la fecha de negocio es anterior a hoy (la tardía del sábado, con fecha del lunes, no lo es el domingo ni el lunes). Un solo turno abierto por caja (en los dos modos). El dueño corrige la fecha (hoy o el próximo laborable) con PIN y motivo, abierto o cerrado hoy. Cambiar días u horas no mueve turnos existentes.
  5. **Reloj único**: toda decisión por fecha u hora lee `util::ahora()` (hora local de la PC; en pruebas, la que fija cada prueba con `util::fijar_reloj`, o toda la suite con `POS_RELOJ_PRUEBA`). La pantalla usa `EstadoCaja.hoy`/`siguiente` de Rust; su propia hora solo se muestra. Ninguna prueba depende de la hora a la que se corre.
  4. Conteo de apertura ciego y bloqueado; se compara con lo que quedó en la gaveta al cerrar la caja anterior ("¿Cuánto queda…?" después del conteo de cierre; contado − queda = retiro de cierre). Turno por cajero: otro cajero puede cerrar, con su conteo ciego, un turno que quedó abierto desde un día anterior.
- Entradas y salidas de efectivo (movimientos grandes se validan), "da vuelto" con la caja abierta, y gastos olvidados de turnos anteriores.
- **Corte** (dueño): ve lo acumulado y puede hacer un retiro con PIN.
- **Conteo ciego:** el cajero cuenta billete por billete (o escribe el total) sin saber cuánto debería haber. Al confirmar, el conteo queda bloqueado (trigger). Al cerrar, la gaveta se abre una vez para contar (causa `cierre`, no cuenta como "sin venta").
- **Cierre Z completo:** formas de pago, efectivo esperado contra contado, descuentos (del cajero y de catálogo), anulaciones, aperturas sin venta, cortes, ventas por usuario y por departamento (reparto exacto), detalle de tarjeta, SINPE y transferencia, movimientos, conteo, firmas, estadísticas de control por usuario y lecturas del día, y registro del supervisor.
- Opciones al cerrar: detalle completo o un tiquete por departamento. PDF tamaño carta con logo y detalle de transacciones para el dueño. Reimprimir sale como COPIA y pide el PIN del dueño.
- Solo el dueño reabre un turno (PIN y motivo), si no se abrió otro después.

### 4.4 Gaveta de dinero
- Solo se abre con una venta en efectivo (una vez), con una "No venta" con motivo, con una orden del dueño con PIN, o una vez al cerrar la caja.
- Límite de "no venta" por turno: al llegar avisa en el cierre; pasado, pide el PIN del dueño.
- Ningún otro trabajo de impresión puede abrirla: Rust filtra los comandos ESC/POS con una lista blanca.

### 4.5 Productos y catálogo
- Crear y editar productos, códigos de barras y códigos internos generados. Nombres repetidos bloqueados.
- Etiquetas con código de barras.
- **Importación CSV** desde la web, con reglas de categoría y palabras clave para asignar departamentos y favoritos, opción de generar códigos internos, vista previa de errores y modo "todo o nada" o "solo las filas válidas". Se confirma con PIN y Rust valida todo de nuevo.
- Departamentos: nombre, orden, activo/inactivo y color (paleta de 12, con contraste de texto automático).

### 4.6 Clientes (Ley 8968 de protección de datos)
- Solo nombre y teléfono obligatorios. No se guarda un cliente sin su consentimiento, que queda con fecha y versión del aviso.
- El dueño puede ver todos los datos, corregirlos, exportarlos (PDF o CSV) y anonimizarlos (con PIN y motivo). Los clientes no se borran: se anonimizan.

### 4.7 Configuración
- Datos del negocio: nombre, cédula, régimen, dirección, logo, encabezado y pie del tiquete.
- Formas de pago y bancos.
- **Varias impresoras** (Windows, puerto serial o USB directo), de 58 u 80 mm, con code page, cortador y gaveta. Las configura solo el técnico; el dueño las ve, las prueba y elige a cuál va cada documento (tiquete, cierre, movimientos, etiquetas).
- Usuarios: crear, editar y cambiar PIN.
- **Caja y cierre** (dueño): turno compartido, varios turnos al día y hora de cierre por día (se pone la hora **real** de cierre; "Misma hora para todos los días de trabajo" + "Aplicar a todos", y luego se cambia solo el día distinto), casillas por defecto del Z, motivos y límite de "no venta", consecutivo, monto desde el que quitar una línea queda en la bitácora.
- Tema claro u oscuro por equipo (contraste WCAG AA verificado con pruebas).
- Herramientas de hardware: prueba del lector, prueba de la impresora, vista previa sin hardware y diagnóstico.

### 4.8 Inventario (fase 4)
- Existencia por producto y sucursal en unidades enteras; mínimo y último costo (el costo solo lo ve el dueño).
- Control por código: un producto nuevo empieza sin control; su primer código de barras lo pone bajo control. Servicios (sin código) y precio libre no controlan inventario.
- Kardex solo-agregar: venta, anulación, entrada, ajuste e inventario inicial. La existencia se guarda en la misma transacción y siempre es la suma del kardex (trigger).
- Cobrar baja la existencia; anular la devuelve; la venta en espera no la toca. `permitir_vender_sin_existencia` (sí por defecto): si se apaga, vender sin existencia pide el PIN del dueño.
- Entradas de mercadería (con borrador) con proveedor y factura opcionales, último costo y precio nuevo (con confirmación), comprobante impreso y etiquetas.
- Ajuste manual con motivo de una lista configurable y PIN; conteo físico por departamento que se guarda a medias, anota la hora de cada producto contado y respeta lo vendido después de contarlo.
- Lista con estado (sin control, con existencia, bajo mínimo, agotado, negativo) y filtros; kardex por fechas; aviso discreto al dueño en el menú; existencia opcional en la tarjeta de la venta.
- Reportes (dueño): bajo mínimo con cantidad sugerida, inventario valorizado y movimientos; CSV sin fórmulas y PDF.
- Carga inicial: conteo por departamento o CSV (código o id, existencia, costo) con vista previa y todo o nada.

### 4.10 Apartados y crédito (fase 3, `cuentas.rs`, migración 21)
- **Apartado**: en la venta, **F9** (pide el cliente con consentimiento si no hay) → abono (viene el mínimo, `abono_minimo_pct`) y **"Qué se aparta"** opcional (`cuentas.descripcion`, migración 22, hasta 200 letras; ej. "Retablo de graduada", "Taza sublimada") → el cobro de siempre. La descripción sale en el comprobante, en las listas y se puede buscar con F10. Sirve también para pedidos por encargo (sublimados): se aparta con abono y se cobra el resto al entregar. Las unidades quedan **reservadas** (no salen del kardex); venderlas pide el PIN del dueño aunque se permita vender sin existencia. Comprobante con número `A-0001`, saldo, fecha límite, condiciones y la línea del aviso de privacidad.
- **F10** (botón "Abonar apartado" en la barra de la venta y "¿Viene a pagar un apartado?" con la venta vacía): buscar por número, nombre, teléfono, cédula o descripción; abonar (mixto, con vuelto en efectivo). El abono que deja el saldo en 0 **liquida**: se crea una venta normal con las líneas y precios del apartado (no los del catálogo de hoy), sin pagos por lo ya abonado (`ventas.cuenta_id`); ahí sale del inventario. "Se lleva los productos" → entregado; si no, queda pagado y se entrega después.
- **Cada abono es dinero del turno donde se recibe** (su fecha de negocio sale del turno, incluida la caja tardía) y la venta entra al Z el día que se liquida: ningún colón se cuenta dos veces. Sin turno abierto no se abona. Un doble clic no crea dos abonos (`operacion_id`). La gaveta abre una vez por abono en efectivo (`gaveta_abono`).
- **Z**: sección "Apartados y crédito": abonos por forma de pago (dinero), ventas pagadas con abonos o a crédito, apartados nuevos, liquidados y cancelados (devuelto y retenido), abonos anulados y condonado. El efectivo esperado suma el efectivo neto de los abonos.
- **Dueño** (menú Apartados): abiertos, vencidos (aviso en el menú, sin acción automática), pagados sin entregar, cerrados y crédito. Cancelar (PIN, motivo, cuánto se devuelve y cuánto de eso en efectivo; el resto queda retenido), ajustar el saldo, condonar, anular un abono (en su turno abierto sale del esperado; de un turno cerrado, el Z viejo no cambia y la devolución sale hoy), prorrogar y límite de crédito. Opciones: mínimo, plazo (calendario o días de trabajo), política de cancelación (`devolver` o `retener` con %) y condiciones.
- **Crédito** (`usa_credito`, Chaguí no; lo activa el técnico en Configuración técnica → editor de claves, no el dueño: `config.rs::permiso_de`): en el cobro, "Dejar … a crédito" con cliente; Rust revisa el límite (del cliente o `credito_limite_defecto`) y al cajero solo le dice si alcanza. La venta se reconoce al crearla.
- Ley 8968: cliente con consentimiento; el límite y los pagos solo los ve el dueño y no van a la bitácora; no se anonimiza con saldo ni con un apartado pagado sin entregar.
- Pendiente de diseño, apagado: "saldo a favor" al cancelar. Una venta que liquida un apartado no se anula desde Ventas del día (se corrige en Apartados); una venta a crédito sin abonos sí, y cancela su cuenta.

### 4.11 Reportes de ventas (fase 5, `reportes.rs`, solo el dueño: permiso `reportes.ventas`)
- **Menú a la izquierda agrupado** como el del POS anterior: Ventas (Resumen, Por día, Por hora, Departamentos, Productos, Formas de pago, Usuarios) · Caja y control (Cierres de caja, Anulaciones y diferencias, Apartados y crédito) · Ganancia (Utilidad bruta) · Inventario (Existencias y movimientos, Lista de precios).
- **Resumen**: cifras grandes con su variación en texto e icono; **"Comparar con: Período anterior / Año pasado"** (año pasado = mismas fechas, 19 nov vs 19 nov; 29 feb → 28; Rust `mismo_periodo_anio_pasado`, campos `anio*` y `porDiaAnio` del `Reporte`). Gráfico de todos los días del rango (por mes si pasa de 62 días; por hora si es un solo día) con la barra del año pasado detrás. Vistazo de los 5 primeros departamentos, productos y formas de pago con "Ver todo". Lo que casi siempre es ¢0 va en una fila chica y solo si tiene monto. Sin ventas del POS viejo importadas: la comparación con el año pasado empieza a tener datos en nov. 2027.
- Por rango de **fecha de negocio** con atajos (Hoy = día de negocio actual, Ayer, Esta semana, Este mes, Mes anterior): resumen, por día, departamento (mismo reparto que el Z), producto (más y menos vendidos), usuario, forma de pago (ventas y abonos), hora real del cobro, anulaciones y control (descuentos, ventas después del cierre, diferencias de apertura y cierre), por cobrar (antigüedad) y utilidad bruta (solo con costo; las ventas guardan su costo desde la migración 21, las viejas usan el costo actual y salen "aprox.").
- **Suma de un reporte = suma de los cierres Z** de esas fechas: la regla "como al cerrar" (`VENTA_EN_SU_Z`) cuenta una venta en su turno si está completada o si se anuló en otro turno; esa anulación se resta el día del turno donde se anuló. Cada turno se compara con su Z congelado y, si no coincide, la pantalla lo avisa. Los turnos abiertos van aparte ("en curso").
- Tablas ordenables y barras (por día y por hora) con su tabla. CSV (sin fórmulas, con tildes) y PDF carta en `Documentos\Punto de venta\Reportes\AAAA-MM`. Un mes entre 50.000 ventas: menos de 2 s (prueba).
- **Cierres de caja**: el historial de turnos (antes en Caja → Turnos) vive aquí, con el mismo detalle, reimpresión, revisión, reapertura y corrección de día. Cada día es un encabezado propio ("Viernes 13 de noviembre · 3 cajas · 9 ventas", "Vendido ¢X" y botón **"Resumen del día"** que abre el Resumen solo de esa fecha); debajo sus cajas con quién abrió/cerró y a qué hora, ventas, total, **efectivo contado** y si "Cuadró / Faltó ¢X / Sobró ¢X", y "Ver ›". El efectivo contado no se suma por día (el fondo que pasa de una caja a otra se contaría dos veces). Si al abrir un cierre falta el estado de la caja, se pide de nuevo y el error se muestra.
- **Inventario y Lista de precios** dentro de Reportes: reutiliza los reportes de Inventario (los movimientos ahora se ven en tabla, hasta 300; el archivo lleva todos) y una lista de precios (código, producto, departamento, precio) ordenable y exportable.
- "Ventas del día" (menú) y Reportes → Por día cubren las transacciones del día; no se duplicó otro reporte.

### 4.9 Seguridad y datos
- Base cifrada (SQLCipher) con la clave guardada en Windows DPAPI.
- **Respaldo cifrado** AES-256-GCM con contraseña, en `%APPDATA%\PuntoDeVenta-Datos\respaldos`, y restauración. El respaldo lleva la versión y la migración (`POSBAK02`); al restaurar uno viejo se pone al día con las migraciones y se verifica (integridad y bitácora) antes de reemplazar nada. Un respaldo de una versión más nueva se rechaza. No se restaura ni se actualiza con la caja abierta. `tests/fixtures` guarda un respaldo de cada versión.
- **Bitácora** de acciones sensibles, solo para agregar y encadenada con hashes. Se verifica al cerrar la caja y no guarda datos personales. Pantalla para el dueño (Administración → Bitácora) con frases simples; el técnico ve el detalle crudo.
- Triggers que impiden cambiar los pagos y el conteo de turnos cerrados.
- App cerrada: estricta, sin acceso a internet, sin DevTools en la versión final y sin fórmulas en los CSV.
- **Datos fuera del alcance del desinstalador**: `%APPDATA%\PuntoDeVenta-Datos` (constante `CARPETA_DATOS`). Las versiones viejas usaban `%APPDATA%\cr.puntodeventa.pos`; se trasladan solas. **NO CAMBIAR** el `identifier` (`cr.puntodeventa.pos`): `build.rs` frena el build.
- **Respaldo automático** diario y al cerrar cada turno, verificado, con rotación (30) y recordatorio semanal de USB. **Restaurar desde respaldo** en la pantalla de error cuando la base no abre (nunca se crea una base vacía encima de una instalación).
- **Una sola instancia**, reloj revisado al abrir/cobrar/cerrar (con salida para el técnico: `reloj_ignorar_hasta`), registro local `errores.log` y «Exportar diagnóstico» (técnico). «Preparar para el cliente» (técnico) revisa que la instalación esté lista.

## 5. Fases

| Fase | Contenido | Estado |
|---|---|---|
| 0. Prototipo de hardware | Lector, POS-58, code pages, gaveta; elegir Tauri | ✅ Hecho |
| 1. Base | Base de datos, roles, datos del negocio, catálogo, importación CSV, códigos internos, etiquetas | ✅ Hecho |
| 2. Venta y caja | Venta, cobro mixto, espera, tiquete, caja, cierre Z, gaveta, impresoras, turno compartido, varios turnos, pendientes de factura, seguridad | ✅ Hecho |
| 3. Apartados y créditos | Apartados con abonos (Chaguí) y crédito (otros negocios), según banderas por negocio | ✅ Código hecho (2026-11-19); falta la prueba manual en la PC real (PRUEBAS-MANUALES T) |
| 4. Inventario | Existencias, entradas de mercadería, ajustes con motivo, mínimos y alertas, venta sin stock configurable; además: `bd_leer` cerrado y respaldos compatibles entre versiones | ✅ Hecho |
| 5. Reportes | Ventas por día, departamento, producto y usuario; stock bajo; inventario valorizado; exportar PDF/CSV | ✅ Código hecho (2026-11-19); falta la prueba manual en la PC real (PRUEBAS-MANUALES U) |
| 6. Entrega | Pruebas manuales en la PC real, instalador, respaldo configurado, capacitación, instalación final | ⏳ Incluido en el contrato |

**Versión actual: 0.9.0 (versión de prueba en el negocio)**, migraciones 1 a 22. Pasó la auditoría de salida: datos que sobreviven instalar/desinstalar/actualizar, invariantes con pruebas (dinero, consecutivo, efectivo esperado, kardex, Z), tabla de permisos comando × rol probada (SEGURIDAD.md), recuperación y respaldo automático. Para instalarla: PRUEBAS-MANUALES «Aceptación de la versión de prueba»; para pasar a 1.0.0: ACTUALIZAR.md; hashes de cada entrega: ENTREGAS.md.

### Cambios del 2026-11-20 (pedidos del dueño tras usarlo)
- Migración 22: `cuentas.descripcion` (qué se aparta). Rust `crear_apartado_con` (la app); `crear_apartado` sin descripción solo existe en pruebas (`#[cfg(test)]`).
- Reportes rediseñados (4.11): menú agrupado, comparación contra el año pasado, gráfico con todos los días, vistazo de lo más vendido, inventario y lista de precios. Revisado a 1024, 1366 y 1920 px (los nombres largos del menú bajan de línea).
- Cierres de caja más claros para usuarios poco técnicos (4.11): día como encabezado, efectivo contado y cuadre en palabras, "Resumen del día".
- Venta: Cobrar siempre al pie aunque la venta esté vacía; botones visibles para cobrar un apartado (4.10).
- Caja y cierre: texto de la hora de cierre corregido (la hora real, no "un poco antes") y "Aplicar a todos" (4.7).
- Pendiente: verlo todo en la app real (los cambios visuales se revisaron con una página de prueba con el CSS real, tema oscuro) y en tema claro.

### Cambios del 2026-11-19 (fases 3 y 5)
- Migración 21: apartados y crédito (columnas en `cuentas`, `cuenta_lineas` y `abonos`; `cuenta_eventos` solo-agregar; `cajas.cuenta_siguiente`; `clientes.limite_credito`), costo por línea vendida (`venta_lineas.costo_unitario`) e índices de reportes.
- Apartados y crédito (4.10), reportes de ventas e historial de cierres en Reportes (4.11). Diseño: DISENO-FASE3.md y DISENO-FASE5.md.
- `ui/Modal` con `<dialog>` nativo; avisos en popover. Enter y flechas pasan de casilla en los diálogos de la venta (`ui/teclado.ts`).
- Tipos de TS generados (ts-rs), pruebas espejo con casos compartidos y prueba de punta a punta (WebdriverIO + tauri-driver).

### Cambios desde el 2026-11-08
- Migración 12: control de inventario de productos nuevos según su código de barras.
- Migración 13: hora de cada producto contado en el conteo físico.
- Migraciones 14 y 15: descuento fijo por producto y su registro por línea vendida (separado en el Z).
- Migraciones 16 y 17: SINPE Móvil anota el nombre de quien paga (columna `venta_pagos.pagador`).
- Migración 18: apertura de gaveta al cerrar la caja (causa `cierre`).
- Migración 20: días laborables (`caja_horario`, con los valores de Chaguí) y `caja_turnos.no_laborable`. Reloj inyectable en Rust (`util::ahora`).
- Migración 19: apertura de cada turno (`apertura_caso`, `apertura_esperada`, `diferencia_apertura`) y `queda_en_gaveta`; conteo de apertura bloqueado (trigger).
- Regla de fechas de los turnos (sección 4.3): hora de cierre del negocio (`caja_hora_cierre`, `caja_hora_cierre_dia`), pregunta hoy/mañana, corrección del dueño, "Ventas después del cierre", historial por día, ventas agrupadas por el día de su turno. Orden de campos en SINPE (referencia, banco, nombre).
- Pantalla de bitácora para el dueño; impresoras solo las configura el técnico.
- Validaciones: nombres únicos, comprobante de pago repetido, movimientos de efectivo grandes, vuelto grande, ajuste de redondeo al corregir un pago, gastos olvidados de turnos anteriores.
- PDF del Z con detalle de transacciones; mejoras en la pantalla de conteo y en los mensajes de restaurar respaldo.

## 6. Lo que falta

### Incluido en el contrato (no es opcional)
1. **Prueba manual de apartados y reportes en la PC real** (PRUEBAS-MANUALES T y U). El dueño de Chaguí define las condiciones del apartado y la política de cancelación (Apartados → Opciones). Confirmar con el contador si los abonos necesitan comprobante propio (hoy la venta pasa a "Pendientes de factura" al liquidar).
2. **Leer la versión de WebView2 en la PC de Chaguí** («Preparar para el cliente» la muestra; mínimo 120).
3. **Entrega (fase 6):** aceptación de la 0.9.0 en la PC real (`PRUEBAS-MANUALES.md`), uso de prueba, instalador, respaldo configurado, capacitación y versión 1.0.0.

### Deuda técnica o seguridad (de SEGURIDAD.md)
4. Firmar el instalador (requiere certificado; mientras tanto, documentar el SHA-256 de cada entrega en ENTREGAS.md).
5. Permisos por rol editables desde Configuración técnica.

### Casos conocidos (aceptados)
- Una caja del día que nunca se cerró sigue bloqueando la venta pasada la medianoche hasta cerrarla (no aplica al turno abierto tras el cierre, que ya cuenta para el día siguiente).
- Si se vuelve a una versión anterior con un respaldo que trae un turno "para mañana" abierto, esa versión no deja vender en él hasta el día siguiente.

### Fuera del contrato (módulos aparte, se cotizan por separado)
- Factura electrónica de Hacienda (se evaluará con el SDK hacienda-cr en sandbox).
- Sincronización con la nube o varias cajas en red (el módulo existe, apagado).
- Crédito (fiado) para Chaguí: no lo usa; para los otros negocios se activa por configuración.

## 7. Reglas del proyecto (para proponer cambios)
- Vender es lo primero: nada de menús ni diálogos innecesarios en la venta.
- Textos cortos, en español de Costa Rica.
- Lo que cambia entre negocios va en configuración, no en código (pensar siempre en Chagui y también en floristerías, tiendas de peluches, etc.).
- Nada se pierde: las ventas en espera se guardan siempre y la venta queda guardada aunque falle la impresión.
- Dinero y permisos se validan en Rust, con enteros y en una sola transacción.
- Lógica nueva de dinero, caja o inventario lleva su prueba (`cargo test` / `npm test`).
- Respaldos compatibles: una versión nueva tiene que poder restaurar los respaldos de todas las anteriores.
- Accesibilidad WCAG 2.1 AA: todo se puede usar con teclado y los botones miden 44 px o más.
