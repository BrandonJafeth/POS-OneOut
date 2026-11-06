# Guía de pruebas manuales: caja y seguridad

Esta guía es para probar en la computadora de la caja, con la impresora POS-58 conectada.
Antes de empezar, cree estos usuarios (con el técnico, Ctrl+Alt+T en la pantalla de entrada):
- dueño **Ana**, PIN de 6 dígitos;
- cajero **Luis**, PIN de 4 dígitos.

Cada prueba dice lo que debe pasar. Si algo no coincide, anote el número de la prueba.

## A. Entrada y PIN

1. **PIN temporal.** Entre con Luis usando el PIN que le puso el dueño. → Pide "Cambie su PIN" y no deja hacer nada más hasta cambiarlo.
2. **PIN corto del dueño.** Ponga un PIN de 4 dígitos a un dueño desde Usuarios. → El sistema lo rechaza (mínimo 6).
3. **Bloqueo.** Escriba mal el PIN 5 veces seguidas. → Desde el 5.º intento dice que espere 30 s; luego 1 min, 2 min…
   - Tampoco entra con el PIN correcto mientras dura la espera.
4. **Inactividad.** Deje la app sin tocar 10 minutos. → Vuelve sola a la entrada.
5. **Técnico oculto.** El técnico no aparece en la lista de usuarios. Con Ctrl+Alt+T aparece su entrada.
6. **El técnico no maneja dinero.** Entre como técnico. → No ve Venta ni Caja ni Clientes.

## B. Abrir caja

1. Entre como Luis y vaya a **Venta**. → Dice "La caja está cerrada" y no deja vender.
2. Pulse **Abrir caja**, cuente con − / + (por ejemplo 2 × ¢10.000 y 5 × ¢1.000). → El total se actualiza en vivo: ¢25.000.
3. Pulse **Abrir con ¢25.000**. → El menú lateral dice "Caja abierta · hh:mm".
4. Intente abrir de nuevo desde otra sesión. → "La caja ya está abierta (la abrió …). Puede vender en ese mismo turno."

## C. Vender y mover efectivo

1. Haga una venta de ¢1.825 en efectivo, pagando con ¢2.000. → Vuelto ¢175 y el tiquete sale impreso.
2. En **Caja → Entrada**, registre ¢30.000 con el motivo "Ingreso de cambio". → Aparece en Movimientos.
3. En **Caja → Salida**, registre ¢25.000 con el motivo "Retiro de dinero". → Pide el PIN del dueño (pasa de ¢20.000).
   - El PIN de Luis no sirve; el de Ana sí.
4. Intente sacar más efectivo del que hay. → "No hay tanto efectivo en la caja".
5. Pulse el icono de impresora de un movimiento. → Sale el comprobante con espacio para la firma.
6. Revise **Efectivo esperado**. Debe ser fondo + efectivo cobrado + entradas − salidas: 25.000 + 1.825 + 30.000 − 25.000 = **¢31.825**.

## D. Corregir y anular con la caja abierta

1. Como Luis, abra en **Ventas del día** una venta suya. → No hay botones de corregir ni anular: "pida al dueño que entre con su PIN".
2. **Cambiar usuario** → Ana. Corrija el pago de Tarjeta a SINPE (con referencia). → Pide motivo y su PIN; queda en "Correcciones".
3. Anule una venta con su PIN y un motivo. → Queda "Anulada" (por Ana), conserva su número y sale del efectivo esperado.

## E. Cerrar caja

1. **Cierre del cajero (ciego).** Como Luis, pulse **Cerrar caja**. → Puede escribir el total o contar billete por billete; en ningún caso ve lo esperado.
   - Pulse **Listo, revisar el conteo** → muestra lo que contó. **Volver a contar** deja corregir; **Confirmar y cerrar** cierra.
   - Recién ahí ve el resultado ("Cuadra" / "Faltante…") y el cierre Z completo en pantalla, y sale impreso.
2. **El conteo ya no cambia.** Después de cerrar no hay forma de editar el conteo. Solo Ana, en Turnos, con **Reabrir** (PIN y motivo).
3. **Cierre con faltante del dueño.** Como Ana, cuente ¢2.000 menos. → Pide "¿Qué pasó?" y no cierra sin nota.
4. **Reimprimir.** Desde **Caja → Turnos**, abra el turno e imprima el Z otra vez. → Pide el PIN del dueño y sale con "*** COPIA ***".
5. **Revisión del dueño.** Como Ana, en Turnos aparece "Revisar". Abra el turno y pulse **Marcar como revisada**.

