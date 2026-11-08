// Envío de bytes a la impresora: por el spooler de Windows (RAW), por un puerto serial (COMn) o
// directo al dispositivo USB de impresora. También lista lo que el sistema detecta: la pantalla
// solo puede elegir de esa lista (nunca escribir una ruta).
//
// "RAW" significa que Windows NO interpreta los bytes: el driver los pasa tal cual a la
// impresora. Así los comandos ESC/POS (negrita, código de barras, logo…) llegan intactos.
// Lo que se manda ya pasó por escpos::validar (o es el pulso de gaveta que arma Rust).
//
// Todo lo de Windows está dentro de `#[cfg(windows)]`. En otro sistema se compila una versión que
// devuelve un error claro, y en las pruebas una impresora simulada (módulo `simulada`).

use serde::Serialize;

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usb {
    /// Ruta del dispositivo (\\?\usb#vid_…): es lo que se guarda como destino.
    pub ruta: String,
    /// Nombre para mostrar.
    pub nombre: String,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Detectadas {
    pub windows: Vec<String>,
    pub serial: Vec<String>,
    pub usb: Vec<Usb>,
    /// Si algo no se pudo listar (p. ej. sin permisos), qué pasó. La lista igual sirve.
    pub avisos: Vec<String>,
}

impl Detectadas {
    /// ¿Ese destino lo detectó el sistema para ese tipo de conexión?
    pub fn contains(&self, conexion: &str, destino: &str) -> bool {
        match conexion {
            "windows" => self.windows.iter().any(|x| x == destino),
            "serial" => self.serial.iter().any(|x| x == destino),
            "usb" => self.usb.iter().any(|x| x.ruta == destino),
            _ => false,
        }
    }
}

#[cfg(all(windows, not(test)))]
mod imp {
    use super::{Detectadas, Usb};
    use std::io::Write;
    use std::os::windows::io::AsRawHandle;
    use windows::core::{GUID, HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Devices::Communication::{GetCommState, SetCommState, SetCommTimeouts, COMMTIMEOUTS, DCB, NOPARITY, ONESTOPBIT};
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW, SetupDiGetDeviceInterfaceDetailW, SetupDiGetDeviceRegistryPropertyW,
        DIGCF_DEVICEINTERFACE, DIGCF_PRESENT, SPDRP_DEVICEDESC, SPDRP_FRIENDLYNAME, SP_DEVICE_INTERFACE_DATA, SP_DEVICE_INTERFACE_DETAIL_DATA_W, SP_DEVINFO_DATA,
    };
    use windows::Win32::Foundation::{GetLastError, HANDLE};
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW, StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W,
        PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_HANDLE, PRINTER_INFO_4W,
    };
    use windows::Win32::Storage::FileSystem::QueryDosDeviceW;

    /// Interfaz de dispositivo de las impresoras USB (GUID_DEVINTERFACE_USBPRINT).
    const USBPRINT: GUID = GUID::from_u128(0x28d78fad_5a12_11d1_ae5b_0000f803a8c2);

    /// Las APIs de Windows usan texto UTF-16 terminado en 0 ("wide strings").
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Lee GetLastError() y lo convierte en un mensaje legible (en el idioma de Windows).
    fn last_error(paso: &str) -> String {
        let code = unsafe { GetLastError() };
        let msg = HRESULT::from_win32(code.0).message();
        format!("{paso} falló (código {}): {}", code.0, msg.trim())
    }

    pub fn list_printers() -> Result<Vec<String>, String> {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed = 0u32;
        let mut returned = 0u32;
        unsafe {
            // 1ª llamada sin buffer: Windows responde cuántos bytes necesita.
            let _ = EnumPrintersW(flags, PCWSTR::null(), 4, None, &mut needed, &mut returned);
            if needed == 0 {
                return Ok(Vec::new());
            }
            let mut buf = vec![0u8; needed as usize];
            EnumPrintersW(flags, PCWSTR::null(), 4, Some(&mut buf), &mut needed, &mut returned).map_err(|e| format!("EnumPrintersW falló: {}", e.message()))?;
            let infos = std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, returned as usize);
            Ok(infos.iter().filter(|i| !i.pPrinterName.is_null()).map(|i| i.pPrinterName.to_string().unwrap_or_default()).collect())
        }
    }

    /// Puertos COM que existen ahora (QueryDosDevice lista todos los dispositivos de MS-DOS).
    fn puertos_serial() -> Result<Vec<String>, String> {
        let mut tam = 64 * 1024;
        loop {
            let mut buf = vec![0u16; tam];
            let n = unsafe { QueryDosDeviceW(PCWSTR::null(), Some(&mut buf)) } as usize;
            if n == 0 {
                if tam >= 4 * 1024 * 1024 {
                    return Err(last_error("QueryDosDevice"));
                }
                tam *= 4;
                continue;
            }
            let mut out: Vec<String> = buf[..n]
                .split(|c| *c == 0)
                .map(String::from_utf16_lossy)
                .filter(|s| s.len() > 3 && s[..3].eq_ignore_ascii_case("COM") && s[3..].chars().all(|c| c.is_ascii_digit()))
                .map(|s| s.to_uppercase())
                .collect();
            out.sort_by_key(|s| s[3..].parse::<u32>().unwrap_or(0));
            out.dedup();
            return Ok(out);
        }
    }

    fn propiedad(info: windows::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO, dato: &SP_DEVINFO_DATA, prop: windows::Win32::Devices::DeviceAndDriverInstallation::SETUP_DI_REGISTRY_PROPERTY) -> Option<String> {
        let mut buf = vec![0u8; 1024];
        let mut req = 0u32;
        unsafe { SetupDiGetDeviceRegistryPropertyW(info, dato, prop, None, Some(&mut buf), Some(&mut req)).ok()? };
        let w: Vec<u16> = buf.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|c| *c != 0).collect();
        let s = String::from_utf16_lossy(&w).trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    /// Impresoras USB conectadas (clase de impresora USB), con su ruta de dispositivo.
    fn usb() -> Result<Vec<Usb>, String> {
        let mut out = Vec::new();
        unsafe {
            let info = SetupDiGetClassDevsW(Some(&USBPRINT), PCWSTR::null(), None, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE).map_err(|e| format!("SetupDiGetClassDevs falló: {}", e.message()))?;
            for i in 0..64u32 {
                let mut iface = SP_DEVICE_INTERFACE_DATA { cbSize: std::mem::size_of::<SP_DEVICE_INTERFACE_DATA>() as u32, ..Default::default() };
                if SetupDiEnumDeviceInterfaces(info, None, &USBPRINT, i, &mut iface).is_err() {
                    break;
                }
                let mut req = 0u32;
                let _ = SetupDiGetDeviceInterfaceDetailW(info, &iface, None, 0, Some(&mut req), None);
                if req == 0 {
                    continue;
                }
                // Estructura de largo variable: se reserva en u64 para que quede bien alineada.
                let mut buf = vec![0u64; (req as usize).div_ceil(8)];
                let det = buf.as_mut_ptr() as *mut SP_DEVICE_INTERFACE_DETAIL_DATA_W;
                (*det).cbSize = std::mem::size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;
                let mut dev = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
                if SetupDiGetDeviceInterfaceDetailW(info, &iface, Some(det), req, None, Some(&mut dev)).is_err() {
                    continue;
                }
                let ruta = PCWSTR((*det).DevicePath.as_ptr()).to_string().unwrap_or_default();
                if ruta.is_empty() {
                    continue;
                }
                let nombre = propiedad(info, &dev, SPDRP_FRIENDLYNAME).or_else(|| propiedad(info, &dev, SPDRP_DEVICEDESC)).unwrap_or_else(|| "Impresora USB".into());
                out.push(Usb { ruta, nombre });
            }
            let _ = SetupDiDestroyDeviceInfoList(info);
        }
        // Dos impresoras iguales se llaman igual: se numeran para poder distinguirlas.
        let n = out.len();
        for i in 0..n {
            if out.iter().filter(|u| u.nombre == out[i].nombre).count() > 1 {
                let k = out[..i].iter().filter(|u| u.nombre.starts_with(&out[i].nombre)).count() + 1;
                out[i].nombre = format!("{} ({k})", out[i].nombre);
            }
        }
        Ok(out)
    }

    pub fn detectar() -> Detectadas {
        let mut d = Detectadas::default();
        match list_printers() {
            Ok(l) => d.windows = l,
            Err(e) => d.avisos.push(format!("Impresoras de Windows: {e}")),
        }
        match puertos_serial() {
            Ok(l) => d.serial = l,
            Err(e) => d.avisos.push(format!("Puertos seriales: {e}")),
        }
        match usb() {
            Ok(l) => d.usb = l,
            Err(e) => d.avisos.push(format!("USB: {e}")),
        }
        d
    }

    pub fn print_raw(printer_name: &str, data: &[u8]) -> Result<(), String> {
        if data.is_empty() {
            return Err("No hay bytes para imprimir".into());
        }
        let name = wide(printer_name);
        let mut handle = PRINTER_HANDLE::default();
        unsafe {
            OpenPrinterW(PCWSTR(name.as_ptr()), &mut handle, None).map_err(|e| format!("No se pudo abrir la impresora \"{printer_name}\": {}", e.message().trim()))?;
        }
        // Lo que sigue va en una función aparte para que ClosePrinter se llame SIEMPRE.
        let result = unsafe { write_job(handle, data) };
        unsafe {
            let _ = ClosePrinter(handle);
        }
        result
    }

    unsafe fn write_job(handle: PRINTER_HANDLE, data: &[u8]) -> Result<(), String> {
        let mut doc_name = wide("Punto de Venta (RAW)");
        let mut datatype = wide("RAW");
        let doc = DOC_INFO_1W { pDocName: PWSTR(doc_name.as_mut_ptr()), pOutputFile: PWSTR::null(), pDatatype: PWSTR(datatype.as_mut_ptr()) };
        unsafe {
            if StartDocPrinterW(handle, 1, &doc) == 0 {
                return Err(last_error("StartDocPrinter"));
            }
            if !StartPagePrinter(handle).as_bool() {
                let e = last_error("StartPagePrinter");
                let _ = EndDocPrinter(handle);
                return Err(e);
            }
            // WritePrinter puede escribir menos de lo pedido: se repite hasta mandar todo.
            let mut sent = 0usize;
            while sent < data.len() {
                let chunk = &data[sent..];
                let mut written = 0u32;
                let ok = WritePrinter(handle, chunk.as_ptr().cast(), chunk.len() as u32, &mut written);
                if !ok.as_bool() || written == 0 {
                    let e = if ok.as_bool() { "WritePrinter no escribió ningún byte".to_string() } else { last_error("WritePrinter") };
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

    /// Puerto serial: 8N1 a los baudios configurados, con tiempo límite para no trabar la caja.
    fn serial(puerto: &str, baudios: u32, data: &[u8]) -> Result<(), String> {
        let ruta = format!(r"\\.\{puerto}");
        let mut f = std::fs::OpenOptions::new().write(true).open(&ruta).map_err(|e| format!("No se pudo abrir {puerto}: {e}"))?;
        let h = HANDLE(f.as_raw_handle());
        unsafe {
            let mut dcb = DCB { DCBlength: std::mem::size_of::<DCB>() as u32, ..Default::default() };
            GetCommState(h, &mut dcb).map_err(|e| format!("GetCommState: {}", e.message()))?;
            dcb.BaudRate = baudios;
            dcb.ByteSize = 8;
            dcb.Parity = NOPARITY;
            dcb.StopBits = ONESTOPBIT;
            SetCommState(h, &dcb).map_err(|e| format!("SetCommState: {}", e.message()))?;
            let t = COMMTIMEOUTS { WriteTotalTimeoutConstant: 5000, WriteTotalTimeoutMultiplier: 2, ..Default::default() };
            SetCommTimeouts(h, &t).map_err(|e| format!("SetCommTimeouts: {}", e.message()))?;
        }
        f.write_all(data).map_err(|e| format!("No se pudo escribir en {puerto}: {e}"))?;
        f.flush().map_err(|e| format!("{puerto}: {e}"))
    }

    /// USB directo: se escribe en el dispositivo de impresora (sin driver de Windows de por medio).
    fn usb_directo(ruta: &str, data: &[u8]) -> Result<(), String> {
        let mut f = std::fs::OpenOptions::new().write(true).open(ruta).map_err(|e| format!("No se pudo abrir el dispositivo USB: {e}"))?;
        f.write_all(data).map_err(|e| format!("No se pudo escribir en el dispositivo USB: {e}"))?;
        f.flush().map_err(|e| format!("USB: {e}"))
    }

    pub fn enviar(conexion: &str, destino: &str, baudios: u32, data: &[u8]) -> Result<(), String> {
        match conexion {
            "windows" => print_raw(destino, data),
            "serial" => serial(destino, baudios, data),
            "usb" => usb_directo(destino, data),
            _ => Err("Tipo de conexión desconocido".into()),
        }
    }
}

#[cfg(all(not(windows), not(test)))]
mod imp {
    use super::Detectadas;
    const MSG: &str = "La impresión solo está implementada en Windows.";

    pub fn list_printers() -> Result<Vec<String>, String> {
        Err(MSG.into())
    }

    pub fn detectar() -> Detectadas {
        Detectadas { avisos: vec![MSG.into()], ..Default::default() }
    }

    pub fn print_raw(_printer_name: &str, _data: &[u8]) -> Result<(), String> {
        Err(MSG.into())
    }

    pub fn enviar(_conexion: &str, _destino: &str, _baudios: u32, _data: &[u8]) -> Result<(), String> {
        Err(MSG.into())
    }
}

/// Impresoras de mentira para las pruebas: se "instalan", reciben trabajos y se pueden "apagar".
/// Cada prueba usa nombres propios, así corren en paralelo sin pisarse.
#[cfg(test)]
#[allow(clippy::items_after_test_module)]
pub mod simulada {
    use super::{Detectadas, Usb};
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Estado {
        instaladas: Vec<(String, String)>,
        apagadas: HashSet<String>,
        trabadas: HashSet<String>,
        trabajos: HashMap<String, Vec<Vec<u8>>>,
    }

    static E: Mutex<Option<Estado>> = Mutex::new(None);

    fn con<T>(f: impl FnOnce(&mut Estado) -> T) -> T {
        let mut g = E.lock().unwrap();
        f(g.get_or_insert_with(Estado::default))
    }

    pub fn instalar(conexion: &str, destino: &str) {
        con(|e| e.instaladas.push((conexion.into(), destino.into())));
    }

    pub fn apagar(destino: &str, apagada: bool) {
        con(|e| if apagada { e.apagadas.insert(destino.into()) } else { e.apagadas.remove(destino) });
    }

    /// Trabada: recibe el trabajo pero no contesta (como una USB sin papel).
    pub fn trabar(destino: &str, trabada: bool) {
        con(|e| if trabada { e.trabadas.insert(destino.into()) } else { e.trabadas.remove(destino) });
    }

    pub fn trabajos(destino: &str) -> Vec<Vec<u8>> {
        con(|e| e.trabajos.get(destino).cloned().unwrap_or_default())
    }

    pub fn list_printers() -> Result<Vec<String>, String> {
        Ok(detectar().windows)
    }

    pub fn detectar() -> Detectadas {
        con(|e| {
            let mut d = Detectadas::default();
            for (c, x) in &e.instaladas {
                match c.as_str() {
                    "windows" => d.windows.push(x.clone()),
                    "serial" => d.serial.push(x.clone()),
                    _ => d.usb.push(Usb { ruta: x.clone(), nombre: format!("USB {x}") }),
                }
            }
            d
        })
    }

    pub fn enviar(_conexion: &str, destino: &str, _baudios: u32, data: &[u8]) -> Result<(), String> {
        if con(|e| e.trabadas.contains(destino)) {
            con(|e| e.trabajos.entry(destino.into()).or_default().push(data.to_vec()));
            std::thread::sleep(std::time::Duration::from_secs(2));
            return Ok(());
        }
        con(|e| {
            if e.apagadas.contains(destino) {
                return Err("StartDocPrinter falló (código 1801)".into());
            }
            e.trabajos.entry(destino.into()).or_default().push(data.to_vec());
            Ok(())
        })
    }

    pub fn print_raw(destino: &str, data: &[u8]) -> Result<(), String> {
        enviar("windows", destino, 0, data)
    }
}

#[cfg(not(test))]
pub use imp::{detectar, enviar, list_printers, print_raw};
#[cfg(test)]
#[allow(clippy::items_after_test_module)]
pub use simulada::{detectar, enviar, list_printers, print_raw};
