-- Permisos configurables y bloqueo por inactividad (DISENO-PERMISOS.md, versión 0.9.3).
-- Cada versión de la configuración de seguridad (permisos por rol, excepciones por usuario,
-- anulación por el cajero e inactividad) es una fila nueva: nunca se edita ni se borra. La vigente
-- es la de mayor id con la cadena de hashes sana. La versión 1 la crea Rust al abrir la base
-- (plantilla «Normal» con los topes que ya tenía la configuración), para que sea igual a la 0.9.2.

CREATE TABLE seguridad_versiones (
  id            INTEGER PRIMARY KEY,
  creada_en     TEXT NOT NULL,
  creada_por    TEXT,                 -- usuario; NULL = la versión inicial que crea el sistema
  pin_dueno_de  TEXT,                 -- dueño que confirmó con su PIN (si hizo falta)
  plantilla     TEXT,                 -- estricto / normal / flexible, o NULL si fue a mano
  motivo        TEXT NOT NULL DEFAULT '',
  datos         TEXT NOT NULL,        -- JSON (politica::Datos), validado al leer
  hash_anterior TEXT NOT NULL,
  hash          TEXT NOT NULL CHECK (length(hash) = 64)
);

CREATE TRIGGER seguridad_versiones_sin_update BEFORE UPDATE ON seguridad_versiones
BEGIN SELECT RAISE(ABORT, 'las versiones de seguridad no se pueden modificar'); END;

CREATE TRIGGER seguridad_versiones_sin_delete BEFORE DELETE ON seguridad_versiones
BEGIN SELECT RAISE(ABORT, 'las versiones de seguridad no se pueden borrar'); END;

-- Anulación: quién la hizo y con qué política (A = solo dueño, B = cajero con PIN, C = cajero sin PIN).
-- anulada_por sigue siendo quien autorizó.
ALTER TABLE ventas ADD COLUMN anulada_actor TEXT;
ALTER TABLE ventas ADD COLUMN anulada_politica TEXT;
ALTER TABLE ventas ADD COLUMN anulada_version INTEGER;

-- Anulaciones de un cajero sin PIN (sección del Z, aviso al dueño, conteo por turno): sin índice,
-- cada Z recorría todas las ventas.
CREATE INDEX ventas_anuladas_c ON ventas (anulada_turno_id) WHERE anulada_politica = 'C';
