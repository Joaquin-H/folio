// Pruebas de punta a punta de las hojas .md con formato: que cada elemento se dibuje, que
// todo caiga sobre el rayado en los cuatro tamaños de letra, que una nota larga se pagine
// sin cortes feos, que el doble clic deje el cursor en su renglón del original, que los
// enlaces se abran afuera sin que la vista navegue, que las tareas se marquen en el
// archivo y que la selección y las franjas sigan andando. También Ajustes → Integraciones.
// Corren sobre la interfaz con datos de muestra (src/mock.ts), en un Edge sin ventana.
//
// Uso (desde la carpeta del proyecto):
//   node tests/e2e/markdown.mjs             todas
//   node tests/e2e/markdown.mjs enlaces     solo las que tienen "enlaces" en el nombre
//
// Ver tests/e2e/README.md para los puertos y lo que hace falta tener instalado.

import { check, equal, launch, sleep, suite } from './harness.mjs';

/** Las dos notas .md de los datos de muestra: van al final del cuaderno. */
const RICH = 'Plan del cuaderno con formato';
const RICH_FILE = '2026-10-01-plan-del-cuaderno.md';
const LONG = 'bitacora-del-proyecto.md';
/** Alto del renglón de cada tamaño de letra (src/layout.ts). */
const LINE = { small: 24, medium: 28, large: 32, xlarge: 36 };

const { test, run } = suite();

const open = (page, prefs = {}, window = { width: 1280, height: 900 }) =>
  page.open({ ...window, prefs: { size: 'standard', spread: 'double', ...prefs } });
const middle = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });

// ---- ayudas que corren dentro de la página ------------------------------------------

/** Se instala en cada carga: busca texto en la hoja con formato y mide sus bloques. */
function helpers() {
  const root = () => document.querySelector('.flow-clip:not(.parked) .page-text.md');
  window.__md = {
    /** Centro de la aparición número `nth` de `word` en lo dibujado. */
    word(word, nth = 0) {
      const md = root();
      if (!md) return null;
      const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let index = node.data.indexOf(word); index >= 0; index = node.data.indexOf(word, index + 1)) {
          if (seen++ !== nth) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + word.length);
          const rect = [...range.getClientRects()].find((r) => r.width > 0);
          return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, left: rect.left, right: rect.right } : null;
        }
      }
      return null;
    },
    /** Rectángulo (el primero) del elemento de la hoja con formato que coincide. */
    box(selector, text) {
      const element = [...(root()?.querySelectorAll(selector) ?? [])].find((e) => text == null || (e.textContent ?? '').includes(text));
      const rect = element?.getClientRects()[0];
      return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom } : null;
    },
    /** Bloques que no caen sobre el rayado: empiezan o terminan a mitad de un renglón, o se salen de la hoja. */
    grid() {
      const md = root();
      const clip = md.closest('.flow-clip').getBoundingClientRect();
      const line = parseFloat(getComputedStyle(md).lineHeight);
      const off = (value) => {
        const rest = ((value % line) + line) % line;
        return Math.min(rest, line - rest);
      };
      const bad = [];
      for (const element of md.querySelectorAll('[data-line], li, tr')) {
        for (const rect of element.getClientRects()) {
          if (rect.height === 0) continue;
          const name = `${element.tagName.toLowerCase()} «${(element.textContent ?? '').slice(0, 24)}»`;
          if (off(rect.top - clip.top) > 0.6) bad.push(`${name} empieza en ${(rect.top - clip.top).toFixed(1)}`);
          if (off(rect.height) > 0.6) bad.push(`${name} mide ${rect.height.toFixed(1)}`);
          if (rect.bottom > clip.bottom + 0.6) bad.push(`${name} se sale por abajo`);
        }
      }
      return { line, bad, blocks: md.querySelectorAll('[data-line]').length };
    },
    /** Cómo quedó repartida la nota en las páginas (columnas del flujo). */
    pages() {
      const md = root();
      const flow = md.closest('.flow');
      const origin = flow.getBoundingClientRect().left;
      const step = flow.offsetWidth + parseFloat(getComputedStyle(flow).columnGap);
      const column = (rect) => Math.round((rect.left - origin) / step);
      const rects = (element) => [...element.getClientRects()].filter((r) => r.height > 0);
      let last = 0;
      for (const element of md.querySelectorAll('[data-line]')) for (const rect of rects(element)) last = Math.max(last, column(rect));
      // Un título no queda solo al pie de una página: lo que sigue va en la misma.
      const orphans = [...md.querySelectorAll('h1, h2, h3')]
        .filter((heading) => heading.nextElementSibling)
        .filter((heading) => column(rects(heading).at(-1)) !== column(rects(heading.nextElementSibling)[0]))
        .map((heading) => heading.textContent);
      const splitCode = [...md.querySelectorAll('pre.md-code')].filter((pre) => rects(pre).length > 1).length;
      const end = [...md.querySelectorAll('p')].find((p) => p.textContent.includes('Fin de la bitácora'));
      return { columns: last + 1, orphans, splitCode, endColumn: end ? column(rects(end)[0]) : -1 };
    },
  };
}

