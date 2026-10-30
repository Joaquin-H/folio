// Pruebas de punta a punta de la tapa: la contratapa (llegar por el final y volver), dar
// vuelta el cuaderno, los estilos de tapa y las imágenes pegadas (pegar, acomodar, que
// persistan y acompañen el tamaño). Corren sobre la interfaz con datos de muestra, en un
// Edge sin ventana.
//
// Uso (desde la carpeta del proyecto):
//   node tests/e2e/cover.mjs              todas
//   node tests/e2e/cover.mjs contratapa   solo las que tienen "contratapa" en el nombre
//
// Ver tests/e2e/README.md para los puertos y lo que hace falta tener instalado.

import { check, equal, launch, sleep, suite } from './harness.mjs';

const WINDOW = { pocket: { width: 1280, height: 900 }, standard: { width: 1280, height: 900 }, full: { width: 1920, height: 1080 } };
/** Hojas de los datos de muestra (src/mock.ts): la más reciente y una larga, de varias páginas. */
const FIRST = 'Pendientes de hoy';
const LONG = 'Apuntes del curso';
const STYLES = ['plain', 'spots', 'strap', 'spine', 'leather'];

const { test, run } = suite();

const open = (page, size, spread, prefs = {}) => page.open({ ...WINDOW[size], prefs: { size, spread, ...prefs } });
const middle = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
const near = (a, b, slack = 1.5) => Math.abs(a - b) <= slack;

/** Deja en el cuaderno solo las dos primeras hojas: la última pasa a ser la larga. */
async function onlyTwoSheets(page) {
  await page.evaluate(
    `import('/src/api.ts').then(async ({ api }) => { for (let id = 3; id <= 19; id++) await api.setSheetHidden(id, true); return true; })`,
  );
  await page.until(async () => /de 2$/.test((await page.ask('label', '.page-foot-main')) ?? ''), 'el cuaderno no quedó con dos hojas');
  await page.settle();
}

/** Cara que se está viendo con el cuaderno cerrado, o `null` si está abierto o a medio girar. */
const face = (page) =>
  page.evaluate(`(() => {
    const book = document.querySelector('.book.closed');
    return book && !book.dataset.flip && !document.querySelector('.cover.leaving') ? (book.dataset.face ?? null) : null;
  })()`);

async function waitFace(page, wanted, what) {
  await page.until(async () => (await face(page)) === wanted, what);
  await sleep(320);
}

/** Cierra el cuaderno por adelante: desde la primera hoja, hacia atrás. */
async function closeFront(page) {
  await page.key('Home');
  await page.settle(200);
  await page.key('ArrowLeft');
  await waitFace(page, 'front', 'el cuaderno no se cerró mostrando la tapa');
}

async function waitOpen(page, what) {
  await page.until(async () => {
    const state = await page.state();
    return state.open && !state.busy && state.sheet !== null;
  }, what);
  await page.settle();
  return page.state();
}

/** Avanza con la flecha hasta la última página de la nota abierta y devuelve dónde quedó. */
async function toLastPage(page) {
  for (let turns = 0; turns < 40; turns++) {
    const state = await page.state();
    const pages = /^(\d+) de (\d+)$/.exec(state.page ?? '');
    const shown = await page.ask('count', '.page');
    if (!pages || Number(pages[1]) + shown > Number(pages[2])) return state;
    await page.key('ArrowRight');
    await page.settle(220);
  }
  throw new Error('No se llegó a la última página');
}

async function pickFromCoverMenu(page, label) {
  await page.clickOn('.cover .menu > button');
  await page.until(() => page.ask('count', '.cover .menu-list'), 'el menú de la tapa no se abrió');
  await sleep(160);
  await page.clickOn('.cover .menu-item', label);
}

