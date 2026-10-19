// Generador de capturas PNG de alta resolución y GIFs animados de la interfaz de Book.
// Utiliza el arnés de pruebas e2e (headless Edge + Vite) y ffmpeg para generar
// medios reales en inglés, con transiciones fluidas a 20 fps y paleta optimizada.
//
// Puertos exclusivos asignados para E2E:
//   BOOK_E2E_PORT=1476
//   BOOK_E2E_DEBUG_PORT=9386

import { execFile } from 'node:child_process';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_DIR = join(ROOT, 'docs', 'media');
const FRAMES_DIR = join(ROOT, 'docs', '.frames-temp');

process.env.BOOK_E2E_PORT = process.env.BOOK_E2E_PORT ?? '1476';
process.env.BOOK_E2E_DEBUG_PORT = process.env.BOOK_E2E_DEBUG_PORT ?? '9386';

import { launch, sleep } from '../tests/e2e/harness.mjs';

/**
 * Ejecuta ffmpeg para convertir una secuencia de frames PNG en un GIF animado fluido (20 fps)
 * con interpolación suave de movimiento (minterpolate blend) y paleta global sin granulado feo.
 */
async function framesToGif(pattern, outFile, inFps = 12, outFps = 20) {
  const filter = `[0:v] minterpolate=fps=${outFps}:mi_mode=blend,split [a][b];[a] palettegen=max_colors=256:reserve_transparent=on:stats_mode=full [p];[b][p] paletteuse=dither=sierra2_4a`;
  await execFileAsync('ffmpeg', [
    '-y',
    '-framerate', String(inFps),
    '-i', pattern,
    '-filter_complex', filter,
    outFile,
  ]);
}

/** Limpia y crea la carpeta de frames temporales. */
async function resetFramesDir() {
  await rm(FRAMES_DIR, { recursive: true, force: true });
  await mkdir(FRAMES_DIR, { recursive: true });
}

/**
 * Traduce las categorías y notas de muestra del mock al inglés para que todas las capturas
 * y GIFs del README principal estén 100% en inglés (UI + pestañas + contenido de las hojas).
 */
async function seedEnglishData(page) {
  await page.evaluate(`import('/src/mock.ts').then(({ seedMockEnglish }) => seedMockEnglish())`);
  await page.settle(150);
  await page.key('ArrowRight');
  await page.settle(100);
  await page.key('Home');
  await page.settle(200);
}

/** Crea un grabador de cuadros para una secuencia fluida. */
function makeRecorder() {
  let frame = 0;
  const snap = async (page, repeats = 1) => {
    frame++;
    const path = join(FRAMES_DIR, `frame_${String(frame).padStart(4, '0')}.png`);
    await page.screenshot(path);
    for (let i = 1; i < repeats; i++) {
      frame++;
      const copyPath = join(FRAMES_DIR, `frame_${String(frame).padStart(4, '0')}.png`);
      await copyFile(path, copyPath);
    }
  };
  const burst = async (page, count = 4, gapMs = 45) => {
    for (let i = 0; i < count; i++) {
      await snap(page, 1);
      if (gapMs > 0) await sleep(gapMs);
    }
  };
  return { snap, burst };
}

/** Cierra el cuaderno por el frente y espera a que la tapa quede visible. */
async function closeToFront(page) {
  await page.key('Home');
  await page.settle(180);
  await page.key('ArrowLeft');
  await page.until(
    async () => (await page.evaluate("document.querySelector('.book.closed')?.dataset.face")) === 'front',
    'la tapa no se cerró mostrando el frente',
    8000,
  );
  await page.settle(250);
}

/**
 * 1. HERO NOTEBOOK GIF (docs/media/hero-notebook.gif)
 * - Tapa de cuero cerrada con título en inglés ("My notebook" / "18 sheets")
 * - Clic en la tapa -> ráfaga de frames abriendo el cuaderno a doble hoja en inglés
 * - Filtra por la solapa "Work" arriba -> muestra las notas de trabajo
 * - Pasa de hoja a "team-sync.md" con formato Markdown
 */
