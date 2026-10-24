// Pruebas de punta a punta de la interacción del cuaderno: pasar página (franjas de los
// bordes, deslizar, teclado), entrar a escribir con doble clic y quedarse escribiendo,
// la pregunta de la papelera, los atajos para guardar y la vuelta desde la papelera y el
// secret-book. Corren sobre la interfaz con datos de muestra, en un Edge sin ventana.
//
// Uso (desde la carpeta del proyecto):
//   node tests/e2e/notebook.mjs             todas
//   node tests/e2e/notebook.mjs papelera    solo las que tienen "papelera" en el nombre
//
// Ver tests/e2e/README.md para los puertos y lo que hace falta tener instalado.

import { check, equal, launch, sleep, suite } from './harness.mjs';

const WINDOW = { pocket: { width: 1280, height: 900 }, standard: { width: 1280, height: 900 }, full: { width: 1920, height: 1080 } };
/** Hojas de los datos de muestra (src/mock.ts): una que se puede escribir y una larga. */
const WRITABLE = 'reunion-equipo.md';
const LONG = 'Apuntes del curso';
const FIRST = 'Pendientes de hoy';

const { test, run } = suite();

// Estas pruebas miden el lugar del cursor sobre el texto tal cual está escrito: la hoja de
// prueba es una .md, así que se la lee sin formato. Las de la hoja con formato están en
// markdown.mjs.
const open = (page, size, spread, prefs = {}) => page.open({ ...WINDOW[size], prefs: { size, spread, markdown: false, ...prefs } });
const middle = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
const isZone = (under) => /turn-zone/.test(under?.classes ?? '');

/** Pasa hojas con el teclado hasta llegar a la que tiene ese título. */
async function gotoSheet(page, title) {
  for (let turns = 0; turns < 60; turns++) {
    const state = await page.state();
    if (state.title === title && !state.busy) return state;
    await page.key('ArrowRight');
    await page.settle(220);
  }
  throw new Error(`No se llegó a la hoja «${title}»`);
}

/** Lugares de la hoja a la vista donde probar clics: sobre el texto y fuera de él. */
async function places(page) {
  const flow = await page.ask('box', '.flow-clip:not(.parked) .flow');
  const last = await page.ask('lastChar');
  const leaves = await page.ask('box', '.leaves');
  return { flow, last, leaves };
}

/** Lo que tiene que seguir igual cuando un gesto no debía pasar página ni cerrar nada. */
async function sameSpot(page, before, what) {
  const after = await page.state();
  equal(after.closed, false, `${what}: el cuaderno se cerró`);
  equal(after.sheet, before.sheet, `${what}: cambió de hoja`);
  equal(after.page, before.page, `${what}: cambió de página`);
  equal(after.title, before.title, `${what}: cambió el título`);
  return after;
}

/** Nunca queda una hoja escribiéndose sin verse: leyendo, las franjas de pasar página están. */
async function coherent(page, what) {
  const state = await page.state();
  if (state.writing) check(state.focusInEditor, `${what}: se está escribiendo pero el cursor no está en el texto`);
  else if (state.open && state.sheet) check((await page.ask('count', '.turn-zone')) > 0, `${what}: no se ve ningún editor, pero el cuaderno sigue en modo escritura`);
  return state;
}

async function pickFromMenu(page, label) {
  await page.clickOn('.page-actions .menu > button');
  await page.until(() => page.ask('count', '.page-actions .menu-list'), 'el menú de la hoja no se abrió');
  await sleep(160);
  await page.clickOn('.page-actions .menu-item', label);
}

/** Mueve una hoja a la papelera por dentro, sin pasar por el menú. */
const trashDirectly = (page, id) => page.evaluate(`import('/src/api.ts').then(({ api }) => api.setSheetHidden(${id}, true)).then(() => true)`);

// ---- un clic en la hoja no pasa página; las franjas de los bordes, sí --------------

for (const spread of ['double', 'single']) {
  test(`un clic en el centro de la hoja no pasa página ni cierra el cuaderno (${spread})`, async (page) => {
    await open(page, 'standard', spread);
    const { leaves } = await places(page);
    const before = await page.state();
    const spots = [[0.5, 0.5], [0.3, 0.62], [0.7, 0.62], [0.45, 0.86], [0.2, 0.9], [0.8, 0.5], [0.55, 0.42]];
    for (const [fx, fy] of spots) {
      const x = leaves.left + leaves.width * fx;
      const y = leaves.top + leaves.height * fy;
      const under = await page.ask('at', x, y);
      check(!isZone(under), `en ${fx},${fy} no tendría que haber una franja de pasar página`);
      check(!under.cursor.includes('url('), `en ${fx},${fy} se ve el cursor de flecha fuera de las franjas`);
      await page.click(x, y);
      await sleep(420);
      const after = await sameSpot(page, before, `clic en ${fx},${fy}`);
      equal(after.writing, false, `clic en ${fx},${fy}: entró a escribir con un solo clic`);
    }
    const word = await page.ask('word', 'Revisar');
    await page.click(word.x, word.y);
    await sleep(420);
    await sameSpot(page, before, 'clic sobre una palabra');
  });

  test(`cada franja pasa página en su sentido (${spread})`, async (page) => {
    await open(page, 'standard', spread);
    const next = await page.ask('box', '.turn-zone.next');
    const prev = await page.ask('box', '.turn-zone.prev');
    const { leaves, flow } = await places(page);
    check(next && prev, 'faltan las franjas de pasar página');
    check(next.width >= 48 && next.width <= 96, `la franja de avanzar mide ${next.width}px`);
    check(prev.width >= 40 && prev.width <= 96, `la franja de volver mide ${prev.width}px`);
    check(Math.abs(prev.left - leaves.left) < 1 && Math.abs(next.right - leaves.right) < 1, 'las franjas no están en los bordes de afuera');
    check(prev.right <= flow.left, 'la franja de volver tapa el principio de los renglones');

    // El cursor de flecha avisa, también donde hay texto debajo.
    const word = await page.ask('word', 'Revisar');
    for (const [zone, x] of [['next', next.left + 6], ['prev', prev.right - 6]]) {
      const under = await page.ask('at', x, word.y);
      check(under.classes.includes(`turn-zone ${zone}`) && under.cursor.includes('url('), `la franja ${zone} no muestra su flecha a la altura del texto`);
    }

    // Los botones del papel siguen siendo de ellos.
    for (const selector of ['.page-controls button', '.page-actions > button', '.page-actions .menu > button']) {
      for (const button of await page.ask('boxes', selector)) {
        const { x, y } = middle(button);
        const hit = await page.evaluate(`!!document.elementFromPoint(${x}, ${y})?.closest('button')`);
        check(hit, `una franja tapa un botón (${selector})`);
      }
    }

    await page.click(middle(next).x, middle(next).y);
    await page.settle();
    let state = await page.state();
    equal(state.sheet, 2, 'la franja derecha tenía que avanzar a la hoja 2');
    equal(state.title, LONG, 'hoja equivocada');
    const firstPage = state.page;

    await page.click(middle(next).x, middle(next).y);
    await page.settle();
    state = await page.state();
    equal(state.sheet, 2, 'dentro de una nota larga se avanza de página, no de hoja');
    check(state.page !== firstPage, `la página no avanzó (${state.page})`);

    await page.click(middle(prev).x, middle(prev).y);
    await page.settle();
    equal((await page.state()).page, firstPage, 'la franja izquierda tenía que volver a la primera página');

    await page.click(middle(prev).x, middle(prev).y);
    await page.settle();
    state = await page.state();
    equal(state.sheet, 1, 'la franja izquierda tenía que volver a la hoja 1');
    equal(state.title, FIRST, 'hoja equivocada al volver');
  });
}

