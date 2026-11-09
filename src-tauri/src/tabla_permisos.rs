// Tabla de permisos comando × rol (auditoría). Llama cada comando (la función que usa lib.rs) con
// cada rol y compara con lo esperado. Es "permitido" si NO responde con falta de permiso (puede
// fallar por otra cosa: el id de prueba no existe, la caja está cerrada…). Esta misma tabla está
// en SEGURIDAD.md: si cambia un permiso, cambian las dos.
use crate::bd::Bd;
use crate::caja::{self, tests::conteo, CAJA_1};
use crate::permisos::Rol;
use crate::sesion::Actor;
use crate::usuarios::tests::base_con_usuarios;
use crate::util::Res;
use crate::{clientes, config, gaveta, importacion, impresoras, inventario, negocio, respaldo, usuarios, ventas};
use serde_json::{json, Value};

fn de<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn denegado<T>(r: Res<T>) -> bool {
    matches!(r, Err(e) if e.contains("No tiene permiso"))
}

/// (comando, ¿cajero?, ¿dueño?, ¿técnico?). "Con sesión" = cualquiera que haya entrado.
pub const ESPERADA: &[(&str, bool, bool, bool)] = &[
    ("usuarios_listar", false, true, true),
    ("usuarios_crear (cajero)", false, true, true),
    ("usuarios_editar", false, true, true),
    ("usuarios_cambiar_pin (de otro)", false, true, true),
    ("usuarios_eliminar", false, true, true),
    ("config_guardar (tema)", true, true, true),
    ("config_guardar (técnica)", false, false, true),
    ("config_guardar (caja_*)", false, true, true),
    ("config_guardar (inventario)", false, true, false),
    ("negocio_guardar (contacto)", false, true, true),
    ("negocio_logo", false, false, true),
    ("bitacora_listar / verificar", false, true, true),
    ("caja_estado", true, true, false),
    ("caja_abrir", true, true, false),
    ("caja_movimiento", true, true, false),
    ("caja_detalle", true, true, false),
    ("caja_necesita_nota", true, true, false),
    ("caja_cerrar", true, true, false),
    ("caja_reabrir", false, true, false),
    ("caja_revisada", false, true, false),
    ("caja_z", true, true, false),
    ("caja_z_imprimir", true, true, false),
    ("caja_nota_cierre", true, true, false),
    ("caja_corte", false, true, false),
    ("caja_turnos", true, true, false),
    ("gaveta_venta", true, true, false),
    ("gaveta_no_venta", true, true, false),
    ("gaveta_dueno", true, true, false),
    ("gaveta_aperturas", false, true, false),
    ("venta_esperas / crear / guardar", true, true, false),
    ("venta_espera_descartar", true, true, false),
    ("venta_autorizar_descuento", true, true, false),
    ("venta_cobrar", true, true, false),
    ("venta_obtener", true, true, false),
    ("venta_listar_dia", true, true, false),
    ("venta_imprimir", true, true, false),
    ("venta_correcciones", true, true, false),
    ("venta_corregir_pago", false, true, false),
    ("venta_anular", false, true, false),
    ("venta_pendientes_factura", true, true, false),
    ("venta_pedir_factura", true, true, false),
    ("venta_marcar_factura", true, true, false),
    ("cliente_crear", true, true, false),
    ("cliente_buscar", true, true, false),
    ("cliente_basico", true, true, false),
    ("cliente_dato_factura", true, true, false),
    ("cliente_tiene_correo", true, true, false),
    ("cliente_listar", false, true, false),
    ("cliente_obtener", false, true, false),
    ("cliente_editar", false, true, false),
    ("cliente_cuentas_saldo", false, true, false),
    ("cliente_exportar", false, true, false),
    ("cliente_anonimizar", false, true, false),
    ("cliente_retencion", false, true, false),
    ("respaldo_crear", false, true, false),
    ("respaldo_restaurar", false, true, false),
    ("respaldo_ultimo", false, true, false),
    ("respaldo_auto_configurar / estado / ahora / usb_confirmado", false, true, false),
    ("importacion_leer", false, true, true),
    ("importacion_aplicar", false, true, true),
    ("inventario_* (lista, kardex, entradas, ajustes, conteos, carga inicial)", false, true, false),
    ("inventario_reporte_*", false, true, false),
    ("inventario_existencia (config apagada)", false, true, false),
    ("proveedores_*", false, true, false),
    ("impresoras_listar / detectar / guardar / eliminar / asignar / probar", false, true, true),
    ("impresora_ajustes (formato, sin destino)", true, true, true),
    ("imprimir (movimiento)", true, true, false),
    ("imprimir (etiqueta)", false, true, true),
    ("imprimir (cierre)", false, true, false),
    ("imprimir (entrada)", false, true, false),
    ("list_printers / print_raw (diagnóstico)", false, false, true),
];

