-- "Da vuelto" decide qué pagos son efectivo, y el efectivo esperado del turno abierto se calcula con
-- ese dato al momento (caja::resumen). Cambiarlo con una caja abierta movería el esperado de
-- ventas ya cobradas (p. ej. quitárselo a Efectivo deja la caja esperando solo el fondo).
CREATE TRIGGER formas_pago_da_vuelto_con_turno
BEFORE UPDATE OF da_vuelto ON formas_pago
WHEN OLD.da_vuelto <> NEW.da_vuelto AND EXISTS (SELECT 1 FROM caja_turnos WHERE estado = 'abierto' AND eliminado_en IS NULL)
BEGIN SELECT RAISE(ABORT, 'Cierre la caja antes de cambiar «Da vuelto»: cambiaría el efectivo esperado del turno abierto'); END;
