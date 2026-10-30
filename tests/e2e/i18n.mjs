// Pruebas de punta a punta de los idiomas (español e inglés): el selector de Ajustes →
// Personalización, que las pantallas ya traducidas pasen al inglés y vuelvan, que las fechas y
// los textos de tiempo sigan al idioma, que «Automático» siga al del navegador, que el cambio
// llegue a la otra ventana por el evento `storage` y que un texto sin traducir se vea en
// español sin romper nada. Corren sobre la interfaz con datos de muestra (src/mock.ts), en un
// Edge sin ventana.
//
// Uso (desde la carpeta del proyecto):
//   node tests/e2e/i18n.mjs                  todas
//   node tests/e2e/i18n.mjs otra             solo las que tienen "otra" en el nombre
//
// Ver tests/e2e/README.md para los puertos y lo que hace falta tener instalado.
//
// Las pantallas cubiertas son las que ya tienen inglés: Ajustes (Personalización, solo el
// idioma y la tapa; Carpetas, Exclusiones, Categorías, Versiones, Clasificador y Datos), Buscar
// y filtrar, las versiones de una hoja, las preguntas de confirmación y las fechas. Las demás
// se suman cuando se traduzcan: basta agregar su frase a `ENGLISH` o una prueba nueva.

import { check, equal, launch, sleep, suite } from './harness.mjs';

const { test, run } = suite();

const TABS = {
  look: 0,
  shortcuts: 1,
  folders: 2,
  bans: 3,
  categories: 4,
  jev: 5,
  integrations: 6,
  versions: 7,
  data: 8,
  about: 9,
};
/** Las pestañas de Ajustes con inglés propio (la de Personalización se mira aparte: tiene filas de otros). */
const COVERED = ['shortcuts', 'folders', 'bans', 'categories', 'versions', 'jev', 'data', 'integrations', 'about'];

// ---- ayudas ---------------------------------------------------------------------------

/** Hace que el navegador diga hablar esos idiomas, en cada página nueva que se cargue. */
const NAVIGATOR = (langs) => `
  window.__nav = ${JSON.stringify(langs)};
  Object.defineProperty(Navigator.prototype, 'languages', { get: () => window.__nav, configurable: true });
  Object.defineProperty(Navigator.prototype, 'language', { get: () => window.__nav[0], configurable: true });
`;

async function withNavigator(page, langs, body) {
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: NAVIGATOR(langs) });
  try {
    return await body();
  } finally {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
}

/** Abre Ajustes en su propia ventana (como en la app). */
async function openSettings(page, { prefs = { lang: 'es' }, width = 760 } = {}) {
  await page.open({ width, height: 900, prefs, query: '?window=settings' });
  await page.until(async () => (await page.ask('count', '.settings-tabs [role="tab"]')) > 0, 'no cargaron las pestañas de Ajustes');
  await page.until(async () => (await page.ask('count', '.settings-body .group')) > 0, 'Ajustes no mostró su primer grupo');
  await sleep(250);
}

/** Va a una pestaña de Ajustes por su lugar (los nombres cambian con el idioma). */
async function goTo(page, name) {
  await page.evaluate(`document.querySelectorAll('.settings-tabs [role="tab"]')[${TABS[name]}].scrollIntoView({ inline: 'center' })`);
  await sleep(200);
  const box = (await page.ask('boxes', '.settings-tabs [role="tab"]'))[TABS[name]];
  await page.click(box.left + box.width / 2, box.top + box.height / 2);
  await sleep(350);
  await page.evaluate("document.querySelector('.settings-body').scrollTo(0, 0)");
}

/** Todas las frases a la vista dentro de `scope`: textos, rótulos, cartelitos y marcas de campos, sin repetir. */
const phrases = (page, scope = '.settings-body') =>
  page.evaluate(`(() => {
    const seen = new Set();
    const add = (text) => {
      const phrase = (text ?? '').replace(/\\s+/g, ' ').replace(/\\d+ min\\b/, 'N min').trim();
      if (phrase) seen.add(phrase);
    };
    for (const element of document.querySelector(${JSON.stringify(scope)}).querySelectorAll('*')) {
      for (const name of ['aria-label', 'title', 'placeholder']) add(element.getAttribute(name));
      for (const node of element.childNodes) if (node.nodeType === Node.TEXT_NODE) add(node.textContent);
    }
    return [...seen].sort();
  })()`);

/** Frases a la vista que son una clave del diccionario inglés: es decir, en español y sin traducir. */
const untranslated = (page, scope = '.settings-body') =>
  page.evaluate(`(async () => {
    const { EN } = await import('/src/i18n/en/index.ts');
    const seen = new Set();
    for (const element of document.querySelector(${JSON.stringify(scope)}).querySelectorAll('*')) {
      for (const name of ['aria-label', 'title', 'placeholder']) seen.add((element.getAttribute(name) ?? '').replace(/\\s+/g, ' ').trim());
      for (const node of element.childNodes) if (node.nodeType === Node.TEXT_NODE) seen.add(node.textContent.replace(/\\s+/g, ' ').trim());
    }
    return [...seen].filter((phrase) => Object.hasOwn(EN, phrase) && EN[phrase] !== phrase);
  })()`);

/** Las frases que se pidieron en inglés y no tenían traducción (el registro de desarrollo de i18n). */
const missing = (page) => page.evaluate('window.__i18n.missing()');

