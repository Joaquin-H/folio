// Arnés de las pruebas de punta a punta de la interfaz.
//
// Levanta la interfaz con datos de muestra (Vite) y un Edge sin ventana, y lo maneja por
// el protocolo de depuración con el mouse y el teclado del navegador (Input.dispatch…):
// los clics pasan por donde pasan los de una persona, con su selección de texto, su foco
// y su doble clic. Sin dependencias: alcanza con el WebSocket y el fetch de Node 22.
//
// Puertos y navegador se cambian por variables de entorno:
//   BOOK_E2E_PORT        puerto de Vite (1432)
//   BOOK_E2E_DEBUG_PORT  puerto de depuración de Edge (9342)
//   BOOK_E2E_BROWSER     ruta de msedge.exe (o de un Chrome)
//   BOOK_E2E_URL         interfaz ya levantada: no se arranca Vite

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VITE_PORT = Number(process.env.BOOK_E2E_PORT ?? 1432);
const DEBUG_PORT = Number(process.env.BOOK_E2E_DEBUG_PORT ?? 9342);
const BROWSER = process.env.BOOK_E2E_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const GIVEN_URL = process.env.BOOK_E2E_URL;

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Espera a que `probe` devuelva algo verdadero; si no pasa a tiempo, falla con `what`. */
async function until(probe, what, timeout = 30_000, every = 150) {
  const limit = Date.now() + timeout;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // todavía no responde
    }
    if (Date.now() > limit) throw new Error(`Se agotó la espera: ${what}`);
    await sleep(every);
  }
}

// ---- lo que se abre (y se cierra al terminar) ----------------------------------

