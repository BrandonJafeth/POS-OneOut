-- Migración 12: control de inventario de productos NUEVOS según su código de barras.
-- La 11 lo decidió una vez para los productos que ya existían; los que se crean después (a mano
-- o importados) quedaban todos con control, también servicios como "Impresiones", y con
-- permitir_vender_sin_existencia apagado el cajero no podía venderlos.
-- Regla: un producto nuevo empieza sin control; su PRIMER código de barras lo pone bajo control.
-- Si el dueño lo apaga a mano, agregarle otro código no lo vuelve a encender.

CREATE TRIGGER productos_nuevo_sin_control AFTER INSERT ON productos
BEGIN
  UPDATE productos SET controla_inventario = 0 WHERE id = NEW.id;
END;

CREATE TRIGGER codigos_primer_barras_controla AFTER INSERT ON codigos
WHEN NEW.tipo = 'barras'
  AND NOT EXISTS (SELECT 1 FROM codigos c WHERE c.producto_id = NEW.producto_id AND c.tipo = 'barras' AND c.codigo <> NEW.codigo)
BEGIN
  UPDATE productos SET controla_inventario = 1 WHERE id = NEW.producto_id;
END;
