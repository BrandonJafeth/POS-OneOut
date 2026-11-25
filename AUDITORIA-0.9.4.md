# Auditoría 0.9.4 — Etapa 1 (hallazgos, sin corregir)

_2026-11-24. Base: rama `entrega-0.9.3` (commit `d7e4ad4`). Solo se leyó y se probó: nada de lo de abajo está corregido todavía._

Gravedad (criterio del pedido): **Crítica** pierde o descuadra dinero, pierde datos, salta un permiso, expone datos personales o cierra la app · **Alta** resultado incorrecto que el usuario puede no notar · **Media** error visible con salida fácil · **Baja** detalle.

Origen: **[RI]** revisión independiente 0.9.2→0.9.3 (subagente sin contexto) · **[SAST]** Cyber Neo fase 3 · **[CN2–6]** otras fases de Cyber Neo · **[Yo]** revisión propia. «Confirmado» = lo verifiqué leyendo el código o con una prueba.

## Resumen

| Gravedad | Cuántos | Lo más importante |
|---|---|---|
| Crítica | 5 | Niveles «PIN» y «motivo» que valen como «sí»; precio libre / quitar líneas sin PIN al cobrar; el técnico se puede hacer dueño; cambio del PIN propio sin el actual; la autorización de descuento es un % y sirve para un carrito más grande |
| Alta | 6 | Cadena de permisos rota → nada nuevo aplica; «0 por turno» = sin límite; límite de «no venta» de Caja que ya no manda; entrada de mercadería doble; el cajero lista todos los apartados; el dueño frenado por «no deja» del cajero |
| Media | 10 | Pase de un solo uso frágil y no atado a la operación; acciones del catálogo sin efecto; bitácora escribible desde la pantalla; `cargo audit`/`deny` fallan; reloj de Windows hacia atrás; … |
| Baja / Info | 24 | Ver tabla |

Herramientas: clippy pedantic 378 avisos (2 sitios reales de pánico); `cargo audit`/`cargo deny` fallan por 2 avisos actualizables y 2 sin arreglo; `npm audit --omit=dev` 0; eslint 57 `exhaustive-deps` + 1 `any`; proptest 8 propiedades × 400 casos en verde; fast-check 2 × 400 en verde; legacy-scan sin nada que cause errores; mutantes: sección 5. Revisión independiente: el mapeo comando → acción de la 0.9.3 da los mismos roles que la 0.9.2 en todos los comandos (sin desajustes).

---

## 1. Críticos

**C1. Los niveles «PIN» y «motivo» valen como «sí» fuera de la puerta común** [RI 2 · confirmado · 0.9.3]
- `sesion.rs` `Actor::puede` = `nivel != No`; `lib.rs::puerta` no revisa nada en acciones `propia` ni en comandos `SegunArgumento`. La pantalla Permisos ofrece los 4 niveles para toda acción.
- Reproducción: Permisos → cajero `caja.ver_totales` = «Con PIN del dueño» (con la advertencia). El cajero ve los totales del turno y su cierre deja de ser ciego, sin PIN (`caja::ve_totales`, `cerrar` `ciego`, `Turno::para`, `necesita_nota`). Igual con `caja.cerrar_otro`, `caja.historial`, `caja.entrada` (via `caja_movimiento`), `cuentas.ver_todas` (eventos), `bd_lote` (productos, departamentos, formas de pago), `config_guardar`, `negocio_guardar`, `imprimir`. Al revés: «motivo» en `caja.salida`, `venta.sin_existencia`, `venta.apartadas` pide PIN; en `venta.descuento` vale como «sí».
- Impacto: el dueño cree que pidió su PIN y no se pide. Cajero que ve totales = puede dejar de registrar ventas sin que se note.

**C2. Precio libre y quitar líneas con «PIN» o «motivo» se saltan al cobrar** [RI 1 · confirmado · 0.9.3]
- `ventas::guardar_espera` aplica la política, pero `cobrar_opc` cobra el `estado` que manda la pantalla y `revisar_precio_libre` solo rechaza «No»; no compara con lo guardado.
- Reproducción (UI normal, plantilla Estricto): F4 → precio cualquiera → sale el pedido de PIN → Cancelar (la línea queda en pantalla) → F12 → se cobra sin PIN. Igual al quitar una línea por encima del monto.
- Impacto: pierde dinero (precio inventado, artículo quitado después de pasarlo).

