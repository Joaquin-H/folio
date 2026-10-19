// Pruebas de punta a punta del recorrido de la primera vez: cuándo aparece (y cuándo no), cómo
// se avanza, se vuelve y se salta (con los botones y con el teclado), los pasos donde se prueba
// algo, cómo arranca con el cuaderno cerrado, abierto o sin hojas, que los globos entren en la
// ventana sin tapar lo que explican ni los botones, cómo se vuelve a ver (menú y Ajustes) y que
// durante el recorrido ningún clic ni tecla toque el cuaderno por accidente. Corren sobre la
// interfaz con datos de muestra, en un Edge sin ventana.
//
// Uso (desde la carpeta del proyecto):
//   node tests/e2e/tutorial.mjs              todas
//   node tests/e2e/tutorial.mjs teclado      solo las que tienen "teclado" en el nombre
//
// Ver tests/e2e/README.md para los puertos y lo que hace falta tener instalado.

import { check, equal, launch, sleep, suite } from './harness.mjs';

/** La ventana mide lo que el cuaderno más la mesa (src/layout.ts): se prueba con las medidas reales. */
const WINDOW = {
  standard: { width: 1216, height: 868, prefs: { size: 'standard', spread: 'double' } },
  pocketSingle: { width: 474, height: 628, prefs: { size: 'pocket', spread: 'single' } },
  pocketDouble: { width: 866, height: 628, prefs: { size: 'pocket', spread: 'double' } },
  standardSingle: { width: 656, height: 868, prefs: { size: 'standard', spread: 'single' } },
  full: { width: 1920, height: 1080, prefs: { size: 'full', spread: 'double' } },
};
/** Cuántos pasos tiene el recorrido con las solapas a la vista, y cuántos sin ellas. */
const STEPS = 7;
/** Títulos de los pasos, en orden (el primero depende de si el cuaderno arranca abierto o cerrado). */
const TITLES = ['¡Hola! Esto es Folio', 'Pasá de hoja', 'Escribí en la hoja', 'Buscar y hoja nueva', 'Las solapas', 'El menú', 'Siempre a mano'];
/** Hoja de muestra que es un archivo: la primera que se puede escribir (src/mock.ts). */
const WRITABLE = 'reunion-equipo.md';

const { test, run } = suite();

const open = (page, size, extra = {}) => {
  const { width, height, prefs } = WINDOW[size];
  return page.open({ width, height, prefs: { ...prefs, ...extra.prefs }, tour: extra.tour, welcome: extra.welcome });
};

/** Lo que se ve del recorrido ahora, o `null` si no hay. */
const tour = (page) =>
  page.evaluate(`(() => {
    const root = document.querySelector('.tour');
    const balloon = document.querySelector('.tour-balloon');
    if (!root || !balloon) return null;
    const rect = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    const hole = document.querySelector('.tour-hole');
    return {
      hidden: root.classList.contains('hidden'),
      leaving: root.classList.contains('leaving'),
      title: balloon.querySelector('.tour-title')?.textContent ?? '',
      count: balloon.querySelector('.tour-count')?.textContent ?? '',
      text: balloon.querySelector('.tour-text')?.textContent ?? '',
      hint: balloon.querySelector('.tour-try')?.textContent ?? null,
      done: !!balloon.querySelector('.tour-try.done'),
      buttons: [...balloon.querySelectorAll('button')].map((button) => button.textContent),
      arrow: !!balloon.querySelector('.tour-arrow'),
      balloon: rect(balloon),
      hole: hole ? rect(hole) : null,
      glide: root.classList.contains('glide'),
    };
  })()`);

/** Espera a que el recorrido se vea y no esté escondido ni yéndose. */
async function shown(page, what = 'el recorrido no apareció', timeout = 8000) {
  await page.until(async () => {
    const state = await tour(page);
    return state && !state.hidden && !state.leaving;
  }, what, timeout);
  return tour(page);
}

/** Espera a ese paso («3 de 7») y a que termine de deslizarse a su lugar. */
async function step(page, count) {
  await page.until(async () => {
    const state = await tour(page);
    return state && !state.hidden && !state.leaving && state.count === count;
  }, `no se llegó al paso «${count}»`, 8000);
  await sleep(520);
  return tour(page);
}

/** Espera a que el recorrido no esté a la vista (terminó, o se hizo a un lado). */
const gone = (page, what) => page.until(async () => !(await tour(page)), what, 5000);
const aside = (page, what) =>
  page.until(async () => {
    const state = await tour(page);
    return !state || state.hidden;
  }, what, 5000);

