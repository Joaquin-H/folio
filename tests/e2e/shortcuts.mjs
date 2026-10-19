// Pruebas de punta a punta de dos cosas: el tamaño de la letra del cuaderno (el renglón del
// texto y el del rayado son uno solo, y las páginas se recalculan) y los atajos de teclado
// (los de fábrica, cambiarlos en Ajustes, los choques, restablecer, los globales y las
// conexiones chicas de Ajustes → Carpetas). Corren sobre la interfaz con datos de muestra,
// en un Edge sin ventana.
//
// Uso (desde la carpeta del proyecto):
//   node tests/e2e/shortcuts.mjs             todas
//   node tests/e2e/shortcuts.mjs letra       solo las que tienen "letra" en el nombre
//
// Ver tests/e2e/README.md para los puertos y lo que hace falta tener instalado.

import { check, equal, launch, sleep, suite } from './harness.mjs';

const WINDOW = { pocket: { width: 1280, height: 900 }, standard: { width: 1280, height: 900 }, full: { width: 1920, height: 1080 } };
const WRITABLE = 'reunion-equipo.md';
const LONG = 'Apuntes del curso';
/** Alto de renglón y cuerpo de la letra por tamaño: la tabla de src/layout.ts. */
const TEXT = { small: { font: 13, line: 24 }, medium: { font: 14.5, line: 28 }, large: { font: 16.5, line: 32 }, xlarge: { font: 19, line: 36 } };

const { test, run } = suite();

// ---- teclado: teclas con su `code`, para probar teclados en español y en inglés ----------

const letter = (ch) => ({ key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0) });
const digit = (n) => ({ key: String(n), code: `Digit${n}`, vk: 48 + n });
const KEYS = {
  comma: { key: ',', code: 'Comma', vk: 188 },
  period: { key: '.', code: 'Period', vk: 190 },
  minus: { key: '-', code: 'Minus', vk: 189 },
  /** En un teclado en español, el «+» es la tecla de al lado de la «P»; con Mayús da «*». */
  esPlus: { key: '+', code: 'BracketRight', vk: 221 },
  esStar: { key: '*', code: 'BracketRight', vk: 221 },
  /** En uno en inglés, «=»; con Mayús da «+». */
  usEqual: { key: '=', code: 'Equal', vk: 187 },
  usPlus: { key: '+', code: 'Equal', vk: 187 },
  underscore: { key: '_', code: 'Minus', vk: 189 },
  enter: { key: 'Enter', code: 'Enter', vk: 13 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  pageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  pageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  f2: { key: 'F2', code: 'F2', vk: 113 },
};
const bits = (mods) => (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);

/**
 * Aprieta y suelta una tecla (con esos modificadores), como si fuera el teclado. Ctrl + N, Ctrl + W
 * y Ctrl + T son del navegador: por el protocolo de depuración no llegan a la página (Ctrl + W le
 * cierra la pestaña), así que esas tres se mandan como evento de teclado a la página, que las
 * atiende igual que atiende las de verdad.
 */
async function press(page, spec, mods = {}) {
  if (mods.ctrl && !mods.alt && ['KeyN', 'KeyW', 'KeyT'].includes(spec.code)) {
    await page.evaluate(
      `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(spec.key)}, code: ${JSON.stringify(spec.code)}, ctrlKey: true, shiftKey: ${!!mods.shift}, bubbles: true, cancelable: true }))`,
    );
    await sleep(90);
    return;
  }
  const common = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers: bits(mods) };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  await sleep(90);
}

// ---- ayudas ---------------------------------------------------------------------------

/** Abre el cuaderno de cero: sin atajos elegidos de antes. */
async function open(page, size = 'standard', spread = 'double', prefs = {}, query = '') {
  try {
    await page.evaluate("localStorage.removeItem('book.shortcuts')");
  } catch {
    // la primera vez la página está en blanco y no tiene almacenamiento
  }
  await page.open({ ...WINDOW[size], prefs: { size, spread, ...prefs }, query });
}

const prefsOf = (page) => page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
const api = (page, code) => page.evaluate(`import('/src/api.ts').then(({ api }) => (${code}))`);
const waitDialog = (page, name) => page.until(async () => (await page.state()).dialog === name, `no se abrió «${name}»`);
/** La pregunta corta (Confirm) puede estar encima de Ajustes: se mira por su propia clase. */
const confirmTitle = (page) => page.evaluate("document.querySelector('.confirm')?.getAttribute('aria-label') ?? null");
const waitConfirm = (page, title) => page.until(async () => (await confirmTitle(page)) === title, `no se abrió «${title}»`);
const noConfirm = (page, what) => page.until(async () => (await confirmTitle(page)) === null, what);
const noDialog = (page, what) => page.until(async () => !(await page.state()).dialog, what);

/** Lleva la hoja a la vista y, si hace falta, el elemento al centro antes de tocarlo. */
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

async function gotoSheet(page, title) {
  for (let turns = 0; turns < 60; turns++) {
    const state = await page.state();
    if (state.title === title && !state.busy) return state;
    await press(page, KEYS.right);
    await page.settle(220);
  }
  throw new Error(`No se llegó a la hoja «${title}»`);
}

async function openSettings(page, tab) {
  await press(page, KEYS.comma, { ctrl: true });
  await waitDialog(page, 'Ajustes');
  await sleep(250);
  if (tab) {
    await page.clickOn('.settings-tabs [role="tab"]', tab);
    await sleep(200);
  }
}

const closeDialog = async (page) => {
  await press(page, KEYS.escape);
  await noDialog(page, 'Esc no cerró el diálogo');
  await sleep(250);
};

/** Combinaciones que muestran las teclas de una acción en Ajustes → Atajos. */
const keysOf = (page, action) =>
  page.evaluate(`[...document.querySelectorAll('.shortcut-row[data-action="${action}"] .keycap:not(.add)')].map((e) => e.textContent)`);
const noticeOf = (page, action) => page.evaluate(`document.querySelector('.shortcut-row[data-action="${action}"] .shortcut-notice')?.textContent ?? null`);

/** Cuántos pedidos de «cerrar la ventana» llegaron. */
const watchHide = (page) => page.evaluate(`import('/src/api.ts').then(({ api }) => { window.__hidden = 0; api.window.hide = () => { window.__hidden++; }; return true; })`);