## F. Después del cierre

1. **Reabrir.** Como Ana, abra el turno de hoy en Turnos y pulse **Reabrir**. → Pide motivo y PIN; la caja vuelve a quedar abierta.
2. **Turno de ayer.** El botón Reabrir no aparece en turnos de días anteriores.
3. **Caja olvidada abierta.** Deje la caja abierta y cambie la fecha de Windows al día siguiente.
   - Venta dice "Quedó abierta la caja del …" y pide cerrarla antes de vender.
4. **Corregir una venta de un turno cerrado.**
   - Como Luis, en Ventas del día abra una venta de un turno cerrado. → No hay botones de corregir ni anular; avisa que solo el dueño puede.
   - Como Ana, con la caja de hoy abierta, corrija el pago con su PIN. → En Caja → "Ajustes de turnos anteriores" aparece el ajuste.
   - El Z del turno viejo no cambia.
5. **Anular una venta de un turno cerrado.** Como Ana, anúlela devolviendo efectivo. → En la caja de hoy aparece una salida "Devolución".

## G. Respaldo y restauración

1. En **Administración → Respaldo**, cree un respaldo con una contraseña de 8 caracteres o más. → Dice dónde quedó el `.posbak`.
2. Abra el `.posbak` con el Bloc de notas. → No se lee ningún nombre de cliente ni de producto.
3. **Restaurar con datos equivocados.** Elija el archivo y escriba una contraseña equivocada. → "Contraseña incorrecta o respaldo dañado".
   - Con un PIN equivocado, también se rechaza.
4. **Restaurar bien.** Use la contraseña correcta y el PIN de Ana. → "Respaldo verificado y listo". Pulse **Reiniciar ahora**; la app vuelve con los datos del respaldo.
5. **Archivo alterado.** Copie el `.posbak`, cambie un carácter con un editor hexadecimal e intente restaurarlo. → Se rechaza.

## H. Base cifrada

1. Abra `%APPDATA%\cr.puntodeventa.pos\pos.db` con el Bloc de notas. → No aparece "SQLite format 3" ni datos legibles.
2. En **Técnico → Sistema** debe decir "Cifrada (SQLCipher, clave protegida por Windows)".
3. Pulse **Verificar ahora** en la línea Bitácora. → "Íntegra (N registros)".

## I. Sin red

Desconecte el cable de red o el Wi-Fi y repita una venta y un cierre de caja. → Todo funciona igual.

## J. Dos impresoras

Prepare: la POS-58 (tiquetes, con la gaveta) y otra impresora para etiquetas (o "Microsoft Print to PDF" para probar).

1. Como Ana, **Administración → Impresoras → Agregar impresora**. → La lista de impresoras solo trae las que detecta Windows; no se puede escribir una ruta.
2. Deje "Tiquetes" (POS-58, 58 mm, 32 columnas, gaveta) y "Etiquetas". Asigne: tiquete, cierre y movimientos → Tiquetes; etiquetas → Etiquetas.
3. **Imprimir prueba** en cada una. → Sale la hoja de prueba con el ancho, las tildes y un código de barras.
4. Venda algo en efectivo. → El tiquete sale en la POS-58 y abre la gaveta. Imprima una etiqueta desde Productos. → Sale en la otra.
5. Apague la POS-58 y venda. → "La impresora «Tiquetes» no respondió…". La venta queda guardada; encienda y use **Reintentar impresión** (o reimprímala desde Ventas del día, sale COPIA).

## K. Turno compartido y cambio de usuario

1. Como Ana, abra la caja y haga una venta. **Cambiar usuario** → Luis.
   - Luis vende en el mismo turno sin abrir otro. En la barra dice "Caja abierta".
   - No queda ninguna pantalla de Ana a la vista ni ningún total (Caja dice "Los totales se ven al cerrar"; Mis turnos muestra "—").
