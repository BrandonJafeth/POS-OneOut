-- Migración 3: venta, cobro y tiquete (fase 2).

-- ───── Formas de pago y bancos (configurables desde Configuración técnica) ─────
ALTER TABLE formas_pago ADD COLUMN pide_ultimos4 INTEGER NOT NULL DEFAULT 0;

INSERT INTO formas_pago (id, codigo, nombre, tipo, requiere_banco, requiere_referencia, da_vuelto, pide_ultimos4, orden) VALUES
  ('0000000000000000000000FP01', 'EF', 'Efectivo', 'efectivo', 0, 0, 1, 0, 1),
  ('0000000000000000000000FP02', 'TJ', 'Tarjeta', 'tarjeta', 0, 0, 0, 1, 2),
  ('0000000000000000000000FP03', 'SP', 'SINPE Móvil', 'sinpe', 0, 1, 0, 0, 3),
  ('0000000000000000000000FP04', 'TR', 'Transferencia', 'transferencia', 1, 1, 0, 0, 4);

INSERT INTO bancos (id, nombre, orden) VALUES
  ('0000000000000000000000BN01', 'Banco Nacional', 1),
  ('0000000000000000000000BN02', 'Banco de Costa Rica', 2),
  ('0000000000000000000000BN03', 'BAC Credomatic', 3),
  ('0000000000000000000000BN04', 'Banco Popular', 4),
  ('0000000000000000000000BN05', 'Davivienda', 5),
  ('0000000000000000000000BN06', 'Promerica', 6),
  ('0000000000000000000000BN07', 'Otro', 7);

-- ───── ventas ─────
ALTER TABLE ventas ADD COLUMN dia TEXT;                         -- AAAA-MM-DD local (jornada a la que pertenece)
ALTER TABLE ventas ADD COLUMN redondeo INTEGER NOT NULL DEFAULT 0; -- total = subtotal - descuento + redondeo
ALTER TABLE ventas ADD COLUMN nombre_tiquete TEXT;              -- "nombre en tiquete (no guardar)": sin crear cliente
ALTER TABLE ventas ADD COLUMN requiere_factura INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ventas ADD COLUMN factura_emitida INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ventas ADD COLUMN factura_referencia TEXT;          -- número o clave de la factura hecha en otro sistema
ALTER TABLE ventas ADD COLUMN factura_marcada_por TEXT REFERENCES usuarios(id);
ALTER TABLE ventas ADD COLUMN factura_marcada_en TEXT;
ALTER TABLE ventas ADD COLUMN descuento_autorizado_por TEXT REFERENCES usuarios(id);
ALTER TABLE ventas ADD COLUMN anulada_en TEXT;
ALTER TABLE ventas ADD COLUMN reimpresiones INTEGER NOT NULL DEFAULT 0;
CREATE INDEX ventas_dia ON ventas (caja_id, dia);
CREATE INDEX ventas_factura ON ventas (requiere_factura, factura_emitida);

ALTER TABLE venta_pagos ADD COLUMN ultimos4 TEXT;

ALTER TABLE venta_pago_correcciones ADD COLUMN ultimos4_anterior TEXT;
ALTER TABLE venta_pago_correcciones ADD COLUMN ultimos4_nuevo TEXT;
ALTER TABLE venta_pago_correcciones ADD COLUMN autorizado_por TEXT REFERENCES usuarios(id);

-- Ventas en espera: el estado completo (líneas, descuentos, cliente) como JSON. Se guarda en
-- cada cambio, así un apagón no pierde nada. Al cobrarse o descartarse se marca eliminado_en.
CREATE TABLE ventas_espera (
  id             TEXT PRIMARY KEY,
  sucursal_id    TEXT NOT NULL REFERENCES sucursales(id),
  caja_id        TEXT NOT NULL REFERENCES cajas(id),
  usuario_id     TEXT NOT NULL REFERENCES usuarios(id),
  numero         INTEGER NOT NULL,          -- número de pestaña (1, 2, 3…)
  datos          TEXT NOT NULL DEFAULT '{}',
  venta_id       TEXT REFERENCES ventas(id), -- la venta en que terminó (si se cobró)
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en   TEXT
);
CREATE INDEX ventas_espera_caja ON ventas_espera (caja_id, eliminado_en);

-- Cierre del día (mínimo): después de cerrado ya no se corrigen formas de pago de ese día.
-- El arqueo completo (conteo, diferencias) llega con apertura y cierre de caja.
CREATE TABLE cierres_dia (
  id             TEXT PRIMARY KEY,
  sucursal_id    TEXT NOT NULL REFERENCES sucursales(id),
  caja_id        TEXT NOT NULL REFERENCES cajas(id),
  dia            TEXT NOT NULL,
  usuario_id     TEXT NOT NULL REFERENCES usuarios(id),
  cerrado_en     TEXT NOT NULL,
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en   TEXT,
  UNIQUE (caja_id, dia)
);

INSERT INTO config (clave, valor) VALUES
  -- Total redondeado al múltiplo más cercano (₡5 = moneda más chica). 1 = sin redondeo.
  ('redondeo_total', '5'),
  -- Descuento máximo (% de la venta) sin pedir PIN de dueño.
  ('descuento_max_pct', '{"cajero":10,"dueno":100,"tecnico":100}'),
  ('denominaciones_rapidas', '[1000,2000,5000,10000,20000,50000]'),
  ('abrir_gaveta_efectivo', 'true'),
  ('texto_no_factura', '"Este tiquete no es una factura electrónica"'),
  ('avisar_espera_al_cerrar', 'true');
