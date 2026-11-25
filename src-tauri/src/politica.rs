// Política de permisos (DISENO-PERMISOS.md). Un solo lugar decide qué puede hacer cada usuario:
// `efectiva`. La configuración vive en `seguridad_versiones` (solo agregar, cadena de hashes) y se
// guarda en memoria (App.seguridad); se vuelve a leer solo cuando se agrega una versión.

use crate::acciones::{self, buscar, AlPasar, Limites, Nivel, Politica, CATALOGO, L_CANTIDAD, L_MONTO, L_PCT, L_TURNO, L_VENTANA};
use crate::bitacora;
use crate::config;
use crate::permisos::Rol;
use crate::util::{ahora_iso, e, Res};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::BTreeMap;
use std::sync::{Arc, LazyLock};
#[cfg(test)]
use ts_rs::TS;

pub const INACTIVIDAD_DEFECTO: i64 = 10;
pub const INACTIVIDAD_MAX: i64 = 60;
pub const INACTIVIDAD_MAX_TECNICO: i64 = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Inactividad {
    #[cfg_attr(test, ts(type = "number"))]
    pub general: i64,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "number | null"))]
    pub cajero: Option<i64>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "number | null"))]
    pub dueno: Option<i64>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "number | null"))]
    pub tecnico: Option<i64>,
}

impl Default for Inactividad {
    fn default() -> Self {
        Inactividad { general: INACTIVIDAD_DEFECTO, cajero: None, dueno: None, tecnico: None }
    }
}

impl Inactividad {
    /// Minutos de un rol: el suyo o el general; el técnico nunca más de 15.
    pub fn minutos(&self, rol: Rol) -> i64 {
        let propio = match rol {
            Rol::Cajero => self.cajero,
            Rol::Dueno => self.dueno,
            Rol::Tecnico => self.tecnico,
        };
        let m = propio.unwrap_or(self.general).clamp(1, INACTIVIDAD_MAX);
        if rol == Rol::Tecnico { m.min(INACTIVIDAD_MAX_TECNICO) } else { m }
    }
}

/// Toda la configuración de seguridad de una versión. Se valida con `validar` antes de guardarla y
/// otra vez al leerla (un JSON que no calza con este esquema no se usa).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Datos {
    /// Acción → política del cajero. Lo que no está: no permitido.
    pub cajero: BTreeMap<String, Politica>,
    pub tecnico: BTreeMap<String, Politica>,
    /// Excepciones: usuario (cajero) → acción → política.
    pub usuarios: BTreeMap<String, BTreeMap<String, Politica>>,
    pub motivos_anulacion: Vec<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub umbral_aviso_anulaciones: i64,
    /// Comprobante de anulación también en las opciones A y B (en C siempre).
    pub comprobante_anulacion_ab: bool,
    /// Se confirmó la advertencia de dejar ver totales al cajero.
    pub ver_totales_confirmado: bool,
    pub inactividad: Inactividad,
}

/// Lo vigente: versión, datos y si la cadena estaba rota al leerla.
#[derive(Debug, Clone)]
pub struct Vigente {
    pub version: i64,
    pub datos: Datos,
    /// Id de la primera versión con la cadena rota (se usa la última válida antes de ella).
    pub rota_en: Option<i64>,
}

pub fn plantilla_normal() -> Datos {
    let (cajero, tecnico) = CATALOGO.iter().fold((BTreeMap::new(), BTreeMap::new()), |(mut c, mut t), a| {
        if a.normal_cajero.nivel != Nivel::No {
            c.insert(a.id.to_string(), a.normal_cajero);
        }
        if a.normal_tecnico.nivel != Nivel::No {
            t.insert(a.id.to_string(), a.normal_tecnico);
        }
        (c, t)
    });
    Datos {
        cajero,
        tecnico,
        usuarios: BTreeMap::new(),
        motivos_anulacion: ["Error de digitación", "Cliente desistió", "Cobro duplicado", "Otro"].map(String::from).to_vec(),
        umbral_aviso_anulaciones: 3,
        comprobante_anulacion_ab: false,
        ver_totales_confirmado: false,
        inactividad: Inactividad::default(),
    }
}