2. Deje una venta en espera como Ana y entre como Luis. → La pestaña dice "Venta 2 · Ana"; Luis la cobra. En Ventas del día (como Ana): "cobró Luis (la empezó Ana)".
3. Cierre como Luis. → En el Z: "Abrió Ana · Cerró Luis" y "VENTAS POR USUARIO" con la nota "Efectivo y diferencia corresponden a la caja…".
4. En **Administración → Caja y cierre**, desmarque "Permitir que otros usuarios usen un turno abierto por otro" (lea el texto de ayuda). Ana abre; Luis entra. → Luis no puede vender ni mover efectivo en ese turno.

## L. No venta, orden del dueño y corte

1. En Venta o Caja pulse **No venta**, elija "Cambio de billetes". → Abre la gaveta. "Otro" pide escribir el motivo.
2. **Gaveta (dueño)**: pide el PIN del dueño y un motivo. El PIN de Luis no sirve.
3. No hay otra forma de abrirla: Técnico → Hardware ya no tiene botón de gaveta, y una venta con tarjeta no la abre.
4. Como Ana, **Caja → Corte** sin retiro. → Muestra e imprime lo vendido por forma de pago; la caja sigue abierta. Otro corte con retiro de ¢10.000 → pide su PIN y aparece como salida.
5. Cierre. → El Z trae "Aperturas sin venta", sus motivos, y "Cortes realizados". Con más aperturas que el umbral (Caja y cierre), sale "ATENCION: muchas aperturas sin venta".
6. Como Ana, en Caja → "Gaveta abierta sin venta", filtre por fecha y por Luis.

## M. Departamentos y venta

1. **Administración → Departamentos**: cambie el color de uno (de la lista o "Otro color…"). → En Venta, la píldora cambia; el texto sigue legible (blanco o negro).
2. En Venta, elija un departamento. → Además del color, la píldora elegida tiene borde grueso y ✓.
3. Pruebe en tema claro y oscuro, y a 1366 × 768 y 1920 × 1080.

## N. Prueba guiada: cierre Z en la POS-58 real

Objetivo: comprobar en papel el Z con detalle completo y los tiquetes por departamento.

1. Como Ana, **Administración → Caja y cierre**: marque "Detalle completo" y "Un tiquete aparte por departamento".
2. Abra la caja con un fondo contado por billetes (por ejemplo 1 × ¢10.000).
3. Haga al menos estas ventas:
   - 42 "IMPRESIONES A COLOR" a ¢200 pagadas con SINPE (con referencia).
   - 1 "IMPRESIONES A COLOR" en efectivo, pagando con ¢1.000 (vuelto ¢800).
   - Un cuaderno + 3 impresiones con un descuento al total, pagado mitad SINPE (banco BCR) y mitad efectivo.
   - Una venta con un nombre de producto muy largo (más de 32 letras).
4. Registre una entrada (¢3.000, "Ingreso de cambio"), una salida (¢500), una "No venta" y un corte sin retiro.
5. **Cambiar usuario** → Luis. Cierre escribiendo el total contado. Antes de confirmar, deje las casillas como están.
6. En el papel revise:
   - Encabezado: negocio, caja, día, abrió Ana (hora), cerró Luis (hora).
   - TOTAL VENTAS igual a la suma de las formas de pago, y "Efectivo esperado" = fondo + contado + entradas − salidas − vueltos.
   - "POR DEPARTAMENTO": la suma de los departamentos da el total de ventas.
   - "DETALLE DE VENTAS": "De IMPRESIONES A COLOR x42", "Co … x1", "Mx … x3"; subtotales por departamento y "TOTAL GENERAL" igual al total de ventas. El nombre largo termina en "." sin salirse del papel.
   - "CONTEO": todas las denominaciones (50 mil … 5), con 0 las que no hubo.
   - Firmas del cajero y del supervisor.
   - Después del Z, un tiquete por cada departamento con ventas, con su encabezado, su detalle, el subtotal por forma de pago y su total.
7. Reimprima desde Turnos con las casillas desmarcadas. → Pide el PIN de Ana; sale solo el Z, sin detalle ni tiquetes por departamento, y cada papel dice "*** COPIA ***".
8. Como Ana, en el turno pulse **Exportar PDF**. → Se descarga un PDF carta con el logo, el Z, el detalle completo y cada departamento en su página.
