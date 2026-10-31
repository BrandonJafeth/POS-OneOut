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

/// Minúsculas, sin tildes ni diéresis, espacios simples (igual que normalizar() del frontend).
pub fn normalizar(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars().flat_map(|c| c.to_lowercase()) {
        let c = match c {
            'á' | 'à' | 'ä' | 'â' | 'ã' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
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
    let t = v.trim();
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

#[cfg(test)]
mod tests {
    use super::*;

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
