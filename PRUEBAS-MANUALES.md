# Guía de pruebas manuales: caja, seguridad, inventario y actualización

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

## S. Fecha de negocio de los turnos (cliente tardío, cambio de turno, medianoche)

Hágalo dos veces: con **Turno compartido** marcado (como Chaguí) y desmarcado (turno por cajero), en Administración → Caja y cierre. En **Días de trabajo y hora de cierre**, ponga la hora de cierre de hoy una hora antes de la hora actual para los pasos 1 y 2, y una hora después para el paso 3. Al terminar, deje lun–vie 18:30, sáb 17:30 y domingo sin trabajar.

1. **Cliente tardío (queda para mañana).**
   - Abra la caja, haga una venta, cierre con su conteo. Al final pregunta "¿Cuánto queda en la gaveta para la próxima caja?": escriba un monto y **Guardar** (sin eso no se puede pulsar Listo).
   - Abra la caja otra vez. → Antes de confirmar avisa "La caja de hoy ya se cerró: esta caja cuenta para mañana (martes 17)". Cuente el fondo y abra. → Solo dice "Cuadra" o "Diferencia" (el cajero no ve montos).
   - Venda algo. → En Caja dice "Cuenta para mañana, martes 17". Ventas del día abre en mañana y la venta dice "Venta del lunes 16, cuenta para el martes 17"; en el día de hoy no aparece.
   - Deje la caja abierta, cambie la fecha de Windows al día siguiente y venda. → Vende normal, sin "Quedó abierta la caja…".
   - Ciérrela. → El Z trae la sección **Ventas después del cierre** con la hora real, el tiquete, el usuario y el monto. En Turnos, el día aparece marcado.
2. **Bitácora.** Abra una caja después de un cierre y no venda nada. → En Administración → Bitácora aparece la apertura con usuario y hora.
3. **Cambio de turno (antes de la hora de cierre).** Cierre la caja y ábrala otra vez. → Pregunta "¿Esta caja es para hoy o para el martes 17?" (el próximo día de trabajo) con dos botones y ninguno marcado; **Abrir** no se habilita sin elegir. Elija **Hoy**. → En Turnos, el día muestra los dos turnos y un solo total del día (sin sumar fondos); el segundo dice "Abierta después de un cierre: elegida para hoy".
4. **Diferencia de apertura.** Cierre dejando ¢20.000 en la gaveta y al abrir cuente ¢19.000. → El cajero ve "Diferencia". Como Ana: en Turnos sale "Diferencia de apertura −¢1.000" y en el Z del turno nuevo también.
5. **Corregir el día (dueño).** Como Ana, abra un turno abierto (o cerrado hoy) en Turnos → **Corregir día**, elija el otro día, motivo y PIN. → Cambia el día y queda en la bitácora. Un turno cerrado otro día no deja.
6. **Venta cerca de medianoche.** Con la caja de hoy abierta, cambie la hora de Windows a las 11:55 p. m., venda, y luego a las 12:05 a. m. → La venta de las 11:55 es del día; a las 12:05 pide cerrar la caja de ayer ("caja olvidada"). Ciérrela a las 12:30 a. m. y vuelva a abrir. → Cuenta para hoy (un cierre de madrugada es de la noche anterior).
7. **Caja olvidada de un día anterior.** Deje una caja abierta y adelante la fecha dos días. → Pide cerrarla antes de vender.
8. **Turno por cajero: cerrar el turno de otro.** Con turno por cajero, Luis abre y deja la caja abierta; adelante la fecha un día y entre como otro cajero. → Ofrece **Cerrar el turno de Luis** con conteo ciego; queda anotado quién lo cerró. Luego abre el suyo.
9. **Un solo turno abierto.** Con una caja abierta, otro usuario intenta abrir. → No deja (en los dos modos).
10. **Caja tardía del sábado.** Ponga la fecha de Windows en un sábado. Abra, venda, cierre después de las 17:30 y vuelva a abrir. → Avisa "esta caja cuenta para el lunes 23". Venda algo. Cambie la fecha al domingo y luego al lunes. → En ninguno pide cerrar la caja ("caja olvidada"); el lunes se sigue vendiendo en ella. En Ventas del día, la venta del sábado sale en el lunes con "Venta del sábado 21, cuenta para el lunes 23".
11. **Sábado antes de las 17:30.** Un sábado, cierre a las 3 p. m. y vuelva a abrir. → Pregunta "¿Esta caja es para hoy o para el lunes 23?".
12. **Apertura en domingo.** Ponga la fecha en un domingo y abra la caja. → "Hoy es domingo, día no laborable. ¿Abrir igual?". Con **Sí, abrir**, la caja cuenta para el domingo (Caja dice "Hoy · día no laborable") y queda en la bitácora.
13. **Caja olvidada del viernes.** Deje abierta la caja de un viernes y ponga la fecha en lunes. → Pide cerrarla antes de vender.