/** Ctrl + coma (Ajustes): el arnés no la trae definida, así que va como evento de teclado a la página. */
const ctrlComma = (page) =>
  page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true, cancelable: true }))`);

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

/** Empieza el recorrido como lo pide Ajustes cuando es otra ventana (el almacenamiento avisa). */
async function replay(page) {
  await page.evaluate(`window.dispatchEvent(new StorageEvent('storage', { key: 'book.tutorial.replay' }))`);
}

/** Empieza el recorrido desde el principio, con la interfaz ya cargada y el recorrido marcado como visto. */
async function begin(page) {
  await replay(page);
  return shown(page);
}

/** Lleva el recorrido hasta ese paso (1 es el primero), con las flechas. */
async function goTo(page, wanted) {
  for (let current = 1; current < wanted; current++) {
    await step(page, `${current} de ${STEPS}`);
    await page.key('ArrowRight');
  }
  return step(page, `${wanted} de ${STEPS}`);
}

const center = (box) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
const area = (a, b) => {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
};

/** Qué hay en pantalla y cómo está el cuaderno: lo que ningún gesto del recorrido tiene que cambiar. */
async function notebook(page) {
  const state = await page.state();
  const extra = await page.evaluate(`({
    menu: !!document.querySelector('.menu-list'),
    dialog: !!document.querySelector('.backdrop'),
    sizing: !!document.querySelector('.app.sizing'),
    stored: localStorage.getItem('book.tutorial'),
  })`);
  return { ...state, ...extra };
}

/** Afirma que el cuaderno sigue como estaba. */
async function unchanged(page, before, what) {
  const after = await notebook(page);
  for (const key of ['closed', 'sheet', 'page', 'title', 'writing', 'tab', 'menu', 'dialog', 'sizing', 'toast']) {
    equal(after[key], before[key], `${what}: cambió «${key}»`);
  }
}

/** Rectángulos de las cosas del cuaderno que un globo no debería tapar. */
const controls = (page) =>
  page.evaluate(`['[data-tour="controls"]', '[data-tour="actions"]', '.cover-controls', '.cover-actions']
    .map((selector) => document.querySelector(selector))
    .filter(Boolean)
    .map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })`);

// ---- cuándo aparece ------------------------------------------------------------------

test('aparece la primera vez, abierto en el primer paso, y no la segunda', async (page) => {
  await open(page, 'standard', { tour: true });
  const first = await shown(page, 'el recorrido no apareció la primera vez');
  equal(first.title, TITLES[0], 'primer paso');
  equal(first.count, `1 de ${STEPS}`, 'cuenta del primer paso');
  check(first.buttons.includes('Siguiente') && first.buttons.includes('Saltar') && !first.buttons.includes('Atrás'), `botones del primer paso: ${first.buttons}`);
  // Saltarlo lo da por visto: recargando, ya no sale.
  await page.key('Escape');
  await gone(page, 'Esc no saltó el recorrido');
  const stored = await page.evaluate(`JSON.parse(localStorage.getItem('book.tutorial'))`);
  check(typeof stored.version === 'number' && stored.version >= 1, `no quedó guardado que se vio: ${JSON.stringify(stored)}`);
  await page.send('Page.reload');
  await page.until(() => page.evaluate(`!!document.querySelector('.book') && !!document.querySelector('.page')`), 'el cuaderno no volvió a cargar', 15_000);
  await sleep(2600);
  equal(await tour(page), null, 'el recorrido volvió a salir la segunda vez');
});

test('las pruebas de siempre no lo ven: marcado como visto, no sale', async (page) => {
  await open(page, 'standard');
  await sleep(2600);
  equal(await tour(page), null, 'apareció con el recorrido marcado como visto');
});

test('si se termina el recorrido tampoco vuelve; si cambia de versión, sí', async (page) => {
  await open(page, 'standard', { tour: true });
  await shown(page);
  for (let at = 1; at < STEPS; at++) {
    await step(page, `${at} de ${STEPS}`);
    await page.clickOn('.tour .button.primary');
  }
  const last = await step(page, `${STEPS} de ${STEPS}`);
  equal(last.buttons.at(-1), 'Listo', 'el último paso cierra con «Listo»');
  await page.clickOn('.tour .button.primary');
  await gone(page, '«Listo» no cerró el recorrido');
  check((await notebook(page)).stored, 'no quedó guardado que se vio');
  // Una versión más vieja del recorrido ya no cuenta: se muestra de nuevo.
  await open(page, 'standard', { tour: JSON.stringify({ version: 0 }) });
  await shown(page, 'con una versión vieja guardada, el recorrido no salió');
  // Lo guardado ya es de esta versión o de una más nueva: no sale.
  await open(page, 'standard', { tour: JSON.stringify({ version: 2, at: 1 }) });
  await sleep(2600);
  equal(await tour(page), null, 'salió con la versión actual guardada');
});

test('un dato guardado roto no rompe nada: se muestra una vez y queda bien escrito', async (page) => {
  await open(page, 'standard', { tour: 'esto no es json {' });
  await shown(page, 'con un dato roto, el recorrido no salió');
  await page.key('Escape');
  await gone(page, 'no se pudo saltar');
  const stored = await page.evaluate(`JSON.parse(localStorage.getItem('book.tutorial'))`);
  check(typeof stored.version === 'number', 'no se volvió a escribir bien');
});

test('con el almacenamiento roto no insiste ni falla', async (page) => {
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => { const get = Storage.prototype.getItem; Storage.prototype.getItem = function (key) { if (key === 'book.tutorial') throw new Error('bloqueado'); return get.call(this, key); }; })()`,
  });
  try {
    // Esta apertura quita el marcador y deja el almacenamiento roto solo para esa clave.
    await open(page, 'standard', { tour: true });
    await sleep(2600);
    equal(await tour(page), null, 'insistió con el recorrido sin poder saber si ya se vio');
    // Pedirlo a mano sigue andando, y terminarlo no tira errores aunque no se pueda leer lo guardado.
    await replay(page);
    await shown(page);
    await page.key('Escape');
    await gone(page, 'no se pudo saltar con el almacenamiento roto');
  } finally {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
});

// ---- avanzar, volver, saltar ----------------------------------------------------------

test('botones: Siguiente avanza, Atrás vuelve, Saltar termina', async (page) => {
  await open(page, 'standard');
  await begin(page);
  let state = await step(page, `1 de ${STEPS}`);
  equal(state.title, TITLES[0], 'primer paso');
  await page.clickOn('.tour .button.primary', 'Siguiente');
  state = await step(page, `2 de ${STEPS}`);
  equal(state.title, TITLES[1], 'segundo paso');
  check(state.buttons.includes('Atrás'), 'el segundo paso no tiene «Atrás»');
  await page.clickOn('.tour .button', 'Siguiente');
  state = await step(page, `3 de ${STEPS}`);
  equal(state.title, TITLES[2], 'tercer paso');
  await page.clickOn('.tour .button', 'Atrás');
  state = await step(page, `2 de ${STEPS}`);
  equal(state.title, TITLES[1], 'después de volver');
  await page.clickOn('.tour .button', 'Saltar');
  await gone(page, '«Saltar» no cerró el recorrido');
  // Nada de lo que hizo el recorrido movió el cuaderno.
  const after = await notebook(page);
  equal(after.sheet, 1, 'el recorrido pasó de hoja');
  equal(after.writing, false, 'el recorrido entró a escribir');
});

