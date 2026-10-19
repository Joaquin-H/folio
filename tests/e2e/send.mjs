// Pruebas de punta a punta de «Enviar lo seleccionado al Book»: el atajo global en
// Ajustes → Atajos («Ctrl + Alt + X» de fábrica, cambiarlo, choques, aviso cuando otra
// aplicación ya lo usa, restablecer), la elección del destino («Agregar a la hoja del día»
// o «Abrir en hoja suelta») y la recepción del recorte con su origen en la hoja suelta
// (tanto al abrirse como cuando ya estaba abierta con texto escrito).
//
// Uso (desde la carpeta del proyecto):
//   node tests/e2e/send.mjs             todas
//   node tests/e2e/send.mjs hoja        solo las que tienen "hoja" en el nombre

import { check, equal, launch, sleep, suite } from './harness.mjs';

const WINDOW = { standard: { width: 1280, height: 900 }, full: { width: 1920, height: 1080 } };

const { test, run } = suite();

const letter = (ch) => ({ key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0) });
const KEYS = {
  comma: { key: ',', code: 'Comma', vk: 188 },
  enter: { key: 'Enter', code: 'Enter', vk: 13 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
};
const bits = (mods) => (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);

async function press(page, spec, mods = {}) {
  const common = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers: bits(mods) };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  await sleep(90);
}

async function open(page, query = '') {
  try {
    await page.evaluate("localStorage.removeItem('book.shortcuts'); sessionStorage.removeItem('book.mock.seed');");
  } catch {
    // la primera vez la página está en blanco y no tiene almacenamiento
  }
  await page.open({ ...WINDOW.standard, prefs: { size: 'standard', spread: 'double' }, query });
}

const api = (page, code) => page.evaluate(`import('/src/api.ts').then(({ api }) => (${code}))`);
const waitDialog = (page, name) => page.until(async () => (await page.state()).dialog === name, `no se abrió «${name}»`);
const confirmTitle = (page) => page.evaluate("document.querySelector('.confirm')?.getAttribute('aria-label') ?? null");
const waitConfirm = (page, title) => page.until(async () => (await confirmTitle(page)) === title, `no se abrió «${title}»`);
const noConfirm = (page, what) => page.until(async () => (await confirmTitle(page)) === null, what);

async function tap(page, selector, text) {
  await page.evaluate(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${JSON.stringify(text ?? null)} === null || (e.textContent ?? '').includes(${JSON.stringify(text ?? null)}));
    element?.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(60);
  await page.clickOn(selector, text);
  await sleep(120);
}

async function openShortcuts(page) {
  await press(page, KEYS.comma, { ctrl: true });
  await waitDialog(page, 'Ajustes');
  await sleep(250);
  await page.clickOn('.settings-tabs [role="tab"]', 'Atajos');
  await sleep(200);
}

const keysOf = (page, action) =>
  page.evaluate(`[...document.querySelectorAll('.shortcut-row[data-action="${action}"] .keycap:not(.add)')].map((e) => e.textContent)`);
const noticeOf = (page, action) => page.evaluate(`document.querySelector('.shortcut-row[data-action="${action}"] .shortcut-notice')?.textContent ?? null`);

test('enviar: en Ajustes → Atajos aparece «Enviar lo seleccionado a Folio» con Ctrl + Alt + X, su explicación y el pie del grupo', async (page) => {
  await open(page);
  equal(
    await api(page, 'api.getSettings().then((s) => `${s.sendKeys}|${s.sendShortcut}|${s.sendTo}`)'),
    'Ctrl+Alt+X|Ctrl + Alt + X|day',
    'ajustes de fábrica de enviar a Folio',
  );
  await openShortcuts(page);
  equal((await keysOf(page, 'global-send')).join('|'), 'Ctrl + Alt + X', 'combinación de fábrica de «Enviar lo seleccionado a Folio»');
  const rowText = await page.evaluate("document.querySelector('.shortcut-row[data-action=\"global-send\"] .row-text')?.textContent ?? ''");
  check(rowText.includes('Enviar lo seleccionado a Folio'), `falta el nombre de la acción: ${rowText}`);
  check(rowText.includes('Selecciona un texto en cualquier programa'), `falta la explicación debajo del nombre: ${rowText}`);

  const footer = await page.evaluate(`(() => {
    const group = [...document.querySelectorAll('.settings-body .group')].find((g) => g.querySelector('h3')?.textContent === 'Desde cualquier programa');
    return group?.querySelector('.group-footer')?.textContent ?? '';
  })()`);
  check(footer.includes('clic derecho') && footer.includes('recortes-AAAA-MM-DD.txt'), `el pie del grupo no explica el atajo ni la hoja del día: ${footer}`);
});

