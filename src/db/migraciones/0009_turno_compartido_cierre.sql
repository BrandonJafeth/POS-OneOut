-- Migración 9: turno de la caja (compartido entre usuarios), cortes parciales, aperturas de gaveta
-- sin venta, cierre Z con desglose, colores de departamento y abreviatura de bancos.

-- ───── Quién hizo cada cosa y en qué turno ─────
-- Pagos: usuario y turno propios (antes solo se sabían por la venta). El trigger que protege los
-- pagos de turnos cerrados se quita un momento para llenar estas columnas y se vuelve a crear igual.
ALTER TABLE venta_pagos ADD COLUMN usuario_id TEXT REFERENCES usuarios(id);
ALTER TABLE venta_pagos ADD COLUMN turno_id TEXT REFERENCES caja_turnos(id);
DROP TRIGGER venta_pagos_turno_cerrado_upd;
UPDATE venta_pagos SET
  usuario_id = (SELECT v.usuario_id FROM ventas v WHERE v.id = venta_pagos.venta_id),
  turno_id = (SELECT v.turno_id FROM ventas v WHERE v.id = venta_pagos.venta_id);
CREATE TRIGGER venta_pagos_turno_cerrado_upd BEFORE UPDATE ON venta_pagos
WHEN (SELECT t.estado FROM ventas v JOIN caja_turnos t ON t.id = v.turno_id WHERE v.id = OLD.venta_id) = 'cerrado'
BEGIN SELECT RAISE(ABORT, 'turno cerrado: el pago no se puede modificar'); END;
CREATE INDEX venta_pagos_turno ON venta_pagos (turno_id);

-- Ventas: quién empezó la venta en espera (usuario_id es quien la cobró), en qué turno se anuló,
-- cuándo se abrió la gaveta por esa venta (una sola vez) y cuándo salió el tiquete original
-- (después, solo copias marcadas). Las ventas anteriores se dan por impresas.
ALTER TABLE ventas ADD COLUMN espera_creada_por TEXT REFERENCES usuarios(id);
ALTER TABLE ventas ADD COLUMN anulada_turno_id TEXT REFERENCES caja_turnos(id);
ALTER TABLE ventas ADD COLUMN gaveta_abierta_en TEXT;
ALTER TABLE ventas ADD COLUMN impreso_en TEXT;
UPDATE ventas SET espera_creada_por = usuario_id, impreso_en = fecha;
CREATE INDEX ventas_usuario ON ventas (turno_id, usuario_id);

-- ───── Conteo del cierre: una vez cerrado, no se edita ─────
-- Solo reabrir (dueño, con PIN y motivo) vuelve el turno a 'abierto' y deja contar otra vez.
CREATE TRIGGER caja_turnos_conteo_bloqueado BEFORE UPDATE OF conteo_final, monto_contado, monto_esperado, diferencia, totales ON caja_turnos
WHEN OLD.estado = 'cerrado' AND NEW.estado = 'cerrado'
BEGIN SELECT RAISE(ABORT, 'turno cerrado: el conteo no se puede modificar'); END;

