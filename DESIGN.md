---
name: Punto de venta (Librería y Bazar Chagui)
description: Mostrador, no tablero. Catálogo tocable a la izquierda y tiquete fijo a la derecha, con un solo acento (grafito o el color propio del negocio).
colors:
  bg: "#f2f3f4"
  card: "#ffffff"
  card2: "#f7f7f8"
  line: "#84888f"
  hair: "#e3e5e8"
  text: "#1a1c20"
  muted: "#575b63"
  accent: "#24272c"
  on-accent: "#ffffff"
  accent-bg: "#eaebed"
  focus: "#24272c"
  ok: "#0b6b4d"
  ok-bg: "#e1f4ec"
  warn: "#7a4a00"
  warn-bg: "#fdf1d8"
  err: "#b42318"
  err-bg: "#fdeceb"
  on-err: "#ffffff"
  mark: "#ffd54a"
  dark-bg: "#111214"
  dark-card: "#18191c"
  dark-card2: "#1f2024"
  dark-line: "#737780"
  dark-hair: "#2b2d32"
  dark-text: "#eceef1"
  dark-muted: "#a6aab2"
  dark-accent: "#eceef1"
  dark-on-accent: "#18191c"
  dark-accent-bg: "#2e3036"
  dark-focus: "#eceef1"
typography:
  amount-hero:
    fontFamily: "Public Sans Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 700
    lineHeight: 1.1
    fontFeature: "tnum"
  amount-charge:
    fontFamily: "Public Sans Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 750
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Public Sans Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Public Sans Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 650
  body:
    fontFamily: "Public Sans Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  control:
    fontFamily: "Public Sans Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 550
  label:
    fontFamily: "Public Sans Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  caption:
    fontFamily: "Public Sans Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  mono:
    fontFamily: "Consolas, Cascadia Mono, Courier New, monospace"
    fontSize: "13px"
    fontWeight: 400
rounded:
  radio: "8px"
  radio-g: "12px"
  modal: "16px"
  pill: "999px"
spacing:
  e1: "4px"
  e2: "8px"
  e3: "12px"
  e4: "16px"
  e5: "24px"
  e6: "32px"
  alto-control: "44px"
components:
  button:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.radio}"
    padding: "8px 16px"
    height: "44px"
  button-hover:
    backgroundColor: "{colors.card2}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.control}"
    rounded: "{rounded.radio}"
    padding: "8px 16px"
    height: "44px"
  button-charge:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.amount-charge}"
    rounded: "{rounded.radio-g}"
    padding: "12px 24px"
    height: "64px"
    width: "100%"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.err}"
    rounded: "{rounded.radio}"
    height: "44px"
  button-danger-hover:
    backgroundColor: "{colors.err-bg}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.radio}"
    height: "44px"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.radio}"
    padding: "8px 12px"
    height: "44px"
  input-search:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    rounded: "{rounded.radio-g}"
    padding: "8px 12px 8px 46px"
    height: "52px"
  chip-filter:
    backgroundColor: "{colors.card}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 12px"
    height: "40px"
  chip-filter-selected:
    backgroundColor: "{colors.accent-bg}"
    textColor: "{colors.accent}"
  tile:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    rounded: "{rounded.radio-g}"
    padding: "12px 12px 12px 16px"
    height: "132px"
  segment-selected:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "6px"
    height: "36px"
  nav-item-active:
    backgroundColor: "{colors.accent-bg}"
    textColor: "{colors.accent}"
    rounded: "{rounded.radio}"
    height: "44px"
  badge:
    rounded: "{rounded.pill}"
    padding: "2px 9px"
    typography: "{typography.caption}"
---

# Design System: Punto de venta (Librería y Bazar Chagui)

## Overview

**Creative North Star: "El Mostrador"**

Esto es un mostrador, no un tablero. El cajero escanea o toca, ve crecer el tiquete y cobra con un botón que dice el monto. El catálogo vive a la izquierda como una grilla de tarjetas tocables; el tiquete queda fijo a la derecha, siempre a la vista, con el botón de cobro anclado al pie. Todo lo demás (navegación, filtros, clientes) es soporte de ese gesto.