test('teclado: → y Enter siguen, ← vuelve, Esc salta, y no pasan página', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await step(page, `1 de ${STEPS}`);
  await page.key('ArrowRight');
  await step(page, `2 de ${STEPS}`);
  await page.key('Enter');
  await step(page, `3 de ${STEPS}`);
  await page.key('ArrowLeft');
  await step(page, `2 de ${STEPS}`);
  await page.key('ArrowLeft');
  await step(page, `1 de ${STEPS}`);
  await page.key('ArrowLeft'); // en el primero no hay a dónde volver
  await sleep(300);
  equal((await tour(page)).count, `1 de ${STEPS}`, 'volvió desde el primer paso');
  const state = await notebook(page);
  equal(state.sheet, 1, 'las flechas del recorrido pasaron de hoja');
  equal(state.writing, false, 'Enter entró a escribir');
  await page.key('Escape');
  await gone(page, 'Esc no saltó el recorrido');
  // Con el recorrido cerrado, las flechas vuelven a ser del cuaderno.
  await page.key('ArrowRight');
  await page.until(async () => (await page.state()).sheet === 2, 'sin el recorrido, la flecha no pasó de hoja');
});

test('teclado: las teclas sueltas del cuaderno no hacen nada mientras se mira', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await step(page, `1 de ${STEPS}`);
  const before = await notebook(page);
  for (const key of ['End', 'Home', 'PageDown', 'PageUp', 'ArrowDown', 'F2', 'Backspace', 'Tab']) {
    await page.key(key);
    await sleep(120);
  }
  await page.key('v');
  await sleep(300);
  equal((await tour(page)).count, `1 de ${STEPS}`, 'alguna tecla cambió de paso');
  await unchanged(page, before, 'teclas sueltas');
});

test('teclado: Ctrl + algo sigue siendo del cuaderno y el recorrido se hace a un lado', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await step(page, `1 de ${STEPS}`);
  await page.key('f', { ctrl: true });
  await page.until(() => page.evaluate(`!!document.querySelector('.backdrop')`), 'Ctrl + F no abrió la búsqueda');
  await aside(page, 'el recorrido no se hizo a un lado con la búsqueda abierta');
  // Esc es de la búsqueda, no del recorrido: la cierra y no salta nada.
  await page.key('Escape');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.backdrop')`)), 'Esc no cerró la búsqueda');
  const back = await shown(page, 'el recorrido no volvió al cerrar la búsqueda');
  equal(back.count, `1 de ${STEPS}`, 'volvió a otro paso');
  // Los ajustes también lo hacen a un lado.
  await ctrlComma(page);
  await page.until(() => page.evaluate(`!!document.querySelector('.backdrop .modal')`), 'Ctrl + , no abrió Ajustes');
  await aside(page, 'el recorrido no se hizo a un lado con Ajustes abierto');
  await page.key('Escape');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.backdrop')`)), 'Esc no cerró Ajustes');
  await shown(page, 'el recorrido no volvió al cerrar Ajustes');
});

// ---- pasos donde se prueba algo ---------------------------------------------------------

test('probar: tocar el borde derecho pasa de hoja y el recorrido sigue solo', async (page) => {
  await open(page, 'standard');
  await begin(page);
  const state = await goTo(page, 2);
  check(/Probá/.test(state.hint ?? ''), 'el paso no pide probar nada');
  check(state.buttons.includes('Siguiente'), 'el paso interactivo no tiene «Siguiente»');
  equal((await page.state()).sheet, 1, 'ya había pasado de hoja');
  // El hueco está sobre la franja de la derecha: ahí el clic llega al cuaderno.
  const strip = await page.ask('box', '[data-tour="turn-next"]');
  const at = await page.evaluate(`(() => { const hole = document.querySelector('.tour-hole').getBoundingClientRect(); return { l: hole.left, r: hole.right, t: hole.top, b: hole.bottom }; })()`);
  check(at.l <= strip.left && at.r >= strip.right && at.t <= strip.top && at.b >= strip.bottom, 'lo resaltado no cubre la franja');
  await page.clickOn('[data-tour="turn-next"]');
  await page.until(async () => (await page.state()).sheet === 2, 'el clic en la franja no pasó de hoja');
  const done = await page.until(async () => (await tour(page))?.done, 'no se vio que salió bien', 3000).then(() => tour(page));
  check(/Eso es/.test(done.hint), `no dijo que salió bien: ${done.hint}`);
  await step(page, `3 de ${STEPS}`);
  equal((await page.state()).sheet, 2, 'después de seguir, volvió de hoja');
});

test('probar: «Siguiente» sigue estando y no pasa de hoja', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await goTo(page, 2);
  await page.clickOn('.tour .button.primary');
  await step(page, `3 de ${STEPS}`);
  await sleep(500);
  equal((await page.state()).sheet, 1, 'seguir con el botón pasó de hoja');
});

test('probar: deslizar la hoja por la franja también cuenta', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await goTo(page, 2);
  const strip = await page.ask('box', '[data-tour="turn-next"]');
  const middle = center(strip);
  await page.drag({ x: middle.x + 10, y: middle.y }, { x: middle.x - 90, y: middle.y }, { steps: 8 });
  // El deslizamiento empieza en el papel, sobre la franja: pasa de hoja.
  await page.until(async () => (await page.state()).sheet === 2, 'deslizar sobre lo resaltado no pasó de hoja', 3000);
  await step(page, `3 de ${STEPS}`);
});

