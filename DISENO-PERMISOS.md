# Diseño: permisos configurables y bloqueo por inactividad

_Borrador para aprobar antes de programar. 2026-11-23. Versión propuesta: 0.9.3, migración 25._

**Para qué:** que el dueño decida qué puede hacer cada cajero (por rol y por persona), con límites, sin abrir huecos;
y que el tiempo de bloqueo por inactividad se pueda ajustar sin poder apagarlo.
**Regla de oro:** con la plantilla «Normal», cada comando responde **exactamente igual que hoy** para cada rol.
Nada de esto agrega pasos a una venta normal.

---

## 0. Lo que encontré en el código (cambia el diseño)

| Hallazgo | Consecuencia |
|---|---|
| Hay 147 comandos en `generate_handler!` (lib.rs). Los permisos son 21 textos fijos (`permisos.rs`) revisados con `exigir` en ~110 lugares, más reglas de rol escritas a mano dentro de los módulos: `ve_totales` (caja.rs), `confirmar_dueno` exige rol dueño (anular, reabrir…), conteo ciego si es cajero, `puede_cerrar`, `administrables` (usuarios). | Todas pasan a una sola función. Las reglas a mano se vuelven acciones del catálogo. |
| Varios «topes» ya existen como claves de configuración sueltas: `descuento_max_pct` (por rol), `caja_salida_max_sin_pin`, `caja_no_venta_umbral`, `permitir_vender_sin_existencia`, `caja_quitar_linea_bitacora`. | Pasan a ser **límites de su acción** (una sola fuente). La migración los copia con su valor actual. Las claves viejas quedan sin uso y `config_guardar` las rechaza con «Se cambia en Permisos». |
| `bd_lote` (catálogo) usa el campo `permiso` de `sentencias.json`; `config_guardar` decide con `permiso_de(clave)`; `imprimir` decide por documento; `guardar_descarga` por carpeta. | Cada operación, clave, documento y carpeta se asigna a una acción. Lo que no tenga acción se niega. |
| **La sesión mide la inactividad con `Instant::now()`, no con el reloj inyectable**, y cualquier comando la renueva. | Pasa a `util::ahora()`. Solo renueva la actividad real (teclado, mouse, táctil) que informa la pantalla. |
| **Hoy vencer la sesión = cerrar sesión**: la pantalla vuelve a la entrada, desmonta todo y borra el borrador de la entrada de mercadería (`borrarBorradores`). Se pierde el conteo a medias, la entrada y los formularios abiertos. | Se cambia por un **bloqueo**: la sesión queda en Rust marcada como bloqueada y la pantalla queda montada detrás de un velo opaco. |
| `sesion_inactividad_min` acepta de 1 a 240 y cualquier rol con `config.tecnica` lo cambia sin PIN. | Pasa a la configuración de seguridad versionada (de 1 a 60, técnico hasta 15). |
| Del catálogo mínimo pedido, **no existen hoy**: «cambiar el precio de un producto en la venta» y «devolución» (parcial). Una venta que liquida un apartado o un crédito con abonos **no se anula desde Ventas del día ni siquiera el dueño** (se corrige en Apartados). | Ver decisión D1. Esas ventas siguen sin anularse ahí con cualquier política. |

---

## 1. Modelo

### 1.1 Acción y política
- **Acción**: un id corto (`venta.anular`) con área, nombre visible, si es **sensible** (dinero, caja, clientes o
  anulaciones) y qué límites admite. El catálogo vive en Rust (`acciones.rs`, una tabla constante) y TS lo recibe
  con tipos generados (ts-rs).
- **Política** de una acción para un rol o un usuario:

| Nivel | Significa |
|---|---|
| `no` | No permitido. |
| `si` | Permitido. |
| `motivo` | Permitido, con motivo obligatorio. |
| `pin` | Permitido con el PIN de un dueño en ese momento (y motivo si la acción lo pide). |

- **Límites** (solo los que la acción admite), con qué pasa al pasarse: `pedir PIN` o `bloquear`.
  - `monto_max` (colones), `pct_max` (descuento), `cantidad_turno` (veces por turno y por usuario),
    `solo_turno_abierto`, `solo_propias` (ventas que cobró él), `ventana_min` (minutos desde la venta, con `util::ahora()`).

### 1.2 Dónde se guarda (migración 25)
Una sola tabla, **solo agregar** (triggers contra `UPDATE`/`DELETE`, como la bitácora):

```
seguridad_versiones(id INTEGER PK, creada_en, creada_por, pin_dueno_de (id del dueño que confirmó o NULL),
                    plantilla (NULL si es a mano), motivo, datos TEXT JSON)
```
`datos` = toda la configuración de seguridad: política por rol, excepciones por usuario, motivos de anulación,
umbral del aviso y tiempos de inactividad. **Vigente = la de mayor id.** Volver a una versión = crear una nueva
con los datos de la vieja (el historial nunca se reescribe). Cada comando lee la vigente **dentro de su
transacción** (un `SELECT` de una fila): un cambio aplica en el siguiente comando, sin caché que invalidar.