test('enviar: cambiar el atajo global, choques, aviso si otra aplicación ya lo usa y restablecer (uno o todos)', async (page) => {
  await open(page);
  await openShortcuts(page);

  await tap(page, '.shortcut-row[data-action="global-send"] .keycap');
  await press(page, letter('j'), { ctrl: true, shift: true });
  await sleep(250);
  equal(await api(page, 'api.getSettings().then((s) => s.sendKeys)'), 'Ctrl+Shift+J', 'no guardó la combinación nueva en sendKeys');
  equal((await keysOf(page, 'global-send')).join('|'), 'Ctrl + Mayús + J', 'la pantalla no muestra la combinación nueva');

  // Chocar con otro atajo global avisa y no ofrece reemplazar.
  await tap(page, '.shortcut-row[data-action="global-send"] .keycap');
  await press(page, letter('n'), { ctrl: true, alt: true });
  const notice = (await noticeOf(page, 'global-send')) ?? '';
  check(notice.includes('Ya se usa para «Nueva hoja suelta»') && !notice.includes('Reemplazar'), `choque con otro global: ${notice}`);
  equal((await keysOf(page, 'global-send')).join('|'), 'Ctrl + Mayús + J', 'el choque cambió la combinación');

  // Restablecer solo este atajo vuelve a Ctrl + Alt + X.
  await tap(page, '.shortcut-row[data-action="global-send"] .shortcut-reset');
  await sleep(250);
  equal(await api(page, 'api.getSettings().then((s) => s.sendKeys)'), 'Ctrl+Alt+X', 'restablecer el atajo no volvió a Ctrl+Alt+X');
  equal((await keysOf(page, 'global-send')).join('|'), 'Ctrl + Alt + X', 'la tecla no volvió a Ctrl + Alt + X');

  // Cambiarlo otra vez y usar «Restablecer todos».
  await tap(page, '.shortcut-row[data-action="global-send"] .keycap');
  await press(page, letter('y'), { ctrl: true, shift: true });
  await sleep(250);
  equal((await keysOf(page, 'global-send')).join('|'), 'Ctrl + Mayús + Y', 'no tomó Ctrl + Mayús + Y');
  await tap(page, '.settings-body button', 'Restablecer todos');
  await waitConfirm(page, '¿Restablecer todos los atajos?');
  await sleep(250);
  await tap(page, '.confirm button', 'Restablecer');
  await noConfirm(page, 'Restablecer no cerró la pregunta');
  await sleep(300);
  equal(await api(page, 'api.getSettings().then((s) => s.sendKeys)'), 'Ctrl+Alt+X', '«Restablecer todos» no devolvió sendKeys a Ctrl+Alt+X');
  equal((await keysOf(page, 'global-send')).join('|'), 'Ctrl + Alt + X', '«Restablecer todos» no devolvió la tecla a Ctrl + Alt + X');

  // Si el sistema no pudo registrar el atajo (sendShortcut: null), lo avisa en esa fila.
  await open(page);
  await api(page, '(() => { const get = api.getSettings; api.getSettings = async () => ({ ...(await get()), sendShortcut: null }); })()');
  await openShortcuts(page);
  const sendRow = await page.evaluate("document.querySelector('.shortcut-row[data-action=\"global-send\"]').textContent");
  check(sendRow.includes('No se pudo activar: otra aplicación ya usa esa combinación.'), `no avisó que sendShortcut no se pudo activar: ${sendRow}`);
  const openRow = await page.evaluate("document.querySelector('.shortcut-row[data-action=\"global-open\"]').textContent");
  check(!openRow.includes('No se pudo activar'), 'el aviso apareció en un atajo que sí estaba activo');
});

