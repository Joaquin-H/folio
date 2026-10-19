// Prueba de estrés de la interfaz, sobre la app real.
//
// Maneja la ventana del cuaderno como lo haría alguien jugando con ella: pasa páginas
// (con el teclado, con un clic en las franjas de los bordes y deslizando sobre el papel),
// cambia entre una y dos hojas y entre los tres tamaños, abre y cierra la tapa, salta a
// la última hoja, filtra por solapas, abre el buscador, abre una hoja nueva y la deja
// sin escribir, entra a escribir con doble clic y sale sin tocar nada... y después de cada
// paso revisa que nada se haya roto (que el cuaderno entre en la ventana y la ventana en
// la pantalla, que las solapas no se salgan, que el texto no pise el encabezado, que las
// franjas de pasar página no tapen ningún botón, que no haya errores de JavaScript).
//
// Los gestos uno por uno (qué pasa página y qué no, el doble clic, la papelera, los
// atajos) se prueban con el mouse y el teclado del navegador en tests/e2e/.
//
// No modifica datos: no crea hojas (las que abre quedan vacías y se descartan solas), no
// escribe en las que abre (entra y sale sin cambiar el texto, así que no se guarda nada) ni
// cambia categorías. Las preferencias que toca
// (tamaño, hojas, solapas) se restauran al terminar. Solo mide; no lee el texto de las notas.
//
// Uso (PowerShell):
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
//   .\src-tauri\target\release\book.exe
//   node tests/stress.mjs [pasos=300] [semilla=1]

const PORT = Number(process.env.BOOK_DEBUG_PORT ?? 9333);
const STEPS = Number(process.argv[2] ?? 300);
const SEED = Number(process.argv[3] ?? 1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- conexión por el protocolo de depuración de WebView2 -------------------

async function connect() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      // La ventana del cuaderno es la que no lleva el parámetro `window`.
      const page = targets.find((t) => t.type === 'page' && !t.url.includes('window='));
      if (page) return page;
    } catch {
      // la app todavía no abrió el puerto
    }
    await sleep(500);
  }
  throw new Error(`No se encontró la ventana de Book en el puerto ${PORT}. ¿Se abrió con el puerto de depuración?`);
}

const page = await connect();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

