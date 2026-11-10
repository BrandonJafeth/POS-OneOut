# Flujos del Punto de Venta — guía para pruebas manuales

Versión 0.9.0 más los cambios del 10/11/2026. Las capturas están en `capturas/` y se tomaron en la
app real, con una base de prueba aparte (negocio «Librería La Esquina (PRUEBA)»).

**Datos de prueba usados en las capturas**

| Qué | Valor |
|---|---|
| Técnico | PIN 735919 (se entra con Ctrl+Alt+T en la pantalla de entrada) |
| Dueña | Ana |
| Cajero | Luis |
| Productos | Cuaderno 100 hojas ¢1.500 · Lapicero azul ¢350 · Cartulina blanca ¢250 · Fotocopia blanco y negro ¢25 |
| Impresora y gaveta | No había: por eso varias capturas muestran «No se imprimió» y «La gaveta no abrió» |

**Cómo leer cada flujo:** quién lo hace, los pasos, qué debe pasar, y «Pruebe también» con los casos
raros que vale la pena intentar para encontrar errores.

---

## 1. Primer arranque y configuración (técnico)

### 1.1 Primer arranque
- **Quién:** técnico, una sola vez por instalación.
- **Pasos:** abrir el programa → escribir el PIN técnico dos veces → «Crear usuario técnico».
- **Debe pasar:** entra directo como técnico. El menú muestra solo Productos, Administración y Técnico.
- **Capturas:** `01-primer-arranque`, `02-despues-de-crear-tecnico`.
- **Pruebe también:** PIN de 5 números; PIN «000000»; los dos PIN distintos; abrir el programa dos veces (debe avisar «ya está abierto»).

### 1.2 Preparar para el cliente
- **Pasos:** Técnico → «Preparar para el cliente».
- **Debe pasar:** lista de puntos en «listo» o «falta», cada uno dice dónde se arregla. Antes de entregar todo debe estar en listo, incluido «Sin datos de prueba».
- **Capturas:** `03-tecnico-preparar-para-el-cliente`.

### 1.3 Resto de pantallas del técnico
- Claves de configuración (`04`), Hardware (`05`), Formas de pago (`06`), Bancos (`07`), Permisos por rol (`08`), Bitácora (`09`), Sistema (`10`).
- **Pruebe también:** en Claves, poner `redondeo_total` en 3 (debe rechazarlo); desactivar una forma de pago y ver que ya no sale en el cobro; revisar que la Bitácora tenga cada acción que usted hizo.
- **Sin captura:** Departamentos y Formato del tiquete.

### 1.4 Datos del negocio
- **Pasos:** Administración → Datos del negocio → llenar nombre, cédula, dirección, teléfono, pie del tiquete → Guardar.
- **Debe pasar:** el nombre aparece arriba del menú y en la pantalla de entrada; los datos salen en el tiquete.
- **Capturas:** `11-administracion`, `12-admin-datos-del-negocio-vacio`, `12-admin-datos-del-negocio`, `74-admin-datos-del-negocio`.
- **Pruebe también:** guardar con el nombre vacío; subir un logo muy grande; cambiar el color.

### 1.5 Usuarios
- **Pasos:** Administración → Usuarios → «Nuevo usuario» → nombre, rol y PIN temporal → Crear.
- **Debe pasar:** el usuario queda en la lista. La primera vez que entra, el programa lo obliga a cambiar el PIN.
- **Capturas:** `13-admin-usuario-nuevo`, `14-admin-usuarios`, `72-admin-usuarios`.
- **Pruebe también:** dos usuarios con el mismo nombre (con y sin tilde, mayúsculas); PIN «1111»; desactivar o eliminar al único dueño (debe negarse); desactivarse a sí mismo; mientras carga debe decir «Cargando usuarios…».

### 1.6 Productos
- **Pasos:** Productos → «Nuevo producto» → nombre, departamento, precio → «Crear producto» → agregar código → Cerrar. La estrella marca favorito (sale como tarjeta en la venta).
- **Debe pasar:** el producto aparece en la lista con su código.
- **Capturas:** `15-producto-nuevo-vacio`, `15-producto-nuevo`, `16-producto-editar-con-codigo`, `17-productos-lista`.
- **Pruebe también:** precio 0; precio negativo o con letras; el mismo código en dos productos; un código UPC de 12 dígitos buscado con y sin el cero adelante; escanear un código que no existe; desactivar un producto que está en una venta en espera.
- **Sin captura:** Importar productos (archivo CSV), etiquetas.

---

## 2. Entrada al programa

