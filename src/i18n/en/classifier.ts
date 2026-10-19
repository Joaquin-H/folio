/** Ajustes → Clasificador: la IA que clasifica (Jev.tsx y Providers.tsx). Jev y los nombres de las IAs no se traducen. */
export const classifier: Record<string, string> = {
  // Jev.tsx
  Nunca: 'Never',
  'Cada {n} día': 'Every {n} day',
  'Cada {n} días': 'Every {n} days',
  'Falta el modelo de Ollama.': 'The Ollama model is missing.',
  'Falta la clave de {provider}.': 'The {provider} key is missing.',
  'Se procesan en segundo plano.': 'They are processed in the background.',
  'La clasificación automática está desactivada.': 'Automatic classification is turned off.',
  'Volver a clasificar todo': 'Classify everything again',
  'Es una consulta a {provider} por cada hoja (hasta {sheets}). No se tocan las categorías que pusiste a mano.':
    'That is one {provider} query per sheet (up to {sheets}). Categories you set by hand are left alone.',
  'Es una consulta a {provider} por cada hoja. No se tocan las categorías que pusiste a mano.':
    'That is one {provider} query per sheet. Categories you set by hand are left alone.',
  'Consulta de nuevo a {provider} por todas las hojas, salvo las que pusiste en una categoría a mano. Cuesta una consulta por hoja.':
    'Asks {provider} again about every sheet, except the ones you put in a category by hand. It costs one query per sheet.',
  'Sí, consultar todo': 'Yes, ask about everything',
  'Volver a clasificar': 'Classify again',
  'Clasificación automática': 'Automatic classification',
  'Clasificar automáticamente': 'Classify automatically',
  'Cada hoja nueva pasa por {provider} cuando deja de cambiar.': 'Each new sheet goes through {provider} once it stops changing.',
  'Primero escribí el modelo de Ollama.': 'First enter the Ollama model.',
  'Primero guardá la clave de {provider}.': 'First save the {provider} key.',
  'Confianza mínima': 'Minimum confidence',
  'Por debajo de este valor, la hoja queda en “Sin clasificar”.': 'Below this value, the sheet stays in “Unclassified”.',
  'Cuándo consulta {provider}': 'When {provider} is queried',
  '{provider} no se consulta todo el tiempo. Una hoja se consulta cuando es nueva y dejó de cambiar; si ya está clasificada, no se vuelve a consultar aunque la edites, salvo que elijas revisarlas cada tanto. Y al crear o describir categorías, solo se revisan las hojas que quedaron sin categoría. Cambiar de IA tampoco vuelve a clasificar lo que ya está clasificado.':
    '{provider} is not queried all the time. A sheet is queried when it is new and has stopped changing; once it is classified, it is not queried again even if you edit it, unless you choose to review them every so often. And when you create or describe categories, only the sheets left without a category are reviewed. Switching AI does not reclassify what is already classified either.',
  'Revisar hojas ya clasificadas': 'Review classified sheets',
  'Volver a consultar a {provider} por las hojas ya clasificadas que cambiaron.': 'Ask {provider} again about classified sheets that changed.',
  'Cada cuánto volver a consultar las hojas ya clasificadas que cambiaron': 'How often to re-query classified sheets that changed',
  Consultas: 'Queries',
  'Cuenta las de todas las IAs, y también las pruebas.': 'Counts those of every AI, tests included.',
  '{today} hoy · {total} en total': '{today} today · {total} total',
  'Hojas pendientes de clasificar': 'Sheets waiting to be classified',
  'Clasificar ahora': 'Classify now',

  // Providers.tsx
  'Por defecto claude-haiku-5-5, el rápido y barato. Para uno más fino escribí su nombre, por ejemplo claude-sonnet-5-5.':
    'Defaults to claude-haiku-5-5, the fast, cheap one. For a finer one, type its name, for example claude-sonnet-5-5.',
  'Por defecto gpt-6-luna, el más económico. Podés escribir el nombre de otro modelo de OpenAI.':
    'Defaults to gpt-6-luna, the most economical. You can type the name of another OpenAI model.',
  'Por defecto gemini-3.5-flash-lite, el más rápido y barato. Podés escribir el nombre de otro modelo de Gemini.':
    'Defaults to gemini-3.5-flash-lite, the fastest and cheapest. You can type the name of another Gemini model.',
  'El modelo que tengas instalado en Ollama, tal cual figura en «ollama list». Por ejemplo llama3.2.':
    'The model you have installed in Ollama, exactly as it appears in “ollama list”. For example llama3.2.',
  'El texto de cada hoja se envía a {host}.': 'The text of each sheet is sent to {host}.',
  'No sale nada de esta PC.': 'Nothing leaves this PC.',
  'Un Ollama de otra máquina: el texto de cada hoja se envía a {host}.': 'An Ollama on another machine: the text of each sheet is sent to {host}.',
  'Las hojas del secret-book y las descartadas nunca se envían.': 'Sheets in the secret-book and discarded ones are never sent.',
  'Con Ollama activo, el texto de cada hoja lo lee un modelo que corre en esta PC ({host}): no sale a Internet. {never}':
    'With Ollama active, the text of each sheet is read by a model running on this PC ({host}): it never reaches the Internet. {never}',
  'Con Ollama activo, el texto de cada hoja se envía a {host}, que no es esta PC. {never}':
    'With Ollama active, the text of each sheet is sent to {host}, which is not this PC. {never}',
  'Con {provider} activo, el texto de cada hoja se envía a {host} ({maker}) para elegir su categoría. {never}':
    'With {provider} active, the text of each sheet is sent to {host} ({maker}) to pick its category. {never}',
  'Con una clave gratuita de Gemini, Google puede usar lo que le enviás para mejorar sus productos; con una cuenta de pago, no.':
    'With a free Gemini key, Google may use what you send it to improve its products; with a paid account, it does not.',
  'IA que clasifica': 'AI that classifies',
  'IA que clasifica las hojas': 'AI that classifies the sheets',
  'en la red': 'on the network',
  'Con clave': 'Has key',
  Lista: 'Ready',
  'Sin clave': 'No key',
  'Sin modelo': 'No model',
  'Clave de API': 'API key',
  'Tomada de la variable de entorno {envVar}.': 'Taken from the {envVar} environment variable.',
  'Guardada en el llavero del sistema.': 'Saved in the system keychain.',
  'Se guarda en el llavero del sistema, no en la base de Folio. También puede venir de la variable de entorno {envVar}.':
    'It is saved in the system keychain, not in Folio’s database. It can also come from the {envVar} environment variable.',
  'Quitar clave': 'Remove key',
  'Clave de API de {provider}': '{provider} API key',
  'Pegá tu clave': 'Paste your key',
  'De fábrica': 'Use default',
  Probar: 'Test',
  'Clasifica una hoja de ejemplo con tus categorías de ahora y muestra qué elige. Cuenta como una consulta.':
    'Classifies a sample sheet with your current categories and shows what it picks. Counts as one query.',
  'Primero escribí el modelo que tenés instalado.': 'First enter the model you have installed.',
  'Probando…': 'Testing…',
  'Consultando a {provider}…': 'Asking {provider}…',
  'Eligió «{category}»': 'Picked “{category}”',
  'Eligió «otro» (ninguna categoría encajó)': 'Picked “other” (no category fit)',
  'con {pct}% de confianza · {time}': 'with {pct}% confidence · {time}',
  'Es menos que tu confianza mínima ({pct}%): una hoja así quedaría en «Sin clasificar».':
    'That is below your minimum confidence ({pct}%): a sheet like this would end up in “Unclassified”.',
  'Hoja de ejemplo: {sample}': 'Sample sheet: {sample}',
  'No se pudo probar {provider}.': 'Couldn’t test {provider}.',
  Modelo: 'Model',
  'Modelo de {provider}': '{provider} model',
  Dirección: 'Address',
  'Dónde escucha Ollama. Por defecto, en esta misma PC.': 'Where Ollama listens. By default, on this very PC.',
  'Es otra máquina: el texto de las hojas viaja hasta ella por la red.': 'It is another machine: the text of the sheets travels to it over the network.',
  'Dirección de Ollama': 'Ollama address',
};
