-- Migración 7: importador de productos de la web (slug, categorías de origen, revisión) y
-- reglas de importación editables (categoría → departamento, palabras del nombre, favoritos).

-- web_id sigue siendo la clave para reconocer el producto; el slug sirve de respaldo si el id cambia.
ALTER TABLE productos ADD COLUMN web_slug TEXT;
-- Categorías tal como venían de la web ("Bazar | Escolar"), solo informativo.
ALTER TABLE productos ADD COLUMN categorias_origen TEXT;
-- 1 = el dueño debería revisarlo (entró sin categoría o sin mapeo). Se limpia al editarlo.
ALTER TABLE productos ADD COLUMN revisar INTEGER NOT NULL DEFAULT 0;
CREATE INDEX productos_web_slug ON productos (web_slug);
CREATE INDEX productos_revisar ON productos (revisar) WHERE revisar = 1;

INSERT INTO config (clave, valor) VALUES
  ('producto_tasa_iva_defecto', '13'),
  ('producto_cabys_defecto', '""'),
  -- categorias: en orden de prioridad (si un producto trae varias, gana la primera de esta lista).
  -- palabras: se aplican después y sobrescriben; "preguntar" = el dueño decide en la vista previa.
  ('importacion_reglas', '{"categorias":[
    {"categoria":"Escolar","departamentoId":"00000000000000000000000D01"},
    {"categoria":"Cuadernos","departamentoId":"00000000000000000000000D01"},
    {"categoria":"Libros","departamentoId":"00000000000000000000000D01"},
    {"categoria":"Arte y Manualidades","departamentoId":"00000000000000000000000D09"},
    {"categoria":"Oficina","departamentoId":"00000000000000000000000D02"},
    {"categoria":"Carpetas","departamentoId":"00000000000000000000000D02"},
    {"categoria":"Papeleria","departamentoId":"00000000000000000000000D03"},
    {"categoria":"Agendas","departamentoId":"00000000000000000000000D03"},
    {"categoria":"Fotografia","departamentoId":"00000000000000000000000D04"},
    {"categoria":"Tecnología","departamentoId":"00000000000000000000000D06"},
    {"categoria":"Bazar","departamentoId":"00000000000000000000000D08"},
    {"categoria":"Figuras","departamentoId":"00000000000000000000000D08"},
    {"categoria":"sublimacion y DTF","departamentoId":"00000000000000000000000D12"}
  ],"palabras":[
    {"palabras":["lapicero","lapiz","boligrafo","portaminas"],"departamentoId":"00000000000000000000000D11","preguntar":false},
    {"palabras":["portarretrato","marco","porta retrato"],"departamentoId":"00000000000000000000000D05","preguntar":false},
    {"palabras":["carton","cartulina"],"departamentoId":"00000000000000000000000D10","preguntar":false},
    {"palabras":["marcador"],"departamentoId":"00000000000000000000000D11","preguntar":true}
  ],"favoritosMax":40,"criterioFavoritos":"alfabetico"}');
