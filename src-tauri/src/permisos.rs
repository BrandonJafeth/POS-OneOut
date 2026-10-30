// Roles y permisos. Es la fuente que DECIDE (el frontend solo esconde botones con su copia en
// src/lib/permisos.ts). Mantener ambas listas iguales.

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

const CAJERO: &[&str] = &["venta", "caja", "clientes.basico", "facturas"];
const DUENO: &[&str] = &[
    "venta",
    "caja",
    "caja.admin",
    "productos",
    "productos.importar",
    "departamentos",
    "usuarios",
    "negocio",
    "reportes",
    "clientes.basico",
    "clientes",
    "respaldo",
    "facturas",
];
// El técnico configura el sistema; no vende, no maneja caja ni ve datos de clientes.
const TECNICO: &[&str] = &[
    "productos",
    "productos.importar",
    "departamentos",
    "departamentos.estructura",
    "usuarios",
    "negocio",
    "negocio.legal",
    "config.tecnica",
    "reportes",
];

pub fn puede(rol: Rol, permiso: &str) -> bool {
    match rol {
        Rol::Cajero => CAJERO,
        Rol::Dueno => DUENO,
        Rol::Tecnico => TECNICO,
    }
    .contains(&permiso)
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
    format!("No tiene permiso para {que}")
}
