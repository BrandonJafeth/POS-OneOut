-- Migración 14: descuento fijo por producto (% que el dueño pone en el catálogo). Al agregarlo a una
-- venta se aplica solo y no cuenta contra el tope de descuento del cajero (lo autorizó el dueño).

ALTER TABLE productos ADD COLUMN descuento_pct INTEGER NOT NULL DEFAULT 0 CHECK (descuento_pct BETWEEN 0 AND 100);