/// Plantillas para elegir en la pantalla: "estricto", "normal" (= 0.9.2) y "flexible".
pub fn plantilla(nombre: &str, base: &Datos) -> Res<Datos> {
    let mut d = base.clone();
    let n = plantilla_normal();
    d.cajero = n.cajero.clone();
    d.tecnico = n.tecnico.clone();
    let lim = |m: Option<i64>, p: Option<f64>, c: Option<i64>, turno: bool, v: Option<i64>| Limites { monto_max: m, pct_max: p, cantidad_turno: c, solo_turno_abierto: turno, ventana_min: v, al_pasar: AlPasar::Pin };
    match nombre {
        "normal" => {}
        "estricto" => {
            d.cajero.insert("venta.descuento".into(), Politica { nivel: Nivel::Si, motivo: false, limites: lim(None, Some(0.0), None, false, None) });
            d.cajero.insert("caja.salida".into(), Politica { nivel: Nivel::Si, motivo: false, limites: lim(Some(0), None, None, false, None) });
            d.cajero.insert("caja.no_venta".into(), Politica::PIN_MOTIVO);
            d.cajero.insert("venta.sin_existencia".into(), Politica::PIN);
            d.cajero.insert("venta.descartar_espera".into(), Politica::MOTIVO);
            d.cajero.insert("venta.precio_libre".into(), Politica::PIN);
        }
        "flexible" => {
            d.cajero.insert("ventas.anular".into(), Politica { nivel: Nivel::Motivo, motivo: true, limites: lim(Some(10_000), None, Some(3), true, Some(30)) });
            d.cajero.insert("venta.descuento".into(), Politica { nivel: Nivel::Si, motivo: false, limites: lim(None, Some(15.0), None, false, None) });
            d.cajero.insert("caja.salida".into(), Politica { nivel: Nivel::Si, motivo: false, limites: lim(Some(30_000), None, None, false, None) });
        }
        _ => return Err("Plantilla desconocida".into()),
    }
    Ok(d)
}

static NORMAL: LazyLock<Arc<Vigente>> = LazyLock::new(|| Arc::new(Vigente { version: 0, datos: plantilla_normal(), rota_en: None }));

/// La plantilla Normal en memoria (pruebas de módulo que arman un Actor a mano).
pub fn normal() -> Arc<Vigente> {
    NORMAL.clone()
}

/// LA política efectiva de un usuario para una acción. Único lugar que la decide.
/// 1) reglas fijas · 2) excepción del usuario · 3) su rol · 4) si nada la define: no.
pub fn efectiva(d: &Datos, usuario_id: &str, rol: Rol, accion: &str) -> Politica {
    let Some(a) = buscar(accion) else { return Politica::NO };
    match rol {
        Rol::Dueno if a.dueno_sigue_cajero => {
            let c = a.ajustar(d.cajero.get(accion).copied().unwrap_or(Politica::NO));
            // Con su PIN el dueño siempre puede: el «no deja» al pasar es para el cajero (A6).
            Politica { nivel: if c.nivel == Nivel::Si { Nivel::Si } else { Nivel::Pin }, motivo: false, limites: Limites { al_pasar: AlPasar::Pin, ..c.limites } }
        }
        Rol::Dueno => a.dueno,
        Rol::Tecnico => {
            if a.protegida {
                Politica::NO
            } else if a.no_delegable {
                a.normal_tecnico
            } else {
                a.ajustar(d.tecnico.get(accion).copied().unwrap_or(Politica::NO))
            }
        }
        Rol::Cajero => {
            if a.no_delegable {
                return Politica::NO;
            }
            a.ajustar(d.usuarios.get(usuario_id).and_then(|m| m.get(accion)).or_else(|| d.cajero.get(accion)).copied().unwrap_or(Politica::NO))
        }
    }
}

/// Revisa una configuración antes de guardarla o de volver a ella. `cajeros`: ids de los usuarios con rol cajero.
pub fn validar(d: &Datos, cajeros: Option<&[String]>) -> Res<()> {
    validar_con(d, cajeros, true)
}

/// Quita las acciones que ya no existen en el catálogo (una versión guardada por un programa anterior).
pub fn sin_desconocidas(d: &mut Datos) {
    d.cajero.retain(|id, _| buscar(id).is_some());
    d.tecnico.retain(|id, _| buscar(id).is_some());
    for m in d.usuarios.values_mut() {
        m.retain(|id, _| buscar(id).is_some());
    }
}