const htmlLang = (page) => page.evaluate('document.documentElement.lang');
const savedLang = (page) => page.evaluate("JSON.parse(localStorage.getItem('book.prefs') ?? '{}').lang ?? null");

/** Las opciones del selector de idioma, y cuál está elegida. */
const languageControl = (page) =>
  page.evaluate(`(() => {
    const control = document.querySelector('.segmented[aria-label="Idioma"], .segmented[aria-label="Language"]');
    if (!control) return null;
    const options = [...control.querySelectorAll('button')];
    return {
      label: control.getAttribute('aria-label'),
      options: options.map((button) => button.textContent),
      selected: options.find((button) => button.getAttribute('aria-selected') === 'true')?.textContent ?? null,
      row: control.closest('.row').querySelector('.row-text span').textContent,
      group: control.closest('.group').querySelector('h3')?.textContent ?? null,
    };
  })()`);

const pickLanguage = (page, name) =>
  page.clickOn('.segmented[aria-label="Idioma"] button, .segmented[aria-label="Language"] button', name);

const hasText = (text, expected, what) => check(text.includes(expected), `${what}: falta «${expected}» en\n${text}`);

/** Escribe en un campo y lo guarda con Enter. */
async function write(page, label, value) {
  await page.clickOn(`input[aria-label="${label}"]`);
  await page.evaluate(`document.querySelector('input[aria-label="${label}"]').select()`);
  await page.type(value);
  await page.key('Enter');
  await sleep(250);
}

