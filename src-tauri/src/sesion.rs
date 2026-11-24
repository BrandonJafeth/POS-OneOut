// Sesión del usuario, guardada en Rust. Cada comando toma el actor de aquí, nunca del frontend:
// la pantalla no puede hacerse pasar por otro usuario ni subir su rol.
//
// Bloqueo por inactividad (DISENO-PERMISOS.md §5): lo decide Rust con el reloj de `util::ahora`.
// Solo la actividad real que informa la pantalla (teclado, lector, mouse, táctil: `tocar`) renueva
// el plazo; los comandos no. Al vencer, la sesión queda BLOQUEADA (no se cierra): ningún comando
// corre hasta que el mismo usuario ponga su PIN, y la pantalla conserva lo que tenía abierto.
// Un comando que ya empezó (cobro, impresión) termina: el bloqueo cae en el siguiente.

use crate::acciones::{Nivel, Politica};
use crate::permisos::{sin_permiso, Rol};
use crate::politica::{self, Vigente};
use crate::util::Res;
use chrono::{DateTime, FixedOffset};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub struct Actor {
    pub id: String,
    pub rol: Rol,
    pub nombre: String,
    /// La configuración de seguridad vigente cuando empezó el comando.
    pub seg: Arc<Vigente>,
    /// Autorizaciones de un solo uso (PIN del dueño o motivo) que trajo ESTE comando.
    pub autorizaciones: Vec<Autorizacion>,
}

impl Actor {
    /// Con la plantilla Normal (pruebas de módulo y usos internos sin App).
    pub fn nuevo(id: impl Into<String>, rol: Rol, nombre: impl Into<String>) -> Actor {
        Actor { id: id.into(), rol, nombre: nombre.into(), seg: politica::normal(), autorizaciones: vec![] }
    }
    pub fn politica(&self, accion: &str) -> Politica {
        politica::efectiva(&self.seg.datos, &self.id, self.rol, accion)
    }
    pub fn puede(&self, accion: &str) -> bool {
        self.politica(accion).nivel != Nivel::No
    }
    pub fn exigir(&self, accion: &str, que: &str) -> Res<()> {
        if self.puede(accion) { Ok(()) } else { Err(sin_permiso(que)) }
    }
}

struct Activa {
    id: String,
    rol: Rol,
    nombre: String,
    ultimo: DateTime<FixedOffset>,
    bloqueada: bool,
    en_curso: Arc<AtomicU32>,
    /// Autorizaciones de un solo uso (PIN del dueño o motivo) para una acción de la puerta común.
    autorizaciones: Vec<Autorizacion>,
}

/// Lo que se dio para UNA llamada de una acción con «PIN» o «motivo» (seguridad_autorizar).
#[derive(Debug, Clone)]
pub struct Autorizacion {
    pub accion: String,
    pub autorizo: Option<String>,
    pub motivo: Option<String>,
    pub vence: DateTime<FixedOffset>,
}

#[derive(Default)]
pub struct Sesion(Mutex<Option<Activa>>);

pub const EXPIRADA: &str = "SESION_EXPIRADA";
pub const BLOQUEADA: &str = "SESION_BLOQUEADA";