### 2.1 Entrar y cambiar el PIN
- **Pasos:** elegir el usuario → escribir el PIN → Enter. La primera vez pide un PIN nuevo.
- **Capturas:** `18-entrada-elegir-usuario`, `19-entrada-pin`, `20-cambiar-pin-obligatorio`.
- **Pruebe también:** PIN equivocado 5 veces seguidas (debe pedir esperar, y la espera debe seguir aunque cierre el programa); dejar el programa sin tocar más de 10 minutos (debe cerrar la sesión); «Cambiar usuario» con la caja abierta.

---

## 3. Caja

### 3.1 Abrir la caja
- **Quién:** cajero o dueño.
- **Pasos:** Caja → «Abrir caja» → escribir el fondo, o contar billetes y monedas → «Abrir con ¢…».
- **Debe pasar:** el indicador del menú pasa a «Caja abierta · hora». Sin caja abierta, Venta no deja vender.
- **Capturas:** `21-venta-con-caja-cerrada`, `22-caja-cerrada`, `23-caja-abrir-conteo`, `24-caja-abrir-billetes`, `25-caja-abierta`.
- **Pruebe también:** abrir con ¢0; abrirla dos veces; que otro usuario intente abrir con una ya abierta.

### 3.2 Entrada y salida de efectivo
- **Pasos:** Caja → «Entrada» o «Salida» → monto, motivo, nota → Registrar.
- **Debe pasar:** el efectivo esperado sube o baja; el movimiento aparece en la lista.
- **Capturas:** `46-caja-entrada`, `47-caja-salida`, `45-caja-abierta-con-ventas`.
- **Pruebe también:** salida mayor al efectivo que hay (debe negarse); salida de más de ¢20.000 (pide PIN del dueño); monto 0.

### 3.3 No venta y gaveta del dueño
- **Pasos:** Venta → «No venta» → motivo → «Abrir la gaveta». En Caja, «Gaveta (dueño)» pide el PIN.
- **Debe pasar:** queda anotado con nombre, hora y motivo; aparece en el cierre.
- **Capturas:** `44-no-venta`, `50-caja-gaveta-dueno`.
- **Pruebe también:** motivo «Otro» sin detalle; abrirla más de 5 veces (debe salir aviso en Caja).

### 3.4 Corte parcial
- **Quién:** dueño.
- **Pasos:** Caja → «Corte» → (opcional) «Retirar efectivo» con PIN → «Hacer corte».
- **Debe pasar:** muestra lo vendido por forma de pago; la caja sigue abierta.
- **Capturas:** `48-caja-corte`, `49-caja-corte-resultado`.
- **Pruebe también:** retirar más de lo que hay.

### 3.5 Cierre del dueño
- **Pasos:** Caja → «Cerrar caja» → revisar tarjeta/SINPE contra el datáfono → «Coincide, contar el efectivo» → escribir lo contado → «Cerrar con ¢…».
- **Debe pasar:** muestra esperado, contado y la diferencia. Si la diferencia llega al umbral (¢1.000) pide una nota.
- **Capturas:** `78-cierre-1-revisar-pagos`, `79-cierre-2-contar-efectivo`, `80-cierre-3-resultado`.
- **Pruebe también:** cerrar con ventas en espera (debe avisar que quedan para mañana); cerrar con diferencia grande; cerrar sin escribir nada (cierra en ¢0: revise que se entienda).

### 3.6 Historial de turnos y cierre Z
- **Pasos:** Caja → tabla «Turnos» → clic en un turno.
- **Debe pasar:** el detalle es igual al Z impreso. Si un turno se cerró otro día, la columna «Cerró» muestra también la fecha.
- **Capturas:** `82-caja-cerrada-con-historial`, `83-turno-detalle-z`, `84-turno-detalle-z-abajo`.
- **Pruebe también:** «Reabrir» un turno de hoy (PIN y motivo) y uno de otro día (debe negarse); «Exportar PDF».

### 3.7 Caja que quedó abierta de ayer
- **Cómo provocarlo:** dejar la caja abierta y abrir el programa al día siguiente.
- **Debe pasar:** el menú dice «Abierta desde el AAAA-MM-DD»; no deja vender ni «No venta»; sí deja registrar entradas y salidas y cerrar.
- **Sin captura.**

---

## 4. Venta

### 4.1 Agregar productos
- **Pasos:** tocar una tarjeta, escanear, o escribir nombre o código y Enter. `3*código` agrega 3.
- **Debe pasar:** la línea aparece en el tiquete de la derecha; el mismo producto suma cantidad.
- **Capturas:** `26-venta-vacia`, `27-venta-con-productos`.
- **Pruebe también:** escanear muy rápido el mismo código dos veces; un código que no existe; cantidad 0 o 100.001.

