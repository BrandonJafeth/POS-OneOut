// Sesión del usuario, guardada en Rust. Cada comando toma el actor de aquí, nunca del frontend:
// la pantalla no puede hacerse pasar por otro usuario ni subir su rol.

use crate::permisos::{puede, sin_permiso, Rol};
use crate::util::Res;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub struct Actor {
    pub id: String,
    pub rol: Rol,
    pub nombre: String,
}

impl Actor {
    pub fn exigir(&self, permiso: &str, que: &str) -> Res<()> {
        if puede(self.rol, permiso) {
            Ok(())
        } else {
            Err(sin_permiso(que))
        }
    }
}

struct Activa {
    actor: Actor,
    ultimo: Instant,
    limite: Duration,
}

#[derive(Default)]
pub struct Sesion(Mutex<Option<Activa>>);

pub const EXPIRADA: &str = "SESION_EXPIRADA";

impl Sesion {
    pub async fn iniciar(&self, actor: Actor, minutos_inactividad: i64) {
        *self.0.lock().await = Some(Activa {
            actor,
            ultimo: Instant::now(),
            limite: Duration::from_secs(minutos_inactividad.clamp(1, 240) as u64 * 60),
        });
    }

    pub async fn cerrar(&self) {
        *self.0.lock().await = None;
    }

    /// El usuario de la sesión. Si pasó el tiempo de inactividad, la sesión se cierra.
    pub async fn actor(&self) -> Res<Actor> {
        let mut g = self.0.lock().await;
        match g.as_mut() {
            None => Err(EXPIRADA.into()),
            Some(a) if a.ultimo.elapsed() > a.limite => {
                *g = None;
                Err(EXPIRADA.into())
            }
            Some(a) => {
                a.ultimo = Instant::now();
                Ok(a.actor.clone())
            }
        }
    }

    /// Hay sesión vigente (sin renovarla).
    pub async fn vigente(&self) -> Option<Actor> {
        let g = self.0.lock().await;
        g.as_ref().filter(|a| a.ultimo.elapsed() <= a.limite).map(|a| a.actor.clone())
    }
}
