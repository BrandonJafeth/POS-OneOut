// Formato común de cualquier importación. Cada origen (CSV de la web hoy; la base del sistema
// viejo después) solo tiene que convertir lo suyo a FuenteImportacion; el plan y la aplicación
// en la base son los mismos para todos.

export interface FilaFuente {
  /** Línea en el archivo original (1 = encabezado), para los mensajes de error. */
  fila: number;
  /** Clave para reconocer el producto si se vuelve a importar. */
  webId: string;
  /** Respaldo de la clave: si el id cambia en la web, el slug suele seguir igual. */
  slug: string;
  nombre: string;
  /** Precio tal como venía (se valida en el plan). */
  precio: string;
  /** "disponible" o "agotado" (vacío si el archivo no trae la columna). */
  estado: string;
  /** Tipo de producto de la web; solo se admite "simple". */
  tipo: string;
  destacado: boolean;
  /** Se ignora; solo se avisa si trae un valor. */
  precioOferta: string;
  /** Categorías del origen, en el orden en que venían; se traducen a departamento con las reglas. */
  categorias: string[];
}

export interface FuenteImportacion {
  origen: string;
  /** Columnas opcionales que sí venían (estado, tipo, slug, destacado, precio_oferta). */
  columnas: string[];
  filas: FilaFuente[];
}

export interface ErrorFila {
  fila: number;
  nombre: string;
  mensaje: string;
}
