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
4. Intente abrir de nuevo desde otra sesión. → "La caja ya está abierta".

## C. Vender y mover efectivo

1. Haga una venta de ¢1.825 en efectivo, pagando con ¢2.000. → Vuelto ¢175 y el tiquete sale impreso.
2. En **Caja → Entrada**, registre ¢30.000 con el motivo "Ingreso de cambio". → Aparece en Movimientos.
3. En **Caja → Salida**, registre ¢25.000 con el motivo "Retiro de dinero". → Pide el PIN del dueño (pasa de ¢20.000).
   - El PIN de Luis no sirve; el de Ana sí.
4. Intente sacar más efectivo del que hay. → "No hay tanto efectivo en la caja".
5. Pulse el icono de impresora de un movimiento. → Sale el comprobante con espacio para la firma.
6. Revise **Efectivo esperado**. Debe ser fondo + efectivo cobrado + entradas − salidas: 25.000 + 1.825 + 30.000 − 25.000 = **¢31.825**.

## D. Corregir y anular con la caja abierta

1. Haga una venta pagada con Tarjeta. En **Ventas del día**, corríjala a SINPE (con referencia). → Solo pide motivo y queda en "Correcciones".
2. Corrija un pago de Tarjeta a Efectivo. → Pide el PIN del dueño (cambia el efectivo esperado).
3. Anule una venta con el PIN del dueño y un motivo. → Queda "Anulada", conserva su número y sale del efectivo esperado.

## E. Cerrar caja

1. **Cierre que cuadra.** Pulse **Cerrar caja** y cuente exactamente lo esperado. → "Cuadra".
   - Sale el **reporte Z** con ventas por forma de pago, movimientos, conteo y firma.
2. **Cierre con faltante.** Otro día, cuente ¢2.000 menos. → Pide "¿Qué pasó?" y no cierra sin nota.
   - El resultado dice "Faltante… Queda para revisión del dueño".
3. **Reimprimir.** Desde **Caja → Turnos**, abra el turno e imprima el Z otra vez. → Sale con "*** COPIA ***".
4. **Revisión del dueño.** Como Ana, en Turnos aparece "Revisar". Abra el turno y pulse **Marcar como revisada**.
5. **Cierre ciego.** Como técnico, en Técnico → Claves ponga `caja_cierre_ciego` = true. Haga un turno como Luis.
   - Luis no ve el efectivo esperado ni la diferencia, ni en pantalla ni en el Z.
   - Ana sí los ve.

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