Al abrir la base, si no hay ninguna versión (instalación existente o respaldo viejo restaurado), Rust crea la
**versión 1 = plantilla Normal** con los topes copiados de las claves viejas y el tiempo de `sesion_inactividad_min`
(si alguien puso más de 60, queda en 60 y se anota en la bitácora).

### 1.3 Política efectiva: un solo lugar
`politica::efectiva(datos, actor, accion)`, en este orden:
1. **Reglas fijas** (sección 4.3): dueño → su fila fija; técnico + acción protegida → `no`; cajero + acción
   no delegable → `no`.
2. **Excepción del usuario** para esa acción, si existe.
3. **Política del rol.**
4. Si nada la define: **`no`** (se niega por defecto).

### 1.4 Cómo la aplica cada comando
- Todo comando con sesión empieza con `st.comando("venta.anular")` (reemplaza a `st.actor()` + `exigir`): revisa el
  bloqueo por inactividad, el cambio de PIN pendiente y que la política efectiva no sea `no`. Devuelve el actor y un
  **guardia de operación en curso** (ver 5.4).
- Las acciones con límites, motivo o PIN llaman además, **dentro de la misma transacción `BEGIN IMMEDIATE`**, a
  `politica::aplicar(&mut tx, actor, accion, ctx)`. `ctx` trae monto, turno, venta (dueña y hora), motivo y el PIN
  ya verificado. Devuelve qué se aplicó (nivel, versión, quién autorizó) y lo anota en la bitácora con la acción.
- El PIN se verifica antes de abrir la transacción (Argon2 es lento) con el mismo `autorizar_dueno` y su freno;
  la decisión de si hacía falta se toma adentro con los datos frescos (cantidad del turno, ventana de tiempo).
- Errores con código para la pantalla: `SIN_PERMISO`, `NECESITA_MOTIVO`, `NECESITA_PIN:<acción>:<por qué>` (la
  pantalla pide el PIN y repite), igual que hoy con `PIN_GAVETA`.

### 1.5 Ningún comando sin acción
- `acciones.rs` tiene `COMANDOS: &[(&str, Destino)]` con los 147 comandos (+ los nuevos). `Destino` es una acción,
  `SinSesion`, `CualquierSesion` o `SegunArgumento` (config, bd_lote, imprimir, guardar_descarga).
- Prueba `todo_comando_tiene_accion`: lee el `generate_handler![…]` de `lib.rs` con `include_str!` y falla si un
  comando no está en `COMANDOS` (o al revés). Otras pruebas igual para cada id de `sentencias.json`, cada documento
  de `imprimir`, cada carpeta de `guardar_descarga` y cada clave de `config::validar`.
- Una clave de config, una operación o un documento desconocido: se niega (hoy una clave desconocida cae en
  «técnico»; eso se mantiene como acción `config.tecnica`, que es una política, no un hueco).

---

## 2. Catálogo de acciones

Columnas: **Normal** = cajero / técnico (= hoy). El dueño tiene su fila fija (4.3). 🔒 = protegida (el técnico
nunca, Ley 8968 o dinero). Límites que admite entre corchetes.

### Venta
| Acción | Comandos | Normal C / T |
|---|---|---|
| `venta.vender` 🔒 | venta_esperas, venta_espera_crear, venta_espera_guardar, venta_faltantes, venta_referencia_usada, venta_cobrar, gaveta_venta | sí / no |
| `venta.descuento` 🔒 [pct_max] | venta_autorizar_descuento; revisado en cobrar, apartar y proforma | sí hasta 10 %, al pasar PIN / no |
| `venta.precio_libre` 🔒 | venta_espera_guardar (línea sin producto) | sí / no |
| `venta.sin_existencia` 🔒 | venta_cobrar | según `permitir_vender_sin_existencia`: sí, o PIN / no |
| `venta.apartadas` 🔒 | venta_cobrar (unidades reservadas) | PIN / no |
| `venta.quitar_linea` 🔒 [monto_max] | venta_espera_guardar | sí (la bitácora desde ¢5.000 sigue) / no |
| `venta.descartar_espera` 🔒 | venta_espera_descartar | sí / no |
| `venta.ver_existencia` 🔒 | inventario_existencia | según `venta_mostrar_existencia` / no |

### Ventas cobradas
| Acción | Comandos | Normal C / T |
|---|---|---|
| `ventas.ver` 🔒 | venta_obtener, venta_listar_dia, venta_listar_turno, venta_correcciones | sí / no |
| `ventas.reimprimir` 🔒 | venta_imprimir | sí / no |
| `ventas.anular` 🔒 [todos] | venta_anular | no / no |
| `ventas.cambiar_pago` 🔒 [monto_max, solo_turno_abierto] | venta_corregir_pago | no / no |
| `facturas.ver` 🔒 | venta_pendientes_factura, venta_pedir_factura, cliente_dato_factura, cliente_tiene_correo | sí / no |
| `facturas.marcar` 🔒 | venta_marcar_factura | sí / no |

