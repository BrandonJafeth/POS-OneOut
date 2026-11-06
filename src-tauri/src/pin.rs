// Hash y verificación de PIN con Argon2id.
//
// El hash es un texto "PHC" ($argon2id$v=19$m=...,t=...,p=...$sal$hash) que ya trae
// adentro la sal aleatoria y los parámetros: no hay que guardar nada aparte.
// El límite de intentos y la espera se manejan en usuarios.rs (quedan guardados
// en la base, así no se reinician cerrando la app).

use argon2::password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier};
use argon2::Argon2;

pub fn hash(pin: &str) -> Result<String, String> {
    Argon2::default()
        .hash_password(pin.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| format!("No se pudo generar el hash: {e}"))
}

/// true si el PIN corresponde al hash. Un hash dañado cuenta como PIN incorrecto.
pub fn verificar(pin: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(h) => Argon2::default().verify_password(pin.as_bytes(), &h).is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_y_verificacion() {
        let h = hash("1234").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verificar("1234", &h));
        assert!(!verificar("1235", &h));
        assert!(!verificar("", &h));
    }

    #[test]
    fn sal_distinta_cada_vez() {
        // El mismo PIN da hashes distintos (sal aleatoria), pero ambos verifican.
        let a = hash("0000").unwrap();
        let b = hash("0000").unwrap();
        assert_ne!(a, b);
        assert!(verificar("0000", &a) && verificar("0000", &b));
    }

    #[test]
    fn hash_danado() {
        assert!(!verificar("1234", "no-es-un-hash"));
    }
}