function startVite() {
  const output = [];
  const child = spawn(
    process.execPath,
    // Lo mismo que `pnpm exec vite --port … --strictPort`, sin pasar por la consola:
    // así, al terminar, alcanza con cerrar este único proceso.
    [join(ROOT, 'node_modules/vite/bin/vite.js'), '--config', join(ROOT, 'tests/e2e/vite.config.mjs'), '--port', String(VITE_PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  return { child, output };
}

async function startBrowser(profile, width, height) {
  const child = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const target = await until(
    async () => (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find((t) => t.type === 'page'),
    `Edge no abrió el puerto de depuración ${DEBUG_PORT}`,
  );
  return { child, target };
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

async function stop(child) {
  if (!child || exited(child)) return;
  const gone = new Promise((done) => child.once('exit', done));
  child.kill();
  await Promise.race([gone, sleep(4000)]);
}

// ---- teclado -------------------------------------------------------------------

const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Space: { code: 'Space', vk: 32, text: ' ' },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  End: { code: 'End', vk: 35 },
  Home: { code: 'Home', vk: 36 },
  F2: { code: 'F2', vk: 113 },
  Shift: { code: 'ShiftLeft', vk: 16 },
  Comma: { code: 'Comma', vk: 188, text: ',' },
  ',': { code: 'Comma', vk: 188, text: ',' },
  Period: { code: 'Period', vk: 190, text: '.' },
  '.': { code: 'Period', vk: 190, text: '.' },
  Minus: { code: 'Minus', vk: 189, text: '-' },
  '-': { code: 'Minus', vk: 189, text: '-' },
};

function keyInfo(key) {
  if (KEYS[key]) return { key, ...KEYS[key] };
  if (/^[a-z]$/i.test(key)) return { key, code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key };
  if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, vk: key.charCodeAt(0), text: key };
  throw new Error(`Tecla sin definir en el arnés: ${key}`);
}

// ---- lo que corre dentro de la página ------------------------------------------

/** Ayudas para mirar el cuaderno desde adentro; quedan en `window.__e2e`. */
function install() {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const box = (element) => {
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const reader = () => $('.flow-clip:not(.parked) .page-text');

  /** Rectángulo de un carácter del texto a la vista. */
  const charBox = (offset) => {
    const node = reader()?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, Math.min(node.length, offset + 1));
    const rect = [...range.getClientRects()].find((r) => r.width > 0 && r.height > 0);
    return rect ? box({ getBoundingClientRect: () => rect }) : null;
  };

  window.__e2e = {
    /** Dónde está el cuaderno y en qué anda. */
    state() {
      const foot = $('.page-foot-main')?.textContent ?? '';
      const sheet = /^(?:Hoja|Sheet) ([\d.,]+)/.exec(foot);
      const pages = $$('.page-foot > span:last-child').map((e) => e.textContent).filter(Boolean);
      const editor = $('.page-text.editing');
      const selection = getSelection();
      return {
        closed: !!$('.book.closed'),
        open: !!$('.leaves'),
        sheet: sheet ? Number(sheet[1].replace(/[.,]/g, '')) : null,
        page: pages[0] ?? null,
        title: $('.page-head .page-title input')?.value ?? $('.page-head .page-title')?.textContent ?? null,
        writing: !!editor,
        focusInEditor: !!editor && document.activeElement === editor,
        caret: editor && selection && editor.contains(selection.focusNode) ? selection.focusOffset : null,
        selected: selection ? String(selection) : '',
        mode: $('.page-mode')?.textContent ?? null,
        text: (editor ?? reader())?.textContent ?? null,
        toast: $('.toast')?.textContent ?? null,
        dialog: $('.backdrop [role="alertdialog"], .backdrop [role="dialog"]')?.getAttribute('aria-label') ?? null,
        busy: !!$('.fading, .leaving, .resizing, .spin'),
        tab: $('.tab.active')?.getAttribute('aria-label') ?? null,
        empty: $('.page-empty h2')?.textContent ?? null,
      };
    },
    box: (selector) => {
      const element = $(selector);
      return element ? box(element) : null;
    },
    boxes: (selector) => $$(selector).map(box),
    /** Centro del primer elemento que coincide y, si se pide, cuyo texto contiene `text`. */
    center(selector, text) {
      const element = $$(selector).find((e) => text === undefined || text === null || (e.textContent ?? '').includes(text));
      if (!element) return null;
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = element.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    count: (selector) => $$(selector).length,
    /** Qué hay bajo ese punto y con qué cursor. */
    at(x, y) {
      const element = document.elementFromPoint(x, y);
      return element ? { tag: element.tagName.toLowerCase(), classes: element.className, cursor: getComputedStyle(element).cursor } : null;
    },
    /** Centro de la primera aparición de `word` en el texto a la vista. */
    word(word) {
      const start = (reader()?.textContent ?? '').indexOf(word);
      if (start < 0) return null;
      const first = charBox(start);
      const last = charBox(start + word.length - 1);
      return first && last ? { x: (first.left + last.right) / 2, y: (first.top + first.bottom) / 2, start, end: start + word.length } : null;
    },
    /** Rectángulo del último carácter dibujado del texto. */
    lastChar() {
      const text = reader()?.textContent ?? '';
      for (let offset = text.length - 1; offset >= 0; offset--) {
        const rect = charBox(offset);
        if (rect) return rect;
      }
      return null;
    },
    charBox,
    label: (selector) => $(selector)?.textContent ?? null,
    labels: (selector) => $$(selector).map((e) => e.textContent),
    focused: () => document.activeElement?.textContent ?? null,
  };
}

// ---- el navegador, manejado desde afuera ---------------------------------------

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    ws.addEventListener('open', done);
    ws.addEventListener('error', () => fail(new Error('No se pudo conectar con el navegador')));
  });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { done, fail, method } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(`${method}: ${message.error.message}`));
      else done(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      errors.push(details.exception?.description ?? details.text);
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400));
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      const { text, url } = message.params.entry;
      // El ícono de la pestaña no existe en desarrollo: no es un error de la interfaz.
      if (!/favicon/.test(`${text} ${url ?? ''}`)) errors.push(`${text} ${url ?? ''}`.trim());
    }
  });
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = ++nextId;
      pending.set(id, { done, fail, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, errors };
}