/** Tecla que el arnés no trae definida (Supr). */
async function press(page, key, code, vk) {
  const common = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

// ---- imágenes: ayudas ------------------------------------------------------------------

const stored = (page) => page.evaluate(`JSON.parse(localStorage.getItem('book.stickers') ?? '[]')`);
const clearStickers = (page) => page.evaluate(`import('/src/components/stickers.ts').then((stickers) => (stickers.clearStickers(), true))`);

/**
 * Arma un archivo dentro de la página (un PNG con transparencia, o uno de texto) y se lo da
 * a la tapa como lo haría una persona: por el selector de archivos, pegándolo o soltándolo.
 */
function give(page, how, { type = 'image/png', name = 'calco.png', at = null, width = 300, height = 180 } = {}) {
  return page.evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = ${width};
    canvas.height = ${height};
    const paint = canvas.getContext('2d');
    paint.fillStyle = '#e4572e';
    paint.beginPath();
    paint.ellipse(${width / 2}, ${height / 2}, ${width / 2 - 8}, ${height / 2 - 8}, 0, 0, Math.PI * 2);
    paint.fill();
    const type = ${JSON.stringify(type)};
    const blob = type.startsWith('image/') ? await new Promise((done) => canvas.toBlob(done, type)) : new Blob(['no soy una imagen'], { type });
    const data = new DataTransfer();
    data.items.add(new File([blob], ${JSON.stringify(name)}, { type }));
    const how = ${JSON.stringify(how)};
    const at = ${JSON.stringify(at)};
    if (how === 'input') {
      const input = document.querySelector('.cover input[type=file]');
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (how === 'paste') {
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    } else {
      const cover = document.querySelector('.cover');
      for (const kind of ['dragover', 'drop']) {
        cover.dispatchEvent(new DragEvent(kind, { dataTransfer: data, bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
      }
    }
    return true;
  })()`);
}

/** Espera a que haya `count` imágenes a la vista en la cara que se está mirando. */
const waitStickers = (page, count, what) => page.until(async () => (await page.ask('count', '.cover .sticker')) === count, what);

/** Dónde está una imagen respecto de la tapa: centro y ancho como fracción de ella, y giro. */
const spot = (page, selector = '.cover .sticker') =>
  page.evaluate(`(() => {
    const image = document.querySelector(${JSON.stringify(selector)});
    const cover = document.querySelector('.cover').getBoundingClientRect();
    if (!image) return null;
    return {
      x: parseFloat(image.style.left) / 100,
      y: parseFloat(image.style.top) / 100,
      width: image.offsetWidth / cover.width,
      height: image.offsetHeight / cover.height,
      turn: parseFloat(image.style.rotate || '0'),
      left: cover.left + (parseFloat(image.style.left) / 100) * cover.width,
      top: cover.top + (parseFloat(image.style.top) / 100) * cover.height,
      pixels: image.offsetWidth,
    };
  })()`);

async function pasteOne(page, options) {
  const before = await page.ask('count', '.cover .sticker');
  await give(page, 'input', options);
  await waitStickers(page, before + 1, 'la imagen no apareció en la tapa');
  await page.until(() => page.ask('count', '.cover.arranging .sticker-box.selected'), 'al pegar una imagen no se entró a acomodarla');
  await sleep(250);
}

// ---- contratapa ------------------------------------------------------------------------

for (const spread of ['double', 'single']) {
  test(`contratapa: después de la última página se cierra por atrás y se vuelve a ella (${spread})`, async (page) => {
    await open(page, 'standard', spread);
    await onlyTwoSheets(page);
    await page.key('ArrowRight');
    await page.settle();
    equal((await page.state()).title, LONG, 'la segunda hoja tenía que ser la larga');
    const last = await toLastPage(page);
    check(last.page && !/^1 de/.test(last.page), `la nota larga tenía que tener varias páginas (${last.page})`);

    // La franja de avanzar sigue estando en la última página; la rueda no cierra el cuaderno.
    const zone = await page.ask('box', '.turn-zone.next');
    check(zone, 'en la última página falta la franja de avanzar');
    const leaves = await page.ask('box', '.leaves');
    for (let turns = 0; turns < 3; turns++) {
      await page.wheel(leaves.left + leaves.width / 2, leaves.top + leaves.height / 2, 240);
      await sleep(320);
    }
    const still = await page.state();
    equal(still.closed, false, 'la rueda cerró el cuaderno por el final');
    equal(still.page, last.page, 'la rueda movió la página estando en la última');

    // La franja lo cierra mostrando la contratapa.
    await page.click(middle(zone).x, middle(zone).y);
    await waitFace(page, 'back', 'la franja de avanzar, en la última página, no llevó a la contratapa');
    check(await page.ask('count', '.cover.back'), 'cerrado por el final no se ve la contratapa');
    equal(await page.ask('count', '.cover .cover-label'), 0, 'la contratapa no lleva etiqueta');
    check(/Hecho por J\./.test(await page.ask('label', '.cover-imprint')), 'falta el pie de imprenta de la contratapa');
    check(await page.ask('count', '.cover.back .cover-controls .menu > button'), 'la contratapa no tiene menú');
    check(await page.ask('count', '.cover.back .cover-close'), 'la contratapa no tiene la cruz de cerrar la ventana');
    if (spread === 'single') {
      const spiral = await page.ask('box', '.spiral');
      const book = await page.ask('box', '.book');
      check(spiral.left > book.left + book.width / 2, 'vista de atrás, la espiral tiene que quedar a la derecha');
    }

    // Desde la contratapa, una flecha abre el cuaderno en la última hoja donde estaba.
    await page.key('ArrowLeft');
    let state = await waitOpen(page, 'la flecha izquierda no abrió el cuaderno desde la contratapa');
    equal(state.title, LONG, 'desde la contratapa se abre en la última hoja');
    equal(state.page, last.page, 'desde la contratapa se abre en la última página');

    // Deslizando también se llega, y con un clic en la contratapa se vuelve.
    const paper = await page.ask('box', '.leaves');
    const from = { x: paper.left + paper.width * 0.45, y: paper.bottom - 14 };
    check(!(await page.ask('at', from.x, from.y)).classes.includes('page-text'), 'el arrastre tiene que empezar fuera del texto');
    await page.drag(from, { x: from.x - 170, y: from.y });
    await waitFace(page, 'back', 'deslizar en la última página no llevó a la contratapa');
    const cover = await page.ask('box', '.cover');
    await page.click(cover.left + cover.width / 2, cover.top + cover.height * 0.6);
    state = await waitOpen(page, 'un clic en la contratapa no abrió el cuaderno');
    equal(state.title, LONG, 'un clic en la contratapa abre la última hoja');
    equal(state.page, last.page, 'un clic en la contratapa abre la última página');
  });
}

test('contratapa: la flecha derecha en la última hoja cierra por atrás', async (page) => {
  await open(page, 'standard', 'double');
  await page.key('End');
  await page.until(async () => (await page.state()).sheet === 18, 'Fin no llevó a la última hoja');
  await page.settle();
  await toLastPage(page);
  await page.key('ArrowRight');
  await waitFace(page, 'back', 'la flecha derecha, en la última página de la última hoja, no llevó a la contratapa');
  // Y con la tapa a la vista, se da vuelta y se abre.
  await page.key('v');
  await waitFace(page, 'front', 'V no dio vuelta el cuaderno');
  // Después de darlo vuelta, la tapa se abre por la primera hoja.
  await page.key('ArrowRight');
  const state = await waitOpen(page, 'la flecha derecha no abrió el cuaderno desde la tapa');
  equal(state.sheet, 1, 'dado vuelta desde la contratapa, la tapa abre la primera hoja');
  equal(state.title, FIRST, 'hoja equivocada');
});

// ---- dar vuelta ------------------------------------------------------------------------

test('dar vuelta: desde el menú de la tapa y de la contratapa, con giro', async (page) => {
  await open(page, 'standard', 'double');
  await onlyTwoSheets(page);
  await closeFront(page);
  check(await page.ask('count', '.cover.front .cover-label'), 'la tapa perdió su etiqueta');

  await pickFromCoverMenu(page, 'Dar vuelta el cuaderno');
  await page.until(() => page.ask('count', '.book[data-flip]'), 'dar vuelta no tuvo transición de giro', 2000);
  await waitFace(page, 'back', 'el menú de la tapa no dio vuelta el cuaderno');
  // La ventana no cambia de tamaño al darlo vuelta: es la misma tapa.
  const back = await page.ask('box', '.book');

  // Dado vuelta, se abre por la otra punta: la última página de la última hoja.
  const cover = await page.ask('box', '.cover');
  await page.click(cover.left + cover.width / 2, cover.top + cover.height * 0.5);
  let state = await waitOpen(page, 'un clic en la contratapa no abrió el cuaderno');
  equal(state.title, LONG, 'dado vuelta desde la tapa, la contratapa abre la última hoja');
  const pages = /^(\d+) de (\d+)$/.exec(state.page ?? '');
  check(pages && Number(pages[1]) + 2 > Number(pages[2]), `tenía que abrir en la última página y abrió en ${state.page}`);

  // Cerrado con el botón queda la tapa; si se lo da vuelta dos veces, abre donde estaba.
  await page.clickOn('.page-controls button[aria-label="Cerrar el cuaderno"]');
  await waitFace(page, 'front', 'el botón de cerrar el cuaderno no dejó la tapa a la vista');
  const front = await page.ask('box', '.book');
  check(near(front.width, back.width) && near(front.height, back.height), 'la tapa y la contratapa no miden lo mismo');
  await page.key('v');
  await waitFace(page, 'back', 'V no dio vuelta el cuaderno');
  await pickFromCoverMenu(page, 'Dar vuelta el cuaderno');
  await waitFace(page, 'front', 'el menú de la contratapa no dio vuelta el cuaderno');
  await page.key('ArrowRight');
  state = await waitOpen(page, 'la tapa no se abrió');
  equal(state.title, LONG, 'sin cambiar de cara, el cuaderno se abre donde se había cerrado');
});

test('dar vuelta: la tecla no vale mientras se escribe el nombre ni con un diálogo abierto', async (page) => {
  await open(page, 'standard', 'double');
  await closeFront(page);
  await page.clickOn('.cover-name');
  await sleep(120);
  await page.key('v');
  await sleep(500);
  equal(await face(page), 'front', 'V dio vuelta el cuaderno mientras se escribía su nombre');
  check(/v/.test(await page.evaluate(`document.querySelector('.cover-name').value`)), 'la V no se escribió en el nombre');
  await page.key('Enter');
  await sleep(120);

  await pickFromCoverMenu(page, 'Ajustes');
  await page.until(async () => (await page.state()).dialog === 'Ajustes', 'no se abrieron los ajustes');
  await page.key('v');
  await sleep(500);
  equal(await face(page), 'front', 'V dio vuelta el cuaderno con los ajustes abiertos');
});

// ---- estilos ---------------------------------------------------------------------------

/** Rectángulo de lo que dibuja un pseudo-elemento de la tapa (el lomo, la tira), ya puesto en su lado. */
const drawn = (page, layer, pseudo) =>
  page.evaluate(`(() => {
    const host = document.querySelector('.cover > ${layer}');
    const style = getComputedStyle(host, '${pseudo}');
    if (style.content === 'none') return null;
    const cover = host.getBoundingClientRect();
    const width = parseFloat(style.width);
    const mirrored = getComputedStyle(host).transform !== 'none';
    // De un elemento posicionado, el estilo calculado ya da la izquierda en píxeles.
    const left = parseFloat(style.left);
    const from = mirrored ? cover.width - left - width : left;
    return { left: cover.left + from, right: cover.left + from + width, width, mask: (style.maskImage || style.webkitMaskImage) !== 'none' };
  })()`);

for (const style of STYLES) {
  test(`estilo ${style}: se aplica en la tapa y en la contratapa, y deja leer lo que va encima`, async (page) => {
    for (const [size, cover, theme] of [
      ['pocket', '#141416', 'light'],
      ['standard', '#B59A76', 'dark'],
    ]) {
      await open(page, size, 'double', { cover, coverStyle: style, theme });
      await closeFront(page);
      equal(await page.evaluate(`document.querySelector('.cover').dataset.coverStyle`), style, 'la tapa no tiene el estilo elegido');

      const marks = { spots: await drawn(page, '.cover-skin', '::before'), tape: await drawn(page, '.cover-skin', '::after'), band: await drawn(page, '.cover-over', '::after') };
      if (style === 'plain') check(!marks.spots && !marks.tape && !marks.band, 'la tapa lisa no tiene que dibujar nada más que el color');
      if (style === 'spots') check(marks.spots?.mask && marks.tape?.width > 20, 'faltan las manchas o la cinta del lomo');
      if (style === 'strap') check(marks.band?.width > 12, 'falta la tira elástica');
      if (style === 'spine') check(marks.tape?.width > 30, 'falta la cinta del lomo');
      if (style === 'leather') check(marks.spots?.mask && marks.band?.mask, 'faltan el grano del cuero o la costura');

      // La etiqueta no pisa el lomo ni la tira, y cada botón recibe su clic.
      const coverBox = await page.ask('box', '.cover');
      const label = await page.ask('box', '.cover-label');
      if (style === 'spots' || style === 'spine') check(label.left > marks.tape.right + 4, 'la etiqueta pisa la cinta del lomo');
      if (style === 'strap') {
        check(marks.band.left > coverBox.left + coverBox.width / 2, 'en la tapa, la tira va del lado de afuera (a la derecha)');
        check(label.right < marks.band.left - 4, 'la etiqueta pisa la tira');
        const cross = await page.ask('box', '.cover-close');
        check(cross.left > marks.band.right, 'la cruz quedó sobre la tira');
      }
      for (const selector of ['.cover-close', '.cover-actions > button', '.cover-actions .menu > button']) {
        const { x, y } = middle(await page.ask('box', selector));
        check(await page.evaluate(`!!document.elementFromPoint(${x}, ${y})?.closest('button')`), `algo tapa un botón de la tapa (${selector})`);
      }
      const brand = await page.ask('box', '.cover-brand');
      check(brand.right <= coverBox.right - 8 && brand.bottom <= coverBox.bottom - 8, 'la marca se sale de la tapa');
      if (style === 'strap') check(brand.right < marks.band.left, 'la marca quedó sobre la tira');
      // La tinta se despega del color: clara sobre la tapa negra, oscura sobre la kraft.
      const ink = await page.evaluate(`getComputedStyle(document.querySelector('.cover-close')).color`);
      const lightness = Number(/oklch\(([\d.]+)/.exec(ink)?.[1] ?? (/rgba?\((\d+)/.exec(ink)?.[1] ?? 0) / 255);
      check(cover === '#141416' ? lightness > 0.7 : lightness < 0.4, `la tinta de la tapa no contrasta con ${cover}: ${ink}`);

      await page.key('v');
      await waitFace(page, 'back', 'V no dio vuelta el cuaderno');
      equal(await page.evaluate(`document.querySelector('.cover').dataset.coverStyle`), style, 'la contratapa no tiene el estilo de la tapa');
      const behind = { tape: await drawn(page, '.cover-skin', '::after'), band: await drawn(page, '.cover-over', '::after') };
      const controls = await page.ask('box', '.cover-controls');
      if (style === 'spots' || style === 'spine') {
        check(behind.tape.left > coverBox.left + coverBox.width / 2, 'en la contratapa el lomo va a la derecha');
        check(controls.right < behind.tape.left, 'los botones de la contratapa quedaron sobre el lomo');
      }
      if (style === 'strap') check(behind.band.right < coverBox.left + coverBox.width / 2, 'en la contratapa la tira va a la izquierda');
      for (const selector of ['.cover-close', '.cover-controls .menu > button']) {
        const { x, y } = middle(await page.ask('box', selector));
        check(await page.evaluate(`!!document.elementFromPoint(${x}, ${y})?.closest('button')`), `algo tapa un botón de la contratapa (${selector})`);
      }
      const imprint = await page.ask('box', '.cover-imprint');
      check(imprint.left >= coverBox.left + 8 && imprint.right <= coverBox.right - 8 && imprint.bottom <= coverBox.bottom - 8, 'el pie de imprenta se sale de la contratapa');
      if (style === 'strap') check(imprint.left > behind.band.right, 'el pie de imprenta quedó sobre la tira');
    }
  });
}

test('estilos: se eligen en Ajustes, con una miniatura de cada uno', async (page) => {
  await open(page, 'full', 'double', { cover: '#6E2433' });
  await page.clickOn('.page-actions .menu > button');
  await page.until(() => page.ask('count', '.page-actions .menu-list'), 'el menú de la hoja no se abrió');
  await sleep(160);
  await page.clickOn('.page-actions .menu-item', 'Ajustes');
  await page.until(() => page.ask('count', '.cover-thumb'), 'en Ajustes no están los estilos de tapa');
  await sleep(300);
  equal(await page.ask('count', '.cover-thumb'), STYLES.length, 'tiene que haber una miniatura por estilo');
  equal(await page.evaluate(`document.querySelector('.cover-thumb[aria-checked="true"]').dataset.coverStyle`), 'plain', 'de fábrica, la tapa es lisa');
  // Las miniaturas van con el color elegido para la tapa.
  equal(await page.evaluate(`getComputedStyle(document.querySelector('.cover-thumb')).backgroundColor`), 'rgb(110, 36, 51)', 'las miniaturas no usan el color de la tapa');

  for (const style of ['strap', 'spots']) {
    await page.clickOn(`.cover-thumb[data-cover-style="${style}"]`);
    await page.until(
      () => page.evaluate(`document.querySelector('.cover-thumb[aria-checked="true"]')?.dataset.coverStyle === '${style}'`),
      `no quedó elegido el estilo ${style}`,
    );
    equal(await page.evaluate(`JSON.parse(localStorage.getItem('book.prefs')).coverStyle`), style, 'el estilo no se guardó');
  }
  await page.key('Escape');
  await page.until(async () => (await page.state()).dialog === null, 'los ajustes no se cerraron');
  await sleep(250);
  await closeFront(page);
  equal(await page.evaluate(`document.querySelector('.cover').dataset.coverStyle`), 'spots', 'la tapa no tomó el estilo elegido en Ajustes');
});

// ---- imágenes pegadas ------------------------------------------------------------------

test('imágenes: pegar una desde el menú, acomodarla (mover, agrandar, girar) y quitarla', async (page) => {
  await open(page, 'standard', 'double');
  await clearStickers(page);
  await closeFront(page);
  check(!(await page.ask('labels', '.cover .menu-item')).length, 'el menú no tenía que estar abierto');

  // El menú ofrece pegar; acomodar, recién cuando hay algo que acomodar.
  await page.clickOn('.cover .menu > button');
  await page.until(() => page.ask('count', '.cover .menu-list'), 'el menú de la tapa no se abrió');
  let items = (await page.ask('labels', '.cover .menu-item')).join(' | ');
  check(/Pegar una imagen/.test(items) && /Dar vuelta el cuaderno/.test(items), `faltan opciones en el menú de la tapa: ${items}`);
  check(!/Acomodar las imágenes/.test(items), 'sin imágenes no hay nada que acomodar');
  await page.key('Escape');
  await sleep(200);

  await pasteOne(page);
  check(/Acomodando/.test(await page.ask('label', '.cover-mode')), 'falta el cartel del modo acomodar');
  const start = await spot(page);
  check(start.x > 0.3 && start.x < 0.7 && start.width > 0.2 && start.width < 0.5, `la imagen cayó en un lugar raro: ${JSON.stringify(start)}`);
  check(near(start.height / start.width, (180 / 300) * 0.76, 0.01), 'la imagen perdió su proporción');
  equal(start.turn, 0, 'la imagen recién pegada va derecha');
  equal(await page.evaluate(`getComputedStyle(document.querySelector('.cover .sticker')).pointerEvents`), 'none', 'las imágenes tienen que ser inertes');

  // Mover: arrastrando la imagen.
  await page.drag({ x: start.left, y: start.top }, { x: start.left + 70, y: start.top - 90 });
  await sleep(200);
  const moved = await spot(page);
  check(near(moved.left, start.left + 70, 2) && near(moved.top, start.top - 90, 2), `la imagen no siguió al mouse: ${JSON.stringify(moved)}`);
  check(near(moved.pixels, start.pixels, 1), 'mover la imagen le cambió el tamaño');
  let saved = (await stored(page))[0];
  check(near(saved.x, moved.x, 0.002) && near(saved.y, moved.y, 0.002) && saved.face === 'front', `lo movido no se guardó: ${JSON.stringify(saved)}`);
  equal(await face(page), 'front', 'arrastrar una imagen no tiene que abrir el cuaderno');

  // Agrandar: desde una esquina, en proporción.
  const corner = middle(await page.ask('box', '.sticker-handle.se'));
  await page.drag(corner, { x: corner.x + 45, y: corner.y + 27 });
  await sleep(200);
  const grown = await spot(page);
  check(grown.pixels > moved.pixels * 1.2, `la imagen no creció: ${moved.pixels} → ${grown.pixels}`);
  check(near(grown.height / grown.width, moved.height / moved.width, 0.01), 'al agrandarla perdió su proporción');
  check(near(grown.x, moved.x, 0.002) && near(grown.y, moved.y, 0.002), 'al agrandarla se corrió de lugar');

  // Girar: con la rueda sobre la imagen (de a 5°) y con la manija.
  await page.wheel(grown.left, grown.top, 120);
  await sleep(200);
  equal((await spot(page)).turn, 5, 'la rueda sobre la imagen la gira 5 grados');
  await page.wheel(grown.left, grown.top, -120);
  await page.wheel(grown.left, grown.top, -120);
  await sleep(200);
  equal((await spot(page)).turn, -5, 'la rueda al revés la gira para el otro lado');
  const knob = middle(await page.ask('box', '.sticker-handle.turn'));
  await page.drag(knob, { x: knob.x + 120, y: knob.y + 60 });
  await sleep(200);
  const turned = await spot(page);
  check(turned.turn > 20 && turned.turn < 100, `la manija no giró la imagen: ${turned.turn}`);
  saved = (await stored(page))[0];
  check(near(saved.turn, turned.turn, 0.2) && near(saved.width, grown.width, 0.005), `el giro o el tamaño no se guardaron: ${JSON.stringify(saved)}`);

  // Con el teclado: las flechas corren la imagen (y no abren el cuaderno).
  await page.key('ArrowRight');
  await page.key('ArrowRight');
  await sleep(200);
  check(near((await spot(page)).x, turned.x + 0.02, 0.002), 'la flecha derecha no corrió la imagen');
  equal(await face(page), 'front', 'acomodando, la flecha derecha no tiene que abrir el cuaderno');

  // Esc termina; el cuaderno sigue cerrado y la imagen en su lugar.
  await page.key('Escape');
  await page.until(async () => !(await page.ask('count', '.cover.arranging, .cover-arrange, .cover-mode')), 'Esc no terminó el modo acomodar');
  equal(await face(page), 'front', 'Esc, al terminar de acomodar, no tiene que abrir ni cerrar nada');
  const settled = await spot(page);
  check(near(settled.turn, turned.turn, 0.2) && near(settled.pixels, grown.pixels, 1), 'al terminar de acomodar la imagen cambió');

  // Ahora el menú sí ofrece acomodar; adentro, Supr quita la imagen y el modo termina solo.
  await pickFromCoverMenu(page, 'Acomodar las imágenes');
  await page.until(() => page.ask('count', '.cover.arranging .sticker-box.selected'), 'el menú no entró al modo acomodar');
  await press(page, 'Delete', 'Delete', 46);
  await waitStickers(page, 0, 'Supr no quitó la imagen');
  await page.until(async () => !(await page.ask('count', '.cover.arranging, .cover-mode')), 'sin imágenes, el modo acomodar tenía que terminar');
  equal((await stored(page)).length, 0, 'la imagen quitada siguió guardada');
});

test('imágenes: fuera del modo acomodar son inertes; persisten y acompañan el tamaño del cuaderno', async (page) => {
  await open(page, 'standard', 'double');
  await clearStickers(page);
  await closeFront(page);
  await pasteOne(page);
  const start = await spot(page);
  await page.drag({ x: start.left, y: start.top }, { x: start.left - 60, y: start.top + 120 });
  const corner = middle(await page.ask('box', '.sticker-handle.nw'));
  await page.drag(corner, { x: corner.x - 30, y: corner.y - 18 });
  await page.wheel(start.left - 60, start.top + 120, 120);
  await sleep(200);
  // «Listo» termina de acomodar.
  await page.clickOn('.cover-mode button', 'Listo');
  await page.until(async () => !(await page.ask('count', '.cover.arranging, .cover-arrange')), '«Listo» no terminó el modo acomodar');
  const placed = await spot(page);

  // Un clic sobre la imagen es un clic en la tapa: abre el cuaderno.
  await page.click(placed.left, placed.top);
  await waitOpen(page, 'un clic sobre una imagen pegada no abrió el cuaderno');

  // Al volver a cargar, la imagen sigue donde estaba.
  await open(page, 'standard', 'double');
  await closeFront(page);
  await waitStickers(page, 1, 'la imagen no persistió al recargar');
  const again = await spot(page);
  for (const key of ['x', 'y', 'width', 'height', 'turn']) check(near(again[key], placed[key], 0.003), `al recargar cambió ${key}: ${placed[key]} → ${again[key]}`);
  check(await page.evaluate(`document.querySelector('.cover .sticker').naturalWidth > 0`), 'la imagen guardada no se pudo mostrar');

  // En otro tamaño de cuaderno ocupa la misma parte de la tapa.
  for (const size of ['pocket', 'full']) {
    await open(page, size, size === 'full' ? 'single' : 'double');
    await closeFront(page);
    await waitStickers(page, 1, `la imagen no está a tamaño ${size}`);
    const scaled = await spot(page);
    for (const key of ['x', 'y', 'width', 'height', 'turn']) check(near(scaled[key], placed[key], 0.006), `a tamaño ${size} cambió ${key}: ${placed[key]} → ${scaled[key]}`);
    check(!near(scaled.pixels, placed.pixels, 20), `a tamaño ${size} la imagen tenía que medir distinto en píxeles`);
  }

  // No se sale de la tapa: lo que asoma se recorta en su borde.
  equal(await page.evaluate(`getComputedStyle(document.querySelector('.cover-stickers')).overflow`), 'hidden', 'las imágenes no se recortan en el borde de la tapa');
});

test('imágenes: Ctrl + V y soltar un archivo las pegan en la cara que se está viendo', async (page) => {
  await open(page, 'standard', 'double');
  await clearStickers(page);
  await closeFront(page);
  await page.key('v');
  await waitFace(page, 'back', 'V no dio vuelta el cuaderno');

  await give(page, 'paste');
  await waitStickers(page, 1, 'pegar con el portapapeles no puso la imagen en la contratapa');
  await page.until(() => page.ask('count', '.cover.arranging .sticker-box.selected'), 'al pegar no se entró a acomodar');
  equal((await stored(page))[0].face, 'back', 'la imagen pegada con la contratapa a la vista tenía que quedar en la contratapa');

  // Soltar un archivo: cae donde se lo suelta.
  const cover = await page.ask('box', '.cover');
  const at = { x: cover.left + cover.width * 0.3, y: cover.top + cover.height * 0.25 };
  await give(page, 'drop', { at });
  await waitStickers(page, 2, 'soltar un archivo no pegó la imagen');
  await sleep(250);
  const dropped = (await stored(page))[1];
  check(near(dropped.x, 0.3, 0.01) && near(dropped.y, 0.25, 0.01) && dropped.face === 'back', `la imagen soltada no cayó donde se la soltó: ${JSON.stringify(dropped)}`);
  await page.key('Enter');
  await page.until(async () => !(await page.ask('count', '.cover.arranging, .cover-arrange')), 'Enter no terminó el modo acomodar');

  // En la tapa no hay ninguna: cada cara tiene las suyas.
  await page.key('v');
  await waitFace(page, 'front', 'V no dio vuelta el cuaderno');
  equal(await page.ask('count', '.cover .sticker'), 0, 'las imágenes de la contratapa se ven en la tapa');
  await page.key('v');
  await waitFace(page, 'back', 'V no dio vuelta el cuaderno');
  await waitStickers(page, 2, 'al volver a la contratapa faltan sus imágenes');

  // Lo que no es una imagen se avisa y no se pega.
  await give(page, 'paste', { type: 'text/plain', name: 'nota.txt' });
  await page.until(async () => /no es una imagen/.test((await page.ask('label', '.cover .toast')) ?? ''), 'no se avisó que el archivo no era una imagen');
  equal((await stored(page)).length, 2, 'se pegó algo que no era una imagen');
});

test('imágenes: hay un tope por cara y se avisa al llegar', async (page) => {
  await open(page, 'pocket', 'double');
  await clearStickers(page);
  await closeFront(page);
  for (let count = 1; count <= 12; count++) {
    await give(page, 'paste', { width: 64, height: 64 });
    await waitStickers(page, count, `no se pegó la imagen número ${count}`);
  }
  await give(page, 'paste', { width: 64, height: 64 });
  await page.until(async () => /Ya hay 12 imágenes en la tapa/.test((await page.ask('label', '.cover .toast')) ?? ''), 'no se avisó que la tapa estaba llena');
  equal((await stored(page)).length, 12, 'se pasó del tope de imágenes');
  // El tope es por cara: en la contratapa todavía entra.
  await page.key('Escape');
  await page.until(async () => !(await page.ask('count', '.cover.arranging, .cover-arrange')), 'Esc no terminó el modo acomodar');
  await page.key('v');
  await waitFace(page, 'back', 'V no dio vuelta el cuaderno');
  await give(page, 'paste', { width: 64, height: 64 });
  await waitStickers(page, 1, 'con la tapa llena, la contratapa tenía que aceptar una imagen');
  await clearStickers(page);
  await waitStickers(page, 0, 'no se quitaron las imágenes');
});

test('imágenes: en Ajustes se ven cuántas hay, se quitan de a una y todas con confirmación', async (page) => {
  await open(page, 'full', 'double');
  await clearStickers(page);
  await closeFront(page);
  await give(page, 'paste');
  await waitStickers(page, 1, 'no se pegó la primera imagen');
  await give(page, 'paste', { width: 120, height: 200 });
  await waitStickers(page, 2, 'no se pegó la segunda imagen');
  await page.key('Escape');
  await page.until(async () => !(await page.ask('count', '.cover.arranging, .cover-arrange')), 'Esc no terminó el modo acomodar');
  await page.key('v');
  await waitFace(page, 'back', 'V no dio vuelta el cuaderno');
  await give(page, 'paste');
  await waitStickers(page, 1, 'no se pegó la imagen de la contratapa');
  await page.key('Escape');
  await page.until(async () => !(await page.ask('count', '.cover.arranging, .cover-arrange')), 'Esc no terminó el modo acomodar');

  await pickFromCoverMenu(page, 'Ajustes');
  await page.until(() => page.ask('count', '.sticker-chip'), 'en Ajustes no aparecen las imágenes pegadas');
  await sleep(300);
  equal(await page.ask('count', '.sticker-chip'), 3, 'tienen que verse las tres imágenes');
  const row = (await page.ask('labels', '.row')).find((text) => text.includes('Imágenes de la tapa'));
  check(/2 imágenes en la tapa y 1 en la contratapa/.test(row), `el renglón no dice cuántas hay: ${row}`);
  check(await page.evaluate(`[...document.querySelectorAll('.sticker-chip img')].every((image) => image.naturalWidth > 0)`), 'alguna miniatura no cargó');

  // Quitar de a una: sin preguntar.
  await page.clickOn('.sticker-chip button');
  await page.until(async () => (await page.ask('count', '.sticker-chip')) === 2, 'no se quitó la imagen');
  equal((await stored(page)).length, 2, 'la imagen quitada siguió guardada');
  // La contratapa, que está a la vista detrás de los ajustes, no perdió la suya.
  equal(await page.ask('count', '.cover .sticker'), 1, 'se quitó una imagen de la cara equivocada');

  // Quitar todas pregunta antes; Cancelar no quita nada.
  await page.clickOn('.row .button', 'Quitar todas');
  await page.until(async () => (await page.ask('label', '.modal.confirm h2')) === '¿Quitar todas las imágenes?', 'no pidió confirmación');
  await sleep(200);
  await page.clickOn('.confirm .button', 'Cancelar');
  await sleep(400);
  equal((await stored(page)).length, 2, 'Cancelar quitó las imágenes');
  await page.clickOn('.row .button', 'Quitar todas');
  await page.until(async () => (await page.ask('label', '.modal.confirm h2')) === '¿Quitar todas las imágenes?', 'no pidió confirmación');
  await sleep(200);
  await page.clickOn('.confirm .button.danger', 'Quitar todas');
  await page.until(async () => (await stored(page)).length === 0, 'confirmar no quitó las imágenes');
  await page.until(async () => !(await page.ask('count', '.sticker-chip, .cover .sticker')), 'las imágenes quitadas siguen a la vista');
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