/** Un segundo Edge tab sobre la misma app y el mismo almacenamiento: otra ventana de Ajustes, por ejemplo. */
async function otherWindow(page, query) {
  const debug = Number(process.env.BOOK_E2E_DEBUG_PORT ?? 9342);
  const origin = await page.evaluate('location.origin');
  const created = await fetch(`http://127.0.0.1:${debug}/json/new?${origin}/${query}`, { method: 'PUT' });
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    ws.addEventListener('open', done);
    ws.addEventListener('error', () => fail(new Error('No se pudo conectar con la segunda ventana')));
  });
  let next = 0;
  const waiting = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  });
  const evaluate = (expression) =>
    new Promise((done, fail) => {
      const id = ++next;
      waiting.set(id, (message) => {
        const failure = message.error?.message ?? message.result?.exceptionDetails?.exception?.description;
        if (failure) fail(new Error(failure));
        else done(message.result.result.value);
      });
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  const until = async (probe, what, timeout = 5000) => {
    for (const limit = Date.now() + timeout; Date.now() < limit; await sleep(80)) if (await probe()) return;
    throw new Error(`Se agotó la espera: ${what}`);
  };
  await until(
    () => evaluate("document.querySelectorAll('.settings-tabs [role=\"tab\"]').length > 0 && document.querySelectorAll('.settings-body .group').length > 0").catch(() => false),
    'la segunda ventana no cargó Ajustes',
    15_000,
  );
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = ++next;
      waiting.set(id, (message) => (message.error ? fail(new Error(message.error.message)) : done(message.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    evaluate,
    until,
    async close() {
      ws.close();
      await fetch(`http://127.0.0.1:${debug}/json/close/${target.id}`).catch(() => {});
    },
  };
}

// ---- las pruebas ------------------------------------------------------------------------

test('el selector: Ajustes → Personalización → Apariencia → Idioma, con Automático, Español y English', async (page) => {
  await openSettings(page, { prefs: { lang: 'es' } });
  const control = await languageControl(page);
  check(control, 'no hay selector de idioma');
  equal(control.row, 'Idioma', 'el nombre de la fila');
  equal(control.group, 'Apariencia', 'el grupo donde está');
  equal(control.options.join('|'), 'Automático|Español|English', 'las opciones');
  equal(control.selected, 'Español', 'lo elegido');
  equal(await htmlLang(page), 'es', 'el idioma del documento');
  // Un solo selector, y es una pestaña más de Ajustes (el cambio mínimo en Look.tsx).
  equal(await page.ask('count', '.segmented[aria-label="Idioma"]'), 1, 'cantidad de selectores');
});

test('de fábrica es Automático: sin nada guardado, sigue al navegador', async (page) => {
  await withNavigator(page, ['en-US', 'en'], async () => {
    await openSettings(page, { prefs: { lang: undefined } });
    const control = await languageControl(page);
    equal(control.selected, 'Automatic', 'lo elegido de fábrica');
    equal(control.row, 'Language', 'el sistema está en inglés');
    equal(await htmlLang(page), 'en', 'el idioma del documento');
  });
  await withNavigator(page, ['es-AR', 'es'], async () => {
    await openSettings(page, { prefs: { lang: undefined } });
    equal((await languageControl(page)).selected, 'Automático', 'lo elegido de fábrica');
    equal(await htmlLang(page), 'es', 'el idioma del documento');
  });
  equal(await savedLang(page), null, 'mirar Ajustes no tendría que guardar el idioma');
});

test('Automático sigue al idioma del navegador: español si es es-*, inglés en cualquier otro, y sigue los cambios', async (page) => {
  const cases = [
    [['es-AR', 'es'], 'es'],
    [['es'], 'es'],
    [['es-ES', 'en'], 'es'],
    [['en-GB', 'en'], 'en'],
    [['en-US', 'es-AR'], 'en'],
    [['pt-BR', 'pt'], 'en'],
    [['fr'], 'en'],
  ];
  for (const [langs, expected] of cases) {
    await withNavigator(page, langs, async () => {
      await openSettings(page, { prefs: { lang: 'auto' } });
      equal(await htmlLang(page), expected, `con el navegador en ${langs.join(', ')}`);
      equal((await languageControl(page)).row, expected === 'es' ? 'Idioma' : 'Language', `la fila con el navegador en ${langs.join(', ')}`);
    });
  }
  // Con la ventana abierta, si el sistema cambia de idioma, la interfaz lo sigue.
  await withNavigator(page, ['es-AR'], async () => {
    await openSettings(page, { prefs: { lang: 'auto' } });
    equal(await htmlLang(page), 'es', 'antes del cambio');
    await page.evaluate("window.__nav = ['en-US']; window.dispatchEvent(new Event('languagechange')); true");
    await page.until(async () => (await htmlLang(page)) === 'en' && (await languageControl(page)).row === 'Language', 'no pasó a inglés al cambiar el sistema');
  });
  // Elegir un idioma lo fija: el del navegador ya no cuenta.
  for (const [langs, lang, expected] of [[['en-US'], 'es', 'es'], [['es-AR'], 'en', 'en']]) {
    await withNavigator(page, langs, async () => {
      await openSettings(page, { prefs: { lang } });
      equal(await htmlLang(page), expected, `con el navegador en ${langs} y ${lang} elegido`);
      await page.evaluate(`window.__nav = ['${expected === 'es' ? 'en-US' : 'es-AR'}']; window.dispatchEvent(new Event('languagechange')); true`);
      await sleep(250);
      equal(await htmlLang(page), expected, 'un idioma elegido no sigue al navegador');
    });
  }
});

test('inglés: cambiar a English traduce todas las secciones de Ajustes', async (page) => {
  await openSettings(page, { prefs: { lang: 'es' } });
  await pickLanguage(page, 'English');
  await page.until(async () => (await htmlLang(page)) === 'en', 'no cambió el idioma del documento');
  equal(await savedLang(page), 'en', 'el idioma no quedó guardado');

  // Personalización: el selector y las filas de la tapa.
  const look = await languageControl(page);
  equal(look.row, 'Language', 'la fila');
  equal(look.options.join('|'), 'Automatic|Español|English', 'las opciones: Español y English se escriben en su idioma');
  equal(look.selected, 'English', 'lo elegido');
  let text = await page.evaluate("document.querySelector('.settings-body').innerText");
  for (const expected of ['Automatic follows the system language', 'Cover style', 'Plain: just the color.', 'Cover images', 'Paste an image…']) hasText(text, expected, 'Personalización');
  const styles = await page.evaluate("[...document.querySelectorAll('.cover-styles button')].map((b) => b.getAttribute('aria-label'))");
  equal(styles.join('|'), 'Plain|Speckled|Strap|Cloth spine|Leather', 'los estilos de tapa');
  const lookLeft = await untranslated(page);
  equal(lookLeft.join(' | '), '', 'Personalización: frases en español con la interfaz en inglés');

  const expectations = {
    shortcuts: ['Keyboard shortcuts', 'Detached sheet', 'Send selection to Folio', 'Reset all', 'Mouse gestures'],
    folders: ['Folders Folio scans', 'Add folder…', 'Ignore git repositories', 'Ignore hidden folders', 'Scan again', 'Where sheets turned up', 'Exclude'],
    bans: ['Exclude a folder', 'Choose folder…', 'Exclude by name', 'Folders by name', 'Files by name', 'Skipped anywhere on the disk.', 'Add'],
    categories: ['Categories', 'New category', 'Suggest categories from my notes', 'Suggest'],
    versions: ['Previous versions to keep', 'End of an editing session', 'Maximum file size', 'Bigger files are rarely notes'],
    jev: ['AI that classifies', 'No key', 'Nothing leaves this PC.', 'Automatic classification', 'Minimum confidence', 'Every 7 days', 'Never', 'Queries', 'Classify now'],
    data: ['Where Folio keeps its data', 'Show in folder', 'What is not in there', 'Your original notes', 'Originals that went missing', 'Notepad', 'Went missing on'],
    integrations: ['AI assistants', 'Notes folder', 'Tools', 'Copy instructions'],
    about: ['Version', 'Created by Joaquín Hernández', 'Getting to know the notebook', 'Take the tour', 'License', 'Built with'],
  };
  for (const name of COVERED) {
    await goTo(page, name);
    text = (await phrases(page)).join('\n');
    for (const expected of expectations[name]) hasText(text, expected, name);
    const left = await untranslated(page);
    equal(left.join(' | '), '', `${name}: frases en español con la interfaz en inglés`);
  }
  equal((await missing(page)).join(' | '), '', 'frases pedidas en inglés sin traducción');
});

test('inglés: las diez pestañas de Ajustes tienen sus nombres traducidos', async (page) => {
  await openSettings(page, { prefs: { lang: 'en' } });
  const tabs = await page.evaluate("[...document.querySelectorAll('.settings-tabs [role=\"tab\"]')].map((b) => b.textContent.trim())");
  const expected = [
    'Customization',
    'Shortcuts',
    'Folders',
    'Exclusions',
    'Categories',
    'Classifier',
    'Integrations',
    'Versions',
    'Data',
    'About',
  ];
  equal(tabs.join('|'), expected.join('|'), 'los nombres de las pestañas en inglés');
  const stripLabel = await page.evaluate("document.querySelector('.settings-tabs [role=\"tablist\"]').getAttribute('aria-label')");
  equal(stripLabel, 'Settings section', 'el aria-label de las pestañas de Ajustes en inglés');
  const left = await untranslated(page, '.settings-tabs');
  equal(left.join(' | '), '', 'pestañas sin traducir');

  // En el cuaderno, Ajustes abre en un modal con su título traducido.
  await page.open({ width: 900, height: 700, prefs: { lang: 'en' } });
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true, cancelable: true }))");
  await page.until(async () => (await page.ask('count', '.modal')) === 1, 'no se abrió el modal de Ajustes');
  equal(await page.ask('label', '.modal h2'), 'Settings', 'el título del modal de Ajustes en inglés');
  await page.key('Escape');
  await page.until(async () => (await page.ask('count', '.modal')) === 0, 'Esc no cerró el modal de Ajustes');

  equal((await missing(page)).join(' | '), '', 'frases pedidas en inglés sin traducción');
});