/** Lo que se abrió afuera (el backend de muestra lo anota). */
const opened = (page) => page.evaluate(`import('/src/mock.ts').then((mock) => mock.openedLinks.slice())`);
const md = (page, name, ...args) => page.evaluate(`window.__md.${name}(${args.map((a) => JSON.stringify(a ?? null)).join(', ')})`);

async function word(page, text, nth = 0) {
  const found = await md(page, 'word', text, nth);
  if (!found) throw new Error(`No está a la vista: «${text}»`);
  return found;
}

/** Va a la nota .md con todo (la última del cuaderno). */
async function toRich(page, title = RICH) {
  await page.key('End');
  await page.until(async () => {
    const state = await page.state();
    return state.title === title && !state.busy;
  }, `no se llegó a «${title}»`, 8000);
  await page.settle(300);
}

/** Va a la nota .md larga, a su primera página. */
async function toLong(page) {
  await toRich(page);
  await page.key('ArrowLeft');
  await page.until(async () => (await page.state()).title === LONG, 'no se llegó a la nota larga');
  await page.settle(250);
  for (let turns = 0; turns < 12 && !/^1 de /.test((await page.state()).page ?? ''); turns++) {
    await page.key('ArrowLeft');
    await page.settle(220);
  }
  check(/^1 de \d+/.test((await page.state()).page ?? ''), 'la nota larga no quedó en su primera página');
}

/** El texto original de la hoja a la vista: escribiendo se ve tal cual. */
async function original(page) {
  await page.key('Enter');
  await page.until(async () => (await page.state()).writing, 'Enter no entró a escribir');
  const { text } = await page.state();
  await page.key('Escape');
  await page.until(async () => !(await page.state()).writing, 'Esc no terminó la escritura');
  await page.until(async () => (await page.ask('count', '.flow-clip:not(.parked) .page-text.md')) > 0, 'la hoja no volvió a verse con formato');
  await page.settle(250);
  return text;
}

async function pickFromMenu(page, label) {
  await page.clickOn('.page-actions .menu > button');
  await page.until(() => page.ask('count', '.page-actions .menu-list'), 'el menú de la hoja no se abrió');
  await sleep(160);
  await page.clickOn('.page-actions .menu-item', label);
}

// ---- qué se dibuja ---------------------------------------------------------------------

