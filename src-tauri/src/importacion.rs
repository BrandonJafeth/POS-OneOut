// Importación de productos desde un CSV local (exportado de la tienda web).
//
// La pantalla arma la vista previa (mapeo, reglas, códigos), pero lo que toca el archivo y la
// base pasa por aquí:
//  - leer(): bytes → tabla de texto. Límite de tamaño y de filas, BOM, codificación (UTF-8 o
//    Windows-1252, la de Excel) y separador (coma o punto y coma), con la librería csv.
//    Quita caracteres de control (un ESC en el nombre mandaría comandos a la impresora).
//  - aplicar(): recibe lo que decidió la vista previa, VUELVE a validar cada campo y escribe en
//    una transacción: todo o nada, o fila por fila (SAVEPOINT) en el modo "solo las válidas".
//    Al actualizar solo cambia nombre, precio, activo, slug y categorías de origen; departamento
//    y favorito únicamente si se pidió, y nunca los códigos de barras.
// El contenido del archivo no se guarda ni se registra: la bitácora lleva solo cantidades.

use crate::bitacora;
use crate::config;
use crate::sesion::Actor;
use crate::usuarios;
use crate::util::{ahora_iso, e, normalizar, ulid, Res};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::HashSet;

pub const MAX_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_FILAS: usize = 20_000;
pub const MAX_NOMBRE: usize = 120;
const MAX_PRECIO: i64 = 100_000_000;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FilaTabla {
    /// Línea del archivo donde empieza la fila (1 = encabezado), para los mensajes.
    pub linea: u64,
    pub celdas: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tabla {
    pub separador: String,
    pub codificacion: String,
    pub cabecera: Vec<String>,
    pub filas: Vec<FilaTabla>,
}

/// UTF-8 (con o sin BOM); si no es UTF-8 válido, Windows-1252 (lo que guarda Excel en español).
fn decodificar(b: &[u8]) -> (String, &'static str) {
    if let Some(resto) = b.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(resto).into_owned(), "UTF-8 con BOM");
    }
    match std::str::from_utf8(b) {
        Ok(s) => (s.to_string(), "UTF-8"),
        Err(_) => (b.iter().map(|&c| cp1252(c)).collect(), "Windows-1252"),
    }
}

fn cp1252(c: u8) -> char {
    const ALTOS: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜',
        '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    match c {
        0x80..=0x9f => ALTOS[(c - 0x80) as usize],
        _ => c as char, // ASCII y Latin-1 coinciden con Unicode
    }
}

/// Cuenta separadores fuera de comillas en la primera línea; gana el que más aparece.
fn detectar_separador(t: &str) -> u8 {
    let (mut comas, mut punto_coma, mut comillas) = (0, 0, false);
    for c in t.chars() {
        match c {
            '"' => comillas = !comillas,
            '\n' | '\r' if !comillas => break,
            ',' if !comillas => comas += 1,
            ';' if !comillas => punto_coma += 1,
            _ => {}
        }
    }
    if punto_coma > comas { b';' } else { b',' }
}

use crate::util::invisible;

/// Sin caracteres de control (saltos y tabs pasan a espacio), espacios simples, sin bordes.
pub fn limpiar(s: &str) -> String {
    let t: String = s.chars().map(|c| if invisible(c) { ' ' } else { c }).collect();
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn leer(bytes: &[u8]) -> Res<Tabla> {
    if bytes.len() > MAX_BYTES {
        return Err("El archivo pesa más de 5 MB y no se lee. Divídalo en archivos más pequeños.".into());
    }
    let (texto, codificacion) = decodificar(bytes);
    let sep = detectar_separador(&texto);
    let mut r = csv::ReaderBuilder::new().delimiter(sep).has_headers(false).flexible(true).from_reader(texto.as_bytes());
    let mut filas: Vec<FilaTabla> = Vec::new();
    for reg in r.records() {
        let reg = reg.map_err(|err| {
            let linea = err.position().map(|p| p.line()).unwrap_or(0);
            format!("El archivo no es un CSV válido (cerca de la línea {linea}). Revise que las comillas estén cerradas.")
        })?;
        let celdas: Vec<String> = reg.iter().map(limpiar).collect();
        if celdas.iter().all(String::is_empty) {
            continue;
        }
        // + 1 por el encabezado.
        if filas.len() >= MAX_FILAS + 1 {
            return Err("El archivo tiene más de 20.000 filas y no se lee. Divídalo en partes.".into());
        }
        filas.push(FilaTabla { linea: reg.position().map(|p| p.line()).unwrap_or(0), celdas });
    }
    if filas.is_empty() {
        return Err("El archivo está vacío".into());
    }
    let cabecera = filas.remove(0).celdas;
    Ok(Tabla { separador: (sep as char).to_string(), codificacion: codificacion.into(), cabecera, filas })
}

// ─────────── Aplicar ───────────

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub fila: i64,
    /// "crear" o "actualizar".
    pub accion: String,
    pub web_id: String,
    #[serde(default)]
    pub slug: String,
    /// Solo en "actualizar": el producto que reconoció la vista previa (por id de la web o por slug).
    #[serde(default)]
    pub producto_id: Option<String>,
    pub nombre: String,
    pub precio: i64,
    pub activo: bool,
    pub departamento_id: String,
    #[serde(default)]
    pub favorito: bool,
    #[serde(default)]
    pub revisar: bool,
    #[serde(default)]
    pub categorias_origen: String,
    /// Código interno propuesto (departamento + 3 letras). Si ya está tomado se le agrega un número.
    #[serde(default)]
    pub codigo: Option<String>,
}

