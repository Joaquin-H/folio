// Pruebas de punta a punta de Ajustes → Clasificador: elegir la IA (Jev, Claude, OpenAI, Gemini
// u Ollama), guardar y quitar su clave, escribir el modelo y la dirección, y «Probar». Corren
// sobre la interfaz con datos de muestra (src/mock.ts), en un Edge sin ventana: no hay claves
// ni llamadas a ninguna API, y todo lo que "responde" es de mentira.
//
// Uso (desde la carpeta del proyecto):
//   node tests/e2e/classifier.mjs              todas
//   node tests/e2e/classifier.mjs ollama       solo las que tienen "ollama" en el nombre
//
// Ver tests/e2e/README.md para los puertos y lo que hace falta tener instalado.

import { check, equal, launch, sleep, suite } from './harness.mjs';

const { test, run } = suite();

/** Lo que cada IA dice de adónde viaja el texto (y el nombre del modelo de fábrica). */
const HOSTS = {
  Jev: 'api.typesafe.ai',
  Claude: 'api.anthropic.com',
  OpenAI: 'api.openai.com',
  Gemini: 'generativelanguage.googleapis.com',
};
const FACTORY = { Claude: 'claude-haiku-5-5', OpenAI: 'gpt-6-luna', Gemini: 'gemini-3.5-flash-lite' };

// ---- ayudas ---------------------------------------------------------------------------

/** Abre Ajustes en su propia ventana (como en la app) y entra a la pestaña Clasificador. */
async function open(page, width = 760) {
  await page.open({ width, height: 900, query: '?window=settings' });
  await page.until(async () => (await page.ask('count', '.settings-tabs [role="tab"]')) > 0, 'no cargaron las pestañas de Ajustes');
  await page.clickOn('.settings-tabs [role="tab"]', 'Clasificador');
  await page.until(async () => (await page.ask('count', '[role="radio"]')) === 5, 'no aparecieron las cinco IAs');
  await sleep(350);
}