### Caja
| Acción | Comandos | Normal C / T |
|---|---|---|
| `caja.ver` 🔒 | caja_estado, caja_detalle, caja_turnos, caja_necesita_nota | sí / no |
| `caja.abrir` 🔒 | caja_abrir, caja_queda | sí / no |
| `caja.cerrar` 🔒 | caja_cerrar, gaveta_cierre, caja_z, caja_z_imprimir (original), caja_nota_cierre | sí / no |
| `caja.cerrar_otro` 🔒 | caja_cerrar sobre un turno ajeno (sin turno compartido) | sí, solo si es de un día anterior (regla de hoy) / no |
| `caja.ver_totales` 🔒 | `ve_totales` (detalle, turnos, Z, necesita_nota) | no; darlo pide confirmar una advertencia / no |
| `caja.reabrir` 🔒 | caja_reabrir | no / no |
| `caja.entrada` 🔒 | caja_movimiento (entrada), imprimir (movimiento) | sí / no |
| `caja.salida` 🔒 [monto_max] | caja_movimiento (salida) | sí hasta ¢20.000, al pasar PIN / no |
| `caja.corte` 🔒 | caja_corte | no / no |
| `caja.no_venta` 🔒 [cantidad_turno] | gaveta_no_venta (motivo de la lista, como hoy) | sí, desde el umbral PIN / no |
| `caja.gaveta_sin_venta` 🔒 | gaveta_dueno | PIN / no |
| `caja.historial` 🔒 | caja_revisada, gaveta_aperturas, imprimir (cierre), Reportes → Cierres | no / no |
| `caja.reimprimir_z` 🔒 | caja_z_imprimir (COPIA) | PIN / no |
| `caja.corregir_dia` 🔒 | caja_corregir_dia | no / no |
| `caja.consecutivo` | caja_consecutivo | no / sí |
| `caja.opciones` | config_guardar (`caja_*`) | no / sí |

### Apartados y crédito
| Acción | Comandos | Normal C / T |
|---|---|---|
| `cuentas.crear` 🔒 | cuentas_reglas, cuenta_crear_apartado, cuenta_buscar, cuenta_obtener, cuenta_imprimir | sí / no |
| `cuentas.abonar` 🔒 | cuenta_abonar (y liquidar), cuenta_entregar, gaveta_abono | sí / no |
| `cuentas.ver_todas` 🔒 | cuenta_listar, cuenta_vencidas, cliente_estado_cuenta, imprimir (estado_cuenta) | no / no |
| `cuentas.cancelar` 🔒 [monto_max] | cuenta_cancelar | no / no |
| `cuentas.anular_abono` 🔒 [monto_max, solo_turno_abierto] | abono_anular | no / no |
| `cuentas.ajustar` 🔒 | cuenta_ajustar | no / no |
| `cuentas.condonar` 🔒 [monto_max] | cuenta_condonar | no / no |
| `cuentas.prorrogar` 🔒 | cuenta_prorrogar | no / no |
| `credito.vender` 🔒 | venta_cobrar a crédito, credito_disponible | sí / no |
| `credito.limite` 🔒 | cliente_limite_credito, cliente_limite_obtener | no / no |
| `cuentas.opciones` | credito_opciones, credito_guardar_opciones, config (`apartado_*`, `credito_*`, `abono_minimo_pct`) | no / sí (como hoy) |

### Proformas
| Acción | Comandos | Normal C / T |
|---|---|---|
| `proformas.crear` 🔒 | proforma_guardar, proforma_buscar, proforma_obtener, proforma_abrir, proforma_imprimir | sí / no |
| `proformas.convertir` 🔒 | venta_cobrar / cuenta_crear_apartado con proforma | sí / no |
| `proformas.anular` 🔒 | proforma_anular | no / no |
| `proformas.admin` 🔒 | proforma_reporte, config (`proforma_*`) | no / no (la config `proforma_*` sigue abierta al técnico, como hoy) |

### Productos e inventario
| Acción | Comandos | Normal C / T |
|---|---|---|
| `productos.crear` | bd_lote producto.crear, codigo.*, codigo_interno.* | no / sí |
| `productos.editar` | bd_lote producto.editar (sin cambiar precio) | no / sí |
| `productos.precio` | bd_lote producto.editar con precio distinto (Rust compara) | no / sí |
| `productos.desactivar` | bd_lote producto.eliminar | no / sí |
| `productos.favoritos` | bd_lote producto.favorito | no / sí |
| `productos.etiquetas` | imprimir (etiqueta) | no / sí |
| `productos.importar` | importacion_leer, importacion_aplicar | no / sí |
| `departamentos.editar` | bd_lote departamento.editar/color/orden, config de colores | no / sí |
| `departamentos.estructura` | bd_lote departamento.crear/cambiar_codigo | no / sí |
| `inventario.ver` 🔒 | inventario_lista, _estado, _alertas, _producto, _kardex | no / no |
| `inventario.entradas` 🔒 | inventario_entrada, _entrada_obtener, imprimir (entrada), proveedores_* | no / no |
| `inventario.ajustes` 🔒 | inventario_ajustar | no / no |
| `inventario.conteo` 🔒 | inventario_conteo_*, inventario_inicial | no / no |
| `inventario.costos` 🔒 | campos de costo en las listas y entradas | no / no |
| `inventario.reportes` 🔒 | inventario_reporte_* | no / no |
| `inventario.opciones` 🔒 | config (`inventario_*`, vender sin existencia, mostrar existencia) | no / no |

