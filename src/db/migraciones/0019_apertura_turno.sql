-- Migración 19: apertura de cada turno y efectivo que queda para la próxima caja.
-- caja_turnos.dia ya es la fecha de negocio del turno (se decide una vez al abrir, en Rust:
-- caja::dia_para_abrir); los turnos existentes no cambian.
--   apertura_caso: cómo se decidió la fecha. 'primera' (primera caja del día), 'tarde' (abierta
--     después de un cierre y de la hora de cierre: mañana), 'hoy' / 'manana' (abierta después de
--     un cierre, antes de la hora de cierre: la eligió quien abrió). NULL en turnos viejos.
--   apertura_esperada: lo que quedó en la gaveta al cerrar la caja anterior (NULL si no hay con qué comparar).
--   diferencia_apertura: fondo contado − apertura_esperada.
--   queda_en_gaveta: al cerrar, lo que se deja para la próxima caja. contado − queda = retiro de cierre.

ALTER TABLE caja_turnos ADD COLUMN apertura_caso TEXT CHECK (apertura_caso IN ('primera', 'tarde', 'hoy', 'manana'));
ALTER TABLE caja_turnos ADD COLUMN apertura_esperada INTEGER;
ALTER TABLE caja_turnos ADD COLUMN diferencia_apertura INTEGER;
ALTER TABLE caja_turnos ADD COLUMN queda_en_gaveta INTEGER CHECK (queda_en_gaveta >= 0);

-- El conteo de apertura se confirma una vez y no se edita (como el del cierre).
CREATE TRIGGER caja_turnos_apertura_bloqueada BEFORE UPDATE OF monto_inicial, conteo_inicial, apertura_esperada, diferencia_apertura ON caja_turnos
BEGIN SELECT RAISE(ABORT, 'turno abierto: el conteo de apertura no se puede modificar'); END;

-- Lo que queda en la gaveta se anota una sola vez, con el turno ya cerrado (reabrir lo deja en NULL).
CREATE TRIGGER caja_turnos_queda_una_vez BEFORE UPDATE OF queda_en_gaveta ON caja_turnos
WHEN NEW.queda_en_gaveta IS NOT NULL AND (OLD.queda_en_gaveta IS NOT NULL OR NEW.estado != 'cerrado')
BEGIN SELECT RAISE(ABORT, 'turno cerrado: lo que queda en la gaveta ya se anotó'); END;
