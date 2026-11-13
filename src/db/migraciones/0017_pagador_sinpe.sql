-- Migración 17: en SINPE Móvil se anota el nombre de quien paga (con banco y referencia), no el
-- teléfono. La columna de la migración 16 pasa a llamarse pagador (sin borrar nada).

ALTER TABLE venta_pagos RENAME COLUMN telefono TO pagador;
