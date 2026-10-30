# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Tauri v2 + React + TypeScript; WebView2 en Windows, app de escritorio local.)

## Users

- **Cajero/a** de librería o floristería pequeña en Costa Rica. No es técnico, trabaja rápido, a veces con poca luz y con clientes esperando. Usa teclado, lector de código USB tipo teclado y mouse.
- **Dueño/a**: administra productos, precios, clientes, usuarios y datos del negocio; también vende.
- **Técnico**: configura la instalación (impresora, formas de pago, claves); no ve datos de clientes.

## Product Purpose

Punto de venta local y sin internet para negocios chicos: vender rápido, imprimir el tiquete en una POS-58, llevar ventas en espera, cobros mixtos y facturas pendientes (la factura electrónica se hace en otro sistema). Éxito = el cajero cobra sin pensar y sin errores.

## Positioning

Una sola app reutilizable en 4 negocios distintos (librerías y floristerías): todo lo que cambia entre negocios es configuración (departamentos, formas de pago, IVA, tiquete), no código. Funciona sin internet y sin servidor.

## Operating Context

- Mostrador con una PC Windows, impresora térmica POS-58 (ESC/POS, 32 columnas, CP858, ¢ en vez de ₡), gaveta y lector USB.
- Montos enteros en colones con punto de miles.
- Varias ventas abiertas a la vez (en espera); se cobra con efectivo, tarjeta, SINPE Móvil o transferencia.
- Catálogo de ~719 productos importados de la web, mayormente sin fotos; códigos EAN/ISBN y códigos internos alfanuméricos (ej. "07toc").

## Capabilities and Constraints

- Roles cajero / dueño / técnico con permisos; PIN con Argon2; bitácora de acciones sensibles.
- Ley 8968: consentimiento para guardar clientes, anonimización, nada de datos personales a la nube.
- IVA: configurable por negocio. Chagui está en régimen simplificado y **no** muestra IVA; otros negocios sí.
- Descuentos por línea y al total, en colones **o** porcentaje (el usuario elige), con tope por rol y PIN de dueño.
- Productos favoritos (marcados por el dueño) se muestran como tarjetas en la venta.

## Brand Commitments

- Referencia visual elegida por el usuario: Alegra POS (grilla de productos a la izquierda, tiquete a la derecha con totales y botón de cobro con el monto). Limpio, minimalista, textos cortos.
- Todo el texto en español de Costa Rica.

## Evidence on Hand

- Logo del tiquete: `src/assets/logo-tiquete.png` (1 bit).
- No hay fotos de productos; no inventarlas.

## Product Principles

1. Vender es lo primero: buscar, agregar y cobrar sin menús ni diálogos innecesarios.
2. Pocas palabras: cada texto debe ganarse su lugar.
3. Configuración, no código, para lo que cambia entre negocios.
4. Nada se pierde: ventas en espera persistentes, la venta se guarda aunque falle la impresión.

## Accessibility & Inclusion

WCAG 2.1 AA: contraste 4,5:1 en texto, 3:1 en bordes de controles y foco; foco visible; todo operable con teclado; etiquetas visibles.