test('probar: doble clic sobre el texto entra a escribir; el recorrido espera y sigue al terminar', async (page) => {
  await open(page, 'standard');
  // Las primeras hojas de muestra vienen del Bloc de notas: hay que llegar a un archivo, que sí se puede escribir.
  await gotoSheet(page, WRITABLE);
  await begin(page);
  const state = await goTo(page, 3);
  check(/Probá/.test(state.hint ?? ''), 'el paso de escribir no pide probar');
  check(/Ctrl \+ Enter/.test(state.text) && /Esc/.test(state.text), `no nombra cómo terminar: ${state.text}`);
  const hole = state.hole;
  await page.doubleClick(hole.left + 140, hole.top + 20);
  await page.until(async () => (await page.state()).writing, 'el doble clic sobre lo resaltado no entró a escribir');
  await aside(page, 'el recorrido no se hizo a un lado al escribir');
  // Escribiendo, el teclado es del texto: lo escrito entra y Esc termina sin tocar el recorrido.
  await page.type('hola');
  await sleep(200);
  check(/hola/.test((await page.state()).text), 'lo escrito no llegó al texto');
  await page.key('Escape');
  await page.until(async () => !(await page.state()).writing, 'Esc no terminó de escribir');
  const next = await step(page, `4 de ${STEPS}`);
  equal(next.title, TITLES[3], 'después de escribir sigue con el paso que viene');
});

test('probar: en una hoja que no se puede escribir no se pide probar', async (page) => {
  await open(page, 'standard');
  await begin(page);
  const state = await goTo(page, 3); // la hoja 1 viene del Bloc de notas
  equal(state.hint, null, 'pide probar en una hoja bloqueada');
  check(/no se puede/.test(state.text), `no avisa que esta hoja no se puede escribir: ${state.text}`);
  // El doble clic ahí no lo resuelve el recorrido: está bloqueado.
  const hole = state.hole;
  await page.doubleClick(hole.left + 140, hole.top + 20);
  await sleep(500);
  equal((await page.state()).writing, false, 'el doble clic bloqueado entró a escribir');
});

test('probar: abrir el menú lo cuenta como hecho y el recorrido sigue al cerrarlo', async (page) => {
  await open(page, 'standard');
  await begin(page);
  const state = await goTo(page, 6);
  check(/Probá/.test(state.hint ?? ''), 'el paso del menú no pide probar');
  await page.clickOn('[data-tour="actions"] .menu > button');
  await page.until(() => page.evaluate(`!!document.querySelector('.menu-list')`), 'el menú no se abrió desde lo resaltado');
  await aside(page, 'el recorrido no se hizo a un lado con el menú abierto');
  const items = await page.evaluate(`[...document.querySelectorAll('.menu-list .menu-label')].map((node) => node.textContent)`);
  check(items.includes('Ajustes'), `el menú no ofrece Ajustes: ${items}`);
  await page.key('Escape');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.menu-list')`)), 'Esc no cerró el menú');
  const next = await step(page, `7 de ${STEPS}`);
  equal(next.title, TITLES[6], 'al cerrar el menú no siguió con el último paso');
});

// ---- cómo arranca ----------------------------------------------------------------------

test('con el cuaderno cerrado empieza por la tapa y sigue cuando se abre', async (page) => {
  await open(page, 'standard');
  await page.clickOn('[aria-label="Cerrar el cuaderno"]');
  await page.until(async () => (await page.state()).closed, 'el cuaderno no se cerró');
  await sleep(500);
  await replay(page);
  const state = await shown(page);
  equal(state.title, TITLES[0], 'el primer paso con la tapa a la vista');
  equal(state.count, `1 de ${STEPS}`, 'cuenta');
  check(/Probá/.test(state.hint ?? ''), 'la tapa no pide probar');
  equal(state.buttons.includes('Atrás'), false, 'la tapa tiene «Atrás»');
  // Tocar la tapa (afuera de la etiqueta) abre el cuaderno y el recorrido sigue.
  const cover = await page.ask('box', '.cover');
  await page.click(cover.left + cover.width / 2, cover.top + cover.height * 0.8);
  await page.until(async () => (await page.state()).open, 'tocar la tapa no abrió el cuaderno');
  const next = await step(page, `2 de ${STEPS}`);
  equal(next.title, TITLES[1], 'al abrirse no siguió con las franjas');
  equal(next.buttons.includes('Atrás'), false, 'al abrirse desde la tapa se puede volver a ella');
});

test('con el cuaderno cerrado, «Siguiente» también lo abre', async (page) => {
  await open(page, 'standard');
  await page.clickOn('[aria-label="Cerrar el cuaderno"]');
  await page.until(async () => (await page.state()).closed, 'el cuaderno no se cerró');
  await sleep(500);
  await replay(page);
  await shown(page);
  await page.key('ArrowRight');
  await page.until(async () => (await page.state()).open, '→ no abrió el cuaderno desde la tapa');
  const next = await step(page, `2 de ${STEPS}`);
  equal(next.title, TITLES[1], 'al abrirse no siguió con las franjas');
});

test('con el cuaderno cerrado por atrás también empieza bien', async (page) => {
  await open(page, 'standard');
  await page.key('End');
  await page.settle(300);
  await page.clickOn('.turn-zone.next');
  await page.until(async () => (await page.state()).closed, 'no se llegó a la contratapa');
  await sleep(600);
  await replay(page);
  const state = await shown(page);
  equal(state.title, TITLES[0], 'primer paso con la contratapa');
  check(/por atrás/.test(state.text), `no explica que se ve por atrás: ${state.text}`);
});

