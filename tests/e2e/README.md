# Pruebas de punta a punta de la interfaz

Manejan el cuaderno con el mouse y el teclado del navegador (clic, doble clic con la
separación que se pida entre los dos clics, arrastre, rueda, teclas) y miran qué pasó.
Corren sobre la interfaz con datos de muestra (`src/mock.ts`), en un Edge sin ventana: no
tocan la app instalada ni ninguna nota real.

```powershell
node tests/e2e/notebook.mjs                 # todas las del cuaderno
node tests/e2e/cover.mjs                    # tapa, contratapa, estilos e imágenes
node tests/e2e/shortcuts.mjs                # atajos a medida y tamaño de la letra
node tests/e2e/tutorial.mjs                 # el recorrido de la primera vez
node tests/e2e/markdown.mjs                 # hojas .md con formato e integraciones
node tests/e2e/classifier.mjs               # clasificador con IA y proveedores
node tests/e2e/i18n.mjs                     # cambio de idioma y textos traducidos
node tests/e2e/secret.mjs                   # cifrado y respaldo del secret-book
node tests/e2e/send.mjs                     # atajo global para enviar recortes
node tests/e2e/notebook.mjs papelera        # solo las que tienen "papelera" en el nombre
node tests/e2e/notebook.mjs "doble clic,deslizar"   # varias, separadas por comas
```

Hace falta Node 22 o más nuevo, las dependencias del proyecto instaladas (`pnpm install`)
y Microsoft Edge. El arnés levanta Vite y Edge, y al terminar cierra los dos y borra el
perfil temporal del navegador, pase lo que pase con las pruebas. Termina con código 1 si
alguna falla.

| Variable | Para qué | Por defecto |
|---|---|---|
| `BOOK_E2E_PORT` | Puerto de Vite | `1432` |
| `BOOK_E2E_DEBUG_PORT` | Puerto de depuración de Edge | `9342` |
| `BOOK_E2E_BROWSER` | Ruta de `msedge.exe` (o de un Chrome) | la de Edge en `Program Files (x86)` |
| `BOOK_E2E_URL` | Interfaz ya levantada: no se arranca Vite | — |

## Qué hay

- `harness.mjs`: levanta y cierra todo, y da las ayudas (`click`, `doubleClick`, `drag`,
  `slide`, `wheel`, `key`, `type`, `state`, `screenshot`…). Sin dependencias: usa el
  WebSocket y el `fetch` de Node.
- `vite.config.mjs`: el servidor de siempre, sin recarga en caliente, para que un archivo
  que cambie en medio de una corrida no reinicie la página.
- `cover.mjs` y `shortcuts.mjs`: lo mismo para la tapa (contratapa, estilos, imágenes
  pegadas) y para los atajos a medida y el tamaño de la letra. Aceptan el mismo filtro
  por nombre.
- `tutorial.mjs`: el recorrido de la primera vez (cuándo aparece, cómo se avanza, se vuelve y se
  salta, los pasos donde se prueba algo, que los globos entren en la ventana sin tapar lo que
  explican, cómo se vuelve a ver y que no toque el cuaderno). El arnés lo marca como visto al
  cargar, para que no aparezca en las demás; `page.open({ tour: true })` lo deja como la
  primera vez.
- `markdown.mjs`: las hojas `.md` con formato (cada elemento, el rayado en los cuatro
  tamaños de letra, la paginación, el doble clic, enlaces, tareas y selección) y Ajustes →
  Integraciones.
- `classifier.mjs`: Ajustes → Clasificador (selección de IA local o remota: Jev, Claude,
  OpenAI, Gemini u Ollama, configuración de modelo y dirección, y prueba de clasificación).
- `i18n.mjs`: cambio de idiomas (español e inglés), selector en Personalización, actualización
  entre ventanas por eventos de almacenamiento y persistencia de preferencias.
- `secret.mjs`: cifrado del cuaderno secreto (secret-book), copia de la clave de respaldo,
  bloqueo y desbloqueo de hojas secretas en Ajustes → Datos.
- `send.mjs`: envío de texto seleccionado desde otras aplicaciones mediante atajo global
  (`Ctrl + Alt + X`), configuración del destino y apertura en hoja suelta o notas del día.
- `notebook.mjs`: las pruebas del cuaderno (leen la hoja de prueba, una `.md`, sin formato). Cada una carga el cuaderno de cero, con el tamaño y las
  preferencias que necesita; una falla también si aparece un error en la consola.

## Qué cubren

- Un clic en la hoja no pasa página ni cierra el cuaderno; las franjas de los bordes sí,
  cada una en su sentido, y en la primera hoja la de atrás cierra la tapa.
- Doble clic sobre una palabra, a la derecha de un renglón, en un renglón vacío, sobre el
  papel en blanco, debajo del texto, en el título y en el pie: entra a escribir, con el
  cursor donde corresponde, y un segundo después sigue escribiendo en la misma hoja. Con
  80 y con 400 ms entre los dos clics, a tamaño estándar y a pantalla completa
  (1920 × 1080), a una y a dos hojas.
- Deslizar pasa la hoja para ese lado; un arrastre corto, vertical o en diagonal, no.
  Seleccionar texto arrastrando no pasa página, y llevar la selección al borde sigue
  pasando de página para continuarla.
- Escribiendo: el guardado automático no saca de la hoja ni mueve el cursor; la rueda y
  Av Pág no salen de la nota; Ctrl + Enter termina y guarda, Ctrl + S guarda y sigue
  (también desde el título); si el archivo cambió afuera, lo escrito no se pierde.
- La papelera pide confirmación (Cancelar, Enter y Esc no mueven nada) y lo que pasa
  dentro de un diálogo no llega a las hojas de atrás.
- De la papelera y del secret-book se vuelve con el botón y con Esc.
- Los carteles de arriba no pisan los botones, en ningún tamaño.
- Hoja suelta: atajos para guardar y segundo clic para descartar.

Lo que estas pruebas no ven: la ventana real (su tamaño, moverla, la bandeja), los
sonidos y el guardado en archivos de verdad. Para la ventana está `tests/stress.mjs`,
que corre sobre la app compilada.