async function captureHeroNotebook(page) {
  console.log('\n[1/5] Generando docs/media/hero-notebook.gif (English, smooth 20 fps)...');
  await resetFramesDir();
  const { snap, burst } = makeRecorder();

  await page.open({
    width: 1280,
    height: 900,
    prefs: {
      coverStyle: 'leather',
      cover: '#1E3558',
      name: 'My Notebook',
      theme: 'light',
      spread: 'double',
      size: 'standard',
      tabs: true,
      lang: 'en',
    },
  });

  await seedEnglishData(page);
  await closeToFront(page);

  // Tapa cerrada (~0.8s)
  await snap(page, 10);

  // Clic en la tapa y captura de la transición de apertura
  const coverBox = await page.ask('box', '.cover');
  await page.click(coverBox.left + coverBox.width / 2, coverBox.top + coverBox.height * 0.5);
  await burst(page, 5, 45);
  await page.until(async () => (await page.state()).open, 'el cuaderno no abrió');
  await page.settle(200);

  // Cuaderno abierto a doble hoja mostrando notas en inglés (~1.1s)
  await snap(page, 13);

  // Clic en la solapa 'Work' arriba del cuaderno
  await page.clickOn('.tab', 'Work');
  await burst(page, 4, 45);
  await page.settle(200);

  // Vista filtrada por 'Work' (~0.9s)
  await snap(page, 11);

  // Pasar a la hoja siguiente (team-sync.md) capturando la animación
  await page.key('ArrowRight');
  await burst(page, 5, 45);
  await page.settle(200);

  // Nota Markdown formateada (~1.2s)
  await snap(page, 14);

  const outFile = join(MEDIA_DIR, 'hero-notebook.gif');
  await framesToGif(join(FRAMES_DIR, 'frame_%04d.png'), outFile, 12, 20);
  console.log(`  ✓ Creado: ${outFile}`);
}

/**
 * 2. WRITING MARKDOWN GIF (docs/media/writing-markdown.gif)
 * - Muestra nota .md en inglés ("Visual Notebook Roadmap")
 * - Marca una casilla interactiva ("Tables aligned to paper rules")
 * - Doble clic para entrar a modo "Writing" con barra de formato y micrófono
 * - Escribe una tarea paso a paso de forma fluida
 * - Toca "Done" y vuelve a la vista con formato sobre el papel rayado
 */
async function captureWritingMarkdown(page) {
  console.log('\n[2/5] Generando docs/media/writing-markdown.gif (English, smooth 20 fps)...');
  await resetFramesDir();
  const { snap, burst } = makeRecorder();

  await page.open({
    width: 1280,
    height: 900,
    prefs: {
      coverStyle: 'plain',
      theme: 'light',
      spread: 'double',
      size: 'standard',
      markdown: true,
      lang: 'en',
    },
  });

  await seedEnglishData(page);

  await page.key('End');
  await page.until(
    async () => (await page.state()).title === 'Visual Notebook Roadmap',
    'no llegó a Visual Notebook Roadmap',
    8000,
  );
  await page.settle(250);

  // Vista Markdown inicial (~0.8s)
  await snap(page, 10);

  // Marcar casilla interactiva
  const checkPos = await page.evaluate(`(() => {
    const li = [...document.querySelectorAll('.flow-clip:not(.parked) li')].find((el) => el.textContent.includes('Tables aligned'));
    const check = li?.querySelector('.md-check');
    if (!check) return null;
    const r = check.getBoundingClientRect();
    return { x: r.left + 10, y: r.top + r.height / 2 };
  })()`);

  if (checkPos) {
    await page.click(checkPos.x, checkPos.y);
    await burst(page, 3, 50);
    await snap(page, 8);
  }

  // Doble clic para entrar al modo Writing
  const leaves = await page.ask('box', '.leaves');
  await page.doubleClick(leaves.left + leaves.width * 0.45, leaves.top + leaves.height * 0.36);
  await page.until(async () => (await page.state()).writing, 'no entró al modo escritura');
  await burst(page, 3, 45);

  // Mostrar el banner "Writing" + barra de herramientas + micrófono
  await snap(page, 9);

  // Escribir una línea paso a paso para que se vea escribir con fluidez
  await page.key('End');
  await page.key('Enter');
  const chunks = ['- [x] ', 'Smooth ', 'live ', 'Markdown ', 'editing'];
  for (const chunk of chunks) {
    await page.type(chunk);
    await sleep(40);
    await snap(page, 2);
  }
  await snap(page, 7);

  // Guardar tocando "Done"
  await page.clickOn('.page-mode.edit-banner button', 'Done');
  await page.until(async () => !(await page.state()).writing, 'no salió del modo escritura');
  await burst(page, 3, 45);

  // Vista formateada final con la nueva tarea marcada (~1.1s)
  await snap(page, 13);

  const outFile = join(MEDIA_DIR, 'writing-markdown.gif');
  await framesToGif(join(FRAMES_DIR, 'frame_%04d.png'), outFile, 12, 20);
  console.log(`  ✓ Creado: ${outFile}`);
}

