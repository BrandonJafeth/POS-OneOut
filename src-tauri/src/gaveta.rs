// Gaveta de dinero. Solo se abre por cuatro caminos, todos aquí y todos registrados:
//  1. Una venta cobrada con efectivo: una sola vez por venta (ventas.gaveta_abierta_en).
//  2. Una "no venta": el usuario elige un motivo de la lista (cambio de billetes, devolución,
//     otro con texto). Queda en gaveta_aperturas y en la bitácora, ligada al turno.
//  3. Una orden del dueño con su PIN (con o sin caja abierta), también registrada.
//  4. Al cerrar la caja, una vez, para contar el efectivo (no cuenta como "sin venta").
// Ningún trabajo de impresión puede abrirla: escpos::validar rechaza ESC p y DLE DC4.

use crate::bitacora;
use crate::caja;
use crate::config;
use crate::impresoras;
use crate::permisos::Rol;
use crate::sesion::Actor;
use crate::usuarios;
use crate::util::{ahora_iso, e, texto, ulid, Res};
use serde::Serialize;
use serde_json::json;
use sqlx::{Row, SqlitePool};

/// Abre la gaveta por una venta con efectivo recién cobrada (una sola vez por venta).
pub async fn por_venta(pool: &SqlitePool, a: &Actor, venta_id: &str) -> Res<()> {
    a.exigir("venta", "abrir la gaveta")?;
    if !config::booleano(pool, "abrir_gaveta_efectivo", true).await {
        return Err("La caja está configurada para no abrir la gaveta con las ventas.".into());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let v = sqlx::query(
        "SELECT v.caja_id, v.turno_id, v.estado, v.gaveta_abierta_en,
           EXISTS (SELECT 1 FROM venta_pagos p JOIN formas_pago f ON f.id = p.forma_pago_id
                   WHERE p.venta_id = v.id AND p.eliminado_en IS NULL AND f.da_vuelto = 1 AND (p.monto > 0 OR COALESCE(p.recibido, 0) > 0)) AS efectivo
         FROM ventas v WHERE v.id = ? AND v.eliminado_en IS NULL",
    )
    .bind(venta_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(e)?
    .ok_or("Venta no encontrada")?;
    if v.get::<String, _>("estado") != "completada" || v.get::<i64, _>("efectivo") != 1 {
        return Err("La gaveta solo se abre con una venta cobrada en efectivo.".into());
    }
    if v.get::<Option<String>, _>("gaveta_abierta_en").is_some() {
        return Err("La gaveta ya se abrió con esta venta. Para abrirla otra vez use «No venta».".into());
    }
    let caja_id: String = v.get("caja_id");
    let t = caja::turno_abierto(&mut tx, &caja_id).await?.filter(|t| Some(&t.id) == v.get::<Option<String>, _>("turno_id").as_ref()).ok_or("Esa venta es de un turno ya cerrado.")?;
    let comp = caja::compartido(&mut tx).await;
    caja::puede_operar(a, &t, comp)?;
    sqlx::query("UPDATE ventas SET gaveta_abierta_en = ? WHERE id = ?").bind(ahora_iso()).bind(venta_id).execute(&mut *tx).await.map_err(e)?;
    let r = impresoras::pulso_gaveta(&mut tx, &caja_id).await;
    cerrar(tx, r).await
}

/// Termina la apertura: si el pulso salió, se guarda. Si la impresora no contestó a tiempo, el pulso
/// pudo llegar tarde y abrir la gaveta: se guarda igual (nunca una apertura sin registro) y se avisa.
/// Si falló de otra forma (sin impresora, desconectada), no se abrió: no queda nada.
async fn cerrar(tx: sqlx::Transaction<'_, sqlx::Sqlite>, r: Res<()>) -> Res<()> {
    match r {
        Ok(()) => tx.commit().await.map_err(e),
        Err(m) if m.contains(impresoras::SIN_RESPUESTA) => {
            tx.commit().await.map_err(e)?;
            Err(format!("{m} Si la gaveta se abrió, quedó registrado."))
        }
        Err(m) => Err(m),
    }
}

/// Prefijo del error cuando falta el PIN del dueño: la pantalla lo reconoce y lo pide.
pub const PIN_GAVETA: &str = "PIN_GAVETA";

/// "No venta": abrir la gaveta sin vender (cambiar billetes…), con un motivo de la lista. Hasta el
/// límite del turno (caja_no_venta_umbral, el mismo de la alerta del cierre) es libre; desde ahí,
/// cada una necesita el PIN del dueño (el dueño no). Límite 0 = sin PIN nunca.
pub async fn no_venta(pool: &SqlitePool, a: &Actor, caja_id: &str, motivo: &str, nota: &str, pin: Option<&str>) -> Res<()> {
    a.exigir("caja", "abrir la gaveta")?;
    let motivo = texto(motivo, 60, "el motivo", true)?;
    let nota = texto(nota, 200, "el detalle", false)?;
    let lista = caja::motivos_no_venta(pool).await;
    if !lista.contains(&motivo) {
        return Err("Elija un motivo de la lista".into());
    }
    if motivo.to_lowercase().starts_with("otro") && nota.chars().count() < 3 {
        return Err("Escriba el motivo".into());
    }
    let umbral = config::entero(pool, "caja_no_venta_umbral", 5).await;
    // Fuera de la transacción: autorizar_dueno escribe (intentos fallidos) y la transacción tiene la base tomada.
    let previas: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM gaveta_aperturas g JOIN caja_turnos t ON t.id = g.turno_id WHERE g.caja_id = ? AND t.estado = 'abierto' AND g.causa = 'no_venta'",
    )
    .bind(caja_id)
    .fetch_one(pool)
    .await
    .map_err(e)?;
    let autorizado = if a.rol != Rol::Dueno && umbral > 0 && previas >= umbral {
        match pin.filter(|p| !p.is_empty()) {
            None => return Err(format!("{PIN_GAVETA}: ya van {previas} aperturas sin venta en este turno. Para abrirla otra vez hace falta el PIN del dueño.")),
            Some(p) => Some(usuarios::autorizar_dueno(pool, p, "abrir la gaveta sin venta", &a.id).await?),
        }
    } else {
        None
    };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let t = caja::turno_para_vender(&mut tx, caja_id, a).await?;
    let id = ulid();
    sqlx::query(
        "INSERT INTO gaveta_aperturas (id, sucursal_id, caja_id, turno_id, usuario_id, causa, motivo, nota, autorizado_por, fecha)
         SELECT ?, sucursal_id, id, ?, ?, 'no_venta', ?, ?, ?, ? FROM cajas WHERE id = ?",
    )
    .bind(&id)
    .bind(&t.id)
    .bind(&a.id)
    .bind(&motivo)
    .bind((!nota.is_empty()).then_some(&nota))
    .bind(&autorizado)
    .bind(ahora_iso())
    .bind(caja_id)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "gaveta.no_venta", "caja_turno", Some(&t.id), &json!({"aperturaId": id, "motivo": motivo, "nota": nota, "autorizadoPor": autorizado})).await?;
    // Si la gaveta no abre, no queda registro (la transacción se deshace); ver cerrar().
    let r = impresoras::pulso_gaveta(&mut tx, caja_id).await;
    cerrar(tx, r).await
}