test('en la primera hoja la franja de atrás cierra la tapa, y un clic en la tapa la abre', async (page) => {
  await open(page, 'standard', 'double');
  const prev = await page.ask('box', '.turn-zone.prev');
  await page.click(middle(prev).x, middle(prev).y);
  await page.until(async () => (await page.state()).closed, 'la tapa no se cerró');
  await page.settle();
  const cover = await page.ask('box', '.cover');
  await page.click(cover.left + cover.width / 2, cover.top + cover.height * 0.75);
  await page.until(async () => (await page.state()).open, 'la tapa no se abrió');
  await page.settle();
  equal((await page.state()).sheet, 1, 'al abrir tenía que estar la primera hoja');
});

test('las flechas del teclado siguen pasando página', async (page) => {
  await open(page, 'standard', 'double');
  await page.key('ArrowRight');
  await page.settle();
  equal((await page.state()).sheet, 2, 'flecha derecha');
  await page.key('ArrowLeft');
  await page.settle();
  equal((await page.state()).sheet, 1, 'flecha izquierda');
  await page.key('ArrowLeft');
  await page.until(async () => (await page.state()).closed, 'flecha izquierda en la primera hoja no cerró la tapa');
  await page.settle();
  await page.key('ArrowRight');
  await page.until(async () => (await page.state()).open, 'flecha derecha no abrió la tapa');
});

// ---- doble clic: entra a escribir y sigue escribiendo ------------------------------

for (const [size, spread] of [['standard', 'double'], ['standard', 'single'], ['full', 'double'], ['full', 'single']]) {
  test(`doble clic entra a escribir y sigue escribiendo en la misma hoja (${size}, ${spread})`, async (page) => {
    await open(page, size, spread);
    await gotoSheet(page, WRITABLE);
    const text = (await page.state()).text;
    const targets = {
      'sobre una palabra': async () => {
        const word = await page.ask('word', 'Asistentes');
        return { ...word, caret: word.end };
      },
      'a la derecha de un renglón corto': async () => {
        const word = await page.ask('word', 'Temas');
        const { flow } = await places(page);
        return { x: flow.left + flow.width * 0.6, y: word.y, caret: text.indexOf('## Temas') + '## Temas'.length };
      },
      'en un renglón vacío': async () => {
        const above = await page.ask('word', 'Reunión');
        const below = await page.ask('word', 'Asistentes');
        return { x: above.x, y: (above.y + below.y) / 2, caret: text.indexOf('\n\n') + 1 };
      },
      'sobre papel en blanco': async () => {
        const { flow, last } = await places(page);
        return { x: flow.left + flow.width * 0.5, y: last.bottom + 200, caret: text.length, paper: true };
      },
      'justo debajo del texto': async () => {
        const { last } = await places(page);
        return { x: last.left + 12, y: last.bottom + 22, caret: text.length, paper: true };
      },
      'sobre el título': async () => ({ ...(await page.ask('center', '.page-head .page-title')), caret: 0 }),
      'en el pie de la hoja': async () => {
        const { flow, leaves } = await places(page);
        return { x: flow.left + flow.width * 0.5, y: leaves.bottom - 12, caret: text.length, paper: true };
      },
    };
    for (const [where, locate] of Object.entries(targets)) {
      for (const gap of [80, 400]) {
        const what = `doble clic ${where}, ${gap} ms entre clics`;
        const before = await page.state();
        equal(before.title, WRITABLE, `${what}: no se arrancó en la hoja de prueba`);
        equal(before.writing, false, `${what}: ya se estaba escribiendo`);
        const target = await locate();
        const under = await page.ask('at', target.x, target.y);
        check(!isZone(under), `${what}: el punto elegido cae en una franja`);
        if (target.paper) check(!under.classes.includes('page-text'), `${what}: el punto elegido cae sobre el texto`);

        await page.doubleClick(target.x, target.y, { gap });
        await page.until(async () => (await page.state()).writing, `${what}: no entró a escribir`, 1500);
        const soon = await page.state();
        equal(soon.title, WRITABLE, `${what}: entró a escribir en otra hoja`);
        check(soon.focusInEditor, `${what}: el cursor no quedó en el texto`);
        equal(soon.caret, target.caret, `${what}: lugar del cursor`);

        await sleep(1000);
        const later = await page.state();
        check(later.writing, `${what}: un segundo después ya no se estaba escribiendo`);
        equal(later.title, WRITABLE, `${what}: un segundo después estaba en otra hoja`);
        equal(later.sheet, before.sheet, `${what}: un segundo después cambió el número de hoja`);
        check(later.focusInEditor, `${what}: un segundo después el cursor no estaba en el texto`);
        equal(later.caret, target.caret, `${what}: un segundo después el cursor se movió`);
        equal(later.text, text, `${what}: el texto cambió sin escribir nada`);

        await page.key('Escape');
        await page.until(async () => !(await page.state()).writing, `${what}: Esc no terminó la escritura`);
        await page.settle(120);
      }
    }
  });
}