/**
 * Abre todo y devuelve la página lista para manejar. `close()` cierra lo que se abrió
 * (el navegador, su perfil temporal y el servidor), pase lo que pase con las pruebas.
 */
export async function launch({ width = 1280, height = 900 } = {}) {
  const opened = { vite: null, browser: null, profile: null, ws: null, visits: 0 };
  const close = async () => {
    try {
      opened.ws?.close();
    } catch {
      // ya estaba cerrado
    }
    await stop(opened.browser);
    await stop(opened.vite?.child);
    // Edge tarda un instante en soltar los archivos de su perfil.
    for (let tries = 0; opened.profile && tries < 8; tries++) {
      try {
        await rm(opened.profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(400);
      }
    }
  };

  try {
    const base = GIVEN_URL ?? `http://localhost:${VITE_PORT}/`;
    if (!GIVEN_URL) {
      opened.vite = startVite();
      await until(
        async () => {
          if (exited(opened.vite.child)) throw new Error(`Vite no arrancó:\n${opened.vite.output.join('')}`);
          return (await fetch(base)).ok;
        },
        `Vite no respondió en ${base}\n${opened.vite.output.join('')}`,
        60_000,
      ).catch((reason) => {
        throw exited(opened.vite.child) ? new Error(`Vite no arrancó (¿el puerto ${VITE_PORT} está ocupado?):\n${opened.vite.output.join('')}`) : reason;
      });
    }
    opened.profile = await mkdtemp(join(tmpdir(), 'book-e2e-'));
    const browser = await startBrowser(opened.profile, width, height);
    opened.browser = browser.child;
    const { ws, send, errors } = await connect(browser.target);
    opened.ws = ws;
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${install.toString()})()` });

    let prefsScript = null;
    let mouse = { x: 0, y: 0 };
    const evaluate = async (expression) => {
      const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
      return out.result.value;
    };
    /** Llama a una de las ayudas de `window.__e2e` con esos argumentos. */
    const ask = (name, ...args) => evaluate(`window.__e2e.${name}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
    const mouseEvent = (type, x, y, extra = {}) => {
      mouse = { x, y };
      return send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, pointerType: 'mouse', ...extra });
    };
    const modifiers = (mods = {}) => (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);

    const page = {
      errors,
      send,
      evaluate,
      ask,
      sleep,
      state: () => ask('state'),
      until: (probe, what, timeout = 5000) => until(probe, what, timeout, 60),

      /**
       * Carga el cuaderno con esa ventana y esas preferencias. Los datos de muestra viven
       * en la página: cada carga arranca con las mismas hojas. El recorrido de la primera
       * vez no aparece (se lo marca como visto antes de cargar), salvo con `tour: true`:
       * entonces la primera carga lo ve como una persona que abre Book por primera vez, y
       * las recargas siguientes ya no (lo que el recorrido guardó queda guardado). Con un
       * texto en `tour`, eso es lo que queda guardado de entrada (para probar datos viejos o rotos).
       */
      async open({ width: w = width, height: h = height, prefs = {}, query = '', tour = false, welcome = false } = {}) {
        await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h });
        if (prefsScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: prefsScript });
        // El idioma va fijo en español: las pruebas están escritas en español y no dependen del idioma del navegador.
        const saved = JSON.stringify({ theme: 'light', lang: 'es', tabs: true, spread: 'double', size: 'standard', sounds: false, ...prefs });
        // Con `tour`, el estado inicial se pone una vez por apertura (no por recarga): el marcador va en la sesión de la pestaña.
        const initial = typeof tour === 'string' ? `localStorage.setItem('book.tutorial', ${JSON.stringify(tour)});` : `localStorage.removeItem('book.tutorial');`;
        const seen = tour
          ? `if (sessionStorage.getItem('__e2e_tour') !== '${++opened.visits}') { ${initial} sessionStorage.setItem('__e2e_tour', '${opened.visits}'); }`
          : `localStorage.setItem('book.tutorial', JSON.stringify({ version: 9999 }));`;
        const welcomeInitial = typeof welcome === 'string' ? `localStorage.setItem('book.welcome', ${JSON.stringify(welcome)});` : `localStorage.removeItem('book.welcome');`;
        const welcomeSeen = welcome
          ? `if (sessionStorage.getItem('__e2e_welcome') !== '${opened.visits}') { ${welcomeInitial} sessionStorage.setItem('__e2e_welcome', '${opened.visits}'); }`
          : `localStorage.setItem('book.welcome', JSON.stringify({ version: 9999 }));`;
        prefsScript = (
          await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('book.prefs', ${JSON.stringify(saved)}); ${seen} ${welcomeSeen}` })
        ).identifier;
        await send('Page.navigate', { url: `${base}${query}` });
        await until(() => evaluate(`!!window.__e2e && !!document.querySelector(${JSON.stringify(query ? '#root > *' : '.book')})`), 'la interfaz no cargó', 30_000);
        if (query) return;
        await until(async () => (await ask('state')).sheet === 1 && !(await ask('state')).busy, 'el cuaderno no mostró su primera hoja', 15_000);
        await evaluate('document.fonts.ready.then(() => true)');
        // La animación de entrada del cuaderno lo achica apenas: que termine antes de medir.
        await sleep(320);
      },

      /** Espera a que no quede ninguna transición del cuaderno en curso. */
      async settle(extra = 300) {
        await until(async () => !(await ask('state')).busy, 'el cuaderno no terminó de acomodarse', 5000);
        await sleep(extra);
      },

      move: (x, y) => mouseEvent('mouseMoved', x, y),
      async click(x, y, mods) {
        await mouseEvent('mouseMoved', x, y);
        await mouseEvent('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1, modifiers: modifiers(mods) });
        await mouseEvent('mouseReleased', x, y, { button: 'left', clickCount: 1, modifiers: modifiers(mods) });
      },
      /** Clic en el medio de un elemento (el primero que coincide; con `text`, el que lo contiene). */
      async clickOn(selector, text) {
        const point = await ask('center', selector, text ?? null);
        if (!point) throw new Error(`No está en pantalla: ${selector}${text ? ` «${text}»` : ''}`);
        await page.click(point.x, point.y);
      },
      /** Doble clic, con `gap` milisegundos entre el primer clic y el segundo. */
      async doubleClick(x, y, { gap = 80 } = {}) {
        await mouseEvent('mouseMoved', x, y);
        await mouseEvent('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
        await mouseEvent('mouseReleased', x, y, { button: 'left', clickCount: 1 });
        await sleep(gap);
        await mouseEvent('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 2 });
        await mouseEvent('mouseReleased', x, y, { button: 'left', clickCount: 2 });
      },
      /** Aprieta en `from`, arrastra hasta `to` y suelta. `hold` es la pausa antes de soltar. */
      async drag(from, to, { steps = 10, pause = 12, hold = 0, release = true, mods } = {}) {
        await mouseEvent('mouseMoved', from.x, from.y);
        await mouseEvent('mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1, modifiers: modifiers(mods) });
        for (let step = 1; step <= steps; step++) {
          const x = from.x + ((to.x - from.x) * step) / steps;
          const y = from.y + ((to.y - from.y) * step) / steps;
          await mouseEvent('mouseMoved', x, y, { button: 'left', buttons: 1, modifiers: modifiers(mods) });
          await sleep(pause);
        }
        if (hold) await sleep(hold);
        if (release) await mouseEvent('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1, modifiers: modifiers(mods) });
      },
      /** Con el botón ya apretado (un `drag` sin soltar), sigue arrastrando hasta `to`. */
      async slide(to, { steps = 10, pause = 12 } = {}) {
        const from = { ...mouse };
        for (let step = 1; step <= steps; step++) {
          await mouseEvent('mouseMoved', from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps, { button: 'left', buttons: 1 });
          await sleep(pause);
        }
      },
      release: (mods) => mouseEvent('mouseReleased', mouse.x, mouse.y, { button: 'left', clickCount: 1, modifiers: modifiers(mods) }),
      wheel: (x, y, deltaY) => mouseEvent('mouseWheel', x, y, { deltaX: 0, deltaY }),

      async key(key, mods = {}) {
        const info = keyInfo(key);
        if (mods.ctrl && !mods.alt && ['KeyN', 'KeyW', 'KeyT'].includes(info.code)) {
          await evaluate(
            `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(info.key)}, code: ${JSON.stringify(info.code)}, ctrlKey: true, shiftKey: ${!!mods.shift}, bubbles: true, cancelable: true }))`,
          );
          return;
        }
        const plain = !mods.ctrl && !mods.alt && !mods.meta;
        const text = plain && info.text ? (mods.shift ? info.text.toUpperCase() : info.text) : undefined;
        const common = { key: info.key, code: info.code, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk, modifiers: modifiers(mods) };
        await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...common, ...(text ? { text, unmodifiedText: text } : {}) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
      },
      /** Mantiene una tecla apretada hasta que se la suelte con `keyUp`. */
      keyDown: (key, mods = {}, repeat = false) => {
        const info = keyInfo(key);
        return send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: info.key,
          code: info.code,
          windowsVirtualKeyCode: info.vk,
          modifiers: modifiers(mods),
          autoRepeat: repeat,
        });
      },
      keyUp: (key, mods = {}) => {
        const info = keyInfo(key);
        return send('Input.dispatchKeyEvent', { type: 'keyUp', key: info.key, code: info.code, windowsVirtualKeyCode: info.vk, modifiers: modifiers(mods) });
      },
      /** Escribe como con el teclado, en donde esté el cursor. */
      type: (text) => send('Input.insertText', { text }),

      /** Guarda una captura de la página, para mirar qué pasó. */
      async screenshot(file) {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        await writeFile(file, Buffer.from(data, 'base64'));
      },
    };
    return { page, close };
  } catch (reason) {
    await close();
    throw reason;
  }
}

// ---- las pruebas ---------------------------------------------------------------

export function check(condition, message) {
  if (!condition) throw new Error(message);
}

export function equal(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: se esperaba ${JSON.stringify(expected)} y fue ${JSON.stringify(actual)}`);
}