### Clientes y reportes
| Acción | Comandos | Normal C / T |
|---|---|---|
| `clientes.crear` 🔒 | cliente_crear, cliente_buscar, cliente_basico | sí / no |
| `clientes.ver_todos` 🔒 | cliente_listar, cliente_obtener, cliente_cuentas_saldo, cliente_retencion | no / no |
| `clientes.editar` 🔒 | cliente_editar | no / no |
| `clientes.exportar` 🔒 | cliente_exportar, guardar_descarga (Clientes) | no / no |
| `clientes.anonimizar` 🔒 | cliente_anonimizar | no / no |
| `reportes.ver` 🔒 | reporte_rangos, reporte_ventas | no / no |
| `reportes.exportar` 🔒 | guardar_descarga (Reportes) | no / no |

### Administración
| Acción | Comandos | Normal C / T |
|---|---|---|
| `usuarios.administrar` | usuarios_listar, _crear, _editar, _cambiar_pin (de otro), _eliminar | no / sí |
| `negocio.contacto` | negocio_guardar (contacto) | no / sí |
| `negocio.legal` | negocio_logo, negocio_guardar (legal) | no / sí |
| `pagos.formas` | bd_lote forma_pago.guardar, banco.guardar | no / sí |
| `impresoras.configurar` | impresoras_detectar, impresora_guardar, impresora_eliminar, list_printers, print_raw | no / sí |
| `impresoras.asignar` | impresoras_listar, impresora_asignar, impresora_probar | no / sí |
| `config.tecnica` | config_guardar (el resto de claves) | no / sí |
| `respaldo.crear` 🔒 | respaldo_crear, respaldo_ultimo, respaldo_auto_* , respaldo_usb_confirmado | no / no |
| `respaldo.restaurar` 🔒 | respaldo_restaurar | no / no |
| `bitacora.ver` | bitacora_listar, bitacora_verificar | no / sí |
| `seguridad.editar` | seguridad_* (nuevos) | **fijo** no / **fijo** sí |
| `seguridad.inactividad` | seguridad_inactividad (nuevo) | **fijo** no / **fijo** sí |
| `sistema.preparar` | sistema_preparacion, diagnostico_exportar | no / sí |

**Sin sesión** (lista cerrada, revisada en la prueba): sistema_estado, sistema_crear_tecnico (si no hay técnico),
sistema_restaurar (si la base no abre), diagnostico_anotar, app_reiniciar, sesion_usuarios, sesion_iniciar,
sesion_tecnico, sesion_actual, sesion_cerrar, sesion_tocar, y los nuevos sesion_estado y sesion_desbloquear.
**Cualquier sesión:** bd_leer (lista blanca de siempre), impresora_ajustes, config_guardar (tema),
usuarios_cambiar_pin (el propio), sesion_permisos (nuevo).

Nota: `caja.consecutivo`, `caja.opciones` y `config.tecnica` no son 🔒 porque hoy el técnico los tiene y no llevan
datos de clientes ni montos de ventas.

---

## 3. Anulación por el cajero

Es la acción `ventas.anular` con la fila del cajero. La pantalla de Permisos la muestra como tres opciones:

| Opción | Política del cajero |
|---|---|
| **A**: solo el dueño (hoy) | `no` |
| **B**: con PIN del dueño | `pin` + motivo |
| **C**: sin PIN, con controles | `motivo` + límites; al pasar cualquiera: PIN |

**Opción C**, todo en Rust dentro de la transacción de `ventas::anular`:
- **Motivo de una lista** (`motivos_anulacion` en la configuración de seguridad; por defecto: «Error de digitación»,
  «Cliente desistió», «Cobro duplicado», «Otro» → pide texto de 5 letras o más).
- **Límites** (cada uno opcional): `monto_max` (total de la venta), `cantidad_turno` (anulaciones sin PIN de ese
  cajero en el turno abierto), `solo_turno_abierto`, `ventana_min` (desde `ventas.fecha`). Pasar uno → `NECESITA_PIN`
  con el motivo en palabras («La venta pasa de ¢10.000»).
- **Siempre con PIN, aunque cumpla los límites** (regla fija de la acción, no configurable): venta de un turno
  cerrado, venta marcada como facturada, devolución en efectivo mayor que `monto_max`.