test('cada elemento de markdown se dibuja, y el encabezado no se ve crudo', async (page) => {
  await open(page);
  await toRich(page);
  const found = await page.evaluate(`(() => {
    const md = document.querySelector('.flow-clip:not(.parked) .page-text.md');
    const count = (selector) => md.querySelectorAll(selector).length;
    return {
      counts: {
        'título 1': count('h1'), 'título 2': count('h2'), 'título 3': count('h3'), negrita: count('strong'), itálica: count('em'),
        tachado: count('del'), 'código en el texto': count('p code, li code'), 'bloque de código': count('pre.md-code'),
        cita: count('blockquote'), viñetas: count('ul'), numerada: count('ol'), anidada: count('li ul'),
        'tarea hecha': count('.md-check[aria-checked="true"]'), 'tarea pendiente': count('.md-check[aria-checked="false"]'),
        separador: count('.md-rule'), 'títulos de tabla': count('table th'), 'celdas de tabla': count('table td'),
        enlace: count('.md-link[data-href]'), 'enlace que no se abre': count('.md-link.off'),
      },
      html: count('b, a[href]'),
      image: md.querySelector('.md-image')?.textContent ?? '',
      text: md.textContent,
    };
  })()`);
  for (const [what, n] of Object.entries(found.counts)) check(n > 0, `no se dibujó: ${what}`);
  equal(found.html, 0, 'el HTML se interpretó o hay enlaces que la vista podría seguir');
  check(found.text.includes('<b>Esto no es HTML</b>'), 'el HTML no se ve tal cual');
  check(found.image.includes('captura del cuaderno'), 'la imagen no muestra su texto alternativo');
  check(!/titulo:|etiquetas:|fuente:/.test(found.text), 'el encabezado YAML se ve crudo');
  check(!/\*\*|## |\[x\]|```/.test(found.text), 'quedaron marcas de markdown a la vista');

  const head = await page.evaluate(`({
    tags: [...document.querySelectorAll('.page-head .page-tag.tag')].map((e) => e.textContent),
    source: document.querySelector('.page-head .page-tag.source')?.textContent ?? null,
    category: document.querySelector('.page-head .chip')?.textContent ?? null,
    file: document.querySelector('.page-head .page-title')?.getAttribute('title') ?? null,
  })`);
  equal(head.tags.join(','), 'book,markdown,diseño', 'etiquetas del encabezado');
  equal(head.source, 'Claude Code', 'fuente del encabezado');
  equal(head.category, 'Proyectos', 'categoría pedida en el encabezado');
  equal(head.file, RICH_FILE, 'el nombre del archivo queda a mano en el título');
});

for (const textSize of ['small', 'medium', 'large', 'xlarge']) {
  for (const spread of ['double', 'single']) {
    test(`cada bloque ocupa renglones enteros, sin salirse de la hoja (${textSize}, ${spread})`, async (page) => {
      await open(page, { textSize, spread });
      for (const goto of [() => toRich(page), () => toLong(page)]) {
        await goto();
        const grid = await md(page, 'grid');
        equal(grid.line, LINE[textSize], 'alto del renglón');
        check(grid.blocks > 10, 'la hoja casi no tiene bloques');
        check(grid.bad.length === 0, `bloques fuera del rayado: ${grid.bad.slice(0, 6).join(' | ')}`);
      }
    });
  }
}

for (const [size, textSize, window] of [
  ['standard', 'medium', undefined],
  ['standard', 'xlarge', undefined],
  ['pocket', 'large', undefined],
  ['full', 'medium', { width: 1920, height: 1080 }],
]) {
  test(`una nota .md larga se pagina entera y sin cortes feos (${size}, ${textSize})`, async (page) => {
    await open(page, { size, textSize }, window);
    await toLong(page);
    const total = Number(/de (\d+)/.exec((await page.state()).page)?.[1]);
    check(total >= 2, `la nota larga tendría que ocupar varias páginas (${total})`);
    const layout = await md(page, 'pages');
    equal(layout.columns, total, 'las páginas contadas no son las que ocupa el texto');
    equal(layout.endColumn, total - 1, 'el final de la nota no está en la última página');
    check(layout.orphans.length === 0, `títulos solos al pie de una página: ${layout.orphans.join(', ')}`);
    equal(layout.splitCode, 0, 'un bloque de código corto quedó partido entre dos páginas');
    // Pasando página se llega hasta la última, que muestra el final.
    for (let turns = 0; turns < total && !(await page.state()).page?.startsWith(`${total} de`) && !(await page.state()).page?.startsWith(`${total - 1} de`); turns++) {
      await page.key('ArrowRight');
      await page.settle(200);
    }
    const last = await word(page, 'Fin de la bitácora');
    const leaves = await page.ask('box', '.leaves');
    check(last.x > leaves.left && last.x < leaves.right, 'el final de la nota no quedó a la vista en la última página');
  });
}

// ---- doble clic para escribir ---------------------------------------------------------

test('doble clic en un título, un ítem, un párrafo y otros bloques deja el cursor en su renglón del original', async (page) => {
  await open(page);
  await toRich(page);
  const text = await original(page);
  /** Posición del original justo después de `part`, buscando desde `from`. */
  const after = (from, part = from) => {
    const at = text.indexOf(from);
    check(at >= 0, `no está en el original: ${from}`);
    return at + from.indexOf(part) + part.length;
  };
  const targets = [
    ['sobre el título grande', () => word(page, 'cuaderno'), after('# Plan del cuaderno')],
    ['sobre un título', () => word(page, 'Pendientes'), after('## Pendientes')],
    ['sobre un ítem de tareas', () => word(page, 'Tablas'), after('- [ ] Tablas', 'Tablas')],
    ['sobre un ítem numerado', () => word(page, 'Abrir'), after('1. Abrir', 'Abrir')],
    ['sobre un ítem anidado', () => word(page, 'renglón'), after('el cursor va al renglón')],
    ['sobre una palabra en negrita', () => word(page, 'markdown'), after('**markdown', 'markdown')],
    ['sobre una palabra común', () => word(page, 'rayado'), after('el rayado')],
    ['sobre una cita', () => word(page, 'Bloc'), after('como en el Bloc')],
    ['sobre el código', () => word(page, 'console'), after('console')],
    ['sobre una celda de tabla', () => word(page, 'Párrafo'), after('| Párrafo')],
    [
      'a la derecha de un título corto',
      async () => {
        const box = await md(page, 'box', 'h2', 'Cómo se usa');
        return { x: box.left + box.width * 0.75, y: box.top + box.height / 2 };
      },
      after('## Cómo se usa'),
    ],
    [
      'en un renglón vacío',
      async () => {
        const line = text.slice(0, text.indexOf('## Pendientes')).split('\n').length - 2;
        const box = await page.evaluate(`window.__md.box('.md-blank[data-line="${line}"]')`);
        return middle(box);
      },
      text.indexOf('\n\n## Pendientes') + 1,
    ],
  ];
  for (const [where, locate, caret] of targets) {
    for (const gap of [80, 400]) {
      const what = `doble clic ${where} (${gap} ms)`;
      const target = await locate();
      await page.doubleClick(target.x, target.y, { gap });
      await page.until(async () => (await page.state()).writing, `${what}: no entró a escribir`, 1500);
      const state = await page.state();
      equal(state.title, RICH, `${what}: entró a escribir en otra hoja`);
      check(state.focusInEditor, `${what}: el cursor no quedó en el texto`);
      // Como en el texto plano, el cursor queda donde termina lo que eligió el doble clic: la
      // palabra y, en Windows, también el espacio que la sigue.
      const spot = `renglón «${text.slice(text.lastIndexOf('\n', state.caret - 1) + 1, state.caret)}|»`;
      check(state.caret === caret || (state.caret === caret + 1 && text[caret] === ' '), `${what}: lugar del cursor (${spot}, se esperaba ${caret})`);
      equal(state.text, text, `${what}: el texto cambió`);
      await page.key('Escape');
      await page.until(async () => !(await page.state()).writing, `${what}: Esc no terminó la escritura`);
      await page.until(async () => (await page.ask('count', '.flow-clip:not(.parked) .page-text.md')) > 0, `${what}: no volvió a verse con formato`);
      await page.settle(200);
    }
  }
});

test('doble clic en el papel, fuera del texto con formato, también entra a escribir', async (page) => {
  await open(page);
  await toRich(page);
  const text = await original(page);
  // Debajo de lo último escrito, en la hoja de la derecha: el final del original.
  const end = await word(page, 'como texto');
  const leaves = await page.ask('box', '.leaves');
  await page.doubleClick(end.x, Math.min(end.y + 200, leaves.bottom - 60));
  await page.until(async () => (await page.state()).writing, 'no entró a escribir');
  equal((await page.state()).caret, text.length, 'debajo del texto, el cursor va al final');
  await page.key('Escape');
  await page.until(async () => !(await page.state()).writing, 'Esc no terminó la escritura');
  await page.settle(250);
  // Un doble clic en una casilla o en un enlace es de ellos: no entra a escribir.
  for (const selector of ['.md-check', '.md-link[data-href]']) {
    const box = await md(page, 'box', selector);
    await page.doubleClick(box.left + box.width / 2, box.top + box.height / 2);
    await sleep(500);
    equal((await page.state()).writing, false, `un doble clic en ${selector} entró a escribir`);
    if (selector === '.md-check') {
      // Los dos clics marcaron y desmarcaron: la tarea queda como estaba, ya guardada.
      await page.settle(700);
    }
  }
});

// ---- enlaces, tareas y selección -----------------------------------------------------

test('los enlaces se abren afuera y la vista nunca navega', async (page) => {
  await open(page);
  await toRich(page);
  const href = await page.evaluate('location.href');
  const before = await page.state();

  await page.click((await word(page, 'CommonMark')).x, (await word(page, 'CommonMark')).y);
  await sleep(300);
  check((await opened(page)).includes('https://commonmark.org/help/'), 'el enlace no se pidió abrir afuera');
  await page.click((await word(page, 'markdownguide')).x, (await word(page, 'markdownguide')).y);
  await sleep(300);
  check((await opened(page)).includes('https://www.markdownguide.org'), 'la dirección entre <> no se pidió abrir');

  // Un enlace a un archivo no se abre.
  const count = (await opened(page)).length;
  await page.click((await word(page, 'copia local')).x, (await word(page, 'copia local')).y);
  await sleep(300);
  equal((await opened(page)).length, count, 'un enlace que no es web ni correo se pidió abrir');

  // Con el teclado: Enter sobre un enlace lo abre y no entra a escribir.
  await page.evaluate(`document.querySelector('.flow-clip:not(.parked) .md-link[data-href]').focus()`);
  await page.key('Enter');
  await sleep(300);
  equal((await opened(page)).length, count + 1, 'Enter sobre un enlace no lo abrió');

  const after = await page.state();
  equal(after.writing, false, 'abrir un enlace entró a escribir');
  equal(after.title, before.title, 'abrir un enlace cambió de hoja');
  equal(after.page, before.page, 'abrir un enlace pasó página');
  equal(await page.evaluate('location.href'), href, 'la vista navegó');
  equal(await page.evaluate(`performance.getEntriesByType('navigation').length`), 1, 'hubo otra navegación');
});

test('una tarea se marca y se desmarca con un clic, y queda guardada en el archivo', async (page) => {
  await open(page);
  await toRich(page);
  const pending = '- [ ] Tablas sobre el rayado';
  check((await original(page)).includes(pending), 'la tarea de prueba no está pendiente');
  for (const [checked, line] of [[true, '- [x] Tablas sobre el rayado'], [false, pending]]) {
    const box = await md(page, 'box', 'li', 'Tablas sobre el rayado');
    await page.click(box.left + 10, box.top + box.height / 2);
    await page.until(
      async () => (await page.evaluate(`[...document.querySelectorAll('.flow-clip:not(.parked) li')].find((li) => li.textContent.includes('Tablas sobre')).querySelector('.md-check').getAttribute('aria-checked')`)) === String(checked),
      `la casilla no quedó ${checked ? 'marcada' : 'desmarcada'}`,
    );
    await page.settle(800);
    const state = await page.state();
    equal(state.title, RICH, 'marcar una tarea sacó de la hoja');
    equal(state.sheet, 1, 'la hoja recién guardada pasa a ser la más reciente, y la vista la sigue');
    equal(state.writing, false, 'marcar una tarea entró a escribir');
    check((await original(page)).includes(line), `el archivo no quedó con «${line}»`);
  }
});

test('seleccionar arrastrando sobre la hoja con formato no pasa página ni entra a escribir', async (page) => {
  await open(page);
  await toRich(page);
  const before = await page.state();
  const from = await word(page, 'notas');
  const to = await word(page, 'Probar');
  await page.drag({ x: from.left + 2, y: from.y }, { x: to.right, y: to.y });
  await sleep(450);
  const after = await page.state();
  equal(after.title, before.title, 'seleccionar cambió de hoja');
  equal(after.page, before.page, 'seleccionar pasó página');
  equal(after.writing, false, 'seleccionar entró a escribir');
  check(after.selected.includes('markdown') && after.selected.includes('Tablas sobre el rayado'), `no quedó seleccionado lo arrastrado: «${after.selected}»`);
});

test('llevar la selección al borde pasa de página también en una .md', async (page) => {
  await open(page);
  await toLong(page);
  const before = await page.state();
  const from = await word(page, 'Semana 2');
  const leaves = await page.ask('box', '.leaves');
  await page.drag({ x: from.x, y: from.y }, { x: leaves.right - 6, y: leaves.top + leaves.height * 0.5 }, { hold: 800 });
  await sleep(300);
  const after = await page.state();
  equal(after.title, before.title, 'la selección dentro de una nota larga no cambia de hoja');
  check(after.page !== before.page, 'sostener la selección en el borde tenía que pasar de página');
  check(after.selected.length > 200, 'la selección tenía que seguir en la página siguiente');
});

test('las franjas de los bordes y deslizar siguen pasando página sobre una .md', async (page) => {
  await open(page);
  await toLong(page);
  const first = (await page.state()).page;
  const next = await page.ask('box', '.turn-zone.next');
  await page.click(middle(next).x, middle(next).y);
  await page.settle();
  const second = (await page.state()).page;
  check(second !== first, 'la franja derecha no pasó página');
  const prev = await page.ask('box', '.turn-zone.prev');
  await page.click(middle(prev).x, middle(prev).y);
  await page.settle();
  equal((await page.state()).page, first, 'la franja izquierda no volvió');
  // Deslizar desde el pie de la hoja (papel, no texto).
  const leaves = await page.ask('box', '.leaves');
  const from = { x: leaves.left + leaves.width * 0.4, y: leaves.bottom - 12 };
  check(!(await page.ask('at', from.x, from.y)).classes.includes('page-text'), 'el arrastre tiene que empezar fuera del texto');
  await page.drag(from, { x: from.x - 160, y: from.y });
  await page.settle(400);
  equal((await page.state()).page, second, 'deslizar a la izquierda no pasó página');
});

// ---- preferencias y ajustes -------------------------------------------------------------

test('con «Ver los .md con formato» apagado, la hoja se ve como texto plano', async (page) => {
  await open(page, { markdown: false });
  await toRich(page, RICH_FILE);
  equal(await page.ask('count', '.page-text.md'), 0, 'con el formato apagado se dibujó con formato');
  const { text } = await page.state();
  check(text.startsWith('---\ntitulo: Plan del cuaderno') && text.includes('## Pendientes'), 'el texto plano no es el original');

  // Desde Ajustes → Personalización se vuelve a prender, y se ve al instante.
  await pickFromMenu(page, 'Ajustes');
  await page.until(() => page.ask('count', '.modal [role="switch"][aria-label="Ver los .md con formato"]'), 'no está el interruptor en Personalización');
  equal(await page.evaluate(`document.querySelector('[aria-label="Ver los .md con formato"]').getAttribute('aria-checked')`), 'false', 'el interruptor no refleja la preferencia');
  await page.evaluate(`document.querySelector('[role="switch"][aria-label="Ver los .md con formato"]').scrollIntoView({ block: 'center' })`);
  await sleep(200);
  await page.clickOn('[role="switch"][aria-label="Ver los .md con formato"]');
  await page.until(() => page.ask('count', '.flow-clip:not(.parked) .page-text.md'), 'al prenderlo, la hoja no pasó a verse con formato');
  await page.key('Escape');
  await page.until(async () => !(await page.state()).dialog, 'Esc no cerró los ajustes');
  equal((await page.state()).title, RICH, 'con formato, el título es el del encabezado');
});

/** Botón de una fila de Ajustes → Integraciones. */
async function rowButton(page, tool, label) {
  const point = await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('.settings-body .row')].find((r) => r.querySelector('.row-text > span')?.textContent === ${JSON.stringify(tool)});
    const button = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!button) return null;
    const r = button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!point) throw new Error(`No está el botón «${label}» de ${tool}`);
  return point;
}

