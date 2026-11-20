# Prueba de punta a punta (e2e)

`npm run e2e` compila la app de desarrollo y recorre, en la app real (Rust, base cifrada, WebView2):
crear apartado → abonar y liquidar → cierre Z → reporte. Usa una carpeta de datos nueva, una semilla y
el reloj fijo (solo existen en la compilación de desarrollo).

Para correrla varias veces seguidas sin volver a compilar:

```powershell
npm run e2e:build                      # una vez
1..10 | % { node tests/e2e/apartado.e2e.mjs; if ($LASTEXITCODE) { "falló la vuelta $_"; break } }
```

## Requisitos (una vez por PC de desarrollo)

1. **tauri-driver**: `cargo install tauri-driver` (queda en `%USERPROFILE%\.cargo\bin`).
2. **msedgedriver de la MISMA versión que WebView2**, en `tools\msedgedriver\msedgedriver.exe`
   (carpeta ignorada por git):
   - Versión de WebView2 de la PC: «Preparar para el cliente» la muestra, o en PowerShell
     `(Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}').pv`.
   - Descargue el «x64» de esa versión exacta en
     <https://developer.microsoft.com/microsoft-edge/tools/webdriver/> y descomprima su contenido en
     `tools\msedgedriver\`.
   - Cuando Windows Update suba WebView2, baje el driver nuevo (si no coinciden, la prueba no arranca).
   - Otra ubicación: variable `MSEDGEDRIVER` con la ruta completa del `.exe`.

`CAPTURAS=<carpeta>` guarda una imagen de cada pantalla clave (revisión visual).