test('enviar: elegir el destino («Hoja única», «Por día», «Por semana», «Por mes» o «Hoja suelta») actualiza sendTo', async (page) => {
  await open(page);
  await openShortcuts(page);

  const selected = () =>
    page.evaluate(
      "[...document.querySelectorAll('[aria-label=\"Al enviar lo seleccionado\"] [role=\"tab\"]')].find((b) => b.getAttribute('aria-selected') === 'true')?.textContent ?? null",
    );
  equal(await selected(), 'Por día', 'destino elegido de fábrica');

  for (const [label, value] of [
    ['Hoja única', 'all'],
    ['Por semana', 'week'],
    ['Por mes', 'month'],
    ['Hoja suelta', 'sheet'],
    ['Por día', 'day'],
  ]) {
    await tap(page, '[aria-label="Al enviar lo seleccionado"] [role="tab"]', label);
    await sleep(200);
    equal(await selected(), label, `no marcó «${label}»`);
    equal(await api(page, 'api.getSettings().then((s) => s.sendTo)'), value, `no actualizó sendTo a "${value}"`);
  }
});

test('enviar: la hoja suelta recibe el texto inicial y el origen de CaptureSeed al abrirse y al guardar crea la nota', async (page) => {
  await open(page);
  // Dejamos la semilla en sessionStorage antes de abrir la hoja suelta, como cuando el backend
  // la abre desde «Enviar lo seleccionado al Book» con el destino «Abrir en hoja suelta».
  await page.evaluate(
    `sessionStorage.setItem('book.mock.seed', JSON.stringify({ origin: '— 14:32 · Chrome · «Artículo de prueba»', text: 'Un fragmento seleccionado en el navegador.' }))`,
  );
  await page.open({ width: 440, height: 572, query: '?window=capture' });
  await page.until(
    async () => (await page.evaluate("document.querySelector('.loose-text')?.value ?? ''")).includes('Artículo de prueba'),
    'la hoja suelta no cargó la semilla inicial',
  );
  const initial = await page.evaluate("document.querySelector('.loose-text').value");
  equal(initial, '— 14:32 · Chrome · «Artículo de prueba»\nUn fragmento seleccionado en el navegador.', 'texto inicial de la hoja suelta');
  // La semilla se entrega una sola vez.
  equal(await api(page, 'api.takeCaptureSeed()'), null, 'takeCaptureSeed tenía que haberse consumido');

  // Al guardar con Ctrl + Enter, crea la nota con ese contenido.
  await page.clickOn('.loose-text');
  await press(page, KEYS.enter, { ctrl: true });
  await page.until(
    async () => (await api(page, "api.listSheets({ view: 'all' })")).some((s) => s.preview.includes('Un fragmento seleccionado en el navegador.')),
    'guardar la hoja suelta no creó la nota en el Book',
  );
  const created = await api(page, "api.listSheets({ view: 'all' }).then((list) => list.find((s) => s.preview.includes('Un fragmento seleccionado en el navegador.')))");
  check(created && created.preview.startsWith('— 14:32 · Chrome · «Artículo de prueba»\n'), `la nota creada no conserva el encabezado de origen: ${JSON.stringify(created)}`);
});

