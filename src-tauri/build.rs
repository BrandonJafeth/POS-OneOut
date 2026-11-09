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
    tauri_build::build()
}