/** Espera a que la pregunta termine de irse: mientras se desvanece, su fondo todavía ataja los clics. */
const gone = (page) => page.until(async () => !(await page.ask('count', '[role="alertdialog"]')), 'la pregunta no se fue');

const rowStatus = (page, tool) =>
  page.evaluate(`[...document.querySelectorAll('.settings-body .row')].find((r) => r.querySelector('.row-text > span')?.textContent === ${JSON.stringify(tool)})?.querySelector('.integration-status')?.textContent ?? null`);

test('Ajustes → Integraciones: instalar, preguntar antes de tocar un archivo que existe, quitar y copiar', async (page) => {
  await open(page);
  await pickFromMenu(page, 'Ajustes');
  await page.until(() => page.ask('count', '.modal [role="tab"]'), 'no se abrieron los ajustes');
  const tabs = await page.ask('labels', '.modal [role="tab"]');
  equal(tabs[tabs.indexOf('Clasificador') + 1], 'Integraciones', 'la pestaña va después de «Clasificador»');
  // Con diez pestañas, la fila se desplaza: se trae la de Integraciones a la vista.
  await page.evaluate(`document.getElementById('settings-tab-integrations').scrollIntoView({ inline: 'center' })`);
  await sleep(200);
  await page.clickOn('.modal [role="tab"]', 'Integraciones');
  await page.until(async () => (await rowStatus(page, 'Gemini CLI')) !== null, 'no aparecieron las herramientas');
  check((await page.ask('label', '.settings-body')).includes('C:\\Users\\demo\\Documents\\Folio'), 'no se ve la carpeta de notas');

  // Claude Code: el archivo no existe, se instala sin preguntar.
  const install = await rowButton(page, 'Claude Code', 'Instalar');
  await page.click(install.x, install.y);
  await page.until(async () => (await rowStatus(page, 'Claude Code')) === 'Instalada', 'Claude Code no quedó instalada');
  equal(await page.ask('count', '[role="alertdialog"]'), 0, 'preguntó sin que hubiera un archivo para tocar');

  // Codex: su AGENTS.md ya existe, así que se pregunta diciendo cuál.
  const codex = await rowButton(page, 'Codex', 'Instalar');
  await page.click(codex.x, codex.y);
  await page.until(() => page.ask('count', '[role="alertdialog"]'), 'no preguntó antes de tocar AGENTS.md');
  check((await page.ask('label', '.confirm p')).includes('.codex\\AGENTS.md'), 'la pregunta no dice qué archivo se toca');
  await page.clickOn('.confirm button', 'Cancelar');
  await gone(page);
  equal(await rowStatus(page, 'Codex'), 'No instalada', 'Cancelar instaló igual');
  await page.click(codex.x, codex.y);
  await page.until(() => page.ask('count', '[role="alertdialog"]'), 'no volvió a preguntar');
  await page.clickOn('.confirm button', 'Instalar');
  await page.until(async () => (await rowStatus(page, 'Codex')) === 'Instalada', 'Codex no quedó instalada');
  await gone(page);

  // Quitar también pregunta, y deja la herramienta como estaba.
  const remove = await rowButton(page, 'Claude Code', 'Quitar');
  await page.click(remove.x, remove.y);
  await page.until(() => page.ask('count', '[role="alertdialog"]'), 'no preguntó antes de quitar');
  await page.clickOn('.confirm button', 'Quitar');
  await page.until(async () => (await rowStatus(page, 'Claude Code')) === 'No instalada', 'Claude Code no se quitó');
  await gone(page);

  // Copiar las instrucciones.
  const copy = await rowButton(page, 'Gemini CLI', 'Copiar');
  await page.click(copy.x, copy.y);
  await page.until(async () => (await rowButton(page, 'Gemini CLI', 'Copiadas').catch(() => null)) !== null, 'no avisó que copió');
  const text = await page.evaluate(`import('/src/api.ts').then(({ api }) => api.integrationText('gemini'))`);
  check(text.includes('<!-- folio:inicio') && text.includes('C:\\Users\\demo\\Documents\\Folio') && !text.includes('{{'), 'las instrucciones no tienen la carpeta de verdad');
});

// ---- correr --------------------------------------------------------------------------

const { page, close } = await launch({ width: 1280, height: 900 });
let failures = [];
try {
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${helpers.toString()})()` });
  failures = await run(page);
} finally {
  await close();
}
process.exit(failures.length ? 1 : 0);