test('inglés: el recorrido inicial se muestra traducido', async (page) => {
  await page.open({ width: 1216, height: 868, prefs: { lang: 'en', size: 'standard', spread: 'double' } });
  await page.evaluate("window.dispatchEvent(new StorageEvent('storage', { key: 'book.tutorial.replay' }))");
  await page.until(
    () =>
      page.evaluate("(() => { const el = document.querySelector('.tour-balloon'); return !!(el && !el.closest('.tour').classList.contains('hidden') && !el.closest('.tour').classList.contains('leaving')); })()"),
    'el recorrido no apareció',
    8000,
  );
  await sleep(300);
  const info = await page.evaluate(`(() => {
    const balloon = document.querySelector('.tour-balloon');
    return {
      title: balloon.querySelector('.tour-title')?.textContent ?? '',
      count: balloon.querySelector('.tour-count')?.textContent ?? '',
      buttons: [...balloon.querySelectorAll('button')].map((b) => b.textContent.trim()),
    };
  })()`);
  equal(info.title, 'Hello! This is Folio', 'título del primer paso en inglés');
  equal(info.count, '1 of 7', 'conteo del primer paso en inglés');
  check(info.buttons.includes('Skip') && info.buttons.includes('Next'), `botones del primer paso: ${info.buttons}`);
  const left = await untranslated(page, '.tour-balloon');
  equal(left.join(' | '), '', 'frases sin traducir en el globo del recorrido');
  equal((await missing(page)).join(' | '), '', 'frases pedidas en inglés sin traducción');
});

test('inglés: los textos armados con números, fechas y nombres también se traducen', async (page) => {
  await openSettings(page, { prefs: { lang: 'en' } });
  await goTo(page, 'folders');
  let text = await page.evaluate("document.querySelector('.settings-body').innerText");
  check(/\d+ files in 4\.2 s · \d+ min ago/.test(text), `el último escaneo: ${text}`);
  await page.clickOn('.settings-body .row button[aria-label^="Remove"]');
  await page.until(async () => (await page.ask('count', '.confirm')) === 1, 'no apareció la pregunta de quitar la carpeta');
  await sleep(250);
  equal(await page.ask('label', '.confirm h2'), 'Stop scanning this folder?', 'el título de la pregunta');
  text = await page.ask('label', '.confirm');
  check(/\d+ sheets leave the notebook\./.test(text) && text.includes('Your original notes are left untouched'), `el detalle de la pregunta: ${text}`);
  const buttons = await page.evaluate("[...document.querySelectorAll('.confirm button')].map((b) => b.textContent)");
  equal(buttons.join('|'), 'Cancel|Remove', 'los botones de la pregunta (Cancelar es el de fábrica de ui.tsx)');
  await page.key('Escape');
  await page.until(async () => (await page.ask('count', '.confirm')) === 0, 'Esc no cerró la pregunta');

  await page.clickOn('.settings-body .row button', 'Exclude');
  await page.until(async () => (await page.ask('count', '.confirm')) === 1, 'no apareció la pregunta de excluir');
  await sleep(250);
  equal(await page.ask('label', '.confirm h2'), 'Exclude this folder?', 'el título de excluir');
  check(/\d+ sheets leave the notebook, and Folio will not scan that folder again\./.test(await page.ask('label', '.confirm')), 'el detalle de excluir');
  await page.key('Escape');
  await page.until(async () => (await page.ask('count', '.confirm')) === 0, 'Esc no cerró la pregunta de excluir');

  // Categorías: sugerencias, con sus conteos y sus ejemplos entre comillas inglesas.
  await goTo(page, 'categories');
  await page.clickOn('.suggest-go');
  await page.until(async () => (await page.ask('count', '.suggest-item')) > 0, 'no aparecieron las sugerencias', 8000);
  await sleep(300);
  text = await page.evaluate("document.querySelector('.suggest-panel').innerText");
  check(/\d+ sheets/.test(text) && text.includes('For example: “'), `las sugerencias: ${text}`);
  check(/\d+ of \d+ selected/.test(text) && text.includes('Create selected') && text.includes('Discard'), `el pie de las sugerencias: ${text}`);

  // Clasificador: la prueba de una IA, con el porcentaje, el tiempo y la hoja de ejemplo.
  await goTo(page, 'jev');
  await page.clickOn('[role="radio"]', 'Gemini');
  await sleep(350);
  await write(page, 'Gemini API key', 'AIza-de-mentira');
  await page.until(async () => ((await page.evaluate("[...document.querySelectorAll('.settings-body button')].map((b) => b.textContent)")).includes('Remove key')), 'no se guardó la clave');
  await page.clickOn('.settings-body button', 'Test');
  await page.until(async () => ((await page.ask('label', '.test-result')) ?? '').includes('Asking Gemini…'), 'no mostró «Asking Gemini…»', 3000).catch(() => {});
  await page.until(async () => ((await page.ask('label', '.test-result.done')) ?? '').includes('Picked'), 'no apareció el resultado de la prueba', 6000);
  text = await page.ask('label', '.test-result.done');
  check(/Picked “[^”]+” with 91% confidence · \d+(\.\d)? (ms|s)/.test(text) && text.includes('Sample sheet: “'), `el resultado de la prueba: ${text}`);
  equal((await missing(page)).join(' | '), '', 'frases pedidas en inglés sin traducción');
});