El mundo es gris neutro y blanco, con bordes de 1 px y un solo acento que aparece solo donde hay acción o selección. Por defecto el acento es grafito; cada negocio puede poner su propio color (config `color_acento`) y la app lo ajusta sola hasta que cumpla AA. El sistema no tiene un tono de marca propio: le sirve igual a una librería que a una floristería y no se parece a marcas de terceros. Las tarjetas son planas en reposo y se levantan apenas al pasar el puntero. La densidad es de herramienta de trabajo (modo Operate): controles de 44 px como mínimo, números tabulares, texto corto en español de Costa Rica. Hay un tema oscuro de grafito casi negro con acento claro para las horas de poca luz; ambos temas salen de una sola fuente (`src/ui/tema.ts`) y una prueba verifica cada par de contraste contra WCAG 2.1 AA, también con ocho colores de negocio de muestra.

Rechazos confirmados: el formulario de líneas con botones apilados (el viejo POS); los atajos de teclado pintados dentro de los botones (el usuario se quejó; viven en el tooltip y en `aria-keyshortcuts`); un acento predeterminado con tono de marca (el verde azulado anterior se parecía a un competidor).

**Key Characteristics:**
- Dos columnas fijas en la venta: catálogo flexible + tiquete de 372 a 460 px.
- Un acento (grafito o el color del negocio, ajustado a AA), usado para acción primaria, selección y estado "en esta venta".
- Bordes de 1 px en dos pesos: `line` para controles, `hair` para divisores.
- Planos en reposo; la sombra es una respuesta al hover o a la capa modal.
- Montos en colones con ¢, punto de miles y cifras tabulares.
- Public Sans Variable, empaquetada sin conexión, con pesos intermedios (550, 650, 750).

## Colors

Grises neutros sin tinte, casi blancos, con un único acento intercambiable: grafito por defecto o el color propio del negocio. Los colores de estado aparecen solo como mensajes, nunca como decoración.

### Primary
- **Grafito** (accent): botón Cobrar, botón primario, borde de la tarjeta que ya está en la venta, insignia de cantidad, chip de filtro seleccionado, segmento ¢/% elegido, ítem de navegación activo, icono de "Venta simple" y anillo de foco (focus). Lleva texto blanco encima (on-accent). En oscuro se invierte a **Tiza** (dark-accent), un gris casi blanco con texto del color de la tarjeta oscura encima (dark-on-accent).
- **Gris Selección** (accent-bg): fondo de selección: línea abierta del tiquete, ítem de menú activo, chip seleccionado, forma de pago elegida, `::selection`. En oscuro, **Grafito Selección** (dark-accent-bg).
- **Color del negocio** (config `color_acento`, `#rrggbb`; vacío = Grafito): en tiempo de ejecución reemplaza accent, focus, accent-bg y on-accent en los dos temas. No es un token fijo; ver The Own Color Rule.

### Neutral
- **Gris Mostrador** (bg): fondo de la app y del catálogo.
- **Blanco Tarjeta** (card): tarjetas, tiquete, menú lateral, modales, campos.
- **Blanco Humo** (card2): hover de botones neutros, zonas secundarias, fondo del control segmentado, campos deshabilitados.
- **Gris Borde** (line): bordes de campos y botones; contraste ≥ 3:1 sobre bg y card.
- **Gris Hilo** (hair): divisores, contorno de tarjetas y chips, separación del tiquete; no identifica un control.
- **Tinta** (text) y **Gris Secundario** (muted, ≥ 4,5:1 en todas las superficies).
- **Tema oscuro:** **Carbón** (dark-bg), **Tarjeta Carbón** (dark-card) y **Carbón Alto** (dark-card2), con dark-line, dark-hair, dark-text y dark-muted en los mismos papeles.

### Estado
- **ok / ok-bg**: cobro completo, descuentos en la línea (texto verde).
- **warn / warn-bg**: avisos, contador del menú, estrella de favorito marcada (warn sobre card).
- **err / err-bg / on-err**: errores, "falta" en el cobro, papelera y Descartar.
- **mark**: resaltado de coincidencias de búsqueda.

