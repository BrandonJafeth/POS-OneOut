-- Migración 1: esquema inicial (fase 1 + tablas vacías de fases siguientes).
-- Convenciones:
--   * id TEXT = ULID generado en el cliente (permite varias cajas/sucursales sin choques).
--   * Fechas TEXT en ISO 8601 UTC ("2026-10-29T18:00:00.000Z").
--   * eliminado_en NULL = vigente. Nunca se borra físicamente lo principal.
--   * Montos INTEGER en colones (sin decimales).

CREATE TABLE sucursales (
  id             TEXT PRIMARY KEY,
  nombre         TEXT NOT NULL,
  activa         INTEGER NOT NULL DEFAULT 1,
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en   TEXT
);

CREATE TABLE cajas (
  id                    TEXT PRIMARY KEY,
  sucursal_id           TEXT NOT NULL REFERENCES sucursales(id),
  nombre                TEXT NOT NULL,
  prefijo_tiquete       TEXT NOT NULL DEFAULT '',
  consecutivo_siguiente INTEGER NOT NULL DEFAULT 1 CHECK (consecutivo_siguiente > 0),
  activa                INTEGER NOT NULL DEFAULT 1,
  creado_en             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en          TEXT
);

INSERT INTO sucursales (id, nombre) VALUES ('0000000000000000000000S001', 'Principal');
INSERT INTO cajas (id, sucursal_id, nombre, prefijo_tiquete, consecutivo_siguiente)
VALUES ('0000000000000000000000C001', '0000000000000000000000S001', 'Caja 1', '', 67791);