test('si se cierra el cuaderno a mitad del recorrido, espera a que se abra', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await goTo(page, 4);
  // El recorrido no deja tocar el cuaderno: se lo cierra como lo haría un atajo o la bandeja.
  await page.evaluate(`document.querySelector('[aria-label="Cerrar el cuaderno"]').click()`);
  await page.until(async () => (await page.state()).closed, 'el cuaderno no se cerró');
  await aside(page, 'el recorrido no esperó con el cuaderno cerrado');
  await sleep(300);
  // Ya sin recorrido encima, la tapa se abre con un clic.
  const cover = await page.ask('box', '.cover');
  await page.click(cover.left + cover.width / 2, cover.top + cover.height * 0.8);
  await page.until(async () => (await page.state()).open, 'la tapa no se abrió');
  const back = await shown(page, 'el recorrido no volvió al abrirse el cuaderno');
  equal(back.count, `4 de ${STEPS}`, 'volvió a otro paso');
});

test('sin hojas todavía: explica sin señalar lo que no existe', async (page) => {
  await open(page, 'standard');
  await page.clickOn('.tab[aria-label="Ver Papelera"]'); // sin nada en la papelera: no hay hojas que mostrar
  await page.until(async () => (await page.state()).empty !== null, 'no se vio el cuaderno vacío');
  await sleep(400);
  await replay(page);
  let state = await step(page, `1 de ${STEPS}`);
  equal(state.title, 'Todavía no hay hojas', 'primer paso sin hojas');
  check(state.hole && state.hole.right > state.hole.left, 'el primer paso no señala nada');
  await page.key('ArrowRight');
  state = await step(page, `2 de ${STEPS}`);
  check(/Cuando haya hojas/.test(state.text), `el paso de pasar de hoja no avisa que todavía no hay: ${state.text}`);
  equal(state.hint, null, 'pide probar pasar de hoja sin hojas');
  check(state.hole, 'el paso no señala nada');
  equal(await page.ask('count', '.turn-zone'), 0, 'hay franjas sin hojas');
  await page.key('ArrowRight');
  state = await step(page, `3 de ${STEPS}`);
  equal(state.hint, null, 'pide escribir sin hojas');
  check(/hoja nueva/.test(state.text), `no manda al botón de hoja nueva: ${state.text}`);
  // Lo que señala está de verdad en pantalla, dentro de la ventana.
  const view = await page.evaluate(`({ w: innerWidth, h: innerHeight })`);
  check(state.hole.left >= 0 && state.hole.top >= 0 && state.hole.right <= view.w && state.hole.bottom <= view.h, 'señala algo fuera de la ventana');
  for (let at = 4; at <= STEPS; at++) {
    await page.key('ArrowRight');
    state = await step(page, `${at} de ${STEPS}`);
    check(state.hole && state.hole.right > state.hole.left, `el paso ${at} no señala nada`);
  }
});

test('con las solapas ocultas el recorrido no las nombra', async (page) => {
  await open(page, 'standard', { prefs: { tabs: false } });
  await begin(page);
  const state = await step(page, `1 de ${STEPS - 1}`);
  equal(state.count, `1 de ${STEPS - 1}`, 'cuenta');
  const titles = [];
  for (let at = 1; at <= STEPS - 1; at++) {
    titles.push((await step(page, `${at} de ${STEPS - 1}`)).title);
    if (at < STEPS - 1) await page.key('ArrowRight');
  }
  check(!titles.includes('Las solapas'), `habla de las solapas ocultas: ${titles}`);
});

// ---- que los globos entren y no tapen --------------------------------------------------

for (const size of ['standard', 'pocketSingle', 'pocketDouble', 'standardSingle', 'full']) {
  test(`${size}: los globos quedan dentro de la ventana y no tapan lo que explican ni los botones`, async (page) => {
    await open(page, size);
    await begin(page);
    const { width, height } = WINDOW[size];
    for (let at = 1; at <= STEPS; at++) {
      const state = await step(page, `${at} de ${STEPS}`);
      const where = `${size}, paso ${at} («${state.title}»)`;
      const b = state.balloon;
      check(b.left >= 0 && b.top >= 0 && b.right <= width && b.bottom <= height, `${where}: el globo se sale de la ventana: ${JSON.stringify(b)}`);
      check(state.hole, `${where}: no resalta nada`);
      equal(area(b, state.hole), 0, `${where}: el globo tapa lo resaltado`);
      for (const control of await controls(page)) equal(area(b, control), 0, `${where}: el globo tapa los botones del papel`);
      check(state.arrow, `${where}: el globo no apunta a nada`);
      check(state.text.length > 20, `${where}: sin texto`);
      if (at < STEPS) await page.key('ArrowRight');
    }
  });
}

test('si la ventana cambia de tamaño a mitad del recorrido, el globo la sigue', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await goTo(page, 4);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 640, deviceScaleFactor: 1, mobile: false, screenWidth: 760, screenHeight: 640 });
  await sleep(700);
  const state = await shown(page);
  const b = state.balloon;
  check(b.left >= 0 && b.top >= 0 && b.right <= 760 && b.bottom <= 640, `el globo quedó fuera de la ventana nueva: ${JSON.stringify(b)}`);
});

// ---- cómo se vuelve a ver -----------------------------------------------------------------