### Named Rules
**The One Accent Rule.** Hay un solo acento por instalación, grafito o el color del negocio, y significa "acción o selección" (más el tono informativo de alertas e insignias, sobre accent-bg). No se usa como fondo de sección, ilustración ni texto decorativo: si algo lleva el color de acento, se puede tocar o está elegido. Los componentes lo piden siempre como `var(--accent)`, `var(--accent-bg)`, `var(--on-accent)` y `var(--focus)`, nunca como un hex fijo.

**The Own Color Rule.** El negocio elige el tono y el sistema garantiza que se lea. `temaConAcento()` conserva el tono y lo oscurece (tema claro, mezclándolo con negro en pasos de 6 %) o lo aclara (tema oscuro, mezclándolo con blanco) hasta que el acento como texto llegue a 4,5:1 sobre card, bg y su propio accent-bg. accent-bg es el color mezclado al 10 % (claro) o al 20 % (oscuro) sobre card; on-accent es blanco o #111214, el que dé más contraste; focus es el mismo acento ajustado. Un valor inválido deja el grafito. Ejemplos medidos: el rosa #ff69b4 queda en #b0487c en claro y en oscuro se conserva, con texto #111214; el amarillo #ffd400 queda en #816b00 en claro; el azul #1a4fc4 se aclara a #6a8dd9 en oscuro. Solo el técnico lo edita, en Datos del negocio, con vista previa en vivo del botón Cobrar y un botón "Usar grafito" para volver al predeterminado.

