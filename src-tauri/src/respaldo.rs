// Respaldo cifrado de la base (contiene datos personales: Ley 8968).
//
// Formato del archivo .posbak:
//   "POSBAK01" (8 bytes) | sal (32) | nonce (12) | datos cifrados + etiqueta (AES-256-GCM)
// La clave de 32 bytes (AES-256) sale de la contraseña con Argon2id y la sal aleatoria.
// GCM además autentica: con una contraseña equivocada o un archivo alterado, descifrar falla
// en vez de devolver basura.

use aes_gcm::aead::{Aead, Generate, Key, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::Argon2;

const MAGIA: &[u8; 8] = b"POSBAK01";
const LARGO_SAL: usize = 32;
const LARGO_NONCE: usize = 12;
pub const CONTRASENA_MINIMA: usize = 8;

fn clave(contrasena: &str, sal: &[u8]) -> Result<Key<Aes256Gcm>, String> {
    let mut k = Key::<Aes256Gcm>::default();
    Argon2::default()
        .hash_password_into(contrasena.as_bytes(), sal, &mut k)
        .map_err(|e| format!("No se pudo derivar la clave: {e}"))?;
    Ok(k)
}

pub fn validar_contrasena(contrasena: &str) -> Result<(), String> {
    if contrasena.chars().count() < CONTRASENA_MINIMA {
        return Err(format!("El respaldo necesita una contraseña de al menos {CONTRASENA_MINIMA} caracteres"));
    }
    Ok(())
}

pub fn cifrar(datos: &[u8], contrasena: &str) -> Result<Vec<u8>, String> {
    validar_contrasena(contrasena)?;
    // 32 bytes aleatorios del generador del sistema, usados como sal.
    let sal = Key::<Aes256Gcm>::generate();
    let nonce = Nonce::generate();
    let cifrado = Aes256Gcm::new(&clave(contrasena, &sal)?)
        .encrypt(&nonce, datos)
        .map_err(|_| "No se pudo cifrar el respaldo".to_string())?;
    let mut out = Vec::with_capacity(MAGIA.len() + LARGO_SAL + LARGO_NONCE + cifrado.len());
    out.extend_from_slice(MAGIA);
    out.extend_from_slice(&sal);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&cifrado);
    Ok(out)
}

// Hoy solo lo usan las pruebas; queda listo para la pantalla de restauración.
#[cfg_attr(not(test), allow(dead_code))]
pub fn descifrar(archivo: &[u8], contrasena: &str) -> Result<Vec<u8>, String> {
    let cab = MAGIA.len() + LARGO_SAL + LARGO_NONCE;
    if archivo.len() < cab || &archivo[..MAGIA.len()] != MAGIA {
        return Err("No es un respaldo del POS".into());
    }
    let sal = &archivo[MAGIA.len()..MAGIA.len() + LARGO_SAL];
    let nonce = Nonce::try_from(&archivo[MAGIA.len() + LARGO_SAL..cab]).map_err(|_| "Respaldo dañado".to_string())?;
    Aes256Gcm::new(&clave(contrasena, sal)?)
        .decrypt(&nonce, &archivo[cab..])
        .map_err(|_| "Contraseña incorrecta o respaldo dañado".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_contrasena_no_hay_respaldo() {
        assert!(cifrar(b"datos", "").is_err());
        assert!(cifrar(b"datos", "corta").is_err());
    }

    #[test]
    fn ida_y_vuelta() {
        let datos = b"SQLite format 3\0 ... cliente Ana 8888-8888";
        let c = cifrar(datos, "contrasena-larga").unwrap();
        assert!(c.starts_with(MAGIA));
        // El contenido no aparece en claro dentro del archivo.
        assert!(!c.windows(4).any(|w| w == b"8888"));
        assert_eq!(descifrar(&c, "contrasena-larga").unwrap(), datos);
    }

    #[test]
    fn contrasena_equivocada_o_archivo_alterado() {
        let mut c = cifrar(b"hola mundo", "contrasena-larga").unwrap();
        assert!(descifrar(&c, "otra-contrasena").is_err());
        let ultimo = c.len() - 1;
        c[ultimo] ^= 1;
        assert!(descifrar(&c, "contrasena-larga").is_err());
        assert!(descifrar(b"basura", "contrasena-larga").is_err());
    }
}