test('doble clic en una hoja que no se puede escribir avisa por qué y no pasa página', async (page) => {
  await open(page, 'standard', 'double');
  const before = await page.state();
  const { flow, last } = await places(page);
  await page.doubleClick(flow.left + flow.width * 0.5, last.bottom + 160, { gap: 120 });
  await page.until(async () => (await page.state()).toast, 'no apareció el aviso');
  const after = await sameSpot(page, before, 'doble clic en una hoja del Bloc de notas');
  equal(after.writing, false, 'una pestaña del Bloc de notas no se escribe desde Book');
  check(/Bloc de notas/.test(after.toast), `el aviso no explica el motivo: ${after.toast}`);
});

test('doble clic en una franja pasa página y no entra a escribir', async (page) => {
  await open(page, 'standard', 'double');
  await gotoSheet(page, WRITABLE);
  const next = middle(await page.ask('box', '.turn-zone.next'));
  await page.doubleClick(next.x, next.y, { gap: 400 });
  await page.settle(400);
  const state = await coherent(page, 'doble clic en la franja');
  equal(state.writing, false, 'la franja no es para escribir');
  check(state.title !== WRITABLE, 'la franja tenía que pasar página');
});

test('pasar página y hacer doble clic enseguida no deja una hoja escribiéndose a escondidas', async (page) => {
  await open(page, 'full', 'double');
  for (const lead of [0, 40, 70]) {
    await gotoSheet(page, WRITABLE);
    const word = await page.ask('word', 'Asistentes');
    await page.move(word.x, word.y);
    await page.key('ArrowRight');
    if (lead) await sleep(lead);
    await page.doubleClick(word.x, word.y, { gap: 30 });
    await sleep(1100);
    const state = await coherent(page, `doble clic ${lead} ms después de pasar página`);
    if (state.writing) await page.key('Escape');
    await page.settle(200);
    await page.key('Home');
    await page.settle(300);
  }
});

test('Enter también entra a escribir, con el cursor al final', async (page) => {
  await open(page, 'standard', 'double');
  await gotoSheet(page, WRITABLE);
  const { text } = await page.state();
  await page.key('Enter');
  await page.until(async () => (await page.state()).writing, 'Enter no entró a escribir');
  equal((await page.state()).caret, text.length, 'lugar del cursor');
  await page.key('Escape');
  await page.until(async () => !(await page.state()).writing, 'Esc no terminó la escritura');
});

// ---- deslizar ------------------------------------------------------------------------

for (const spread of ['double', 'single']) {
  test(`deslizar sobre el papel pasa la hoja para ese lado (${spread})`, async (page) => {
    await open(page, 'standard', spread);
    await gotoSheet(page, WRITABLE);
    const { flow, last } = await places(page);
    const from = { x: flow.left + flow.width * 0.55, y: last.bottom + 180 };
    check(!(await page.ask('at', from.x, from.y)).classes.includes('page-text'), 'el arrastre tiene que empezar fuera del texto');

    // Corto o hacia arriba: no es un deslizamiento.
    for (const [dx, dy, what] of [[-34, 0, 'un arrastre corto'], [-30, -160, 'un arrastre vertical'], [90, 90, 'un arrastre en diagonal']]) {
      await page.drag(from, { x: from.x + dx, y: from.y + dy });
      await sleep(420);
      equal((await page.state()).title, WRITABLE, `${what} pasó página`);
    }

    // Mientras se arrastra, las hojas acompañan unos píxeles; si se vuelve, no pasa nada.
    await page.drag(from, { x: from.x - 140, y: from.y + 6 }, { release: false });
    const nudged = await page.evaluate(`getComputedStyle(document.querySelector('.flow-clip:not(.parked)')).translate`);
    check(/^-\d/.test(nudged), `las hojas no acompañan el arrastre (translate: ${nudged})`);
    await page.slide({ x: from.x - 8, y: from.y });
    await page.release();
    await sleep(520);
    equal((await page.state()).title, WRITABLE, 'volver al punto de partida antes de soltar no tenía que pasar página');
    equal(await page.evaluate(`document.querySelector('.leaves').dataset.swipe ?? null`), null, 'las hojas no volvieron a su lugar');

    // Hacia la izquierda: la siguiente. Hacia la derecha: la anterior.
    await page.drag(from, { x: from.x - 150, y: from.y + 8 });
    await page.settle(420);
    let state = await coherent(page, 'deslizar a la izquierda');
    equal(state.sheet, 4, 'deslizar a la izquierda tenía que pasar a la hoja siguiente');
    equal(state.selected, '', 'deslizar no tiene que seleccionar texto');
    equal(await page.evaluate(`getComputedStyle(document.querySelector('.flow-clip:not(.parked)')).translate`), 'none', 'la hoja nueva quedó corrida');

    const paper = await places(page);
    const back = { x: paper.flow.left + paper.flow.width * 0.4, y: paper.leaves.bottom - 90 };
    await page.drag(back, { x: back.x + 150, y: back.y - 5 });
    await page.settle(420);
    state = await coherent(page, 'deslizar a la derecha');
    equal(state.title, WRITABLE, 'deslizar a la derecha tenía que volver a la hoja anterior');

    // Escribiendo, arrastrar sobre el papel es cosa del cursor: no pasa página.
    await page.key('Enter');
    await page.until(async () => (await page.state()).writing, 'no entró a escribir');
    await page.drag(from, { x: from.x - 160, y: from.y });
    await sleep(420);
    state = await page.state();
    check(state.writing && state.title === WRITABLE, 'deslizar mientras se escribe pasó página o terminó la escritura');
    await page.key('Escape');
  });
}