-- Una sola fila (id = 1).
CREATE TABLE negocio (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  nombre_comercial TEXT NOT NULL DEFAULT '',
  razon_social     TEXT NOT NULL DEFAULT '',
  cedula           TEXT NOT NULL DEFAULT '',
  direccion        TEXT NOT NULL DEFAULT '',
  telefono         TEXT NOT NULL DEFAULT '',
  correo           TEXT NOT NULL DEFAULT '',
  regimen          TEXT NOT NULL DEFAULT '',
  logo_original    BLOB,
  logo_mime        TEXT,
  -- Logo ya convertido a 1 bit (formato GS v 0: MSB = punto izquierdo, ancho múltiplo de 8).
  logo_bits        BLOB,
  logo_ancho       INTEGER,
  logo_alto        INTEGER,
  logo_umbral      INTEGER,
  encabezado_extra TEXT NOT NULL DEFAULT '',
  pie_tiquete      TEXT NOT NULL DEFAULT '',
  actualizado_en   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO negocio (id, pie_tiquete) VALUES (1, '¡Gracias por preferirnos!');

CREATE TABLE departamentos (
  id             TEXT PRIMARY KEY,
  codigo         TEXT NOT NULL UNIQUE,
  nombre         TEXT NOT NULL,
  orden          INTEGER NOT NULL DEFAULT 0,
  activo         INTEGER NOT NULL DEFAULT 1,
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en   TEXT
);

INSERT INTO departamentos (id, codigo, nombre, orden) VALUES
  ('00000000000000000000000D01', '01', 'Librería', 1),
  ('00000000000000000000000D02', '02', 'Oficina', 2),
  ('00000000000000000000000D03', '03', 'Papelería', 3),
  ('00000000000000000000000D04', '04', 'Fotografía', 4),
  ('00000000000000000000000D05', '05', 'Portarretratos', 5),
  ('00000000000000000000000D06', '06', 'Tecnología', 6),
  ('00000000000000000000000D07', '07', 'Fotocopias', 7),
  ('00000000000000000000000D08', '08', 'Bazar', 8),
  ('00000000000000000000000D09', '09', 'Trabajos manuales', 9),
  ('00000000000000000000000D10', '10', 'Cartón', 10),
  ('00000000000000000000000D11', '11', 'Lapicero y lápiz', 11),
  ('00000000000000000000000D12', '12', 'Otros', 12);

CREATE TABLE productos (
  id              TEXT PRIMARY KEY,
  web_id          TEXT UNIQUE,                 -- id del producto en la tienda web (NULL si no viene de ahí)
  nombre          TEXT NOT NULL,
  nombre_busqueda TEXT NOT NULL,               -- nombre en minúsculas y sin tildes, para buscar
  departamento_id TEXT NOT NULL REFERENCES departamentos(id),
  precio          INTEGER NOT NULL CHECK (precio >= 0),
  activo          INTEGER NOT NULL DEFAULT 1,
  creado_en       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en    TEXT
);
CREATE INDEX productos_busqueda ON productos (nombre_busqueda);
CREATE INDEX productos_departamento ON productos (departamento_id);

-- El código es la clave natural. COLLATE NOCASE: "07TOC" y "07toc" son el mismo código.
CREATE TABLE codigos (
  codigo      TEXT PRIMARY KEY COLLATE NOCASE,
  producto_id TEXT NOT NULL REFERENCES productos(id),
  tipo        TEXT NOT NULL CHECK (tipo IN ('barras', 'interno', 'manual')),
  creado_en   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX codigos_producto ON codigos (producto_id);

CREATE TABLE usuarios (
  id                TEXT PRIMARY KEY,
  nombre            TEXT NOT NULL,
  rol               TEXT NOT NULL CHECK (rol IN ('cajero', 'dueno', 'tecnico')),
  pin_hash          TEXT NOT NULL,
  activo            INTEGER NOT NULL DEFAULT 1,
  intentos_fallidos INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta   TEXT,
  creado_en         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en      TEXT
);

-- valor = JSON (true, 50, "texto", {...}).
CREATE TABLE config (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO config (clave, valor) VALUES
  ('usa_apartados', 'true'),
  ('usa_credito', 'false'),
  ('abono_minimo_pct', '50'),
  ('escaner_debounce_ms', '400'),
  ('imprime_tiquete', 'true'),
  ('imprime_tiquetes_departamento', 'false'),
  ('codigo_interno_siguiente', '1'),
  ('impresora_nombre', '""'),
  ('impresora_code_page', '19'),
  ('impresora_sin_modo_chino', 'true'),
  ('impresora_barras', '"B"'),
  ('impresora_cortador', 'false'),
  ('importacion_mapeo_categorias', '{}'),
  ('departamento_defecto', '"00000000000000000000000D12"');

CREATE TABLE bitacora (
  id          TEXT PRIMARY KEY,
  fecha       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  usuario_id  TEXT REFERENCES usuarios(id),
  accion      TEXT NOT NULL,
  entidad     TEXT NOT NULL,
  entidad_id  TEXT,
  detalle     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX bitacora_fecha ON bitacora (fecha);
CREATE INDEX bitacora_entidad ON bitacora (entidad, entidad_id);

-- ───────────── Tablas para fases siguientes (sin lógica todavía) ─────────────

CREATE TABLE formas_pago (
  id                  TEXT PRIMARY KEY,
  codigo              TEXT NOT NULL UNIQUE,
  nombre              TEXT NOT NULL,
  tipo                TEXT NOT NULL CHECK (tipo IN ('efectivo', 'tarjeta', 'transferencia', 'sinpe', 'otro')),
  requiere_banco      INTEGER NOT NULL DEFAULT 0,
  requiere_referencia INTEGER NOT NULL DEFAULT 0,
  da_vuelto           INTEGER NOT NULL DEFAULT 0,
  orden               INTEGER NOT NULL DEFAULT 0,
  activo              INTEGER NOT NULL DEFAULT 1,
  creado_en           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en        TEXT
);

CREATE TABLE bancos (
  id             TEXT PRIMARY KEY,
  nombre         TEXT NOT NULL,
  orden          INTEGER NOT NULL DEFAULT 0,
  activo         INTEGER NOT NULL DEFAULT 1,
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en   TEXT
);

CREATE TABLE clientes (
  id              TEXT PRIMARY KEY,
  nombre          TEXT NOT NULL,
  nombre_busqueda TEXT NOT NULL,
  cedula          TEXT,
  telefono        TEXT,
  correo          TEXT,
  notas           TEXT NOT NULL DEFAULT '',
  creado_en       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en    TEXT
);
CREATE INDEX clientes_busqueda ON clientes (nombre_busqueda);

CREATE TABLE caja_turnos (
  id                  TEXT PRIMARY KEY,
  sucursal_id         TEXT NOT NULL REFERENCES sucursales(id),
  caja_id             TEXT NOT NULL REFERENCES cajas(id),
  usuario_apertura_id TEXT NOT NULL REFERENCES usuarios(id),
  usuario_cierre_id   TEXT REFERENCES usuarios(id),
  abierto_en          TEXT NOT NULL,
  cerrado_en          TEXT,
  monto_inicial       INTEGER NOT NULL DEFAULT 0,
  monto_esperado      INTEGER,
  monto_contado       INTEGER,
  notas               TEXT NOT NULL DEFAULT '',
  creado_en           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en        TEXT
);

CREATE TABLE caja_movimientos (
  id             TEXT PRIMARY KEY,
  sucursal_id    TEXT NOT NULL REFERENCES sucursales(id),
  caja_id        TEXT NOT NULL REFERENCES cajas(id),
  turno_id       TEXT REFERENCES caja_turnos(id),
  tipo           TEXT NOT NULL CHECK (tipo IN ('entrada', 'salida')),
  monto          INTEGER NOT NULL CHECK (monto > 0),
  motivo         TEXT NOT NULL,
  usuario_id     TEXT NOT NULL REFERENCES usuarios(id),
  fecha          TEXT NOT NULL,
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en   TEXT
);

-- Apartados y créditos.
CREATE TABLE cuentas (
  id             TEXT PRIMARY KEY,
  sucursal_id    TEXT NOT NULL REFERENCES sucursales(id),
  caja_id        TEXT NOT NULL REFERENCES cajas(id),
  tipo           TEXT NOT NULL CHECK (tipo IN ('apartado', 'credito')),
  cliente_id     TEXT NOT NULL REFERENCES clientes(id),
  usuario_id     TEXT NOT NULL REFERENCES usuarios(id),
  fecha          TEXT NOT NULL,
  fecha_entrega  TEXT,
  total          INTEGER NOT NULL CHECK (total >= 0),
  saldo          INTEGER NOT NULL,
  estado         TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta', 'pagada', 'entregada', 'cancelada')),
  notas          TEXT NOT NULL DEFAULT '',
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en   TEXT
);
CREATE INDEX cuentas_cliente ON cuentas (cliente_id);

CREATE TABLE cuenta_lineas (
  id              TEXT PRIMARY KEY,
  cuenta_id       TEXT NOT NULL REFERENCES cuentas(id),
  producto_id     TEXT REFERENCES productos(id),
  descripcion     TEXT NOT NULL,
  cantidad        INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario INTEGER NOT NULL,
  total           INTEGER NOT NULL,
  orden           INTEGER NOT NULL DEFAULT 0,
  creado_en       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en    TEXT
);

CREATE TABLE ventas (
  id                TEXT PRIMARY KEY,
  sucursal_id       TEXT NOT NULL REFERENCES sucursales(id),
  caja_id           TEXT NOT NULL REFERENCES cajas(id),
  turno_id          TEXT REFERENCES caja_turnos(id),
  consecutivo       INTEGER NOT NULL,
  numero            TEXT NOT NULL,             -- prefijo de la caja + consecutivo, tal como sale en el tiquete
  fecha             TEXT NOT NULL,
  usuario_id        TEXT NOT NULL REFERENCES usuarios(id),
  cliente_id        TEXT REFERENCES clientes(id),
  cuenta_id         TEXT REFERENCES cuentas(id), -- si la venta liquida un apartado/crédito
  subtotal          INTEGER NOT NULL,
  descuento         INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL,
  estado            TEXT NOT NULL DEFAULT 'completada' CHECK (estado IN ('completada', 'anulada')),
  anulada_por       TEXT REFERENCES usuarios(id),
  anulada_motivo    TEXT,
  creado_en         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en      TEXT,
  UNIQUE (caja_id, consecutivo)
);
CREATE INDEX ventas_fecha ON ventas (fecha);

CREATE TABLE venta_lineas (
  id              TEXT PRIMARY KEY,
  venta_id        TEXT NOT NULL REFERENCES ventas(id),
  producto_id     TEXT REFERENCES productos(id),
  codigo          TEXT,
  descripcion     TEXT NOT NULL,
  departamento_id TEXT NOT NULL REFERENCES departamentos(id),
  cantidad        INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario INTEGER NOT NULL,
  descuento       INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL,
  orden           INTEGER NOT NULL DEFAULT 0,
  creado_en       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en    TEXT
);
CREATE INDEX venta_lineas_venta ON venta_lineas (venta_id);

CREATE TABLE venta_pagos (
  id             TEXT PRIMARY KEY,
  venta_id       TEXT NOT NULL REFERENCES ventas(id),
  forma_pago_id  TEXT NOT NULL REFERENCES formas_pago(id),
  banco_id       TEXT REFERENCES bancos(id),
  monto          INTEGER NOT NULL,
  recibido       INTEGER,                      -- efectivo entregado por el cliente
  vuelto         INTEGER,
  referencia     TEXT,
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en   TEXT
);
CREATE INDEX venta_pagos_venta ON venta_pagos (venta_id);

-- Historial: cada vez que se corrige la forma de pago de un pago ya registrado.
CREATE TABLE venta_pago_correcciones (
  id                      TEXT PRIMARY KEY,
  venta_pago_id           TEXT NOT NULL REFERENCES venta_pagos(id),
  forma_pago_anterior_id  TEXT NOT NULL REFERENCES formas_pago(id),
  forma_pago_nueva_id     TEXT NOT NULL REFERENCES formas_pago(id),
  banco_anterior_id       TEXT REFERENCES bancos(id),
  banco_nuevo_id          TEXT REFERENCES bancos(id),
  referencia_anterior     TEXT,
  referencia_nueva        TEXT,
  motivo                  TEXT NOT NULL,
  usuario_id              TEXT NOT NULL REFERENCES usuarios(id),
  fecha                   TEXT NOT NULL,
  creado_en               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en            TEXT
);

CREATE TABLE abonos (
  id             TEXT PRIMARY KEY,
  cuenta_id      TEXT NOT NULL REFERENCES cuentas(id),
  sucursal_id    TEXT NOT NULL REFERENCES sucursales(id),
  caja_id        TEXT NOT NULL REFERENCES cajas(id),
  turno_id       TEXT REFERENCES caja_turnos(id),
  fecha          TEXT NOT NULL,
  usuario_id     TEXT NOT NULL REFERENCES usuarios(id),
  forma_pago_id  TEXT NOT NULL REFERENCES formas_pago(id),
  banco_id       TEXT REFERENCES bancos(id),
  monto          INTEGER NOT NULL CHECK (monto > 0),
  referencia     TEXT,
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en   TEXT
);
CREATE INDEX abonos_cuenta ON abonos (cuenta_id);