const text = (page, selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const selectedAi = (page) => page.evaluate(`document.querySelector('[role="radio"][aria-checked="true"] .provider-name')?.firstChild?.textContent ?? null`);
const footer = (page) => text(page, '.group-footer');
/** El título del grupo de la IA elegida (el segundo grupo de la pestaña). */
const panelTitle = (page) => text(page, '.provider-panel h3');
const stateOf = (page, name) =>
  page.evaluate(`[...document.querySelectorAll('[role="radio"]')].find((e) => e.querySelector('.provider-name').firstChild.textContent === ${JSON.stringify(name)})?.querySelector('.provider-state')?.textContent ?? null`);
const hasInput = (page, label) => page.ask('count', `input[aria-label="${label}"]`).then((n) => n > 0);
const inputValue = (page, label) => page.evaluate(`document.querySelector('input[aria-label="${label}"]')?.value ?? null`);
const rowText = (page, label) =>
  page.evaluate(`[...document.querySelectorAll('.settings-body .row')].find((r) => r.querySelector('.row-text span')?.textContent === ${JSON.stringify(label)})?.textContent ?? null`);
const buttonLabels = (page) => page.evaluate(`[...document.querySelectorAll('.settings-body button')].map((b) => b.textContent)`);
const switchOn = (page) => page.evaluate(`document.querySelector('button[role="switch"]').getAttribute('aria-checked') === 'true'`);
const switchDisabled = (page) => page.evaluate(`document.querySelector('button[role="switch"]').disabled`);

async function choose(page, name) {
  await page.clickOn('[role="radio"]', name);
  await page.until(async () => (await selectedAi(page)) === name, `no se eligió ${name}`);
  await sleep(350);
}

/** Escribe en un campo y lo guarda con Enter. */
async function write(page, label, value) {
  await page.clickOn(`input[aria-label="${label}"]`);
  await page.evaluate(`document.querySelector('input[aria-label="${label}"]').select()`);
  if (value) await page.type(value);
  else await page.key('Backspace');
  await page.key('Enter');
  await sleep(250);
}

const noOverflow = (page) =>
  page.evaluate(`(() => {
    const body = document.querySelector('.settings-body');
    const wide = [...body.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > body.getBoundingClientRect().right + 1 && getComputedStyle(e).position !== 'fixed');
    return { scroll: body.scrollWidth - body.clientWidth, wide: wide.slice(0, 3).map((e) => e.className || e.tagName) };
  })()`);

// ---- las pruebas ------------------------------------------------------------------------

test('la pestaña se llama Clasificador y lista las cinco IAs con adónde viaja el texto', async (page) => {
  await open(page);
  const tabs = await page.evaluate(`[...document.querySelectorAll('.settings-tabs [role="tab"]')].map((e) => e.textContent)`);
  check(tabs.includes('Clasificador') && !tabs.includes('Jev'), `las pestañas son ${tabs.join(', ')}`);
  equal(await selectedAi(page), 'Jev', 'de fábrica se consulta a Jev');
  const options = await page.evaluate(`[...document.querySelectorAll('[role="radio"]')].map((e) => e.textContent)`);
  equal(options.length, 5, 'cantidad de IAs');
  for (const [name, host] of Object.entries(HOSTS)) {
    const option = options.find((o) => o.startsWith(name));
    check(option?.includes(host), `${name} no dice que el texto va a ${host}: ${option}`);
  }
  const ollama = options.find((o) => o.startsWith('Ollama'));
  check(ollama.includes('No sale nada de esta PC'), `Ollama no dice que no sale nada de la PC: ${ollama}`);
  // Arriba va elegir la IA; después lo de esa IA; y recién después lo de siempre.
  const titles = await page.evaluate(`[...document.querySelectorAll('.settings-body .group h3')].map((e) => e.textContent)`);
  equal(titles.join('|'), 'IA que clasifica|Jev|Clasificación automática|Cuándo consulta Jev', 'orden de los grupos');
});

test('el texto de privacidad dice el destino real de cada IA', async (page) => {
  await open(page);
  check((await footer(page)).includes('api.typesafe.ai (TypeSafe)'), `Jev: ${await footer(page)}`);
  for (const name of ['Claude', 'OpenAI', 'Gemini']) {
    await choose(page, name);
    const note = await footer(page);
    check(note.includes(`${HOSTS[name]} (`) && !note.includes('typesafe'), `${name}: ${note}`);
    check(note.includes('secret-book') && note.includes('nunca se envían'), `${name} no repite lo del secret-book: ${note}`);
  }
  check((await footer(page)).includes('clave gratuita de Gemini'), `Gemini no avisa de la capa gratuita: ${await footer(page)}`);
  await choose(page, 'Ollama');
  const local = await footer(page);
  check(local.includes('no sale a Internet') && local.includes('localhost:11434') && !local.includes('Gemini'), `Ollama: ${local}`);
});

test('elegir cada IA cambia lo que se pide: clave, modelo y dirección', async (page) => {
  await open(page);
  equal(await panelTitle(page), 'Jev', 'título del grupo de Jev');
  check(await hasInput(page, 'Clave de API de Jev'), 'Jev pide su clave');
  check(!(await buttonLabels(page)).includes('Quitar clave') && (await rowText(page, 'Modelo')) === null, 'Jev tiene un solo modelo');

  for (const name of ['Claude', 'OpenAI', 'Gemini']) {
    await choose(page, name);
    equal(await panelTitle(page), name, `título del grupo de ${name}`);
    check(await hasInput(page, `Clave de API de ${name}`), `${name} no pide su clave`);
    equal(await inputValue(page, `Modelo de ${name}`), FACTORY[name], `modelo de fábrica de ${name}`);
    check(!(await hasInput(page, 'Dirección de Ollama')), `${name} pide la dirección de Ollama`);
    check((await rowText(page, 'Clave de API')).includes('variable de entorno'), `${name} no avisa de su variable de entorno`);
  }
  const envNames = { Claude: 'ANTHROPIC_API_KEY', OpenAI: 'OPENAI_API_KEY', Gemini: 'GEMINI_API_KEY' };
  for (const [name, variable] of Object.entries(envNames)) {
    await choose(page, name);
    check((await rowText(page, 'Clave de API')).includes(variable), `${name} no nombra ${variable}`);
  }

  await choose(page, 'Ollama');
  equal(await panelTitle(page), 'Ollama', 'título del grupo de Ollama');
  check(!(await rowText(page, 'Clave de API')), 'Ollama pide una clave');
  equal(await inputValue(page, 'Modelo de Ollama'), '', 'Ollama no trae modelo');
  equal(await inputValue(page, 'Dirección de Ollama'), 'http://localhost:11434', 'dirección de fábrica');
  equal(await page.evaluate(`document.querySelector('input[aria-label="Modelo de Ollama"]').placeholder`), 'llama3.2', 'el ejemplo de modelo');
});

test('guardar y quitar la clave de una IA', async (page) => {
  await open(page);
  await choose(page, 'Claude');
  equal(await stateOf(page, 'Claude'), 'Sin clave', 'antes de guardar');
  check(await switchDisabled(page), 'se pudo prender la clasificación sin clave');

  await write(page, 'Clave de API de Claude', 'sk-ant-de-mentira');
  await page.until(async () => (await buttonLabels(page)).includes('Quitar clave'), 'no apareció Quitar clave');
  equal(await stateOf(page, 'Claude'), 'Con clave', 'después de guardar');
  equal(await stateOf(page, 'Jev'), 'Sin clave', 'la clave de Claude no es la de Jev');
  check(!(await hasInput(page, 'Clave de API de Claude')), 'sigue el campo de la clave');
  check((await rowText(page, 'Clave de API')).includes('llavero del sistema'), 'no dice dónde queda guardada');
  check(!(await switchDisabled(page)) && (await switchOn(page)), 'guardar la clave no prendió la clasificación');

  // Cada IA tiene su clave: Jev sigue sin.
  await choose(page, 'Jev');
  check(await hasInput(page, 'Clave de API de Jev'), 'la clave de Claude apareció en Jev');
  await choose(page, 'Claude');
  await page.clickOn('.settings-body button', 'Quitar clave');
  await page.until(async () => await hasInput(page, 'Clave de API de Claude'), 'no volvió el campo de la clave');
  equal(await stateOf(page, 'Claude'), 'Sin clave', 'después de quitarla');
  check((await switchDisabled(page)) && !(await switchOn(page)), 'quitar la clave no apagó la clasificación');
});

test('el modelo se cambia, se recuerda por IA y vuelve al de fábrica', async (page) => {
  await open(page);
  await choose(page, 'Claude');
  check(!(await buttonLabels(page)).includes('De fábrica'), 'ofrece volver al de fábrica sin haberlo cambiado');
  await write(page, 'Modelo de Claude', 'claude-sonnet-5-5');
  equal(await inputValue(page, 'Modelo de Claude'), 'claude-sonnet-5-5', 'el modelo escrito');
  await page.until(async () => (await buttonLabels(page)).includes('De fábrica'), 'no apareció De fábrica');

  // Otra IA tiene el suyo; Claude conserva el elegido.
  await choose(page, 'OpenAI');
  equal(await inputValue(page, 'Modelo de OpenAI'), 'gpt-6-luna', 'el modelo de OpenAI no cambia con el de Claude');
  await choose(page, 'Claude');
  equal(await inputValue(page, 'Modelo de Claude'), 'claude-sonnet-5-5', 'Claude no recordó su modelo');

  await page.clickOn('.settings-body button', 'De fábrica');
  await page.until(async () => (await inputValue(page, 'Modelo de Claude')) === 'claude-haiku-5-5', 'De fábrica no devolvió el modelo');
  await sleep(250);
  check(!(await buttonLabels(page)).includes('De fábrica'), 'De fábrica sigue ahí');

  // Vaciar el campo y guardar también vuelve al de fábrica; un nombre con espacios no se guarda.
  await write(page, 'Modelo de Claude', 'claude-opus-5-5');
  await write(page, 'Modelo de Claude', '');
  await page.until(async () => (await inputValue(page, 'Modelo de Claude')) === 'claude-haiku-5-5', 'vaciar el campo no devolvió el de fábrica');
  await write(page, 'Modelo de Claude', 'un modelo con espacios');
  check(((await text(page, '.form-error')) ?? '').includes('espacios'), 'no avisó que el modelo no puede tener espacios');
});

test('Ollama: sin modelo no se puede probar; con modelo, sí, y la dirección se acomoda', async (page) => {
  await open(page);
  await choose(page, 'Ollama');
  equal(await stateOf(page, 'Ollama'), 'Sin modelo', 'Ollama sin modelo');
  const probar = () => page.evaluate(`[...document.querySelectorAll('.settings-body button')].find((b) => b.textContent === 'Probar' || b.textContent === 'Probando…').disabled`);
  check(await probar(), 'se puede probar sin modelo');
  check(await switchDisabled(page), 'se puede prender la clasificación sin modelo');
  check((await rowText(page, 'Probar')).includes('escribí el modelo'), 'no dice qué falta');

  await write(page, 'Modelo de Ollama', 'llama3.2');
  await page.until(async () => (await stateOf(page, 'Ollama')) === 'Lista', 'Ollama no quedó lista');
  check(!(await probar()) && !(await switchDisabled(page)), 'con modelo no se puede probar o prender');

  // Una dirección sin http:// se completa; la de otra máquina cambia lo que se dice del texto.
  await write(page, 'Dirección de Ollama', 'mi-pc:11434/');
  equal(await inputValue(page, 'Dirección de Ollama'), 'http://mi-pc:11434', 'la dirección acomodada');
  await sleep(300);
  check((await footer(page)).includes('mi-pc:11434, que no es esta PC'), `no dice que el texto sale de la PC: ${await footer(page)}`);
  const option = await page.evaluate(`[...document.querySelectorAll('[role="radio"]')].find((e) => e.textContent.startsWith('Ollama')).textContent`);
  check(!option.includes('No sale nada de esta PC') && option.includes('mi-pc:11434'), `la lista sigue diciendo que no sale nada: ${option}`);
  check((await rowText(page, 'Dirección')).includes('otra máquina'), 'el campo no avisa que es otra máquina');

  // Una dirección que no sirve se rechaza con el motivo, y la anterior queda.
  await write(page, 'Dirección de Ollama', 'ftp://x');
  check(((await text(page, '.form-error')) ?? '').includes('http://'), 'no avisó que la dirección tiene que ser http');

  await write(page, 'Dirección de Ollama', '');
  equal(await inputValue(page, 'Dirección de Ollama'), 'http://localhost:11434', 'vaciar la dirección no vuelve a esta PC');
  await sleep(300);
  check((await footer(page)).includes('no sale a Internet'), 'volver a esta PC no vuelve a decir que no sale nada');
});

test('Probar muestra qué eligió la IA, lo cuenta como consulta y se borra al cambiar el modelo', async (page) => {
  await open(page);
  await choose(page, 'Gemini');
  await write(page, 'Clave de API de Gemini', 'AIza-de-mentira');
  await page.until(async () => (await buttonLabels(page)).includes('Quitar clave'), 'no se guardó la clave');
  const calls = () => rowText(page, 'Consultas');
  const parseCalls = (value) => {
    const match = /(\d+) hoy · (\d+) en total/.exec(value ?? '');
    return match ? { today: Number(match[1]), total: Number(match[2]) } : null;
  };
  // Guardar la clave prendió la clasificación: las hojas sin categoría ya pasaron por la IA.
  await page.until(async () => (parseCalls(await calls())?.today ?? 0) > 0, `consultas antes: ${await calls()}`);
  const before = parseCalls(await calls());
  check(before && before.today === before.total, `consultas antes: ${await calls()}`);

  await page.clickOn('.settings-body button', 'Probar');
  await page.until(async () => ((await text(page, '.test-result')) ?? '').includes('Consultando a Gemini'), 'no mostró que estaba consultando');
  check((await buttonLabels(page)).includes('Probando…'), 'el botón no dice Probando…');
  await page.until(async () => ((await text(page, '.test-result.done')) ?? '').includes('Eligió'), 'no apareció el resultado', 5000);
  const result = await text(page, '.test-result.done');
  check(result.includes('Eligió «Compras»') && result.includes('91% de confianza'), `el resultado: ${result}`);
  check(result.includes('Lista del súper') && !result.includes('\n'), `el resultado no muestra la hoja de ejemplo: ${result}`);
  await page.until(
    async () => ((await calls()) ?? '').includes(`${before.today + 1} hoy · ${before.total + 1} en total`),
    'la prueba no sumó una consulta',
  );

  // Con otro modelo, el resultado de antes ya no vale.
  await write(page, 'Modelo de Gemini', 'gemini-3.1-flash-lite');
  await page.until(async () => (await page.ask('count', '.test-result')) === 0, 'el resultado quedó a la vista con otro modelo');
});

test('Probar con un error muestra el motivo', async (page) => {
  await open(page);
  await choose(page, 'Ollama');
  await write(page, 'Modelo de Ollama', 'modelo-inexistente');
  await page.clickOn('.settings-body button', 'Probar');
  await page.until(async () => ((await text(page, '.test-result.failed')) ?? '').includes('No se pudo probar Ollama'), 'no apareció el error', 5000);
  const failed = await text(page, '.test-result.failed');
  check(failed.includes('HTTP 404') && failed.includes('not found'), `el motivo del error: ${failed}`);
  check(!failed.includes('Error:'), `el error trae el prefijo Error: ${failed}`);
  equal(await page.ask('count', '.test-result.done'), 0, 'mostró un resultado y un error');
  // Probar de nuevo no queda trabado.
  check(!(await page.evaluate(`[...document.querySelectorAll('.settings-body button')].find((b) => b.textContent === 'Probar').disabled`)), 'Probar quedó trabado');
});

test('cambiar de IA no vuelve a consultar lo ya clasificado', async (page) => {
  await open(page);
  // Con la clave de Jev, las hojas sin categoría se clasifican y quedan pendientes en cero.
  await write(page, 'Clave de API de Jev', 'tsk-de-mentira');
  await page.until(async () => (await buttonLabels(page)).includes('Quitar clave'), 'no se guardó la clave de Jev');
  const calls = () => rowText(page, 'Consultas');
  const pending = () => text(page, '.row-count');
  await page.until(async () => (await pending()) === '0', 'quedaron hojas pendientes con Jev');
  const before = await calls();
  check(!before.includes('0 en total'), `Jev no consultó nada: ${before}`);

  await choose(page, 'Claude');
  await write(page, 'Clave de API de Claude', 'sk-ant-de-mentira');
  await page.until(async () => (await buttonLabels(page)).includes('Quitar clave'), 'no se guardó la clave de Claude');
  await choose(page, 'OpenAI');
  await choose(page, 'Jev');
  equal(await calls(), before, 'cambiar de IA sumó consultas');
  equal(await pending(), '0', 'cambiar de IA dejó hojas pendientes');
  // «Volver a clasificar todo» es lo único que repite consultas, y lo dice con el nombre de la IA.
  await choose(page, 'Claude');
  check((await rowText(page, 'Volver a clasificar todo')).includes('Consulta de nuevo a Claude'), 'Volver a clasificar no nombra a Claude');
});

test('lo de siempre sigue ahí, con el nombre de la IA elegida', async (page) => {
  await open(page);
  await choose(page, 'OpenAI');
  const titles = await page.evaluate(`[...document.querySelectorAll('.settings-body .group h3')].map((e) => e.textContent)`);
  check(titles.includes('Clasificación automática') && titles.includes('Cuándo consulta OpenAI'), `grupos: ${titles.join(' | ')}`);
  for (const label of ['Clasificar automáticamente', 'Confianza mínima', 'Revisar hojas ya clasificadas', 'Consultas', 'Hojas pendientes de clasificar', 'Volver a clasificar todo']) {
    check(await rowText(page, label), `falta la fila «${label}»`);
  }
  // Salvo la lista de IAs (que nombra a todas), nada habla de Jev con otra IA elegida.
  const rest = await page.evaluate(`[...document.querySelectorAll('.settings-body .group')].slice(1).map((g) => g.textContent).join(' | ')`);
  check(!rest.includes('Jev'), `todavía habla de Jev con OpenAI elegida: ${rest.match(/.{30}Jev.{30}/)?.[0]}`);
  check((await rowText(page, 'Hojas pendientes de clasificar')).includes('clave de OpenAI'), 'no dice que falta la clave de OpenAI');
});

test('se ve bien en la ventana más angosta y con el tema oscuro', async (page) => {
  for (const width of [620, 760]) {
    await open(page, width);
    for (const name of ['Jev', 'Claude', 'Gemini', 'Ollama']) {
      await choose(page, name);
      const overflow = await noOverflow(page);
      check(overflow.scroll <= 0 && overflow.wide.length === 0, `${name} a ${width} px se sale de la ventana: ${JSON.stringify(overflow)}`);
    }
  }
  await page.evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await sleep(300);
  await page.screenshot(`${process.env.TEMP}\\book-providers\\clasificador-oscuro.png`);
});

// ---- correr --------------------------------------------------------------------------

const { page, close } = await launch({ width: 760, height: 900 });
let failures = [];
try {
  failures = await run(page);
} finally {
  await close();
}
process.exit(failures.length ? 1 : 0);