## G. Respaldo y restauración

1. En **Administración → Respaldo**, cree un respaldo con una contraseña de 8 caracteres o más. → Dice dónde quedó el `.posbak`.
2. Abra el `.posbak` con el Bloc de notas. → No se lee ningún nombre de cliente ni de producto.
3. **Restaurar con datos equivocados.** Elija el archivo y escriba una contraseña equivocada. → "Contraseña incorrecta o respaldo dañado".
   - Con un PIN equivocado, también se rechaza.
4. **Restaurar bien.** Use la contraseña correcta y el PIN de Ana. → "Respaldo verificado y listo". Pulse **Reiniciar ahora**; la app vuelve con los datos del respaldo.
5. **Archivo alterado.** Copie el `.posbak`, cambie un carácter con un editor hexadecimal e intente restaurarlo. → Se rechaza.
6. **Caja abierta.** Con la caja abierta, intente restaurar. → "Cierre la caja antes de restaurar un respaldo."
7. **Respaldo de una versión anterior.** Restaure un `.posbak` hecho con la versión anterior del programa. → Se pone al día solo; después de reiniciar están las ventas, los turnos, los clientes, y la bitácora sale "Íntegra".
8. **Respaldo de una versión más nueva.** Intente restaurar un respaldo hecho con una versión más nueva. → "Este respaldo se hizo con una versión más nueva del programa…". La base actual no cambia.

## H. Base cifrada

1. Abra `%APPDATA%\PuntoDeVenta-Datos\pos.db` con el Bloc de notas. → No aparece "SQLite format 3" ni datos legibles.
2. En **Técnico → Sistema** debe decir "Cifrada (SQLCipher, clave protegida por Windows)".
3. Pulse **Verificar ahora** en la línea Bitácora. → "Íntegra (N registros)".

## I. Sin red

Desconecte el cable de red o el Wi-Fi y repita una venta y un cierre de caja. → Todo funciona igual.

## J. Dos impresoras

Prepare: la POS-58 (tiquetes, con la gaveta) y otra impresora para etiquetas (o "Microsoft Print to PDF" para probar).

1. Como Ana (dueño), en **Administración → Impresoras** ve las impresoras, «Imprimir prueba» y a cuál va cada documento, pero no «Agregar impresora», ni editar ni quitar. Como el técnico (Ctrl+Alt+T), **Administración → Impresoras → Agregar impresora**. → La lista de impresoras solo trae las que detecta Windows; no se puede escribir una ruta.
2. Deje "Tiquetes" (POS-58, 58 mm, 32 columnas, gaveta) y "Etiquetas". Asigne: tiquete, cierre y movimientos → Tiquetes; etiquetas → Etiquetas.
3. **Imprimir prueba** en cada una. → Sale la hoja de prueba con el ancho, las tildes y un código de barras.
4. Venda algo en efectivo. → El tiquete sale en la POS-58 y abre la gaveta. Imprima una etiqueta desde Productos. → Sale en la otra.
5. Apague la POS-58 y venda. → "La impresora «Tiquetes» no respondió…". La venta queda guardada; encienda y use **Reintentar impresión** (o reimprímala desde Ventas del día, sale COPIA).

## K. Turno compartido y cambio de usuario

1. Como Ana, abra la caja y haga una venta. **Cambiar usuario** → Luis.
   - Luis vende en el mismo turno sin abrir otro. En la barra dice "Caja abierta".
   - No queda ninguna pantalla de Ana a la vista ni ningún total (Caja dice "Los totales se ven al cerrar"; Mis turnos muestra "—").
   - En **Ventas del día**, Luis ve también el tiquete de Ana (para atender un reclamo si ella no está): lo abre y lo reimprime como COPIA. No ve la suma de lo vendido; anular y corregir el pago siguen pidiendo el PIN del dueño.
2. Deje una venta en espera como Ana y entre como Luis. → La pestaña dice "Venta 2 · Ana"; Luis la cobra. En Ventas del día (como Ana): "cobró Luis (la empezó Ana)".
3. Cierre como Luis. → En el Z: "Abrió Ana · Cerró Luis" y "VENTAS POR USUARIO" con la nota "Efectivo y diferencia corresponden a la caja…".
4. En **Administración → Caja y cierre**, desmarque "Permitir que otros usuarios usen un turno abierto por otro" (lea el texto de ayuda). Ana abre; Luis entra. → Luis no puede vender ni mover efectivo en ese turno.

## L. No venta, orden del dueño y corte

1. En Venta o Caja pulse **Abrir gaveta**, elija "Cambio de billetes". → Abre la gaveta. "Otro" pide escribir el motivo.
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

## O. Inventario

Como Ana (dueño). Use dos productos con código de barras (A y B) y un servicio (por ejemplo "Fotocopia").

