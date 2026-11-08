# Contexto del proyecto: Punto de Venta (POS) para Librería y Bazar Chagui

## 1. Qué es

App de escritorio para Windows, local y sin internet, para cobrar en negocios chicos de Costa Rica (librerías y floristerías).
- Cliente actual: Librería y Bazar Chagui. La idea es reutilizarla en 4 negocios: lo que cambia entre negocios es **configuración, no código** (departamentos, formas de pago, IVA, formato del tiquete).
- Hardware del mostrador: PC Windows, impresora térmica POS-58 (ESC/POS, 32 columnas, code page CP858), gaveta de dinero y lector de código de barras USB que funciona como teclado.
- Catálogo: unos 719 productos importados de la web, casi todos sin foto; códigos EAN/ISBN y códigos internos alfanuméricos (ej. "07toc").
- Montos: colones enteros, con punto de miles.
- No emite factura electrónica de Hacienda. Esa se hace en otro sistema; el POS solo lista las ventas que quedan "pendientes de factura".

## 2. Tecnología

- **Tauri v2** (Rust) + **React + TypeScript** (Vite) + **SQLite cifrado con SQLCipher**.
- Rust decide todo lo sensible: dinero, permisos, PIN, caja, impresión. La pantalla (React) solo muestra y pide.
- Todo el SQL está en `src/db` y en Rust. Las escrituras de catálogo pasan por `bd_lote` (operaciones con nombre) en una sola transacción. La lectura con SQL desde la pantalla (`bd_leer`) solo alcanza catálogo y configuración pública (lista blanca); todo lo demás va por comandos tipados.
- Migraciones numeradas en `src/db/migraciones` (van de la 0001 a la 0011). Nunca se edita una migración ya instalada.
- Pruebas: `npm test` (vitest con node:sqlite) y `cargo test` (Rust).

Carpetas principales:
```
src/db/          capa de datos (único lugar con SQL)
src/lib/         lógica pura: venta/, caja/, importar/, impresión ESC/POS, permisos
src/screens/     pantallas (venta/, caja/, clientes/, productos/, config/, hardware/)
src/ui/          componentes propios (Button, Modal, Field, Card, Alert…)
src-tauri/src/   Rust: ventas, caja, desglose (reparto del Z), usuarios, pin, impresoras,
                 escpos (lista blanca), gaveta, respaldo, bitacora, clientes, importacion,
                 inventario
tests/           pruebas vitest
```

## 3. Usuarios y roles

| Rol | Qué hace |
|---|---|
| **Cajero** | Vende, abre y cierra caja, busca o crea clientes (solo nombre, teléfono y cédula), ve los pendientes de factura. **No ve totales de ventas** mientras el turno está abierto. |
| **Dueño** | Hace todo lo del cajero, más productos, precios, departamentos, usuarios, datos del negocio, clientes completos, reportes, respaldo, impresoras, inventario (existencias, entradas, ajustes, conteos, costos, proveedores), anulaciones y reaperturas (con PIN). |
| **Técnico** | Configura la instalación (impresoras, formas de pago, ajustes técnicos). **No ve datos de clientes, no vende, no toca la caja ni el inventario.** |

Acceso: PIN con Argon2id, bloqueo progresivo si falla, cambio de PIN obligatorio la primera vez y sesión con vencimiento. El técnico entra con **Ctrl+Alt+T** en el login.

## 4. Funcionalidades terminadas

### 4.1 Venta (pantalla principal)
- Grilla de productos a la izquierda y tiquete a la derecha (estilo Alegra POS).
- Búsqueda por texto o código, lector de barras, `3*código` para 3 unidades.
- Productos favoritos como tarjetas. Filtro por departamento con píldoras de color.
- **Ventas en espera:** varias ventas abiertas a la vez en pestañas, que se guardan solas en la base en cada cambio.
- Precio libre (F4), venta por departamento (F6), cliente (F7), descuento al total (F8), cobrar (F12).
- Descuentos por línea o al total, en colones o porcentaje, con un tope por rol. Si se pasa del tope, pide el PIN del dueño.
- Redondeo del total (₡5 por defecto).
- **Cobro mixto:** efectivo, tarjeta, SINPE Móvil y transferencia, con banco y referencia. Calcula el vuelto.
- Consecutivo sin saltos ni repetidos (prefijo de la caja + número).
- IVA configurable. Chagui está en régimen simplificado y no lo muestra.
- Tiquete impreso con logo, una línea por pago, recibido y vuelto, y opción de COPIA.
- Si la impresora falla, la venta queda guardada para reimprimir.