- **Ventas que liquidan un apartado o créditos con abonos:** hoy no se anulan desde Ventas del día con ningún rol
  («Corríjalo en Apartados»). Se mantiene así en A, B y C.
- **Comprobante de anulación** (documento nuevo `anulacion`, impresora de tiquetes): número de tiquete, monto, motivo,
  usuario, fecha y hora real (de Rust), línea para la firma del cajero, «Guardar con el cierre». Si la impresora falla,
  la anulación ya quedó; se reimprime como COPIA desde Ventas del día.
- **Z**: sección nueva «Anulaciones por cajero sin PIN» (tiquete, monto, motivo, usuario), aparte de las del dueño o con PIN.
  Igual en papel, PDF y pantalla.
- **Aviso al dueño**: al entrar, «Hubo N anulaciones sin PIN» con enlace a Reportes → Anulaciones. N = las de la
  bitácora desde el último «visto» de cualquier dueño (se anota `aviso.anulaciones_visto`; sin tabla nueva). Si un día
  pasa `umbral_aviso_anulaciones` (por defecto 3), ese día sale marcado en Cierres de caja (calculado al leer).
- **Bitácora** en las tres opciones: `venta.anular` con `politica: "A"|"B"|"C"`, `version`, `autorizo` (id del dueño
  o del cajero) y el límite que pidió PIN, si hubo.
- **Columnas nuevas en `ventas`** (migración 25): `anulada_actor` (quién la hizo) y `anulada_politica`. `anulada_por`
  sigue siendo quien autorizó (el dueño, o el mismo cajero en C).
- Dinero, inventario y Z: el mismo código de hoy en las tres opciones (solo cambia quién autoriza). Factura emitida →
  el aviso de nota de crédito que ya existe.

---

## 4. Quién edita y reglas que nadie rompe

### 4.1 Pantalla «Permisos» (Administración)
- Pestañas: **Por rol** (matriz acciones × cajero/técnico, agrupada por área, con buscador; la columna del dueño
  se ve fija), **Por usuario** (excepciones de un cajero; solo las acciones que difieren de su rol), **Bloqueo**
  (sección 5), **Historial** (versiones: quién, cuándo, qué cambió; «Volver a esta versión»).
- Cada celda: un selector con los cuatro niveles y, si la acción los admite, los límites. Debajo, en lenguaje simple,
  qué significa: «El cajero podrá anular ventas de hasta ¢10.000 sin PIN, 3 por turno, dentro de 30 minutos».
- Los cambios se juntan y se guardan de una vez (una versión por guardado), con una lista de diferencias antes de
  confirmar. Si alguno da más permisos sobre algo sensible, la confirmación pide además el PIN del dueño.
- **Plantillas**: Estricto (todo lo sensible con PIN: descuento 0 %, salida ¢0, no venta con PIN), Normal (= hoy) y
  Flexible (anular C hasta ¢10.000, 3 por turno, 30 min; descuento 15 %; salida hasta ¢30.000). Al elegir: lista de
  diferencias y confirmar (con PIN si da más permisos).
- **Imprimir / PDF** de la tabla vigente (carta, con versión, fecha, línea para la firma del dueño). Se arma con el
  PDF de los reportes.

### 4.2 Quién guarda y cuándo hace falta el PIN del dueño
- Editan el dueño y el técnico (`seguridad.editar`, fijo). Rust recibe la propuesta completa
  (`seguridad_guardar(datos, motivo, pin?)`), la valida y la compara con la vigente.
- `mas_permisivo(vieja, nueva)` (Rust, con su prueba): para cada rol/usuario y cada acción sensible, nivel
  `no < pin < motivo < si`, quitar el motivo del PIN, subir o quitar un límite, o cambiar «al pasar» de bloquear a PIN.
  También subir la inactividad por encima de 10 min. Si da `true` y no vino un PIN de dueño válido → `NECESITA_PIN`.
- Volver a una versión anterior: siempre con PIN del dueño.

### 4.3 Reglas fijas (Rust las aplica al validar y al calcular; la pantalla las muestra deshabilitadas)
1. **El dueño siempre tiene todo.** Su fila es fija y es la de hoy (incluido el PIN propio donde hoy se pide: anular,
   reabrir, corregir pago, reimprimir Z, anonimizar, restaurar…). No tiene excepciones.
2. **Siempre al menos un dueño activo con PIN**: `usuarios_editar`/`usuarios_eliminar` lo rechazan (revisar que ya
   esté y agregar prueba).
3. **Nadie se quita el permiso de editar permisos siendo el último**: se cumple solo porque `seguridad.editar` es fijo
   para dueño y técnico; queda igual la validación y su prueba.