1. **Menú.** Ana ve **Inventario** en el menú; Luis y el técnico no. En **Productos**, Ana ve las columnas Existencia, Mínimo y Estado; el técnico no.
2. **Datos iniciales.** En **Inventario → Existencias**, filtro "Sin control": están los productos sin código de barras (servicios). Los que tienen código empiezan en 0, estado "Agotado".
3. **Carga desde CSV.** En **Carga inicial**, elija un CSV con `codigo,existencia,costo` y una fila con un código que no existe. → La vista previa marca el error y el botón **Cargar** queda apagado. Corrija el archivo, vuelva a elegirlo y cargue con el PIN de Ana. → A queda con su existencia; en su **Kardex** aparece "Inventario inicial".
4. **Entrada de mercadería.** En **Entrada de mercadería**: proveedor (créelo antes en Proveedores), factura "F-1", escanee A tres veces (cantidad 3) y ponga costo ¢400. Escriba un precio nuevo para B. → Pide confirmar el cambio de precio. Guarde.
   - La existencia de A sube 3; en Existencias, el costo de A es ¢400.
   - **Imprimir comprobante** sale por la impresora de comprobantes. **Imprimir etiquetas** saca 3 etiquetas de A (B sin código no lleva).
5. **Vender.** Como Luis, venda 2 de A, 1 Fotocopia y un precio libre (F4). → A baja 2; la fotocopia y el precio libre no aparecen en el kardex. Una venta **en espera** sin cobrar no cambia nada.
6. **Anular.** Como Ana, anule esa venta. → A vuelve a subir 2; el kardex muestra "Anulación · Tiquete …".
7. **Vender sin existencia (permitido).** Venda más unidades de B de las que hay. → Se vende; B queda "Negativo" (filtro Negativos).
8. **Vender sin existencia (bloqueado).** En **Opciones**, apague "Vender aunque no haya existencia". Como Luis, intente vender más de lo que hay. → Pide el PIN del dueño. Con un PIN equivocado, no vende. Con el de Ana, vende. Vuelva a encender la opción.
9. **Ajuste.** En Existencias → **Ajustar** sobre A: sin motivo, el botón queda apagado; con "Otro" sin escribir el motivo, también. Elija "Daño", diferencia −1, PIN equivocado → rechazado; PIN de Ana → baja 1. La bitácora tiene `inventario.ajuste`.
10. **Conteo físico.** En **Conteo físico**, elija un departamento y **Empezar conteo**. Escanee A dos veces (contado 2) y escriba un número en otro producto. **Guardar a medias**, salga de la pantalla y vuelva: sigue ahí. Marque "Ver solo diferencias", **Aplicar conteo** con el PIN de Ana. → Las existencias quedan iguales a lo contado; en el kardex, "Ajuste · Conteo".
11. **Mínimo y alerta.** En A → **Mínimo y costo**, mínimo 5. → A sale "Bajo mínimo" y el menú Inventario muestra un número. En la pantalla de Venta (Luis) no aparece ningún aviso.
12. **Existencia en la venta.** En Opciones, encienda "Mostrar la existencia en las tarjetas". → En Venta, las tarjetas de productos con control dicen "Hay N" en vez del departamento. Apáguelo.
13. **Reportes** (Ana): Bajo mínimo con "Pedir" = mínimo × 2 − existencia (cámbielo), Valorizado (los sin costo aparte), Movimientos por fechas y tipo. Exporte CSV y PDF de cada uno: el CSV abre en Excel con tildes; una celda que empiece con "=" sale como texto.
14. **Kardex por fechas.** En A → Kardex, cambie las fechas: solo salen los movimientos del rango.

15. **Producto nuevo.** Cree "Impresión B/N" sin código de barras. → Estado "Sin control"; con «vender sin existencia» apagado, Luis lo vende sin PIN. Cree otro con código de barras. → Queda con control (Agotado).
16. **Eliminar con existencias.** Elimine un producto con unidades. → La confirmación dice cuántas unidades dejan de contarse.

## R. Casos límite de venta y clientes