### 4.2 Ventas del día y pendientes de factura
- Lista de las ventas del día, búsqueda y reimpresión.
- Anular una venta o cambiar su forma de pago: solo el dueño, con PIN y motivo.
- "Pendientes de factura": las ventas que hay que facturar en el sistema externo, para marcarlas como hechas.

### 4.3 Caja (turno, movimientos, cierre Z)
- Abrir caja con fondo inicial. Valida si la hora del equipo no cuadra.
- **Turno compartido** (activo por defecto): varios usuarios venden en el mismo turno y cada acción guarda quién la hizo. "Cambiar usuario" cierra la sesión sin cerrar el turno.
- Entradas y salidas de efectivo, y "da vuelto" con la caja abierta.
- **Corte** (dueño): ve lo acumulado y puede hacer un retiro con PIN.
- **Conteo ciego:** el cajero cuenta billete por billete sin saber cuánto debería haber. Al confirmar, el conteo queda bloqueado.
- **Cierre Z completo:** formas de pago, efectivo esperado contra contado, descuentos, anulaciones, aperturas sin venta, cortes, ventas por usuario y por departamento (reparto exacto), detalle de tarjeta, SINPE y transferencia, movimientos, conteo, firmas, estadísticas de control por usuario y lecturas del día, y registro del supervisor.
- Opciones al cerrar: detalle completo o un tiquete por departamento. PDF tamaño carta con logo para el dueño. Reimprimir sale como COPIA y pide el PIN del dueño.
- Solo el dueño reabre un turno (PIN y motivo).

### 4.4 Gaveta de dinero
- Solo se abre con una venta en efectivo (una vez), con una "No venta" con motivo o con una orden del dueño con PIN.
- Ningún otro trabajo de impresión puede abrirla: Rust filtra los comandos ESC/POS con una lista blanca.

### 4.5 Productos y catálogo
- Crear y editar productos, códigos de barras y códigos internos generados.
- Etiquetas con código de barras.
- **Importación CSV** desde la web, con reglas de categoría y palabras clave para asignar departamentos y favoritos, vista previa de errores y modo "todo o nada" o "solo las filas válidas". Se confirma con PIN y Rust valida todo de nuevo.
- Departamentos: nombre, orden, activo/inactivo y color (paleta de 12, con contraste de texto automático).

### 4.6 Clientes (Ley 8968 de protección de datos)
- Solo nombre y teléfono obligatorios. No se guarda un cliente sin su consentimiento, que queda con fecha y versión del aviso.
- El dueño puede ver todos los datos, corregirlos, exportarlos (PDF o CSV) y anonimizarlos (con PIN y motivo). Los clientes no se borran: se anonimizan.

### 4.7 Configuración
- Datos del negocio: nombre, cédula, régimen, dirección, logo, encabezado y pie del tiquete.
- Formas de pago y bancos.
- **Varias impresoras** (Windows, puerto serial o USB directo), de 58 u 80 mm, con code page, cortador y gaveta. Cada documento (tiquete, cierre, movimientos, etiquetas) va a la impresora que tenga asignada. Botón "Imprimir prueba".
- Usuarios: crear, editar y cambiar PIN.
- Opciones de caja y cierre, y ajustes técnicos.
- Tema claro u oscuro por equipo (contraste WCAG AA verificado con pruebas).
- Herramientas de hardware: prueba del lector, prueba de la impresora, vista previa sin hardware y diagnóstico.

### 4.8 Inventario (fase 4)
- Existencia por producto y sucursal en unidades enteras; mínimo y último costo (el costo solo lo ve el dueño). Los productos sin código de barras (servicios) y el precio libre no controlan inventario.
- Kardex solo-agregar: venta, anulación, entrada, ajuste e inventario inicial. La existencia se guarda en la misma transacción y siempre es la suma del kardex (trigger).
- Cobrar baja la existencia; anular la devuelve; la venta en espera no la toca. `permitir_vender_sin_existencia` (sí por defecto): si se apaga, vender sin existencia pide el PIN del dueño.
- Entradas de mercadería con proveedor y factura opcionales, último costo y precio nuevo (con confirmación), comprobante impreso y etiquetas.
- Ajuste manual con motivo de una lista configurable y PIN; conteo físico por departamento que se guarda a medias y aplica las diferencias.
- Lista con estado (sin control, con existencia, bajo mínimo, agotado, negativo) y filtros; kardex por fechas; aviso discreto al dueño en el menú; existencia opcional en la tarjeta de la venta.
- Reportes (dueño): bajo mínimo con cantidad sugerida, inventario valorizado y movimientos; CSV sin fórmulas y PDF.
- Carga inicial: conteo por departamento o CSV (código o id, existencia, costo) con vista previa y todo o nada.

