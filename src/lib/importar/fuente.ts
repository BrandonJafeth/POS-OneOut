// Formato común de cualquier importación. Cada origen (CSV de la web hoy; la base del sistema
// viejo después) solo tiene que convertir lo suyo a FuenteImportacion; el plan y la aplicación
// en la base son los mismos para todos.

export interface FilaFuente {
  /** Número de fila en el archivo original (1 = encabezado), para los mensajes de error. */
  fila: number;
  /** Clave para reconocer el producto si se vuelve a importar. */
  webId: string;
  nombre: string;
  /** Precio tal como venía (se valida en el plan). */
  precio: string;
  /** Categoría del origen; se traduce a departamento con el mapeo. */
  categoria: string;
}

export interface FuenteImportacion {
  origen: string;
  filas: FilaFuente[];
}

export interface ErrorFila {
  fila: number;
  nombre: string;
  mensaje: string;
}