1. **Venta de ¢0 con dinero.** Haga una venta que quede en ¢0 (descuento total autorizado) y escriba ¢1.000 en efectivo. → "La venta es de ¢0: no reciba dinero…"; la gaveta no se abre. Sin monto, se registra.
2. **Cantidad enorme.** En el buscador escriba `999999*` y un código. → "La cantidad máxima por línea es 100.000."
3. **Anonimizar con factura pendiente.** Venda a un cliente pidiendo factura y, sin marcarla, intente anonimizarlo. → Lo rechaza y dice por qué. Marque la factura y anonimice: en Ventas del día, el tiquete ya no muestra su nombre.
4. **Anular una venta facturada.** → Aviso rojo de nota de crédito; en la bitácora, `venta.anular` lleva la referencia de la factura.
5. **Importar sin códigos internos.** En Productos → Importar, deje apagado «Generar un código interno…» (viene apagado). → Los productos nuevos quedan sin código; se les escanea el código de barras después. Enciéndalo y vuelva a importar: reciben código interno. La opción queda guardada.
6. **Nombres con espacios o tildes raras.** Cree un producto «Café   con  leche» copiando el nombre de una página web. → Se guarda «Café con leche»; buscar «cafe con leche» lo encuentra y el tiquete imprime la tilde bien.
7. **Nombre repetido.** Cree «Copia» y después «copia», «COPIA» y «Cópia ». → Mientras escribe, debajo del nombre aparece en rojo «Ya existe "Copia" (¢…). Use otro nombre…» y **Crear producto** queda apagado. Renombrar otro producto a «copia» tampoco deja. En Productos → Mostrar → **Nombre repetido** salen los que ya venían repetidos (p. ej. de la importación), uno junto al otro. Al importar: si «Copia» se creó a mano en el POS y la web trae «copia», no se duplica: sale en «Se van a actualizar» (precio de la web, etc.) con el aviso «Se une con "Copia"…»; al reimportar ya se reconoce por su id. Si el del POS ya venía de **otro** producto de la web, la fila sale en **Problemas** diciendo cuál es y qué hacer.
8. **Descuento fijo de producto.** En un producto ponga Descuento 10 %. → Abajo dice «Se vende a ¢…». Con 50 % o más pide confirmar. Como Luis (cajero, tope 10 %), véndalo: el descuento sale solo, sin PIN. Escanéelo otra vez: suma cantidad y el descuento se recalcula. Agréguele un F8 que pase el tope de Luis → pide PIN (solo cuenta lo de Luis). Deje una venta en espera con ese producto, cambie el % como Ana y cobre como Luis → «el descuento del producto cambió, vuelva a agregarlo». En el Z, «Descuentos de producto» sale aparte de «Descuentos dados».
9. **Unidades al crear.** Cree un producto nuevo con «Unidades que hay» = 6. → En Existencias tiene 6 y en su Kardex, «Entrada de mercadería» de hoy. El campo no aparece al editar ni para quien no maneja inventario.
10. **Páginas.** En Productos, Existencias, Conteo físico, Ventas del día y Clientes, con más de una página: «51–100 de N», Anterior / Siguiente y números. Busque algo que esté en la página 3 estando en la 1 → lo encuentra (la búsqueda es sobre todo). En el conteo, escanee un producto de otra página → salta a esa página y suma 1.

5. **Impresora sin papel.** Quite el papel (o desconecte la USB a medio tiquete) y cobre. → En unos 10 s avisa que la impresora no contestó; la venta queda guardada y la siguiente venta se cobra normal. Con «No venta», si la gaveta no contesta, el aviso dice que quedó registrado.

## T. Apartados y crédito

Antes, como Ana: **Apartados → Opciones**, escriba las condiciones (por ejemplo «Pasado el plazo se devuelve lo abonado») y deje 50 %, 30 días, calendario, «Se le devuelve todo».

1. **Apartar sin cliente.** Como Luis, con la caja abierta, agregue un producto de ¢20.000 y pulse **F9**. → Abre la ventana de cliente.
   - Cree uno nuevo (nombre, teléfono, casilla del aviso). → Sigue solo a **Apartar**: total, abono mínimo ¢10.000 y «Retirar antes del …» (30 días después; si cae en domingo, el lunes).
2. **Abono menor al mínimo.** Escriba ¢9.000 y Enter. → «El abono mínimo para apartar es…». Escriba ¢10.000 y Enter → el cobro de siempre → Enter (efectivo).
   - → Gaveta abierta, comprobante «A-0001 · APARTADO» con productos, total, abonado, saldo ¢10.000, fecha límite, condiciones y (si está activo) el aviso de privacidad. La venta desaparece de las pestañas.
3. **Lo apartado no se vende.** Si ese producto tenía 1 unidad con control de inventario: véndalo en otra venta. → Pide el PIN del dueño («Está apartado: … (A-0001)»).
4. **El precio cambia.** Como Ana, cambie el precio del producto a ¢25.000.
5. **Abonar y liquidar.** Como Luis, **F10** → escriba «Marta» (o «A-1», o el teléfono) → ↓ y Enter. → Saldo ¢10.000. Enter → cobro con tarjeta → Enter.
   - → «A-0001 liquidado», sale el **tiquete de venta** de ¢20.000 (el precio del apartado, no ¢25.000) con «Pagado con abonos (A-0001)». La existencia baja ahora.
