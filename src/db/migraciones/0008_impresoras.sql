-- Migración 8: varias impresoras (tiquetes, cierres, etiquetas…) y a cuál va cada documento.
-- Antes había una sola impresora en config (impresora_nombre, impresora_code_page…). Se copia a una
-- fila de `impresoras` con los cuatro documentos asignados, así nada cambia para el negocio.

CREATE TABLE impresoras (
  id             TEXT PRIMARY KEY,
  sucursal_id    TEXT NOT NULL REFERENCES sucursales(id),
  caja_id        TEXT NOT NULL REFERENCES cajas(id),
  nombre         TEXT NOT NULL,                 -- como la llama el negocio: "Tiquetes", "Etiquetas"
  conexion       TEXT NOT NULL CHECK (conexion IN ('windows', 'serial', 'usb')),
  -- Nombre de la impresora de Windows, puerto COMn o ruta del dispositivo USB. Siempre se elige
  -- de la lista que da el sistema (Rust lo vuelve a revisar al guardar y al imprimir).
  destino        TEXT NOT NULL,
  ancho_mm       INTEGER NOT NULL DEFAULT 58 CHECK (ancho_mm IN (58, 80)),
  columnas       INTEGER NOT NULL DEFAULT 32 CHECK (columnas BETWEEN 24 AND 64),
  code_page      INTEGER NOT NULL DEFAULT 19 CHECK (code_page BETWEEN 0 AND 255),
  sin_modo_chino INTEGER NOT NULL DEFAULT 1,
  barras         TEXT NOT NULL DEFAULT 'B' CHECK (barras IN ('A', 'B')),
  cortador       INTEGER NOT NULL DEFAULT 0,
  -- La gaveta va conectada a una sola impresora (la de tiquetes) y solo se abre desde ahí.
  gaveta         INTEGER NOT NULL DEFAULT 0,
  baudios        INTEGER NOT NULL DEFAULT 9600, -- solo puerto serial
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  eliminado_en   TEXT
);
CREATE UNIQUE INDEX impresoras_una_gaveta ON impresoras (caja_id) WHERE gaveta = 1 AND eliminado_en IS NULL;
CREATE UNIQUE INDEX impresoras_nombre ON impresoras (caja_id, nombre COLLATE NOCASE) WHERE eliminado_en IS NULL;

-- Cada documento va solo a la impresora asignada.
CREATE TABLE impresora_destinos (
  caja_id        TEXT NOT NULL REFERENCES cajas(id),
  documento      TEXT NOT NULL CHECK (documento IN ('tiquete', 'cierre', 'movimiento', 'etiqueta')),
  impresora_id   TEXT NOT NULL REFERENCES impresoras(id),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (caja_id, documento)
);

-- ───── La impresora única de antes pasa a la tabla nueva ─────
INSERT INTO impresoras (id, sucursal_id, caja_id, nombre, conexion, destino, ancho_mm, columnas, code_page, sin_modo_chino, barras, cortador, gaveta)
SELECT '0000000000000000000000IM01', c.sucursal_id, c.id, 'Tiquetes', 'windows', json_extract(n.valor, '$'), 58, 32,
  COALESCE((SELECT CAST(valor AS INTEGER) FROM config WHERE clave = 'impresora_code_page'), 19),
  COALESCE((SELECT CASE valor WHEN 'false' THEN 0 ELSE 1 END FROM config WHERE clave = 'impresora_sin_modo_chino'), 1),
  COALESCE((SELECT CASE json_extract(valor, '$') WHEN 'A' THEN 'A' ELSE 'B' END FROM config WHERE clave = 'impresora_barras'), 'B'),
  COALESCE((SELECT CASE valor WHEN 'true' THEN 1 ELSE 0 END FROM config WHERE clave = 'impresora_cortador'), 0),
  -- Era la única impresora: si la caja abría la gaveta, la gaveta está conectada a ella.
  COALESCE((SELECT CASE valor WHEN 'false' THEN 0 ELSE 1 END FROM config WHERE clave = 'abrir_gaveta_efectivo'), 1)
FROM cajas c JOIN config n ON n.clave = 'impresora_nombre'
WHERE c.id = '0000000000000000000000C001' AND COALESCE(json_extract(n.valor, '$'), '') <> '';

INSERT INTO impresora_destinos (caja_id, documento, impresora_id)
SELECT i.caja_id, d.column1, i.id
FROM impresoras i, (VALUES ('tiquete'), ('cierre'), ('movimiento'), ('etiqueta')) d
WHERE i.id = '0000000000000000000000IM01';

-- Las claves viejas se quitan solo si ya quedaron copiadas (si no había impresora, se dejan).
DELETE FROM config
WHERE clave IN ('impresora_nombre', 'impresora_code_page', 'impresora_sin_modo_chino', 'impresora_barras', 'impresora_cortador')
  AND EXISTS (SELECT 1 FROM impresoras WHERE id = '0000000000000000000000IM01');
