// NO CAMBIAR el identifier de tauri.conf.json: Windows lo usa para la instalación, el
// desinstalador y los datos de la ventana. Cambiarlo hace que la versión nueva se instale como
// OTRO programa (el cliente vería una app vacía y el desinstalador viejo quedaría suelto).
// Este chequeo frena el build si alguien lo cambia sin querer.
const IDENTIFIER: &str = "cr.puntodeventa.pos";

fn main() {
    let conf = std::fs::read_to_string("tauri.conf.json").expect("no se pudo leer tauri.conf.json");
    let esperado = format!("\"identifier\": \"{IDENTIFIER}\"");
    assert!(
        conf.contains(&esperado),
        "NO CAMBIAR el identifier (debe ser {IDENTIFIER}): la versión nueva se instalaría como otro programa y el cliente perdería de vista sus datos."
    );
    println!("cargo:rerun-if-changed=tauri.conf.json");

    // Ningún instalador repite número de versión: si ENTREGAS.md ya registró un instalador con esta
    // versión (tiene su SHA-256), el build de release (el del instalador) se frena. Los builds de
    // desarrollo y las pruebas no se frenan.
    println!("cargo:rerun-if-changed=../ENTREGAS.md");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let version = std::env::var("CARGO_PKG_VERSION").unwrap();
        let entregas = std::fs::read_to_string("../ENTREGAS.md").unwrap_or_default();
        assert!(
            !version_entregada(&entregas, &version),
            "La versión {version} ya se entregó (ENTREGAS.md tiene su SHA-256). Suba la versión en tauri.conf.json, Cargo.toml y package.json."
        );
    }
    // Manifiesto de Windows (Common Controls v6) puesto por el enlazador y no por tauri_build: así
    // también lo lleva el ejecutable de pruebas, que con el runtime simulado de Tauri (tabla_comandos)
    // no arranca sin él (STATUS_ENTRYPOINT_NOT_FOUND). Es el mismo manifiesto que pone tauri_build.
    let mut attrs = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
        attrs = attrs.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attrs).expect("tauri_build")
}

/// La sección "## X.Y.Z — …" de ENTREGAS.md ya tiene un SHA-256 escrito (64 hex).
fn version_entregada(entregas: &str, version: &str) -> bool {
    let titulo = format!("## {version} ");
    let Some(i) = entregas.find(&titulo) else { return false };
    let seccion = &entregas[i + titulo.len()..];
    let seccion = &seccion[..seccion.find("\n## ").unwrap_or(seccion.len())];
    seccion.lines().any(|l| l.contains("SHA-256") && l.split('`').any(|p| p.len() == 64 && p.chars().all(|c| c.is_ascii_hexdigit())))
}