4. **La bitácora no se apaga ni se edita**: no hay acción para eso; `bitacora.ver` solo lee.
5. **El técnico nunca tiene una acción 🔒**, aunque venga en los datos (Ley 8968 y dinero). Rust rechaza la versión.
6. **El cajero nunca** tiene `seguridad.editar` ni `seguridad.inactividad` (ni por excepción).
7. **`caja.ver_totales` para el cajero** solo se guarda con `confirmo_advertencia: true`; la pantalla muestra:
   «El cajero va a ver cuánto se ha vendido en el turno. Así puede dejar de registrar ventas sin que se note en el cierre.»
8. **El bloqueo por inactividad no se desactiva** (sección 5).
9. Excepciones por usuario: solo para usuarios con rol cajero (el dueño es fijo; el técnico es uno solo y usa su fila).

### 4.4 Aplicar de inmediato
`seguridad_guardar` emite el evento `seguridad-cambiada` (ya permitido: `core:event:default`). La pantalla vuelve a
pedir `sesion_permisos` (la política efectiva del usuario: acción → nivel y límites) y redibuja sin cerrar sesión.
Rust no necesita avisar: lee la versión vigente en cada comando.

`src/lib/permisos.ts` (la copia de la tabla) **se borra**: la pantalla usa lo que dice `sesion_permisos`.

---

## 5. Bloqueo por inactividad

### 5.1 Configuración (dentro de la configuración de seguridad, versionada)
`inactividad: { general: 10, cajero?: n, dueno?: n, tecnico?: n }`. Rol sin valor → general.
- Rango 1 a 60 (enteros). No existe 0 ni «nunca»: `validar` lo rechaza.
- Técnico: máximo 15. Si el general pasa de 15, el técnico usa 15.
- Bajar: sin PIN. Subir un valor por encima de 10: PIN del dueño (misma regla que 4.2).
- La pantalla dice: «Si nadie toca la caja por 10 minutos, se pide el PIN otra vez.»
- Se edita en **Configuración técnica → Bloqueo por inactividad** y en la pestaña Bloqueo de Permisos (mismo
  componente). Bitácora: valor anterior, nuevo y si hubo PIN del dueño.
- «Preparar para el cliente» muestra el tiempo vigente por rol para que el dueño lo confirme.

### 5.2 Rust decide (sesion.rs)
```
Activa { actor, ultimo: DateTime (util::ahora), minutos, bloqueada: bool, en_curso: u32 }
```
- `sesion_tocar`: la pantalla informa teclado (incluye el lector), mouse o táctil, cada 10 s como mucho. Solo eso
  renueva `ultimo`. **Los comandos ya no la renuevan** (un recargado automático no debe mantener viva la sesión).
- Al empezar cada comando: si `bloqueada` → `SESION_BLOQUEADA`. Si `ahora − ultimo ≥ minutos` y `en_curso == 0`
  → se marca bloqueada y `SESION_BLOQUEADA`. Si la pantalla deja de informar, el siguiente comando choca igual.
- `sesion_estado` (sin renovar): `{ bloqueada, restanteMs }` para que la pantalla programe el aviso y el velo.
- Los minutos se recalculan al guardar una versión nueva: aplica de inmediato a la sesión abierta.

### 5.3 Desbloquear sin perder trabajo
- Bloquear **no cierra el turno ni la sesión**: la pantalla queda montada detrás de un velo opaco a pantalla completa
  (`inert` en el resto, foco en el PIN, sin nada visible del fondo).
- Velo: la lista de usuarios con el de la sesión primero. `sesion_desbloquear(usuario_id, pin)`:
  - **Mismo usuario** → se quita el bloqueo; sigue donde estaba (venta en espera, conteo de caja a medias, entrada de
    mercadería, proforma y cualquier formulario abierto siguen en la memoria de la ventana).
  - **Otro usuario** → la sesión anterior se descarta en Rust y la pantalla se desmonta y vuelve a montar con el
    nuevo (borra el borrador de la entrada y todo lo que estaba en memoria). Ve solo lo que su rol permite. Las ventas
    en espera de la caja siguen en la base, como hoy al «Cambiar usuario».
  - Mismo freno de PIN y bitácora que el inicio de sesión (`sesion.bloqueo`, `sesion.desbloqueo`).
- Un cambio de PIN pendiente sigue mandando sobre todo.

### 5.4 No interrumpir un cobro o una impresión
- `st.comando(...)` devuelve un guardia que suma `en_curso` y resta al terminar (también si falla). Mientras
  `en_curso > 0` no se bloquea; al terminar, el siguiente comando bloquea si ya venció.
- La pantalla no muestra el velo mientras tiene un trabajo en marcha (cobro, impresión, cierre); lo muestra apenas
  termina. Si el bloqueo llega entre el cobro y la impresión, la venta ya está guardada: se reimprime al volver.

### 5.5 Aviso de 1 minuto
Popover discreto arriba: «Se bloquea en 1 minuto por inactividad», `role="status"`. Cualquier tecla o toque lo
cierra (y eso mismo es actividad). Con un tiempo de 1 minuto, el aviso sale a los 30 s.