/**
 * 3. COVERS & THEMES GIF (docs/media/covers-themes.gif)
 * - Muestra las tapas realistas en inglés (Classic, Spots, Strap ya arreglada, Fabric spine, Stitched leather)
 * - Cuaderno abierto en tema claro, tema oscuro y modo de 1 hoja con espiral metálico
 */
async function captureCoversThemes(page) {
  console.log('\n[3/5] Generando docs/media/covers-themes.gif (English, smooth 20 fps)...');
  await resetFramesDir();
  const { snap } = makeRecorder();

  await page.open({
    width: 1280,
    height: 900,
    prefs: {
      coverStyle: 'plain',
      cover: null,
      name: 'My Notebook',
      theme: 'light',
      spread: 'double',
      size: 'standard',
      tabs: true,
      lang: 'en',
    },
  });
  await seedEnglishData(page);
  await closeToFront(page);

  const coverStyles = [
    { coverStyle: 'plain', cover: null },
    { coverStyle: 'spots', cover: '#2B2C31' },
    { coverStyle: 'strap', cover: '#6E2433' },
    { coverStyle: 'spine', cover: '#1F4D3A' },
    { coverStyle: 'leather', cover: '#B59A76' },
    { coverStyle: 'leather', cover: '#1E3558' },
  ];

  for (const style of coverStyles) {
    await page.evaluate(`(() => {
      const raw = JSON.parse(localStorage.getItem('book.prefs') || '{}');
      Object.assign(raw, ${JSON.stringify(style)}, { name: 'My Notebook', lang: 'en' });
      localStorage.setItem('book.prefs', JSON.stringify(raw));
      window.dispatchEvent(new StorageEvent('storage', { key: 'book.prefs' }));
    })()`);
    await page.settle(200);
    await snap(page, 8);
  }

  // Pegar dos pegatinas (stickers) sobre la tapa y mostrar el modo de acomodado (arranging)
  await page.evaluate(`(async () => {
    const makeSticker = async (kind) => {
      const canvas = document.createElement('canvas');
      canvas.width = 240;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      if (kind === 'sun') {
        ctx.fillStyle = '#F59E0B';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.arc(120, 120, 82, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#FFFBEB';
        ctx.font = 'bold 34px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('LOCAL', 120, 108);
        ctx.font = 'bold 26px Inter, sans-serif';
        ctx.fillText('FIRST', 120, 144);
      } else {
        ctx.fillStyle = '#10B981';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.roundRect(24, 54, 192, 132, 26);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 36px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('.md / .txt', 120, 122);
      }
      const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
      const data = new DataTransfer();
      data.items.add(new File([blob], kind + '.png', { type: 'image/png' }));
      const input = document.querySelector('.cover input[type=file]');
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    await makeSticker('sun');
  })()`);
  await page.until(async () => (await page.ask('count', '.cover .sticker')) === 1, 'no se pegó el primer sticker');
  await page.settle(250);
  // Mostrar el sticker seleccionado con sus manijas de rotar y redimensionar y el cartel "Arranging images · Done"
  await snap(page, 11);

  // Rotar y mover un poco el sticker para que se vea vivo
  await page.evaluate(`(() => {
    const list = JSON.parse(localStorage.getItem('book.stickers') || '[]');
    if (list[0]) {
      list[0].x = 0.72;
      list[0].y = 0.68;
      list[0].turn = -11;
      localStorage.setItem('book.stickers', JSON.stringify(list));
      window.dispatchEvent(new StorageEvent('storage', { key: 'book.stickers' }));
    }
  })()`);
  await page.settle(180);
  await snap(page, 8);

  // Terminar de acomodar con Escape para que quede pegado en la tapa
  await page.key('Escape');
  await page.settle(200);
  await snap(page, 9);

  // Abrir el cuaderno a doble hoja en tema claro
  const coverBox = await page.ask('box', '.cover');
  await page.click(coverBox.left + coverBox.width / 2, coverBox.top + coverBox.height * 0.5);
  await page.until(async () => (await page.state()).open, 'no abrió el cuaderno');
  await page.settle(250);
  await snap(page, 10);

  // Cambiar en vivo a tema oscuro
  await page.evaluate(`(() => {
    const raw = JSON.parse(localStorage.getItem('book.prefs') || '{}');
    Object.assign(raw, { theme: 'dark', lang: 'en' });
    localStorage.setItem('book.prefs', JSON.stringify(raw));
    window.dispatchEvent(new StorageEvent('storage', { key: 'book.prefs' }));
  })()`);
  await page.settle(250);
  await snap(page, 10);

  // Cambiar a vista de 1 hoja con espiral metálico en tema claro
  await page.evaluate(`(() => {
    const raw = JSON.parse(localStorage.getItem('book.prefs') || '{}');
    Object.assign(raw, { theme: 'light', spread: 'single', lang: 'en' });
    localStorage.setItem('book.prefs', JSON.stringify(raw));
    window.dispatchEvent(new StorageEvent('storage', { key: 'book.prefs' }));
  })()`);
  await page.settle(250);
  await snap(page, 10);

  const outFile = join(MEDIA_DIR, 'covers-themes.gif');
  await framesToGif(join(FRAMES_DIR, 'frame_%04d.png'), outFile, 12, 20);
  console.log(`  ✓ Creado: ${outFile}`);
}