test('español: volver a Español deja todas las pantallas como estaban', async (page) => {
  await openSettings(page, { prefs: { lang: 'es' } });
  const before = {};
  for (const name of ['look', ...COVERED]) {
    await goTo(page, name);
    before[name] = await phrases(page);
  }
  await goTo(page, 'look');
  await pickLanguage(page, 'English');
  await page.until(async () => (await languageControl(page)).row === 'Language', 'no pasó a inglés');
  // Recorrer las pantallas en inglés no tiene que dejar nada en español pegado.
  await goTo(page, 'jev');
  await goTo(page, 'folders');
  const english = await phrases(page);
  check(!english.includes('Carpetas que Folio recorre'), 'quedó el título en español');
  await goTo(page, 'look');
  await pickLanguage(page, 'Español');
  await page.until(async () => (await languageControl(page)).row === 'Idioma', 'no volvió a español');
  equal(await htmlLang(page), 'es', 'el idioma del documento');
  equal(await savedLang(page), 'es', 'el idioma guardado');
  for (const name of ['look', ...COVERED]) {
    await goTo(page, name);
    const after = await phrases(page);
    equal(JSON.stringify(after), JSON.stringify(before[name]), `${name}: no quedó como estaba`);
  }
});

test('fechas y tiempo: hoy, ayer, días, meses, horas y "hace N min" en cada idioma', async (page) => {
  await openSettings(page, { prefs: { lang: 'es' } });
  const out = await page.evaluate(`(async () => {
    const i18n = await import('/src/i18n/index.ts');
    const format = await import('/src/format.ts');
    const now = Date.now();
    const march = new Date(2024, 2, 5, 14, 5);
    const sample = () => ({
      today: format.dayHeading(now),
      yesterday: format.dayHeading(now - 86_400_000),
      older: format.dayHeading(march.getTime()),
      clock: format.timeOf(march.getTime()),
      short: format.shortDateTime(march.getTime()),
      month: format.monthTitle(march),
      just: format.relativeTime(now - 20_000),
      minutes: format.relativeTime(now - 5 * 60_000),
      hours: format.relativeTime(now - 3 * 3_600_000),
      days: format.relativeTime(now - 2 * 86_400_000),
      big: format.count(12345),
      one: format.plural(1, 'hoja', 'hojas'),
      many: format.plural(2000, 'hoja', 'hojas'),
      tn: [i18n.tn(1, '{n} hoja', '{n} hojas'), i18n.tn(3, '{n} hoja', '{n} hojas')],
    });
    i18n.setLanguage('es');
    const es = sample();
    i18n.setLanguage('en');
    const en = sample();
    return { es, en };
  })()`);
  const { es, en } = out;
  // Español, como siempre.
  equal(es.today.title, 'Hoy', 'es: hoy');
  equal(es.yesterday.title, 'Ayer', 'es: ayer');
  check(es.today.relative && es.yesterday.relative && !es.older.relative, 'es: relative');
  equal(es.older.title, 'Martes', 'es: día de la semana');
  equal(es.older.subtitle, '5 de marzo de 2024', 'es: fecha con año');
  equal(es.clock, '14:05', 'es: hora');
  check(/^5 mar,? 14:05$/.test(es.short), `es: fecha corta ${es.short}`);
  equal(es.month, 'Marzo de 2024', 'es: mes');
  equal(es.just, 'recién', 'es: recién');
  equal(es.minutes, 'hace 5 min', 'es: minutos');
  equal(es.hours, 'hace 3 h', 'es: horas');
  equal(es.days, 'hace 2 d', 'es: días');
  equal(es.big, '12.345', 'es: miles');
  equal(es.one, '1 hoja', 'es: singular');
  equal(es.many, '2000 hojas', 'es: plural');
  equal(es.tn.join(' / '), '1 hoja / 3 hojas', 'es: tn');
  // Inglés.
  equal(en.today.title, 'Today', 'en: hoy');
  equal(en.yesterday.title, 'Yesterday', 'en: ayer');
  check(en.today.relative && en.yesterday.relative && !en.older.relative, 'en: relative');
  check(/^(Today|Yesterday)$/.test(en.today.title) && /^[A-Z][a-z]+, [A-Z][a-z]+ \d+$/.test(en.today.subtitle), `en: subtítulo de hoy ${en.today.subtitle}`);
  equal(en.older.title, 'Tuesday', 'en: día de la semana');
  equal(en.older.subtitle, 'March 5, 2024', 'en: fecha con año');
  check(/^2:05\sPM$/.test(en.clock), `en: hora ${en.clock}`);
  check(/^Mar 5, 2:05\sPM$/.test(en.short), `en: fecha corta ${en.short}`);
  equal(en.month, 'March 2024', 'en: mes');
  equal(en.just, 'just now', 'en: recién');
  equal(en.minutes, '5 min ago', 'en: minutos');
  equal(en.hours, '3 h ago', 'en: horas');
  equal(en.days, '2 d ago', 'en: días');
  equal(en.big, '12,345', 'en: miles');
  equal(en.one, '1 sheet', 'en: singular');
  equal(en.many, '2,000 sheets', 'en: plural');
  equal(en.tn.join(' / '), '1 sheet / 3 sheets', 'en: tn con las palabras de hoja(s)');
});

