/** El recorrido inicial: pasos, títulos, explicaciones y botones. */
export const tutorial: Record<string, string> = {
  // Pasos del recorrido
  '¡Hola! Esto es Folio': 'Hello! This is Folio',
  'Estás viendo el cuaderno por atrás. Tocalo para abrirlo por la última hoja':
    'You are looking at the back of the notebook. Click it to open it at the last sheet',
  ', o dalo vuelta con': ', or flip it with',
  'para ver la tapa': 'to see the cover',
  'Esta es la tapa. Tocala para abrirlo y ver tus notas de a una, de la más reciente hacia atrás. El nombre de la etiqueta se cambia con un clic.':
    'This is the cover. Click it to open it and view your notes one by one, from most recent to oldest. The label name can be changed with a click.',
  'Probá: tocá la tapa.': 'Try it: click the cover.',
  'Todavía no hay hojas': 'No sheets yet',
  'Folio está buscando tus notas por la PC (o este filtro no trae ninguna). Cuando aparezcan, las vas a ver acá, de la más reciente hacia atrás.':
    'Folio is searching your PC for notes (or this filter found none). When they appear, you will see them here, from most recent to oldest.',
  'Cada hoja es una nota: arriba ves su fecha, su título y su categoría. Van de la más reciente hacia atrás.':
    'Each sheet is a note: at the top you see its date, title, and category. They go from most recent to oldest.',
  'Pasar de hoja': 'Turn page',
  'Pasá de hoja': 'Turn the page',
  'Cuando haya hojas, vas a pasar de una a otra con las franjas de los bordes, deslizando la hoja, con la rueda o con el teclado.':
    'When there are sheets, you will turn from one to another using the edge strips, sliding the sheet, with the wheel, or with the keyboard.',
  'Tocá la franja del borde: la derecha avanza y la izquierda vuelve. También podés deslizar la hoja, usar la rueda o el teclado':
    'Click the edge strip: right moves forward and left goes back. You can also slide the sheet, use the wheel, or the keyboard',
  'Probá: tocá el borde derecho.': 'Try it: click the right edge.',
  'Escribí en el cuaderno': 'Write in the notebook',
  'Escribí en la hoja': 'Write on the sheet',
  'El botón de hoja nueva abre una hoja en blanco para escribir ahí mismo. Cuando haya hojas, con doble clic escribís en cualquiera.':
    'The new sheet button opens a blank sheet to write right there. When there are sheets, double-click to write on any of them.',
  'Con doble clic escribís ahí mismo, en las hojas que son archivos .txt o .md; esta no se puede, porque viene de otra aplicación. Con':
    'With a double-click you write right there, on sheets that are .txt or .md files; this one cannot be edited, because it comes from another application. With',
  'se guarda y se termina.': 'it saves and finishes.',
  'Hacé doble clic en cualquier parte de la hoja y escribís ahí mismo, en el archivo original. Con':
    'Double-click anywhere on the sheet and you write right there, in the original file. With',
  'Probá: doble clic sobre el texto.': 'Try it: double-click the text.',
  'Buscar y hoja nueva': 'Search and new sheet',
  'La lupa busca en todas las hojas y filtra por fecha': 'The magnifying glass searches across all sheets and filters by date',
  'La hoja con lápiz abre una en blanco, lista para escribir': 'The sheet with pencil opens a blank one, ready for writing',
  'Las solapas': 'Tabs',
  'Cada solapa es una categoría y filtra las hojas. Tocá una para ver solo esas; volvé a tocarla para ver todas de nuevo.':
    'Each tab is a category and filters the sheets. Click one to see only those; click it again to see all of them.',
  'El menú': 'The menu',
  'Acá elegís una o dos hojas, el tamaño del cuaderno y Ajustes':
    'Here you choose one or two pages, the notebook size, and Settings',
  'Para darle el tamaño que quieras, mantené Mayús y arrastrá un borde. Este recorrido se puede volver a ver desde Ajustes.':
    'To give it any size you want, hold Shift and drag an edge. This tour can be viewed again from Settings.',
  'Probá: abrí el menú.': 'Try it: open the menu.',
  'Siempre a mano': 'Always at hand',
  'La cruz cierra la ventana, pero Folio queda en la bandeja, junto al reloj.':
    'The cross closes the window, but Folio stays in the tray, next to the clock.',
  'Desde cualquier programa,': 'From any program,',
  'abre el cuaderno': 'opens the notebook',
  'abre una hoja suelta para tomar una nota rápida': 'opens a loose sheet to take a quick note',

  // Globos y botones
  'Recorrido por Folio': 'Tour of Folio',
  '¡Eso es!': 'That’s it!',
  Saltar: 'Skip',
  'Paso {n} de {total}': 'Step {n} of {total}',
  '{n} de {total}': '{n} of {total}',
  Atrás: 'Back',
  Siguiente: 'Next',

  // Bienvenida inicial
  '¡Bienvenido a Folio!': 'Welcome to Folio!',
  'Categorías iniciales': 'Initial categories',
  'Proveedor de IA': 'AI Provider',
  'Reunimos tus notas .txt, .md, del Bloc de notas y de Notas rápidas de la PC sin mover ni tocar tus archivos.':
    'We gather your .txt, .md, Notepad, and Sticky Notes from your PC without moving or modifying your files.',
  'Podés analizar y clasificar las categorías de tus notas con un algoritmo inteligente o una IA, o continuar directamente con las categorías de fábrica.':
    'You can analyze and organize your note categories using an algorithm or AI, or continue directly with the default categories.',
  'Analizar en esta PC': 'Analyze on this PC',
  'Conectar mi propia IA': 'Connect my own AI',
  'Un algoritmo propio agrupa las palabras que más se repiten en tus notas para sugerir categorías sin enviar nada a internet.':
    'A proprietary algorithm groups the most frequent words in your notes to suggest categories without sending anything to the internet.',
  'Analizando notas…': 'Analyzing notes…',
  'Volver a analizar': 'Analyze again',
  'Sugerir en esta PC': 'Suggest on this PC',
  'Crear categorías y empezar el recorrido': 'Create categories and start tour',
  'Elegí un modelo para proponer categorías amplias. Podés usar Ollama en tu PC (sin clave ni internet) o pegar tu clave de Claude, OpenAI o Gemini (guardada únicamente en el llavero de Windows).':
    'Choose a model to propose broad categories. You can use Ollama on your PC (no key or internet) or paste your Claude, OpenAI, or Gemini key (stored only in Windows Credential Manager).',
  'Modelo en Ollama:': 'Ollama model:',
  'Por ejemplo: llama3, mistral o qwen': 'For example: llama3, mistral, or qwen',
  'Clave de API:': 'API key:',
  'Pegá tu clave de API': 'Paste your API key',
  'Consultando IA…': 'Consulting AI…',
  'Sugerir con {provider}': 'Suggest with {provider}',
  'Saltar todo': 'Skip all',
  'Usar categorías de fábrica y empezar': 'Use default categories and start',

  // Resumen final (Outro)
  '¡Todo listo! Qué más podés hacer en Folio': 'All set! What else you can do in Folio',
  'Tu cuaderno personal ya está configurado. Acá tenés algunas funciones pensadas para tu día a día:':
    'Your personal notebook is all set up. Here are a few features designed for your daily use:',
  'Guardar recortes al instante (Ctrl + Alt + X)': 'Save clippings instantly (Ctrl + Alt + X)',
  'Seleccioná texto en cualquier programa o navegador y apretá el atajo para guardarlo en la hoja recortes-AAAA-MM-DD.txt o en una hoja suelta.':
    'Select text in any application or browser and press the shortcut to save it to recortes-YYYY-MM-DD.txt or to a loose sheet.',
  'Clasificación automática con IA': 'Automatic classification with AI',
  'Conectá Ollama (local y sin internet), Claude, OpenAI, Gemini o Jev para que cada nota nueva reciba su categoría sola.':
    'Connect Ollama (local and offline), Claude, OpenAI, Gemini, or Jev so each new note is categorized automatically.',
  'Integración con asistentes (Skills)': 'Integration with assistants (Skills)',
  'Conectá Claude Code, Codex o Gemini CLI en un clic para que guarden notas .md con formato directo en tu Folio.':
    'Connect Claude Code, Codex, or Gemini CLI in one click to save formatted .md notes straight to your Folio.',
  'Personalización y cuaderno secreto cifrado': 'Customization and encrypted secret notebook',
  'Elegí entre 6 tapas realistas, stickers, modo de 1 o 2 hojas, atajos a medida y hojas secretas cifradas con XChaCha20-Poly1305.':
    'Choose from 6 realistic covers, stickers, 1 or 2 page view, custom shortcuts, and secret sheets encrypted with XChaCha20-Poly1305.',
  'Abrir Ajustes': 'Open Settings',
  'Empezar a usar Folio': 'Start using Folio',
};