let nextId = 0;
const pending = new Map();
const jsErrors = [];
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result ?? message.error);
    pending.delete(message.id);
  } else if (message.method === 'Runtime.exceptionThrown') {
    jsErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    jsErrors.push(message.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
  return out.result.value;
};
await send('Runtime.enable');

// ---- lo que corre dentro de la página ---------------------------------------

function install() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const box = (element) => {
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const inside = (inner, outer, slack = 1) =>
    inner.left >= outer.left - slack && inner.right <= outer.right + slack && inner.top >= outer.top - slack && inner.bottom <= outer.bottom + slack;
  const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const prefs = () => JSON.parse(localStorage.getItem('book.prefs') ?? '{}');
  // Windows deja las ventanas minimizadas en (-32000, -32000).
  const minimized = () => screenX <= -30000 && screenY <= -30000;

  /**
   * Espera a que la ventana y el cuaderno dejen de cambiar: sin transiciones en curso
   * y con la ventana ya ajustada a la medida del cuaderno (o hasta agotar la espera).
   */
  async function settle() {
    let last = '';
    for (let i = 0; i < 45; i++) {
      await wait(90);
      const book = $('.book');
      const fitted = book && (minimized() || Math.abs(innerWidth - (book.offsetWidth + 48)) <= 2);
      const now = [innerWidth, innerHeight, book?.offsetWidth, book?.offsetHeight].join();
      if (now === last && fitted && !$('.leaving') && !$('.fading') && !$('.resizing')) return;
      last = now;
    }
  }

  /** Revisa todo lo que tiene que cumplirse siempre. Devuelve la lista de problemas. */
  function check() {
    const problems = [];
    const fail = (text) => problems.push(text);
    const view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const book = $('.book');
    if (!book) return ['no hay cuaderno en pantalla'];
    const p = prefs();
    const tabs = $('.tabs');
    const closed = book.classList.contains('closed');
    const double = book.classList.contains('double');
    const b = box(book);

    // La ventana mide lo que el cuaderno más la franja de mesa. Minimizada no se puede
    // cambiar de tamaño ni de lugar: eso se revisa cuando vuelve.
    const expected = { width: book.offsetWidth + 48, height: book.offsetHeight + (tabs ? 36 : 18) + 32 };
    if (!minimized() && (Math.abs(innerWidth - expected.width) > 2 || Math.abs(innerHeight - expected.height) > 2)) {
      fail(`la ventana mide ${innerWidth}x${innerHeight} y debería medir ${expected.width}x${expected.height}`);
    }
    const ratio = closed || !double ? 0.76 : 1.46;
    const room = { width: screen.availWidth - 48, height: screen.availHeight - (tabs ? 36 : 18) - 32 };
    // "A medida" es el alto que quedó al estirar el cuaderno a mano.
    const nominal = p.size === 'custom' ? p.height : { pocket: 560, standard: 800, full: 4000 }[p.size ?? 'standard'];
    const height = Math.max(360, Math.floor(Math.min(nominal, room.height, room.width / ratio)));
    if (book.offsetHeight !== height || book.offsetWidth !== Math.round(height * ratio)) {
      fail(`el cuaderno mide ${book.offsetWidth}x${book.offsetHeight} y debería medir ${Math.round(height * ratio)}x${height}`);
    }
    // La ventana entera tiene que quedar dentro del área útil de la pantalla.
    const area = { left: screen.availLeft ?? 0, top: screen.availTop ?? 0 };
    if (
      !minimized() &&
      (screenX < area.left - 2 ||
        screenY < area.top - 2 ||
        screenX + outerWidth > area.left + screen.availWidth + 2 ||
        screenY + outerHeight > area.top + screen.availHeight + 2)
    ) {
      fail(`la ventana se sale de la pantalla (en ${screenX},${screenY}, mide ${outerWidth}x${outerHeight})`);
    }
    if (!inside(b, view)) fail('el cuaderno se sale de la ventana');
    if (document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1) {
      fail('la ventana tiene desplazamiento: algo se desborda');
    }
    if (!!tabs !== (p.tabs !== false)) fail('las solapas no coinciden con la preferencia');
    if (tabs) {
      if (tabs.scrollWidth > tabs.clientWidth + 1) fail(`las solapas se desbordan (${tabs.scrollWidth} > ${tabs.clientWidth})`);
      for (const tab of $$('.tab')) {
        const t = box(tab);
        if (t.left < b.left - 1 || t.right > b.right + 1) fail('una solapa se sale del ancho del cuaderno');
        if (t.width < 8) fail('una solapa quedó demasiado angosta');
      }
      if ($$('.tab.active').length !== 1) fail('tiene que haber exactamente una solapa activa');
    }

    if (closed) {
      const cover = $('.cover');
      if (!cover) return [...problems, 'cerrado pero sin tapa'];
      const c = box(cover);
      for (const selector of ['.cover-label', '.cover-name', '.cover-row', '.cover-brand', '.cover-actions']) {
        const element = $(selector);
        if (!element) fail(`falta ${selector} en la tapa`);
        else if (!inside(box(element), c)) fail(`${selector} se sale de la tapa`);
      }
      if ($('.leaves')) fail('cerrado pero con hojas a la vista');
      return problems;
    }

    const leaves = $('.leaves');
    if (!leaves) return [...problems, 'abierto pero sin hojas'];
    const l = box(leaves);
    const pages = $$('.page');
    if (pages.length !== (double ? 2 : 1)) fail(`hay ${pages.length} hojas a la vista y debería haber ${double ? 2 : 1}`);
    for (const pageElement of pages) if (box(pageElement).width < 200) fail('una hoja quedó demasiado angosta');
    if (!!$('.spiral') === double) fail('la espiral solo va en la vista de una hoja');

    const controls = $('.page-controls');
    const actions = $('.page-actions');
    if (!controls || !actions) fail('faltan los botones sobre el papel');
    else {
      if (!inside(box(controls), l) || !inside(box(actions), l)) fail('los botones se salen de la hoja');
      if (overlap(box(controls), box(actions))) fail('los botones de la izquierda y la derecha se pisan');
      // Solo los botones propios: si hay un menú abierto, sus opciones no cuentan.
      const own = $$('.page-actions > button, .page-actions > .menu > button').length;
      if (own !== 3 || $$('.page-controls > button').length !== 2) fail('cantidad de botones inesperada');
    }

    // Leyendo una hoja, las franjas de los bordes pasan página: tienen que estar, dentro
    // de las hojas y sin tapar ningún botón. Escribiendo no hay franjas.
    const zones = $$('.turn-zone');
    const reading = $('.flow-clip:not(.parked)') && !$('.page-text.editing');
    if (reading && !$('.turn-zone.prev')) fail('falta la franja de volver');
    if (!reading && zones.length) fail('hay franjas de pasar página donde no se lee ninguna hoja');
    for (const zone of zones) {
      const z = box(zone);
      if (!inside(z, l)) fail('una franja de pasar página se sale de las hojas');
      if (z.width < 40 || z.width > 100) fail(`una franja de pasar página mide ${Math.round(z.width)}px de ancho`);
      for (const button of $$('.page-controls > button, .page-actions > button, .page-actions > .menu > button')) {
        if (overlap(z, box(button))) fail('una franja de pasar página tapa un botón');
      }
    }

    const clip = $('.flow-clip:not(.parked)');
    const empty = $('.page-empty');
    if (!clip && !empty) fail('la hoja no muestra ni texto ni un estado vacío');
    if (clip) {
      const c = box(clip);
      const flow = $('.flow-clip:not(.parked) .flow');
      if (!inside(c, l)) fail('el texto se sale de las hojas');
      // El alto se mide sin transformaciones: durante la animación de entrada el rectángulo está escalado.
      if (clip.offsetHeight % 28 !== 0 || clip.offsetHeight < 28 * 5) {
        fail(`el área de escritura mide ${clip.offsetHeight}px: no son renglones enteros o son muy pocos`);
      }
      if (flow.offsetWidth < 150) fail(`la columna de texto mide ${flow.offsetWidth}px`);
      // El pie tiene dos partes: el contador de hojas y la página dentro de la nota.
      const foot = $('.page-foot-main')?.textContent ?? '';
      const match = /^Hoja ([\d.]+)(?: de ([\d.]+))?/.exec(foot);
      if (!match) fail(`el pie no dice en qué hoja estamos: "${foot}"`);
      else if (match[2] && Number(match[1].replace(/\./g, '')) > Number(match[2].replace(/\./g, ''))) fail(`el contador se pasó: "${foot}"`);
      for (const footElement of $$('.page-foot')) {
        const pageOf = /^(\d+) de (\d+)$/.exec(footElement.lastElementChild?.textContent ?? '');
        if (pageOf && Number(pageOf[1]) > Number(pageOf[2])) fail(`la página se pasó del total: ${pageOf[0]}`);
        if (!inside(box(footElement), l, 3)) fail('el pie se sale de la hoja');
      }

      const head = $('.page-head');
      const text = $('.flow-clip:not(.parked) .page-text');
      if (!head || !text) fail('falta el encabezado o el texto de la hoja');
      else if (getComputedStyle(head).visibility === 'visible') {
        if (!$('.page-title')?.textContent) fail('la hoja no tiene título');
        // El texto ocupa varias columnas; lo que importa es el hueco que deja al empezar.
        const spacer = $('.flow-clip:not(.parked) .flow-spacer');
        if (!spacer || spacer.offsetHeight < head.offsetHeight) fail('el texto pisa el encabezado');
        if (spacer && spacer.offsetHeight % 28 !== 0) fail('el encabezado no ocupa renglones enteros');
        if (!inside(box(head), l, 3)) fail('el encabezado se sale de la hoja');
      }
    }
    return problems;
  }

  const menu = async (label) => {
    const trigger = $('.page-actions .menu > button') ?? $('.cover-actions .menu > button');
    if (!trigger) return false;
    trigger.click();
    await wait(140);
    const item = $$('.menu-list .menu-item').find((e) => e.querySelector('.menu-label')?.textContent.startsWith(label));
    if (!item) {
      trigger.click();
      return false;
    }
    item.click();
    return true;
  };
  const key = (name, extra = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...extra }));
  // Un clic pasa página solo en las franjas de los bordes de afuera de las hojas.
  const clickPage = (side) => {
    const zone = $(`.turn-zone.${side}`);
    if (!zone) return false;
    const r = zone.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const target = document.elementFromPoint(x, y);
    if (target !== zone) throw new Error(`algo tapa la franja de pasar página (${side})`);
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    return true;
  };
  /** Un punto del papel sin texto ni controles: el pie de la última hoja a la vista. */
  const paperPoint = () => {
    const leaves = $('.leaves');
    if (!leaves || !$('.flow-clip:not(.parked)')) return null;
    const r = leaves.getBoundingClientRect();
    const x = r.right - Math.min(220, r.width / 4);
    const y = r.bottom - 14;
    const target = document.elementFromPoint(x, y);
    return target && target.classList.contains('page') ? { x, y, target } : null;
  };
  // Deslizar: apretar sobre el papel, arrastrar de costado y soltar.
  const swipe = async (direction) => {
    const from = paperPoint();
    if (!from || $('.page-text.editing')) return false;
    const to = from.x + (direction === 'next' ? -150 : 150);
    from.target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: from.x, clientY: from.y }));
    for (let step = 1; step <= 5; step++) {
      const x = from.x + ((to - from.x) * step) / 5;
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, clientX: x, clientY: from.y }));
      await wait(12);
    }
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: to, clientY: from.y }));
    return true;
  };
  const closePanel = async () => {
    // Sin texto escrito, cerrar la hoja nueva no guarda nada.
    key('Escape');
    await wait(260);
  };

  const actions = {
    next: () => key('ArrowRight'),
    prev: () => key('ArrowLeft'),
    clickNext: () => clickPage('next'),
    clickPrev: () => clickPage('prev'),
    swipeNext: () => swipe('next'),
    swipePrev: () => swipe('prev'),
    // Un clic en el medio de la hoja no pasa página ni cierra el cuaderno.
    clickPaper: async () => {
      const point = paperPoint();
      if (!point) return false;
      const before = [$('.page-foot-main')?.textContent, $('.book')?.className].join();
      point.target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: point.x, clientY: point.y }));
      point.target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: point.x, clientY: point.y }));
      await wait(320);
      if ([$('.page-foot-main')?.textContent, $('.book')?.className].join() !== before) throw new Error('un clic en el papel pasó página o cerró el cuaderno');
      return true;
    },
    // Doble clic en el papel: entra a escribir (si la hoja se puede escribir) y se sale sin
    // tocar el texto, así que no se guarda nada.
    writeAndLeave: async () => {
      const point = paperPoint();
      if (!point || $('.page-text.editing')) return false;
      const title = $('.page-head .page-title')?.textContent;
      point.target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: point.x, clientY: point.y }));
      await wait(200);
      const editor = $('.page-text.editing');
      if (!editor) return false; // una hoja que no se escribe desde Book: avisa y sigue en lectura
      if (document.activeElement !== editor) throw new Error('se entró a escribir pero el cursor no quedó en el texto');
      await wait(700);
      if (!$('.page-text.editing')) throw new Error('la escritura se cortó sola');
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(260);
      if ($('.page-text.editing')) throw new Error('Escape no terminó la escritura');
      if ($('.page-head .page-title')?.textContent !== title) throw new Error('al dejar de escribir quedó a la vista otra hoja');
      return true;
    },
    home: () => key('Home'),
    burst: async () => {
      // Pasar páginas a toda velocidad, como con la tecla apretada.
      for (let i = 0; i < 12; i++) {
        key(i % 5 === 4 ? 'ArrowLeft' : 'ArrowRight');
        await wait(15);
      }
    },
    toggleSpread: () => menu('Doble hoja'),
    // Los tres tamaños están a la vista en el menú: se elige uno cualquiera.
    pickSize: async (n) => {
      const trigger = $('.page-actions .menu > button') ?? $('.cover-actions .menu > button');
      if (!trigger) return false;
      trigger.click();
      await wait(140);
      const options = $$('.menu-choices button');
      if (!options.length) {
        trigger.click();
        return false;
      }
      options[n % options.length].click();
      return true;
    },
    end: () => key('End'),
    lastFromMenu: () => menu('Ir a la última hoja'),
    firstFromMenu: () => menu('Ir a la primera hoja'),
    toggleTabs: () => {
      // Como lo haría la ventana de Ajustes: escribe la preferencia y avisa.
      localStorage.setItem('book.prefs', JSON.stringify({ ...prefs(), tabs: prefs().tabs === false }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'book.prefs' }));
    },
    close: () => $('.page-controls button')?.click(),
    open: () => $('.cover')?.click(),
    tab: (n) => {
      const all = $$('.tab');
      all[n % Math.max(1, all.length)]?.click();
    },
    finder: async () => {
      key('f', { ctrlKey: true });
      await wait(260);
      const opened = !!$('.finder');
      await closePanel();
      return opened;
    },
    // Hoja nueva: se abre en el cuaderno lista para escribir; sin texto, al salir se descarta.
    compose: async () => {
      key('n', { ctrlKey: true });
      // Si el cuaderno estaba cerrado, primero se abre: se le da tiempo.
      let editor = null;
      for (let i = 0; i < 20 && !(editor && document.activeElement === editor); i++) {
        await wait(100);
        editor = $('.page-text.editing');
      }
      if (!editor) return false;
      if (document.activeElement !== editor) throw new Error('la hoja nueva no quedó con el cursor');
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(260);
      if ($('.page-text.editing')) throw new Error('Escape no terminó la escritura');
      return true;
    },
    spreadTwice: async () => {
      // Cambiar de modo dos veces seguidas, sin esperar a que la ventana termine de ajustarse.
      await menu('Doble hoja');
      await wait(40);
      await menu('Doble hoja');
    },
    closeOpenFast: async () => {
      $('.page-controls button')?.click();
      await wait(60);
      key('ArrowRight');
      await wait(60);
      $('.cover')?.click();
    },
  };

  window.__stress = {
    prefs,
    async step(name, argument) {
      await actions[name](argument);
      await settle();
      const leftovers = $$('.backdrop').length;
      return {
        problems: [...check(), ...(leftovers ? ['quedó un panel abierto'] : [])],
        window: [innerWidth, innerHeight],
        book: $('.book')?.className,
        minimized: minimized(),
      };
    },
    async restore(saved) {
      if (saved === null) localStorage.removeItem('book.prefs');
      else localStorage.setItem('book.prefs', saved);
      window.dispatchEvent(new StorageEvent('storage', { key: 'book.prefs' }));
      await settle();
      $('.cover')?.click();
      await settle();
      const all = $$('.tab');
      if (all.length && !all[0].classList.contains('active')) all[0].click();
      key('Home');
      await settle();
      return check();
    },
  };
  return true;
}

