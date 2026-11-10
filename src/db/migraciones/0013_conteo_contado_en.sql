-- Migración 13: hora en que se contó cada producto del conteo físico ({"producto_id": "fecha ISO"}).
-- Con la tienda abierta se sigue vendiendo mientras se cuenta: al aplicar el conteo, lo que entró o
-- salió de un producto DESPUÉS de contarlo se respeta (antes la existencia quedaba inflada).

ALTER TABLE inventario_conteos ADD COLUMN contado_en TEXT NOT NULL DEFAULT '{}';
