-- Migración 16: teléfono de quien paga por SINPE Móvil (8 dígitos), para buscar el pago en el banco.

ALTER TABLE venta_pagos ADD COLUMN telefono TEXT;