/**
 * 4. AI INTEGRATIONS GIF (docs/media/ai-integrations.gif)
 * - Muestra Ajustes en inglés recorriendo:
 *   1. Classifier (Jev, Claude, OpenAI, Gemini, Ollama local)
 *   2. Categories (sugerencia de categorías en inglés)
 *   3. Shortcuts (Ctrl + Alt + X y opciones de recortes)
 *   4. Integrations (Claude Code, Codex y Gemini CLI)
 */
async function captureAiIntegrations(page) {
  console.log('\n[4/5] Generando docs/media/ai-integrations.gif (English, smooth 20 fps)...');
  await resetFramesDir();
  const { snap, burst } = makeRecorder();

  await page.open({
    width: 860,
    height: 720,
    query: '?window=settings',
    prefs: { lang: 'en', theme: 'light' },
  });

  await seedEnglishData(page);
  await page.until(async () => (await page.ask('count', '.settings-tabs [role="tab"]')) > 0, 'no cargó ajustes');
  await page.settle(250);

  const goToTab = async (index) => {
    await page.evaluate(`document.querySelectorAll('.settings-tabs [role="tab"]')[${index}].scrollIntoView({ block: 'nearest', inline: 'center' })`);
    await sleep(100);
    const box = (await page.ask('boxes', '.settings-tabs [role="tab"]'))[index];
    await page.click(box.left + box.width / 2, box.top + box.height / 2);
    await burst(page, 3, 45);
    await sleep(180);
  };

  // Pestaña Classifier (index 6)
  await goToTab(6);
  await page.until(async () => (await page.ask('count', '[role="radio"]')) === 5, 'no cargaron los 5 proveedores');
  await snap(page, 8);

  await page.clickOn('[role="radio"]', 'Claude');
  await page.settle(180);
  await snap(page, 5);

  await page.clickOn('[role="radio"]', 'OpenAI');
  await page.settle(180);
  await snap(page, 5);

  await page.clickOn('[role="radio"]', 'Ollama');
  await page.settle(220);
  await snap(page, 10);

  // Pestaña Categories (index 4)
  await goToTab(4);
  await snap(page, 7);

  // Pestaña Shortcuts (index 1)
  await goToTab(1);
  await snap(page, 10);

  // Pestaña Integrations (index 8)
  await goToTab(8);
  await page.until(async () => (await page.ask('count', '.integration-status')) > 0, 'no cargaron integraciones', 4000);
  await page.settle(250);
  await snap(page, 11);

  const outFile = join(MEDIA_DIR, 'ai-integrations.gif');
  await framesToGif(join(FRAMES_DIR, 'frame_%04d.png'), outFile, 12, 20);
  console.log(`  ✓ Creado: ${outFile}`);
}

/**
 * 5. STATIC SCREENSHOTS (docs/media/*.png) — todas en inglés
 */
