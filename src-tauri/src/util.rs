// Utilidades compartidas: errores, ULID, fechas y normalización de texto.

use chrono::{Local, Utc};

pub type Res<T> = Result<T, String>;

/// Convierte cualquier error en texto para el frontend.
/// Error técnico (base de datos, archivo, sistema). Lleva una marca para que la pantalla muestre
/// un mensaje general ("contacte al administrador") y el detalle solo al técnico.
pub const TECNICO: &str = "ERROR_TECNICO: ";

pub fn e<E: std::fmt::Display>(err: E) -> String {
    format!("{TECNICO}{err}")
}

/// ¢1.825 (igual que monto() de la pantalla), para mensajes.
pub fn colones(n: i64) -> String {
    let s = n.abs().to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push('.');
        }
        out.push(c);
    }
    format!("{}¢{out}", if n < 0 { "-" } else { "" })
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// ULID: 48 bits de tiempo (ms) + 80 bits aleatorios, en Crockford base32 (26 caracteres).
pub fn ulid() -> String {
    let ms = Utc::now().timestamp_millis().max(0) as u64;
    let mut azar = [0u8; 16];
    getrandom::getrandom(&mut azar).expect("sin fuente de azar del sistema");
    let mut s = String::with_capacity(26);
    for i in (0..10).rev() {
        s.push(CROCKFORD[((ms >> (i * 5)) & 31) as usize] as char);
    }
    for b in azar {
        s.push(CROCKFORD[(b & 31) as usize] as char);
    }
    s
}

/// "2026-10-29T18:00:00.123Z" (mismo formato que usa el frontend).
pub fn ahora_iso() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Día local "AAAA-MM-DD" (la jornada de la caja, en la hora de la computadora).
pub fn dia_local() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Caracteres invisibles que no tienen nada que hacer en un texto: control (C0/C1, incluido ESC),
/// ancho cero y marcas de dirección (pueden disfrazar un nombre).
pub fn invisible(c: char) -> bool {
    c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
}

/// Tilde "suelta" (Unicode descompuesto, como llega al copiar de una web o de una Mac: e + ◌́).
fn marca(c: char) -> bool {
    ('\u{0300}'..='\u{036f}').contains(&c)
}

