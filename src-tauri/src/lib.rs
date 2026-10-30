mod db;
mod pin;
mod printer;
mod respaldo;

// Comandos que el frontend puede llamar con `invoke(...)`.
// Son `async` a propósito: así Tauri los ejecuta en un hilo aparte y la ventana
// no se congela mientras el spooler responde o mientras se calcula un hash.

/// Nombres de las impresoras instaladas en Windows.
#[tauri::command]
async fn list_printers() -> Result<Vec<String>, String> {
    printer::list_printers()
}

/// Manda `data` tal cual (RAW) a la impresora `printer_name`.
/// Ok solo significa que el spooler aceptó el trabajo, no que ya salió en papel.
#[tauri::command]
async fn print_raw(printer_name: String, data: Vec<u8>) -> Result<(), String> {
    printer::print_raw(&printer_name, &data)
}

/// Hash Argon2id de un PIN (para guardar en usuarios.pin_hash).
#[tauri::command]
async fn pin_hash(pin: String) -> Result<String, String> {
    pin::hash(&pin)
}

/// Compara un PIN con su hash guardado.
#[tauri::command]
async fn pin_verificar(pin: String, hash: String) -> bool {
    pin::verificar(&pin, &hash)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // El plugin abre la base al arrancar (preload en tauri.conf.json) y corre las migraciones pendientes.
        .plugin(tauri_plugin_sql::Builder::new().add_migrations(db::DB_URL, db::migraciones()).build())
        .invoke_handler(tauri::generate_handler![list_printers, print_raw, pin_hash, pin_verificar, db::sql_lote, db::respaldo_crear])
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicación Tauri");
}