test('se vuelve a ver desde Ajustes → Personalización', async (page) => {
  await open(page, 'standard');
  equal(await tour(page), null, 'el recorrido estaba a la vista');
  await page.clickOn('[data-tour="actions"] .menu > button');
  await page.until(() => page.evaluate(`!!document.querySelector('.menu-list')`), 'el menú no se abrió');
  await sleep(200);
  await page.clickOn('.menu-list .menu-item', 'Ajustes');
  await page.until(() => page.evaluate(`!!document.querySelector('.backdrop .modal')`), 'Ajustes no se abrió');
  await sleep(300);
  await page.until(() => page.evaluate(`!![...document.querySelectorAll('.modal .button')].find((node) => node.textContent.includes('Ver el recorrido'))`), 'Personalización no tiene el botón');
  await sleep(200);
  await page.clickOn('.modal .button', 'Ver el recorrido');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.backdrop')`)), 'Ajustes no se cerró');
  const state = await shown(page, 'Ajustes no volvió a mostrar el recorrido');
  equal(state.count, `1 de ${STEPS}`, 'no empezó por el principio');
  equal(state.title, TITLES[0], 'primer paso');
});

test('se vuelve a ver desde Ajustes con la tapa a la vista', async (page) => {
  await open(page, 'standard');
  await page.clickOn('[aria-label="Cerrar el cuaderno"]');
  await page.until(async () => (await page.state()).closed, 'el cuaderno no se cerró');
  await sleep(500);
  await page.clickOn('.cover .menu > button');
  await page.until(() => page.evaluate(`!!document.querySelector('.menu-list')`), 'el menú de la tapa no se abrió');
  await sleep(200);
  await page.clickOn('.menu-list .menu-item', 'Ajustes');
  await page.until(() => page.evaluate(`!!document.querySelector('.backdrop .modal')`), 'Ajustes no se abrió desde la tapa');
  await sleep(300);
  await page.clickOn('.modal .button', 'Ver el recorrido');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.backdrop')`)), 'Ajustes no se cerró');
  const state = await shown(page, 'Ajustes no mostró el recorrido');
  check(/tapa/.test(state.text), `desde la tapa no empieza por ella: ${state.text}`);
});

test('se vuelve a ver desde Ajustes → Acerca de, y el pedido de otra ventana también lo muestra', async (page) => {
  await open(page, 'standard');
  await ctrlComma(page);
  await page.until(() => page.evaluate(`!!document.querySelector('.backdrop .modal')`), 'Ajustes no se abrió');
  await sleep(300);
  await page.clickOn('[role="tab"]', 'Acerca de');
  await page.until(() => page.evaluate(`!![...document.querySelectorAll('.modal .button')].find((node) => node.textContent.includes('Ver el recorrido'))`), 'Acerca de no tiene el botón');
  await sleep(200);
  await page.clickOn('.modal .button', 'Ver el recorrido');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.backdrop')`)), 'Ajustes no se cerró');
  const state = await shown(page, 'Ajustes no mostró el recorrido');
  equal(state.title, TITLES[0], 'primer paso');
  await page.key('Escape');
  await gone(page, 'no se pudo saltar');
  // Cuando Ajustes es otra ventana, le pide el recorrido al cuaderno por el almacenamiento.
  await page.evaluate(`import('/src/components/Tutorial.tsx').then((tutorial) => (tutorial.requestTour(), true))`);
  const asked = await page.evaluate(`localStorage.getItem('book.tutorial.replay')`);
  check(asked && /^\d+$/.test(asked), `Ajustes no dejó el pedido: ${asked}`);
  await replay(page);
  await shown(page, 'el pedido de otra ventana no mostró el recorrido');
});

// ---- que no toque el cuaderno ------------------------------------------------------------

test('ningún clic ni gesto pasa página, abre ni cambia nada mientras se mira', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await step(page, `1 de ${STEPS}`);
  const before = await notebook(page);
  const book = await page.ask('box', '.leaves');
  const strips = { prev: await page.ask('box', '[data-tour="turn-prev"]'), next: await page.ask('box', '[data-tour="turn-next"]') };
  const buttons = ['[aria-label="Buscar y filtrar"]', '[aria-label="Nueva hoja"]', '[data-tour="actions"] .menu > button', '[aria-label="Cerrar el cuaderno"]', '[aria-label="Cerrar la ventana"]', '.tab[aria-label="Ver Papelera"]', '.tab[aria-label="Ver Trabajo"]'];
  const points = [
    center(book),
    center(strips.next),
    center(strips.prev),
    { x: book.left + 200, y: book.top + 140 },
    ...(await Promise.all(buttons.map((selector) => page.ask('center', selector)))).filter(Boolean),
  ];
  for (const point of points) {
    await page.click(point.x, point.y);
    await sleep(60);
    await page.doubleClick(point.x, point.y, { gap: 60 });
    await sleep(60);
    await page.wheel(point.x, point.y, 240);
    await sleep(60);
  }
  // Deslizar la hoja y arrastrar para seleccionar texto tampoco.
  await page.drag({ x: book.left + 200, y: book.top + 300 }, { x: book.left + 20, y: book.top + 300 }, { steps: 8 });
  await page.drag({ x: book.right - 200, y: book.top + 300 }, { x: book.right - 20, y: book.top + 300 }, { steps: 8 });
  await sleep(700);
  await unchanged(page, before, 'clics sobre el recorrido');
  const state = await tour(page);
  equal(state.count, `1 de ${STEPS}`, 'algún gesto hizo avanzar el recorrido');
  equal(state.hidden, false, 'algún gesto escondió el recorrido');
  // Con el recorrido cerrado, el mismo clic en la franja sí pasa página: no es que el cuaderno esté roto.
  await page.key('Escape');
  await gone(page, 'no se pudo saltar');
  await page.clickOn('[data-tour="turn-next"]');
  await page.until(async () => (await page.state()).sheet === 2, 'sin el recorrido, la franja no pasó de hoja');
});