async function captureStaticScreenshots(page) {
  console.log('\n[5/5] Generando capturas PNG estáticas en inglés...');

  // 1. notebook-light.png
  await page.open({
    width: 1280,
    height: 900,
    prefs: { coverStyle: 'leather', cover: '#1E3558', theme: 'light', spread: 'double', size: 'standard', tabs: true, lang: 'en' },
  });
  await seedEnglishData(page);
  await page.settle(300);
  const lightPath = join(MEDIA_DIR, 'notebook-light.png');
  await page.screenshot(lightPath);
  console.log(`  ✓ Creado: ${lightPath}`);

  // 2. notebook-dark.png
  await page.open({
    width: 1280,
    height: 900,
    prefs: { coverStyle: 'leather', cover: '#1E3558', theme: 'dark', spread: 'double', size: 'standard', tabs: true, lang: 'en' },
  });
  await seedEnglishData(page);
  await page.settle(300);
  const darkPath = join(MEDIA_DIR, 'notebook-dark.png');
  await page.screenshot(darkPath);
  console.log(`  ✓ Creado: ${darkPath}`);

  // 3. finder.png (buscador abierto en inglés)
  await page.open({
    width: 1280,
    height: 900,
    prefs: { theme: 'light', spread: 'double', size: 'standard', tabs: true, lang: 'en' },
  });
  await seedEnglishData(page);
  await page.settle(250);
  await page.clickOn('[aria-label="Search and filter"]');
  await page.until(async () => (await page.ask('count', '.finder')) > 0, 'no abrió el buscador');
  await page.clickOn('.finder input[type="search"]');
  await page.type('dashboard');
  await page.settle(350);
  const finderPath = join(MEDIA_DIR, 'finder.png');
  await page.screenshot(finderPath);
  console.log(`  ✓ Creado: ${finderPath}`);

  // 4. capture-sheet.png (hoja suelta rápida ?window=capture en inglés)
  await page.open({
    width: 480,
    height: 640,
    query: '?window=capture',
    prefs: { theme: 'light', lang: 'en' },
  });
  await page.settle(250);
  await page.evaluate(`
    import('/src/mock.ts').then(({ simulateSend }) => {
      simulateSend({
        origin: '— 14:32 · Chrome · "DeepSeek / OpenAI API benchmark"',
        text: 'Latency: 180ms TTFT\\nThroughput: 85 tokens/sec\\nSummary: Strong code generation and local reasoning performance.'
      });
    })
  `);
  await page.settle(400);
  const capturePath = join(MEDIA_DIR, 'capture-sheet.png');
  await page.screenshot(capturePath);
  console.log(`  ✓ Creado: ${capturePath}`);
}

async function verifyMediaFiles() {
  console.log('\n--- Verificando archivos generados en docs/media/ ---');
  const required = [
    'hero-notebook.gif',
    'writing-markdown.gif',
    'covers-themes.gif',
    'ai-integrations.gif',
    'notebook-light.png',
    'notebook-dark.png',
    'finder.png',
    'capture-sheet.png',
  ];

  let ok = true;
  for (const name of required) {
    const file = join(MEDIA_DIR, name);
    try {
      const s = await stat(file);
      const kb = (s.size / 1024).toFixed(1);
      if (s.size < 15 * 1024) {
        console.error(`  ✗ ${name} (${kb} KB) es menor a 15 KB`);
        ok = false;
      } else {
        console.log(`  ✓ ${name} (${kb} KB)`);
      }
    } catch {
      console.error(`  ✗ ${name} NO EXISTE`);
      ok = false;
    }
  }

  await rm(FRAMES_DIR, { recursive: true, force: true });

  if (!ok) {
    throw new Error('Algunos archivos requeridos no cumplen las condiciones.');
  }
}

async function main() {
  await mkdir(MEDIA_DIR, { recursive: true });
  console.log(`Iniciando generación de medios para Book...`);
  console.log(`Puertos: BOOK_E2E_PORT=${process.env.BOOK_E2E_PORT}, BOOK_E2E_DEBUG_PORT=${process.env.BOOK_E2E_DEBUG_PORT}`);

  const { page, close } = await launch({ width: 1280, height: 900 });

  try {
    await captureHeroNotebook(page);
    await captureWritingMarkdown(page);
    await captureCoversThemes(page);
    await captureAiIntegrations(page);
    await captureStaticScreenshots(page);
    await verifyMediaFiles();
    console.log('\n¡Todos los medios fueron generados y verificados con éxito!');
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error('\nError generando medios:', err);
  process.exit(1);
});
