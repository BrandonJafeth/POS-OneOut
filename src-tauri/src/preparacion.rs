// "Preparar para el cliente" (técnico): lista de lo que tiene que estar listo antes de entregar.
// Cada punto lo decide la base, no la pantalla. Solo informa: no cambia nada.

use crate::bd::Bd;
use crate::sesion::Actor;
use crate::util::{e, Res};
use serde::Serialize;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Punto {
    pub titulo: &'static str,
    pub listo: bool,
    /// Qué falta o qué hay, y dónde se arregla.
    pub detalle: String,
}

async fn n(bd: &Bd, sql: &str) -> Res<i64> {
    sqlx::query_scalar(sql).fetch_one(&bd.pool).await.map_err(e)
}

pub async fn revisar(bd: &Bd, a: &Actor) -> Res<Vec<Punto>> {
    a.exigir("config.tecnica", "preparar la instalación")?;
    let mut v = vec![];
    let negocio: (String, String) = sqlx::query_as("SELECT COALESCE(nombre_comercial, ''), COALESCE(cedula, '') FROM negocio WHERE id = 1").fetch_optional(&bd.pool).await.map_err(e)?.unwrap_or_default();
    v.push(Punto {
        titulo: "Datos del negocio",
        listo: !negocio.0.trim().is_empty() && !negocio.1.trim().is_empty(),
        detalle: "Nombre comercial y cédula (salen en el tiquete). Administración → Datos del negocio.".into(),
    });
    let duenos = n(bd, "SELECT COUNT(*) FROM usuarios WHERE rol = 'dueno' AND activo = 1 AND eliminado_en IS NULL").await?;
    v.push(Punto { titulo: "Usuario del dueño", listo: duenos > 0, detalle: format!("{duenos} dueño(s) activo(s). Al entrar por primera vez cada uno cambia su PIN. Administración → Usuarios.") });
    let prueba = n(bd, "SELECT COUNT(*) FROM usuarios WHERE eliminado_en IS NULL AND (lower(nombre) LIKE '%prueba%' OR lower(nombre) LIKE '%test%' OR lower(nombre) LIKE '%demo%')").await?;
    v.push(Punto { titulo: "Sin usuarios de prueba", listo: prueba == 0, detalle: if prueba == 0 { "Ninguno.".into() } else { format!("Hay {prueba} usuario(s) con nombre de prueba: elimínelos en Administración → Usuarios.") } });
    let efectivo = n(bd, "SELECT COUNT(*) FROM formas_pago WHERE activo = 1 AND eliminado_en IS NULL AND da_vuelto = 1").await?;
    let formas = n(bd, "SELECT COUNT(*) FROM formas_pago WHERE activo = 1 AND eliminado_en IS NULL").await?;
    v.push(Punto { titulo: "Formas de pago", listo: efectivo > 0, detalle: format!("{formas} activa(s), {efectivo} con vuelto (efectivo). Técnico → Formas de pago.") });
    let deps = n(bd, "SELECT COUNT(*) FROM departamentos WHERE activo = 1 AND eliminado_en IS NULL").await?;
    v.push(Punto { titulo: "Departamentos", listo: deps > 0, detalle: format!("{deps} activo(s). Administración → Departamentos.") });
    let asignados = n(bd, "SELECT COUNT(*) FROM impresora_destinos d JOIN impresoras i ON i.id = d.impresora_id WHERE i.eliminado_en IS NULL AND d.documento IN ('tiquete', 'cierre')").await?;
    v.push(Punto { titulo: "Impresoras", listo: asignados >= 2, detalle: "Tiquete y cierre con impresora asignada (y «Imprimir prueba»). Administración → Impresoras.".into() });
    let gaveta = n(bd, "SELECT COUNT(*) FROM impresoras WHERE gaveta = 1 AND eliminado_en IS NULL").await?;
    v.push(Punto { titulo: "Gaveta", listo: gaveta > 0, detalle: "Marcada en la impresora de tiquetes. Administración → Impresoras.".into() });
    let productos = n(bd, "SELECT COUNT(*) FROM productos WHERE eliminado_en IS NULL").await?;
    v.push(Punto { titulo: "Productos", listo: productos > 0, detalle: format!("{productos} en el catálogo. Productos → Importar productos.") });
    let siguiente = n(bd, "SELECT MIN(consecutivo_siguiente) FROM cajas WHERE eliminado_en IS NULL").await?;
    v.push(Punto { titulo: "Número del próximo tiquete", listo: true, detalle: format!("{siguiente}. Si venía de otro sistema, que siga al último tiquete entregado. Administración → Caja y cierre.") });
    let dir = bd.dir.as_ref().ok_or("Sin carpeta de datos")?;
    v.push(Punto {
        titulo: "Respaldo automático",
        listo: dir.join("respaldo-automatico.clave").exists(),
        detalle: "El dueño elige la contraseña y la anota fuera de la computadora. Administración → Respaldo.".into(),
    });
    let (ventas, turnos, clientes) = (n(bd, "SELECT COUNT(*) FROM ventas").await?, n(bd, "SELECT COUNT(*) FROM caja_turnos").await?, n(bd, "SELECT COUNT(*) FROM clientes").await?);
    v.push(Punto {
        titulo: "Sin datos de prueba",
        listo: ventas == 0 && turnos == 0 && clientes == 0,
        detalle: if ventas + turnos + clientes == 0 {
            "Sin ventas, turnos ni clientes: lista para el primer día.".into()
        } else {
            format!("Hay {ventas} venta(s), {turnos} turno(s) y {clientes} cliente(s). Si son de prueba, instale limpio (ver PRUEBAS-MANUALES, «Instalación limpia»).")
        },
    });
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permisos::Rol;

    #[tokio::test]
    async fn base_recien_instalada_sin_datos_y_con_lo_pendiente_marcado() {
        let dir = std::env::temp_dir().join(format!("pos-prep-{}", crate::util::ulid()));
        let bd = Bd::abrir(&dir, None).await.unwrap();
        // Recién instalada: nada de prueba adentro (ni usuarios, ni ventas, ni clientes, ni PIN por defecto).
        for t in ["usuarios", "ventas", "caja_turnos", "clientes", "venta_pagos", "bitacora"] {
            let c: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {t}")).fetch_one(&bd.pool).await.unwrap();
            assert_eq!(c, 0, "{t}");
        }
        let t = crate::usuarios::crear_tecnico_inicial(&bd.pool, "735919").await.unwrap();
        let tec = Actor { id: t.id, rol: Rol::Tecnico, nombre: "T".into() };
        let lista = revisar(&bd, &tec).await.unwrap();
        let punto = |t: &str| lista.iter().find(|p| p.titulo == t).unwrap().listo;
        assert!(!punto("Usuario del dueño") && !punto("Impresoras") && !punto("Respaldo automático") && !punto("Productos"));
        assert!(punto("Sin datos de prueba") && punto("Sin usuarios de prueba"));
        crate::usuarios::crear(&bd.pool, &tec, "Usuario Prueba", Rol::Cajero, "1593").await.unwrap();
        let lista = revisar(&bd, &tec).await.unwrap();
        assert!(!lista.iter().find(|p| p.titulo == "Sin usuarios de prueba").unwrap().listo);
        // Solo el técnico.
        let d = crate::usuarios::crear(&bd.pool, &tec, "Ana", Rol::Dueno, "246813").await.unwrap();
        assert!(revisar(&bd, &Actor { id: d.id, rol: Rol::Dueno, nombre: "Ana".into() }).await.is_err());
        bd.pool.close().await;
        bd.lectura.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