/// Al cerrar la caja: abre la gaveta una vez para contar el efectivo. Solo quien puede cerrar ese
/// turno. No es "sin venta": no cuenta para el límite ni para la alerta del cierre.
pub async fn para_cierre(pool: &SqlitePool, a: &Actor, caja_id: &str) -> Res<()> {
    a.exigir("caja", "abrir la gaveta")?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let t = caja::turno_abierto(&mut tx, caja_id).await?.ok_or("La caja no está abierta")?;
    let comp = caja::compartido(&mut tx).await;
    caja::puede_cerrar(a, &t, comp)?;
    let ya: Option<i64> = sqlx::query_scalar("SELECT 1 FROM gaveta_aperturas WHERE turno_id = ? AND causa = 'cierre'").bind(&t.id).fetch_optional(&mut *tx).await.map_err(e)?;
    if ya.is_some() {
        return Err("La gaveta ya se abrió para este cierre. Si hace falta otra vez, use «Abrir gaveta».".into());
    }
    let id = ulid();
    sqlx::query(
        "INSERT INTO gaveta_aperturas (id, sucursal_id, caja_id, turno_id, usuario_id, causa, motivo, fecha)
         SELECT ?, sucursal_id, id, ?, ?, 'cierre', 'Contar para el cierre', ? FROM cajas WHERE id = ?",
    )
    .bind(&id)
    .bind(&t.id)
    .bind(&a.id)
    .bind(ahora_iso())
    .bind(caja_id)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "gaveta.cierre", "caja_turno", Some(&t.id), &json!({"aperturaId": id})).await?;
    let r = impresoras::pulso_gaveta(&mut tx, caja_id).await;
    cerrar(tx, r).await
}

