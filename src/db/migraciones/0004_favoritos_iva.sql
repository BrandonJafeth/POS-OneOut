-- Migración 4: productos favoritos (tarjetas en la venta) e IVA visible configurable.

ALTER TABLE productos ADD COLUMN favorito INTEGER NOT NULL DEFAULT 0;
CREATE INDEX productos_favoritos ON productos (favorito) WHERE favorito = 1;

INSERT INTO config (clave, valor) VALUES
  -- Mostrar el desglose de IVA en la venta y el tiquete. Régimen simplificado = false.
  ('mostrar_iva', 'false');
