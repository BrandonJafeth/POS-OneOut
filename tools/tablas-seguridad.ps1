# Regenera las tablas de permisos de SEGURIDAD.md desde el catálogo (acciones.rs).
# La prueba permisos_tests::seguridad_md_igual_al_catalogo falla si quedan distintas.
$env:PATH = "C:\Strawberry\perl\bin;$env:PATH"
$env:POS_GENERAR_SEGURIDAD = "1"
Set-Location (Join-Path $PSScriptRoot "..\src-tauri")
cargo test --lib seguridad_md_igual_al_catalogo
