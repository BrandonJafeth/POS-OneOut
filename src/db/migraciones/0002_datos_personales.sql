-- Migración 2: Ley 8968 (protección de datos personales) + campos fiscales opcionales.
-- No borra datos: agrega columnas y reconstruye `clientes` copiando lo que tuviera.

-- ───── clientes ─────
-- Se reconstruye porque SQLite no permite quitar NOT NULL de `notas` (al anonimizar queda NULL).
-- Los clientes NO usan borrado lógico: se anonimizan (el id se conserva para el historial).
-- Solo nombre y teléfono son obligatorios (lo valida la app; en la base quedan NULL al anonimizar).
CREATE TABLE clientes_nueva (
  id                     TEXT PRIMARY KEY,
  nombre                 TEXT NOT NULL,
  nombre_busqueda        TEXT NOT NULL,
  tipo_identificacion    TEXT CHECK (tipo_identificacion IN ('fisica', 'juridica', 'dimex', 'nite', 'extranjero')),
  cedula                 TEXT,
  telefono               TEXT,
  correo                 TEXT,
  notas                  TEXT,
  consentimiento_datos   INTEGER NOT NULL DEFAULT 0,
  consentimiento_fecha   TEXT,
  consentimiento_version TEXT,
  anonimizado_en         TEXT,
  creado_en              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO clientes_nueva (id, nombre, nombre_busqueda, cedula, telefono, correo, notas, creado_en, actualizado_en)
  SELECT id, nombre, nombre_busqueda, cedula, telefono, correo, NULLIF(notas, ''), creado_en, actualizado_en FROM clientes;
-- Con foreign_keys activo, DROP hace un DELETE implícito. En la fase 1 nada escribe en clientes
-- ni en cuentas/ventas, así que no hay referencias y no falla. Si las hubiera, el DROP fallaría y
-- el plugin deshace la migración completa (corre en una transacción): no se pierde nada.
DROP TABLE clientes;
ALTER TABLE clientes_nueva RENAME TO clientes;
CREATE INDEX clientes_busqueda ON clientes (nombre_busqueda);
CREATE INDEX clientes_telefono ON clientes (telefono);

-- ───── negocio: responsable y aviso de privacidad ─────
ALTER TABLE negocio ADD COLUMN responsable_tratamiento TEXT NOT NULL DEFAULT '';
ALTER TABLE negocio ADD COLUMN aviso_privacidad_texto TEXT NOT NULL DEFAULT '';
ALTER TABLE negocio ADD COLUMN aviso_privacidad_version TEXT NOT NULL DEFAULT '1';
UPDATE negocio SET responsable_tratamiento = nombre_comercial, aviso_privacidad_texto =
'Para apartados y para contactarle sobre su compra le pedimos nombre y teléfono; la cédula y el correo son opcionales.
Usamos estos datos solo para administrar sus apartados y avisarle cuando su pedido esté listo.
No los compartimos con terceros.
Se guardan únicamente en el equipo de este negocio, no en internet.
Puede pedir en la caja ver, corregir o eliminar sus datos en cualquier momento (Ley 8968).'
WHERE id = 1;

-- ───── productos: preparación fiscal (sin facturación electrónica) ─────
ALTER TABLE productos ADD COLUMN cabys TEXT;
ALTER TABLE productos ADD COLUMN tasa_iva REAL NOT NULL DEFAULT 13 CHECK (tasa_iva >= 0 AND tasa_iva <= 100);
ALTER TABLE productos ADD COLUMN exento INTEGER NOT NULL DEFAULT 0;

-- ───── ventas: IVA informativo (incluido en el precio) ─────
ALTER TABLE ventas ADD COLUMN iva_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE venta_lineas ADD COLUMN tasa_iva REAL NOT NULL DEFAULT 13;
ALTER TABLE venta_lineas ADD COLUMN iva INTEGER NOT NULL DEFAULT 0;

INSERT INTO config (clave, valor) VALUES
  ('retencion_clientes_meses', '36'),
  ('aviso_privacidad_en_tiquete', 'false');