test('con Mayús apretada (modo tamaño) deslizar no pasa página', async (page) => {
  await open(page, 'standard', 'double');
  await gotoSheet(page, WRITABLE);
  const { flow, last } = await places(page);
  const from = { x: flow.left + flow.width * 0.55, y: last.bottom + 180 };
  await page.keyDown('Shift', { shift: true });
  await sleep(320);
  check(await page.ask('count', '.app.sizing'), 'Mayús no entró al modo tamaño');
  await page.drag(from, { x: from.x - 160, y: from.y }, { mods: { shift: true } });
  await page.keyUp('Shift');
  await sleep(450);
  equal((await page.state()).title, WRITABLE, 'deslizar en modo tamaño pasó página');
});

test('seleccionar texto arrastrando no pasa página', async (page) => {
  await open(page, 'standard', 'double');
  await gotoSheet(page, WRITABLE);
  const before = await page.state();
  const from = await page.ask('word', 'Migración');
  const to = await page.ask('word', 'semanas');
  check(Math.abs(to.x - from.x) > 120, 'las dos palabras tienen que estar lejos para que el arrastre valga como prueba');
  await page.drag({ x: from.x - 20, y: from.y }, { x: to.x, y: to.y });
  await sleep(450);
  const after = await sameSpot(page, before, 'seleccionar arrastrando');
  check(after.selected.includes('gestor unificado'), `no quedó seleccionado el texto arrastrado: "${after.selected}"`);
  equal(after.writing, false, 'seleccionar no es escribir');
});

test('llevar la selección al borde sigue pasando de página para continuarla', async (page) => {
  await open(page, 'standard', 'double');
  await gotoSheet(page, LONG);
  const before = await page.state();
  const from = await page.ask('word', 'Unidad 2');
  const { leaves } = await places(page);
  await page.drag({ x: from.x, y: from.y }, { x: leaves.right - 6, y: leaves.top + leaves.height * 0.5 }, { hold: 800 });
  await sleep(300);
  const after = await page.state();
  equal(after.sheet, before.sheet, 'la selección dentro de una nota larga no cambia de hoja');
  check(after.page !== before.page, 'sostener la selección en el borde tenía que pasar de página');
  check(after.selected.length > 200, 'la selección tenía que seguir en la página siguiente');
});

// ---- escribir: atajos y vías que no tienen que cortar la escritura -----------------

test('Ctrl + Enter termina de escribir y guarda; Ctrl + S guarda y se sigue escribiendo', async (page) => {
  await open(page, 'standard', 'double');
  await gotoSheet(page, WRITABLE);
  const word = await page.ask('word', 'Asistentes');
  await page.doubleClick(word.x, word.y);
  await page.until(async () => (await page.state()).writing, 'no entró a escribir');
  check(/Ctrl \+ Enter/.test((await page.state()).mode), `el cartel no muestra el atajo: ${(await page.state()).mode}`);

  await page.type(' presentes');
  await page.key('s', { ctrl: true });
  await page.until(async () => (await page.ask('label', '.write-status')) === 'Guardado', 'Ctrl + S no guardó');
  let state = await page.state();
  check(state.writing && state.focusInEditor, 'Ctrl + S no tiene que terminar la escritura');

  await page.type(' y ausentes');
  await page.key('Enter', { ctrl: true });
  await page.until(async () => !(await page.state()).writing, 'Ctrl + Enter no terminó la escritura');
  await page.settle(700);
  state = await coherent(page, 'después de Ctrl + Enter');
  equal(state.title, WRITABLE, 'al terminar tenía que seguir a la vista la misma hoja');
  check(state.text.includes('Asistentes presentes y ausentes'), `lo escrito no quedó guardado: ${state.text.slice(0, 80)}`);
  equal(state.sheet, 1, 'la hoja recién guardada es la más reciente del cuaderno');
});

test('hoja nueva: Ctrl + Enter guarda y termina también con el foco en el título', async (page) => {
  await open(page, 'standard', 'double');
  await page.clickOn('.page-actions button[aria-label="Nueva hoja"]');
  await page.until(async () => (await page.state()).writing, 'la hoja nueva no quedó lista para escribir');
  let state = await page.state();
  check(state.mode.startsWith('Hoja nueva') && /Ctrl \+ Enter/.test(state.mode), `cartel de la hoja nueva: ${state.mode}`);
  check(state.focusInEditor, 'la hoja nueva no quedó con el cursor');
  await page.type('Comprar pilas');

  await page.clickOn('.page-head .page-title input');
  check(await page.evaluate(`document.activeElement?.matches('.page-title input')`), 'el foco no pasó al título');
  await page.key('s', { ctrl: true });
  await page.until(async () => (await page.ask('label', '.write-status')) === 'Guardado', 'Ctrl + S desde el título no guardó');
  check((await page.state()).writing, 'Ctrl + S desde el título no tiene que terminar la escritura');

  await page.key('Enter', { ctrl: true });
  await page.until(async () => !(await page.state()).writing, 'Ctrl + Enter desde el título no terminó la escritura');
  await page.settle(900);
  state = await coherent(page, 'después de guardar la hoja nueva');
  equal(state.text, 'Comprar pilas', 'el texto de la hoja nueva');
  equal(state.title, 'Comprar pilas.txt', 'título de la hoja nueva derivado de la primera línea');
  equal(state.sheet, 1, 'la hoja nueva es la primera del cuaderno');
});

