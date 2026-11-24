// Roles. Qué puede hacer cada uno lo decide politica.rs (acciones configurables por rol y usuario).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Rol {
    Cajero,
    Dueno,
    Tecnico,
}

impl Rol {
    pub fn desde(s: &str) -> Option<Rol> {
        match s {
            "cajero" => Some(Rol::Cajero),
            "dueno" => Some(Rol::Dueno),
            "tecnico" => Some(Rol::Tecnico),
            _ => None,
        }
    }
    pub fn como_str(self) -> &'static str {
        match self {
            Rol::Cajero => "cajero",
            Rol::Dueno => "dueno",
            Rol::Tecnico => "tecnico",
        }
    }
}

/// Roles que `rol` puede crear o administrar (además de cambiar su propio PIN).
pub fn administrables(rol: Rol) -> &'static [Rol] {
    match rol {
        Rol::Tecnico => &[Rol::Dueno, Rol::Cajero],
        Rol::Dueno => &[Rol::Cajero],
        Rol::Cajero => &[],
    }
}

pub fn sin_permiso(que: &str) -> String {
    format!("No tiene permiso para {que}. Si lo necesita, pídaselo al dueño o al administrador.")
}
