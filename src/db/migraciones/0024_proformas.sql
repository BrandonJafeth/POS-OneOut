-- Proformas (cotizaciones), DISENO-PROFORMAS.md. Un precio por escrito sin registrar una venta: no mueve
-- dinero, no toca el inventario y no entra al Z. Solo agrega tablas, columnas e índices.

CREATE TABLE proformas (
  id                       TEXT PRIMARY KEY,
  sucursal_id              TEXT NOT NULL REFERENCES sucursales(id),
  caja_id                  TEXT NOT NULL REFERENCES cajas(id),
  consecutivo              INTEGER NOT NULL,
  version                  INTEGER NOT NULL DEFAULT 1,
  numero                   TEXT NOT NULL,                 -- P-0012 o P-0012-2
  cliente_id               TEXT REFERENCES clientes(id),  -- cliente guardado (con consentimiento)
  nombre                   TEXT,                          -- nombre escrito, solo de esta proforma; se borra solo (proforma_retencion_nombre_dias)
  usuario_id               TEXT NOT NULL REFERENCES usuarios(id),
  fecha                    TEXT NOT NULL,                 -- fecha y hora real
  dia                      TEXT NOT NULL,                 -- AAAA-MM-DD local de la emisión (reportes)
  vence                    TEXT NOT NULL,                 -- AAAA-MM-DD, último día válida
  subtotal                 INTEGER NOT NULL DEFAULT 0,
  descuento                INTEGER NOT NULL DEFAULT 0,    -- al total
  total                    INTEGER NOT NULL CHECK (total >= 0),
  descuento_autorizado_por TEXT REFERENCES usuarios(id),
  condiciones              TEXT NOT NULL DEFAULT '',      -- copia de proforma_condiciones al emitir
  estado                   TEXT NOT NULL DEFAULT 'vigente' CHECK (estado IN ('vigente', 'convertida', 'anulada', 'reemplazada')),
  fin_en                   TEXT,                          -- cuándo dejó de estar vigente (convertida, anulada o reemplazada)
  venta_id                 TEXT REFERENCES ventas(id),
  cuenta_id                TEXT REFERENCES cuentas(id),
  anulada_por              TEXT REFERENCES usuarios(id),
  anulada_motivo           TEXT,
  reimpresiones            INTEGER NOT NULL DEFAULT 0,
  creado_en                TEXT NOT NULL,
  actualizado_en           TEXT NOT NULL
);
CREATE UNIQUE INDEX proformas_numero ON proformas (caja_id, consecutivo, version);
CREATE INDEX proformas_estado ON proformas (estado, vence);
CREATE INDEX proformas_dia ON proformas (dia);

CREATE TABLE proforma_lineas (
  id                     TEXT PRIMARY KEY,
  proforma_id            TEXT NOT NULL REFERENCES proformas(id),
  orden                  INTEGER NOT NULL,
  producto_id            TEXT REFERENCES productos(id),
  codigo                 TEXT,
  descripcion            TEXT NOT NULL,
  departamento_id        TEXT NOT NULL REFERENCES departamentos(id),
  cantidad               INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario        INTEGER NOT NULL,
  descuento              INTEGER NOT NULL DEFAULT 0,
  descuento_catalogo     INTEGER NOT NULL DEFAULT 0,      -- % del producto al emitir
  tasa_iva               REAL NOT NULL DEFAULT 0,
  exento                 INTEGER NOT NULL DEFAULT 0,
  total                  INTEGER NOT NULL
);
CREATE INDEX proforma_lineas_proforma ON proforma_lineas (proforma_id, orden);

-- Una proforma se convierte una sola vez: en una venta o en un apartado.
ALTER TABLE ventas ADD COLUMN proforma_id TEXT REFERENCES proformas(id);
ALTER TABLE cuentas ADD COLUMN proforma_id TEXT REFERENCES proformas(id);
CREATE UNIQUE INDEX ventas_proforma ON ventas (proforma_id) WHERE proforma_id IS NOT NULL;
CREATE UNIQUE INDEX cuentas_proforma ON cuentas (proforma_id) WHERE proforma_id IS NOT NULL;

ALTER TABLE cajas ADD COLUMN proforma_siguiente INTEGER NOT NULL DEFAULT 1;