### 4.2 Editar una línea
- **Pasos:** clic en la línea → cambiar cantidad, descuento de línea o «Quitar».
- **Capturas:** `28-venta-linea-abierta`.
- **Pruebe también:** descuento mayor que la línea; quitar una línea cara (queda en bitácora).

### 4.3 Descuento al total
- **Pasos:** «Descuento» (F8) → monto en ¢ o % → Aplicar.
- **Debe pasar:** el tiquete muestra Subtotal, Descuentos y Redondeo. Si pasa el máximo del rol, pide el PIN del dueño.
- **Capturas:** `29-venta-descuento-total`, `36-venta-con-descuento`.
- **Pruebe también:** como cajero, descuento de 50 % (debe pedir PIN); 100 %; cancelar el PIN.

### 4.4 Cliente o nombre en el tiquete
- **Pasos:** «Cliente de contado» (F7) → buscar, crear, o escribir solo un nombre para el tiquete.
- **Capturas:** `30-venta-cliente`.

### 4.5 Venta simple (precio libre)
- **Pasos:** «Venta simple» (F4) → monto, departamento, descripción → Agregar.
- **Capturas:** `31-venta-simple-precio-libre`.
- **Pruebe también:** monto 0; monto enorme.

### 4.6 Cobro en efectivo
- **Pasos:** «Cobrar» (F12) → escribir lo recibido o tocar un billete → «Confirmar cobro» (Enter).
- **Debe pasar:** muestra el vuelto; la venta queda guardada aunque no imprima.
- **Capturas:** `32-cobro-efectivo`, `33-cobro-efectivo-con-vuelto`, `35-venta-cobrada`.
- **Pruebe también:** recibido menor al total (debe decir «Falta»); un cero de más (aviso de vuelto grande); doble clic en Confirmar.

### 4.7 Escanear con el cobro abierto
- **Debe pasar:** la lectura no se toma como monto ni confirma el cobro; sale un aviso.
- **Capturas:** `34-cobro-lectura-de-codigo-ignorada`.

### 4.8 Tarjeta y redondeo
- **Debe pasar:** el redondeo a ¢5 es solo del efectivo. Con un total de ¢3.249, en efectivo se cobra ¢3.250 y con tarjeta ¢3.249; el cobro muestra los dos montos.
- **Capturas:** `37-cobro-redondeo-efectivo`, `38-cobro-tarjeta-exacto`.
- **Pruebe también:** tarjeta por más del total (debe negarse).

### 4.9 SINPE y comprobante repetido
- **Pasos:** en el cobro elegir SINPE Móvil → escribir la referencia → Confirmar.
- **Debe pasar:** si esa referencia ya se usó, avisa en qué tiquete. No bloquea, pero queda en la bitácora.
- **Capturas:** `39-cobro-sinpe-referencia`, `40-cobro-sinpe-comprobante-repetido`.
- **Pruebe también:** SINPE sin referencia (debe negarse).

### 4.10 Pago dividido
- **Pasos:** en el cobro, «Dividir pago» → escribir cuánto va en tarjeta; el efectivo en blanco cubre el resto.
- **Capturas:** `41-cobro-pago-dividido`.
- **Pruebe también:** que la suma no alcance; dos filas de tarjeta; quitar una fila.

### 4.11 Ventas en espera y descartar
- **Pasos:** «+» (F2) abre otra venta; las pestañas muestran cada una con su total. La «X» o «Descartar» la quita.
- **Debe pasar:** al descartar sale un aviso con «Deshacer». Si cierra el programa, las ventas en espera siguen ahí.
- **Capturas:** `42-ventas-en-espera`, `43-venta-descartada-deshacer`.
- **Pruebe también:** descartar y deshacer; cerrar el programa con una venta a medias y volver a abrir.

### 4.12 Sin existencia
- **Cómo provocarlo:** Inventario → Opciones → apagar «Vender aunque no haya existencia». Vender más de lo que hay.
- **Debe pasar:** antes de cobrar sale «No hay suficiente existencia». Al cobrar pide el PIN del dueño; si se cancela, el botón vuelve a «Confirmar cobro».
- **Sin captura.**

---

## 5. Ventas del día

### 5.1 Lista y detalle
- **Pasos:** Ventas del día → clic en un tiquete.
- **Capturas:** `51-ventas-del-dia`, `52-venta-detalle`, `57-ventas-del-dia-con-anulada`.
- **Pruebe también:** buscar por tiquete, producto o monto; filtrar por forma de pago; cambiar el día.

