-- 0.9.4. D1: código de recuperación del dueño. Se guarda solo su hash (Argon2id); el código se
-- muestra una vez al crearlo. Restablecer el PIN de un dueño lo exige y deja la fecha para avisarle.
ALTER TABLE usuarios ADD COLUMN recuperacion_hash TEXT;
ALTER TABLE usuarios ADD COLUMN pin_restablecido_en TEXT;

-- A4: la misma entrada de mercadería enviada dos veces (doble clic) queda una sola.
ALTER TABLE inventario_entradas ADD COLUMN operacion_id TEXT;
CREATE UNIQUE INDEX inventario_entradas_operacion ON inventario_entradas (operacion_id) WHERE operacion_id IS NOT NULL;