**C3. El técnico puede convertirse en dueño** [SAST 1 · confirmado · desde antes de la 0.9.3]
- `permisos::administrables(Tecnico) = [Dueno, Cajero]`: crea un dueño con el PIN que quiera, o le cambia el PIN al dueño real (queda «debe cambiar» y el técnico, entrando como él, lo cambia). Desde ahí ve ventas, clientes (Ley 8968) y su PIN autoriza anulaciones.
- Reproducción: técnico → Usuarios → nuevo dueño (o «Cambiar PIN» del dueño) → Cambiar usuario → entra con ese PIN → cambia el PIN → Reportes / Clientes.
- Choca con una decisión vigente: es el camino para recuperar a un dueño que olvidó su PIN (prueba `dueno_bloqueado_lo_recupera_el_tecnico`). **Pide decisión (D1).**

**C4. Cambiar el PIN propio no pide el PIN actual** [SAST 2 · confirmado]
- `usuarios_cambiar_pin` con `id == propio`: solo `administrable`. Una sesión de dueño abierta (antes del bloqueo, hasta 60 min configurables) deja a cualquiera ponerle un PIN nuevo al dueño: queda con un PIN de dueño que autoriza todo y el dueño real queda fuera.
- Arreglo propuesto (visible): pedir el PIN actual, salvo el cambio obligatorio del primer ingreso. **D2.**

**C5. La autorización de descuento es un porcentaje y sirve para un carrito más grande** [SAST 4 · confirmado]
- `ventas::ver_autorizacion`: `espera_id`, vigencia y `pct <= p.pct`. El token queda en la venta mientras se agregan líneas.
- Reproducción (UI normal, cajero 10 %): carrito ¢2.000, 50 % → PIN del dueño (ve ¢1.000) → escanear ¢200.000 con ¢100.000 de descuento → se cobra ¢101.000 de descuento con la autorización de ¢1.000.
- Arreglo: atar el token al monto en colones del descuento (y borrarlo si cambian las líneas). Visible: si se agrega algo después, se vuelve a pedir el PIN.

## 2. Altos

| # | Hallazgo | Dónde | Reproducción | Impacto | Origen |
|---|---|---|---|---|---|
| A1 | Con la cadena de `seguridad_versiones` rota, lo que se guarda después nunca aplica | `politica::agregar` encadena a la última fila (la rota); `leer` se detiene en la primera rota; `volver` igual | Insertar a mano una versión con hash malo → guardar permisos en la pantalla → responde «guardado (versión N)» pero sigue la vieja, para siempre | El dueño cree que cambió los permisos | RI 5 · confirmado |
| A2 | «0 por turno» en la «no venta» = sin límite | `gaveta::no_venta` (`u > 0 &&`) vs `politica::aplicar` (`x >= m`: 0 = siempre PIN) | Permisos → cajero «No venta», Por turno = 0 → abre la gaveta sin PIN siempre | Gaveta libre cuando el dueño quiso PIN siempre | RI 3 · confirmado |
| A3 | El «límite por turno» de Caja y cierre ya no controla el PIN | `ConfigCaja.tsx` sigue diciendo «pasado, pide el PIN»; el PIN sale de la política (copia única al actualizar) | Bajarlo de 5 a 2 → el PIN se sigue pidiendo desde la 6.ª | Control que no hace lo que dice | RI 4 · confirmado |
| A4 | Entrada de mercadería: doble clic = entrada doble | `inventario/Entrada.tsx` usa `useState(ocupado)` (no el candado por ref de `useEnvio`); Rust sin clave de operación | Doble clic rápido en «Guardar entrada» | Existencia y costo duplicados sin que nadie lo note | Yo · confirmado leyendo |
| A5 | El cajero lista todos los apartados y créditos abiertos (nombre, teléfono, saldo) | `cuentas::buscar` con `''` devuelve 50; `LIKE` sin escapar; `cedula LIKE %q%` sirve para adivinar cédulas | F10 con búsqueda vacía; o `%`; o cédula dígito por dígito | Datos personales de clientes que no atiende | SAST 5 · confirmado. ¿La lista vacía es a propósito en F10? **D3** |
| A6 | El dueño no puede hacer salidas grandes si el cajero tiene «no deja» | `politica::efectiva` copia `al_pasar` del cajero al dueño (`dueno_sigue_cajero`) | Cajero `caja.salida` al pasar «no deja» → el dueño tampoco, ni con PIN | Bloquea al dueño (salida: retiro en corte) | RI 6 · confirmado |

## 3. Medios