test('botón de micrófono: inicia dictado por voz y no pierde el foco del editor', async (page) => {
  await open(page, 'standard', 'double');
  await gotoSheet(page, WRITABLE);
  const word = await page.ask('word', 'Asistentes');
  await page.doubleClick(word.x, word.y);
  await page.until(async () => (await page.state()).writing, 'no entró a escribir');

  equal(await page.ask('count', '.edit-banner .dict-btn'), 1, 'el cartel de edición no tiene el botón de dictado');
  const label = await page.evaluate("document.querySelector('.dict-btn')?.getAttribute('aria-label')");
  equal(label, 'Dictar con la voz (Win + H)', 'etiqueta del botón de dictado');

  const before = await page.evaluate("import('/src/mock.ts').then((m) => m.dictationCalls)");
  await page.clickOn('.dict-btn');
  await page.until(
    async () => (await page.evaluate("import('/src/mock.ts').then((m) => m.dictationCalls)")) === before + 1,
    'el botón de dictado no invocó startDictation',
  );

  const focused = await page.evaluate("document.activeElement?.matches('.sheet-editor') ?? false");
  check(focused, 'el clic en el botón de dictado sacó el foco de .sheet-editor');
  const state = await page.state();
  check(state.writing && state.focusInEditor, 'el estado no reporta foco en el editor');
});

test('escribiendo, ni la rueda ni Av Pág sacan de la hoja', async (page) => {
  await open(page, 'full', 'double');
  await gotoSheet(page, WRITABLE);
  const { flow, last } = await places(page);
  await page.doubleClick(flow.left + flow.width * 0.5, last.bottom + 200);
  await page.until(async () => (await page.state()).writing, 'no entró a escribir');
  for (const turn of [() => page.wheel(flow.left + 200, last.bottom + 200, 120), () => page.wheel(flow.left + 200, last.bottom + 200, -120), () => page.key('PageDown'), () => page.key('PageUp')]) {
    await turn();
    await sleep(450);
    const state = await page.state();
    check(state.writing && state.focusInEditor, 'la rueda o Av Pág terminaron la escritura');
    equal(state.title, WRITABLE, 'la rueda o Av Pág cambiaron de hoja mientras se escribía');
  }
  await page.key('Escape');
  await page.until(async () => !(await page.state()).writing, 'Esc no terminó la escritura');
  // Leyendo, la rueda sigue pasando de hoja.
  await page.settle(300);
  await page.wheel(flow.left + 200, last.bottom + 200, 120);
  await page.settle(400);
  check((await page.state()).title !== WRITABLE, 'leyendo, la rueda tenía que pasar de hoja');
});

// ---- papelera ------------------------------------------------------------------------

test('mover a la papelera pide confirmación: Cancelar, Enter y Esc no mueven nada', async (page) => {
  await open(page, 'standard', 'double');
  const before = await page.state();
  const total = await page.ask('label', '.page-foot-main');

  await pickFromMenu(page, 'Mover a la papelera');
  await page.until(async () => (await page.state()).dialog, 'no apareció la pregunta');
  equal((await page.state()).dialog, '¿Mover esta hoja a la papelera?', 'título de la pregunta');
  check(/recuperar/i.test(await page.ask('label', '.confirm p')), 'la pregunta no aclara que se puede recuperar');
  equal(await page.ask('focused'), 'Cancelar', 'el foco inicial tiene que estar en Cancelar');

  // Enter, con el foco donde arranca, no confirma.
  await page.key('Enter');
  await page.until(async () => !(await page.state()).dialog, 'Enter sobre Cancelar no cerró la pregunta');
  await sleep(500);
  await sameSpot(page, before, 'Enter en la pregunta');
  equal(await page.ask('label', '.page-foot-main'), total, 'Enter mandó la hoja a la papelera');

  await pickFromMenu(page, 'Mover a la papelera');
  await page.until(async () => (await page.state()).dialog, 'no apareció la pregunta');
  await page.key('Escape');
  await page.until(async () => !(await page.state()).dialog, 'Esc no cerró la pregunta');
  await sleep(500);
  await sameSpot(page, before, 'Esc en la pregunta');

  await pickFromMenu(page, 'Mover a la papelera');
  await page.until(async () => (await page.state()).dialog, 'no apareció la pregunta');
  await page.clickOn('.confirm button', 'Cancelar');
  await page.until(async () => !(await page.state()).dialog, 'Cancelar no cerró la pregunta');
  await sleep(500);
  await sameSpot(page, before, 'Cancelar');
  equal(await page.ask('label', '.page-foot-main'), total, 'Cancelar mandó la hoja a la papelera');

  // Con la pregunta abierta, las flechas no pasan página por detrás.
  await pickFromMenu(page, 'Mover a la papelera');
  await page.until(async () => (await page.state()).dialog, 'no apareció la pregunta');
  await page.key('ArrowRight');
  await sleep(350);
  await sameSpot(page, before, 'flecha con la pregunta abierta');

  // Confirmar sí la mueve.
  await page.clickOn('.confirm button', 'Mover a la papelera');
  await page.until(async () => (await page.state()).title !== before.title, 'confirmar no movió la hoja');
  await page.settle(400);
  const after = await coherent(page, 'después de mover a la papelera');
  equal(after.dialog, null, 'la pregunta quedó abierta');
  equal(after.title, LONG, 'tenía que quedar a la vista la hoja siguiente');
  equal(await page.ask('label', '.page-foot-main'), 'Hoja 1 de 17', 'el cuaderno tenía que quedar con una hoja menos');
});

