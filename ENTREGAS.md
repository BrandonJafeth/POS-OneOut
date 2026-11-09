# Entregas

Cada instalador entregado, con su SHA-256. Antes de instalar, compare (PowerShell, en la carpeta del instalador):

```powershell
Get-FileHash ".\Punto de Venta_0.9.0_x64-setup.exe" -Algorithm SHA256
```

Si el hash no coincide, **no lo instale**: avise al técnico. Los instaladores no están firmados; Windows
SmartScreen avisa «Windows protegió su PC» → **Más información → Ejecutar de todas formas**. No desactive el
antivirus.

## 0.9.0 — versión de prueba en el negocio (2026-11-09)

| | |
|---|---|
| Archivo | `Punto de Venta_0.9.0_x64-setup.exe` (NSIS, por usuario, 4,28 MiB) |
| SHA-256 | `d504141d8b79547ac0af811c1ad184a12e837de172cefac02f92236d7ca99981` |
| Migraciones | 1 a 12 |
| Respaldo | `POSBAK02` (fixture `tests/fixtures/respaldo-v0.9.0-m12.posbak`) |
| Pruebas | `cargo test --lib` 114 ok (1 ignorada: genera fixture) · `npm test` 167 ok · `tsc` sin errores |

Cambios principales desde 0.1.0:
- Datos en `%APPDATA%\PuntoDeVenta-Datos` (el desinstalador no los borra); traslado automático desde la carpeta vieja.
- Inventario (existencias, entradas, ajustes, kardex, mínimos, reportes).
- Respaldo automático diario y al cerrar turno, verificado, con rotación y recordatorio de USB.
- «Restaurar desde respaldo» cuando la base no abre; nunca crea una base vacía encima de una instalación.
- Migraciones que no se rompen por saltos de línea (CRLF/LF).
- Una sola instancia, reloj revisado al cobrar y cerrar, impresora trabada no bloquea la caja.
- Número inicial de tiquete configurable antes de la primera venta.
- Registro local de errores y «Exportar diagnóstico»; «Preparar para el cliente».
- El técnico ya no consulta ventas (datos de clientes, Ley 8968).
- PDF y tiquetes rediseñados; pantallas adaptadas a pantallas pequeñas.
