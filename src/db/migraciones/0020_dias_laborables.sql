-- Migración 20: días laborables del negocio y su hora de cierre (caja::leer_horario).
-- "Mañana" en la fecha de negocio de los turnos es el próximo día laborable. Un turno abierto en un
-- día no laborable (evento especial) cuenta para ese mismo día y queda marcado.
-- Valores iniciales (Chaguí): lunes a viernes 18:30, sábado 17:30, domingo no laborable. Las fechas
-- de los turnos ya guardados no cambian.

ALTER TABLE caja_turnos ADD COLUMN no_laborable INTEGER NOT NULL DEFAULT 0 CHECK (no_laborable IN (0, 1));

INSERT OR IGNORE INTO config (clave, valor) VALUES
  ('caja_horario', '["18:30","18:30","18:30","18:30","18:30","17:30",null]');