/** Lo que dicen los menús del cuaderno a la derecha de cada renglón. */
async function menuHints(page) {
  await page.clickOn('.page-actions .menu > button');
  await page.until(() => page.ask('count', '.page-actions .menu-list'), 'el menú de la hoja no se abrió');
  await sleep(200);
  const hints = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('.page-actions .menu-item')].map((e) => [e.querySelector('.menu-label')?.textContent, e.querySelector('kbd')?.textContent ?? null]))`);
  await press(page, KEYS.escape);
  await sleep(250);
  return hints;
}

// ---- tamaño de la letra --------------------------------------------------------------

/** Mide la hoja a la vista: el renglón del texto, el del rayado y dónde cae cada cosa. */
const measure = (page) =>
  page.evaluate(`(() => {
    const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
    const clip = document.querySelector('.flow-clip:not(.parked)');
    const flow = clip.querySelector('.flow');
    const text = clip.querySelector('.page-text');
    const style = getComputedStyle(text);
    const lines = document.querySelector('.page-lines');
    const head = document.querySelector('.page-head');
    const foot = document.querySelector('.page-foot');
    const spacer = clip.querySelector('.flow-spacer');
    const node = text.firstChild;
    const char = (offset) => {
      if (!node || node.nodeType !== Node.TEXT_NODE || node.length <= offset) return null;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = [...range.getClientRects()].find((r) => r.width > 0);
      return rect ? { top: rect.top, bottom: rect.bottom } : null;
    };
    const pages = /de (\\d+)$/.exec(document.querySelector('.page-foot > span:last-child')?.textContent ?? '');
    return {
      lineHeight: parseFloat(style.lineHeight),
      fontSize: parseFloat(style.fontSize),
      rule: getComputedStyle(lines).backgroundSize,
      linesHeight: lines.getBoundingClientRect().height,
      clip: box(clip),
      flow: box(flow),
      head: box(head),
      foot: box(foot),
      spacer: spacer.getBoundingClientRect().height,
      first: char(0),
      later: char(Math.min(60, (node?.length ?? 1) - 1)),
      pages: pages ? Number(pages[1]) : 1,
    };
  })()`);

/** El renglón del texto es el del rayado, el área de escritura es de renglones enteros y nada pisa el encabezado ni el pie. */
function seatedOnLines(m, size, where) {
  const { font, line } = TEXT[size];
  equal(m.lineHeight, line, `${where}: alto del renglón del texto`);
  equal(m.fontSize, font, `${where}: cuerpo de la letra`);
  check(m.rule.split(' ').pop() === `${line}px`, `${where}: el rayado va a ${m.rule} y el renglón es de ${line}px`);
  equal(m.clip.height % line, 0, `${where}: el área de escritura (${m.clip.height}px) no es un número entero de renglones de ${line}px`);
  equal(m.linesHeight, m.clip.height, `${where}: el rayado no ocupa lo mismo que el área de escritura`);
  equal(m.spacer % line, 0, `${where}: el hueco del encabezado (${m.spacer}px) no son renglones enteros`);
  check(m.clip.height >= line * 3, `${where}: el área de escritura quedó con menos de tres renglones`);
  check(m.first && m.first.top >= m.head.bottom - 0.5, `${where}: el texto pisa el encabezado (texto desde ${m.first?.top}, encabezado hasta ${m.head.bottom})`);
  check(m.clip.bottom <= m.foot.top + 0.5, `${where}: el área de escritura (hasta ${m.clip.bottom}) pisa el pie (desde ${m.foot.top})`);
  // El centro de cada renglón de texto cae en el centro de un renglón del rayado.
  for (const char of [m.first, m.later]) {
    if (!char) continue;
    const middle = ((char.top + char.bottom) / 2 - m.flow.top) % line;
    check(Math.abs(middle - line / 2) <= 1.5, `${where}: el texto no está centrado sobre su renglón (${middle.toFixed(1)}px de ${line}px)`);
  }
}

test('letra: en los cuatro tamaños el texto y el rayado comparten el renglón (tres tamaños de cuaderno, una y dos hojas)', async (page) => {
  for (const book of ['pocket', 'standard', 'full']) {
    for (const spread of ['double', 'single']) {
      for (const size of Object.keys(TEXT)) {
        const where = `${size}, cuaderno ${book}, ${spread}`;
        await open(page, book, spread, { textSize: size });
        await gotoSheet(page, LONG);
        seatedOnLines(await measure(page), size, where);
      }
    }
  }
});

test('letra: la tabla de layout.ts es la que ven las hojas, la hoja suelta y las versiones', async (page) => {
  const table = await page.evaluate("import('/src/layout.ts').then(({ TEXT_STYLES }) => TEXT_STYLES)");
  for (const size of Object.keys(TEXT)) equal(JSON.stringify(table[size]), JSON.stringify(TEXT[size]), `tabla de ${size}`);
  equal(table.medium.line, 28, 'la letra mediana tiene que ser la de siempre');
  equal(table.medium.font, 14.5, 'la letra mediana tiene que ser la de siempre');
  for (const size of ['small', 'xlarge']) {
    await open(page, 'standard', 'double', { textSize: size });
    // Las versiones anteriores usan la misma letra.
    await page.clickOn('.page-head .chip', 'versiones anteriores');
    await waitDialog(page, 'Versiones de Pendientes de hoy');
    await sleep(300);
    equal(await page.evaluate("parseFloat(getComputedStyle(document.querySelector('.versions-text')).fontSize)"), TEXT[size].font, `versiones en ${size}`);
    await closeDialog(page);
    // Y la hoja suelta.
    await page.open({ width: 440, height: 572, prefs: { textSize: size }, query: '?window=capture' });
    const loose = await page.evaluate("(() => { const s = getComputedStyle(document.querySelector('.loose-text')); return { line: parseFloat(s.lineHeight), font: parseFloat(s.fontSize), rule: s.backgroundSize }; })()");
    equal(loose.line, TEXT[size].line, `hoja suelta en ${size}: renglón`);
    equal(loose.font, TEXT[size].font, `hoja suelta en ${size}: letra`);
    check(loose.rule.split(' ').pop() === `${TEXT[size].line}px`, `hoja suelta en ${size}: el rayado va a ${loose.rule}`);
  }
});

test('letra: una nota larga ocupa más páginas cuanto más grande es la letra', async (page) => {
  const pages = {};
  for (const size of Object.keys(TEXT)) {
    await open(page, 'pocket', 'single', { textSize: size });
    await gotoSheet(page, LONG);
    pages[size] = (await measure(page)).pages;
  }
  check(pages.small <= pages.medium && pages.medium <= pages.large && pages.large <= pages.xlarge, `las páginas no crecen con la letra: ${JSON.stringify(pages)}`);
  check(pages.xlarge > pages.small, `la letra muy grande no ocupa más páginas que la chica: ${JSON.stringify(pages)}`);
});

/** Hay una nota de varias páginas escrita en la hoja `WRITABLE`, con el cursor al final. */
async function fillWriting(page, lines = 70) {
  await gotoSheet(page, WRITABLE);
  await press(page, KEYS.enter);
  await page.until(async () => (await page.state()).writing, 'no entró a escribir');
  const body = Array.from({ length: lines }, (_, i) => `Renglón ${i + 1} con un texto bastante largo para que ocupe más de un renglón del papel.`).join('\n');
  await page.type(`\n${body}`);
  await sleep(500);
}

/** El cursor está dentro de lo que se ve del área de escritura. */
async function caretVisible(page, what) {
  const rect = await page.evaluate(`(() => {
    const selection = getSelection();
    const clip = document.querySelector('.flow-clip:not(.parked)').getBoundingClientRect();
    if (!selection.rangeCount) return { missing: true };
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(false);
    const rect = [...range.getClientRects()][0] ?? range.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, clip: { top: clip.top, bottom: clip.bottom, left: clip.left, right: clip.right } };
  })()`);
  check(!rect.missing, `${what}: no hay cursor`);
  const { clip } = rect;
  check(rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1 && rect.left >= clip.left - 1 && rect.right <= clip.right + 1, `${what}: el cursor quedó fuera de lo que se ve (${JSON.stringify(rect)})`);
}

test('letra: escribiendo, el cursor se ve en los cuatro tamaños, a una y dos hojas', async (page) => {
  for (const spread of ['double', 'single']) {
    for (const size of Object.keys(TEXT)) {
      const where = `${size}, ${spread}`;
      await open(page, 'pocket', spread, { textSize: size });
      await fillWriting(page, 40);
      const state = await page.state();
      check(state.writing && state.focusInEditor, `${where}: se cortó la escritura`);
      await caretVisible(page, where);
      check((await measure(page)).pages > 1, `${where}: la nota escrita tendría que ocupar varias páginas`);
      seatedOnLines(await measure(page), size, `${where} (escribiendo)`);
      await press(page, KEYS.escape);
    }
  }
});

test('letra: cambiarla mientras se escribe no pierde texto y el cursor sigue a la vista', async (page) => {
  for (const spread of ['double', 'single']) {
    await open(page, 'pocket', spread, { textSize: 'medium' });
    await fillWriting(page, 40);
    await page.type(' FIN-DEL-TEXTO');
    await sleep(300);
    const before = await page.state();
    const pagesBefore = (await measure(page)).pages;
    const steps = [
      ['Ctrl + Mayús + + (teclado en español)', () => press(page, KEYS.esStar, { ctrl: true, shift: true }), 'large'],
      ['Ctrl + Mayús + + otra vez', () => press(page, KEYS.esStar, { ctrl: true, shift: true }), 'xlarge'],
      ['Ctrl + Mayús + −', () => press(page, KEYS.underscore, { ctrl: true, shift: true }), 'large'],
      ['Ctrl + Mayús + <', () => press(page, KEYS.comma, { ctrl: true, shift: true }), 'medium'],
      ['Ctrl + Mayús + <', () => press(page, KEYS.comma, { ctrl: true, shift: true }), 'small'],
      ['Ctrl + Mayús + >', () => press(page, KEYS.period, { ctrl: true, shift: true }), 'medium'],
    ];
    for (const [what, act, expected] of steps) {
      await act();
      await sleep(450);
      equal((await prefsOf(page)).textSize, expected, `${spread}: ${what}`);
      const state = await page.state();
      check(state.writing && state.focusInEditor, `${spread}: ${what} cortó la escritura`);
      check(state.text === before.text, `${spread}: ${what} cambió el texto`);
      check(state.text.endsWith('FIN-DEL-TEXTO'), `${spread}: ${what} perdió el final del texto`);
      await caretVisible(page, `${spread}: ${what}`);
      seatedOnLines(await measure(page), expected, `${spread}: ${what}`);
    }
    check((await measure(page)).pages === pagesBefore, 'al volver a la letra mediana la nota tendría que ocupar las mismas páginas');
    await press(page, KEYS.escape);
  }
});

test('letra: al cambiarla leyendo la vista queda en una página válida y las páginas se recalculan', async (page) => {
  await open(page, 'pocket', 'single', { textSize: 'small' });
  await gotoSheet(page, LONG);
  const small = (await measure(page)).pages;
  // Se va hasta la última página con la letra chica…
  for (let i = 0; i < small - 1; i++) {
    await press(page, KEYS.pageDown);
    await page.settle(150);
  }
  await page.settle(300);
  // …y se agranda: sigue en la misma nota, en una página que existe.
  await press(page, KEYS.esStar, { ctrl: true, shift: true });
  await press(page, KEYS.esStar, { ctrl: true, shift: true });
  await page.settle(500);
  const state = await page.state();
  equal(state.title, LONG, 'cambió de hoja al agrandar la letra');
  const [current, total] = (state.page ?? '1 de 1').match(/\d+/g).map(Number);
  check(total > small, `la nota no pasó a ocupar más páginas (antes ${small}, ahora ${total})`);
  check(current >= 1 && current <= total, `la vista quedó en la página ${current} de ${total}`);
  seatedOnLines(await measure(page), 'large', 'después de agrandar leyendo');
});

// ---- los atajos de fábrica ----------------------------------------------------------

test('atajos de fábrica: pasar página, primera y última hoja, escribir y volver (una acción por vez)', async (page) => {
  await open(page);
  await press(page, KEYS.right);
  await page.settle();
  equal((await page.state()).sheet, 2, 'flecha derecha (página siguiente)');
  await press(page, KEYS.left);
  await page.settle();
  equal((await page.state()).sheet, 1, 'flecha izquierda (página anterior)');
  await press(page, KEYS.pageDown);
  await page.settle();
  equal((await page.state()).sheet, 2, 'Av Pág (página siguiente)');
  await press(page, KEYS.pageUp);
  await page.settle();
  equal((await page.state()).sheet, 1, 'Re Pág (página anterior)');
  await press(page, KEYS.end);
  await page.settle(500);
  check((await page.state()).sheet > 5, 'Fin (última hoja) no fue al final');
  await press(page, KEYS.home);
  await page.settle(500);
  equal((await page.state()).sheet, 1, 'Inicio (primera hoja)');

  await gotoSheet(page, WRITABLE);
  await press(page, KEYS.enter);
  await page.until(async () => (await page.state()).writing, 'Enter no entró a escribir');
  await press(page, KEYS.escape);
  await page.until(async () => !(await page.state()).writing, 'Esc no terminó de escribir');
  await press(page, KEYS.f2);
  await page.until(async () => (await page.state()).writing, 'F2 no entró a escribir');
  await press(page, KEYS.enter, { ctrl: true });
  await page.until(async () => !(await page.state()).writing, 'Ctrl + Enter no terminó de escribir');
  await sleep(500);
  await press(page, KEYS.enter);
  await page.until(async () => (await page.state()).writing, 'no volvió a escribir');
  await page.type(' x');
  await press(page, letter('s'), { ctrl: true });
  await page.until(async () => (await page.ask('label', '.write-status')) === 'Guardado', 'Ctrl + S no guardó');
  check((await page.state()).writing, 'Ctrl + S sacó de la hoja');
  await press(page, KEYS.tab);
  check((await page.state()).text.includes('\t'), 'Tab no escribió una tabulación');
  await press(page, KEYS.escape);
});

test('atajos de fábrica: pasar de página dentro de la nota que se escribe (Av Pág y Re Pág)', async (page) => {
  await open(page, 'pocket', 'single');
  await fillWriting(page, 40);
  const last = (await page.state()).page;
  await press(page, KEYS.pageUp);
  await sleep(500);
  check((await page.state()).page !== last, 'Re Pág no pasó de página');
  equal((await page.state()).writing, true, 'Re Pág sacó de la nota');
  await press(page, KEYS.pageDown);
  await sleep(500);
  equal((await page.state()).page, last, 'Av Pág no volvió a la página');
  await press(page, KEYS.escape);
});

test('atajos de fábrica: la ventana (buscar, hoja nueva, ajustes, tamaños, una o dos hojas, cerrar)', async (page) => {
  await open(page, 'standard', 'double');
  await watchHide(page);
  await press(page, letter('f'), { ctrl: true });
  await waitDialog(page, 'Buscar y filtrar');
  await closeDialog(page);

  await press(page, letter('n'), { ctrl: true });
  await page.until(async () => ((await page.state()).mode ?? '').startsWith('Hoja nueva'), 'Ctrl + N no abrió una hoja nueva');
  await press(page, KEYS.escape);
  await page.settle(400);

  await openSettings(page);
  await closeDialog(page);

  await press(page, digit(1), { ctrl: true });
  equal((await prefsOf(page)).size, 'pocket', 'Ctrl + 1');
  await press(page, digit(3), { ctrl: true });
  equal((await prefsOf(page)).size, 'full', 'Ctrl + 3');
  await press(page, digit(2), { ctrl: true });
  equal((await prefsOf(page)).size, 'standard', 'Ctrl + 2');

  await press(page, digit(1), { ctrl: true });
  // Agrandar y achicar el cuaderno: «+» y «-» de un teclado en español, y «=» de uno en inglés.
  await press(page, KEYS.esPlus, { ctrl: true });
  let prefs = await prefsOf(page);
  equal(prefs.height, 608, 'Ctrl + + (teclado en español)');
  await press(page, KEYS.usEqual, { ctrl: true });
  equal((await prefsOf(page)).height, 656, 'Ctrl + = (teclado en inglés)');
  await press(page, KEYS.usPlus, { ctrl: true, shift: true });
  equal((await prefsOf(page)).height, 704, 'Ctrl + Mayús + = es el «+» de un teclado en inglés: agranda el cuaderno');
  equal((await prefsOf(page)).textSize, 'medium', 'en un teclado en inglés, Ctrl + «+» no cambia la letra');
  await press(page, KEYS.minus, { ctrl: true });
  equal((await prefsOf(page)).height, 656, 'Ctrl + −');

  await press(page, letter('d'), { ctrl: true });
  equal((await prefsOf(page)).spread, 'single', 'Ctrl + D');
  await press(page, letter('d'), { ctrl: true });
  equal((await prefsOf(page)).spread, 'double', 'Ctrl + D otra vez');

  await press(page, letter('w'), { ctrl: true });
  equal(await page.evaluate('window.__hidden'), 1, 'Ctrl + W no pidió cerrar la ventana');
});

test('atajos de fábrica: la letra se agranda y se achica con teclados en español y en inglés', async (page) => {
  await open(page, 'standard', 'double');
  const size = async () => (await prefsOf(page)).textSize;
  await press(page, KEYS.esStar, { ctrl: true, shift: true });
  equal(await size(), 'large', 'Ctrl + Mayús + + (español)');
  await press(page, KEYS.period, { ctrl: true, shift: true });
  equal(await size(), 'xlarge', 'Ctrl + Mayús + . (inglés, donde Ctrl + Mayús + «+» es Ctrl + «+»)');
  await press(page, KEYS.period, { ctrl: true, shift: true });
  equal(await size(), 'xlarge', 'en la letra más grande no pasa nada');
  await press(page, KEYS.underscore, { ctrl: true, shift: true });
  equal(await size(), 'large', 'Ctrl + Mayús + −');
  await press(page, KEYS.comma, { ctrl: true, shift: true });
  await press(page, KEYS.comma, { ctrl: true, shift: true });
  await press(page, KEYS.comma, { ctrl: true, shift: true });
  equal(await size(), 'small', 'Ctrl + Mayús + , tres veces llega a la chica y ahí se queda');
});

test('atajos de fábrica: hoja suelta (Esc guarda y cierra) y las combinaciones se leen igual en cualquier teclado', async (page) => {
  await open(page, 'standard', 'double', {}, '?window=capture');
  await api(page, "(window.__saved = [], api.createNote = async (...args) => { window.__saved.push(args); return {}; })");
  await page.clickOn('.loose-text');
  await page.type('Con Esc');
  await press(page, KEYS.escape);
  await page.until(async () => (await page.evaluate('window.__saved.length')) === 1, 'Esc no guardó la hoja suelta');

  // Cómo se leen las teclas: lo que escribe cada una, y nada con AltGr.
  const read = await page.evaluate(`import('/src/shortcuts.ts').then(({ comboOf, matches }) => {
    const ev = (key, code, mods = '') => ({ key, code, ctrlKey: mods.includes('c'), altKey: mods.includes('a'), shiftKey: mods.includes('s'), metaKey: false });
    return {
      es: comboOf(ev('+', 'BracketRight', 'c')),
      esShift: comboOf(ev('*', 'BracketRight', 'cs')),
      us: comboOf(ev('=', 'Equal', 'c')),
      usShift: comboOf(ev('+', 'Equal', 'cs')),
      minus: comboOf(ev('-', 'Slash', 'c')),
      minusShift: comboOf(ev('_', 'Slash', 'cs')),
      comma: comboOf(ev(',', 'Comma', 'c')),
      commaShift: comboOf(ev(';', 'Comma', 'cs')),
      esShift0: comboOf(ev('=', 'Digit0', 'cs')),
      altGr: comboOf(ev('d', 'KeyD', 'ca')),
      altGrMatches: matches(ev('d', 'KeyD', 'ca'), 'spread'),
      onlyShift: comboOf(ev('Shift', 'ShiftLeft', 's')),
      flip: matches(ev('v', 'KeyV'), 'flip'),
      flipWithCtrl: matches(ev('v', 'KeyV', 'c'), 'flip'),
    };
  })`);
  equal(read.es, 'Ctrl+Plus', '«+» en español');
  equal(read.esShift, 'Ctrl+Shift+Plus', 'Mayús + «+» en español (da «*»)');
  equal(read.us, 'Ctrl+Plus', '«=» en inglés');
  equal(read.usShift, 'Ctrl+Plus', '«+» en inglés (Mayús + «=»)');
  equal(read.minus, 'Ctrl+Minus', '«-»');
  equal(read.minusShift, 'Ctrl+Shift+Minus', 'Mayús + «-»');
  equal(read.comma, 'Ctrl+Comma', '«,»');
  equal(read.commaShift, 'Ctrl+Shift+Comma', 'Mayús + «,»');
  equal(read.esShift0, 'Ctrl+Shift+0', 'Ctrl + Mayús + 0 en español no es un «+»');
  equal(read.altGr, null, 'Ctrl + Alt (AltGr) no es una combinación');
  equal(read.altGrMatches, false, 'AltGr + D disparó «una o dos hojas»');
  equal(read.onlyShift, null, 'Mayús sola no es una combinación');
  equal(read.flip, true, 'la acción de dar vuelta el cuaderno (V) no está en el registro');
  equal(read.flipWithCtrl, false, 'Ctrl + V es de pegar, no de dar vuelta el cuaderno');
});

test('atajos: Ctrl + Alt (AltGr) con una letra no dispara nada', async (page) => {
  await open(page, 'standard', 'double');
  const before = await prefsOf(page);
  await press(page, letter('d'), { ctrl: true, alt: true });
  await press(page, letter('f'), { ctrl: true, alt: true });
  await press(page, letter('n'), { ctrl: true, alt: true });
  await press(page, digit(1), { ctrl: true, alt: true });
  await sleep(300);
  const state = await page.state();
  equal(state.dialog, null, 'Ctrl + Alt + F abrió el buscador');
  equal(state.writing, false, 'Ctrl + Alt + N abrió una hoja nueva');
  equal(JSON.stringify(await prefsOf(page)), JSON.stringify(before), 'Ctrl + Alt + D o 1 cambió una preferencia');
});

// ---- cambiar los atajos en Ajustes ---------------------------------------------------

test('atajos: cambiar uno en Ajustes hace que el nuevo funcione y el viejo no, y persiste al recargar', async (page) => {
  await open(page);
  await openSettings(page, 'Atajos');
  equal((await keysOf(page, 'spread')).join('|'), 'Ctrl + D', 'la combinación de fábrica de «Una o dos hojas»');
  await tap(page, '.shortcut-row[data-action="spread"] .keycap:not(.add)');
  equal(await page.ask('label', '.keycap.listening'), 'Apretá la combinación nueva…', 'la tecla no avisa que espera la combinación');
  await press(page, letter('k'), { ctrl: true });
  equal((await keysOf(page, 'spread')).join('|'), 'Ctrl + K', 'la combinación nueva no quedó');
  check(!(await page.ask('count', '.keycap.listening')), 'sigue esperando después de elegir');
  check((await page.state()).dialog === 'Ajustes', 'elegir una combinación cerró Ajustes');
  await closeDialog(page);

  await press(page, letter('d'), { ctrl: true });
  equal((await prefsOf(page)).spread, 'double', 'el atajo viejo (Ctrl + D) siguió andando');
  await press(page, letter('k'), { ctrl: true });
  equal((await prefsOf(page)).spread, 'single', 'el atajo nuevo (Ctrl + K) no anduvo');

  // El menú muestra la combinación vigente.
  equal((await menuHints(page))['Doble hoja'], 'Ctrl + K', 'el menú sigue mostrando la combinación de fábrica');

  // Persiste al recargar (sin borrar lo guardado).
  await page.open({ ...WINDOW.standard, prefs: { size: 'standard', spread: 'double' } });
  await press(page, letter('k'), { ctrl: true });
  equal((await prefsOf(page)).spread, 'single', 'Ctrl + K no sobrevivió a la recarga');
  equal((await menuHints(page))['Doble hoja'], 'Ctrl + K', 'el menú, recargado, no muestra la combinación elegida');

  // Lo que se cambia en otra ventana llega por el evento de almacenamiento.
  await page.evaluate(`(() => { localStorage.setItem('book.shortcuts', JSON.stringify({ spread: ['Ctrl+J'] })); window.dispatchEvent(new StorageEvent('storage', { key: 'book.shortcuts' })); return true; })()`);
  await sleep(150);
  await press(page, letter('j'), { ctrl: true });
  equal((await prefsOf(page)).spread, 'double', 'Ctrl + J (puesto desde otra ventana) no anduvo');
  equal((await menuHints(page))['Doble hoja'], 'Ctrl + J', 'el menú no se enteró del cambio hecho en otra ventana');
});

test('atajos: lo guardado roto no rompe nada y se vuelve a los de fábrica', async (page) => {
  await open(page);
  for (const broken of ['{no es json', '[1,2,3]', '"hola"', '{"spread":"Ctrl+K","next":[1,null,"???"],"bogus":["Ctrl+Q"],"search":["Ctrl+Alt+F","nada"]}']) {
    await page.evaluate(`localStorage.setItem('book.shortcuts', ${JSON.stringify(broken)})`);
    await page.open({ ...WINDOW.standard, prefs: { size: 'standard', spread: 'double' } });
    await press(page, letter('d'), { ctrl: true });
    equal((await prefsOf(page)).spread, 'single', `con «${broken.slice(0, 20)}» Ctrl + D dejó de andar`);
    await press(page, letter('d'), { ctrl: true });
    await press(page, letter('f'), { ctrl: true });
    await waitDialog(page, 'Buscar y filtrar');
    await closeDialog(page);
    await press(page, KEYS.right);
    await page.settle();
    equal((await page.state()).sheet, 2, `con «${broken.slice(0, 20)}» la flecha derecha dejó de andar`);
  }
});

test('atajos: un choque avisa, se puede cancelar o reemplazar, y la acción sin atajo queda libre', async (page) => {
  await open(page);
  await openSettings(page, 'Atajos');
  await tap(page, '.shortcut-row[data-action="new"] .keycap:not(.add)');
  await press(page, letter('f'), { ctrl: true });
  const notice = await noticeOf(page, 'new');
  check(notice && notice.includes('Ya se usa para «Buscar y filtrar»') && notice.includes('Reemplazar'), `no avisó del choque: ${notice}`);
  equal((await keysOf(page, 'new')).join('|'), 'Ctrl + N', 'el choque cambió la combinación igual');

  await tap(page, '.shortcut-row[data-action="new"] .shortcut-notice button', 'Cancelar');
  equal(await noticeOf(page, 'new'), null, 'Cancelar no sacó el aviso');
  equal((await keysOf(page, 'new')).join('|'), 'Ctrl + N', 'Cancelar cambió la combinación');
  equal((await keysOf(page, 'search')).join('|'), 'Ctrl + F', 'Cancelar le sacó la combinación a la otra acción');

  await tap(page, '.shortcut-row[data-action="new"] .keycap:not(.add)');
  await press(page, letter('f'), { ctrl: true });
  await tap(page, '.shortcut-row[data-action="new"] .shortcut-notice button', 'Reemplazar');
  equal((await keysOf(page, 'new')).join('|'), 'Ctrl + F', 'Reemplazar no dejó la combinación');
  equal((await keysOf(page, 'search')).join('|'), '', 'Reemplazar no se la sacó a la otra acción');
  check((await page.evaluate("document.querySelector('.shortcut-row[data-action=\"search\"]').textContent")).includes('Sin atajo'), 'la acción sin combinación no dice «Sin atajo»');
  await closeDialog(page);

  await press(page, letter('n'), { ctrl: true });
  await sleep(300);
  equal((await page.state()).writing, false, 'Ctrl + N, que quedó libre, abrió una hoja nueva');
  await press(page, letter('f'), { ctrl: true });
  await page.until(async () => ((await page.state()).mode ?? '').startsWith('Hoja nueva'), 'Ctrl + F no abrió la hoja nueva');
  equal((await page.state()).dialog, null, 'Ctrl + F todavía abre el buscador');
  await press(page, KEYS.escape);
});

test('atajos: lo que no sirve avisa y sigue esperando; Esc cancela sin cerrar Ajustes; Retroceso quita; se puede sumar otra', async (page) => {
  await open(page);
  await openSettings(page, 'Atajos');
  await tap(page, '.shortcut-row[data-action="new"] .keycap:not(.add)');
  const tries = [
    [letter('k'), {}, 'escribiría'],
    [letter('k'), { ctrl: true, alt: true }, 'AltGr'],
  ];
  for (const [spec, mods, expected] of tries) {
    await press(page, spec, mods);
    const notice = await noticeOf(page, 'new');
    check(notice && notice.includes(expected), `se esperaba un aviso con «${expected}» y fue: ${notice}`);
    check(await page.ask('count', '.keycap.listening'), `después de «${expected}» dejó de esperar la combinación`);
  }
  // Copiar, pegar y deshacer son del texto. (Ctrl + C por el protocolo de depuración copia de verdad
  // y deja la prueba esperando: se mira la regla directamente.)
  const reserved = await page.evaluate(`import('/src/shortcuts.ts').then(({ problemWith }) => ['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+A'].map((combo) => problemWith('new', combo)))`);
  check(reserved.every((problem) => problem && problem.includes('la usa el texto')), `Ctrl + C, V, X, Z y A tendrían que estar reservadas: ${JSON.stringify(reserved)}`);
  await press(page, KEYS.escape);
  equal((await page.state()).dialog, 'Ajustes', 'Esc para cancelar cerró Ajustes');
  check(!(await page.ask('count', '.keycap.listening')), 'Esc no canceló la espera');
  equal((await keysOf(page, 'new')).join('|'), 'Ctrl + N', 'Esc cambió la combinación');

  // Retroceso quita la combinación.
  await tap(page, '.shortcut-row[data-action="size-pocket"] .keycap:not(.add)');
  await press(page, KEYS.backspace);
  equal((await keysOf(page, 'size-pocket')).join('|'), '', 'Retroceso no quitó la combinación');
  // Y se puede sumar otra, también con una segunda a una acción que ya tiene una.
  await tap(page, '.shortcut-row[data-action="spread"] .keycap.add');
  equal(await page.ask('label', '.keycap.listening'), 'Apretá la combinación nueva…', 'sumar otra no espera la combinación');
  await press(page, letter('k'), { ctrl: true });
  equal((await keysOf(page, 'spread')).join('|'), 'Ctrl + D|Ctrl + K', 'la segunda combinación no quedó');
  await closeDialog(page);
  await press(page, digit(1), { ctrl: true });
  equal((await prefsOf(page)).size, 'standard', 'Ctrl + 1, que se quitó, siguió andando');
  await press(page, letter('d'), { ctrl: true });
  await press(page, letter('k'), { ctrl: true });
  equal((await prefsOf(page)).spread, 'double', 'las dos combinaciones de una acción tienen que andar (dos veces seguidas = vuelve al principio)');
});

test('atajos: restablecer una o todas vuelve a las de fábrica', async (page) => {
  await open(page);
  await openSettings(page, 'Atajos');
  const resetAllButton = () => page.evaluate("[...document.querySelectorAll('.settings-body button')].find((b) => b.textContent.includes('Restablecer todos')).disabled");
  equal(await resetAllButton(), true, '«Restablecer todos» tiene que estar apagado si nada cambió');
  equal(await page.evaluate("document.querySelector('.shortcut-row[data-action=\"spread\"] .shortcut-reset').classList.contains('shown')"), false, 'el botón de restablecer se ve sin nada cambiado');

  await tap(page, '.shortcut-row[data-action="spread"] .keycap:not(.add)');
  await press(page, letter('k'), { ctrl: true });
  await tap(page, '.shortcut-row[data-action="search"] .keycap:not(.add)');
  await press(page, letter('j'), { ctrl: true });
  equal(await resetAllButton(), false, '«Restablecer todos» tendría que estar prendido');

  await tap(page, '.shortcut-row[data-action="spread"] .shortcut-reset');
  equal((await keysOf(page, 'spread')).join('|'), 'Ctrl + D', 'restablecer una no la devolvió a la de fábrica');
  equal((await keysOf(page, 'search')).join('|'), 'Ctrl + J', 'restablecer una tocó otra');

  await tap(page, '.settings-body button', 'Restablecer todos');
  await waitConfirm(page, '¿Restablecer todos los atajos?');
  await sleep(250);
  await tap(page, '.confirm button', 'Cancelar');
  await noConfirm(page, 'Cancelar no cerró la pregunta');
  await sleep(350);
  equal((await keysOf(page, 'search')).join('|'), 'Ctrl + J', 'Cancelar restableció los atajos');
  await tap(page, '.settings-body button', 'Restablecer todos');
  await waitConfirm(page, '¿Restablecer todos los atajos?');
  await sleep(300);
  await tap(page, '.confirm button', 'Restablecer');
  await noConfirm(page, 'Restablecer no cerró la pregunta');
  await sleep(350);
  equal((await keysOf(page, 'search')).join('|'), 'Ctrl + F', 'restablecer todos no devolvió «Buscar» a la de fábrica');
  equal(await page.evaluate("localStorage.getItem('book.shortcuts')"), null, 'restablecer todos dejó datos guardados');
});

test('atajos: los menús y el botón «Listo» muestran la combinación vigente', async (page) => {
  await open(page);
  let hints = await menuHints(page);
  equal(hints['Doble hoja'], 'Ctrl + D', 'menú: doble hoja');
  equal(hints['Ajustes'], 'Ctrl + ,', 'menú: ajustes');
  equal(hints['Ir a la primera hoja'], 'Inicio', 'menú: primera hoja');
  equal(hints['Ir a la última hoja'], 'Fin', 'menú: última hoja');
  equal(hints['Escribir en esta hoja'], 'Enter', 'menú: escribir');

  await gotoSheet(page, WRITABLE);
  await press(page, KEYS.enter);
  await page.until(async () => (await page.state()).writing, 'no entró a escribir');
  await sleep(300);
  equal(await page.ask('label', '.page-mode button kbd'), 'Ctrl + Enter', 'botón «Listo»');
  hints = await menuHints(page);
  equal(hints['Guardar y terminar de escribir'], 'Ctrl + Enter', 'menú: terminar de escribir');
  await press(page, KEYS.escape);
  await sleep(300);

  // Cambiar «terminar de escribir»: el botón y el menú lo dicen, y vale lo nuevo.
  await openSettings(page, 'Atajos');
  await tap(page, '.shortcut-row[data-action="finish"] .keycap:not(.add)');
  await press(page, letter('e'), { ctrl: true });
  equal((await keysOf(page, 'finish')).join('|'), 'Ctrl + E|Esc', 'finish');
  await closeDialog(page);
  await press(page, KEYS.enter);
  await page.until(async () => (await page.state()).writing, 'no volvió a escribir');
  await sleep(300);
  equal(await page.ask('label', '.page-mode button kbd'), 'Ctrl + E', 'el botón «Listo» no muestra la combinación nueva');
  await press(page, KEYS.enter, { ctrl: true });
  await sleep(300);
  equal((await page.state()).writing, true, 'Ctrl + Enter, que ya no es de «terminar», terminó de escribir');
  await press(page, letter('e'), { ctrl: true });
  await page.until(async () => !(await page.state()).writing, 'Ctrl + E no terminó de escribir');
});

test('atajos: los globales llaman a setGlobalShortcut, avisan si no se pudo y se restablecen', async (page) => {
  await open(page);
  // Los datos de muestra guardan la combinación elegida.
  equal(await api(page, 'api.getSettings().then((s) => s.captureKeys + "|" + s.openKeys)'), 'Ctrl+Alt+N|Ctrl+Alt+B', 'combinaciones de fábrica');
  await openSettings(page, 'Atajos');
  equal((await keysOf(page, 'global-capture')).join('|'), 'Ctrl + Alt + N', 'la hoja nueva global');
  equal((await keysOf(page, 'global-open')).join('|'), 'Ctrl + Alt + B', 'abrir el cuaderno global');

  await tap(page, '.shortcut-row[data-action="global-capture"] .keycap');
  await press(page, letter('k'), { ctrl: true, shift: true });
  await sleep(300);
  equal(await api(page, 'api.getSettings().then((s) => s.captureKeys)'), 'Ctrl+Shift+K', 'no llamó a setGlobalShortcut con la combinación nueva');
  equal((await keysOf(page, 'global-capture')).join('|'), 'Ctrl + Mayús + K', 'la pantalla no muestra la combinación nueva');

  // Una tecla suelta no sirve para un atajo global, y el aviso lo dice.
  await tap(page, '.shortcut-row[data-action="global-open"] .keycap');
  await press(page, letter('k'));
  check(((await noticeOf(page, 'global-open')) ?? '').includes('Alt'), 'una letra sola como atajo global no avisó');
  // Chocar con la otra global avisa y no ofrece reemplazar.
  await press(page, letter('k'), { ctrl: true, shift: true });
  const notice = (await noticeOf(page, 'global-open')) ?? '';
  check(notice.includes('Ya se usa para «Nueva hoja suelta»') && !notice.includes('Reemplazar'), `choque entre globales: ${notice}`);
  // Chocar con un atajo de la ventana ofrece reemplazarlo.
  await tap(page, '.shortcut-row[data-action="global-open"] .keycap');
  await press(page, letter('d'), { ctrl: true, shift: true });
  await sleep(300);
  equal(await api(page, 'api.getSettings().then((s) => s.openKeys)'), 'Ctrl+Shift+D', 'Ctrl + Mayús + D tenía que servir para abrir el cuaderno');

  // Si el sistema no la acepta, el motivo queda a la vista.
  await api(page, "(api.setGlobalShortcut = async () => { throw 'Otra aplicación ya usa esa combinación (prueba)'; })");
  await tap(page, '.shortcut-row[data-action="global-capture"] .keycap');
  await press(page, letter('m'), { alt: true });
  await sleep(300);
  check(((await noticeOf(page, 'global-capture')) ?? '').includes('(prueba)'), 'no mostró por qué falló setGlobalShortcut');
  equal((await keysOf(page, 'global-capture')).join('|'), 'Ctrl + Mayús + K', 'una combinación rechazada cambió lo que se muestra');

  // Restablecer vuelve a Ctrl + Alt + N / Ctrl + Alt + B.
  await page.open({ ...WINDOW.standard, prefs: { size: 'standard', spread: 'double' } });
  await api(page, "api.setGlobalShortcut('capture', 'Ctrl+Shift+K')");
  await api(page, "(window.__calls = [], api.setGlobalShortcut = async (which, keys) => { window.__calls.push([which, keys]); })");
  await openSettings(page, 'Atajos');
  await tap(page, '.shortcut-row[data-action="global-capture"] .shortcut-reset');
  await sleep(200);
  equal(JSON.stringify(await page.evaluate('window.__calls')), JSON.stringify([['capture', 'Ctrl+Alt+N']]), 'restablecer el global no pidió la combinación de fábrica');
});

test('atajos: el aviso de que otra aplicación ya usa la combinación global', async (page) => {
  await open(page);
  await api(page, "(() => { const get = api.getSettings; api.getSettings = async () => ({ ...(await get()), captureShortcut: null }); })()");
  await openSettings(page, 'Atajos');
  const text = await page.evaluate("document.querySelector('.shortcut-row[data-action=\"global-capture\"]').textContent");
  check(text.includes('No se pudo activar: otra aplicación ya usa esa combinación.'), `no avisó que no se pudo activar: ${text}`);
  const other = await page.evaluate("document.querySelector('.shortcut-row[data-action=\"global-open\"]').textContent");
  check(!other.includes('No se pudo activar'), 'el aviso apareció en el atajo que sí se pudo activar');
});

test('atajos: la lista del mouse es informativa y los grupos están completos', async (page) => {
  await open(page);
  await openSettings(page, 'Atajos');
  const titles = await page.evaluate("[...document.querySelectorAll('.settings-body .group h3')].map((e) => e.textContent)");
  equal(titles.join('|'), 'Cuaderno|Escribiendo|Ventana y tamaño|Hoja suelta|Desde cualquier programa|Con el mouse', 'grupos');
  const mouse = await page.evaluate("[...document.querySelectorAll('.settings-body .group:last-of-type kbd')].map((e) => e.textContent)");
  check(['doble clic', 'rueda del mouse', 'Mayús + arrastrar un borde'].every((item) => mouse.includes(item)), `faltan gestos del mouse: ${mouse}`);
  equal(await page.ask('count', '.settings-body .group:last-of-type button'), 0, 'los gestos del mouse no se editan');
  // La pestaña de Personalización ya no repite los atajos.
  await page.clickOn('.settings-tabs [role="tab"]', 'Personalización');
  await sleep(250);
  check(!(await page.evaluate('document.querySelector(".settings-body").textContent')).includes('Atajos con el cuaderno abierto'), 'Personalización todavía lista los atajos');
});

// ---- Ajustes → Carpetas: sacar una carpeta pide confirmación -----------------------------

test('carpetas: Excluir y Quitar piden confirmación, dicen cuántas hojas salen y Cancelar no hace nada', async (page) => {
  await open(page);
  await openSettings(page, 'Carpetas');
  const bans = () => api(page, 'api.getSettings().then((s) => s.bans.length)');
  const roots = () => api(page, 'api.getSettings().then((s) => s.roots.length)');
  const bansBefore = await bans();
  const rootsBefore = await roots();

  await tap(page, '.settings-body .row button', 'Excluir');
  await waitConfirm(page, '¿Excluir esta carpeta?');
  await sleep(250);
  const text = await page.ask('label', '.confirm');
  check(/Salen 9 hojas/.test(text) && /originales no se tocan/.test(text), `la pregunta no dice cuántas hojas salen ni que los originales no se tocan: ${text}`);
  await tap(page, '.confirm button', 'Cancelar');
  await noConfirm(page, 'Cancelar no cerró la pregunta');
  await sleep(300);
  equal(await bans(), bansBefore, 'Cancelar excluyó la carpeta');

  await tap(page, '.settings-body .row button[aria-label^="Quitar"]');
  await waitConfirm(page, '¿Dejar de recorrer esta carpeta?');
  await sleep(250);
  const rootText = await page.ask('label', '.confirm');
  check(/Salen 15 hojas/.test(rootText) && /originales no se tocan/.test(rootText), `la pregunta de quitar no dice cuántas hojas salen: ${rootText}`);
  await tap(page, '.confirm button', 'Cancelar');
  await noConfirm(page, 'Cancelar no cerró la pregunta de quitar');
  await sleep(300);
  equal(await roots(), rootsBefore, 'Cancelar quitó la carpeta');

  await tap(page, '.settings-body .row button', 'Excluir');
  await waitConfirm(page, '¿Excluir esta carpeta?');
  await sleep(250);
  await tap(page, '.confirm button', 'Excluir');
  await sleep(400);
  equal(await bans(), bansBefore + 1, 'confirmar no excluyó la carpeta');
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