| # | Hallazgo | Dónde / origen |
|---|---|---|
| M1 | Pase de un solo uso: lo gasta el siguiente comando aunque sea otro (p. ej. `venta_faltantes`), y no queda atado a la venta ni al monto (con IPC se usa para otra venta); la bitácora `permiso.autorizado` se escribe antes de que el comando haga algo; si se bloquea con el diálogo abierto y entra otro, el reintento corre con la sesión nueva | `sesion::actor` (`mem::take`), `politica::aplicar`, `lib::puerta` · RI 8, SAST 6 · confirmado |
| M2 | Tres acciones del catálogo no hacen nada: `caja.reimprimir_z`, `proformas.convertir`, `reportes.exportar` | `acciones.rs` · RI 7 · confirmado (no se usan fuera del catálogo) |
| M3 | Cualquier sesión escribe cualquier acción en la bitácora (`bd_lote` → `bitacora.registrar`); borra el aviso de anulaciones sin PIN (`aviso.anulaciones_visto`), el de la USB, etc. Requiere IPC (no hay DevTools en la versión final) | `bd.rs::lote` · SAST 3, RI 9 · confirmado |
| M4 | `inventario_producto` (control, mínimo, costo) con `inventario.ver`: un permiso de leer escribe | `acciones.rs` · SAST 7 · confirmado |
| M5 | Si `politica::cargar` falla al arrancar, se usa la Normal en silencio; si `verificar` falla al cerrar caja, el comando da error aunque el cierre quedó y no lanza el respaldo | `lib.rs` · RI 10 · confirmado |
| M6 | Reloj de Windows hacia atrás: el bloqueo por inactividad no llega hasta que la hora alcanza a la de antes | `sesion::vencida` (diferencia negativa) · Yo |
| M7 | `cargo audit` y `cargo deny` fallan (la entrega exige que pasen): `url` 2.5.8 (RUSTSEC-2026-0592) y `cookie` 0.18.2 (RUSTSEC-2026-0594) se arreglan con `cargo update`; SQLite de SQLCipher (RUSTSEC-2026-0459) y `chrono` sin mantenimiento no tienen arreglo compatible: excepción documentada | CN2 |
| M8 | Instalador sin firma y compilado a mano en la PC de desarrollo (sin `--locked`, sin versión de herramientas anotada) | CN6 · proceso, no código |
| M9 | eslint: 57 `react-hooks/exhaustive-deps`. La mayoría son efectos «al montar» a propósito; por revisar uno por uno los que pueden dejar datos viejos (Venta 159-183, Cobro 79/131/150, useEsperas) | eslint |
| M10 | Bloqueo con un diálogo de PIN abierto: el diálogo de autorización se dibuja encima del velo | `App.tsx` (pedido) · RI 8 |

## 4. Bajos e informativos

| # | Hallazgo | Origen |
|---|---|---|
| B1 | `printer.rs:111` `s[..3]` sobre nombres de dispositivo: pánico (cierra la app) con un nombre no ASCII; `buf[..n]` confía en Win32 | clippy · SAST 15 |
| B2 | `util::ulid` `expect` si Windows no da azar; `bd.rs:114/117` `expect` sobre `sentencias.json` embebido (constante); `lib.rs` `expect` al arrancar Tauri. Justificables | clippy |
| B3 | `errores.log` solo oculta 6+ dígitos seguidos: teléfono «8765-4321», cédula «1-0987-0654» y nombres pasan; `diagnostico_anotar` sin sesión | CN5, SAST 11 |
| B4 | `bd_leer` sin tope de filas ni tiempo: un `WITH RECURSIVE … randomblob` agota memoria (requiere IPC) | SAST 8 |
| B5 | `bd_lote` (productos, departamentos) sin validar largo, controles ni precio máximo | SAST 9 |
| B6 | Cadenas de hashes (bitácora, versiones) sin clave: quien escribe la base las recalcula; SEGURIDAD.md promete más | SAST 10 |
| B7 | Respaldo: Argon2 con parámetros por defecto y contraseña mínima de 8 | SAST 13 |
| B8 | `sistema_crear_tecnico` revisa fuera de la transacción (dos técnicos en el primer arranque) | SAST 14 |
| B9 | El cajero puede cambiarse el nombre (`usuarios_editar` propio) | SAST 12 (igual en 0.9.2) |
| B10 | `guardar_en` revisa y después escribe (TOCTOU) | CN5 |
| B11 | `mas_permisivo` no pide PIN al subir el umbral del aviso ni al apagar el comprobante A/B; `productos.*` y `productos.importar` no son «sensibles» | RI 11 |
| B12 | El tope de descuento propio del dueño en `descuento_max_pct` se perdió (ahora sin tope) | RI 11 |
| B13 | La plantilla «Normal» vuelve a los valores del catálogo, no a los del negocio en 0.9.2 (la etiqueta «= 0.9.2» confunde) | RI 11 |
| B14 | `caja.no_venta` «por turno» cuenta las de todos, no por usuario como dice el doc; el reporte de anulaciones muestra a quien autorizó (en B, el dueño), no al cajero | RI 11 |
| B15 | `deny_unknown_fields` + `validar`: una versión de permisos de un programa más nuevo cuenta como cadena rota al volver atrás | RI 11 |
| B16 | Campos de PIN sin `autocomplete` explícito (WebView2 podría ofrecer guardarlos) | legacy-scan |
| B17 | SEGURIDAD.md:71 dice que no hay archivo de log (sí hay `errores.log`) | CN5 |
| B18 | `prueba_avanzar_reloj` registrado en la versión final (no hace nada fuera de desarrollo) | CN5 |
| B19 | `style-src 'unsafe-inline'` en la CSP (sin salida de datos posible) | CN5 |
| B20 | Pánicos antes de `setup` no quedan en `errores.log` | CN5 |
| B21 | `tools/msedgedriver/msedgedriver.exe` (24 MB) está en git aunque `tools/` se ignora | CN4, CN6 |
| B22 | npm: 14 avisos solo de `webdriverio` (e2e, no va en el instalador); `npm ci` corre scripts que descargan drivers | CN2, CN6 |
| B23 | Fechas de comprobantes de apartado y estado de cuenta impresas con la hora de la pantalla, no la de Rust | Yo |
| B24 | `src-tauri/.cargo/audit.toml`: el comentario de evidencia usa `--target all` (debería ser el destino Windows) | CN2 |

