-- Migración 11: inventario (fase 4).
-- Reglas:
--   * La existencia se mueve SOLO agregando un movimiento al kardex. El trigger revisa que la
--     existencia resultante sea la anterior + la cantidad y la copia a `existencias` en la misma
--     transacción: la existencia guardada siempre es la suma del kardex.
--   * El kardex no se edita ni se borra (triggers).
--   * El costo es dato del dueño: va en su propia tabla, fuera de `productos`, para que la lectura
--     de catálogo de la pantalla (bd_leer) no lo vea nunca.

-- Servicios (fotocopias, impresiones) y lo que no tiene código de barras: sin control al inicio.
ALTER TABLE productos ADD COLUMN controla_inventario INTEGER NOT NULL DEFAULT 1 CHECK (controla_inventario IN (0, 1));
ALTER TABLE productos ADD COLUMN stock_minimo INTEGER NOT NULL DEFAULT 0 CHECK (stock_minimo >= 0);
UPDATE productos SET controla_inventario = 0
WHERE NOT EXISTS (SELECT 1 FROM codigos c WHERE c.producto_id = productos.id AND c.tipo = 'barras');

-- Último costo (colones enteros). Sin fila = sin costo.
CREATE TABLE producto_costos (
  producto_id    TEXT PRIMARY KEY REFERENCES productos(id),
  costo          INTEGER NOT NULL CHECK (costo >= 0),
  actualizado_en TEXT NOT NULL
);

CREATE TABLE existencias (
  producto_id    TEXT NOT NULL REFERENCES productos(id),
  sucursal_id    TEXT NOT NULL REFERENCES sucursales(id),
  cantidad       INTEGER NOT NULL DEFAULT 0,
  actualizado_en TEXT NOT NULL,
  PRIMARY KEY (producto_id, sucursal_id)
);

CREATE TABLE inventario_movimientos (
  id              TEXT PRIMARY KEY,
  producto_id     TEXT NOT NULL REFERENCES productos(id),
  sucursal_id     TEXT NOT NULL REFERENCES sucursales(id),
  tipo            TEXT NOT NULL CHECK (tipo IN ('venta', 'anulacion', 'entrada', 'ajuste', 'inicial')),
  cantidad        INTEGER NOT NULL CHECK (cantidad <> 0),   -- + entra, − sale
  existencia      INTEGER NOT NULL,                          -- resultante
  costo_unitario  INTEGER CHECK (costo_unitario IS NULL OR costo_unitario >= 0),
  motivo          TEXT NOT NULL DEFAULT '',
  referencia_tipo TEXT CHECK (referencia_tipo IS NULL OR referencia_tipo IN ('venta', 'entrada', 'conteo', 'importacion')),
  referencia_id   TEXT,
  usuario_id      TEXT NOT NULL REFERENCES usuarios(id),
  turno_id        TEXT REFERENCES caja_turnos(id),
  fecha           TEXT NOT NULL
);
CREATE INDEX inventario_movimientos_producto ON inventario_movimientos (producto_id, fecha);
CREATE INDEX inventario_movimientos_fecha ON inventario_movimientos (fecha);
CREATE INDEX inventario_movimientos_referencia ON inventario_movimientos (referencia_id);

CREATE TRIGGER inventario_movimientos_cuadra BEFORE INSERT ON inventario_movimientos
WHEN NEW.existencia <> COALESCE((SELECT cantidad FROM existencias WHERE producto_id = NEW.producto_id AND sucursal_id = NEW.sucursal_id), 0) + NEW.cantidad
BEGIN SELECT RAISE(ABORT, 'la existencia del movimiento no cuadra con el kardex'); END;
CREATE TRIGGER inventario_movimientos_existencia AFTER INSERT ON inventario_movimientos
BEGIN
  INSERT INTO existencias (producto_id, sucursal_id, cantidad, actualizado_en) VALUES (NEW.producto_id, NEW.sucursal_id, NEW.existencia, NEW.fecha)
  ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET cantidad = excluded.cantidad, actualizado_en = excluded.actualizado_en;
END;
CREATE TRIGGER inventario_movimientos_sin_update BEFORE UPDATE ON inventario_movimientos
BEGIN SELECT RAISE(ABORT, 'los movimientos de inventario no se pueden modificar'); END;
CREATE TRIGGER inventario_movimientos_sin_delete BEFORE DELETE ON inventario_movimientos
BEGIN SELECT RAISE(ABORT, 'los movimientos de inventario no se pueden borrar'); END;

-- Proveedores: datos de empresas. Si es persona física, lo mínimo (nombre y teléfono).
CREATE TABLE proveedores (
  id             TEXT PRIMARY KEY,
  nombre         TEXT NOT NULL,
  telefono       TEXT NOT NULL DEFAULT '',
  notas          TEXT NOT NULL DEFAULT '',
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en   TEXT
);

-- Encabezado de cada entrada de mercadería; sus líneas son los movimientos con referencia a ella.
CREATE TABLE inventario_entradas (
  id           TEXT PRIMARY KEY,
  sucursal_id  TEXT NOT NULL REFERENCES sucursales(id),
  proveedor_id TEXT REFERENCES proveedores(id),
  factura      TEXT NOT NULL DEFAULT '',
  fecha        TEXT NOT NULL,              -- día de la factura del proveedor (AAAA-MM-DD)
  usuario_id   TEXT NOT NULL REFERENCES usuarios(id),
  creado_en    TEXT NOT NULL
);

-- Conteo físico: se puede guardar a medias. datos = {"producto_id": cantidad contada}.
CREATE TABLE inventario_conteos (
  id              TEXT PRIMARY KEY,
  sucursal_id     TEXT NOT NULL REFERENCES sucursales(id),
  departamento_id TEXT REFERENCES departamentos(id),   -- NULL: todos
  estado          TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto', 'aplicado', 'descartado')),
  datos           TEXT NOT NULL DEFAULT '{}',
  usuario_id      TEXT NOT NULL REFERENCES usuarios(id),
  creado_en       TEXT NOT NULL,
  actualizado_en  TEXT NOT NULL,
  aplicado_en     TEXT
);

INSERT INTO config (clave, valor) VALUES
  -- Al inicio el inventario no está al día: se vende igual y la existencia puede quedar negativa.
  ('permitir_vender_sin_existencia', 'true'),
  -- La tarjeta del producto en la venta muestra la existencia (y el cajero la puede consultar).
  ('venta_mostrar_existencia', 'false'),
  ('inventario_motivos_ajuste', '["Conteo","Daño","Merma","Regalo","Error de registro","Otro"]');