test('en los pasos donde se prueba algo, solo lo resaltado responde', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await goTo(page, 2);
  const before = await notebook(page);
  const book = await page.ask('box', '.leaves');
  const prev = await page.ask('box', '[data-tour="turn-prev"]');
  const buttons = ['[aria-label="Buscar y filtrar"]', '[aria-label="Nueva hoja"]', '[data-tour="actions"] .menu > button', '.tab[aria-label="Ver Papelera"]'];
  for (const point of [center(book), center(prev), ...(await Promise.all(buttons.map((selector) => page.ask('center', selector)))).filter(Boolean)]) {
    await page.click(point.x, point.y);
    await sleep(80);
  }
  await sleep(500);
  await unchanged(page, before, 'clics fuera de lo resaltado en «Pasá de hoja»');
  equal((await tour(page)).count, `2 de ${STEPS}`, 'cambió de paso sin hacer lo pedido');
  // En el paso de escribir, un doble clic fuera de lo resaltado no entra a escribir.
  await page.clickOn('[data-tour="turn-next"]');
  await step(page, `3 de ${STEPS}`);
  const hole = (await tour(page)).hole;
  await page.doubleClick(hole.left + 140, hole.bottom + 160);
  await sleep(500);
  equal((await page.state()).writing, false, 'un doble clic fuera de lo resaltado entró a escribir');
  // Y el clic sobre la franja de la derecha, que queda al lado de lo resaltado, no pasa de hoja.
  const next = await page.ask('center', '[data-tour="turn-next"]');
  const sheet = (await page.state()).sheet;
  await page.click(next.x, next.y);
  await sleep(500);
  equal((await page.state()).sheet, sheet, 'la franja pasó de hoja en el paso de escribir');
});

test('a una hoja, lo resaltado para escribir no llega a la franja de pasar de hoja', async (page) => {
  for (const size of ['standardSingle', 'pocketSingle']) {
    await open(page, size);
    await gotoSheet(page, WRITABLE); // en las del Bloc de notas no hay nada que probar
    await begin(page);
    await goTo(page, 3);
    const hole = (await tour(page)).hole;
    const strip = await page.ask('box', '[data-tour="turn-next"]');
    // Lo que se resalta se ve entero, pero la franja queda para quien la toque sin recorrido.
    check(hole.left < strip.left, `${size}: lo resaltado no empieza antes de la franja`);
    const sheet = (await page.state()).sheet;
    // Un píxel a cada lado del borde de la franja: adentro de ella nada pasa; afuera, tampoco, porque no es parte de lo resaltado.
    for (const x of [strip.left + 1, strip.left + 4, strip.left + 12]) {
      await page.click(x, hole.top + 20);
      await sleep(60);
    }
    await page.doubleClick(strip.left + 8, hole.top + 20, { gap: 60 });
    await sleep(500);
    const after = await page.state();
    equal(after.sheet, sheet, `${size}: un clic al borde de lo resaltado pasó de hoja`);
    equal(after.writing, false, `${size}: un doble clic sobre la franja entró a escribir`);
    // Un clic adentro de lo resaltado, lejos de la franja, no pasa de hoja y el doble clic escribe.
    await page.doubleClick(hole.left + 60, hole.top + 20);
    await page.until(async () => (await page.state()).writing, `${size}: el doble clic sobre lo resaltado no entró a escribir`, 3000);
    equal((await page.state()).sheet, sheet, `${size}: escribir pasó de hoja`);
    await page.key('Escape');
    await page.until(async () => !(await page.state()).writing, `${size}: Esc no terminó de escribir`);
  }
});

test('abrir un menú o un diálogo no rompe el recorrido: se hace a un lado y vuelve', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await goTo(page, 4);
  // El menú de la categoría de la hoja, abierto por afuera del recorrido.
  await page.evaluate(`document.querySelector('.page-head .chip').click()`);
  await page.until(() => page.evaluate(`!!document.querySelector('.menu-list')`), 'el menú de categoría no se abrió');
  await aside(page, 'el recorrido no se hizo a un lado con un menú abierto');
  await page.key('Escape');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.menu-list:not(.leaving)')`)), 'Esc no cerró el menú');
  const state = await shown(page, 'el recorrido no volvió');
  equal(state.count, `4 de ${STEPS}`, 'volvió a otro paso');
});

test('el modo tamaño (Mayús) lo hace a un lado y no lo salta', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await step(page, `1 de ${STEPS}`);
  await page.keyDown('Shift', { shift: true });
  await sleep(500);
  await aside(page, 'el recorrido no se hizo a un lado en el modo tamaño');
  await page.keyUp('Shift');
  await sleep(300);
  const state = await shown(page, 'el recorrido no volvió al terminar el modo tamaño');
  equal(state.count, `1 de ${STEPS}`, 'cambió de paso');
});

// ---- temas -----------------------------------------------------------------------------------

test('en oscuro se ve igual de entero', async (page) => {
  await open(page, 'standard', { prefs: { theme: 'dark' } });
  await begin(page);
  for (let at = 1; at <= STEPS; at++) {
    const state = await step(page, `${at} de ${STEPS}`);
    check(state.balloon.left >= 0 && state.balloon.right <= WINDOW.standard.width, `paso ${at}: el globo se sale`);
    const colors = await page.evaluate(`(() => { const b = getComputedStyle(document.querySelector('.tour-balloon')); const t = getComputedStyle(document.querySelector('.tour-text')); return { back: b.backgroundColor, ink: t.color }; })()`);
    check(colors.back !== colors.ink, `paso ${at}: texto y fondo del mismo color`);
    if (at < STEPS) await page.key('ArrowRight');
  }
});

// ---- bienvenida y cierre (onboarding) --------------------------------------------------------

