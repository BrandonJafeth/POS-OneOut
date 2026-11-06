# Graph Report - .  (2026-11-05)

## Corpus Check
- 195 files · ~166,166 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1771 nodes · 5695 edges · 67 communities (55 shown, 12 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 215 edges (avg confidence: 0.8)
- Token cost: 149,748 input · 0 output

## Community Hubs (Navigation)
- Rust Commands & Types
- Audit Log & Cash Data
- Users & PIN Auth (Rust)
- Cash Shift (Rust)
- CSV Product Import
- DB Crypto & Migrations
- Owner PIN & Cash UI
- App Shell & Routing
- Session & Payment Forms
- Tauri Config & Icons
- Checkout & Text Helpers
- Cloud Sync Whitelist
- Shared UI Components
- Cash Drawer (Rust)
- Users API (TS)
- Import Backend (Rust)
- NPM Dependencies
- Printer Settings
- ESC/POS Builder
- Ticket Logo Bitmap
- Windows Printer FFI
- Printer API & Code Pages
- Customers (Rust)
- UI Review Screenshots
- Z Report Printing
- Closing PDF
- Sale Totals (Rust)
- Ticket Preview
- Customers API (TS)
- TS Config
- Z Breakdown by Dept
- Hash-Chained Audit Log
- App Config (Rust)
- Rust Session Store
- Code Page Encoding
- App Icon Set
- Data Protection Docs
- Printing & Billing Docs
- Money & PIN Docs
- ESC/POS Whitelist (Rust)
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64

## God Nodes (most connected - your core abstractions)
1. `invocar()` - 88 edges
2. `textoError()` - 76 edges
3. `monto()` - 61 edges
4. `useSesion()` - 51 edges
5. `db()` - 45 edges
6. `base_con_usuarios()` - 35 edges
7. `ahora_iso()` - 35 edges
8. `useToast()` - 32 edges
9. `Venta()` - 25 edges
10. `Bd` - 24 edges

## Surprising Connections (you probably didn't know these)
- `Guia de pruebas manuales: caja y seguridad` --semantically_similar_to--> `Pruebas automaticas de seguridad`  [INFERRED] [semantically similar]
  PRUEBAS-MANUALES.md → SEGURIDAD.md
- `bd_lote (sentencias.json con permiso)` --semantically_similar_to--> `Comando Rust sql_lote`  [INFERRED] [semantically similar]
  SEGURIDAD.md → README.md
- `escpos.rs lista blanca ESC/POS` --semantically_similar_to--> `escpos::validar (lista blanca)`  [INFERRED] [semantically similar]
  README.md → SEGURIDAD.md
- `crearSesion()` --indirect_call--> `p()`  [INFERRED]
  src/app/sesion.ts → tests/driverNode.ts
- `agruparPorForma()` --indirect_call--> `p()`  [INFERRED]
  src/db/caja.ts → tests/driverNode.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Sale-to-Checkout Flow (search, add, discount, cobrar, pay)** — _impeccable_review_product_search_bar, _impeccable_review_product_card_grid, _impeccable_review_cart_panel, _impeccable_review_line_item_discount, _impeccable_review_cobrar_button, _impeccable_review_payment_methods, _impeccable_review_quick_cash_buttons [INFERRED 0.85]
- **POS Checkout Flow (cart, Venta simple, Cobrar, post-sale)** — _impeccable_review_venta_simple_form, _impeccable_review_cobrar_button, _impeccable_review_despues_venta, _impeccable_review_despues_venta_siguiente_venta [INFERRED 0.85]
- **Controles anti-fraude del cajero en caja** — seguridad_totales_ocultos_cajero, seguridad_conteo_ciego, seguridad_bitacora_encadenada, seguridad_confirmar_dueno, seguridad_gaveta_aperturas [INFERRED 0.85]
- **Sistema de acento y contraste AA** — design_one_accent_rule, design_own_color_rule, design_tema_con_acento, design_tested_pair_rule, design_tema_test [INFERRED 0.85]
- **Proteccion de datos en disco** — seguridad_sqlcipher, seguridad_respaldo_aes_gcm, seguridad_pin_argon2id, pruebas_manuales_base_cifrada, pruebas_manuales_respaldo [INFERRED 0.75]

## Communities (67 total, 12 thin omitted)

### Community 0 - "Rust Commands & Types"
Cohesion: 0.08
Nodes (118): AppHandle, AtomicBool, CambioPago, Conteo, Corte, Datos, Detalle, EstadoCaja (+110 more)

### Community 1 - "Audit Log & Cash Data"
Cohesion: 0.06
Nodes (90): bitacora(), registrar(), VerificacionBitacora, aCaja(), obtenerCaja(), bool(), bytes(), db() (+82 more)

### Community 2 - "Users & PIN Auth (Rust)"
Cohesion: 0.07
Nodes (103): a_usuario(), administrable(), autorizar_dueno(), base_con_usuarios(), bloqueo_progresivo_y_bitacora(), cajero_no_administra_usuarios(), cambiar_pin(), confirmar_dueno() (+95 more)

### Community 3 - "Cash Shift (Rust)"
Cohesion: 0.07
Nodes (84): BTreeMap, Desglose, a_turno(), abrir(), abrir_movimientos_y_cerrar(), AjusteResumen, cerrar(), compartido() (+76 more)

### Community 4 - "CSV Product Import"
Cohesion: 0.05
Nodes (76): RFC-4180, aplicarImportacion(), codigosExistentes(), favoritosActuales(), leerArchivo(), ModoImportacion, productosParaImportar(), ResultadoImportacion (+68 more)

### Community 5 - "DB Crypto & Migrations"
Cohesion: 0.06
Nodes (75): Aes256Gcm, AsRef, BoxDynError, BoxFuture, Key, Migration, MigrationSource, Query (+67 more)

### Community 6 - "Owner PIN & Cash UI"
Cohesion: 0.07
Nodes (61): PinDueno(), abrirCaja(), Ajuste, AperturaGaveta, aperturasGaveta(), aRust(), cerrarCaja(), Conteo (+53 more)

### Community 7 - "App Shell & Routing"
Cohesion: 0.06
Nodes (40): App(), AVANZADO, Dentro(), Fase, Pagina, PRINCIPAL, Seccion, crearSesion() (+32 more)

### Community 8 - "Session & Payment Forms"
Cohesion: 0.10
Nodes (46): useSesion(), esTecnico(), textoError(), CampoFactura, listarBancos(), listarFormasPago(), anularVenta(), autorizarDescuento() (+38 more)

### Community 9 - "Tauri Config & Icons"
Cohesion: 0.04
Nodes (46): icons/128x128@2x.png, icons/128x128.png, icons/32x32.png, icons/icon.icns, icons/icon.ico, app, security, windows (+38 more)

### Community 10 - "Checkout & Text Helpers"
Cohesion: 0.10
Nodes (36): totalConteo(), cobrarVenta(), descartarEspera(), ResultadoCobro, conMiles(), leerMontoEntero(), colones(), monto() (+28 more)

### Community 11 - "Cloud Sync Whitelist"
Cohesion: 0.08
Nodes (33): ExportacionCliente, cambiosParaNube(), COLUMNAS_PERSONALES, filaParaNube(), NUBE_LISTA_BLANCA, TABLAS_PROHIBIDAS, tablaSincronizable(), campos() (+25 more)

### Community 12 - "Shared UI Components"
Cohesion: 0.12
Nodes (25): CONOCIDOS, Mensaje(), CodigoOcupado, esLecturaDeEscaner(), Opciones, quitarDelCampo(), useEscaner(), NuevoCliente() (+17 more)

### Community 13 - "Cash Drawer (Rust)"
Cohesion: 0.13
Nodes (38): Apertura, gaveta_solo_por_los_tres_caminos(), listar(), no_venta(), orden_dueno(), por_venta(), Actor, Option (+30 more)

### Community 14 - "Users API (TS)"
Cohesion: 0.10
Nodes (33): aLogin(), cambiarPin(), crearTecnicoInicial(), crearUsuario(), editarUsuario(), eliminarUsuario(), iniciarSesion(), iniciarSesionTecnico() (+25 more)

### Community 15 - "Import Backend (Rust)"
Cohesion: 0.12
Nodes (39): aplicar(), cajero_no_importa_y_pin_obligatorio(), clave_valida(), codigo_libre(), CodigoAsignado, contar(), cp1252(), csv_web() (+31 more)

### Community 16 - "NPM Dependencies"
Cohesion: 0.05
Nodes (36): @fontsource-variable/public-sans, lucide-react, dependencies, @fontsource-variable/public-sans, lucide-react, react, react-dom, @tauri-apps/api (+28 more)

### Community 17 - "Printer Settings"
Cohesion: 0.11
Nodes (30): ajustesDe(), AjustesImpresora, aSettings(), asignarImpresora(), Conexion, DatosImpresora, Detectadas, detectarImpresoras() (+22 more)

### Community 18 - "ESC/POS Builder"
Cohesion: 0.18
Nodes (18): aEscPos(), EscPos, cerrar(), escribirAvisoCorto(), escribirEncabezado(), escribirPie(), etiquetaProducto(), lineasLibres() (+10 more)

### Community 19 - "Ticket Logo Bitmap"
Cohesion: 0.13
Nodes (28): aUnBit(), medidasLogo(), umbralSugerido(), DEFAULT_SETTINGS, CAMPOS, ColorNegocio(), decodificar(), Imagen (+20 more)

### Community 20 - "Windows Printer FFI"
Cohesion: 0.15
Nodes (30): FnOnce, HDEVINFO, PRINTER_HANDLE, SETUP_DI_REGISTRY_PROPERTY, SP_DEVINFO_DATA, apagar(), con(), Detectadas (+22 more)

### Community 21 - "Printer API & Code Pages"
Cohesion: 0.15
Nodes (23): CODE_PAGES, LOGO, listPrinters(), printRaw(), colon(), Doc, finish(), gaveta() (+15 more)

### Community 22 - "Customers (Rust)"
Cohesion: 0.24
Nodes (30): a_basico(), a_cliente(), anonimizar(), Basico, buscar_basico(), consentimiento_permisos_y_bitacora_sin_datos(), crear(), cuentas_con_saldo() (+22 more)

### Community 23 - "UI Review Screenshots"
Cohesion: 0.10
Nodes (30): POS Search Results Screenshot (busqueda), Cart Panel with Multi-Sale Tabs and Cliente de contado, Category Filter Chips (Favoritos, Libreria, Oficina, Papeleria, ...), Cobrar Primary Action Button with Total, POS Checkout Modal Screenshot (cobro), Costa Rican Colon Currency Formatting, Department Category Chips, POS Sale Screen Light Theme Screenshot (+22 more)

### Community 24 - "Z Report Printing"
Cohesion: 0.20
Nodes (26): Corte, cabeceraTurno(), comprobanteMovimiento(), den(), documentosCierre(), encabezadoDetalle(), filaDetalle(), hora() (+18 more)

### Community 25 - "Closing PDF"
Cohesion: 0.12
Nodes (22): agruparPorForma(), Detalle, PagoElectronico, pdfCierre(), DENOMINACIONES, descuadres(), exigirCuadre(), LineaDoc (+14 more)

### Community 26 - "Sale Totals (Rust)"
Cohesion: 0.22
Nodes (22): Aplicado, Autorizacion, bruto(), ClienteBasico, Estado, Forma, formas(), importe() (+14 more)

### Community 27 - "Ticket Preview"
Cohesion: 0.13
Nodes (16): Barcode(), copiar(), ean13Modules(), G, isIsbn13(), isValidEan13(), L, PARITY (+8 more)

### Community 28 - "Customers API (TS)"
Cohesion: 0.18
Nodes (21): anonimizarCliente(), buscarClientesBasico(), clienteBasico(), crearCliente(), CuentaResumen, cuentasConSaldo(), datoParaFactura(), DatosCliente (+13 more)

### Community 29 - "TS Config"
Cohesion: 0.09
Nodes (21): DOM, ES2020, src, compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib (+13 more)

### Community 30 - "Z Breakdown by Dept"
Cohesion: 0.22
Nodes (20): armar(), calcular(), codigo_corto(), Departamento, departamentos_y_detalle_suman_el_total(), Desglose, Fila, FormaMonto (+12 more)

### Community 31 - "Hash-Chained Audit Log"
Cohesion: 0.29
Nodes (16): encadenar_pendientes(), Entrada, hash_fila(), hex(), listar(), registrar(), Option, Res (+8 more)

### Community 32 - "App Config (Rust)"
Cohesion: 0.25
Nodes (15): booleano(), booleano_con(), entero(), entero_con(), guardar(), permiso_de(), permisos_por_clave(), Actor (+7 more)

### Community 33 - "Rust Session Store"
Cohesion: 0.21
Nodes (10): Duration, Activa, Actor, Instant, Mutex, Option, Res, Rol (+2 more)

### Community 34 - "Code Page Encoding"
Cohesion: 0.23
Nodes (12): CodePage, codePageByEscT(), decodeByte(), encode(), encodeMap(), encodeMaps, Align, hexDump() (+4 more)

### Community 35 - "App Icon Set"
Cohesion: 0.13
Nodes (15): App icon 128x128@2x, App icon 128x128, App icon 32x32, App icon artwork (default Tauri logo: interlocking yellow and cyan rings with dots), App icon icon, App icon Square107x107Logo, App icon Square142x142Logo, App icon Square150x150Logo (+7 more)

### Community 36 - "Data Protection Docs"
Cohesion: 0.18
Nodes (14): Pruebas H: Base cifrada, Pruebas G: Respaldo y restauracion (.posbak), Anonimizar clientes (sin borrado logico), Ley 8968 (datos personales), src/db/sincronizacion.ts (lista blanca nube), Bitacora encadenada SHA-256 (solo anadir), Bloqueo progresivo de PIN, Cadena de suministro (npm audit, cargo audit, cargo deny) (+6 more)

### Community 37 - "Printing & Billing Docs"
Cohesion: 0.15
Nodes (13): Pruebas J: Dos impresoras, Code pages ESC/POS (CP437, CP850, WPC1252, CP858), Decision: Tauri vs Electron, Validacion EAN-13 / ISBN-13, Pendientes de factura (facturacion externa), Impresoras multiples (tabla impresoras, migracion 8), Migraciones src/db/migraciones, print_raw (spooler Windows RAW) (+5 more)

### Community 38 - "Money & PIN Docs"
Cohesion: 0.18
Nodes (12): Pruebas A: Entrada y PIN, Consecutivo de venta (BEGIN IMMEDIATE), redondeo_total, caja_ajustes (correcciones de turnos cerrados), Dinero validado en Rust (calculo.rs, i64), confirmar_dueno (anular/corregir pagos), DEBE_CAMBIAR_PIN, Entrada oculta del tecnico (Ctrl+Alt+T) (+4 more)

### Community 39 - "ESC/POS Whitelist (Rust)"
Cohesion: 0.26
Nodes (9): acepta_lo_que_arma_la_app(), malo(), pulso_gaveta(), rechaza_gaveta_y_controles_raros(), Res, String, Vec, tiquete() (+1 more)

### Community 40 - "Community 40"
Cohesion: 0.44
Nodes (10): CRYPT_INTEGER_BLOB, blob(), desproteger(), dpapi_ida_y_vuelta(), obtener(), proteger(), Path, Res (+2 more)

### Community 41 - "Community 41"
Cohesion: 0.24
Nodes (11): Atajos en title y aria-keyshortcuts, src/ui/departamentos.ts (paleta de 12), The One Accent Rule, The Own Color Rule, Pildoras de departamento, temaConAcento(), Tema oscuro (Carbon/Tiza), tests/tema.test.ts (contraste WCAG 2.1 AA) (+3 more)

### Community 42 - "Community 42"
Cohesion: 0.18
Nodes (11): Boton Cobrar (firma), config color_acento, El Mostrador (Creative North Star), The Fixed Ticket Rule, Public Sans Variable, The Tabular Money Rule, index.html design thesis comment, Alegra POS visual reference (+3 more)

### Community 43 - "Community 43"
Cohesion: 0.22
Nodes (11): Pruebas B: Abrir caja, Pruebas E: Cerrar caja (cierre ciego), Prueba N: cierre Z en la POS-58 real, Efectivo esperado (fondo + cobrado + entradas - salidas), Guia de pruebas manuales: caja y seguridad, Impresora POS-58, Cierre Z (reporteZ.ts), desglose.rs (reparto exacto del Z) (+3 more)

### Community 44 - "Community 44"
Cohesion: 0.22
Nodes (8): core:app:default, core:event:default, main, description, identifier, permissions, $schema, windows

### Community 45 - "Community 45"
Cohesion: 0.22
Nodes (8): vite.config.ts, compilerOptions, allowSyntheticDefaultImports, composite, module, moduleResolution, skipLibCheck, include

### Community 46 - "Community 46"
Cohesion: 0.25
Nodes (3): hash(), Result, String

### Community 47 - "Community 47"
Cohesion: 0.43
Nodes (4): ICONO_TONO, Tono, AvisoToast, Ctx

### Community 48 - "Community 48"
Cohesion: 0.33
Nodes (7): Pruebas L: No venta, orden del dueno y corte, Corte (dueno), escpos.rs lista blanca ESC/POS, Gaveta (tres caminos de apertura), CSV sin formulas, escpos::validar (lista blanca), gaveta_aperturas (solo anadir)

### Community 49 - "Community 49"
Cohesion: 0.38
Nodes (7): Pruebas K: Turno compartido y cambio de usuario, caja_turno_compartido, bd_leer (solo SELECT, read_only, sin tablas sensibles), Instalador sin firmar (SHA-256 publicado), Lo que NO cubre, Recomendaciones para cada negocio, Totales ocultos al cajero (caja::ve_totales)

### Community 50 - "Community 50"
Cohesion: 0.33
Nodes (3): Api, onClick(), ToastProvider()

## Ambiguous Edges - Review These
- `Venta Simple Quick-Sale Tile` → `Cart Panel with Multi-Sale Tabs and Cliente de contado`  [AMBIGUOUS]
  .impeccable/review/desktop.png · relation: conceptually_related_to

## Knowledge Gaps
- **246 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+241 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Venta Simple Quick-Sale Tile` and `Cart Panel with Multi-Sale Tabs and Cliente de contado`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `Bd` connect `DB Crypto & Migrations` to `Rust Commands & Types`, `Users & PIN Auth (Rust)`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Why does `formas()` connect `Users & PIN Auth (Rust)` to `Sale Totals (Rust)`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **Why does `Forma` connect `Sale Totals (Rust)` to `Users & PIN Auth (Rust)`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _246 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Rust Commands & Types` be split into smaller, more focused modules?**
  _Cohesion score 0.07654789323939845 - nodes in this community are weakly interconnected._
- **Should `Audit Log & Cash Data` be split into smaller, more focused modules?**
  _Cohesion score 0.05536445536445536 - nodes in this community are weakly interconnected._