for (const [size, spread] of [['standard', 'double'], ['pocket', 'single']]) {
  test(`de la papelera y del secret-book se vuelve con el botón y con Esc (${size}, ${spread})`, async (page) => {
    await open(page, size, spread);

    // Papelera vacía: el botón está en el estado vacío.
    await page.clickOn('.tab[aria-label="Ver Papelera"]');
    await page.until(async () => (await page.state()).empty === 'La papelera está vacía', 'no se vio la papelera vacía');
    await page.clickOn('.page-empty button', 'Volver al cuaderno');
    await page.until(async () => (await page.state()).tab === 'Ver Todas', 'el botón de la papelera vacía no volvió al cuaderno');
    await page.settle(300);

    // Papelera vacía, con Esc.
    await page.clickOn('.tab[aria-label="Ver Papelera"]');
    await page.until(async () => (await page.state()).empty === 'La papelera está vacía', 'no se vio la papelera vacía');
    await page.key('Escape');
    await page.until(async () => (await page.state()).tab === 'Ver Todas', 'Esc no volvió de la papelera vacía');
    await page.settle(300);

    // Con hojas: el cartel dice dónde se está en todas, y tiene la salida.
    await trashDirectly(page, 1);
    await trashDirectly(page, 2);
    await page.clickOn('.tab[aria-label="Ver Papelera"]');
    await page.until(async () => ((await page.state()).mode ?? '').includes('apelera'), 'no se vio el cartel de la papelera');
    await page.settle(300);
    check(await page.ask('count', '.page-mode.trash button[aria-label="Volver al cuaderno"]'), 'el cartel no tiene la salida');
    await page.key('ArrowRight');
    await page.settle(300);
    let state = await page.state();
    check((state.mode ?? '').includes('apelera'), 'al pasar de hoja se perdió el cartel de la papelera');
    check(await page.ask('count', '.page-mode.trash button[aria-label="Volver al cuaderno"]'), 'al pasar de hoja se perdió la salida');

    // Esc cierra primero el menú abierto; recién después vuelve al cuaderno.
    await page.clickOn('.page-actions .menu > button');
    await page.until(() => page.ask('count', '.page-actions .menu-list'), 'el menú no se abrió');
    await page.key('Escape');
    await page.until(async () => !(await page.ask('count', '.page-actions .menu-list')), 'Esc no cerró el menú');
    equal((await page.state()).tab, 'Ver Papelera', 'Esc cerró el menú y además salió de la papelera');
    await page.key('Escape');
    await page.until(async () => (await page.state()).tab === 'Ver Todas', 'Esc no volvió de la papelera');
    await page.settle(300);

    await page.clickOn('.tab[aria-label="Ver Papelera"]');
    await page.until(async () => ((await page.state()).mode ?? '').includes('apelera'), 'no se vio el cartel de la papelera');
    await page.settle(300);
    await page.clickOn('.page-mode.trash button[aria-label="Volver al cuaderno"]');
    await page.until(async () => (await page.state()).tab === 'Ver Todas', 'el botón del cartel no volvió de la papelera');
    await page.settle(300);

    // Secret-book.
    await page.clickOn('.tab[aria-label="Ver Secret-book"]');
    await page.until(async () => ((await page.state()).mode ?? '').startsWith('Secret-book'), 'no se vio el cartel del secret-book');
    await page.settle(300);
    await page.clickOn('.page-mode.secret button[aria-label="Volver al cuaderno"]');
    await page.until(async () => (await page.state()).tab === 'Ver Todas', 'el botón del cartel no volvió del secret-book');
    await page.settle(300);
    await page.clickOn('.tab[aria-label="Ver Secret-book"]');
    await page.until(async () => ((await page.state()).mode ?? '').startsWith('Secret-book'), 'no se vio el cartel del secret-book');
    await page.key('Escape');
    await page.until(async () => (await page.state()).tab === 'Ver Todas', 'Esc no volvió del secret-book');
    await page.until(async () => (await page.state()).mode === null, 'en el cuaderno de siempre no va ningún cartel');
    await coherent(page, 'de vuelta en el cuaderno');
  });
}

// ---- los carteles entran en todos los tamaños ----------------------------------------

test('los carteles de arriba no pisan los botones del papel, en ningún tamaño', async (page) => {
  const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
  // El dibujo de cada botón ocupa el centro: el borde transparente puede tocarse.
  const drawn = (b) => ({ left: b.left + 6, right: b.right - 6, top: b.top + 5, bottom: b.bottom - 5 });
  const clear = async (what) => {
    const cartel = await page.ask('box', '.page-mode');
    check(cartel, `${what}: no hay cartel`);
    const leaves = await page.ask('box', '.leaves');
    check(cartel.left >= leaves.left && cartel.right <= leaves.right, `${what}: el cartel se sale de las hojas`);
    for (const button of await page.ask('boxes', '.page-controls button, .page-actions > button, .page-actions .menu > button')) {
      check(apart(cartel, drawn(button)), `${what}: el cartel (${Math.round(cartel.left)}–${Math.round(cartel.right)}) pisa un botón (${Math.round(button.left)}–${Math.round(button.right)})`);
    }
  };
  for (const size of ['pocket', 'standard', 'full']) {
    for (const spread of ['double', 'single']) {
      const where = `${size}, ${spread}`;
      await open(page, size, spread);
      await gotoSheet(page, WRITABLE);
      await page.key('Enter');
      await page.until(async () => (await page.state()).writing, `${where}: no entró a escribir`);
      await sleep(260);
      await clear(`${where}, escribiendo`);
      await page.key('Escape');
      await page.until(async () => !(await page.state()).writing, `${where}: Esc no terminó la escritura`);

      await page.clickOn('.page-actions button[aria-label="Nueva hoja"]');
      await page.until(async () => ((await page.state()).mode ?? '').startsWith('Hoja nueva'), `${where}: no se abrió la hoja nueva`);
      await sleep(260);
      await clear(`${where}, hoja nueva`);
      await page.key('Escape');
      await page.settle(300);

      await trashDirectly(page, 1);
      await page.clickOn('.tab[aria-label="Ver Papelera"]');
      await page.until(async () => ((await page.state()).mode ?? '').includes('apelera'), `${where}: no se vio la papelera`);
      await page.settle(300);
      await clear(`${where}, papelera`);
      await page.clickOn('.tab[aria-label="Ver Secret-book"]');
      await page.until(async () => ((await page.state()).mode ?? '').startsWith('Secret-book'), `${where}: no se vio el secret-book`);
      await page.settle(300);
      await clear(`${where}, secret-book`);
    }
  }

  // En la vista mínima (390 px de ancho, 480 px de alto), el cartel tampoco debe pisar ningún botón.
  await page.open({ width: 390, height: 480, prefs: { size: 'custom', height: 480, spread: 'single', markdown: false } });
  await gotoSheet(page, WRITABLE);
  await page.key('Enter');
  await page.until(async () => (await page.state()).writing, 'mínimo: no entró a escribir');
  await sleep(260);
  await clear('mínimo, escribiendo');
  await page.key('Escape');
  await page.until(async () => !(await page.state()).writing, 'mínimo: Esc no terminó la escritura');

  await page.clickOn('.page-actions button[aria-label="Nueva hoja"]');
  await page.until(async () => (await page.state()).writing, 'mínimo: no se abrió la hoja nueva');
  await sleep(260);
  await clear('mínimo, hoja nueva');
  await page.key('Escape');
  await page.settle(300);
});