6. **Doble clic.** En otro apartado, al cobrar un abono pulse Enter dos veces seguidas. → Un solo abono.
7. **Pagado sin entregar.** Abone el saldo completo de otro apartado **desmarcando** «Se lleva los productos ahora». → Queda «Pagado, sin entregar». Con F10 → **Entregar**.
8. **Sin caja no hay abono.** Cierre la caja y pruebe F10 → abonar. → «La caja está cerrada…».
9. **El Z.** Al cerrar: sección **Apartados y crédito** con los abonos por forma de pago (dinero), «Ventas pagadas con abonos», apartados nuevos y liquidados. El efectivo esperado incluye los abonos en efectivo («Abonos en efectivo»). Como cajero con la caja abierta, en Caja no se ve ningún total de abonos.
10. **Caja tardía.** Un sábado, después de las 17:30, abra la caja que cuenta para el lunes y reciba un abono. → En Reportes, el abono sale el lunes; el comprobante tiene la fecha y hora reales del sábado.
11. **Cancelar.** Como Ana, **Apartados** → un apartado abierto → **Cancelar apartado**: devuelve ¢8.000 de ¢10.000, todo en efectivo, motivo y PIN. → Estado cancelado, retenido ¢2.000; en Caja, una salida «Devolución apartado»; en el Z, «Cancelados: devuelto ¢8.000 · retenido ¢2.000». La unidad ya se puede vender sin PIN.
12. **Anular un abono.** En un apartado abierto, **Anular** un abono del turno abierto (sin devolución). → El saldo sube y el efectivo esperado baja. Con un abono de un turno ya cerrado: el Z viejo no cambia y lo devuelto sale como salida hoy.
13. **Ajustar, condonar, prorrogar.** Ajuste −¢500 (motivo y PIN) → el saldo baja. Condonar → se liquida con ese descuento y sale la venta. Prorrogar a otra fecha → cambia «Vence».
14. **Vencido.** Ponga la fecha de Windows después de la fecha límite de un apartado abierto. → En el menú, Apartados muestra un contador; la pestaña **Vencidos** lo lista con los días de atraso. No se cancela solo.
15. **Ley 8968.** En Clientes, intente anonimizar a Marta con un apartado abierto. → Lo rechaza. En la bitácora, `cuenta.abono` y `cuenta.cancelar` no llevan nombre ni teléfono.
16. **Prorrogar pide PIN.** Prorrogar sin PIN o con uno equivocado → no deja. Con PIN y motivo → cambia «Vence».
17. **Condonar con la caja cerrada.** Con la caja cerrada, Condonar un apartado → «Para condonar, abra la caja primero (se registra una venta)» y el botón no se activa.
18. **Qué se aparta.** El campo dice «Describa el producto. No escriba datos personales del cliente.» y no acepta más de 200 letras.

## V. Crédito (solo en un negocio con crédito; en Chaguí queda apagado)

Antes, como técnico: **Técnico → Claves de configuración**, `usa_credito` → `true`.

1. **Opciones (Ana).** Apartados → Opciones → **Crédito**: límite general ¢100.000, 30 días, «Solo días de trabajo», condiciones «Pague el saldo antes de la fecha límite», PIN. → Guardado. Sin PIN no deja. «Preparar para el cliente» marca Crédito como listo.
2. **Límite por cliente sin cuenta previa.** Clientes → un cliente → **Cambiar límite** ¢25.000 (PIN). → «Límite de crédito: ¢25.000». La bitácora no guarda el monto.
3. **Crédito disponible.** Como Luis, venta de ¢30.000 con ese cliente (F7) → F12. → «Crédito disponible: ¢25.000». Pague ¢5.000 y **Dejar ¢25.000 a crédito**. Con ¢4.000 pagados → «no alcanza» y el botón no se activa.
4. **Comprobante.** Salen el tiquete y el comprobante **C-0001**: total ¢30.000, pagado hoy, saldo, «Pagar antes del …» (nunca un domingo con días de trabajo), condiciones y «Firma del cliente». No dice «pagaré».
5. **Estado de cuenta (Ana).** Clientes → el cliente → **Estado de cuenta**: el crédito y sus apartados abiertos, cada abono con fecha y hora, y el total adeudado. **Imprimir** (térmica) y **PDF**. Como Luis no aparece.
6. **Ajuste hacia arriba.** Ajuste +¢1.000 al crédito (PIN). → El saldo sube ¢1.000; «Condonado» no aparece negativo.
7. **El Z y los reportes.** «Ventas a crédito (por cobrar)» en el Z; en Reportes → Formas de pago, la fila «A crédito (por cobrar)» y las formas suman lo vendido.

## W. Proformas