// ---- recorrido al azar --------------------------------------------------------

// Generador con semilla: la misma semilla repite exactamente la misma secuencia.
let seed = SEED >>> 0;
const random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const WEIGHTED = [
  ['next', 14], ['prev', 8], ['clickNext', 10], ['clickPrev', 6], ['swipeNext', 5], ['swipePrev', 3], ['clickPaper', 4],
  ['writeAndLeave', 4], ['burst', 4], ['home', 2], ['end', 3],
  ['lastFromMenu', 2], ['firstFromMenu', 2],
  ['toggleSpread', 8], ['pickSize', 8], ['toggleTabs', 4], ['spreadTwice', 3],
  ['close', 5], ['open', 7], ['closeOpenFast', 3], ['tab', 8], ['finder', 4], ['compose', 4],
];
const totalWeight = WEIGHTED.reduce((sum, [, weight]) => sum + weight, 0);
const pick = () => {
  let roll = random() * totalWeight;
  for (const [name, weight] of WEIGHTED) if ((roll -= weight) < 0) return name;
  return 'next';
};

for (let attempt = 0; attempt < 60; attempt++) {
  if (await evaluate("!!document.querySelector('.book')")) break;
  await sleep(500);
}
const saved = await evaluate("localStorage.getItem('book.prefs')");
await evaluate(`(${install.toString()})()`);