### 5.2 Anular una venta
- **Quién:** dueño.
- **Pasos:** detalle → «Anular venta» → motivo y PIN → «Anular definitivamente».
- **Debe pasar:** queda como «Anulada» (no se borra); el efectivo esperado baja si fue en efectivo; el inventario vuelve.
- **Capturas:** `53-venta-anular`, `54-venta-anulada`.
- **Pruebe también:** anular una venta en efectivo después de sacar ese dinero con una salida (debe negarse: «ya no queda ese efectivo»); anular una venta de un turno cerrado (pide caja abierta hoy y cuánto se devuelve); anular dos veces.

### 5.3 Corregir la forma de pago
- **Pasos:** detalle → «Corregir forma» → forma correcta, motivo y PIN.
- **Capturas:** `55-venta-corregir-forma-de-pago`.
- **Pruebe también:** dejar la misma forma (debe negarse); pasar de efectivo a tarjeta sin efectivo en caja.

### 5.4 Pedir factura y reimprimir
- **Pasos:** detalle → «Pedir factura» → elegir cliente. «Imprimir tiquete» reimprime como COPIA.
- **Capturas:** `56-venta-pedir-factura`, `71-facturas-pendientes`.
- **Sin captura:** marcar la factura como emitida.

---

## 6. Inventario (dueño)

### 6.1 Existencias, ajuste y kardex
- **Capturas:** `58-inventario-existencias`, `67-inventario-ajuste`, `68-inventario-kardex`.
- **Pruebe también:** ajustar a una cantidad negativa; ajustar sin motivo; revisar que cada venta y anulación salga en el kardex.

### 6.2 Entrada de mercadería
- **Pasos:** Inventario → Entrada de mercadería → proveedor y factura (opcionales) → agregar productos → cantidad, costo, precio nuevo → «Guardar entrada».
- **Debe pasar:** la existencia sube. Costo o precio en blanco: el producto conserva el que tiene. La misma factura del mismo proveedor no entra dos veces.
- **Capturas:** `59-inventario-entrada-de-mercadería`, `65-inventario-entrada-guardada`, `66-inventario-factura-repetida`.
- **Pruebe también:** cantidad 0; cambiar el precio de un producto que está en una venta en espera y luego cobrarla.

### 6.3 Conteo físico
- **Pasos:** Conteo físico → «Empezar conteo» → escribir lo contado → «Aplicar conteo» (PIN).
- **Debe pasar:** se guarda solo. Lo que se venda después de contar un producto no cuenta como diferencia.
- **Capturas:** `60-inventario-conteo-físico`.
- **Pruebe también:** contar un producto, venderlo y después aplicar: la existencia final debe ser lo contado menos lo vendido.

### 6.4 Otras pestañas
- Reportes (`61`), Proveedores (`62`), Carga inicial (`63`), Opciones (`64`).

---

## 7. Clientes
- **Pasos:** Clientes → «Nuevo cliente» → datos → marcar el consentimiento → «Guardar cliente».
- **Debe pasar:** sin el consentimiento marcado no guarda.
- **Capturas:** `69-clientes`, `70-cliente-nuevo`.
- **Pruebe también:** como cajero, intentar escribir notas; anonimizar un cliente con factura pendiente (debe negarse).

---

## 8. Administración (dueño)
- Departamentos (`73`), Impresoras (`75`), Caja y cierre (`76`), Respaldo (`77`).
- **Pruebe también:** en Caja y cierre, cambiar el número de tiquete después de la primera venta (debe negarse); en Respaldo, hacer uno, y restaurarlo en otra carpeta o usuario de Windows.
- **Sin captura:** agregar una impresora, imprimir prueba, hacer y restaurar un respaldo.

---

## 9. Lo que ve el cajero
- **Debe pasar:** el menú solo tiene Venta, Caja, Ventas del día y Facturas pendientes. En Caja no ve totales mientras el turno está abierto. El cierre es a ciegas: cuenta, confirma, y recién entonces ve la diferencia.
- **Capturas:** `85-cajero-inicio`, `86-cajero-venta`, `87-cajero-caja-sin-totales`, `88-cajero-cierre-ciego-contar`, `89-cajero-cierre-ciego-confirmar`, `90-cajero-cierre-resultado`.
- **Pruebe también:** que el cajero no pueda anular ni corregir pagos; que no vea ventas de otros cajeros del turno abierto; continuar una venta en espera que dejó otra persona.

---

## 10. Dejar la base limpia para entregar
1. Cierre el programa.
2. Renombre `%APPDATA%\PuntoDeVenta-Datos` a `PuntoDeVenta-Datos.prueba-<fecha>`.
3. Abra el programa: pide crear el técnico otra vez.
4. Configure lo real y revise que «Preparar para el cliente» marque «Sin datos de prueba».

Atajo: antes de la primera venta de prueba haga un respaldo manual; al terminar, restáurelo.
