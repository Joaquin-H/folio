<!-- folio:inicio · Instrucciones de Folio para tomar notas. Folio agrega y quita este bloque desde Ajustes → Integraciones; lo que esté fuera de él no lo toca. -->
## Notas para Folio

Folio es el cuaderno donde el usuario reúne sus notas. Lee los archivos de la carpeta
`{{CARPETA_DE_NOTAS}}` y los muestra con formato: el encabezado le da el título, la
categoría y las etiquetas a la hoja.

Cuando el usuario pida anotar algo, tomar nota, guardar algo en Folio o dejar un resumen
para después ("anotá esto", "guardalo en Folio", "take a note"):

1. Fijate la fecha de hoy (la del sistema) y elegí un tema corto: en minúsculas, sin
   tildes, con guiones.
2. El archivo va en `{{CARPETA_DE_NOTAS}}` (creá la carpeta si no existe) y se llama
   `AAAA-MM-DD-tema.md`, por ejemplo `2026-10-14-plan-de-migracion.md`.
3. Nunca pises un archivo: si el nombre ya existe, probá con `-2`, `-3`… al final del
   nombre. Si el usuario pide agregar a una nota que ya existe, agregá al final y no
   borres nada.
4. Escribilo en UTF-8 con este formato:

   ```markdown
   ---
   titulo: Título corto y claro
   categoria: Trabajo
   etiquetas: [tema, otro-tema]
   fuente: Gemini CLI
   fecha: AAAA-MM-DD
   ---

   # Título corto y claro

   Una o dos frases con lo esencial.

   ## Pendientes
   - [ ] Lo que falta hacer
   - [x] Lo que ya está
   ```

   - `categoria` es opcional: poné una sola, y solo si sabés que el usuario la tiene
     (por ejemplo Trabajo, Proyectos, Código, Casa, Compras, Finanzas, Salud, Ideas).
   - `etiquetas`: de una a cinco palabras clave, en minúsculas.
   - El cuerpo en markdown simple: títulos con `#`, párrafos cortos, listas, tareas
     `- [ ]`, código entre ` ``` ` con el lenguaje, tablas chicas, enlaces completos
     (`https://…`). Sin HTML.
5. Nada de secretos: no guardes contraseñas, tokens, claves de API, datos de tarjetas
   ni datos personales sensibles. Si aparecen, reemplazalos por `[omitido]`.
6. Al terminar, decí en una línea dónde quedó la nota.

No guardes notas por tu cuenta: si algo parece valer la pena, ofrecelo en una línea y
esperá la respuesta.
<!-- folio:fin -->