/// `estricto`: además, cada nivel debe ser uno que la acción aplica (al guardar). Al leer una versión
/// vieja no: un nivel que ya no aplica se baja al más estricto (efectiva → Accion::ajustar).
fn validar_con(d: &Datos, cajeros: Option<&[String]>, estricto: bool) -> Res<()> {
    let revisar = |quien: &str, id: &str, p: &Politica, es_tecnico: bool| -> Res<()> {
        let a = buscar(id).ok_or_else(|| format!("Acción desconocida: {id}"))?;
        if estricto && !(es_tecnico && a.no_delegable) {
            a.admite(p)?;
        }
        if es_tecnico && a.protegida && p.nivel != Nivel::No {
            return Err(format!("El técnico no puede tener «{}»: lleva datos de clientes o dinero (Ley 8968).", a.nombre));
        }
        if !es_tecnico && a.no_delegable && p.nivel != Nivel::No {
            return Err(format!("{quien} no puede tener «{}».", a.nombre));
        }
        if es_tecnico && a.no_delegable && *p != a.normal_tecnico {
            return Err(format!("«{}» del técnico no se cambia.", a.nombre));
        }
        let l = &p.limites;
        let pide = |bit: u8, hay: bool, que: &str| if hay && a.limites & bit == 0 { Err(format!("«{}» no admite límite de {que}", a.nombre)) } else { Ok(()) };
        pide(L_MONTO, l.monto_max.is_some(), "monto")?;
        pide(L_PCT, l.pct_max.is_some(), "porcentaje")?;
        pide(L_CANTIDAD, l.cantidad_turno.is_some(), "cantidad por turno")?;
        pide(L_TURNO, l.solo_turno_abierto, "turno abierto")?;
        pide(L_VENTANA, l.ventana_min.is_some(), "tiempo")?;
        if l.monto_max.is_some_and(|m| !(0..=100_000_000).contains(&m)) || l.pct_max.is_some_and(|p| !(0.0..=100.0).contains(&p) || p.is_nan()) || l.cantidad_turno.is_some_and(|c| !(0..=1000).contains(&c)) || l.ventana_min.is_some_and(|v| !(1..=1440).contains(&v)) {
            return Err(format!("Límite fuera de rango en «{}»", a.nombre));
        }
        Ok(())
    };
    for (id, p) in &d.cajero {
        revisar("El cajero", id, p, false)?;
    }
    for (id, p) in &d.tecnico {
        revisar("El técnico", id, p, true)?;
    }
    for (u, m) in &d.usuarios {
        if let Some(c) = cajeros {
            if !c.contains(u) {
                return Err("Las excepciones por usuario son solo para cajeros".into());
            }
        }
        for (id, p) in m {
            revisar("Un cajero", id, p, false)?;
        }
    }
    let ve_totales = |p: Option<&Politica>| p.is_some_and(|p| p.nivel != Nivel::No);
    if !d.ver_totales_confirmado && (ve_totales(d.cajero.get("caja.ver_totales")) || d.usuarios.values().any(|m| ve_totales(m.get("caja.ver_totales")))) {
        return Err("Para que el cajero vea los totales con el turno abierto hay que confirmar la advertencia.".into());
    }
    if d.motivos_anulacion.is_empty() || d.motivos_anulacion.len() > 20 || d.motivos_anulacion.iter().any(|m| m.trim().is_empty() || m.chars().count() > 40 || m.chars().any(char::is_control)) {
        return Err("Motivos de anulación: de 1 a 20 textos cortos".into());
    }
    if !(0..=1000).contains(&d.umbral_aviso_anulaciones) {
        return Err("Umbral del aviso de anulaciones: de 0 a 1000".into());
    }
    validar_inactividad(&d.inactividad)
}

pub fn validar_inactividad(i: &Inactividad) -> Res<()> {
    for m in [Some(i.general), i.cajero, i.dueno, i.tecnico].into_iter().flatten() {
        if !(1..=INACTIVIDAD_MAX).contains(&m) {
            return Err(format!("El tiempo de bloqueo va de 1 a {INACTIVIDAD_MAX} minutos (no se puede desactivar)."));
        }
    }
    if i.tecnico.is_some_and(|m| m > INACTIVIDAD_MAX_TECNICO) {
        return Err(format!("El técnico se bloquea a los {INACTIVIDAD_MAX_TECNICO} minutos como máximo."));
    }
    Ok(())
}

fn limite_mas_flojo(a: &Limites, b: &Limites) -> bool {
    // Un límite que se quita o se sube es más permisivo.
    let mas = |x: Option<i64>, y: Option<i64>| match (x, y) {
        (Some(_), None) => true,
        (Some(x), Some(y)) => y > x,
        _ => false,
    };
    let mas_f = |x: Option<f64>, y: Option<f64>| match (x, y) {
        (Some(_), None) => true,
        (Some(x), Some(y)) => y > x,
        _ => false,
    };
    mas(a.monto_max, b.monto_max) || mas_f(a.pct_max, b.pct_max) || mas(a.cantidad_turno, b.cantidad_turno) || mas(a.ventana_min, b.ventana_min) || (a.solo_turno_abierto && !b.solo_turno_abierto) || (a.al_pasar == AlPasar::Bloquear && b.al_pasar == AlPasar::Pin)
}

/// ¿`nueva` da más permiso que `vieja`? Para el nivel: no < pin < motivo < sí; quitar el motivo del PIN
/// o aflojar un límite también. Si va de "no" a algo, todo límite es nuevo (no se compara).
pub fn politica_mas_permisiva(vieja: &Politica, nueva: &Politica) -> bool {
    if nueva.nivel > vieja.nivel {
        return true;
    }
    if nueva.nivel < vieja.nivel || nueva.nivel == Nivel::No {
        return false;
    }
    (vieja.motivo && !nueva.motivo) || limite_mas_flojo(&vieja.limites, &nueva.limites)
}