### 4.9 Seguridad y datos
- Base cifrada (SQLCipher) con la clave guardada en Windows DPAPI.
- **Respaldo cifrado** AES-256-GCM con contraseña, guardado en Documentos\Respaldos POS, y restauración. El respaldo lleva la versión y la migración (`POSBAK02`); al restaurar uno viejo se pone al día con las migraciones y se verifica (integridad y bitácora) antes de reemplazar nada. No se restaura ni se actualiza con la caja abierta. `tests/fixtures` guarda un respaldo de cada versión.
- **Bitácora** de acciones sensibles, solo para agregar y encadenada con hashes. Se verifica al cerrar la caja y no guarda datos personales.
- Triggers que impiden cambiar los pagos de turnos cerrados.
- App cerrada: estricta, sin acceso a internet, sin DevTools en la versión final y sin fórmulas en los CSV.

## 5. Fases

| Fase | Contenido | Estado |
|---|---|---|
| 0. Prototipo de hardware | Lector, POS-58, code pages, gaveta; elegir Tauri | ✅ Hecho |
| 1. Base | Base de datos, roles, datos del negocio, catálogo, importación CSV, códigos internos, etiquetas | ✅ Hecho |
| 2. Venta y caja | Venta, cobro mixto, espera, tiquete, caja, cierre Z, gaveta, impresoras, turno compartido, pendientes de factura, seguridad | 🟡 Casi completa |
| 3. Apartados y créditos | Apartados con abonos (Chaguí) y crédito (otros negocios), según banderas por negocio | ⏳ Siguiente |
| 4. Inventario | Existencias, entradas de mercadería, ajustes con motivo, mínimos y alertas, venta sin stock configurable; además: `bd_leer` cerrado y respaldos compatibles entre versiones | ✅ Hecho (falta probar en la PC real: PRUEBAS-MANUALES O, P, Q) |
| 5. Reportes | Ventas por día, departamento, producto y usuario; stock bajo; inventario valorizado; exportar PDF/CSV | ⏳ Incluido en el contrato |
| 6. Entrega | Pruebas manuales en la PC real, instalador, respaldo configurado, capacitación, instalación final | ⏳ Incluido en el contrato |

**Último trabajo (commits recientes):** registro del supervisor y descarga de archivos, colores por departamento en la venta, validación de hora al abrir caja, "da vuelto" con la caja abierta, y estadísticas por usuario y lecturas del día en el Z.

## 6. Lo que falta

### Incluido en el contrato (no es opcional)
1. Apartados con abonos (fase 3). Las tablas `cuentas`, `cuenta_lineas`, `abonos` y `ventas.cuenta_id` ya existen.
2. Reportes (fase 5): ventas por día, departamento, producto y usuario. Los de inventario ya están (Inventario → Reportes).
3. Pruebas manuales con `PRUEBAS-MANUALES.md` y entrega (fase 6).

### Deuda técnica o seguridad (de SEGURIDAD.md)
4. Firmar el instalador (requiere certificado; mientras tanto, documentar el SHA-256 de cada entrega).
5. Permisos por rol editables desde Configuración técnica.

### Fuera del contrato (módulos aparte, se cotizan por separado)
- Factura electrónica de Hacienda (se evaluará con el SDK hacienda-cr en sandbox).
- Sincronización con la nube o varias cajas en red (el módulo existe, apagado).
- Crédito (fiado) para Chaguí: no lo usa; para los otros negocios se activa por configuración.

## 7. Reglas del proyecto (para proponer cambios)
- Vender es lo primero: nada de menús ni diálogos innecesarios en la venta.
- Textos cortos, en español de Costa Rica.
- Lo que cambia entre negocios va en configuración, no en código.
- Nada se pierde: las ventas en espera se guardan siempre y la venta queda guardada aunque falle la impresión.
- Dinero y permisos se validan en Rust, con enteros y en una sola transacción.
- Accesibilidad WCAG 2.1 AA: todo se puede usar con teclado y los botones miden 44 px o más.
