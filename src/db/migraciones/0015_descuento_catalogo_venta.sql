-- Migración 15: parte del descuento de cada línea vendida que vino del producto (el % que puso el
-- dueño), en colones. El Z la separa de los descuentos que dio el cajero.

ALTER TABLE venta_lineas ADD COLUMN descuento_catalogo INTEGER NOT NULL DEFAULT 0;