/// Qué datos editados en el POS se pueden reemplazar con lo del archivo (por defecto, ninguno).
#[derive(Deserialize, Serialize, Debug, Default, Clone, Copy)]
pub struct Pisar {
    #[serde(default)]
    pub departamento: bool,
    #[serde(default)]
    pub favorito: bool,
}

/// Lo que la vista previa descartó antes de mandar los items (solo cantidades, para la bitácora).
#[derive(Deserialize, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Resumen {
    #[serde(default)]
    pub filas: i64,
    #[serde(default)]
    pub sin_cambios: i64,
    #[serde(default)]
    pub omitidos: i64,
    #[serde(default)]
    pub errores: i64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Pedido {
    /// "todo" (si una fila falla no entra nada) o "validas" (entran las buenas y se listan las malas).
    pub modo: String,
    pub items: Vec<Item>,
    #[serde(default)]
    pub pisar: Pisar,
    #[serde(default)]
    pub resumen: Resumen,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fallo {
    pub fila: i64,
    pub mensaje: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CodigoAsignado {
    pub fila: i64,
    pub codigo: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Resultado {
    pub creados: usize,
    pub actualizados: usize,
    pub fallidos: Vec<Fallo>,
    pub codigos: Vec<CodigoAsignado>,
}

fn clave_valida(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Revisa y limpia un item. Nada de lo que manda la pantalla se usa sin pasar por aquí.
fn validar(it: &Item, deps: &HashSet<String>, pisar: Pisar) -> Result<Item, String> {
    if it.accion != "crear" && it.accion != "actualizar" {
        return Err("Acción desconocida".into());
    }
    if !clave_valida(&it.web_id, 64) {
        return Err("El id no tiene un formato válido".into());
    }
    if !it.slug.is_empty() && !clave_valida(&it.slug, 160) {
        return Err("El slug no tiene un formato válido".into());
    }
    let nombre = limpiar(&it.nombre);
    if nombre.is_empty() {
        return Err("Nombre vacío".into());
    }
    if nombre.chars().count() > MAX_NOMBRE {
        return Err(format!("Nombre de más de {MAX_NOMBRE} caracteres"));
    }
    if it.precio <= 0 || it.precio > MAX_PRECIO {
        return Err("El precio debe ser un entero positivo de colones".into());
    }
    // Al actualizar sin reemplazar el departamento, el que manda la pantalla no se usa.
    if (it.accion == "crear" || pisar.departamento) && !deps.contains(&it.departamento_id) {
        return Err("Departamento inexistente o inactivo".into());
    }
    let categorias = limpiar(&it.categorias_origen);
    if categorias.chars().count() > 500 {
        return Err("Demasiadas categorías".into());
    }
    let codigo = match &it.codigo {
        Some(c) if !(3..=20).contains(&c.len()) || !c.chars().all(|x| x.is_ascii_digit() || x.is_ascii_lowercase()) => {
            return Err("Código interno inválido".into());
        }
        otro => otro.clone(),
    };
    Ok(Item { nombre, categorias_origen: categorias, codigo, ..it.clone() })
}

/// Código interno EAN-13 "200" + 9 dígitos + verificador, del mismo contador que usa el POS
/// (config codigo_interno_siguiente), para que la etiqueta se pueda imprimir y escanear.
pub(crate) fn ean_interno(n: i64) -> String {
    let base = format!("200{n:09}");
    let suma: u32 = base.bytes().enumerate().map(|(i, b)| (b - b'0') as u32 * if i % 2 == 0 { 1 } else { 3 }).sum();
    format!("{base}{}", (10 - suma % 10) % 10)
}

/// El código que mostró la vista previa, si es un interno válido y sigue libre (así lo guardado es
/// exactamente lo que vio el dueño); si no, el siguiente del contador.
async fn codigo_libre(c: &mut SqliteConnection, pedido: &str, ahora: &str) -> Res<String> {
    sqlx::query("INSERT OR IGNORE INTO config (clave, valor) VALUES ('codigo_interno_siguiente', '1')").execute(&mut *c).await.map_err(e)?;
    let n: i64 = pedido.get(3..12).and_then(|x| x.parse().ok()).unwrap_or(0);
    // Nunca uno anterior al contador: aunque esté libre, pudo entregarse (etiqueta impresa) y quitarse después.
    let siguiente: i64 = sqlx::query_scalar("SELECT CAST(valor AS INTEGER) FROM config WHERE clave = 'codigo_interno_siguiente'").fetch_one(&mut *c).await.map_err(e)?;
    if pedido.len() == 13 && pedido.starts_with("200") && n >= siguiente && ean_interno(n) == pedido {
        let usado: Option<i64> = sqlx::query_scalar("SELECT 1 FROM codigos WHERE codigo = ?").bind(pedido).fetch_optional(&mut *c).await.map_err(e)?;
        if usado.is_none() {
            // El contador queda después del mayor usado, para que "Generar código interno" no lo repita.
            sqlx::query("UPDATE config SET valor = MAX(CAST(valor AS INTEGER), ?), actualizado_en = ? WHERE clave = 'codigo_interno_siguiente'")
                .bind(n + 1)
                .bind(ahora)
                .execute(&mut *c)
                .await
                .map_err(e)?;
            return Ok(pedido.to_string());
        }
    }
    for _ in 0..10_000 {
        let n: i64 = sqlx::query_scalar("UPDATE config SET valor = CAST(valor AS INTEGER) + 1, actualizado_en = ? WHERE clave = 'codigo_interno_siguiente' RETURNING CAST(valor AS INTEGER) - 1")
            .bind(ahora)
            .fetch_one(&mut *c)
            .await
            .map_err(e)?;
        if !(1..=999_999_999).contains(&n) {
            break;
        }
        let cand = ean_interno(n);
        let usado: Option<i64> = sqlx::query_scalar("SELECT 1 FROM codigos WHERE codigo = ?").bind(&cand).fetch_optional(&mut *c).await.map_err(e)?;
        if usado.is_none() {
            return Ok(cand);
        }
    }
    Err("No hay código interno libre".into())
}

struct Defectos {
    tasa_iva: f64,
    cabys: Option<String>,
}

/// Escribe un item ya validado. Devuelve el código interno asignado, si hubo.
async fn escribir(c: &mut SqliteConnection, it: &Item, pisar: Pisar, d: &Defectos, ahora: &str) -> Result<Option<String>, String> {
    let slug = (!it.slug.is_empty()).then_some(it.slug.as_str());
    let cats = (!it.categorias_origen.is_empty()).then_some(it.categorias_origen.as_str());
    let producto_id = if it.accion == "crear" {
        let ya: Option<i64> = sqlx::query_scalar("SELECT 1 FROM productos WHERE web_id = ?").bind(&it.web_id).fetch_optional(&mut *c).await.map_err(e)?;
        if ya.is_some() {
            return Err("Ya existe un producto con ese id: vuelva a abrir la vista previa".into());
        }
        let id = ulid();
        sqlx::query(
            "INSERT INTO productos (id, web_id, web_slug, nombre, nombre_busqueda, departamento_id, precio, activo, favorito, revisar, categorias_origen, tasa_iva, cabys, creado_en, actualizado_en)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&it.web_id)
        .bind(slug)
        .bind(&it.nombre)
        .bind(normalizar(&it.nombre))
        .bind(&it.departamento_id)
        .bind(it.precio)
        .bind(it.activo)
        .bind(it.favorito)
        .bind(it.revisar)
        .bind(cats)
        .bind(d.tasa_iva)
        .bind(d.cabys.as_deref())
        .bind(ahora)
        .bind(ahora)
        .execute(&mut *c)
        .await
        .map_err(e)?;
        id
    } else {
        // Se confirma que el producto sigue vigente y que de verdad es ese: mismo id de la web, mismo slug,
        // o creado a mano (sin id de la web) con el mismo nombre, que así queda unido al de la web.
        let id: Option<String> = sqlx::query_scalar(
            "SELECT id FROM productos WHERE id = ? AND eliminado_en IS NULL
               AND (web_id = ? OR (web_slug IS NOT NULL AND web_slug = ?) OR (web_id IS NULL AND nombre_busqueda = ?))",
        )
        .bind(it.producto_id.as_deref().unwrap_or(""))
        .bind(&it.web_id)
        .bind(&it.slug)
        .bind(normalizar(&it.nombre))
            .fetch_optional(&mut *c)
            .await
            .map_err(e)?;
        let id = id.ok_or("El producto ya no existe o se eliminó en el POS")?;
        sqlx::query(
            "UPDATE productos SET web_id = ?, nombre = ?, nombre_busqueda = ?, precio = ?, activo = ?, web_slug = ?, categorias_origen = ?, actualizado_en = ?,
               departamento_id = CASE WHEN ? THEN ? ELSE departamento_id END,
               revisar = CASE WHEN ? THEN ? ELSE revisar END,
               favorito = CASE WHEN ? THEN ? ELSE favorito END
             WHERE id = ?",
        )
        .bind(&it.web_id)
        .bind(&it.nombre)
        .bind(normalizar(&it.nombre))
        .bind(it.precio)
        .bind(it.activo)
        .bind(slug)
        .bind(cats)
        .bind(ahora)
        .bind(pisar.departamento)
        .bind(&it.departamento_id)
        .bind(pisar.departamento)
        .bind(it.revisar)
        .bind(pisar.favorito)
        .bind(it.favorito)
        .bind(&id)
        .execute(&mut *c)
        .await
        .map_err(e)?;
        id
    };
    let Some(pedido) = &it.codigo else { return Ok(None) };
    // Al actualizar, se agrega solo si todavía no tiene uno numérico (los viejos de letras, "05por",
    // no se pueden imprimir: reciben el numérico y conservan el viejo).
    if it.accion == "actualizar" {
        let tiene: Option<i64> = sqlx::query_scalar("SELECT 1 FROM codigos c WHERE c.producto_id = ? AND c.tipo = 'interno' AND length(c.codigo) = 13 AND c.codigo GLOB '200[0-9]*'")
            .bind(&producto_id)
            .fetch_optional(&mut *c)
            .await
            .map_err(e)?;
        if tiene.is_some() {
            return Ok(None);
        }
    }
    let codigo = codigo_libre(c, pedido, ahora).await?;
    sqlx::query("INSERT INTO codigos (codigo, producto_id, tipo, creado_en) VALUES (?, ?, 'interno', ?)")
        .bind(&codigo)
        .bind(&producto_id)
        .bind(ahora)
        .execute(&mut *c)
        .await
        .map_err(e)?;
    Ok(Some(codigo))
}

/// Error de una fila para el dueño: los de la base (técnicos) en palabras simples.
fn amigable(m: &str) -> String {
    match m.strip_prefix(crate::util::TECNICO) {
        None => m.to_string(),
        Some(t) if t.contains("UNIQUE") => "Otro producto ya tiene ese id o código: revise que no esté repetido".into(),
        Some(_) => "No se pudo guardar esta fila. Si se repite, avise al técnico".into(),
    }
}

pub async fn aplicar(pool: &SqlitePool, a: &Actor, pin: &str, p: &Pedido) -> Res<Resultado> {
    a.exigir("productos.importar", "importar productos")?;
    if p.modo != "todo" && p.modo != "validas" {
        return Err("Modo de importación desconocido".into());
    }
    if p.items.is_empty() {
        return Err("No hay nada que importar".into());
    }
    if p.items.len() > MAX_FILAS {
        return Err("Demasiadas filas".into());
    }
    usuarios::confirmar_propio(pool, a, pin, "importar productos").await?;

    let deps: HashSet<String> = sqlx::query_scalar("SELECT id FROM departamentos WHERE activo = 1 AND eliminado_en IS NULL")
        .fetch_all(pool)
        .await
        .map_err(e)?
        .into_iter()
        .collect();
    let mut fallidos = Vec::new();
    let mut validos = Vec::with_capacity(p.items.len());
    let mut ids = HashSet::new();
    for it in &p.items {
        match validar(it, &deps, p.pisar) {
            Ok(v) if !ids.insert(v.web_id.clone()) => fallidos.push(Fallo { fila: it.fila, mensaje: "Id repetido en el archivo".into() }),
            Ok(v) => validos.push(v),
            Err(m) => fallidos.push(Fallo { fila: it.fila, mensaje: m }),
        }
    }
    if p.modo == "todo" && !fallidos.is_empty() {
        let f = &fallidos[0];
        return Err(format!("No se importó nada: {} fila(s) con problemas (la primera, fila {}: {}).", fallidos.len(), f.fila, f.mensaje));
    }

    let tasa_iva = config::valor(pool, "producto_tasa_iva_defecto").await.and_then(|v| v.as_f64()).filter(|t| (0.0..=100.0).contains(t)).unwrap_or(13.0);
    let cabys = config::valor(pool, "producto_cabys_defecto").await.and_then(|v| v.as_str().map(str::to_string)).filter(|c| c.len() == 13 && c.chars().all(|x| x.is_ascii_digit()));
    let d = Defectos { tasa_iva, cabys };
    let ahora = ahora_iso();
    let (mut creados, mut actualizados, mut codigos) = (0, 0, Vec::new());

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    for it in &validos {
        let r = if p.modo == "validas" {
            sqlx::query("SAVEPOINT fila").execute(&mut *tx).await.map_err(e)?;
            let r = escribir(&mut tx, it, p.pisar, &d, &ahora).await;
            if r.is_err() {
                sqlx::query("ROLLBACK TO fila").execute(&mut *tx).await.map_err(e)?;
            }
            sqlx::query("RELEASE fila").execute(&mut *tx).await.map_err(e)?;
            r
        } else {
            escribir(&mut tx, it, p.pisar, &d, &ahora).await
        };
        match r {
            Ok(codigo) => {
                if it.accion == "crear" { creados += 1 } else { actualizados += 1 }
                if let Some(codigo) = codigo {
                    codigos.push(CodigoAsignado { fila: it.fila, codigo });
                }
            }
            // En "todo" el error corta aquí y la transacción se deshace al soltarla.
            Err(m) if p.modo == "todo" => return Err(format!("No se importó nada (fila {}: {}).", it.fila, amigable(&m))),
            Err(m) => fallidos.push(Fallo { fila: it.fila, mensaje: amigable(&m) }),
        }
    }
    fallidos.sort_by_key(|f| f.fila);
    let r = &p.resumen;
    bitacora::registrar(
        &mut tx,
        Some(&a.id),
        "importacion",
        "producto",
        None,
        &json!({
            "origen": "web", "modo": p.modo, "filas": r.filas, "creados": creados, "actualizados": actualizados,
            "sinCambios": r.sin_cambios, "omitidos": r.omitidos, "errores": r.errores, "fallidos": fallidos.len(),
            "codigos": codigos.len(), "pisar": p.pisar,
        }),
    )
    .await?;
    tx.commit().await.map_err(e)?;
    Ok(Resultado { creados, actualizados, fallidos, codigos })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usuarios::tests::base_con_usuarios;

    const D01: &str = "00000000000000000000000D01";
    const D11: &str = "00000000000000000000000D11";
    const PIN_DUENO: &str = "246813";

    fn item(fila: i64, web_id: &str, nombre: &str, precio: i64) -> Item {
        Item {
            fila,
            accion: "crear".into(),
            web_id: web_id.into(),
            slug: web_id.to_lowercase(),
            nombre: nombre.into(),
            precio,
            activo: true,
            departamento_id: D01.into(),
            favorito: false,
            revisar: false,
            producto_id: None,
            categorias_origen: "Escolar".into(),
            codigo: Some("01abc".into()),
        }
    }

    fn pedido(modo: &str, items: Vec<Item>) -> Pedido {
        Pedido { modo: modo.into(), items, pisar: Pisar::default(), resumen: Resumen::default() }
    }

    async fn contar(pool: &SqlitePool, sql: &str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
    }

    /// Mismo perfil que el CSV real de la web: 719 filas, 1 agotada, 281 destacadas, 40 con varias categorías.
    fn csv_web(sep: char) -> String {
        let mut s = format!("id{sep}slug{sep}nombre{sep}precio{sep}estado{sep}tipo{sep}destacado{sep}descuento_activo{sep}precio_oferta{sep}categorias\n");
        for i in 0..719 {
            let estado = if i == 5 { "agotado" } else { "disponible" };
            let cats = if i < 40 { "Bazar | Escolar" } else { "Escolar" };
            s += &format!("id-{i}{sep}p-{i}{sep}\" Producto  ñandú {i}, \"\"especial\"\" \"{sep}{}{sep}{estado}{sep}simple{sep}{}{sep}true{sep}null{sep}{cats}\n", 150 + i * 75, i < 281);
        }
        s
    }

    #[test]
    fn errores_de_fila_en_palabras_simples() {
        assert_eq!(amigable("Nombre vacío"), "Nombre vacío");
        assert!(amigable(&format!("{}UNIQUE constraint failed: productos.web_id", crate::util::TECNICO)).contains("repetido"));
        assert!(!amigable(&format!("{}disk I/O error", crate::util::TECNICO)).contains("disk"));
    }

    #[test]
    fn lee_bom_separador_comillas_y_tildes() {
        for sep in [',', ';'] {
            let mut b = vec![0xEF, 0xBB, 0xBF];
            b.extend(csv_web(sep).as_bytes());
            let t = leer(&b).unwrap();
            assert_eq!(t.codificacion, "UTF-8 con BOM");
            assert_eq!(t.separador, sep.to_string());
            assert_eq!(t.cabecera[0], "id");
            assert_eq!(t.filas.len(), 719);
            // Comillas con separador y comillas escapadas dentro; espacios de más limpios; ñ y tilde intactas.
            assert_eq!(t.filas[0].celdas[2], "Producto ñandú 0, \"especial\"");
            assert_eq!(t.filas[0].linea, 2);
        }
    }

    #[test]
    fn salto_de_linea_en_comillas_windows_1252_y_control() {
        let t = leer(b"id,nombre\r\n1,\"Dos\r\nl\xedneas\"\r\n2,\"L\xe1piz\x1b@\"\r\n\r\n").unwrap();
        assert_eq!(t.codificacion, "Windows-1252");
        assert_eq!(t.filas[0].celdas[1], "Dos líneas");
        // El ESC (comando de impresora) desaparece.
        assert_eq!(t.filas[1].celdas[1], "Lápiz @");
        assert_eq!(t.filas.len(), 2);
    }

    #[test]
    fn rechaza_archivos_grandes_o_con_muchas_filas() {
        assert!(leer(&vec![b'a'; MAX_BYTES + 1]).unwrap_err().contains("5 MB"));
        let mut s = String::from("id,nombre\n");
        for i in 0..=MAX_FILAS {
            s += &format!("{i},x\n");
        }
        assert!(leer(s.as_bytes()).unwrap_err().contains("filas"));
        assert!(leer(b"").unwrap_err().contains("vac"));
    }

    #[tokio::test]
    async fn cajero_no_importa_y_pin_obligatorio() {
        let (bd, tec, dueno, cajero) = base_con_usuarios().await;
        let p = pedido("todo", vec![item(2, "a", "Uno", 100)]);
        assert!(aplicar(&bd.pool, &cajero, "2580", &p).await.unwrap_err().contains("permiso"));
        assert!(aplicar(&bd.pool, &dueno, "000000", &p).await.unwrap_err().contains("PIN"));
        assert_eq!(contar(&bd.pool, "SELECT COUNT(*) FROM productos").await, 0);
        // El técnico también puede, con su propio PIN.
        aplicar(&bd.pool, &tec, "735919", &p).await.unwrap();
        assert_eq!(contar(&bd.pool, "SELECT COUNT(*) FROM productos").await, 1);
    }

    #[tokio::test]
    async fn importa_719_y_reimportar_no_duplica_ni_pisa() {
        let (bd, _, dueno, _) = base_con_usuarios().await;
        let t = leer(csv_web(',').as_bytes()).unwrap();
        let items: Vec<Item> = t
            .filas
            .iter()
            .map(|f| Item {
                activo: f.celdas[4] == "disponible",
                favorito: f.celdas[6] == "true",
                codigo: Some("01pro".into()),
                categorias_origen: f.celdas[9].clone(),
                slug: f.celdas[1].clone(),
                ..item(f.linea as i64, &f.celdas[0], &f.celdas[2], f.celdas[3].parse().unwrap())
            })
            .collect();
        let r = aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("todo", items.clone())).await.unwrap();
        assert_eq!((r.creados, r.actualizados), (719, 0));
        assert_eq!(contar(&bd.pool, "SELECT COUNT(*) FROM productos").await, 719);
        assert_eq!(contar(&bd.pool, "SELECT COUNT(*) FROM productos WHERE activo = 1").await, 718);
        assert_eq!(contar(&bd.pool, "SELECT COUNT(DISTINCT codigo) FROM codigos WHERE tipo = 'interno'").await, 719);
        // Numéricos EAN-13 del contador del POS (imprimibles), no "01pro2".
        assert_eq!((r.codigos[0].codigo.as_str(), r.codigos[1].codigo.as_str()), (ean_interno(1).as_str(), ean_interno(2).as_str()));
        assert_eq!(ean_interno(1), "2000000000015");
        assert_eq!(contar(&bd.pool, "SELECT COUNT(*) FROM productos WHERE tasa_iva = 13").await, 719);

        // El dueño edita en el POS: cambia departamento, quita favorito y escanea un código de barras.
        let id: String = sqlx::query_scalar("SELECT id FROM productos WHERE web_id = 'id-0'").fetch_one(&bd.pool).await.unwrap();
        sqlx::query("UPDATE productos SET departamento_id = ?, favorito = 0 WHERE id = ?").bind(D11).bind(&id).execute(&bd.pool).await.unwrap();
        sqlx::query("INSERT INTO codigos (codigo, producto_id, tipo) VALUES ('7501031311309', ?, 'barras')").bind(&id).execute(&bd.pool).await.unwrap();

        // Reimportar: la vista previa manda los que cambiaron como "actualizar".
        let mut otra = Vec::new();
        for i in items.iter().take(3) {
            let pid: String = sqlx::query_scalar("SELECT id FROM productos WHERE web_id = ?").bind(&i.web_id).fetch_one(&bd.pool).await.unwrap();
            otra.push(Item { accion: "actualizar".into(), producto_id: Some(pid), precio: i.precio + 5, ..i.clone() });
        }
        let r = aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("todo", otra)).await.unwrap();
        assert_eq!((r.creados, r.actualizados), (0, 3));
        assert!(r.codigos.is_empty(), "ya tenían código interno");
        // Uno con el código viejo de letras sí recibe el numérico (y conserva el viejo).
        let viejo: String = sqlx::query_scalar("SELECT id FROM productos WHERE web_id = 'id-9'").fetch_one(&bd.pool).await.unwrap();
        sqlx::query("UPDATE codigos SET codigo = '01pro9' WHERE producto_id = ? AND tipo = 'interno'").bind(&viejo).execute(&bd.pool).await.unwrap();
        let act = Item { accion: "actualizar".into(), producto_id: Some(viejo.clone()), ..items[9].clone() };
        let r = aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("todo", vec![act])).await.unwrap();
        assert_eq!(r.codigos.len(), 1);
        assert_eq!(contar(&bd.pool, &format!("SELECT COUNT(*) FROM codigos WHERE producto_id = '{viejo}'")).await, 2);
        assert_eq!(contar(&bd.pool, "SELECT COUNT(*) FROM productos").await, 719);
        let (dep, fav, precio): (String, bool, i64) =
            sqlx::query_as("SELECT departamento_id, favorito, precio FROM productos WHERE id = ?").bind(&id).fetch_one(&bd.pool).await.unwrap();
        assert_eq!((dep.as_str(), fav, precio), (D11, false, 155));
        assert_eq!(contar(&bd.pool, "SELECT COUNT(*) FROM codigos WHERE tipo = 'barras'").await, 1);

        // Crear otra vez algo que ya existe no duplica: falla y no entra nada.
        assert!(aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("todo", items[..1].to_vec())).await.unwrap_err().contains("Ya existe"));
        // Pidiendo pisar de forma explícita, sí se reemplaza el departamento.
        let mut p = pedido("todo", vec![Item { accion: "actualizar".into(), producto_id: Some(id.clone()), ..items[0].clone() }]);
        p.pisar.departamento = true;
        aplicar(&bd.pool, &dueno, PIN_DUENO, &p).await.unwrap();
        let dep: String = sqlx::query_scalar("SELECT departamento_id FROM productos WHERE id = ?").bind(&id).fetch_one(&bd.pool).await.unwrap();
        assert_eq!(dep, D01);
    }

    #[tokio::test]
    async fn guarda_el_codigo_que_mostro_la_vista_previa() {
        let (bd, _, dueno, _) = base_con_usuarios().await;
        // Se guarda lo que mostró la vista previa (aunque salte números, p. ej. otro ya los tomó).
        let items = vec![Item { codigo: Some(ean_interno(2)), ..item(2, "a", "Uno", 100) }, Item { codigo: Some(ean_interno(3)), ..item(3, "b", "Dos", 100) }];
        let r = aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("todo", items)).await.unwrap();
        assert_eq!(r.codigos.iter().map(|x| x.codigo.clone()).collect::<Vec<_>>(), vec![ean_interno(2), ean_interno(3)]);
        // El contador queda después del mayor: el siguiente no choca.
        assert_eq!(config::entero(&bd.pool, "codigo_interno_siguiente", 0).await, 4);
        // Uno anterior al contador (pudo entregarse y quitarse) no se reutiliza aunque esté libre.
        sqlx::query("DELETE FROM codigos WHERE codigo = ?").bind(ean_interno(1)).execute(&bd.pool).await.unwrap();
        let r = aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("todo", vec![Item { codigo: Some(ean_interno(1)), ..item(6, "e", "Cinco", 1) }])).await.unwrap();
        assert_eq!(r.codigos[0].codigo, ean_interno(4));
        // Uno ya usado o con verificador malo: toma el siguiente libre del contador.
        let r = aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("todo", vec![Item { codigo: Some(ean_interno(3)), ..item(4, "c", "Tres", 1) }, Item { codigo: Some("2000000000010".into()), ..item(5, "d", "Cuatro", 1) }])).await.unwrap();
        assert_eq!(r.codigos.iter().map(|x| x.codigo.clone()).collect::<Vec<_>>(), vec![ean_interno(5), ean_interno(6)]);
    }

    #[tokio::test]
    async fn todo_o_nada_y_solo_validas() {
        let (bd, _, dueno, _) = base_con_usuarios().await;
        let malos = || vec![item(2, "a", "Uno", 100), item(3, "b", "Dos", 0), item(4, "c", "Tres\u{1b}", 300)];
        let err = aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("todo", malos())).await.unwrap_err();
        assert!(err.contains("No se importó nada"), "{err}");
        assert_eq!(contar(&bd.pool, "SELECT COUNT(*) FROM productos").await, 0);
        assert_eq!(contar(&bd.pool, "SELECT COUNT(*) FROM bitacora WHERE accion = 'importacion'").await, 0);

        let r = aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("validas", malos())).await.unwrap();
        assert_eq!(r.creados, 2);
        assert_eq!(r.fallidos, vec![Fallo { fila: 3, mensaje: "El precio debe ser un entero positivo de colones".into() }]);
        // El ESC del nombre se quitó en el backend aunque la pantalla lo mandara.
        let n: String = sqlx::query_scalar("SELECT nombre FROM productos WHERE web_id = 'c'").fetch_one(&bd.pool).await.unwrap();
        assert_eq!(n, "Tres");
        // La bitácora lleva cantidades, no nombres ni precios.
        let det: String = sqlx::query_scalar("SELECT detalle FROM bitacora WHERE accion = 'importacion'").fetch_one(&bd.pool).await.unwrap();
        assert!(det.contains("\"creados\":2") && !det.contains("Uno"));
    }

    #[tokio::test]
    async fn id_cambiado_se_reconoce_por_slug_y_no_toca_otro_producto() {
        let (bd, _, dueno, _) = base_con_usuarios().await;
        aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("todo", vec![item(2, "VIEJO", "Lápiz", 100), Item { codigo: None, ..item(3, "OTRO", "Goma", 50) }])).await.unwrap();
        let id: String = sqlx::query_scalar("SELECT id FROM productos WHERE web_id = 'VIEJO'").fetch_one(&bd.pool).await.unwrap();
        let otro: String = sqlx::query_scalar("SELECT id FROM productos WHERE web_id = 'OTRO'").fetch_one(&bd.pool).await.unwrap();
        // Mismo slug ("viejo"), id nuevo: se actualiza el mismo producto y se guarda el id nuevo.
        let act = Item { accion: "actualizar".into(), producto_id: Some(id.clone()), web_id: "NUEVO".into(), slug: "viejo".into(), precio: 120, ..item(2, "x", "Lápiz", 1) };
        aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("todo", vec![act.clone()])).await.unwrap();
        let (web, precio): (String, i64) = sqlx::query_as("SELECT web_id, precio FROM productos WHERE id = ?").bind(&id).fetch_one(&bd.pool).await.unwrap();
        assert_eq!((web.as_str(), precio), ("NUEVO", 120));
        // La pantalla no puede usar "actualizar" para pisar un producto cualquiera.
        let mal = Item { producto_id: Some(otro), slug: "nada".into(), ..act };
        assert!(aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("todo", vec![mal])).await.unwrap_err().contains("ya no existe"));
    }

    #[tokio::test]
    async fn el_creado_a_mano_con_el_mismo_nombre_se_une_con_el_de_la_web() {
        let (bd, _, dueno, _) = base_con_usuarios().await;
        let p = &bd.pool;
        sqlx::query("INSERT INTO productos (id, nombre, nombre_busqueda, departamento_id, precio) VALUES ('MANO', 'Cartulina', 'cartulina', ?, 80)").bind(D01).execute(p).await.unwrap();
        let unir = Item { accion: "actualizar".into(), producto_id: Some("MANO".into()), codigo: None, ..item(2, "W8", "cartulina", 100) };
        // Con otro nombre no se deja: "actualizar" no sirve para pisar un producto cualquiera.
        assert!(aplicar(p, &dueno, PIN_DUENO, &pedido("todo", vec![Item { nombre: "Otra cosa".into(), ..unir.clone() }])).await.unwrap_err().contains("ya no existe"));
        aplicar(p, &dueno, PIN_DUENO, &pedido("todo", vec![unir])).await.unwrap();
        let (web, precio): (String, i64) = sqlx::query_as("SELECT web_id, precio FROM productos WHERE id = 'MANO'").fetch_one(p).await.unwrap();
        assert_eq!((web.as_str(), precio), ("W8", 100));
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM productos").fetch_one(p).await.unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn valida_departamento_id_y_codigo() {
        let (bd, _, dueno, _) = base_con_usuarios().await;
        let casos = [
            Item { departamento_id: "NO-EXISTE".into(), ..item(2, "a", "Uno", 1) },
            Item { web_id: "a b; DROP".into(), ..item(2, "a", "Uno", 1) },
            Item { codigo: Some("01ABC'".into()), ..item(2, "a", "Uno", 1) },
            Item { nombre: "x".repeat(MAX_NOMBRE + 1), ..item(2, "a", "Uno", 1) },
        ];
        for c in casos {
            assert!(aplicar(&bd.pool, &dueno, PIN_DUENO, &pedido("todo", vec![c])).await.is_err());
        }
        assert_eq!(contar(&bd.pool, "SELECT COUNT(*) FROM productos").await, 0);
    }
}
