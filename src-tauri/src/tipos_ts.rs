// Tipos de TypeScript generados desde Rust (ts-rs) para los comandos nuevos: src/generados/*.ts.
// `cargo test` los escribe; si cambiaron, la prueba falla una vez (para que el cambio se vea y se
// suba junto con el Rust). Los montos son colones enteros (i64, muy por debajo de 2^53): `number`.
use std::path::Path;
use ts_rs::TS;

fn escribir<T: TS + 'static>(dir: &Path, cambiados: &mut Vec<String>) {
    let mut deps: Vec<String> = T::dependencies().into_iter().map(|d| d.ts_name).filter(|n| *n != T::name()).map(|n| format!("import type {{ {n} }} from \"./{n}\";\n")).collect();
    deps.sort();
    deps.dedup();
    let texto = format!("// Generado desde Rust (src-tauri/src/tipos_ts.rs). No editar a mano.\n{}export {}\n", deps.concat(), T::decl().replace("bigint", "number"));
    let ruta = dir.join(format!("{}.ts", T::name()));
    if std::fs::read_to_string(&ruta).ok().as_deref() != Some(texto.as_str()) {
        std::fs::write(&ruta, &texto).unwrap();
        cambiados.push(T::name());
    }
}

#[test]
fn tipos_de_typescript_al_dia() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generados");
    std::fs::create_dir_all(&dir).unwrap();
    let mut c = vec![];
    use crate::cuentas::*;
    escribir::<Reglas>(&dir, &mut c);
    escribir::<CuentaFila>(&dir, &mut c);
    escribir::<CuentaLinea>(&dir, &mut c);
    escribir::<AbonoFila>(&dir, &mut c);
    escribir::<EventoFila>(&dir, &mut c);
    escribir::<CuentaDetalle>(&dir, &mut c);
    escribir::<ResultadoAbono>(&dir, &mut c);
    assert!(c.is_empty(), "Tipos de TS actualizados (revise y suba src/generados): {c:?}");
}