## 5. Mutantes

_(se completa al terminar la corrida)_

## 6. Lo que se revisó y está bien
- **Mapeo comando → acción (0.9.3):** cada comando da los mismos roles que en la 0.9.2 [RI]; todos los comandos con sesión llaman `st.comando` con su propio nombre y guardan el guardia [SAST, RI].
- **SQL:** solo concatena fragmentos constantes o columnas de lista blanca; `bd_leer` sin salidas por comillas, mayúsculas, `pragma_*`, `sqlite_*`, ATTACH o CTE [SAST].
- **Archivos, ESC/POS, CSV y PDF:** guardar solo con nombre simple y carpeta de lista; ESC/POS filtrado byte a byte en Rust; CSV sin fórmulas; PDF escapado; sin `innerHTML` [SAST].
- **Tauri:** CSP, capacidades mínimas, navegación y ventanas nuevas bloqueadas, DevTools solo en desarrollo, código de prueba fuera de la versión final, manifiesto embebido igual al de Tauri (asInvoker + Common Controls 6) [CN5].
- **Secretos:** ninguno en el repo ni en la historia [CN4].
- **Dinero (propiedades):** totales, redondeo, pago mixto y vuelto, reparto del Z por departamento, abonos y fechas de días laborables: sin contraejemplos en 3.200 casos [proptest, fast-check].
- **Bloqueo:** ningún comando corre bloqueado; otro usuario empieza sin pases; el contador de comandos en curso se suelta siempre [RI].
- **Reintento automático de PIN/motivo:** todo `NECESITA_*` sale antes de escribir; no duplica cobros [RI].

## 7. Decisiones que necesito (cambian algo visible o una decisión ya tomada)
- **D1 (C3)** ¿El técnico deja de poder crear o resetear dueños, salvo en la instalación (sin ningún dueño con PIN)? Recuperar a un dueño que olvidó su PIN pasaría a necesitar a otro dueño, o un procedimiento del técnico con un código de un solo uso que el dueño confirma. Recomiendo: solo en la instalación, y para recuperar, otro dueño; si es dueño único, restaurar un respaldo o un procedimiento aparte (a definir).
- **D2 (C4)** ¿Pedir el PIN actual para cambiar el propio? Recomiendo sí.
- **D3 (A5)** F10 con búsqueda vacía hoy muestra los 50 apartados abiertos. ¿Se quita la lista (pedir al menos número, 3 letras del nombre o el teléfono completo)? Recomiendo sí.
- **D4 (C1)** La pantalla Permisos ofrecerá solo los niveles que cada acción sabe cumplir (p. ej. «ver totales», «historial», «cerrar el de otro», «entradas»: solo No / Sí). La alternativa (hacer que todas cumplan PIN y motivo) es mucho más código en caja y cierre. Recomiendo restringir.
- **D5 (C5)** La autorización de descuento pasa a ser por monto: si se agrega algo después, se vuelve a pedir el PIN. Recomiendo sí.
