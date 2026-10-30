// Impresión RAW por el spooler de Windows.
//
// "RAW" significa que Windows NO interpreta los bytes: el driver los pasa tal cual a la
// impresora. Así los comandos ESC/POS (negrita, código de barras, gaveta…) llegan intactos.
//
// Todo lo de Windows está dentro de `#[cfg(windows)]`: ese código solo se compila en Windows.
// En otro sistema operativo se compila la versión de abajo, que devuelve un error claro.

#[cfg(windows)]
mod imp {
    use windows::core::{HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Foundation::GetLastError;
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW, StartDocPrinterW,
        StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
        PRINTER_HANDLE, PRINTER_INFO_4W,
    };

    /// Las APIs de Windows usan texto UTF-16 terminado en 0 ("wide strings").
    /// Esta función convierte un String de Rust a ese formato.
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Lee GetLastError() y lo convierte en un mensaje legible (en el idioma de Windows).
    fn last_error(paso: &str) -> String {
        // `unsafe`: Rust no puede garantizar nada de las funciones de Windows, así que
        // hay que marcarlas explícitamente. Estas llamadas son seguras si se usan como dice la doc.
        let code = unsafe { GetLastError() };
        let msg = HRESULT::from_win32(code.0).message();
        format!("{paso} falló (código {}): {}", code.0, msg.trim())
    }

    pub fn list_printers() -> Result<Vec<String>, String> {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed = 0u32;
        let mut returned = 0u32;
        unsafe {
            // 1ª llamada sin buffer: Windows responde cuántos bytes necesita (y da "error" de
            // buffer insuficiente, que es lo esperado, por eso se ignora).
            let _ = EnumPrintersW(flags, PCWSTR::null(), 4, None, &mut needed, &mut returned);
            if needed == 0 {
                return Ok(Vec::new()); // no hay impresoras
            }
            let mut buf = vec![0u8; needed as usize];
            EnumPrintersW(flags, PCWSTR::null(), 4, Some(&mut buf), &mut needed, &mut returned)
                .map_err(|e| format!("EnumPrintersW falló: {}", e.message()))?;

            // El buffer contiene `returned` estructuras PRINTER_INFO_4W seguidas; cada una
            // apunta a su nombre (también dentro del buffer).
            let infos = std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, returned as usize);
            Ok(infos
                .iter()
                .filter(|i| !i.pPrinterName.is_null())
                .map(|i| i.pPrinterName.to_string().unwrap_or_default())
                .collect())
        }
    }

    pub fn print_raw(printer_name: &str, data: &[u8]) -> Result<(), String> {
        if data.is_empty() {
            return Err("No hay bytes para imprimir".into());
        }
        let name = wide(printer_name);
        let mut handle = PRINTER_HANDLE::default();
        unsafe {
            OpenPrinterW(PCWSTR(name.as_ptr()), &mut handle, None).map_err(|e| {
                format!("No se pudo abrir la impresora \"{printer_name}\": {}", e.message().trim())
            })?;
        }
        // Lo que sigue va en una función aparte para que ClosePrinter se llame SIEMPRE,
        // aunque algún paso falle.
        let result = unsafe { write_job(handle, data) };
        unsafe {
            let _ = ClosePrinter(handle);
        }
        result
    }

    unsafe fn write_job(handle: PRINTER_HANDLE, data: &[u8]) -> Result<(), String> {
        let mut doc_name = wide("Prueba POS (RAW)");
        let mut datatype = wide("RAW");
        let doc = DOC_INFO_1W {
            pDocName: PWSTR(doc_name.as_mut_ptr()),
            pOutputFile: PWSTR::null(),
            pDatatype: PWSTR(datatype.as_mut_ptr()),
        };
        unsafe {
            // StartDocPrinterW devuelve el id del trabajo; 0 = error.
            if StartDocPrinterW(handle, 1, &doc) == 0 {
                return Err(last_error("StartDocPrinter"));
            }
            if !StartPagePrinter(handle).as_bool() {
                let e = last_error("StartPagePrinter");
                let _ = EndDocPrinter(handle);
                return Err(e);
            }
            // WritePrinter puede escribir menos de lo pedido: repetimos hasta mandar todo.
            let mut sent = 0usize;
            while sent < data.len() {
                let chunk = &data[sent..];
                let mut written = 0u32;
                let ok = WritePrinter(handle, chunk.as_ptr().cast(), chunk.len() as u32, &mut written);
                if !ok.as_bool() || written == 0 {
                    let e = if ok.as_bool() {
                        "WritePrinter no escribió ningún byte".to_string()
                    } else {
                        last_error("WritePrinter")
                    };
                    let _ = EndPagePrinter(handle);
                    let _ = EndDocPrinter(handle);
                    return Err(format!("{e} (enviados {sent} de {} bytes)", data.len()));
                }
                sent += written as usize;
            }
            if !EndPagePrinter(handle).as_bool() {
                let e = last_error("EndPagePrinter");
                let _ = EndDocPrinter(handle);
                return Err(e);
            }
            if !EndDocPrinter(handle).as_bool() {
                return Err(last_error("EndDocPrinter"));
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    const MSG: &str = "La impresión RAW solo está implementada en Windows. Use la pestaña \"Sin hardware\".";

    pub fn list_printers() -> Result<Vec<String>, String> {
        Err(MSG.into())
    }

    pub fn print_raw(_printer_name: &str, _data: &[u8]) -> Result<(), String> {
        Err(MSG.into())
    }
}

pub use imp::{list_printers, print_raw};

// Pruebas rápidas sin hardware: `cargo test -- --nocapture` (desde src-tauri).
#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn lista_impresoras() {
        let list = super::list_printers().expect("EnumPrinters debería funcionar");
        println!("Impresoras: {list:?}");
    }

    #[test]
    fn impresora_inexistente_da_error_legible() {
        let err = super::print_raw("NO-EXISTE-123", b"hola\n").unwrap_err();
        println!("Error: {err}");
        assert!(err.contains("NO-EXISTE-123"));
    }
}