1. **Crear (Luis, sin caja abierta).** Agregue productos, un descuento de línea y pulse **F11** (o el botón **Proforma**). Escriba un nombre («Pedro») → **Guardar e imprimir**. → Sale «PROFORMA P-0001», «Válida hasta el …» (8 días de trabajo), detalle, total, condiciones y la leyenda «Proforma. No es una factura ni un comprobante de pago. Precios sujetos a existencia.». No abre la gaveta ni baja la existencia. La pestaña dice «Proforma P-0001».
2. **Cobrar sin cambios.** Abra la caja y en esa pestaña F12 → cobre. → Proformas → Convertidas: P-0001 con la venta. El Z tiene la venta, no la proforma.
3. **Cambiar y cobrar.** Otra proforma; después de guardarla, cambie una cantidad. → Aviso «La venta ya no coincide con la proforma P-0002». F12 → elegir **Guardar como nueva versión (P-0002-2) y cobrar** o **Cobrar sin ligar**. La versión anterior queda «Reemplazada».
4. **Descartar.** Guarde una proforma y descarte la pestaña. → Sigue vigente en Proformas.
5. **Pasar a venta.** Proformas → una vigente → **Pasar a venta**. → Abre una pestaña nueva ligada. Si el dueño subió un precio, se cobra el de la proforma. Con una vencida (cambie la fecha de Windows): aviso «venció el …» y precios de hoy, línea por línea.
6. **Una sola vez.** Abra dos veces la misma proforma con Pasar a venta y cobre las dos pestañas. → La segunda dice que ya está convertida.
7. **Apartar.** Una pestaña ligada → F9 → la proforma pasa a convertida (en el apartado).
8. **Reimprimir y PDF.** → Sale «COPIA». El PDF carta lleva logo, datos y la leyenda.
9. **Anular (Ana).** Con motivo. Luis no ve el botón.
10. **Nombre escrito.** 30 días después de anularla o de que venza (fecha de Windows), la reimpresión dice «Cliente: no registrado». La bitácora y el reporte nunca muestran el nombre.
11. **Reporte (Ana).** Reportes → Ventas → **Proformas**: emitidas, convertidas, vencidas y anuladas con montos. No suman a las ventas.
12. **Opciones (Ana).** Proformas → Opciones: vigencia, días, precio al convertir, condiciones y días para borrar el nombre.

## X. Permisos y bloqueo por inactividad (0.9.3)

Usuarios: Ana (dueña), Luis (cajero), el técnico. Caja abierta para las ventas.

1. **Igual que antes.** Recién actualizado, como Luis: vender, descuento hasta 10 % sin PIN (más pide el PIN de Ana), salida de ¢20.000 sin PIN y ¢25.000 con PIN, no ve totales con el turno abierto, no ve Anular. → Todo como en la 0.9.2.
2. **La pantalla Permisos.** Ana → Administración → **Permisos**. → Matriz por área con buscador; cada celda dice en palabras qué significa; la columna del dueño no se cambia; al técnico, lo de clientes y dinero sale «No (Ley 8968 o dinero)».
3. **Opción C con PIN.** Pestaña **Anulación por el cajero** → C (hasta ¢10.000, 3 por turno, turno abierto, 30 min) → Guardar. → Pide el PIN de Ana. Sin PIN no guarda.
4. **Se aplica sin volver a entrar.** Con Luis dentro (en otra sesión antes de que Ana cambie, o cambiando de usuario): Ventas del día → una venta de ¢2.000 → **Anular venta** → motivo de la lista (con «Otro», escribir cuál) → sin PIN. → Sale el **comprobante** con firma; en la bitácora «opción C: cajero sin PIN».
5. **Pasa un límite.** Anular una de ¢15.000 → pide el PIN de Ana («pasa de ¢10.000»). Una facturada o de un turno cerrado → siempre PIN. Una que liquida un apartado → «Corríjalo en Apartados».
6. **Z.** Cerrar la caja. → Sección **«Anulaciones por cajero sin PIN»** (papel, PDF y pantalla) con motivo y usuario; las que llevaron PIN no salen ahí.
7. **Aviso.** Ana entra. → «Hubo N anulaciones sin PIN» con «Ver el detalle». Con más de 3 en un día, el día sale marcado en Reportes → Cierres de caja.
8. **Excepción.** Por usuario → un segundo cajero (Fabricio) con «Anular» = Sí, con motivo. → Fabricio anula sin PIN; Luis (con su rol en A) no ve Anular.
9. **Reglas fijas.** El técnico intenta darle «Clientes» al técnico o a Luis «Editar permisos». → No deja. Desactivar al único dueño → no deja.
10. **Plantillas e historial.** Elegir «Estricto» → lista de diferencias → usar → Guardar. Historial → «Ver» la versión anterior → **Volver a esta versión** (PIN de Ana). → Vuelve como una versión nueva.
11. **PDF para firmar.** → Documentos\Punto de venta\Reportes\AAAA-MM\permisos-vN.pdf con la tabla, los límites y la línea de firma. Firmarlo con Ana y guardarlo.
12. **Bloqueo.** Técnico → Configuración técnica → **Bloqueo por inactividad**: 5 min sin PIN; 20 min pide el PIN de Ana; 0 o «nunca» no se aceptan; técnico 16 no. → «Si nadie toca la caja por 5 minutos, se pide el PIN otra vez.»
13. **Se bloquea sin perder nada.** Luis: una venta en espera con productos, un conteo de cierre a medias y una entrada de mercadería (como Ana) a medias. Esperar sin tocar. → A falta de 1 minuto, aviso; una tecla lo cierra. Al vencer, **Pantalla bloqueada**. Luis pone su PIN → todo sigue igual. Si en cambio entra Ana, empieza de cero y no ve nada de la pantalla de Luis.
14. **No corta un cobro.** Con el tiempo en 1 min, cobrar justo antes de que venza. → El cobro y el tiquete salen; el bloqueo viene después.
15. **Preparar para el cliente.** → «Permisos y bloqueo por inactividad»: versión y minutos por rol. Revisarlo con el dueño.