/// Lo que se afloja sobre algo sensible (o el tiempo de bloqueo por encima de 10 min). Si no está
/// vacío, guardar pide el PIN del dueño. Devuelve frases cortas para la bitácora.
pub fn mas_permisivo(vieja: &Datos, nueva: &Datos) -> Vec<String> {
    let mut v = vec![];
    for a in CATALOGO.iter().filter(|a| a.sensible) {
        let filas: Vec<(String, Option<&Politica>, Option<&Politica>)> = std::iter::once(("cajero".to_string(), vieja.cajero.get(a.id), nueva.cajero.get(a.id)))
            .chain(std::iter::once(("tecnico".to_string(), vieja.tecnico.get(a.id), nueva.tecnico.get(a.id))))
            .chain(nueva.usuarios.keys().chain(vieja.usuarios.keys()).map(|u| {
                // Sin excepción, el usuario sigue la del rol.
                let ve = vieja.usuarios.get(u).and_then(|m| m.get(a.id)).or(vieja.cajero.get(a.id));
                let nu = nueva.usuarios.get(u).and_then(|m| m.get(a.id)).or(nueva.cajero.get(a.id));
                (format!("usuario {u}"), ve, nu)
            }))
            .collect();
        for (quien, ve, nu) in filas {
            if politica_mas_permisiva(ve.unwrap_or(&Politica::NO), nu.unwrap_or(&Politica::NO)) {
                v.push(format!("{} ({quien})", a.id));
            }
        }
    }
    let (vi, ni) = (&vieja.inactividad, &nueva.inactividad);
    for rol in [Rol::Cajero, Rol::Dueno, Rol::Tecnico] {
        let (a, b) = (vi.minutos(rol), ni.minutos(rol));
        if b > a && b > INACTIVIDAD_DEFECTO {
            v.push(format!("inactividad ({})", rol.como_str()));
        }
    }
    if !vieja.ver_totales_confirmado && nueva.ver_totales_confirmado {
        v.push("caja.ver_totales (advertencia)".into());
    }
    // Avisar menos de las anulaciones o dejar de imprimir su comprobante también afloja (B11).
    if nueva.umbral_aviso_anulaciones > vieja.umbral_aviso_anulaciones {
        v.push("aviso de anulaciones".into());
    }
    if vieja.comprobante_anulacion_ab && !nueva.comprobante_anulacion_ab {
        v.push("comprobante de anulación".into());
    }
    v.sort();
    v.dedup();
    v
}

// ─────────── Aplicar la política dentro de la acción ───────────

/// Datos de la operación para revisar los límites (los arma quien llama, dentro de su transacción).
#[derive(Debug, Default, Clone)]
pub struct Contexto {
    pub monto: Option<i64>,
    pub pct: Option<f64>,
    /// Cuántas ya hizo este usuario en el turno abierto (sin contar esta).
    pub hechas_turno: Option<i64>,
    pub turno_abierto: Option<bool>,
    pub minutos_desde: Option<i64>,
    /// Motivo que vino en los argumentos del comando.
    pub motivo: Option<String>,
    /// Dueño que ya puso su PIN (verificado con usuarios::autorizar_dueno antes de la transacción).
    pub pin_de: Option<String>,
    /// Reglas fijas de la acción que obligan al PIN aunque se cumplan los límites (p. ej. venta facturada).
    pub pin_obligatorio: Option<String>,
}

/// Qué se aplicó: queda en la bitácora con la versión.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Aplicado {
    pub nivel: Nivel,
    /// Quién autorizó con su PIN (si hizo falta o si lo dio igual).
    pub autorizo: Option<String>,
    pub motivo: Option<String>,
    pub version: i64,
    /// El límite (o la regla fija) por el que se pidió el PIN.
    pub por: Option<String>,
}

pub const NECESITA_PIN: &str = "NECESITA_PIN";
pub const NECESITA_MOTIVO: &str = "NECESITA_MOTIVO";

/// Revisa la política efectiva del actor contra la operación. No toca la base: lo que cuenta
/// (cantidades, ventanas) lo trae `ctx`, armado en la misma transacción de la acción.
/// Errores: sin permiso · «NECESITA_PIN:acción:por qué» · «NECESITA_MOTIVO:acción» · bloqueado.
pub fn aplicar(a: &crate::sesion::Actor, accion: &str, ctx: &Contexto) -> Res<Aplicado> {
    let p = a.politica(accion);
    let nombre = buscar(accion).map(|x| x.nombre).unwrap_or(accion);
    if p.nivel == Nivel::No {
        return Err(crate::permisos::sin_permiso(&nombre.to_lowercase()));
    }
    let l = &p.limites;
    let miles = |n: i64| {
        let s = n.abs().to_string();
        let mut o = String::new();
        for (i, ch) in s.chars().enumerate() {
            if i > 0 && (s.len() - i) % 3 == 0 {
                o.push('.');
            }
            o.push(ch);
        }
        o
    };
    let mut exceso: Option<String> = None;
    if let (Some(m), Some(x)) = (l.monto_max, ctx.monto) {
        if x > m {
            exceso = Some(format!("pasa de ¢{}", miles(m)));
        }
    }
    if let (Some(m), Some(x)) = (l.pct_max, ctx.pct) {
        if x > m + 1e-9 {
            exceso.get_or_insert(format!("pasa del {m} %"));
        }
    }
    if let (Some(m), Some(x)) = (l.cantidad_turno, ctx.hechas_turno) {
        if x >= m {
            exceso.get_or_insert(format!("ya van {x} en este turno (máximo {m})"));
        }
    }
    if l.solo_turno_abierto && ctx.turno_abierto == Some(false) {
        exceso.get_or_insert("es de un turno cerrado".into());
    }
    if let (Some(m), Some(x)) = (l.ventana_min, ctx.minutos_desde) {
        if x > m {
            exceso.get_or_insert(format!("pasaron más de {m} minutos"));
        }
    }
    if exceso.is_some() && l.al_pasar == AlPasar::Bloquear {
        return Err(format!("No se puede: {}.", exceso.unwrap_or_default()));
    }
    let por = exceso.or_else(|| ctx.pin_obligatorio.clone());
    let nivel = if por.is_some() { Nivel::Pin } else { p.nivel };
    let token = a.autorizaciones.iter().find(|x| x.accion == accion);
    let autorizo = ctx.pin_de.clone().or_else(|| token.and_then(|t| t.autorizo.clone()));
    let motivo = ctx.motivo.clone().filter(|m| !m.trim().is_empty()).or_else(|| token.and_then(|t| t.motivo.clone()));
    if nivel == Nivel::Pin && autorizo.is_none() {
        return Err(format!("{NECESITA_PIN}:{accion}:{}", por.as_deref().unwrap_or("hace falta el PIN del dueño")));
    }
    if (p.nivel == Nivel::Motivo || p.motivo) && motivo.is_none() {
        return Err(format!("{NECESITA_MOTIVO}:{accion}"));
    }
    Ok(Aplicado { nivel, autorizo, motivo, version: a.seg.version, por })
}

