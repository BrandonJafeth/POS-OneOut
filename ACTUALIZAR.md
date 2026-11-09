# Actualizar el Punto de Venta sin perder datos

De la versión de prueba (0.9.0) a la final (1.0.0), o de cualquier versión a una mayor. Hágalo al final del
día, con calma, con la caja cerrada. Lleve una memoria USB y el instalador nuevo con su SHA-256 (ENTREGAS.md).

**Dónde están los datos:** `%APPDATA%\PuntoDeVenta-Datos` (base `pos.db`, clave `pos.clave`, carpeta
`respaldos`). El instalador y el desinstalador no tocan esa carpeta.

## Antes

1. **Caja cerrada.** Cierre la caja con su conteo e imprima el Z. Con una caja abierta, la versión nueva no
   actualiza la base: avisa y pide volver a la anterior para cerrarla.
2. **Anote los conteos de «antes»** (para comparar después). Como técnico, en **Técnico → Sistema** pulse
   **Exportar diagnóstico**: el archivo de Descargas trae ventas, turnos, productos, clientes (cantidad),
   usuarios y la migración. Guárdelo.
3. **Respaldo manual.** Como dueño, **Administración → Respaldo → Crear respaldo** (o «Hacer uno ahora» del
   automático). Debe decir que quedó verificado.
4. **Copia a la USB.** Copie la carpeta `%APPDATA%\PuntoDeVenta-Datos\respaldos` entera a la USB.
5. **Guarde el instalador viejo** en la USB (para volver atrás si hace falta).
6. **Verifique el instalador nuevo:** en PowerShell, `Get-FileHash .\Punto*Setup.exe -Algorithm SHA256`, y
   compare con ENTREGAS.md. Si no coincide, no lo instale.

## Instalar

7. Cierre el Punto de Venta. Ejecute el instalador nuevo **encima** del anterior (no desinstale). Si
   Windows muestra «Windows protegió su PC»: **Más información → Ejecutar de todas formas** (el instalador no
   está firmado). No desactive el antivirus.
8. Abra el programa. Al arrancar:
   - Si había migraciones nuevas, antes copia la base a `respaldos-automaticos\pos-antes-vN-<fecha>.db`
     y después la pone al día (cada migración en su transacción).
   - Si los datos estaban en la carpeta vieja de una versión anterior (`%APPDATA%\cr.puntodeventa.pos`),
     los traslada solos a `%APPDATA%\PuntoDeVenta-Datos`.

## Verificar

9. **Acerca de** (menú, abajo): la versión es la nueva.
10. Entre con el PIN de cada usuario.
11. **Técnico → Sistema:** base «Cifrada», bitácora «Verificar ahora» → «Íntegra».
12. **Exportar diagnóstico** otra vez y compare con el de «antes»: ventas, turnos, productos, clientes y
    usuarios iguales; la migración sube.
13. **Caja → Turnos:** está el último Z. **Ventas del día / Inventario:** todo como estaba.
14. Abra la caja, venda algo de ¢5 en efectivo, anúlelo (PIN del dueño) y cierre. El tiquete y la gaveta
    funcionan.
15. **Administración → Respaldo:** haga un respaldo y vea que queda verificado.

## Si algo sale mal: volver a la versión anterior

1. Cierre el programa. Anote el mensaje que salió (o exporte el diagnóstico si abre como técnico).
2. Instale el instalador viejo (el de la USB).
3. La versión vieja no abre una base que ya se actualizó (dice «versión más nueva»). Vaya a
   `%APPDATA%\PuntoDeVenta-Datos`, renombre `pos.db` a `pos.db.fallida` (no la borre) y copie ahí la copia
   `respaldos-automaticos\pos-antes-vN-<fecha>.db` con el nombre `pos.db`.
4. Abra el programa y verifique como en los pasos 9–15.
5. Si eso tampoco abre: en la pantalla de error use **Restaurar desde respaldo** con el respaldo de la USB y
   su contraseña.
6. Avise al técnico con el diagnóstico.

## Reglas para el desarrollador (cada versión nueva)

- Nunca editar una migración existente; las nuevas, desde la 13, sin `DROP TABLE` ni `DELETE FROM` (la
  prueba `tests/migraciones.test.ts` lo exige). Columnas nuevas con valor por defecto.
- No cambiar el `identifier` (`build.rs` lo frena) ni `CARPETA_DATOS`.
- Generar el fixture de la versión que se está reemplazando y agregarlo a `tests/fixtures`:
  `cargo test --lib generar_fixture -- --ignored` (no pisa uno existente). Los fixtures viejos no se borran.
- Subir la versión en `package.json`, `src-tauri/Cargo.toml` y `src-tauri/tauri.conf.json`.
- `cargo test --lib`, `npm test`, `npx tsc --noEmit` y `npm run tauri build`; SHA-256 a ENTREGAS.md.