test('fechas en inglés: con el navegador en en-GB la hora es de 24 horas', async (page) => {
  await withNavigator(page, ['en-GB', 'en'], async () => {
    await openSettings(page, { prefs: { lang: 'en' } });
    const clock = await page.evaluate(`import('/src/format.ts').then((f) => f.timeOf(new Date(2024, 2, 5, 14, 5).getTime()))`);
    equal(clock, '14:05', 'la hora en en-GB');
  });
});

test('Buscar y filtrar y las versiones de una hoja, en inglés: títulos, separadores, calendario, fechas y botones', async (page) => {
  await page.open({ prefs: { lang: 'en' } });
  // Las versiones anteriores de la primera hoja.
  const chips = await page.evaluate("[...document.querySelectorAll('.page-head .chip')].map((c) => c.textContent)");
  check(chips.includes('2 previous versions'), `los chips de la hoja: ${chips.join(' | ')}`);
  await page.clickOn('.page-head .chip', 'previous versions');
  await page.until(async () => (await page.state()).dialog === 'Versions of Pendientes de hoy', 'no se abrió «Versions of Pendientes de hoy»');
  await sleep(300);
  let phrasesNow = await phrases(page, '.modal');
  for (const expected of ['Current', 'Done', 'Close', 'Folio saves one version per editing session. You can copy the text of any of them.']) {
    check(phrasesNow.includes(expected), `versiones: falta «${expected}» en ${phrasesNow.join(' | ')}`);
  }
  const dates = await page.evaluate("[...document.querySelectorAll('.versions [role=\"tab\"]')].map((b) => b.textContent)");
  check(dates.length === 3 && dates.at(-1) === 'Current' && dates.slice(0, 2).every((d) => /^[A-Z][a-z]{2} \d+, \d+:\d\d\s[AP]M$/.test(d)), `las fechas de las versiones: ${dates.join(' | ')}`);
  await page.key('Escape');
  await page.until(async () => !(await page.state()).dialog, 'Esc no cerró las versiones');

  // Buscar y filtrar.
  await page.key('f', { ctrl: true });
  await page.until(async () => (await page.state()).dialog === 'Search and filter', 'no se abrió «Search and filter»');
  await sleep(300);
  phrasesNow = await phrases(page, '.modal');
  for (const expected of ['Search all sheets', 'Filter by category', 'Dividers', 'All', 'Uncategorized', 'Secret-book', 'Trash', 'Jump to a date', 'Previous month', 'Next month', 'Clear filters', 'Show sheets', 'Press Enter to go back to the notebook', 'Close']) {
    check(phrasesNow.includes(expected), `buscar: falta «${expected}» en ${phrasesNow.join(' | ')}`);
  }
  const month = await page.evaluate("document.querySelector('.calendar-head strong').textContent");
  const expectedMonth = await page.evaluate("new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date())");
  equal(month, expectedMonth, 'el mes del calendario');
  const weekdays = await page.evaluate("[...document.querySelectorAll('.calendar-weekday')].map((e) => e.textContent).join('')");
  equal(weekdays, 'MTWTFSS', 'las iniciales de los días');
  const sheetsOnADay = await page.evaluate("document.querySelector('.calendar-day:not([disabled])')?.getAttribute('title')");
  check(/^\d+ sheets?$/.test(sheetsOnADay ?? ''), `el cartelito de un día con hojas: ${sheetsOnADay}`);
  const left = await untranslated(page, '.modal');
  equal(left.join(' | '), '', 'buscar: frases en español con la interfaz en inglés');
  await page.key('Escape');
  await page.until(async () => !(await page.state()).dialog, 'Esc no cerró Buscar y filtrar');
  equal((await missing(page)).join(' | '), '', 'frases pedidas en inglés sin traducción');
});

