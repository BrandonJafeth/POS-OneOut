# Prompt para pedir el manual en PDF

Adjunte `FLUJOS.md` y las imágenes de `capturas/` que correspondan (si no caben todas, mándelas por
sección: 1–2, 3, 4, 5–9) y pegue esto:

---

Sos redactor de manuales de software. Te paso `FLUJOS.md`, que describe cada flujo de un punto de
venta de escritorio para librerías pequeñas de Costa Rica, y las capturas de pantalla de la app.

Haceme un manual de pruebas en PDF, en español de Costa Rica, para que yo (el desarrollador) lo
siga paso a paso y encuentre errores antes de entregarle el programa al cliente.

Requisitos:

1. Una sección por flujo, en el mismo orden y con la misma numeración de `FLUJOS.md`.
2. En cada flujo: quién lo hace, los pasos numerados, la captura que corresponde justo después del
   paso que muestra, y un recuadro «Debe pasar» con el resultado esperado.
3. Después, una tabla de casos de prueba con lo que dice «Pruebe también»: columnas «Caso», «Qué
   debe pasar», «¿Pasó? (sí / no)» y «Notas», con espacio para escribir a mano.
4. Cada captura lleva debajo su nombre de archivo, para poder ubicarla. No inventés capturas: si un
   flujo dice «Sin captura», dejalo solo con texto.
5. No inventés funciones, botones ni textos que no estén en `FLUJOS.md` o en las capturas. Si algo
   no queda claro, anotalo en una lista final «Dudas para el desarrollador».
6. Al inicio, una página con los datos de prueba (usuarios, productos) y una lista de control de
   todos los flujos con casilla.
7. Al final, una hoja «Errores encontrados» con columnas: número de flujo, qué hice, qué esperaba,
   qué pasó, gravedad.
8. Formato: A4, letra legible, capturas a lo ancho de la página, cada flujo empieza en página nueva.

Las capturas muestran «No se imprimió el tiquete» y «La gaveta no abrió» porque se tomaron sin
impresora: aclaralo una vez al inicio y no lo tratés como error.