/// Minúsculas, sin tildes ni diéresis, espacios simples (igual que normalizar() del frontend, que
/// quita toda marca con NFD): sirve para buscar, así que las dos tienen que dar lo mismo.
pub fn normalizar(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars().flat_map(|c| c.to_lowercase()) {
        let c = match c {
            c if marca(c) => continue,
            c if invisible(c) => ' ',
            'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ý' | 'ÿ' => 'y',
            'ñ' => 'n',
            'ç' => 'c',
            otro => otro,
        };
        out.push(c);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Texto con largo máximo; recorta espacios. Error si queda vacío y es obligatorio.
pub fn texto(v: &str, max: usize, campo: &str, obligatorio: bool) -> Res<String> {
    // Sin caracteres de ancho cero ni marcas de dirección, y sin espacios repetidos (los saltos de
    // línea de una nota se respetan). Así "Ana  Mora" y "Ana Mora" son el mismo nombre.
    let limpio: String = v.chars().filter(|c| *c == '\n' || c.is_control() || !invisible(*c)).collect();
    let limpio = limpio.split('\n').map(|l| l.split([' ', '\t']).filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ")).collect::<Vec<_>>().join("\n");
    let t = limpio.trim();
    if obligatorio && t.is_empty() {
        return Err(format!("Escriba {campo}"));
    }
    if t.chars().count() > max {
        return Err(format!("{campo}: máximo {max} caracteres"));
    }
    if t.chars().any(|c| c.is_control() && c != '\n') {
        return Err(format!("{campo}: tiene caracteres no permitidos"));
    }
    Ok(t.to_string())
}

/// Error "Ya existe {que} «X»" si otra fila viva de `tabla` tiene el mismo nombre ("Adrián Pérez",
/// "adrian  perez" y "ADRIÁN PÉREZ" son el mismo). Llamarla DENTRO de la transacción que inserta
/// (BEGIN IMMEDIATE): así un doble clic no pasa la revisión dos veces antes de guardar.
/// `tabla` es siempre un literal del código, nunca algo que llegue de la pantalla.
pub async fn nombre_libre(c: &mut sqlx::SqliteConnection, tabla: &'static str, nombre: &str, excluir: &str, que: &str) -> Res<()> {
    let buscado = normalizar(nombre);
    let filas: Vec<(String, String)> = sqlx::query_as(&format!("SELECT id, nombre FROM {tabla} WHERE eliminado_en IS NULL")).fetch_all(&mut *c).await.map_err(e)?;
    match filas.into_iter().find(|(id, n)| id != excluir && normalizar(n) == buscado) {
        Some((_, n)) => Err(format!("Ya existe {que} «{n}». Use otro nombre o edite el que ya está.")),
        None => Ok(()),
    }
}

/// Subcarpeta "AAAA-MM": la ventana solo elige el mes, nunca una ruta.
pub fn mes_valido(m: &str) -> Res<&str> {
    let b = m.as_bytes();
    let ok = b.len() == 7 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit());
    if ok { Ok(m) } else { Err(format!("{TECNICO}Mes no válido: {m}")) }
}

/// Carpetas fijas de documentos exportados: la ventana elige una de la lista, nunca una ruta.
pub fn carpeta_valida(c: &str) -> Res<&str> {
    if matches!(c, "Cierres de caja" | "Inventario" | "Clientes") { Ok(c) } else { Err(format!("{TECNICO}Carpeta no válida: {c}")) }
}

/// Guarda en `dir` un archivo que armó la app (PDF del cierre, CSV) sin pisar uno existente
/// ("x (1).pdf"). Solo un nombre simple .pdf/.csv: la ventana no elige carpetas ni extensiones.
pub fn guardar_en(dir: &std::path::Path, nombre: &str, datos: &[u8]) -> Res<String> {
    let simple = !nombre.is_empty() && nombre.len() <= 120 && !nombre.starts_with('.') && !nombre.chars().any(|c| c.is_control() || "/\\:*?\"<>|".contains(c));
    let Some((base, ext)) = nombre.rsplit_once('.').filter(|(_, x)| matches!(*x, "pdf" | "csv" | "txt")) else {
        return Err(format!("{TECNICO}Archivo no permitido: {nombre}"));
    };
    if !simple {
        return Err(format!("{TECNICO}Archivo no permitido: {nombre}"));
    }
    if datos.len() > 50_000_000 {
        return Err("El archivo es demasiado grande".into());
    }
    std::fs::create_dir_all(dir).map_err(e)?;
    let mut ruta = dir.join(nombre);
    let mut n = 1;
    while ruta.exists() {
        ruta = dir.join(format!("{base} ({n}).{ext}"));
        n += 1;
    }
    std::fs::write(&ruta, datos).map_err(|err| format!("No se pudo guardar {}: {err}", ruta.display()))?;
    Ok(ruta.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mismos casos que tests/texto.test.ts: la búsqueda solo funciona si las dos dan lo mismo.
    #[test]
    fn normalizar_igual_que_la_pantalla_y_nombres_limpios() {
        for (entrada, esperado) in [
            ("Café Ñandú", "cafe nandu"),
            ("Cafe\u{301} N\u{303}andu\u{301}", "cafe nandu"), // tildes sueltas (copiado de una web o Mac)
            ("  LÁPIZ   2B ", "lapiz 2b"),
            ("Ana\u{200b}Mora", "ana mora"),
            ("Pingüino Ýoyo", "pinguino yoyo"),
        ] {
            assert_eq!(normalizar(entrada), esperado, "{entrada:?}");
        }
        assert_eq!(texto("  Ana \u{200b} \t Mora ", 60, "nombre", true).unwrap(), "Ana Mora");
        assert_eq!(texto("línea  uno\nlínea   dos", 200, "nota", false).unwrap(), "línea uno\nlínea dos");
        assert!(texto("\u{200b}\u{feff} ", 60, "el nombre", true).unwrap_err().contains("Escriba"));
        assert!(texto("a\u{1b}b", 60, "nombre", true).is_err());
    }

    #[test]
    fn guardar_sin_pisar_y_solo_nombres_simples() {
        let dir = std::env::temp_dir().join(format!("pos-descargas-{}", ulid()));
        let a = guardar_en(&dir, "cierre.pdf", b"uno").unwrap();
        let b = guardar_en(&dir, "cierre.pdf", b"dos").unwrap();
        assert!(b.ends_with("cierre (1).pdf"));
        assert_eq!(std::fs::read(&a).unwrap(), b"uno");
        for malo in ["../x.pdf", "a\\b.pdf", "x.exe", "x.pdf.bat", ".pdf", "C:x.csv"] {
            assert!(guardar_en(&dir, malo, b"x").is_err(), "{malo}");
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(mes_valido("2026-11").unwrap(), "2026-11");
        for malo in ["2026-1", "..\\..\\x", "2026/11", "abcd-ef", "2026-11-01"] {
            assert!(mes_valido(malo).is_err(), "{malo}");
        }
        assert!(carpeta_valida("Inventario").is_ok());
        assert!(carpeta_valida("..\\Windows").is_err());
    }

    #[test]
    fn ulid_y_normalizar() {
        let a = ulid();
        assert_eq!(a.len(), 26);
        assert!(a.chars().all(|c| CROCKFORD.contains(&(c as u8))));
        assert_eq!(normalizar("  Lápiz  HB Ñandú "), "lapiz hb nandu");
    }

    #[test]
    fn validaciones() {
        assert!(texto("", 10, "el nombre", true).is_err());
        assert!(texto("abc\u{1b}d", 10, "x", false).is_err());
    }
}