/// Orden del dueño: abre la gaveta con su PIN (sirve aunque la caja esté cerrada).
pub async fn orden_dueno(pool: &SqlitePool, a: &Actor, caja_id: &str, pin: &str, motivo: &str) -> Res<()> {
    a.exigir("caja", "abrir la gaveta")?;
    let motivo = texto(motivo, 120, "el motivo", true)?;
    if motivo.chars().count() < 3 {
        return Err("Escriba el motivo".into());
    }
    if pin.is_empty() {
        return Err("Necesita el PIN del dueño".into());
    }
    let dueno = usuarios::autorizar_dueno(pool, pin, "abrir gaveta", &a.id).await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let turno = caja::turno_abierto(&mut tx, caja_id).await?.map(|t| t.id);
    let id = ulid();
    sqlx::query(
        "INSERT INTO gaveta_aperturas (id, sucursal_id, caja_id, turno_id, usuario_id, causa, motivo, autorizado_por, fecha)
         SELECT ?, sucursal_id, id, ?, ?, 'dueno', ?, ?, ? FROM cajas WHERE id = ?",
    )
    .bind(&id)
    .bind(&turno)
    .bind(&a.id)
    .bind(&motivo)
    .bind(&dueno)
    .bind(ahora_iso())
    .bind(caja_id)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "gaveta.orden_dueno", "caja", Some(caja_id), &json!({"aperturaId": id, "turnoId": turno, "motivo": motivo, "autorizadoPor": dueno})).await?;
    let r = impresoras::pulso_gaveta(&mut tx, caja_id).await;
    cerrar(tx, r).await
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Apertura {
    pub id: String,
    pub fecha: String,
    pub dia: Option<String>,
    pub usuario_id: String,
    pub usuario: String,
    pub causa: String,
    pub motivo: String,
    pub nota: Option<String>,
    pub autorizado_por: Option<String>,
    pub turno_id: Option<String>,
}

