// Registro local de errores técnicos y archivo de diagnóstico para el técnico.
//
// Nada personal: se anota el origen y el mensaje técnico, recortados, sin caracteres de control y
// con toda secuencia de 6 o más dígitos cambiada por "#" (un teléfono, una cédula o un monto no
// pasan aunque vinieran en el texto). El archivo rota a los 512 KB (queda una copia anterior).
// El diagnóstico lleva versión, base, integridad, bitácora, CONTEOS (nunca nombres ni datos) y las
// últimas líneas del registro.

use crate::bd::Bd;
use crate::sesion::Actor;
use crate::util::Res;
use std::io::Write;
use std::path::Path;

const ARCHIVO: &str = "errores.log";
const MAX_BYTES: u64 = 512 * 1024;

/// Texto seguro para el registro.
pub fn limpiar(s: &str) -> String {
    let t: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).take(400).collect();
    let mut out = String::with_capacity(t.len());
    let mut digitos = String::new();
    for c in t.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_digit() {
            digitos.push(c);
            continue;
        }
        out.push_str(if digitos.len() >= 6 { "#" } else { &digitos });
        digitos.clear();
        out.push(c);
    }
    out.trim_end().to_string()
}

/// Agrega una línea al registro (nunca falla hacia afuera: es un registro, no una operación).
pub fn anotar(dir: &Path, origen: &str, mensaje: &str) {
    let ruta = dir.join(ARCHIVO);
    if std::fs::metadata(&ruta).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&ruta, dir.join("errores.1.log"));
    }
    let linea = format!("{} [{}] {}\n", crate::util::ahora_iso(), limpiar(origen), limpiar(mensaje));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&ruta) {
        let _ = f.write_all(linea.as_bytes());
    }
}

/// Un cierre inesperado de Rust (panic) queda en el registro antes de que el programa se cierre.
pub fn anotar_cierres(dir: &Path) {
    let dir = dir.to_path_buf();
    let anterior = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        anotar(&dir, "panic", &info.to_string());
        anterior(info);
    }));
}