// ─────────── Guardado: solo agregar, con cadena de hashes ───────────

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[allow(clippy::too_many_arguments)]
fn hash_version(prev: &str, id: i64, creada_en: &str, creada_por: &str, pin_dueno_de: &str, plantilla: &str, motivo: &str, datos: &str) -> String {
    let mut h = Sha256::new();
    for parte in [prev, &id.to_string(), creada_en, creada_por, pin_dueno_de, plantilla, motivo, datos] {
        h.update(parte.as_bytes());
        h.update([0x1f]);
    }
    hex(&h.finalize())
}

/// Lee la cadena completa. Devuelve la última versión válida (con la cadena sana hasta ella y un
/// JSON que calza con el esquema) y, si la hay, la primera rota.
pub async fn leer(c: &mut SqliteConnection) -> Res<Option<Vigente>> {
    let filas = sqlx::query("SELECT id, creada_en, creada_por, pin_dueno_de, plantilla, motivo, datos, hash_anterior, hash FROM seguridad_versiones ORDER BY id")
        .fetch_all(&mut *c)
        .await
        .map_err(e)?;
    let mut prev = String::new();
    let mut ultima: Option<Vigente> = None;
    for f in &filas {
        let s = |k: &str| f.try_get::<Option<String>, _>(k).ok().flatten().unwrap_or_default();
        let id: i64 = f.get("id");
        let esperado = hash_version(&prev, id, &s("creada_en"), &s("creada_por"), &s("pin_dueno_de"), &s("plantilla"), &s("motivo"), &s("datos"));
        let datos = serde_json::from_str::<Datos>(&s("datos")).ok().map(|mut d| {
            sin_desconocidas(&mut d);
            d
        });
        let datos = datos.filter(|d| validar_con(d, None, false).is_ok());
        match datos {
            Some(d) if s("hash_anterior") == prev && s("hash") == esperado => {
                ultima = Some(Vigente { version: id, datos: d, rota_en: None });
                prev = esperado;
            }
            _ => {
                return Ok(Some(match ultima {
                    Some(v) => Vigente { rota_en: Some(id), ..v },
                    // Ni la primera sirve: la plantilla Normal (lo de la 0.9.2), marcada como rota.
                    None => Vigente { version: 0, datos: plantilla_normal(), rota_en: Some(id) },
                }));
            }
        }
    }
    Ok(ultima)
}

/// Agrega una versión dentro de la transacción de quien guarda. Devuelve su id.
pub async fn agregar(c: &mut SqliteConnection, creada_por: Option<&str>, pin_dueno_de: Option<&str>, plantilla: Option<&str>, motivo: &str, d: &Datos) -> Res<i64> {
    let prev: Option<String> = sqlx::query_scalar("SELECT hash FROM seguridad_versiones ORDER BY id DESC LIMIT 1").fetch_optional(&mut *c).await.map_err(e)?;
    let prev = prev.unwrap_or_default();
    let id: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(id), 0) + 1 FROM seguridad_versiones").fetch_one(&mut *c).await.map_err(e)?;
    let creada_en = ahora_iso();
    let datos = serde_json::to_string(d).map_err(e)?;
    let h = hash_version(&prev, id, &creada_en, creada_por.unwrap_or(""), pin_dueno_de.unwrap_or(""), plantilla.unwrap_or(""), motivo, &datos);
    sqlx::query("INSERT INTO seguridad_versiones (id, creada_en, creada_por, pin_dueno_de, plantilla, motivo, datos, hash_anterior, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id)
        .bind(&creada_en)
        .bind(creada_por)
        .bind(pin_dueno_de)
        .bind(plantilla)
        .bind(motivo)
        .bind(&datos)
        .bind(&prev)
        .bind(&h)
        .execute(&mut *c)
        .await
        .map_err(e)?;
    Ok(id)
}

