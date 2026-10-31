# Graph Report - .  (2026-10-30)

## Corpus Check
- 181 files · ~138,243 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1471 nodes · 4675 edges · 46 communities (42 shown, 4 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 161 edges (avg confidence: 0.8)
- Token cost: 259,679 input · 0 output

## Community Hubs (Navigation)
- Catalog & Admin Screens
- Hardware & Ticket Preview
- Tauri Command Layer
- Import, PIN & Users (Rust)
- Product Import Pipeline (TS)
- Encrypted DB & Backups
- Business Profile (Rust)
- Business Settings UI
- Cash Shift Logic (Rust)
- App Shell & Navigation
- Cash Dialogs & UI Kit
- App Icons & Tauri Config
- Clients UI
- NPM Dependencies
- Login & User Mgmt (TS)
- Product & Security Docs
- Clients Backend (Rust)
- Session & Permissions Hooks
- Sale Screen Screenshots
- Cloud Sync & Exports
- Sales History & Invoices
- Sale Calculation (Rust)
- Sale Screen & Held Sales
- TS Config
- Hash-Chained Audit Log
- Rust Session & Actor
- Cash API (TS)
- Printing Data Feeds
- Badge & Toast
- Printer Driver (Rust)
- Config Store (Rust)
- DPAPI Key Protection
- Design North Star & Ticket
- Accent Color Rules
- Tauri Capabilities
- Vite/Node TS Config
- Dark Theme & Contrast
- Sale Integrity Guarantees
- Card Component
- No Caps Rule
- Typeface
- Two Lines Rule

## God Nodes (most connected - your core abstractions)
1. `invocar()` - 71 edges
2. `textoError()` - 65 edges
3. `useSesion()` - 50 edges
4. `monto()` - 50 edges
5. `db()` - 44 edges
6. `ahora_iso()` - 26 edges
7. `useToast()` - 25 edges
8. `Bd` - 24 edges
9. `normalizar()` - 24 edges
10. `Venta()` - 24 edges

## Surprising Connections (you probably didn't know these)
- `sql_lote Rust write command (real transaction)` --semantically_similar_to--> `bd_lote named operations (sentencias.json)`  [INFERRED] [semantically similar]
  README.md → SEGURIDAD.md
- `Automated security tests (Rust + vitest)` --semantically_similar_to--> `Manual test guide: caja y seguridad`  [INFERRED] [semantically similar]
  SEGURIDAD.md → PRUEBAS-MANUALES.md
- `agruparPorForma()` --indirect_call--> `p()`  [INFERRED]
  src/db/caja.ts → tests/driverNode.ts
- `porPalabras()` --indirect_call--> `p()`  [INFERRED]
  src/lib/importar/reglas.ts → tests/driverNode.ts
- `lineasTexto()` --calls--> `interpret()`  [EXTRACTED]
  tests/ventas.test.ts → src/lib/preview.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Business accent color guaranteed AA contrast pipeline** — design_color_acento_config, design_temaconacento, design_own_color_rule, design_tested_pair_rule, readme_tema_ts, product_wcag_aa [INFERRED 0.85]
- **Rust backend trust boundary (session, permissions, named writes, read-only SELECT, money recalculation)** — seguridad_sesion_rust, seguridad_permisos_rs, seguridad_bd_lote_sentencias, seguridad_bd_leer, seguridad_calculo_rust, seguridad_token_descuento [EXTRACTED 1.00]
- **Thermal ticket printing pipeline** — readme_escpos_builder, seguridad_escpos_sanitize, readme_print_raw, product_pos58_printer, src_assets_logo_tiquete_logo [INFERRED 0.85]
- **Sale-to-Checkout Flow (search, add, discount, cobrar, pay)** — _impeccable_review_product_search_bar, _impeccable_review_product_card_grid, _impeccable_review_cart_panel, _impeccable_review_line_item_discount, _impeccable_review_cobrar_button, _impeccable_review_payment_methods, _impeccable_review_quick_cash_buttons [INFERRED 0.85]
- **POS Checkout Flow (cart, Venta simple, Cobrar, post-sale)** — _impeccable_review_venta_simple_form, _impeccable_review_cobrar_button, _impeccable_review_despues_venta, _impeccable_review_despues_venta_siguiente_venta [INFERRED 0.85]

## Communities (46 total, 4 thin omitted)

### Community 0 - "Catalog & Admin Screens"
Cohesion: 0.05
Nodes (96): bitacora(), registrar(), aCaja(), obtenerCaja(), bool(), db(), Driver, Fila (+88 more)

### Community 1 - "Hardware & Ticket Preview"
Cohesion: 0.05
Nodes (73): Barcode(), agruparPorForma(), comprobanteMovimiento(), reporteZ(), signo(), CODE_PAGES, CodePage, codePageByEscT() (+65 more)

### Community 2 - "Tauri Command Layer"
Cohesion: 0.09
Nodes (98): AppHandle, AtomicBool, CambioPago, Conteo, Detalle, EstadoCaja, ResultadoCierre, ResultadoCobro (+90 more)

### Community 3 - "Import, PIN & Users (Rust)"
Cohesion: 0.06
Nodes (79): HashSet, aplicar(), cajero_no_importa_y_pin_obligatorio(), clave_valida(), codigo_libre(), CodigoAsignado, contar(), cp1252() (+71 more)

### Community 4 - "Product Import Pipeline (TS)"
Cohesion: 0.05
Nodes (75): RFC-4180, aplicarImportacion(), codigosExistentes(), favoritosActuales(), leerArchivo(), ModoImportacion, productosParaImportar(), ResultadoImportacion (+67 more)

### Community 5 - "Encrypted DB & Backups"
Cohesion: 0.06
Nodes (74): Aes256Gcm, AsRef, BoxDynError, BoxFuture, Key, Migration, MigrationSource, Query (+66 more)

### Community 6 - "Business Profile (Rust)"
Cohesion: 0.08
Nodes (71): dueno_contacto_tecnico_legal(), guardar(), guardar_logo(), Logo, Actor, Map, Option, Res (+63 more)

### Community 7 - "Business Settings UI"
Cohesion: 0.06
Nodes (50): bytes(), CampoNegocio, CAMPOS_CONTACTO, COLUMNA, guardarLogo(), guardarNegocio(), obtenerLogoOriginal(), puedeEditarCampo() (+42 more)

### Community 8 - "Cash Shift Logic (Rust)"
Cohesion: 0.15
Nodes (51): BTreeMap, PagoElectronico, a_turno(), abrir(), abrir_movimientos_y_cerrar(), AjusteResumen, cada_cajero_su_turno_y_reabrir_solo_el_ultimo(), cerrar() (+43 more)

### Community 9 - "App Shell & Navigation"
Cohesion: 0.07
Nodes (42): App(), AVANZADO, Dentro(), Fase, Pagina, PRINCIPAL, Seccion, crearSesion() (+34 more)

### Community 10 - "Cash Dialogs & UI Kit"
Cohesion: 0.10
Nodes (35): PinDueno(), abrirCaja(), ConteoEntrada, totalConteo(), ORDENES_PRODUCTOS, OrdenProductos, conMiles(), leerMontoEntero() (+27 more)

### Community 11 - "App Icons & Tauri Config"
Cohesion: 0.04
Nodes (46): icons/128x128@2x.png, icons/128x128.png, icons/32x32.png, icons/icon.icns, icons/icon.ico, app, security, windows (+38 more)

### Community 12 - "Clients UI"
Cohesion: 0.13
Nodes (30): CONOCIDOS, esTecnico(), Mensaje(), anonimizarCliente(), buscarClientesBasico(), clienteBasico(), crearCliente(), CuentaResumen (+22 more)

### Community 13 - "NPM Dependencies"
Cohesion: 0.05
Nodes (36): @fontsource-variable/public-sans, lucide-react, dependencies, @fontsource-variable/public-sans, lucide-react, react, react-dom, @tauri-apps/api (+28 more)

### Community 14 - "Login & User Mgmt (TS)"
Cohesion: 0.11
Nodes (30): aLogin(), cambiarPin(), crearTecnicoInicial(), crearUsuario(), editarUsuario(), eliminarUsuario(), iniciarSesion(), iniciarSesionTecnico() (+22 more)

### Community 15 - "Product & Security Docs"
Cohesion: 0.07
Nodes (35): Ley 8968 (Costa Rica personal data law), Offline local-only desktop POS (Tauri v2 + React), POS-58 thermal printer (ESC/POS, 32 cols, CP858), Roles cajero / dueno / tecnico, Open/close cash register shift flow, Cierre ciego (caja_cierre_ciego blind close), Efectivo esperado formula (fondo + cobrado + entradas - salidas), Manual test guide: caja y seguridad (+27 more)

### Community 16 - "Clients Backend (Rust)"
Cohesion: 0.22
Nodes (32): a_basico(), a_cliente(), anonimizar(), Basico, buscar_basico(), consentimiento_permisos_y_bitacora_sin_datos(), crear(), cuentas_con_saldo() (+24 more)

### Community 17 - "Session & Permissions Hooks"
Cohesion: 0.19
Nodes (29): useSesion(), textoError(), detalleTurno(), esMiTurno(), listarTurnos(), marcarRevisada(), reabrirCaja(), listarEsperas() (+21 more)

### Community 18 - "Sale Screen Screenshots"
Cohesion: 0.10
Nodes (30): POS Search Results Screenshot (busqueda), Cart Panel with Multi-Sale Tabs and Cliente de contado, Category Filter Chips (Favoritos, Libreria, Oficina, Papeleria, ...), Cobrar Primary Action Button with Total, POS Checkout Modal Screenshot (cobro), Costa Rican Colon Currency Formatting, Department Category Chips, POS Sale Screen Light Theme Screenshot (+22 more)

### Community 19 - "Cloud Sync & Exports"
Cohesion: 0.13
Nodes (23): cambiosParaNube(), COLUMNAS_PERSONALES, filaParaNube(), NUBE_LISTA_BLANCA, TABLAS_PROHIBIDAS, tablaSincronizable(), encode(), encodeMap() (+15 more)

### Community 20 - "Sales History & Invoices"
Cohesion: 0.13
Nodes (21): CampoFactura, anularVenta(), CambioPago, cobrarVenta(), Correccion, correccionesDe(), corregirPago(), descartarEspera() (+13 more)

### Community 21 - "Sale Calculation (Rust)"
Cohesion: 0.22
Nodes (22): Aplicado, Autorizacion, bruto(), ClienteBasico, Estado, Forma, formas(), importe() (+14 more)

### Community 22 - "Sale Screen & Held Sales"
Cohesion: 0.13
Nodes (19): Detalle, autorizarDescuento(), crearEspera(), guardarEspera(), bruto(), calcularTotales(), estadoVacio(), importeLinea() (+11 more)

### Community 23 - "TS Config"
Cohesion: 0.09
Nodes (21): DOM, ES2020, src, compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib (+13 more)

### Community 24 - "Hash-Chained Audit Log"
Cohesion: 0.29
Nodes (16): encadenar_pendientes(), Entrada, hash_fila(), hex(), listar(), registrar(), Option, Res (+8 more)

### Community 25 - "Rust Session & Actor"
Cohesion: 0.20
Nodes (10): Duration, Activa, Actor, Instant, Mutex, Option, Res, Rol (+2 more)

### Community 26 - "Cash API (TS)"
Cohesion: 0.16
Nodes (14): Ajuste, aRust(), cerrarCaja(), Conteo, CONTEO_VACIO, Movimiento, necesitaNota(), PagoElectronico (+6 more)

### Community 27 - "Printing Data Feeds"
Cohesion: 0.34
Nodes (11): datosReporteZ(), obtenerNegocio(), obtenerVenta(), registrarReimpresion(), impresora(), imprimirMovimiento(), imprimirZ(), ajustesImpresora() (+3 more)

### Community 28 - "Badge & Toast"
Cohesion: 0.21
Nodes (7): ICONO_TONO, Tono, Api, AvisoToast, Ctx, onClick(), ToastProvider()

### Community 29 - "Printer Driver (Rust)"
Cohesion: 0.35
Nodes (11): PRINTER_HANDLE, impresora_inexistente_da_error_legible(), last_error(), list_printers(), lista_impresoras(), print_raw(), Result, String (+3 more)

### Community 30 - "Config Store (Rust)"
Cohesion: 0.32
Nodes (11): booleano(), entero(), guardar(), permiso_de(), permisos_por_clave(), Actor, Option, Res (+3 more)

### Community 31 - "DPAPI Key Protection"
Cohesion: 0.44
Nodes (10): CRYPT_INTEGER_BLOB, blob(), desproteger(), dpapi_ida_y_vuelta(), obtener(), proteger(), Path, Res (+2 more)

### Community 32 - "Design North Star & Ticket"
Cohesion: 0.25
Nodes (9): Boton Cobrar (signature charge button), Creative North Star: El Mostrador, The Fixed Ticket Rule, Linea del tiquete, The Tabular Money Rule, index.html design thesis comment, Alegra POS visual reference, Sale keyboard shortcuts (F2..F12, Supr, Ctrl+1..9) (+1 more)

### Community 33 - "Accent Color Rules"
Cohesion: 0.22
Nodes (8): Config color_acento (business accent color), The Flat-Until-Hover Rule, The One Accent Rule, The Own Color Rule, Tarjeta de producto, Configuration, not code (multi-business reuse), Product Principles, Ventas en espera (held sales)

### Community 34 - "Tauri Capabilities"
Cohesion: 0.22
Nodes (8): core:app:default, core:event:default, main, description, identifier, permissions, $schema, windows

### Community 35 - "Vite/Node TS Config"
Cohesion: 0.22
Nodes (8): vite.config.ts, compilerOptions, allowSyntheticDefaultImports, composite, module, moduleResolution, skipLibCheck, include

### Community 36 - "Dark Theme & Contrast"
Cohesion: 0.50
Nodes (4): Dark theme (Carbon / Tiza accent), The Tested Pair Rule, WCAG 2.1 AA accessibility target, src/ui/tema.ts + tests/tema.test.ts contrast check

### Community 37 - "Sale Integrity Guarantees"
Cohesion: 0.67
Nodes (3): Consecutivo de venta (BEGIN IMMEDIATE, no gaps), Server-side money recalculation (calculo.rs, i64 colones), Single-use owner discount authorization token

## Ambiguous Edges - Review These
- `Venta Simple Quick-Sale Tile` → `Cart Panel with Multi-Sale Tabs and Cliente de contado`  [AMBIGUOUS]
  .impeccable/review/desktop.png · relation: conceptually_related_to

## Knowledge Gaps
- **209 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+204 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Venta Simple Quick-Sale Tile` and `Cart Panel with Multi-Sale Tabs and Cliente de contado`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `Bd` connect `Encrypted DB & Backups` to `Tauri Command Layer`, `Import, PIN & Users (Rust)`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `invocar()` connect `Clients UI` to `Catalog & Admin Screens`, `Product Import Pipeline (TS)`, `Business Settings UI`, `App Shell & Navigation`, `Cash Dialogs & UI Kit`, `Login & User Mgmt (TS)`, `Session & Permissions Hooks`, `Sales History & Invoices`, `Sale Screen & Held Sales`, `Cash API (TS)`, `Printing Data Feeds`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **Why does `textoError()` connect `Session & Permissions Hooks` to `Catalog & Admin Screens`, `Product Import Pipeline (TS)`, `Business Settings UI`, `App Shell & Navigation`, `Cash Dialogs & UI Kit`, `Clients UI`, `Login & User Mgmt (TS)`, `Sales History & Invoices`, `Sale Screen & Held Sales`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _209 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Catalog & Admin Screens` be split into smaller, more focused modules?**
  _Cohesion score 0.05341935483870968 - nodes in this community are weakly interconnected._
- **Should `Hardware & Ticket Preview` be split into smaller, more focused modules?**
  _Cohesion score 0.05404503753127606 - nodes in this community are weakly interconnected._