test('bienvenida: aparece la primera vez, sugiere categorías locales y empieza el recorrido', async (page) => {
  await open(page, 'standard', { welcome: true, tour: true });
  await page.until(() => page.evaluate(`!!document.querySelector('.welcome-card')`), 'la bienvenida no apareció');
  check(!(await tour(page)), 'el globo del recorrido no debe verse mientras está la bienvenida');

  // Sugerencia local en la PC
  await page.clickOn('.welcome-suggest-local');
  await page.until(() => page.evaluate(`!!document.querySelector('.welcome-results')`), 'no aparecieron las sugerencias locales');
  const count = await page.evaluate(`document.querySelectorAll('.welcome-item').length`);
  check(count > 0, 'no se mostraron ítems de categorías sugeridas');

  // Crear categorías y empezar recorrido
  await page.clickOn('.welcome-create-start');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.welcome-overlay')`)), 'la bienvenida no se cerró');

  // El recorrido arranca en el paso 1
  const first = await shown(page, 'el recorrido no arrancó tras crear categorías');
  equal(first.count, `1 de ${STEPS}`, 'el recorrido no empezó en el paso 1');
});

test('bienvenida: sugiere categorías con IA (Ollama) y empieza el recorrido', async (page) => {
  await open(page, 'standard', { welcome: true, tour: true });
  await page.until(() => page.evaluate(`!!document.querySelector('.welcome-card')`), 'la bienvenida no apareció');

  // Cambiar a pestaña IA
  await page.evaluate(`document.querySelectorAll('.welcome-tab')[1].click()`);
  await page.until(() => page.evaluate(`!!document.querySelector('.welcome-suggest-ai')`), 'no se mostró la pestaña IA');

  // Sugerir con IA (Ollama ya viene por defecto con modelo llama3)
  await page.clickOn('.welcome-suggest-ai');
  await page.until(() => page.evaluate(`!!document.querySelector('.welcome-results')`), 'no aparecieron las sugerencias con IA');
  const names = await page.evaluate(`[...document.querySelectorAll('.welcome-item-name')].map(n => n.value || n.textContent)`);
  check(names.includes('Clientes y entregas'), `no se sugirió Clientes y entregas: ${names}`);

  // Crear y empezar
  await page.clickOn('.welcome-create-start');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.welcome-overlay')`)), 'la bienvenida no se cerró');
  const first = await shown(page, 'el recorrido no arrancó tras crear categorías');
  equal(first.count, `1 de ${STEPS}`, 'el recorrido no empezó en el paso 1');
});

test('bienvenida: usar categorías de fábrica empieza el recorrido directo', async (page) => {
  await open(page, 'standard', { welcome: true, tour: true });
  await page.until(() => page.evaluate(`!!document.querySelector('.welcome-card')`), 'la bienvenida no apareció');

  await page.clickOn('.welcome-start-default');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.welcome-overlay')`)), 'la bienvenida no se cerró');
  const first = await shown(page, 'el recorrido no arrancó tras usar categorías de fábrica');
  equal(first.count, `1 de ${STEPS}`, 'el recorrido no empezó en el paso 1');
});

test('bienvenida: saltar todo cierra la bienvenida y no empieza el recorrido', async (page) => {
  await open(page, 'standard', { welcome: true, tour: true });
  await page.until(() => page.evaluate(`!!document.querySelector('.welcome-card')`), 'la bienvenida no apareció');

  await page.clickOn('.welcome-skip');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.welcome-overlay')`)), 'la bienvenida no se cerró');
  await gone(page, 'el recorrido no debió arrancar al saltar todo');

  const seen = await page.evaluate(`({
    welcome: localStorage.getItem('book.welcome'),
    tour: localStorage.getItem('book.tutorial'),
  })`);
  check(seen.welcome && seen.welcome.includes('"version":2'), 'book.welcome no quedó registrado');
  check(seen.tour && seen.tour.includes('"version":2'), 'book.tutorial no quedó registrado');
});

test('outro: al terminar el recorrido con Listo aparece el resumen y se cierra con Empezar', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await goTo(page, 7);

  // En el paso 7, Listo termina el recorrido y abre la pantalla de cierre
  await page.clickOn('.tour-foot button.primary', 'Listo');
  await page.until(() => page.evaluate(`!!document.querySelector('.tour-outro')`), 'la pantalla de cierre no apareció');

  // Verifica que estén las 4 tarjetas
  const cards = await page.evaluate(`document.querySelectorAll('.tour-outro-card').length`);
  equal(cards, 4, 'no están las 4 tarjetas de funciones');

  // Verifica los textos clave
  const text = await page.evaluate(`document.querySelector('.tour-outro').textContent`);
  check(text.includes('Ctrl + Alt + X'), 'no se nombra el atajo de recortes');
  check(text.includes('Clasificación automática con IA') || text.includes('Clasificaci'), 'no se nombra la clasificación con IA');
  check(text.includes('Skills') || text.includes('asistentes'), 'no se nombran las skills');
  check(text.includes('cifrado') || text.includes('secreto'), 'no se nombra el cuaderno secreto');

  // Cerrar con Empezar a usar Book
  await page.clickOn('.outro-done');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.tour-outro-overlay')`)), 'el diálogo de cierre no se cerró');
});

test('outro: abrir Ajustes desde el resumen de cierre abre Ajustes', async (page) => {
  await open(page, 'standard');
  await begin(page);
  await goTo(page, 7);

  await page.clickOn('.tour-foot button.primary', 'Listo');
  await page.until(() => page.evaluate(`!!document.querySelector('.tour-outro')`), 'la pantalla de cierre no apareció');

  await page.clickOn('.outro-settings');
  await page.until(async () => !(await page.evaluate(`!!document.querySelector('.tour-outro-overlay')`)), 'el outro no se cerró al abrir Ajustes');
  await page.until(() => page.evaluate(`!!document.querySelector('.backdrop .modal')`), 'Ajustes no se abrió desde el diálogo de cierre');
});

// ---- correr ---------------------------------------------------------------------------------

const { page, close } = await launch(WINDOW.standard);
let failures = [];
try {
  failures = await run(page);
} finally {
  await close();
}
process.exit(failures.length ? 1 : 0);