/// Lo que de verdad pasa con un rol: (comando, permitido).
/// `otro`: un usuario real que no es el actor (con un id inventado respondería «no encontrado»).
async fn real(bd: &Bd, a: &Actor, otro: &str) -> Vec<(&'static str, bool)> {
    let p = &bd.pool;
    let x = "00000000000000000000000000";
    let mut v: Vec<(&'static str, bool)> = vec![];
    let mut s = |n: &'static str, den: bool| v.push((n, !den));
    // Comandos que revisan el permiso en lib.rs (antes de llamar al módulo): misma revisión aquí.
    let lib = |perm: &str| denegado(a.exigir(perm, "x"));
    s("usuarios_listar", lib("usuarios"));
    s("usuarios_crear (cajero)", denegado(usuarios::crear(p, a, "Nuevo", Rol::Cajero, "1593").await));
    s("usuarios_editar", denegado(usuarios::editar(p, a, otro, Some("Otro nombre"), None).await));
    s("usuarios_cambiar_pin (de otro)", denegado(usuarios::cambiar_pin(p, a, otro, "975319").await));
    s("usuarios_eliminar", denegado(usuarios::eliminar(p, a, otro).await));
    s("config_guardar (tema)", denegado(config::guardar(p, a, "tema", &json!("claro")).await));
    s("config_guardar (técnica)", denegado(config::guardar(p, a, "redondeo_total", &json!(5)).await));
    s("config_guardar (caja_*)", denegado(config::guardar(p, a, "caja_umbral_diferencia", &json!(1000)).await));
    s("config_guardar (inventario)", denegado(config::guardar(p, a, "venta_mostrar_existencia", &json!(false)).await));
    s("negocio_guardar (contacto)", denegado(negocio::guardar(p, a, &de(json!({"telefono": "2222-2222"}))).await));
    s("negocio_logo", denegado(negocio::guardar_logo(p, a, None).await));
    s("bitacora_listar / verificar", lib("reportes"));
    s("caja_estado", denegado(caja::estado(p, a, CAJA_1).await));
    s("caja_abrir", denegado(caja::abrir(p, a, CAJA_1, &conteo(&[(1000, 1)])).await));
    s("caja_movimiento", denegado(caja::movimiento(p, a, CAJA_1, &de(json!({"tipo": "entrada", "monto": 100, "categoria": "Ingreso de cambio"})), None).await));
    s("caja_detalle", denegado(caja::detalle(p, a, x).await));
    s("caja_necesita_nota", denegado(caja::necesita_nota(p, a, CAJA_1, &conteo(&[])).await));
    s("caja_cerrar", denegado(caja::cerrar(p, a, CAJA_1, &conteo(&[]), "").await));
    s("caja_reabrir", denegado(caja::reabrir(p, a, x, "000000", "motivo largo").await));
    s("caja_revisada", denegado(caja::marcar_revisada(p, a, x).await));
    s("caja_z", denegado(caja::datos_z(p, a, x).await));
    s("caja_z_imprimir", denegado(caja::imprimir_z(p, a, x, &[], None).await));
    s("caja_nota_cierre", denegado(caja::nota_cierre(p, a, x, "nota").await));
    s("caja_corte", denegado(caja::corte(p, a, CAJA_1, None, None).await));
    s("caja_turnos", denegado(caja::listar(p, a, CAJA_1, "2000-01-01", "2999-01-01").await));
    s("gaveta_venta", denegado(gaveta::por_venta(p, a, x).await));
    s("gaveta_no_venta", denegado(gaveta::no_venta(p, a, CAJA_1, "Cambio de billetes", "").await));
    s("gaveta_dueno", denegado(gaveta::orden_dueno(p, a, CAJA_1, "000000", "motivo").await));
    s("gaveta_aperturas", denegado(gaveta::listar(p, a, CAJA_1, "2000-01-01", "2999-01-01", None).await));
    s("venta_esperas / crear / guardar", denegado(ventas::listar_esperas(p, a, CAJA_1).await));
    s("venta_espera_descartar", denegado(ventas::descartar_espera(p, a, x).await));
    s("venta_autorizar_descuento", denegado(ventas::autorizar_descuento(p, a, x, 50.0, "000000").await));
    s("venta_cobrar", denegado(ventas::cobrar_con(p, a, CAJA_1, x, &de(json!({"lineas": [], "descuentoTotal": 0, "requiereFactura": false})), &[], None).await));
    s("venta_obtener", denegado(ventas::obtener(p, a, x).await));
    s("venta_listar_dia", denegado(ventas::listar_dia(p, a, CAJA_1, "2026-01-01").await));
    s("venta_imprimir", denegado(ventas::imprimir_tiquete(p, a, x, b"x\n").await));
    s("venta_correcciones", denegado(ventas::correcciones_de(p, a, x).await));
    s("venta_corregir_pago", denegado(ventas::corregir_pago(p, a, CAJA_1, x, &de(json!({"formaPagoId": x})), "motivo largo", None).await));
    s("venta_anular", denegado(ventas::anular(p, a, CAJA_1, x, "000000", "motivo largo", 0).await));
    s("venta_pendientes_factura", denegado(ventas::pendientes_factura(p, a).await));
    s("venta_pedir_factura", denegado(ventas::pedir_factura(p, a, x, x).await));
    s("venta_marcar_factura", denegado(ventas::marcar_factura(p, a, x, "FE-1").await));
    s("cliente_crear", denegado(clientes::crear(p, a, &de(json!({"nombre": "Ana Mora", "telefono": "8888-8888"})), true, "1").await));
    s("cliente_buscar", denegado(clientes::buscar_basico(p, a, "ana", 5).await));
    s("cliente_basico", denegado(clientes::basico(p, a, x).await));
    s("cliente_dato_factura", denegado(clientes::dato_para_factura(p, a, x, "nombre").await));
    s("cliente_tiene_correo", denegado(clientes::tiene_correo(p, a, x).await));
    s("cliente_listar", denegado(clientes::listar(p, a, "", false).await));
    s("cliente_obtener", denegado(clientes::obtener(p, a, x).await));
    s("cliente_editar", denegado(clientes::editar(p, a, x, &de(json!({"nombre": "Ana Mora", "telefono": "8888-8888"}))).await));
    s("cliente_cuentas_saldo", denegado(clientes::cuentas_con_saldo(p, a, x).await));
    s("cliente_exportar", denegado(clientes::para_exportar(p, a, x, "csv").await));
    s("cliente_anonimizar", denegado(clientes::anonimizar(p, a, x, "000000", "otro").await));
    s("cliente_retencion", denegado(clientes::sugerencias_retencion(p, a).await));
    s("respaldo_crear", denegado(respaldo::crear(bd, a, "contrasena-larga").await));
    s("respaldo_restaurar", denegado(respaldo::restaurar(bd, a, "000000", b"x", "contrasena-larga", None).await));
    s("respaldo_ultimo", denegado(respaldo::ultimo(bd, a).await));
    s("respaldo_auto_configurar / estado / ahora / usb_confirmado", denegado(respaldo::estado_automatico(bd, a).await));
    s("importacion_leer", lib("productos.importar"));
    s("importacion_aplicar", denegado(importacion::aplicar(p, a, "000000", &de(json!({"modo": "todo", "items": [], "pisar": {"departamento": false, "favorito": false}, "resumen": {}}))).await));
    s("inventario_* (lista, kardex, entradas, ajustes, conteos, carga inicial)", denegado(inventario::lista(p, a, CAJA_1, &Default::default()).await));
    s("inventario_reporte_*", denegado(inventario::reporte_valorizado(p, a, CAJA_1).await));
    s("inventario_existencia (config apagada)", denegado(inventario::existencia_venta(p, a, CAJA_1, &[x.into()]).await));
    s("proveedores_*", denegado(inventario::proveedores(p, a).await));
    s("impresoras_listar / detectar / guardar / eliminar / asignar / probar", denegado(impresoras::listar(p, a, CAJA_1).await));
    s("impresora_ajustes (formato, sin destino)", denegado(impresoras::ajustes(p, CAJA_1, "tiquete").await));
    // imprimir: el permiso depende del documento (lib.rs).
    s("imprimir (movimiento)", lib("caja"));
    s("imprimir (etiqueta)", lib("productos"));
    s("imprimir (cierre)", lib("caja.admin"));
    s("imprimir (entrada)", lib("inventario"));
    s("list_printers / print_raw (diagnóstico)", lib("config.tecnica"));
    v
}

#[tokio::test]
async fn cada_comando_con_cada_rol_respeta_la_tabla() {
    let mut fallas = vec![];
    for (i, rol) in [Rol::Cajero, Rol::Dueno, Rol::Tecnico].into_iter().enumerate() {
        // Base nueva por rol: lo que un rol cambia no afecta a los otros.
        let (bd, tec, dueno, cajero) = base_con_usuarios().await;
        // Cajero y técnico intentan sobre el dueño; el dueño, sobre el cajero (el que puede administrar).
        let (a, otro) = match rol {
            Rol::Cajero => (cajero, dueno.id.clone()),
            Rol::Dueno => (dueno, cajero.id.clone()),
            Rol::Tecnico => (tec, cajero.id.clone()),
        };
        // Con la caja abierta, para que los comandos de caja lleguen a revisar el permiso.
        let _ = caja::abrir(&bd.pool, &a, CAJA_1, &conteo(&[(1000, 1)])).await;
        let r = real(&bd, &a, &otro).await;
        assert_eq!(r.len(), ESPERADA.len(), "la tabla y la prueba tienen que listar los mismos comandos");
        for ((n, ok), (n2, c, d, t)) in r.iter().zip(ESPERADA) {
            assert_eq!(n, n2);
            let esperado = [*c, *d, *t][i];
            if *ok != esperado {
                fallas.push(format!("{n} con {rol:?}: esperado {}, real {}", if esperado { "permitido" } else { "denegado" }, if *ok { "permitido" } else { "denegado" }));
            }
        }
    }
    assert!(fallas.is_empty(), "\n{}", fallas.join("\n"));
}