/// La versión 1: plantilla Normal con los topes que ya tenía la configuración (0.9.2). Así, al
/// actualizar o al restaurar un respaldo viejo, cada comando responde igual que antes.
pub async fn inicial_desde_config(c: &mut SqliteConnection) -> Res<(Datos, Vec<String>)> {
    let mut d = plantilla_normal();
    let mut notas = vec![];
    if let Some(p) = config::valor_con(c, "descuento_max_pct").await.and_then(|v| v.get("cajero").and_then(|x| x.as_f64())) {
        if let Some(pol) = d.cajero.get_mut("venta.descuento") {
            pol.limites.pct_max = Some(p.clamp(0.0, 100.0));
        }
    }
    let salida = config::entero_con(c, "caja_salida_max_sin_pin", acciones::CAJA_SALIDA_DEFECTO).await;
    if let Some(pol) = d.cajero.get_mut("caja.salida") {
        pol.limites.monto_max = Some(salida.clamp(0, 100_000_000));
    }
    let nv = config::entero_con(c, "caja_no_venta_umbral", 5).await;
    if nv > 0 {
        if let Some(pol) = d.cajero.get_mut("caja.no_venta") {
            pol.limites.cantidad_turno = Some(nv.clamp(0, 1000));
        }
    }
    if !config::booleano_con(c, "permitir_vender_sin_existencia", true).await {
        d.cajero.insert("venta.sin_existencia".into(), Politica::PIN);
    }
    if config::booleano_con(c, "venta_mostrar_existencia", false).await {
        d.cajero.insert("venta.ver_existencia".into(), Politica::SI);
    }
    let m = config::entero_con(c, "sesion_inactividad_min", INACTIVIDAD_DEFECTO).await;
    if m > INACTIVIDAD_MAX {
        notas.push(format!("El tiempo de inactividad era {m} minutos; ahora el máximo es {INACTIVIDAD_MAX}."));
    }
    d.inactividad.general = m.clamp(1, INACTIVIDAD_MAX);
    Ok((d, notas))
}

/// Si no hay ninguna versión (base de la 0.9.2 o respaldo viejo), crea la 1. Va después de las migraciones.
pub async fn asegurar_inicial(pool: &SqlitePool) -> Res<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let hay: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM seguridad_versiones").fetch_one(&mut *tx).await.map_err(e)?;
    if hay > 0 {
        return Ok(());
    }
    let (d, notas) = inicial_desde_config(&mut tx).await?;
    let id = agregar(&mut tx, None, None, Some("normal"), "Versión inicial (igual a la 0.9.2)", &d).await?;
    if !notas.is_empty() {
        bitacora::registrar(&mut tx, None, "seguridad.inicial", "seguridad", Some(&id.to_string()), &json!({"notas": notas})).await?;
    }
    tx.commit().await.map_err(e)?;
    Ok(())
}

/// Lee la vigente para ponerla en memoria (al abrir la app y al agregar una versión). Si la cadena
/// está rota lo anota en la bitácora (el dueño ve el aviso al entrar).
pub async fn cargar(pool: &SqlitePool) -> Res<Vigente> {
    let mut c = pool.acquire().await.map_err(e)?;
    let v = leer(&mut c).await?.unwrap_or(Vigente { version: 0, datos: plantilla_normal(), rota_en: None });
    drop(c);
    if let Some(rota) = v.rota_en {
        anotar_rota(pool, rota, v.version).await?;
    }
    Ok(v)
}

/// Revisión de la cadena (al cerrar la caja y en el diagnóstico). Devuelve el id roto, si hay.
pub async fn verificar(pool: &SqlitePool) -> Res<Option<i64>> {
    let mut c = pool.acquire().await.map_err(e)?;
    let v = leer(&mut c).await?;
    drop(c);
    let rota = v.as_ref().and_then(|v| v.rota_en);
    if let (Some(r), Some(v)) = (rota, v) {
        anotar_rota(pool, r, v.version).await?;
    }
    Ok(rota)
}

async fn anotar_rota(pool: &SqlitePool, rota: i64, usada: i64) -> Res<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    bitacora::registrar(&mut tx, None, "seguridad.alterada", "seguridad", Some(&rota.to_string()), &json!({"usada": usada})).await?;
    tx.commit().await.map_err(e)
}

/// Ids de los cajeros activos (para validar excepciones).
pub async fn cajeros(c: &mut SqliteConnection) -> Res<Vec<String>> {
    sqlx::query_scalar("SELECT id FROM usuarios WHERE rol = 'cajero' AND eliminado_en IS NULL").fetch_all(&mut *c).await.map_err(e)
}