/// Texto del diagnóstico (solo el técnico).
pub async fn exportar(bd: Result<&Bd, &String>, dir: &Path, a: &Actor) -> Res<String> {
    a.exigir("config.tecnica", "exportar el diagnóstico")?;
    let mut t = String::new();
    let mut l = |k: &str, v: String| t.push_str(&format!("{k}: {v}\n"));
    l("Programa", format!("Punto de Venta {}", env!("CARGO_PKG_VERSION")));
    l("Generado", crate::util::ahora_iso());
    l("Sistema", format!("{} {}", std::env::consts::OS, std::env::consts::ARCH));
    l("Carpeta de datos", dir.to_string_lossy().to_string());
    l("Migración que conoce", crate::bd::ultima_migracion().to_string());
    match bd {
        Err(err) => l("Base", format!("NO ABRE: {}", limpiar(err))),
        Ok(b) => {
            let p = &b.pool;
            let q = |sql: &'static str| async move { sqlx::query_scalar::<_, i64>(sql).fetch_one(p).await.map(|n| n.to_string()).unwrap_or_else(|x| limpiar(&x.to_string())) };
            l("Base cifrada", b.cifrada.to_string());
            l("Migración aplicada", q("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations").await);
            let integridad: String = sqlx::query_scalar("PRAGMA quick_check").fetch_one(p).await.unwrap_or_else(|x| x.to_string());
            l("Integridad", limpiar(&integridad));
            let bit = crate::bitacora::verificar(p).await.map(|v| if v.ok { "íntegra".to_string() } else { "ROTA".into() }).unwrap_or_else(|x| limpiar(&x));
            l("Bitácora", bit);
            for (k, sql) in [
                ("Ventas", "SELECT COUNT(*) FROM ventas"),
                ("Turnos", "SELECT COUNT(*) FROM caja_turnos"),
                ("Turnos abiertos", "SELECT COUNT(*) FROM caja_turnos WHERE estado = 'abierto'"),
                ("Productos", "SELECT COUNT(*) FROM productos WHERE eliminado_en IS NULL"),
                ("Clientes (cantidad)", "SELECT COUNT(*) FROM clientes"),
                ("Usuarios activos", "SELECT COUNT(*) FROM usuarios WHERE activo = 1 AND eliminado_en IS NULL"),
                ("Ventas en espera", "SELECT COUNT(*) FROM ventas_espera WHERE eliminado_en IS NULL"),
                ("Impresoras", "SELECT COUNT(*) FROM impresoras WHERE eliminado_en IS NULL"),
            ] {
                l(k, q(sql).await);
            }
        }
    }
    let tam = |n: &str| std::fs::metadata(dir.join(n)).map(|m| format!("{} KB", m.len() / 1024)).unwrap_or_else(|_| "no está".into());
    l("pos.db", tam("pos.db"));
    l("pos.clave", tam("pos.clave"));
    let mut respaldos: Vec<String> = std::fs::read_dir(dir.join("respaldos")).map(|r| r.filter_map(|f| f.ok()).map(|f| f.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    respaldos.sort();
    l("Respaldos", format!("{} (último: {})", respaldos.len(), respaldos.last().cloned().unwrap_or_else(|| "ninguno".into())));
    t.push_str("\n── Últimos errores registrados ──\n");
    let registro = std::fs::read_to_string(dir.join(ARCHIVO)).unwrap_or_default();
    let lineas: Vec<&str> = registro.lines().collect();
    for linea in &lineas[lineas.len().saturating_sub(300)..] {
        t.push_str(linea);
        t.push('\n');
    }
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permisos::Rol;

    #[test]
    fn el_registro_no_guarda_numeros_largos_ni_controles() {
        assert_eq!(limpiar("UNIQUE constraint failed: tel 88881234\u{1b}[31m"), "UNIQUE constraint failed: tel # [31m");
        assert_eq!(limpiar("fila 12 de 345"), "fila 12 de 345");
        assert!(limpiar(&"x".repeat(1000)).len() <= 400);
    }

    #[tokio::test]
    async fn diagnostico_sin_datos_personales_y_registro_que_rota() {
        let dir = std::env::temp_dir().join(format!("pos-diag-{}", crate::util::ulid()));
        let bd = Bd::abrir(&dir, None).await.unwrap();
        let t = crate::usuarios::crear_tecnico_inicial(&bd.pool, "735919").await.unwrap();
        let tec = Actor { id: t.id, rol: Rol::Tecnico, nombre: "T".into() };
        let d = crate::usuarios::crear(&bd.pool, &tec, "Ana", Rol::Dueno, "246813").await.unwrap();
        let dueno = Actor { id: d.id, rol: Rol::Dueno, nombre: "Ana".into() };
        let datos: crate::clientes::Datos = serde_json::from_value(serde_json::json!({"nombre": "Marisol Quesada Pérez", "telefono": "8765-4321", "cedula": "1-0987-0654"})).unwrap();
        crate::clientes::crear(&bd.pool, &dueno, &datos, true, "1").await.unwrap();
        anotar(&dir, "venta_cobrar", "ERROR_TECNICO: database is locked (cliente 87654321)");
        // Solo el técnico.
        assert!(exportar(Ok(&bd), &dir, &dueno).await.unwrap_err().contains("permiso"));
        let txt = exportar(Ok(&bd), &dir, &tec).await.unwrap();
        for dato in ["Marisol", "Quesada", "8765", "87654321", "0987"] {
            assert!(!txt.contains(dato), "el diagnóstico no lleva «{dato}»:\n{txt}");
        }
        for debe in [env!("CARGO_PKG_VERSION"), "Integridad: ok", "Bitácora: íntegra", "Clientes (cantidad): 1", "database is locked"] {
            assert!(txt.contains(debe), "falta «{debe}»:\n{txt}");
        }
        // Rota: un registro enorme pasa a errores.1.log y empieza uno nuevo.
        std::fs::write(dir.join(ARCHIVO), vec![b'x'; (MAX_BYTES + 10) as usize]).unwrap();
        anotar(&dir, "x", "nuevo");
        assert!(dir.join("errores.1.log").exists());
        assert!(std::fs::metadata(dir.join(ARCHIVO)).unwrap().len() < 1000);
        bd.pool.close().await;
        bd.lectura.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