/// Mientras vive, la sesión no se bloquea (un cobro o una impresión no se cortan a la mitad).
#[derive(Debug)]
pub struct Guardia(Arc<AtomicU32>);
impl Drop for Guardia {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(serde::Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EstadoSesion {
    pub bloqueada: bool,
    /// Milisegundos hasta el bloqueo (0 si ya está bloqueada).
    pub restante_ms: i64,
    pub minutos: i64,
}

fn vencida(a: &Activa, minutos: i64, ahora: DateTime<FixedOffset>) -> bool {
    a.en_curso.load(Ordering::SeqCst) == 0 && (ahora - a.ultimo).num_milliseconds() >= minutos * 60_000
}

impl Sesion {
    pub async fn iniciar(&self, actor: Actor) {
        *self.0.lock().await = Some(Activa { id: actor.id, rol: actor.rol, nombre: actor.nombre, ultimo: crate::util::ahora(), bloqueada: false, en_curso: Arc::new(AtomicU32::new(0)), autorizaciones: vec![] });
    }

    pub async fn cerrar(&self) {
        *self.0.lock().await = None;
    }

    /// El usuario de la sesión para un comando. Si venció el tiempo, la bloquea.
    pub async fn actor(&self, seg: &Arc<Vigente>) -> Res<(Actor, Guardia)> {
        let mut g = self.0.lock().await;
        let a = g.as_mut().ok_or(EXPIRADA)?;
        if !a.bloqueada && vencida(a, seg.datos.inactividad.minutos(a.rol), crate::util::ahora()) {
            a.bloqueada = true;
        }
        if a.bloqueada {
            return Err(BLOQUEADA.into());
        }
        a.en_curso.fetch_add(1, Ordering::SeqCst);
        // Las autorizaciones pendientes van con este comando y se gastan aunque no las use.
        let ahora = crate::util::ahora();
        let autorizaciones = std::mem::take(&mut a.autorizaciones).into_iter().filter(|x| x.vence > ahora).collect();
        Ok((Actor { id: a.id.clone(), rol: a.rol, nombre: a.nombre.clone(), seg: seg.clone(), autorizaciones }, Guardia(a.en_curso.clone())))
    }

    /// Hubo actividad real en la pantalla. Si ya venció, bloquea (la pantalla dejó de avisar).
    pub async fn tocar(&self, seg: &Vigente) -> Res<()> {
        let mut g = self.0.lock().await;
        let a = g.as_mut().ok_or(EXPIRADA)?;
        let ahora = crate::util::ahora();
        if a.bloqueada || vencida(a, seg.datos.inactividad.minutos(a.rol), ahora) {
            a.bloqueada = true;
            return Err(BLOQUEADA.into());
        }
        a.ultimo = ahora;
        Ok(())
    }

    /// Para la pantalla (aviso de 1 minuto y velo), sin renovar.
    pub async fn estado(&self, seg: &Vigente) -> Option<EstadoSesion> {
        let mut g = self.0.lock().await;
        let a = g.as_mut()?;
        let minutos = seg.datos.inactividad.minutos(a.rol);
        if !a.bloqueada && vencida(a, minutos, crate::util::ahora()) {
            a.bloqueada = true;
        }
        let restante = if a.bloqueada { 0 } else { (minutos * 60_000 - (crate::util::ahora() - a.ultimo).num_milliseconds()).max(0) };
        Some(EstadoSesion { bloqueada: a.bloqueada, restante_ms: restante, minutos })
    }

    /// Quién está en la sesión (bloqueada o no), sin renovar.
    pub async fn usuario(&self) -> Option<(String, Rol, String, bool)> {
        let g = self.0.lock().await;
        g.as_ref().map(|a| (a.id.clone(), a.rol, a.nombre.clone(), a.bloqueada))
    }

    /// El mismo usuario volvió a poner su PIN: sigue donde estaba.
    pub async fn desbloquear(&self, id: &str) -> bool {
        let mut g = self.0.lock().await;
        match g.as_mut() {
            Some(a) if a.id == id => {
                a.bloqueada = false;
                a.ultimo = crate::util::ahora();
                true
            }
            _ => false,
        }
    }

    /// Guarda una autorización de un solo uso (vence a los 2 minutos).
    pub async fn autorizar(&self, accion: &str, autorizo: Option<String>, motivo: Option<String>) -> Res<()> {
        let mut g = self.0.lock().await;
        let a = g.as_mut().ok_or(EXPIRADA)?;
        let vence = crate::util::ahora() + chrono::Duration::minutes(2);
        a.autorizaciones.retain(|x| x.accion != accion);
        a.autorizaciones.push(Autorizacion { accion: accion.into(), autorizo, motivo, vence });
        Ok(())
    }

    /// Pruebas: como si hubiera vencido el tiempo.
    #[cfg(test)]
    pub async fn forzar_bloqueo(&self) {
        if let Some(a) = self.0.lock().await.as_mut() {
            a.bloqueada = true;
        }
    }

    /// Sesión vigente y sin bloquear (al recargar la ventana), sin renovar el plazo.
    pub async fn vigente(&self, seg: &Arc<Vigente>) -> Option<Actor> {
        let g = self.0.lock().await;
        g.as_ref().filter(|a| !a.bloqueada && !vencida(a, seg.datos.inactividad.minutos(a.rol), crate::util::ahora())).map(|a| Actor { id: a.id.clone(), rol: a.rol, nombre: a.nombre.clone(), seg: seg.clone(), autorizaciones: vec![] })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::fijar_reloj;

    fn seg(min: i64) -> Arc<Vigente> {
        let mut d = politica::plantilla_normal();
        d.inactividad.general = min;
        d.inactividad.dueno = Some(3);
        Arc::new(Vigente { version: 1, datos: d, rota_en: None })
    }

    #[tokio::test]
    async fn bloquea_justo_al_vencer_por_rol_y_solo_la_actividad_renueva() {
        let s = Sesion::default();
        let v = seg(10);
        fijar_reloj("2026-11-24T10:00:00-06:00");
        s.iniciar(Actor::nuevo("c", Rol::Cajero, "Luis")).await;
        // Un comando no renueva el plazo.
        fijar_reloj("2026-11-24T10:09:00-06:00");
        drop(s.actor(&v).await.unwrap());
        fijar_reloj("2026-11-24T10:09:59.950-06:00");
        drop(s.actor(&v).await.unwrap());
        fijar_reloj("2026-11-24T10:10:00.050-06:00");
        assert_eq!(s.actor(&v).await.unwrap_err(), BLOQUEADA);
        // Bloqueada: tocar no la revive; nada corre.
        assert_eq!(s.tocar(&v).await.unwrap_err(), BLOQUEADA);
        assert!(s.vigente(&v).await.is_none());
        // Otro usuario no la desbloquea; el mismo sí.
        assert!(!s.desbloquear("otro").await);
        assert!(s.desbloquear("c").await);
        drop(s.actor(&v).await.unwrap());
        // La actividad real renueva.
        fijar_reloj("2026-11-24T10:19:00-06:00");
        s.tocar(&v).await.unwrap();
        fijar_reloj("2026-11-24T10:28:59-06:00");
        drop(s.actor(&v).await.unwrap());
        // Dueño con su propio tiempo (3 min).
        s.iniciar(Actor::nuevo("d", Rol::Dueno, "Ana")).await;
        fijar_reloj("2026-11-24T10:31:58-06:00");
        let r = s.estado(&v).await.unwrap().restante_ms;
        assert!((900..=1_100).contains(&r), "{r}");
        fijar_reloj("2026-11-24T10:31:59.050-06:00");
        assert_eq!(s.actor(&v).await.unwrap_err(), BLOQUEADA);
        assert!(s.estado(&v).await.unwrap().bloqueada);
    }

    #[tokio::test]
    async fn no_bloquea_a_la_mitad_de_un_comando_y_el_cambio_aplica_de_inmediato() {
        let s = Sesion::default();
        fijar_reloj("2026-11-24T10:00:00-06:00");
        s.iniciar(Actor::nuevo("c", Rol::Cajero, "Luis")).await;
        let (_, cobro) = s.actor(&seg(1)).await.unwrap();
        // El cobro sigue en curso pasado el minuto: otro comando (la impresión) corre.
        fijar_reloj("2026-11-24T10:05:00-06:00");
        drop(s.actor(&seg(1)).await.unwrap());
        drop(cobro);
        // Terminó: el siguiente bloquea.
        assert_eq!(s.actor(&seg(1)).await.unwrap_err(), BLOQUEADA);
        // El tiempo nuevo aplica en el siguiente comando, sin volver a entrar.
        s.iniciar(Actor::nuevo("c", Rol::Cajero, "Luis")).await;
        fijar_reloj("2026-11-24T10:07:00-06:00");
        drop(s.actor(&seg(10)).await.unwrap());
        assert_eq!(s.actor(&seg(1)).await.unwrap_err(), BLOQUEADA);
    }
}