/// Pruebas: el mismo actor con otra configuración de seguridad.
#[cfg(test)]
pub fn con(a: &crate::sesion::Actor, f: impl FnOnce(&mut Datos)) -> crate::sesion::Actor {
    let mut d = a.seg.datos.clone();
    f(&mut d);
    crate::sesion::Actor { seg: Arc::new(Vigente { version: a.seg.version + 1, datos: d, rota_en: None }), ..a.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_es_valida_y_mas_permisivo_detecta_cada_cambio() {
        let n = plantilla_normal();
        validar(&n, Some(&[])).unwrap();
        assert!(mas_permisivo(&n, &n).is_empty());
        // Darle anular al cajero (C): más permiso.
        let f = plantilla("flexible", &n).unwrap();
        assert!(mas_permisivo(&n, &f).iter().any(|x| x.starts_with("ventas.anular")));
        // Bajar el tope de descuento: no.
        let e = plantilla("estricto", &n).unwrap();
        assert!(mas_permisivo(&n, &e).is_empty(), "{:?}", mas_permisivo(&n, &e));
        // Cada forma de aflojar.
        let base = Politica { nivel: Nivel::Pin, motivo: true, limites: Limites { monto_max: Some(100), cantidad_turno: Some(2), solo_turno_abierto: true, ventana_min: Some(30), al_pasar: AlPasar::Bloquear, pct_max: Some(5.0) } };
        let flojas = [
            Politica { nivel: Nivel::Motivo, ..base },
            Politica { motivo: false, ..base },
            Politica { limites: Limites { monto_max: Some(200), ..base.limites }, ..base },
            Politica { limites: Limites { monto_max: None, ..base.limites }, ..base },
            Politica { limites: Limites { pct_max: Some(6.0), ..base.limites }, ..base },
            Politica { limites: Limites { cantidad_turno: Some(3), ..base.limites }, ..base },
            Politica { limites: Limites { solo_turno_abierto: false, ..base.limites }, ..base },
            Politica { limites: Limites { ventana_min: Some(31), ..base.limites }, ..base },
            Politica { limites: Limites { al_pasar: AlPasar::Pin, ..base.limites }, ..base },
        ];
        for f in flojas {
            assert!(politica_mas_permisiva(&base, &f), "{f:?}");
            assert!(!politica_mas_permisiva(&f, &base), "volver a apretar no pide PIN: {f:?}");
        }
        assert!(!politica_mas_permisiva(&base, &Politica::NO));
    }

    #[test]
    fn reglas_fijas_no_se_rompen() {
        let n = plantilla_normal();
        // Técnico con algo protegido.
        let mut d = n.clone();
        d.tecnico.insert("clientes.ver_todos".into(), Politica::SI);
        assert!(validar(&d, None).unwrap_err().contains("Ley 8968"));
        // Cajero con permisos o inactividad.
        for id in ["seguridad.editar", "seguridad.inactividad", "usuarios.administrar", "config.tecnica"] {
            let mut d = n.clone();
            d.cajero.insert(id.into(), Politica::SI);
            assert!(validar(&d, None).is_err(), "{id}");
            let mut d = n.clone();
            d.usuarios.insert("u".into(), BTreeMap::from([(id.to_string(), Politica::SI)]));
            assert!(validar(&d, None).is_err(), "{id} por excepción");
        }
        // Quitarle al técnico editar permisos (o ponérselo en «no»): no se puede; sin la fila, la fija manda.
        let mut d = n.clone();
        d.tecnico.insert("seguridad.editar".into(), Politica::NO);
        assert!(validar(&d, None).is_err());
        d.tecnico.remove("seguridad.editar");
        assert_eq!(efectiva(&d, "t", Rol::Tecnico, "seguridad.editar").nivel, Nivel::Si);
        // Ver totales sin la advertencia.
        let mut d = n.clone();
        d.cajero.insert("caja.ver_totales".into(), Politica::SI);
        assert!(validar(&d, None).is_err());
        d.ver_totales_confirmado = true;
        validar(&d, None).unwrap();
        // Excepción de alguien que no es cajero.
        let mut d = n.clone();
        d.usuarios.insert("dueno-1".into(), BTreeMap::from([("ventas.anular".to_string(), Politica::SI)]));
        assert!(validar(&d, Some(&["cajero-1".into()])).is_err());
        // Límite que la acción no admite.
        let mut d = n.clone();
        d.cajero.insert("venta.vender".into(), Politica { limites: Limites { monto_max: Some(1), ..Limites::NINGUNO }, ..Politica::SI });
        assert!(validar(&d, None).is_err());
        // Una acción que no existe.
        let mut d = n;
        d.cajero.insert("borrar.todo".into(), Politica::SI);
        assert!(validar(&d, None).is_err());
    }

    #[test]
    fn inactividad_rango_y_tecnico() {
        let ok = |i: Inactividad| validar_inactividad(&i).is_ok();
        assert!(ok(Inactividad::default()));
        assert!(!ok(Inactividad { general: 0, ..Default::default() }));
        assert!(!ok(Inactividad { general: 61, ..Default::default() }));
        assert!(!ok(Inactividad { cajero: Some(0), ..Default::default() }));
        assert!(ok(Inactividad { tecnico: Some(15), ..Default::default() }));
        assert!(!ok(Inactividad { tecnico: Some(16), ..Default::default() }));
        // "nunca" no es un número: el esquema lo rechaza.
        assert!(serde_json::from_str::<Inactividad>(r#"{"general":"nunca"}"#).is_err());
        // El técnico usa 15 aunque el general sea más.
        assert_eq!(Inactividad { general: 30, ..Default::default() }.minutos(Rol::Tecnico), 15);
        assert_eq!(Inactividad { general: 30, cajero: Some(5), ..Default::default() }.minutos(Rol::Cajero), 5);
        // Subir de 10 pide PIN; bajar no.
        let n = plantilla_normal();
        let mut d = n.clone();
        d.inactividad.general = 5;
        assert!(mas_permisivo(&n, &d).is_empty());
        d.inactividad.general = 11;
        assert!(!mas_permisivo(&n, &d).is_empty());
        let mut d2 = n.clone();
        d2.inactividad.general = 8;
        let mut d3 = d2.clone();
        d3.inactividad.general = 10;
        assert!(mas_permisivo(&d2, &d3).is_empty(), "subir hasta 10 no pide PIN");
    }

    #[test]
    fn efectiva_excepcion_gana_solo_para_su_accion() {
        let mut d = plantilla_normal();
        d.usuarios.insert("fabricio".into(), BTreeMap::from([("ventas.anular".to_string(), Politica::MOTIVO)]));
        assert_eq!(efectiva(&d, "fabricio", Rol::Cajero, "ventas.anular").nivel, Nivel::Motivo);
        assert_eq!(efectiva(&d, "ana", Rol::Cajero, "ventas.anular").nivel, Nivel::No);
        assert_eq!(efectiva(&d, "fabricio", Rol::Cajero, "caja.corte").nivel, Nivel::No);
        assert_eq!(efectiva(&d, "fabricio", Rol::Cajero, "venta.vender").nivel, Nivel::Si);
        // Acción desconocida: no.
        assert_eq!(efectiva(&d, "x", Rol::Dueno, "no.existe").nivel, Nivel::No);
    }

    #[tokio::test]
    async fn cadena_alterada_o_json_invalido_usa_la_ultima_valida_y_queda_en_bitacora() {
        let bd = crate::bd::Bd::memoria().await.unwrap();
        let p = &bd.pool;
        // La versión 1 la creó la migración (Normal, igual a la 0.9.2).
        let v = cargar(p).await.unwrap();
        assert_eq!((v.version, v.rota_en), (1, None));
        assert_eq!(v.datos, inicial_desde_config(&mut p.acquire().await.unwrap()).await.unwrap().0);
        // Una versión válida más.
        let mut d = v.datos.clone();
        d.inactividad.general = 5;
        let mut tx = p.begin().await.unwrap();
        agregar(&mut tx, None, None, None, "", &d).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(cargar(p).await.unwrap().version, 2);
        // Alguien mete a mano una versión que le da el corte al cajero, con un hash inventado.
        let mut malo = d.clone();
        malo.cajero.insert("caja.corte".into(), Politica::SI);
        let prev: String = sqlx::query_scalar("SELECT hash FROM seguridad_versiones WHERE id = 2").fetch_one(p).await.unwrap();
        sqlx::query("INSERT INTO seguridad_versiones (id, creada_en, datos, hash_anterior, hash) VALUES (3, 'x', ?, ?, ?)")
            .bind(serde_json::to_string(&malo).unwrap())
            .bind(&prev)
            .bind("a".repeat(64))
            .execute(p)
            .await
            .unwrap();
        let v = cargar(p).await.unwrap();
        assert_eq!((v.version, v.rota_en), (2, Some(3)));
        assert_eq!(efectiva(&v.datos, "c", Rol::Cajero, "caja.corte").nivel, Nivel::No);
        assert_eq!(verificar(p).await.unwrap(), Some(3));
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bitacora WHERE accion = 'seguridad.alterada'").fetch_one(p).await.unwrap();
        assert_eq!(n, 2, "al cargar y al verificar");
        // Hash correcto pero JSON que no calza con el esquema: tampoco se usa.
        let bd2 = crate::bd::Bd::memoria().await.unwrap();
        let p2 = &bd2.pool;
        let prev: String = sqlx::query_scalar("SELECT hash FROM seguridad_versiones WHERE id = 1").fetch_one(p2).await.unwrap();
        let datos = r#"{"cajero":{"caja.corte":{"nivel":"si"}},"extra":1}"#;
        let h = hash_version(&prev, 2, "x", "", "", "", "", datos);
        sqlx::query("INSERT INTO seguridad_versiones (id, creada_en, datos, hash_anterior, hash) VALUES (2, 'x', ?, ?, ?)").bind(datos).bind(&prev).bind(&h).execute(p2).await.unwrap();
        let v = cargar(p2).await.unwrap();
        assert_eq!((v.version, v.rota_en), (1, Some(2)));
    }
}