// ---- lo que no tiene que cortar la escritura ni mover la vista -----------------------

/** Cambia una hoja por dentro, como si el archivo se hubiera modificado fuera de Book. */
const changeOutside = (page, id, text) => page.evaluate(`import('/src/api.ts').then(({ api }) => api.saveSheet(${id}, ${JSON.stringify(text)})).then(() => true)`);
/** Id de la hoja `WRITABLE` en los datos de muestra. */
const WRITABLE_ID = 3;

test('el guardado automático no saca de la hoja que se está escribiendo ni mueve el cursor', async (page) => {
  await open(page, 'full', 'double');
  const start = await gotoSheet(page, WRITABLE);
  equal(start.sheet, 3, 'la prueba vale si la hoja no es la primera');
  const word = await page.ask('word', 'Asistentes');
  await page.doubleClick(word.x, word.y);
  await page.until(async () => (await page.state()).writing, 'no entró a escribir');

  // Se escribe en el medio del texto y se deja pasar el guardado automático, dos veces.
  for (const typed of [' uno', ' dos']) {
    await page.type(typed);
    await sleep(1800);
    const state = await page.state();
    equal(state.title, WRITABLE, `después de guardarse sola (${typed.trim()}), quedó a la vista otra hoja`);
    check(state.writing && state.focusInEditor, `después de guardarse sola (${typed.trim()}), se cortó la escritura`);
    equal(await page.ask('label', '.write-status'), 'Guardado', 'el guardado automático no terminó');
  }
  await page.type(' tres');
  let state = await page.state();
  check(state.text.includes('Asistentes uno dos tres: Lucía'), `lo tecleado no quedó donde estaba el cursor: ${state.text.slice(20, 70)}`);
  equal(state.sheet, 1, 'la hoja que se guarda pasa a ser la más reciente, y la vista la sigue');

  await page.key('Enter', { ctrl: true });
  await page.until(async () => !(await page.state()).writing, 'Ctrl + Enter no terminó la escritura');
  await page.settle(700);
  state = await coherent(page, 'después de terminar');
  equal(state.title, WRITABLE, 'al terminar tenía que seguir a la vista la misma hoja');
  check(state.text.includes('Asistentes uno dos tres: Lucía'), 'el texto completo no quedó guardado');
});

test('si entra una hoja nueva adelante, se sigue viendo la que se estaba leyendo', async (page) => {
  await open(page, 'standard', 'double');
  const before = await gotoSheet(page, 'comandos-git.txt');
  await page.evaluate(`import('/src/api.ts').then(({ api }) => api.createNote('recién llegada', 'Una nota nueva')).then(() => true)`);
  await sleep(700);
  const after = await coherent(page, 'después de que entró una hoja');
  equal(after.title, before.title, 'la vista se fue a otra hoja');
  equal(after.sheet, before.sheet + 1, 'la hoja que se lee quedó un lugar más atrás');
});

test('con un diálogo abierto, lo que pasa adentro no llega a las hojas', async (page) => {
  await open(page, 'standard', 'double');
  const before = await page.state();
  const poke = async (selector, what) => {
    const panel = await page.ask('box', selector);
    check(panel, `${what}: no está en pantalla`);
    const inside = { x: panel.left + panel.width * 0.25, y: panel.top + panel.height * 0.4 };
    await page.click(inside.x, inside.y);
    await page.wheel(inside.x, inside.y, 240);
    await sleep(120);
    await page.wheel(inside.x, inside.y, 240);
    await page.drag(inside, { x: inside.x + panel.width * 0.5, y: inside.y + 4 });
    await sleep(520);
    check((await page.state()).dialog, `${what}: se cerró solo`);
    await sameSpot(page, before, what);
  };

  await pickFromMenu(page, 'Mover a la papelera');
  await page.until(async () => (await page.state()).dialog, 'no apareció la pregunta');
  await sleep(260);
  await poke('.confirm', 'clic, rueda y arrastre dentro de la pregunta de la papelera');
  await page.clickOn('.confirm button', 'Cancelar');
  await page.until(async () => !(await page.state()).dialog, 'Cancelar no cerró la pregunta');
  await sleep(450);
  await sameSpot(page, before, 'Cancelar');

  await page.clickOn('.page-head .chip', 'versiones anteriores');
  await page.until(async () => ((await page.state()).dialog ?? '').startsWith('Versiones'), 'no se abrieron las versiones');
  await sleep(300);
  await poke('.versions-text', 'clic, rueda y arrastre dentro de las versiones');
  await page.key('Escape');
  await page.until(async () => !(await page.state()).dialog, 'Esc no cerró las versiones');
  await sleep(300);
  await sameSpot(page, before, 'después de cerrar las versiones');
});

test('mantener apretada una flecha pasa páginas, no deja la hoja en blanco', async (page) => {
  await open(page, 'standard', 'double');
  await page.keyDown('ArrowRight');
  let blank = 0;
  for (let repeat = 0; repeat < 36; repeat++) {
    await sleep(30);
    await page.keyDown('ArrowRight', {}, true);
    if (repeat > 8 && (await page.evaluate(`getComputedStyle(document.querySelector('.flow-clip:not(.parked)')).opacity === '0'`))) blank++;
  }
  const during = await page.state();
  await page.keyUp('ArrowRight');
  check(during.sheet >= 3, `con la flecha apretada más de un segundo solo se llegó a la hoja ${during.sheet}`);
  check(blank < 14, `la hoja estuvo en blanco casi todo el tiempo (${blank} de 27 miradas)`);
  await page.settle(400);
  await coherent(page, 'después de soltar la flecha');
  check(await page.evaluate(`getComputedStyle(document.querySelector('.flow-clip:not(.parked)')).opacity === '1'`), 'al soltar, la hoja quedó en blanco');
});