const failures = [];
const history = [];
const seen = new Set();
const counts = {};
let minimizedSteps = 0;
console.log(`Prueba de estrés: ${STEPS} pasos, semilla ${SEED}`);
try {
  for (let step = 1; step <= STEPS; step++) {
    const name = pick();
    // Muchas categorías pueden estar vacías: se vuelve seguido a "Todas" para probar hojas con texto.
    const argument =
      name === 'tab' ? (random() < 0.6 ? 0 : Math.floor(random() * 12)) : name === 'pickSize' ? Math.floor(random() * 3) : undefined;
    history.push(argument === undefined ? name : `${name}(${argument})`);
    counts[name] = (counts[name] ?? 0) + 1;
    const errorsBefore = jsErrors.length;
    const result = await evaluate(`window.__stress.step(${JSON.stringify(name)}, ${JSON.stringify(argument ?? null)})`);
    if (result.minimized) minimizedSteps++;
    else seen.add(`${result.book} ${result.window.join('x')}`);
    const problems = [...result.problems, ...jsErrors.slice(errorsBefore).map((e) => `error de JavaScript: ${e}`)];
    if (problems.length) {
      failures.push({ step, action: history.at(-1), before: history.slice(-6, -1).join(' → '), problems });
      console.log(`  ✗ paso ${step} (${history.at(-1)}): ${problems.join('; ')}`);
    }
    if (step % 50 === 0) console.log(`  … ${step} pasos, ${failures.length} con problemas`);
  }
} finally {
  // Pase lo que pase, el cuaderno vuelve a quedar como lo tenía el usuario.
  const after = await evaluate(`window.__stress.restore(${JSON.stringify(saved)})`);
  if (after.length) failures.push({ step: 'final', action: 'restaurar', before: '', problems: after });
}

console.log('\nAcciones ejecutadas:', Object.entries(counts).map(([name, n]) => `${name}×${n}`).join(', '));
console.log('Estados distintos visitados (cuaderno y ventana):');
for (const state of [...seen].sort()) console.log('  ' + state);
if (minimizedSteps) {
  console.log(`\nLa ventana estuvo minimizada durante ${minimizedSteps} pasos: en esos no se revisó su tamaño ni su posición.`);
}
if (failures.length === 0) {
  console.log(`\nSin problemas en ${STEPS} pasos.`);
} else {
  console.log(`\n${failures.length} pasos con problemas:`);
  for (const failure of failures.slice(0, 20)) {
    console.log(`  paso ${failure.step}: ${failure.action}  (antes: ${failure.before})`);
    for (const problem of failure.problems) console.log(`      - ${problem}`);
  }
}
ws.close();
process.exit(failures.length ? 1 : 0);