/**
 * Junta las pruebas y las corre en orden. Cada una recibe la página; si tira un error,
 * falla y se sigue con la próxima. Con un argumento en la línea de comandos corren solo
 * las que lo contienen en el nombre (varios, separados por comas).
 */
export function suite() {
  const cases = [];
  return {
    test: (name, run) => cases.push({ name, run }),
    async run(page, only = process.argv[2]) {
      const failures = [];
      const words = (only ?? '').toLowerCase().split(',').map((word) => word.trim()).filter(Boolean);
      const wanted = words.length ? cases.filter((c) => words.some((word) => c.name.toLowerCase().includes(word))) : cases;
      for (const { name, run } of wanted) {
        const before = page.errors.length;
        const started = Date.now();
        let failure = null;
        try {
          await run(page);
        } catch (reason) {
          failure = reason instanceof Error ? reason.message : String(reason);
        }
        const logged = page.errors.slice(before);
        if (!failure && logged.length) failure = `errores en la consola: ${logged.join(' | ')}`;
        const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
        if (failure) {
          failures.push({ name, failure });
          console.log(`  ✗ ${name} (${took})\n      ${failure.split('\n').join('\n      ')}`);
        } else {
          console.log(`  ✓ ${name} (${took})`);
        }
      }
      console.log(failures.length ? `\n${failures.length} de ${wanted.length} pruebas fallaron.` : `\nPasaron las ${wanted.length} pruebas.`);
      return failures;
    },
  };
}