test('en español, Buscar y filtrar y las versiones quedan como siempre', async (page) => {
  await page.open({ prefs: { lang: 'es' } });
  await page.key('f', { ctrl: true });
  await page.until(async () => (await page.state()).dialog === 'Buscar y filtrar', 'no se abrió «Buscar y filtrar»');
  await sleep(300);
  const text = await page.evaluate("document.querySelector('.modal').innerText");
  for (const expected of ['Separadores', 'Todas', 'Sin categoría', 'Secret-book', 'Papelera', 'Abrir en una fecha', 'Quitar filtros', 'Ver las hojas', 'Enter para volver al cuaderno']) hasText(text, expected, 'buscar');
  const weekdays = await page.evaluate("[...document.querySelectorAll('.calendar-weekday')].map((e) => e.textContent).join('')");
  equal(weekdays, 'LMMJVSD', 'las iniciales de los días');
  const month = await page.evaluate("document.querySelector('.calendar-head strong').textContent");
  check(/^[A-ZÁÉÍÓÚ][a-záéíóú]+ de \d{4}$/.test(month), `el mes del calendario en español: ${month}`);
  await page.key('Escape');
  await page.until(async () => !(await page.state()).dialog, 'Esc no cerró Buscar y filtrar');
});

test('otra ventana: el idioma que se cambia en Ajustes llega al cuaderno por el evento storage, y de vuelta', async (page) => {
  await page.open({ prefs: { lang: 'es' } });
  await page.key('f', { ctrl: true });
  await page.until(async () => (await page.state()).dialog === 'Buscar y filtrar', 'no se abrió «Buscar y filtrar»');
  const settings = await otherWindow(page, '?window=settings');
  try {
    equal(await settings.evaluate('document.documentElement.lang'), 'es', 'Ajustes arranca en el idioma guardado');
    const clickLanguage = async (name) => {
      await settings.send('Page.bringToFront');
      await settings.evaluate(
        `[...document.querySelectorAll('.segmented[aria-label="Idioma"] button, .segmented[aria-label="Language"] button')].find((b) => b.textContent === ${JSON.stringify(name)} || (${JSON.stringify(name)} === 'Automático' && b.textContent === 'Automatic')).click()`,
      );
      await page.send('Page.bringToFront');
    };

    await clickLanguage('English');
    await settings.until(async () => (await settings.evaluate('document.documentElement.lang')) === 'en', 'la ventana de Ajustes no cambió');
    // El cuaderno, que está abierto en otra ventana, también.
    await page.until(async () => (await page.state()).dialog === 'Search and filter', 'el cuaderno no pasó a inglés', 6000);
    equal(await htmlLang(page), 'en', 'el idioma del cuaderno');
    check((await phrases(page, '.modal')).includes('Clear filters'), 'el contenido de Buscar y filtrar sigue en español');
    equal(await savedLang(page), 'en', 'el idioma guardado');

    await clickLanguage('Español');
    await settings.until(async () => (await settings.evaluate('document.documentElement.lang')) === 'es', 'la ventana de Ajustes no volvió');
    await page.until(async () => (await page.state()).dialog === 'Buscar y filtrar', 'el cuaderno no volvió a español', 6000);
    equal(await htmlLang(page), 'es', 'el idioma del cuaderno al volver');

    // Automático, desde Ajustes, también se refleja (el navegador de las pruebas habla inglés).
    await clickLanguage('Automático');
    await page.until(async () => (await savedLang(page)) === 'auto', 'no se guardó Automático');
    equal(await htmlLang(page), await settings.evaluate('document.documentElement.lang'), 'las dos ventanas quedaron en idiomas distintos');
  } finally {
    await settings.close();
  }
  await page.key('Escape');
});

test('un texto sin traducir se muestra en español, con sus {huecos}, y nada se rompe', async (page) => {
  await openSettings(page, { prefs: { lang: 'en' } });
  const out = await page.evaluate(`(async () => {
    const { t, tn, mark, quote, setLanguage } = await import('/src/i18n/index.ts');
    window.__i18n.clear();
    const en = {
      plain: t('Esta frase todavía no tiene inglés'),
      holes: t('Frase de prueba {n} de {total}', { n: 3, total: 40 }),
      unknown: t('Con {hueco} sin valor', { otro: 1 }),
      plural: [tn(1, '{n} cosa sin inglés', '{n} cosas sin inglés'), tn(1500, '{n} cosa sin inglés', '{n} cosas sin inglés')],
      marked: mark('Marcada sin inglés'),
      empty: t(''),
      proto: [t('constructor'), t('__proto__'), t('toString'), t('hasOwnProperty')],
      quote: quote('hola'),
      known: t('Cancelar'),
      missing: window.__i18n.missing(),
    };
    setLanguage('es');
    const es = { plain: t('Esta frase todavía no tiene inglés'), known: t('Cancelar'), quote: quote('hola'), holes: t('Frase de prueba {n} de {total}', { n: 3, total: 40 }) };
    setLanguage('en');
    return { en, es };
  })()`);
  equal(out.en.plain, 'Esta frase todavía no tiene inglés', 'una frase sin inglés sale en español');
  equal(out.en.holes, 'Frase de prueba 3 de 40', 'los huecos se llenan también sin traducción');
  equal(out.en.unknown, 'Con {hueco} sin valor', 'un hueco sin valor se queda como está');
  equal(out.en.plural.join(' / '), '1 cosa sin inglés / 1,500 cosas sin inglés', 'los plurales sin traducción, con el número del idioma');
  equal(out.en.marked, 'Marcada sin inglés', 'mark devuelve la frase tal cual');
  equal(out.en.empty, '', 'una frase vacía');
  equal(out.en.proto.join(' | '), 'constructor | __proto__ | toString | hasOwnProperty', 'las claves de Object.prototype no se confunden con frases');
  equal(out.en.quote, '“hola”', 'comillas en inglés');
  equal(out.en.known, 'Cancel', 'una frase con inglés');
  check(out.en.missing.includes('Esta frase todavía no tiene inglés') && out.en.missing.includes('Frase de prueba {n} de {total}'), `el registro de faltantes: ${out.en.missing}`);
  check(!out.en.missing.includes('Cancelar') && !out.en.missing.includes(''), 'el registro anotó una frase que sí tiene inglés (o la vacía)');
  equal(out.es.plain, 'Esta frase todavía no tiene inglés', 'en español, igual');
  equal(out.es.known, 'Cancelar', 'en español, Cancelar');
  equal(out.es.quote, '«hola»', 'comillas en español');
  equal(out.es.holes, 'Frase de prueba 3 de 40', 'en español, los huecos');
  // La pantalla sigue entera, también con el idioma cambiado por detrás.
  check((await page.ask('count', '.settings-body .group')) > 0, 'Ajustes quedó vacío');
});