test('enviar: con la hoja suelta ya abierta, simulateSend agrega el recorte al final y cancela un descarte pendiente', async (page) => {
  await open(page, '?window=capture');
  await page.clickOn('.loose-text');
  await page.type('Nota que ya estaba escribiendo');

  // Primer clic en Descartar: queda esperando confirmación.
  await page.clickOn('.loose-actions button[aria-label="Descartar"]');
  await page.until(() => page.ask('count', '.loose-actions .armed'), 'Descartar no pidió confirmación');

  // Llega un recorte enviado desde otro programa con la hoja abierta.
  await page.evaluate(
    `import('/src/mock.ts').then(({ simulateSend }) => simulateSend({ origin: '— 15:10 · Word · «Informe.docx»', text: 'Recorte sumado a la hoja abierta.' }))`,
  );
  await page.until(
    async () => (await page.evaluate("document.querySelector('.loose-text')?.value ?? ''")).includes('Recorte sumado a la hoja abierta.'),
    'la hoja abierta no recibió el recorte de simulateSend',
  );
  equal(
    await page.evaluate("document.querySelector('.loose-text').value"),
    'Nota que ya estaba escribiendo\n\n— 15:10 · Word · «Informe.docx»\nRecorte sumado a la hoja abierta.',
    'el recorte nuevo tenía que agregarse separado por una línea en blanco',
  );
  equal(await page.ask('count', '.loose-actions .armed'), 0, 'recibir un recorte nuevo tenía que cancelar el descarte pendiente');

  // Si llega otro más, también se suma al final y al guardar queda todo junto.
  await page.evaluate(
    `import('/src/mock.ts').then(({ simulateSend }) => simulateSend({ origin: '— 15:12 · Firefox', text: 'Segundo recorte.' }))`,
  );
  await page.until(
    async () => (await page.evaluate("document.querySelector('.loose-text')?.value ?? ''")).includes('Segundo recorte.'),
    'no llegó el segundo recorte',
  );
  await page.clickOn('.loose-actions button[aria-label="Guardar y cerrar"]');
  await page.until(
    async () => (await api(page, "api.listSheets({ view: 'all' })")).some((s) => s.preview.includes('Segundo recorte.')),
    'Guardar y cerrar no creó la nota con los recortes sumados',
  );
  const saved = await api(page, "api.listSheets({ view: 'all' }).then((list) => list.find((s) => s.preview.includes('Segundo recorte.')))");
  equal(
    saved.preview,
    'Nota que ya estaba escribiendo\n\n— 15:10 · Word · «Informe.docx»\nRecorte sumado a la hoja abierta.\n\n— 15:12 · Firefox\nSegundo recorte.',
    'contenido guardado de la hoja suelta',
  );
});

test('enviar: en la hoja suelta se puede elegir la categoría antes de guardar', async (page) => {
  await open(page, '?window=capture');
  await page.until(() => page.ask('count', '.loose-meta .chip'), 'no apareció el selector de categoría en la hoja suelta');
  equal(await page.evaluate("document.querySelector('.loose-meta .chip')?.textContent ?? ''"), 'Sin categoría', 'categoría inicial en la hoja suelta');

  await page.clickOn('.loose-meta .chip');
  await page.until(() => page.ask('count', '.loose-meta .menu-list'), 'no se abrió el menú de categorías en la hoja suelta');
  await sleep(150);
  await page.clickOn('.loose-meta .menu-item', 'Trabajo');
  await sleep(150);
  equal(await page.evaluate("document.querySelector('.loose-meta .chip')?.textContent ?? ''"), 'Trabajo', 'no se seleccionó la categoría Trabajo en la hoja suelta');

  await page.clickOn('.loose-text');
  await page.type('Nota creada con categoría desde la hoja suelta');
  await page.clickOn('.loose-actions button[aria-label="Guardar y cerrar"]');
  await page.until(
    async () => (await api(page, "api.listSheets({ view: 'all' })")).some((s) => s.preview.includes('Nota creada con categoría desde la hoja suelta')),
    'no se guardó la nota de la hoja suelta con categoría',
  );
  const saved = await api(
    page,
    "api.listSheets({ view: 'all' }).then((list) => list.find((s) => s.preview.includes('Nota creada con categoría desde la hoja suelta')))",
  );
  equal(saved.categoryId, 1, 'la nota guardada desde la hoja suelta no quedó en la categoría elegida (Trabajo = 1)');
  equal(saved.categorySource, 'manual', 'categorySource de la nota guardada con categoría');
});

test('enviar: el interruptor de incluir origen activa y desactiva sendOrigin', async (page) => {
  await open(page);
  await openShortcuts(page);

  const initial = await api(page, 'api.getSettings().then((s) => s.sendOrigin)');
  equal(initial, true, 'sendOrigin viene activado de fábrica');

  await page.clickOn('.shortcut-send-target ~ .row .switch');
  await sleep(200);
  equal(await api(page, 'api.getSettings().then((s) => s.sendOrigin)'), false, 'no desactivó sendOrigin');

  await page.clickOn('.shortcut-send-target ~ .row .switch');
  await sleep(200);
  equal(await api(page, 'api.getSettings().then((s) => s.sendOrigin)'), true, 'no volvió a activar sendOrigin');
});

// ---- correr --------------------------------------------------------------------------

const { page, close } = await launch(WINDOW.full);
let failures = [];
try {
  failures = await run(page);
} finally {
  await close();
}
process.exit(failures.length ? 1 : 0);