test('lo recién escrito no queda tapando la hoja si se pasó de página enseguida', async (page) => {
  await open(page, 'standard', 'double');
  await gotoSheet(page, WRITABLE);
  await page.key('Enter');
  await page.until(async () => (await page.state()).writing, 'no entró a escribir');
  await page.type(' fin');
  // Se termina y se pasa de hoja con el guardado todavía en vuelo.
  await page.key('Enter', { ctrl: true });
  await page.key('ArrowRight');
  await sleep(500);
  check((await page.state()).title !== WRITABLE, 'no se pasó de hoja');
  // Después el archivo cambia por fuera: lo recién escrito ya no es lo que hay guardado.
  await changeOutside(page, WRITABLE_ID, 'Cambiado por fuera');
  await sleep(4600);
  await page.key('Home');
  await page.settle(400);
  const state = await gotoSheet(page, WRITABLE);
  equal(state.text, 'Cambiado por fuera', 'la hoja sigue mostrando lo viejo');
  await page.key('Enter');
  await page.until(async () => (await page.state()).writing, 'la hoja quedó sin poder escribirse');
  await page.key('Escape');
});

test('si el archivo cambió afuera, quedarse con el de afuera no pierde lo escrito', async (page) => {
  await open(page, 'standard', 'double');
  await gotoSheet(page, WRITABLE);
  await page.key('Enter');
  await page.until(async () => (await page.state()).writing, 'no entró a escribir');
  await page.type(' LO MÍO');
  const mine = (await page.state()).text;
  await changeOutside(page, WRITABLE_ID, 'Texto de afuera');
  await page.key('s', { ctrl: true });
  await page.until(async () => ((await page.state()).mode ?? '').includes('cambió'), 'no apareció el aviso de que el archivo cambió afuera');
  check((await page.state()).writing, 'con el aviso a la vista todavía se está escribiendo');

  await page.clickOn('.page-mode.conflict button', 'afuera');
  await page.until(async () => !(await page.state()).writing, 'elegir el de afuera no terminó la escritura');
  await page.until(async () => /copia de Folio/.test((await page.state()).toast ?? ''), 'no avisó dónde quedó lo escrito');
  await page.settle(700);
  await page.key('Home');
  await page.settle(400);
  let state = await page.state();
  check(state.title.includes('(copia de Folio)'), `la copia no es la hoja más reciente: ${state.title}`);
  equal(state.text, mine, 'la copia no tiene lo que se había escrito');
  state = await gotoSheet(page, WRITABLE);
  equal(state.text, 'Texto de afuera', 'el original tenía que quedar con lo de afuera');
});

// ---- hoja suelta ---------------------------------------------------------------------

test('hoja suelta: Ctrl + Enter y Ctrl + S guardan, y descartar con texto pide un segundo clic', async (page) => {
  const fresh = async () => {
    await page.open({ width: 440, height: 572, query: '?window=capture' });
    // Los datos de muestra no dejan ver qué se guardó: se anota acá cada pedido.
    await page.evaluate(`import('/src/api.ts').then(({ api }) => { window.__saved = []; api.createNote = async (...args) => { window.__saved.push(args); return {}; }; return true; })`);
    await page.clickOn('.loose-text');
  };
  const saved = () => page.evaluate('window.__saved');

  await fresh();
  check(/Ctrl \+ Enter guarda y cierra/.test(await page.ask('label', '.loose-foot')), `el pie no muestra el atajo: ${await page.ask('label', '.loose-foot')}`);
  await page.type('Llamar al plomero');
  await page.key('Enter', { ctrl: true });
  await page.until(async () => (await saved()).length === 1, 'Ctrl + Enter no guardó la hoja suelta');
  equal((await saved())[0][1], 'Llamar al plomero', 'texto guardado con Ctrl + Enter');

  await fresh();
  await page.type('Otra nota');
  await page.key('s', { ctrl: true });
  await page.until(async () => (await saved()).length === 1, 'Ctrl + S no guardó la hoja suelta');

  // Descartar con algo escrito: el primer clic solo pregunta.
  await fresh();
  await page.type('Esto no lo quiero perder');
  await page.clickOn('.loose-actions button[aria-label="Descartar"]');
  await page.until(async () => /Descartar lo escrito/.test(await page.ask('label', '.loose-foot')), 'el primer clic en Descartar no pidió confirmación');
  check(await page.ask('count', '.loose-actions .armed'), 'el botón no quedó marcado esperando el segundo clic');
  // Esc se arrepiente del descarte y no cierra ni guarda.
  await page.key('Escape');
  await page.until(async () => /guarda y cierra/.test(await page.ask('label', '.loose-foot')), 'Esc no canceló el descarte');
  equal((await saved()).length, 0, 'Esc, al cancelar el descarte, guardó la hoja');
  // Seguir escribiendo también lo cancela.
  await page.clickOn('.loose-actions button[aria-label="Descartar"]');
  await page.until(async () => /Descartar lo escrito/.test(await page.ask('label', '.loose-foot')), 'no pidió confirmación');
  await page.clickOn('.loose-text');
  await page.type('.');
  await page.until(async () => /guarda y cierra/.test(await page.ask('label', '.loose-foot')), 'seguir escribiendo no canceló el descarte');
  // Dos clics seguidos descartan: no se guarda nada.
  await page.clickOn('.loose-actions button[aria-label="Descartar"]');
  await page.until(() => page.ask('count', '.loose-actions .armed'), 'no pidió confirmación');
  await page.clickOn('.loose-actions .armed');
  await sleep(300);
  equal((await saved()).length, 0, 'descartar guardó la hoja');

  // Sin texto no hay nada que confirmar.
  await fresh();
  await page.clickOn('.loose-actions button[aria-label="Descartar"]');
  await sleep(250);
  check(!(await page.ask('count', '.loose-actions .armed')), 'sin texto, Descartar no tiene que pedir confirmación');
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