test('la preferencia se lee con tolerancia: un valor raro vale Automático y el resto de las preferencias no se pierde', async (page) => {
  await openSettings(page, { prefs: { lang: 'es' } });
  const read = (stored) =>
    page.evaluate(`import('/src/hooks.ts').then(({ loadPrefs }) => {
      localStorage.setItem('book.prefs', ${JSON.stringify(stored)});
      const prefs = loadPrefs();
      return { lang: prefs.lang, theme: prefs.theme, name: prefs.name };
    })`);
  equal((await read('{"lang":"fr"}')).lang, 'auto', 'un idioma que no existe');
  equal((await read('{"lang":5}')).lang, 'auto', 'un número');
  equal((await read('{"lang":null}')).lang, 'auto', 'null');
  equal((await read('{"theme":"dark"}')).lang, 'auto', 'sin idioma guardado (preferencias de antes de que existiera)');
  equal((await read('no es json')).lang, 'auto', 'un JSON roto');
  equal((await read('{"lang":"en","theme":"dark","name":"Mis notas"}')).lang, 'en', 'inglés');
  equal((await read('{"lang":"es"}')).lang, 'es', 'español');
  const kept = await read('{"lang":"en","theme":"dark","name":"Mis notas"}');
  equal(`${kept.theme}|${kept.name}`, 'dark|Mis notas', 'el resto de las preferencias');
});

test('diseño en inglés: el texto entra en Ajustes, hasta en la ventana más angosta, y en Buscar y filtrar', async (page) => {
  const clipped = (page) =>
    page.evaluate(`(() => {
      const body = document.querySelector('.settings-body');
      const limit = body.getBoundingClientRect().right;
      const found = [];
      for (const element of body.querySelectorAll('*')) {
        if (element.matches('.mono, .integration-path, input, textarea')) continue;
        const box = element.getBoundingClientRect();
        if (box.width === 0 || getComputedStyle(element).position === 'fixed') continue;
        const style = getComputedStyle(element);
        const cuts = style.overflowX === 'hidden' || style.overflowX === 'clip' || style.textOverflow === 'ellipsis';
        if (box.right > limit + 1 && !element.closest('.suggest-panel')) found.push('se sale: ' + (element.className || element.tagName) + ' ' + Math.round(box.right - limit));
        else if (cuts && element.scrollWidth > element.clientWidth + 1) found.push('recortado: ' + (element.className || element.tagName) + ' «' + (element.textContent ?? '').slice(0, 40) + '»');
      }
      return { scroll: body.scrollWidth - body.clientWidth, found: found.slice(0, 5) };
    })()`);
  for (const lang of ['en', 'es']) {
    await openSettings(page, { prefs: { lang }, width: 620 });
    for (const name of ['look', ...COVERED]) {
      await goTo(page, name);
      const result = await clipped(page);
      equal(`${result.scroll} ${result.found.join(' ; ')}`.trim(), '0', `${lang}, ${name}, 620 px`);
    }
  }
  // Buscar y filtrar, en inglés: el cuadro cabe en la ventana y nada queda recortado.
  await page.open({ width: 900, height: 700, prefs: { lang: 'en' } });
  await page.key('f', { ctrl: true });
  await page.until(async () => (await page.state()).dialog === 'Search and filter', 'no se abrió Buscar y filtrar');
  await sleep(300);
  const modal = await page.evaluate(`(() => {
    const box = document.querySelector('.modal').getBoundingClientRect();
    const cut = [...document.querySelectorAll('.modal *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && ['hidden', 'clip'].includes(getComputedStyle(e).overflowX)).map((e) => e.className || e.tagName);
    return { fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight, cut };
  })()`);
  check(modal.fits, 'el cuadro de Buscar y filtrar no entra en la ventana');
  equal(modal.cut.join(','), '', 'texto recortado en Buscar y filtrar');
});

// ---- correr --------------------------------------------------------------------------

const { page, close } = await launch({ width: 1280, height: 900 });
let failures = [];
try {
  failures = await run(page);
} finally {
  await close();
}
process.exit(failures.length ? 1 : 0);