**The Two Lines Rule.** `line` (#84888f, ≥ 3:1) delimita todo lo que es un control (campo, botón, segmento, contorno discontinuo de "Venta simple"); `hair` (#e3e5e8) delimita lo que solo separa (tarjetas, divisores, chips en reposo, tablas). Un borde que identifica un control nunca usa `hair`.

**The Tested Pair Rule.** Todo color nuevo entra a `TEMAS` en ambos temas y su combinación a `combinaciones()` con su mínimo (4,5:1 texto, 3:1 bordes y foco). La prueba también corre con ocho colores de negocio de muestra (rosa, amarillo, azul, verde, rojo, morado, blanco y negro) en los dos temas, incluido acento sobre accent-bg ≥ 4,5:1. Si la prueba no lo cubre, no se usa.

## Typography

**Display Font:** ninguna aparte; los montos grandes son Public Sans en peso alto.
**Body Font:** Public Sans Variable (con Segoe UI, system-ui, sans-serif)
**Label/Mono Font:** Consolas / Cascadia Mono, solo para la vista previa del papel térmico, `kbd` y volcados hex.

**Character:** Una sans grotesca neutra y legible, de trazo institucional, que aprovecha el eje variable para pesos intermedios en lugar de saltar de 400 a 700.

### Hierarchy
- **Monto héroe** (700, 40px): total en el diálogo de cobro.
- **Monto de cobro** (750, 26px; 30px desde 1700 px, -0.01em): cifra dentro del botón Cobrar. El vuelto/faltante del resumen va a 30px.
- **Headline** (650, 22px, 1.25): título de pantalla.
- **Title** (650, 17px; 19px en cabecera de modal): títulos de tarjeta y diálogo.
- **Precio de tarjeta** (700, 18px, tabular): precio en la grilla.
- **Body** (400, 16px, 1.45): texto corrido y campos (16px fijo en inputs).
- **Control** (550, 15px): botones, nombre de producto (500), nombre de línea (600).
- **Label** (600, 14px): etiquetas de campo, chips de filtro, totales.
- **Caption** (400–600, 13px; 12px para el departamento en la tarjeta): subtítulos de línea, cabeceras de tabla, insignias.

### Named Rules
**The Tabular Money Rule.** Toda cifra de dinero o cantidad lleva `font-variant-numeric: tabular-nums` y va alineada a la derecha. Formato: `¢` pegado, punto de miles, sin decimales (¢13.225).

**The No Caps Rule.** No hay mayúsculas sostenidas ni tracking abierto en la interfaz; la jerarquía se hace con tamaño y peso.

## Layout

Rejilla de 4 px (`e1`–`e6`: 4, 8, 12, 16, 24, 32). Shell de dos columnas: menú lateral de 216 px (196 px ≤ 1440 px) y contenido con padding 24/32 px. La pantalla de venta anula ese padding y ocupa todo el alto: catálogo `minmax(0,1fr)` + tiquete de 400 px (372 px ≤ 1440 px, 460 px ≥ 1700 px). Probado a 1024, 1366 y 1920.

Catálogo, de arriba abajo: buscador ancho (52 px), chips de filtro que se envuelven en varias filas, grilla `auto-fill` de tarjetas de altura fija (168 px × 132 px; 150 × 120 ≤ 1440; 190 × 140 ≥ 1700) con 12 px de separación, y "Venta simple" siempre primera cuando no se busca. Tiquete, de arriba abajo: pestañas de ventas en espera, cliente (por defecto "Cliente de contado"), líneas desplazables, pie con totales, Cobrar y acciones secundarias.

**The Fixed Ticket Rule.** El tiquete nunca se desplaza junto con el catálogo ni se oculta; solo su lista de líneas desplaza. Cobrar queda siempre visible al pie.

## Elevation & Depth

Sistema plano con capas tonales (bg → card → card2) y bordes de 1 px. La sombra es respuesta, no reposo, y siempre usa el token `sombra` (rgba(20,22,26,.12) en claro, rgba(0,0,0,.5) en oscuro).

### Shadow Vocabulary
- **Levante de tarjeta** (`box-shadow: 0 4px 14px var(--sombra)`): hover de una tarjeta de producto, junto con borde `line`.
- **Capa modal** (`box-shadow: 0 24px 60px var(--sombra), 0 2px 8px var(--sombra)`): diálogos sobre velo `rgba(10,18,24,.45)`.
- **Halo de recorte** (`box-shadow: 0 0 0 3px var(--bg)`): separa la insignia de cantidad del borde de la tarjeta; no es elevación.

### Named Rules
**The Flat-Until-Hover Rule.** Tarjetas, chips y paneles no tienen sombra en reposo. La selección se marca con borde y fondo de acento, nunca con sombra.

## Shapes

Esquinas suaves en dos pasos: 8 px para controles (botones, campos, alertas, segmentos) y 12 px para contenedores y tarjetas de la grilla, el buscador y el botón Cobrar. Los modales llevan 16 px. Las píldoras (999 px) son exclusivas de chips de filtro, insignias y contador. Las pestañas de espera tienen solo las esquinas superiores redondeadas y se funden con el tiquete. El único borde discontinuo es "Venta simple": una tarjeta que no es un producto.

## Components

### Buttons
Sobrios y táctiles: blancos con borde `line`, el acento reservado para la acción que cierra la venta.
- **Shape:** esquinas suaves (8px); Cobrar usa 12px.
- **Primario:** fondo accent, texto on-accent, 44 px mínimo; hover con `brightness(1.1)`.
- **Cobrar (firma):** ancho completo, 64 px, "Cobrar" a la izquierda y el monto a la derecha en 26 px/750. El botón dice el monto. Es la muestra que ve el técnico al elegir el color del negocio.
- **Normal / Fantasma / Peligro:** normal blanco → card2 al hover; fantasma sin borde; peligro con texto y borde err → err-bg al hover; peligro lleno con on-err.
- **Hover / Focus / Active:** transición de color 150ms ease-out; foco con contorno de 2 px `focus` y 2 px de separación; al presionar baja 1 px. Deshabilitado a 45 % de opacidad.
- **Atajos:** el componente recibe `atajo` y lo pone en `title` ("Atajo: F12") y `aria-keyshortcuts`; el `<kbd>` interno está oculto.

### Chips (filtros de departamento)
- **Style:** píldora blanca, borde hair, 40 px (34 px ≤ 1200 px), 14 px.
- **State:** seleccionado = borde accent + fondo accent-bg + texto accent en 650. "Favoritos" va primero con estrella.

### Cards / Containers
- **Corner Style:** 12px.
- **Background:** card sobre bg.
- **Shadow Strategy:** ninguna en reposo (ver Elevation & Depth).
- **Border:** 1 px hair.
- **Internal Padding:** 16px 24px.

### Tarjeta de producto (firma)
Nombre arriba (hasta 3 líneas, 15 px), departamento en caption muted y precio 18 px/700 al pie. Estrella de favorito siempre visible en la esquina superior derecha: en reposo en color `line`, marcada rellena en `warn`. Si el producto ya está en la venta: borde accent e insignia redonda de cantidad (accent, 26 px) montada sobre la esquina superior izquierda. Selección por teclado en la búsqueda: borde accent + anillo de 1 px accent.

### Línea del tiquete (firma)
Rejilla nombre / paso / importe. El paso es `− n +` con botones fantasma de 34 px; con cantidad 1 el `−` se reemplaza por una papelera roja (un solo control para quitar). Al tocar la línea se abre el editor sobre accent-bg con descuento y el control segmentado ¢/%. El descuento se lista en verde (ok) en el subtítulo.

### Control segmentado (¢ / %)
Contenedor card2 con borde line y 2 px de relleno; botones de 36 px. El elegido se llena de accent con texto on-accent, sin sombra.

### Inputs / Fields
- **Style:** borde 1 px line, fondo card, 8px, 44 px, 16 px de texto; etiqueta encima en 14 px/600 y ayuda en 14 px muted.
- **Focus:** contorno de 2 px focus pegado (offset 0) y borde focus.
- **Error / Disabled:** error en err/600 con icono; deshabilitado en card2 con texto muted.
- **Buscador:** 52 px, 18 px, 12px de radio, lupa a 14 px del borde.

### Navigation
Menú lateral blanco con borde derecho hair: nombre del negocio arriba (700), ítems de 44 px con icono + texto en muted 15 px/550; hover a text; activo en accent-bg + accent 650. Administración, usuario, tema y salir quedan al pie separados por hair. Contador en píldora warn.

### Badges y Alerts
Insignias en píldora 13 px/600 con pares tono/fondo (ok, aviso, error, info). Alertas de 8px con icono, mismos pares; info usa accent sobre accent-bg.

## Do's and Don'ts

### Do:
- **Do** usar accent solo para acción primaria y selección; todo lo demás es neutro.
- **Do** pedir el acento por variable (`var(--accent)`, `var(--accent-bg)`, `var(--on-accent)`, `var(--focus)`) para que el color del negocio llegue a todas partes.
- **Do** delimitar controles con `line` y divisores con `hair`.
- **Do** escribir montos como ¢13.225: ¢ pegado, punto de miles, cifras tabulares, alineados a la derecha.
- **Do** mantener controles de 44 px como mínimo y el foco visible de 2 px en `focus`.
- **Do** poner los atajos de teclado en `title` y `aria-keyshortcuts`, no en el botón.
- **Do** mostrar filas de IVA y subtotal solo si `mostrar_iva` está activo o hay descuento/redondeo.
- **Do** escribir el texto en español de Costa Rica, corto y en usted ("Pruebe con otra palabra o escanee el código").
- **Do** agregar cada color nuevo a ambos temas y a la prueba de contraste, y comprobarlo con los colores de negocio de muestra.

### Don't:
- **Don't** apilar botones de acción bajo un formulario de líneas; la venta es grilla + tiquete.
- **Don't** pintar chips de atajo (`F12`, `Supr`) dentro de los botones.
- **Don't** dar sombra a tarjetas o paneles en reposo, ni marcar selección con sombra.
- **Don't** usar `hair` como borde de un campo o botón.
- **Don't** introducir un segundo color de acento ni usar el acento como decoración.
- **Don't** fijar un hex de acento dentro de un componente ni dar al sistema un tono de marca predeterminado; el predeterminado es grafito y el tono lo pone el negocio.
- **Don't** aplicar el color del negocio sin pasar por `temaConAcento()`; el ajuste de contraste no es opcional.
- **Don't** ocultar la estrella de favorito hasta el hover.
