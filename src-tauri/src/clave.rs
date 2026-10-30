// Clave de cifrado de la base (SQLCipher), protegida con DPAPI de Windows.
//
// La clave son 32 bytes aleatorios. Nunca está en el código ni en el repositorio: se genera la
// primera vez y se guarda en "pos.clave" CIFRADA con DPAPI, atada al usuario de Windows. Solo ese
// usuario, en esa computadora, puede descifrarla. Si se pierde el usuario o se reinstala Windows,
// la base se recupera con un respaldo y su contraseña (ver SEGURIDAD.md).

use crate::util::{e, Res};
use std::path::Path;

const ARCHIVO: &str = "pos.clave";

#[cfg(windows)]
mod dpapi {
    use crate::util::Res;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(d: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: d.len() as u32, pbData: d.as_ptr() as *mut u8 }
    }

    /// Copia el resultado de Windows y libera su memoria.
    unsafe fn tomar(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe { LocalFree(Some(HLOCAL(out.pbData as *mut _))) };
        v
    }

    pub fn proteger(datos: &[u8]) -> Res<Vec<u8>> {
        let entrada = blob(datos);
        let mut salida = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(&entrada, windows::core::w!("POS"), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut salida)
                .map_err(|e| format!("DPAPI no pudo proteger la clave: {}", e.message()))?;
            Ok(tomar(salida))
        }
    }

    pub fn desproteger(datos: &[u8]) -> Res<Vec<u8>> {
        let entrada = blob(datos);
        let mut salida = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(&entrada, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut salida).map_err(|_| {
                "No se pudo abrir la clave de la base: este usuario de Windows no es el que instaló la app. Restaure un respaldo.".to_string()
            })?;
            Ok(tomar(salida))
        }
    }
}

#[cfg(not(windows))]
mod dpapi {
    use crate::util::Res;
    pub fn proteger(_: &[u8]) -> Res<Vec<u8>> {
        Err("El cifrado de la base solo está disponible en Windows".into())
    }
    pub fn desproteger(_: &[u8]) -> Res<Vec<u8>> {
        Err("El cifrado de la base solo está disponible en Windows".into())
    }
}

/// Devuelve la clave de la base (la crea la primera vez).
pub fn obtener(dir: &Path) -> Res<[u8; 32]> {
    let ruta = dir.join(ARCHIVO);
    if ruta.exists() {
        let protegida = std::fs::read(&ruta).map_err(e)?;
        let v = dpapi::desproteger(&protegida)?;
        return v.try_into().map_err(|_| "La clave de la base está dañada".to_string());
    }
    let mut k = [0u8; 32];
    getrandom::getrandom(&mut k).map_err(e)?;
    let protegida = dpapi::proteger(&k)?;
    std::fs::create_dir_all(dir).map_err(e)?;
    std::fs::write(&ruta, protegida).map_err(e)?;
    Ok(k)
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn dpapi_ida_y_vuelta() {
        let p = super::dpapi::proteger(b"secreto").unwrap();
        assert_ne!(p, b"secreto");
        assert_eq!(super::dpapi::desproteger(&p).unwrap(), b"secreto");
    }
}