/// Vista del dueño: todas las aperturas sin venta, por fechas (día local) y usuario.
pub async fn listar(pool: &SqlitePool, a: &Actor, caja_id: &str, desde: &str, hasta: &str, usuario_id: Option<&str>) -> Res<Vec<Apertura>> {
    a.exigir("caja.admin", "ver las aperturas de gaveta")?;
    let filas = sqlx::query(
        "SELECT g.*, u.nombre AS usuario, ua.nombre AS autorizado, t.dia FROM gaveta_aperturas g JOIN usuarios u ON u.id = g.usuario_id
         LEFT JOIN usuarios ua ON ua.id = g.autorizado_por LEFT JOIN caja_turnos t ON t.id = g.turno_id
         WHERE g.caja_id = ?1 AND date(g.fecha, 'localtime') >= ?2 AND date(g.fecha, 'localtime') <= ?3 AND (?4 IS NULL OR g.usuario_id = ?4)
         ORDER BY g.fecha DESC LIMIT 1000",
    )
    .bind(caja_id)
    .bind(desde)
    .bind(hasta)
    .bind(usuario_id.filter(|s| !s.is_empty()))
    .fetch_all(pool)
    .await
    .map_err(e)?;
    Ok(filas
        .iter()
        .map(|f| Apertura {
            id: f.get("id"),
            fecha: f.get("fecha"),
            dia: f.get("dia"),
            usuario_id: f.get("usuario_id"),
            usuario: f.get("usuario"),
            causa: f.get("causa"),
            motivo: f.get("motivo"),
            nota: f.get("nota"),
            autorizado_por: f.get("autorizado"),
            turno_id: f.get("turno_id"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caja::tests::conteo;
    use crate::caja::{abrir, detalle, CAJA_1};
    use crate::impresoras::tests::dos_impresoras;
    use crate::printer::simulada;
    use crate::usuarios::tests::base_con_usuarios;

    #[tokio::test]
    async fn gaveta_solo_por_los_tres_caminos() {
        let (bd, tec, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        let (tiq, etq) = dos_impresoras(p, &dueno, "GAV").await;
        let pulso = crate::escpos::pulso_gaveta();
        // Sin caja abierta, "no venta" no se puede.
        assert!(no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "", None).await.unwrap_err().contains("cerrada"));
        let t = abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        // Motivo fuera de la lista u "Otro" sin texto: no.
        assert!(no_venta(p, &cajero, CAJA_1, "Porque sí", "", None).await.is_err());
        assert!(no_venta(p, &cajero, CAJA_1, "Otro", "", None).await.unwrap_err().contains("motivo"));
        no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "", None).await.unwrap();
        no_venta(p, &cajero, CAJA_1, "Otro", "Revisar billete falso", None).await.unwrap();
        // El técnico no abre la gaveta.
        assert!(no_venta(p, &tec, CAJA_1, "Cambio de billetes", "", None).await.unwrap_err().contains("permiso"));
        // Orden del dueño: con PIN del dueño (el del cajero no sirve).
        assert!(orden_dueno(p, &cajero, CAJA_1, "2580", "Poner fondo").await.is_err());
        orden_dueno(p, &cajero, CAJA_1, "246813", "Poner fondo").await.unwrap();
        // Cada apertura mandó el pulso SOLO a la impresora con gaveta.
        assert_eq!(simulada::trabajos(&tiq).iter().filter(|j| **j == pulso).count(), 3);
        assert!(simulada::trabajos(&etq).is_empty());
        // Gaveta apagada: no se registra una apertura que no ocurrió.
        simulada::apagar(&tiq, true);
        assert!(no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "", None).await.unwrap_err().contains("gaveta"));
        simulada::apagar(&tiq, false);
        let d = detalle(p, &dueno, &t.id).await.unwrap();
        assert_eq!(d.resumen.no_ventas.len(), 3);
        assert_eq!(d.resumen.no_ventas[1].nota.as_deref(), Some("Revisar billete falso"));
        // Vista del dueño, filtrada por usuario; el cajero no la ve.
        assert_eq!(listar(p, &dueno, CAJA_1, "2000-01-01", "2999-12-31", Some(&cajero.id)).await.unwrap().len(), 3);
        assert!(listar(p, &cajero, CAJA_1, "2000-01-01", "2999-12-31", None).await.is_err());
        // No se puede borrar el registro.
        assert!(sqlx::query("DELETE FROM gaveta_aperturas").execute(p).await.is_err());
    }

    #[tokio::test]
    async fn pasado_el_limite_del_turno_pide_el_pin_del_dueno() {
        let (bd, _, dueno, cajero) = base_con_usuarios().await;
        let p = &bd.pool;
        dos_impresoras(p, &dueno, "GAVPIN").await;
        sqlx::query("INSERT OR REPLACE INTO config (clave, valor) VALUES ('caja_no_venta_umbral', '2')").execute(p).await.unwrap();
        abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        // Hasta el límite, libre (la orden del dueño no cuenta).
        orden_dueno(p, &cajero, CAJA_1, "246813", "Poner fondo").await.unwrap();
        no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "", None).await.unwrap();
        no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "", None).await.unwrap();
        // Desde ahí: sin PIN o con el del cajero, no se abre ni queda registro.
        assert!(no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "", None).await.unwrap_err().starts_with(PIN_GAVETA));
        assert!(no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "", Some("2580")).await.is_err());
        no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "", Some("246813")).await.unwrap();
        let (n, con_pin): (i64, i64) = sqlx::query_as("SELECT COUNT(*), COUNT(autorizado_por) FROM gaveta_aperturas WHERE causa = 'no_venta'").fetch_one(p).await.unwrap();
        assert_eq!((n, con_pin), (3, 1));
        // El dueño no necesita PIN.
        no_venta(p, &dueno, CAJA_1, "Cambio de billetes", "", None).await.unwrap();
        // Abrir para contar el cierre: sin PIN aunque se pasó el límite, una sola vez, y no cuenta como "sin venta".
        para_cierre(p, &cajero, CAJA_1).await.unwrap();
        assert!(para_cierre(p, &cajero, CAJA_1).await.unwrap_err().contains("ya se abrió"));
        let t: String = sqlx::query_scalar("SELECT id FROM caja_turnos WHERE estado = 'abierto'").fetch_one(p).await.unwrap();
        let d = detalle(p, &dueno, &t).await.unwrap();
        assert_eq!(d.resumen.no_ventas.len(), 5); // 1 orden del dueño + 4 sin venta; la del cierre no
        assert!(d.resumen.no_ventas.iter().all(|x| x.causa != "cierre"));
        // Límite 0: nunca pide PIN.
        sqlx::query("UPDATE config SET valor = '0' WHERE clave = 'caja_no_venta_umbral'").execute(p).await.unwrap();
        no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "", None).await.unwrap();
    }

    /// La migración 18 reconstruye la tabla: las aperturas de antes siguen ahí, sin poder cambiarse ni
    /// borrarse, y se acepta el tipo nuevo 'cierre'.
    #[tokio::test]
    async fn migracion_18_conserva_las_aperturas() {
        let dir = std::env::temp_dir().join(format!("pos-gaveta-{}", crate::util::ulid()));
        std::fs::create_dir_all(&dir).unwrap();
        let vieja = crate::bd::crear_vieja(&dir.join("pos.db"), 17).await;
        sqlx::query("PRAGMA foreign_keys = OFF").execute(&vieja).await.unwrap();
        // Ids que existen (al copiar, la migración revisa las referencias como con datos reales).
        for q in [
            "INSERT INTO usuarios (id, nombre, rol, pin_hash) VALUES ('U', 'Cajero', 'cajero', 'x'), ('D', 'Dueño', 'dueno', 'x')",
            "INSERT INTO caja_turnos (id, sucursal_id, caja_id, usuario_apertura_id, abierto_en, estado) VALUES ('T', '0000000000000000000000S001', '0000000000000000000000C001', 'U', '2026-11-09', 'cerrado')",
            "INSERT INTO gaveta_aperturas (id, sucursal_id, caja_id, turno_id, usuario_id, causa, motivo, nota, autorizado_por, fecha) VALUES
               ('G1', '0000000000000000000000S001', '0000000000000000000000C001', 'T', 'U', 'no_venta', 'Cambio de billetes', 'n', 'D', '2026-11-09T15:00:00Z'),
               ('G2', '0000000000000000000000S001', '0000000000000000000000C001', NULL, 'U', 'dueno', 'Poner fondo', NULL, 'D', '2026-11-09T16:00:00Z')",
        ] {
            sqlx::query(q).execute(&vieja).await.unwrap();
        }
        vieja.close().await;

        let bd = crate::bd::Bd::abrir(&dir, None).await.unwrap();
        let p = &bd.pool;
        let filas: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as("SELECT id, causa, nota, autorizado_por FROM gaveta_aperturas ORDER BY id").fetch_all(p).await.unwrap();
        assert_eq!(filas, vec![("G1".into(), "no_venta".into(), Some("n".into()), Some("D".into())), ("G2".into(), "dueno".into(), None, Some("D".into()))]);
        assert!(sqlx::query("UPDATE gaveta_aperturas SET motivo = 'x'").execute(p).await.is_err());
        assert!(sqlx::query("DELETE FROM gaveta_aperturas").execute(p).await.is_err());
        sqlx::query("PRAGMA foreign_keys = OFF").execute(p).await.unwrap();
        sqlx::query("INSERT INTO gaveta_aperturas (id, sucursal_id, caja_id, usuario_id, causa, motivo, fecha) VALUES ('G3', '0000000000000000000000S001', '0000000000000000000000C001', 'U', 'cierre', 'Contar para el cierre', '2026-11-09T19:00:00Z')").execute(p).await.unwrap();
        assert!(sqlx::query("INSERT INTO gaveta_aperturas (id, sucursal_id, caja_id, usuario_id, causa, motivo, fecha) VALUES ('G4', 'S', 'C', 'U', 'otra', 'x', 'y')").execute(p).await.is_err());
        bd.pool.close().await;
        bd.lectura.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