-- ───── Cortes parciales (el dueño ve el acumulado sin cerrar; puede retirar efectivo) ─────
CREATE TABLE caja_cortes (
  id                   TEXT PRIMARY KEY,
  sucursal_id          TEXT NOT NULL REFERENCES sucursales(id),
  caja_id              TEXT NOT NULL REFERENCES cajas(id),
  turno_id             TEXT NOT NULL REFERENCES caja_turnos(id),
  usuario_id           TEXT NOT NULL REFERENCES usuarios(id),
  fecha                TEXT NOT NULL,
  ventas               INTEGER NOT NULL,
  total                INTEGER NOT NULL,
  efectivo_esperado    INTEGER NOT NULL,           -- antes del retiro
  totales              TEXT NOT NULL,              -- JSON: por forma de pago
  retiro               INTEGER NOT NULL DEFAULT 0,
  retiro_movimiento_id TEXT REFERENCES caja_movimientos(id),
  creado_en            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX caja_cortes_turno ON caja_cortes (turno_id);

-- ───── Gaveta abierta sin venta ─────
-- La gaveta solo se abre por: una venta con efectivo (ventas.gaveta_abierta_en), una "no venta"
-- con motivo o una orden del dueño con PIN (esta tabla). Solo se agrega: no se edita ni se borra.
CREATE TABLE gaveta_aperturas (
  id             TEXT PRIMARY KEY,
  sucursal_id    TEXT NOT NULL REFERENCES sucursales(id),
  caja_id        TEXT NOT NULL REFERENCES cajas(id),
  turno_id       TEXT REFERENCES caja_turnos(id),  -- NULL: orden del dueño con la caja cerrada
  usuario_id     TEXT NOT NULL REFERENCES usuarios(id),
  causa          TEXT NOT NULL CHECK (causa IN ('no_venta', 'dueno')),
  motivo         TEXT NOT NULL,
  nota           TEXT,
  autorizado_por TEXT REFERENCES usuarios(id),
  fecha          TEXT NOT NULL,
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX gaveta_aperturas_turno ON gaveta_aperturas (turno_id);
CREATE INDEX gaveta_aperturas_fecha ON gaveta_aperturas (caja_id, fecha);
CREATE TRIGGER gaveta_aperturas_sin_update BEFORE UPDATE ON gaveta_aperturas
BEGIN SELECT RAISE(ABORT, 'las aperturas de gaveta no se pueden modificar'); END;
CREATE TRIGGER gaveta_aperturas_sin_delete BEFORE DELETE ON gaveta_aperturas
BEGIN SELECT RAISE(ABORT, 'las aperturas de gaveta no se pueden borrar'); END;

-- ───── Color de cada departamento (píldoras de la venta) ─────
-- Paleta de 12 colores distintos; el texto encima (blanco o negro) lo elige la app para AA.
ALTER TABLE departamentos ADD COLUMN color TEXT
  CHECK (color IS NULL OR color GLOB '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]');
UPDATE departamentos SET color = CASE ((orden - 1) % 12 + 12) % 12
  WHEN 0 THEN '#2563eb' WHEN 1 THEN '#15803d' WHEN 2 THEN '#ea580c' WHEN 3 THEN '#7e22ce'
  WHEN 4 THEN '#f472b6' WHEN 5 THEN '#06b6d4' WHEN 6 THEN '#facc15' WHEN 7 THEN '#92400e'
  WHEN 8 THEN '#9f1239' WHEN 9 THEN '#84cc16' WHEN 10 THEN '#1e3a8a' ELSE '#475569' END
WHERE color IS NULL;

-- ───── Bancos: abreviatura para el tiquete ("SINPE Móvil BCR ref 69898") ─────
ALTER TABLE bancos ADD COLUMN abreviatura TEXT NOT NULL DEFAULT '';
UPDATE bancos SET abreviatura = CASE id
  WHEN '0000000000000000000000BN01' THEN 'BN'
  WHEN '0000000000000000000000BN02' THEN 'BCR'
  WHEN '0000000000000000000000BN03' THEN 'BAC'
  WHEN '0000000000000000000000BN04' THEN 'BP'
  WHEN '0000000000000000000000BN05' THEN 'Davivienda'
  WHEN '0000000000000000000000BN06' THEN 'Promerica'
  ELSE '' END;

-- ───── Configuración ─────
INSERT INTO config (clave, valor) VALUES
  -- Otros usuarios pueden vender en el turno que abrió otra persona (el turno es de la caja).
  ('caja_turno_compartido', 'true'),
  -- Casillas del cierre Z (valores por defecto; se pueden cambiar al cerrar).
  ('caja_z_detalle_completo', 'false'),
  ('caja_z_por_departamento', COALESCE((SELECT valor FROM config WHERE clave = 'imprime_tiquetes_departamento'), 'false')),
  -- Apertura de gaveta sin venta.
  ('caja_no_venta_motivos', '["Cambio de billetes","Devolución","Otro"]'),
  ('caja_no_venta_umbral', '5'),
  -- ¢: quitar de una venta abierta una línea de este monto o más queda en la bitácora.
  ('caja_quitar_linea_bitacora', '5000');

-- imprime_tiquetes_departamento no lo usaba nada: su valor pasó a caja_z_por_departamento.
DELETE FROM config WHERE clave = 'imprime_tiquetes_departamento';
-- El conteo del cajero ahora siempre es ciego (y ve el resultado al cerrar): la opción ya no aplica.
DELETE FROM config WHERE clave = 'caja_cierre_ciego';
-- El cierre cuenta también billetes de ¢50.000 (si nadie cambió la lista).
UPDATE config SET valor = '[50000,20000,10000,5000,2000,1000,500,100,50,25,10,5]'
WHERE clave = 'caja_denominaciones' AND valor = '[20000,10000,5000,2000,1000,500,100,50,25,10,5]';
