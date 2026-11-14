-- Migración 18: la gaveta se abre una vez al cerrar la caja, para contar el efectivo. Esa apertura
-- es de otro tipo ('cierre'): no cuenta como "sin venta" (ni para el límite del PIN ni para la
-- alerta). SQLite no deja cambiar un CHECK: se reconstruye la tabla copiando todo.

DROP TRIGGER gaveta_aperturas_sin_update;
DROP TRIGGER gaveta_aperturas_sin_delete;
CREATE TABLE gaveta_aperturas_nueva (
  id             TEXT PRIMARY KEY,
  sucursal_id    TEXT NOT NULL REFERENCES sucursales(id),
  caja_id        TEXT NOT NULL REFERENCES cajas(id),
  turno_id       TEXT REFERENCES caja_turnos(id),  -- NULL: orden del dueño con la caja cerrada
  usuario_id     TEXT NOT NULL REFERENCES usuarios(id),
  causa          TEXT NOT NULL CHECK (causa IN ('no_venta', 'dueno', 'cierre')),
  motivo         TEXT NOT NULL,
  nota           TEXT,
  autorizado_por TEXT REFERENCES usuarios(id),
  fecha          TEXT NOT NULL,
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO gaveta_aperturas_nueva (id, sucursal_id, caja_id, turno_id, usuario_id, causa, motivo, nota, autorizado_por, fecha, creado_en)
  SELECT id, sucursal_id, caja_id, turno_id, usuario_id, causa, motivo, nota, autorizado_por, fecha, creado_en FROM gaveta_aperturas;
-- PERMITIDO: todas las filas ya se copiaron arriba (gaveta::tests::migracion_18_conserva_las_aperturas).
DROP TABLE gaveta_aperturas;
ALTER TABLE gaveta_aperturas_nueva RENAME TO gaveta_aperturas;
CREATE INDEX gaveta_aperturas_turno ON gaveta_aperturas (turno_id);
CREATE INDEX gaveta_aperturas_fecha ON gaveta_aperturas (caja_id, fecha);
CREATE TRIGGER gaveta_aperturas_sin_update BEFORE UPDATE ON gaveta_aperturas
BEGIN SELECT RAISE(ABORT, 'las aperturas de gaveta no se pueden modificar'); END;
CREATE TRIGGER gaveta_aperturas_sin_delete BEFORE DELETE ON gaveta_aperturas
BEGIN SELECT RAISE(ABORT, 'las aperturas de gaveta no se pueden borrar'); END;
