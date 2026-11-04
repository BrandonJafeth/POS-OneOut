// Gaveta de dinero. Solo se abre por tres caminos, todos aquí y todos registrados:
//  1. Una venta cobrada con efectivo: una sola vez por venta (ventas.gaveta_abierta_en).
//  2. Una "no venta": el usuario elige un motivo de la lista (cambio de billetes, devolución,
//     otro con texto). Queda en gaveta_aperturas y en la bitácora, ligada al turno.
//  3. Una orden del dueño con su PIN (con o sin caja abierta), también registrada.
// Ningún trabajo de impresión puede abrirla: escpos::validar rechaza ESC p y DLE DC4.

use crate::bitacora;
use crate::caja;
use crate::config;
use crate::impresoras;
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
    impresoras::pulso_gaveta(&mut tx, &caja_id).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
}

/// "No venta": abrir la gaveta sin vender (cambiar billetes…), con un motivo de la lista.
pub async fn no_venta(pool: &SqlitePool, a: &Actor, caja_id: &str, motivo: &str, nota: &str) -> Res<()> {
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
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(e)?;
    let t = caja::turno_para_vender(&mut tx, caja_id, a).await?;
    let id = ulid();
    sqlx::query(
        "INSERT INTO gaveta_aperturas (id, sucursal_id, caja_id, turno_id, usuario_id, causa, motivo, nota, fecha)
         SELECT ?, sucursal_id, id, ?, ?, 'no_venta', ?, ?, ? FROM cajas WHERE id = ?",
    )
    .bind(&id)
    .bind(&t.id)
    .bind(&a.id)
    .bind(&motivo)
    .bind((!nota.is_empty()).then_some(&nota))
    .bind(ahora_iso())
    .bind(caja_id)
    .execute(&mut *tx)
    .await
    .map_err(e)?;
    bitacora::registrar(&mut tx, Some(&a.id), "gaveta.no_venta", "caja_turno", Some(&t.id), &json!({"aperturaId": id, "motivo": motivo, "nota": nota})).await?;
    // Si la gaveta no abre, no queda registro (la transacción se deshace).
    impresoras::pulso_gaveta(&mut tx, caja_id).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
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
    impresoras::pulso_gaveta(&mut tx, caja_id).await?;
    tx.commit().await.map_err(e)?;
    Ok(())
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
        assert!(no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "").await.unwrap_err().contains("cerrada"));
        let t = abrir(p, &cajero, CAJA_1, &conteo(&[(1000, 5)])).await.unwrap();
        // Motivo fuera de la lista u "Otro" sin texto: no.
        assert!(no_venta(p, &cajero, CAJA_1, "Porque sí", "").await.is_err());
        assert!(no_venta(p, &cajero, CAJA_1, "Otro", "").await.unwrap_err().contains("motivo"));
        no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "").await.unwrap();
        no_venta(p, &cajero, CAJA_1, "Otro", "Revisar billete falso").await.unwrap();
        // El técnico no abre la gaveta.
        assert!(no_venta(p, &tec, CAJA_1, "Cambio de billetes", "").await.unwrap_err().contains("permiso"));
        // Orden del dueño: con PIN del dueño (el del cajero no sirve).
        assert!(orden_dueno(p, &cajero, CAJA_1, "2580", "Poner fondo").await.is_err());
        orden_dueno(p, &cajero, CAJA_1, "246813", "Poner fondo").await.unwrap();
        // Cada apertura mandó el pulso SOLO a la impresora con gaveta.
        assert_eq!(simulada::trabajos(&tiq).iter().filter(|j| **j == pulso).count(), 3);
        assert!(simulada::trabajos(&etq).is_empty());
        // Gaveta apagada: no se registra una apertura que no ocurrió.
        simulada::apagar(&tiq, true);
        assert!(no_venta(p, &cajero, CAJA_1, "Cambio de billetes", "").await.unwrap_err().contains("gaveta"));
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
}