## U. Reportes y cierres de caja

Como Ana, **Reportes**.

1. **Atajos.** Hoy, Ayer, Esta semana (desde el lunes), Este mes, Mes anterior. Con una caja tardía del sábado abierta, «Hoy» es el lunes.
2. **Suma igual a los Z.** Elija un día con dos cierres. → Resumen «Ventas» = suma de «Total ventas» de los dos Z (Reportes → Cierres de caja). Los fondos no se suman.
3. **Anulación de otro día.** Anule hoy una venta de ayer. → Ayer sigue igual (como su Z); hoy aparece en «Anulado después» y en «Anulaciones y control» como «Otro día».
4. **En curso.** Con la caja abierta, el resumen dice «En curso (no se suma)» con lo de ese turno.
5. **Tablas.** En Productos, pulse el encabezado «Ventas»: ordena de mayor a menor; otra vez, al revés. Con Tab llega a cada encabezado y Enter ordena.
6. **Por hora.** Las ventas de la caja tardía salen en su hora real.
7. **Utilidad.** Productos sin costo salen en el aviso «vendidos sin costo»; los vendidos antes de esta versión salen «aprox.».
8. **Exportar.** CSV y PDF en cada pestaña. → Quedan en `Documentos\Punto de venta\Reportes\AAAA-MM\`. El CSV abre en Excel con tildes y los montos se pueden sumar; un nombre que empieza con «=» queda como texto.
9. **Cierres de caja.** La lista de turnos (antes en Caja → Turnos) está aquí: abrir un turno, ver el Z, reimprimir (PIN), marcar revisada, reabrir y corregir el día. En Caja ya no aparece el historial.
10. **Permisos.** Como Luis y como técnico, Reportes no aparece en el menú.

## P. Actualizar el programa en la PC del cliente

El procedimiento completo (antes, instalar, verificar, volver atrás) está en **ACTUALIZAR.md**. Sígalo paso a paso; no lo repita de memoria.

## Q. Lectura cerrada desde la pantalla (versión de desarrollo)

Solo con `npm run tauri dev` (en la versión final no hay DevTools).

1. Entre como Ana, abra DevTools (F12) y en la consola escriba:
   `window.__TAURI_INTERNALS__.invoke("bd_leer", { sql: "SELECT * FROM clientes", params: [] })` → error "no está permitido".
2. Lo mismo con `usuarios`, `ventas`, `existencias`, `inventario_movimientos`, `producto_costos`. → Todas fallan.
3. Con `"SELECT 1; SELECT 2"` y con `"DELETE FROM productos"`. → Fallan.
4. En **Técnico → Bitácora** aparecen las entradas `lectura.rechazada`.
5. Las pantallas de Venta y Productos funcionan igual que antes.

## Aceptación de la versión de prueba (0.9.0)

Se hace una vez, en la computadora del negocio, antes de dejarla en uso. Marque cada casilla solo si pasó lo esperado. Si algo falla, anote el número y no entregue.

### Instalar
- [ ] 1. **Verificar el instalador.** PowerShell: `Get-FileHash .\Punto*Setup.exe -Algorithm SHA256`. → Igual al de ENTREGAS.md.
- [ ] 2. **Instalar.** Doble clic. Si sale «Windows protegió su PC»: **Más información → Ejecutar de todas formas** (no está firmado). → Instala sin pedir permisos de administrador. **No desactive el antivirus.** Si Defender lo pone en cuarentena, no lo saque de ahí: avise al técnico (el SHA-256 dice si el archivo es el correcto).
- [ ] 3. **Primer arranque.** → Pide crear el técnico. **Acerca de** (menú, abajo) dice versión 0.9.0.
- [ ] 4. **Abrir dos veces.** Con el programa abierto, ábralo otra vez. → Aviso «ya está abierto»; no abre una segunda ventana.

### Configurar
- [ ] 5. **Técnico → Preparar para el cliente.** Complete cada punto (negocio, dueño, formas de pago, departamentos, impresoras, gaveta). → Todos en «listo» salvo productos y respaldo.
- [ ] 6. **Número del próximo tiquete.** Si venía de otro sistema, póngalo en Administración → Caja y cierre (antes de la primera venta). → Queda en la bitácora `caja.consecutivo`.
- [ ] 7. **Importar productos** (el archivo del cliente, ~719). → El resumen cuadra con el archivo; los que tienen error dicen la fila y por qué. Sin códigos internos inventados (salvo que lo marque).
- [ ] 8. **Respaldo automático.** Como dueño, Administración → Respaldo: elija la contraseña, márquela como entendida y anótela **fuera de la computadora**. → «Hacer uno ahora» dice verificado.
- [ ] 9. **Preparar para el cliente** otra vez. → Todo listo; «Sin datos de prueba» listo.
- [ ] 9b. **Permisos (0.9.3).** Con el dueño: revisar Administración → Permisos (por defecto «Normal», igual que antes), decidir la anulación por el cajero (A, B o C) y el tiempo de bloqueo; imprimir **PDF para firmar**, firmarlo y guardarlo. (Sección X.)

### Vender
- [ ] 10. Abrir caja con fondo. → Abre; queda en la bitácora.
- [ ] 11. Venta en **efectivo** con vuelto. → Tiquete impreso, gaveta abre, vuelto correcto.
- [ ] 12. Venta con **tarjeta** y con **SINPE / transferencia** (cada forma activa). → Pide referencia si aplica; no abre gaveta si no corresponde.
- [ ] 13. Venta **mixta** (parte efectivo, parte tarjeta). → Suma exacta; vuelto solo sobre el efectivo.
- [ ] 14. **Poner en espera**, cerrar el programa, abrirlo y retomar. → La espera sigue ahí con sus líneas.
- [ ] 15. **Anular** una venta (PIN del dueño). → Pide motivo; el efectivo esperado baja; queda en la bitácora.
- [ ] 16. **Entrada** de efectivo y **salida** de efectivo. → Comprobante impreso; el esperado cambia.
- [ ] 17. **Ajuste de inventario** de un producto con control. → El kardex muestra el movimiento con el motivo.
- [ ] 18. **Abrir gaveta** sin vender. → Pide motivo; queda registrada.
- [ ] 19. **Corte** a medio turno. → Imprime corte; la caja sigue abierta.
- [ ] 20. **Cambiar de usuario** con la caja abierta (cajero ↔ dueño). → El cajero ve en Ventas del día los tiquetes de todos (sin totales del turno) y no entra a Administración.

### Cerrar
- [ ] 21. **Cierre ciego**: el cajero cuenta sin ver el esperado. → Al confirmar muestra la diferencia.
- [ ] 22. **Z impreso.** → Totales por forma de pago = suma de las ventas del turno; anulaciones aparte.
- [ ] 23. Después del cierre, un respaldo automático «cierre» aparece en Administración → Respaldo.

### Respaldo y recuperación
- [ ] 24. **Respaldo manual** a la USB. → Verificado.
- [ ] 25. **Restaurar en otra carpeta** (simulacro, en otra PC o usuario de Windows): instalar, en la pantalla inicial **Restaurar desde respaldo** con el archivo de la USB y su contraseña. → Mismas ventas, turnos y productos (compare con **Exportar diagnóstico**).
- [ ] 26. **Exportar diagnóstico** (Técnico → Sistema). → Archivo en Descargas, sin nombres de clientes ni PIN.

### Desinstalar y reinstalar sin perder datos
- [ ] 27. Anote los conteos (Exportar diagnóstico). **Desinstale** desde Configuración de Windows **marcando «Borrar los datos de la aplicación»** si lo ofrece.
- [ ] 28. Verifique que `%APPDATA%\PuntoDeVenta-Datos` sigue ahí con `pos.db`, `pos.clave` y `respaldos`.
- [ ] 29. **Reinstale** el mismo instalador y entre. → Mismos usuarios, ventas, turnos y productos (diagnóstico igual al del paso 27). No pidió crear técnico de nuevo.

Firma técnico: ________________  Firma dueño: ________________  Fecha: ____________

## Instalación limpia

Para dejar la base sin datos de prueba (por ejemplo, si se probó en la PC del negocio antes de entregar).

1. Cierre el programa. Si hay algo que guardar, haga un respaldo y cópielo a la USB.
2. Vaya a `%APPDATA%\PuntoDeVenta-Datos` y **renombre** la carpeta a `PuntoDeVenta-Datos.prueba-<fecha>` (no la borre hasta que el cliente use la nueva una semana).
3. Abra el programa: arranca como recién instalado (pide crear el técnico).
4. Siga «Aceptación» desde el paso 3. «Preparar para el cliente» debe marcar «Sin datos de prueba».