---

## 6. Datos, migración y compatibilidad

- **Migración 0025** (solo agrega): `seguridad_versiones` + triggers solo-agregar; `ventas.anulada_actor`,
  `ventas.anulada_politica`. Nada se borra.
- **Versión 1** creada por Rust al abrir (1.2), reproduce lo de hoy. Prueba `normal_responde_igual_que_antes`: la
  `tabla_permisos.rs` actual (comando × rol) se corre **sin cambiar una fila** sobre una base recién migrada.
- **Respaldo**: fixture nuevo `respaldo-v0.9.3-m25.posbak`; los anteriores se restauran, migran y reciben la versión 1.
- `config_guardar` rechaza las claves que pasaron a la seguridad (`descuento_max_pct`, `caja_salida_max_sin_pin`,
  `caja_no_venta_umbral`, `permitir_vender_sin_existencia`, `caja_quitar_linea_bitacora`, `sesion_inactividad_min`)
  con «Esto se cambia en Permisos». Las pantallas que las editaban (Caja y cierre, Inventario) llevan un enlace.
- Tipos de TS con ts-rs: `Accion`, `Politica`, `Limites`, `DatosSeguridad`, `PermisoEfectivo`, `CambioSeguridad`.

---

## 7. Pruebas

**Rust**
- `todo_comando_tiene_accion` (+ ops de `sentencias.json`, documentos, carpetas, claves de config).
- `cada_comando_cada_rol_cada_politica`: para cada acción delegable, se pone la fila del cajero (y la del técnico si
  no es 🔒) en `no`, `si`, `motivo` y `pin`, y se llama el comando directo: `SIN_PERMISO` / pasa / `NECESITA_MOTIVO`
  sin motivo / `NECESITA_PIN` sin PIN y pasa con PIN. El dueño, siempre igual a su fila fija.
- `normal_responde_igual_que_antes` (tabla actual sin cambios).
- Excepciones: Fabricio anula sin PIN, Ana no; las demás acciones de Fabricio siguen las del rol.
- Anulación C: cada límite (monto, cantidad, turno cerrado, ventana, facturada) pide PIN; «bloquear» bloquea; apartado
  y crédito con abonos se rechazan; bitácora con política, versión y autorizó; sección del Z; conteo del aviso.
- Reglas fijas: sin dueño activo, técnico con 🔒, cajero con `seguridad.*`, `caja.ver_totales` sin advertencia, bitácora.
- `mas_permisivo` por cada tipo de cambio; sin PIN se rechaza, con PIN pasa; bajar no lo pide.
- Historial: volver a una versión crea otra nueva; los triggers impiden editar o borrar versiones.
- Inactividad con `util::fijar_reloj`: bloquea justo al vencer (general y por rol); 0, 61, `"nunca"` y técnico 16 se
  rechazan; subir de 10 sin PIN no; bloqueada no ejecuta ningún comando; `en_curso` evita bloquear a la mitad;
  desbloquear el mismo usuario sigue, otro usuario reemplaza; el cambio aplica en el siguiente comando y queda en bitácora.

**TS (vitest)**
- Espejo: `tests/casos/permisos.json` con casos (política, contexto) → qué se muestra (oculto / normal / «pide PIN»);
  Rust y TS leen el mismo archivo.
- Frases simples de cada política y límite.
- Velo y aviso: el aviso aparece al faltar 1 min y una tecla lo cierra; con otro usuario se desmonta el árbol.

**e2e** (WebdriverIO, reloj fijo)
1. Dueño elige opción C (hasta ¢10.000) con PIN → cajero anula una venta de ¢2.000 sin PIN (sale el comprobante) →
   intenta una de ¢15.000 y se le pide PIN → cierre Z con la sección → el dueño entra y ve «Hubo 1 anulación sin PIN».
2. Tiempo en 1 min → venta en espera con 2 productos → se adelanta el reloj de prueba → velo → mismo PIN → la venta en
   espera sigue ahí.
   Para adelantar el reloj en la e2e hace falta un comando solo de desarrollo (`prueba_avanzar_reloj`, solo con
   `POS_E2E=1`, igual que la semilla).

---

## 8. Plan de trabajo (después de aprobar)

1. `acciones.rs` + `politica.rs` + migración 25 + versión 1. Pasar los 147 comandos a `st.comando(...)` sin cambiar
   comportamiento → la tabla actual pasa igual.
2. Límites y PIN dentro de las transacciones (descuento, salida, no venta, sin existencia, anular…); quitar las claves viejas.
3. Sesión con reloj inyectable, bloqueo, desbloqueo y aviso.
4. Pantalla Permisos, plantillas, historial, PDF; Bloqueo en Configuración técnica; Preparar para el cliente.
5. Anulación C: comprobante, Z, aviso.
6. Pruebas, documentos (SEGURIDAD, CONTEXTO, PRUEBAS-MANUALES), fixture, versión, ENTREGAS, instalador y SHA-256.

