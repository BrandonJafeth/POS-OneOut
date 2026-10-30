-- Migración 5: turnos de caja (apertura, movimientos, arqueo, cierre, ajustes) y endurecimiento:
-- bitácora encadenada solo-añadir, pagos de turnos cerrados inmutables, PIN con cambio obligatorio.

-- ───── Turnos de caja ─────
-- caja_turnos y caja_movimientos existen desde la migración 1 (sin lógica). Se completan.
ALTER TABLE caja_turnos ADD COLUMN estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto', 'cerrado'));
ALTER TABLE caja_turnos ADD COLUMN dia TEXT;                       -- AAAA-MM-DD local de la apertura
ALTER TABLE caja_turnos ADD COLUMN conteo_inicial TEXT;            -- JSON {denominación: cantidad} o null si fue monto directo
ALTER TABLE caja_turnos ADD COLUMN conteo_final TEXT;
ALTER TABLE caja_turnos ADD COLUMN diferencia INTEGER;             -- contado − esperado (efectivo)
ALTER TABLE caja_turnos ADD COLUMN totales TEXT;                   -- JSON congelado al cerrar (lo que imprime el reporte Z)
ALTER TABLE caja_turnos ADD COLUMN nota_cierre TEXT;
ALTER TABLE caja_turnos ADD COLUMN diferencia_revisada_por TEXT REFERENCES usuarios(id);
ALTER TABLE caja_turnos ADD COLUMN reimpresiones INTEGER NOT NULL DEFAULT 0;
-- Solo un turno abierto por caja (lo garantiza la base, no la pantalla).
CREATE UNIQUE INDEX caja_turnos_uno_abierto ON caja_turnos (caja_id) WHERE estado = 'abierto' AND eliminado_en IS NULL;
CREATE INDEX caja_turnos_dia ON caja_turnos (caja_id, dia);

ALTER TABLE caja_movimientos ADD COLUMN categoria TEXT NOT NULL DEFAULT '';
ALTER TABLE caja_movimientos ADD COLUMN autorizado_por TEXT REFERENCES usuarios(id);
CREATE INDEX caja_movimientos_turno ON caja_movimientos (turno_id);

-- Ajustes registrados DESPUÉS del cierre de un turno: no tocan el turno cerrado, quedan en el actual.
CREATE TABLE caja_ajustes (
  id              TEXT PRIMARY KEY,
  turno_id        TEXT NOT NULL REFERENCES caja_turnos(id),  -- turno en que se hizo el ajuste
  venta_id        TEXT NOT NULL REFERENCES ventas(id),       -- venta de origen (de un turno cerrado)
  tipo            TEXT NOT NULL CHECK (tipo IN ('pago', 'anulacion')),
  valor_anterior  TEXT NOT NULL,                             -- JSON
  valor_nuevo     TEXT NOT NULL,                             -- JSON
  monto           INTEGER NOT NULL,
  motivo          TEXT NOT NULL,
  usuario_id      TEXT NOT NULL REFERENCES usuarios(id),
  autorizado_por  TEXT NOT NULL REFERENCES usuarios(id),
  fecha           TEXT NOT NULL,
  creado_en       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX caja_ajustes_turno ON caja_ajustes (turno_id);

CREATE INDEX ventas_turno ON ventas (turno_id);
ALTER TABLE venta_pago_correcciones ADD COLUMN turno_id TEXT REFERENCES caja_turnos(id);

-- Un pago de un turno cerrado no se modifica ni se borra (las correcciones van como ajuste).
CREATE TRIGGER venta_pagos_turno_cerrado_upd BEFORE UPDATE ON venta_pagos
WHEN (SELECT t.estado FROM ventas v JOIN caja_turnos t ON t.id = v.turno_id WHERE v.id = OLD.venta_id) = 'cerrado'
BEGIN SELECT RAISE(ABORT, 'turno cerrado: el pago no se puede modificar'); END;

CREATE TRIGGER venta_pagos_turno_cerrado_del BEFORE DELETE ON venta_pagos
WHEN (SELECT t.estado FROM ventas v JOIN caja_turnos t ON t.id = v.turno_id WHERE v.id = OLD.venta_id) = 'cerrado'
BEGIN SELECT RAISE(ABORT, 'turno cerrado: el pago no se puede borrar'); END;

-- Los montos de una venta de un turno cerrado tampoco cambian (estado/factura sí, por los ajustes).
CREATE TRIGGER ventas_montos_turno_cerrado BEFORE UPDATE OF subtotal, descuento, redondeo, total, iva_total, turno_id ON ventas
WHEN (SELECT estado FROM caja_turnos WHERE id = OLD.turno_id) = 'cerrado'
BEGIN SELECT RAISE(ABORT, 'turno cerrado: los montos de la venta no se pueden modificar'); END;

-- ───── Bitácora encadenada y solo-añadir ─────
-- hash = SHA-256(hash anterior + campos de la fila). Lo calcula Rust al insertar; si alguien edita
-- o borra una fila directo en el archivo, la verificación encuentra el eslabón roto.
ALTER TABLE bitacora ADD COLUMN hash TEXT;
ALTER TABLE bitacora ADD COLUMN hash_anterior TEXT;

-- Las filas viejas (sin hash) se encadenan una sola vez al arrancar; después no se tocan más.
CREATE TRIGGER bitacora_sin_update BEFORE UPDATE ON bitacora
WHEN OLD.hash IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'la bitácora no se puede modificar'); END;

CREATE TRIGGER bitacora_sin_delete BEFORE DELETE ON bitacora
BEGIN SELECT RAISE(ABORT, 'la bitácora no se puede borrar'); END;

CREATE TRIGGER bitacora_con_hash BEFORE INSERT ON bitacora
WHEN NEW.hash IS NULL
BEGIN SELECT RAISE(ABORT, 'la bitácora se escribe solo desde la aplicación'); END;

-- ───── PIN ─────
ALTER TABLE usuarios ADD COLUMN debe_cambiar_pin INTEGER NOT NULL DEFAULT 0;
-- Dueños y técnico con PIN corto (< 6) deben cambiarlo en el próximo ingreso (lo marca Rust al arrancar).

INSERT INTO config (clave, valor) VALUES
  ('caja_umbral_diferencia', '1000'),           -- ¢: desde aquí el cierre exige nota y avisa al dueño
  ('caja_salida_max_sin_pin', '20000'),         -- ¢: salidas mayores piden PIN del dueño
  ('caja_cierre_ciego', 'false'),
  ('caja_denominaciones', '[50000,20000,10000,5000,2000,1000,500,100,50,25,10,5]'),
  ('caja_motivos', '{"salida":["Retiro de dinero","Gasto menor","Pago a proveedor","Adelanto"],"entrada":["Ingreso de cambio","Otro ingreso"]}'),
  ('pin_min_dueno', '6'),                       -- dueño y técnico
  ('pin_min_cajero', '4'),
  ('sesion_inactividad_min', '10');
