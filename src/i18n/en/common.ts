/** Lo que se usa en todas partes: palabras sueltas, plurales, tiempo, botones y el selector de idioma. */
export const common: Record<string, string> = {
  // Plurales (los usa `plural()` de format.ts: la palabra en singular y en plural)
  hoja: 'sheet',
  hojas: 'sheets',
  '{n} hoja': '{n} sheet',
  '{n} hojas': '{n} sheets',
  archivo: 'file',
  archivos: 'files',
  imagen: 'image',
  imágenes: 'images',
  'versión anterior': 'previous version',
  'versiones anteriores': 'previous versions',

  // Fechas y tiempo (format.ts)
  Hoy: 'Today',
  Ayer: 'Yesterday',
  recién: 'just now',
  'hace {n} min': '{n} min ago',
  'hace {n} h': '{n} h ago',
  'hace {n} d': '{n} d ago',

  // Botones y diálogos (ui.tsx)
  Cancelar: 'Cancel',
  Cerrar: 'Close',
  'Abrir en una ventana aparte': 'Open in a separate window',
  Listo: 'Done',
  Menos: 'Decrease',
  Más: 'Increase',
  Agregar: 'Add',
  Eliminar: 'Delete',
  Excluir: 'Exclude',
  Quitar: 'Remove',
  Guardar: 'Save',

  // Selector de color (ColorPicker.tsx)
  'Elegir otro color': 'Pick another color',
  'Color de la tapa': 'Cover color',
  Matiz: 'Hue',
  'Colores sugeridos': 'Suggested colors',
  'Código del color': 'Color code',

  // Idioma (settings/Language.tsx)
  Idioma: 'Language',
  Automático: 'Automatic',
  'Automático sigue al idioma del sistema: español, o inglés si es otro.': 'Automatic follows the system language: Spanish, or English for any other.',

  // Conectores
  o: 'or',
  y: 'and',

  // Comillas de una cita: «así» en español, “this” en inglés
  '«{text}»': '“{text}”',
};