---

## 9. Decisiones que necesito de usted

| # | Pregunta | Recomiendo |
|---|---|---|
| D1 | «Cambiar el precio en la venta» y «devolución» no existen hoy. ¿Las construyo ahora o quedan fuera del catálogo hasta que existan? | **Fuera.** Son funciones nuevas de venta, no permisos; agregarlas aquí agranda la entrega más sensible. Las anoto como pendientes. |
| D2 | ¿La fila del dueño es fija (igual a hoy, con su PIN donde hoy se pide)? | **Sí.** Quitarle el PIN al dueño deja anular con su sesión abierta a quien pase por la caja. |
| D3 | ¿Excepciones solo para cajeros? | **Sí** (dueño fijo; técnico hay uno). |
| D4 | ¿Solo la actividad real renueva el tiempo (no los comandos)? | **Sí**; si no, una pantalla que recarga sola nunca se bloquea. |
| D5 | ¿El dueño también puede cambiar el tiempo de inactividad (además del técnico)? | **Sí** («el dueño siempre tiene todo»); subir de 10 min pide su PIN igual. |
| D6 | ¿El comprobante de anulación solo en la opción C? | **Sí**; en A y B el dueño estuvo presente. |
| D7 | Valores de la plantilla Flexible y umbral del aviso (3 por día). | Los de 4.1; se ajustan en la pantalla. |
| D8 | Versión **0.9.3** (no hay cambio de contrato, sigue siendo de prueba). | 0.9.3. |

---

## 10. Aprobado e implementado (0.9.3, 2026-11-24)

**Decisiones del cliente:** D1 fuera del catálogo («cambiar precio en la venta» y «devolución» no existen). D2 fila del dueño fija. D3 excepciones solo para cajeros. D4 solo la actividad real renueva el tiempo. D5 el dueño también cambia el bloqueo y subirlo de 10 min le pide su PIN. D6 comprobante obligatorio en C; en A y B, opción apagada por defecto. D7 valores de «Flexible». D8 versión 0.9.3. Además: prueba completa comando × rol antes de tocar validaciones; revisión una por una de cada `exigir()`; nunca sin dueño activo con PIN; cadena de hashes y esquema en `seguridad_versiones`; política en memoria; prueba de que el bloqueo conserva el trabajo.

**Diferencias con este borrador (decididas al programar):**
- La «puerta común» no consume una autorización guardada en la sesión dentro de cada módulo: `seguridad_autorizar` la deja en la sesión y el siguiente comando la lleva en `Actor.autorizaciones` (se gasta aunque no la use). Así `politica::aplicar` funciona igual para la puerta y para las acciones que revisan límites adentro.
- Límites implementados donde hay con qué medirlos: descuento (%), salida (monto), no venta (cantidad por turno), anular (todos), quitar líneas (monto). «Cambiar forma de pago», «cancelar», «condonar» y «anular abono» quedan sin límites (se aplican nivel y PIN).
- Acciones que siempre se confirman con el PIN del dueño (reabrir, corte, corregir el día, anonimizar, ajustes y conteos de inventario, cancelar/ajustar/condonar/prorrogar, límite y opciones de crédito, respaldo automático, restaurar): si se le dan al cajero, igual piden el PIN (`confirmar_dueno` revisa la acción y el PIN; ya no el rol).
- «Vender sin existencia» y «salida de efectivo»: el dueño sigue el tope del cajero (con PIN al pasar), porque en la 0.9.2 ese tope era del negocio y también lo frenaba a él (`dueno_sigue_cajero`).
- `caja_no_venta_umbral` se queda como aviso del Z; el PIN desde N aperturas es el límite de `caja.no_venta` (empiezan iguales).
- «El dueño siempre tiene todos los permisos» = su fila fija es la de la 0.9.2: lo técnico (configuración técnica, impresoras, formas de pago, datos legales, estructura de departamentos, preparar) sigue siendo del técnico.
- El aviso de bloqueo sale 1 minuto antes; con un tiempo de 1 minuto, a los 30 s.
- La foto de la 0.9.2 (`tests/casos/permisos_antes.json`) se tomó llamando cada comando por IPC (runtime simulado de Tauri). Para eso el manifiesto de Windows ahora lo pone el enlazador (`build.rs`), también en el ejecutable de pruebas.
- `productos.precio` e `inventario.costos` (§2) **no entraron al catálogo**: el precio se guarda en la misma operación que el resto del producto y los costos salen en varias consultas de inventario; separarlos es un cambio aparte. Hoy: cambiar precio = `productos.editar`; ver costos = `inventario.ver` (los dos, solo dueño y técnico/dueño en la Normal). Si se le da `inventario.ver` a un cajero, verá costos. Pendiente.
- Migración 25 lleva además un índice parcial (`ventas_anuladas_c`): sin él, el Z y los reportes recorrían todas las ventas por turno (la prueba de 50.000 ventas pasó de ~1,9 s a 2,3 s).
