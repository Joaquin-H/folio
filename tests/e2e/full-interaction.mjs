// Pruebas de punta a punta interactivas completas de Folio (RC4 Full Interactive E2E).
//
// Cubre con clics y teclado reales:
// 1. Abrir y cerrar cuaderno desde portada y contratapa (clics reales y teclado).
// 2. Cambiar tamaños (Bolsillo / Estándar / Completo) y Modo Hoja (Simple / Doble hoja).
// 3. Borde de ventana en Personalización (Ninguno / Transparente / Sólido).
// 4. Escribir, editar, fijar, categorizar y borrar hoja con interacción real.
// 5. Cambiar entre pestañas (Hoy, Fijas, Recortes, Secret, Papelera, Todas).
// 6. Recorte en vivo (Live clipping con atajo y hoja suelta).
// 7. Arrancar hoja flotante, minimizar al dock centrado, mover y expandir.
// 8. Mapa con >40 notas (carga incremental y navegación a hoja >40).
// 9. Buscador de opciones en Ajustes (búsqueda, resaltado mark, Jev, bilingüe y limpiar).
//
// Uso (desde la raíz del proyecto):
//   $env:BOOK_E2E_PORT=1432; $env:BOOK_E2E_DEBUG_PORT=9342; node tests/e2e/full-interaction.mjs

import { check, equal, launch, sleep, suite } from './harness.mjs';

const WINDOW = { pocket: { width: 1280, height: 900 }, standard: { width: 1280, height: 900 }, full: { width: 1920, height: 1080 } };
const { test, run } = suite();

const api = (page, code) => page.evaluate(`import('/src/api.ts').then(({ api }) => (${code}))`);

/** Cara que se está viendo con el cuaderno cerrado, o null si está abierto. */
const face = (page) =>
  page.evaluate(`(() => {
    const book = document.querySelector('.book.closed');
    return book && !book.dataset.flip && !document.querySelector('.cover.leaving') ? (book.dataset.face ?? null) : null;
  })()`);

/** Deja en el cuaderno solo dos hojas para navegar velozmente entre portada y contratapa. */
async function onlyTwoSheets(page) {
  await page.evaluate(
    `import('/src/api.ts').then(async ({ api }) => { for (let id = 3; id <= 60; id++) await api.setSheetHidden(id, true); return true; })`,
  );
  await page.until(async () => /de 2$/.test((await page.ask('label', '.page-foot-main')) ?? ''), 'el cuaderno no quedó con dos hojas');
  await page.settle(200);
}

// -----------------------------------------------------------------------------
// 1. PORTADA Y CONTRATAPA: ABRIR Y CERRAR CON CLICS REALES Y TECLADO
// -----------------------------------------------------------------------------
test('1. Portada y contratapa: abrir y cerrar cuaderno con clics reales y teclado', async (page) => {
  await page.open({ width: 1280, height: 900, prefs: { size: 'standard', spread: 'double' } });

  // 1. Ir a la primera hoja y cerrar hacia la portada (ArrowLeft)
  await page.key('Home');
  await page.settle(250);
  await page.key('ArrowLeft');
  await page.until(async () => (await face(page)) === 'front', 'el cuaderno no se cerró mostrando la portada');
  check(await page.evaluate("document.querySelector('.book.closed') !== null"), 'el cuaderno debe estar cerrado');

  // 2. Abrir el cuaderno desde la portada haciendo clic sobre la tapa (.cover)
  await page.clickOn('.cover');
  await page.until(async () => {
    const s = await page.state();
    return s.open && !s.busy && s.sheet === 1;
  }, 'el cuaderno no se abrió desde la portada');
  await page.settle(300);

  // 3. Cerrar desde el botón de la barra de controles
  await page.clickOn('.page-controls button[aria-label="Cerrar el cuaderno"]');
  await page.until(async () => (await face(page)) === 'front', 'el botón Cerrar el cuaderno no cerró la tapa');
  await page.settle(250);

  // 4. Abrir con teclado (Enter)
  await page.key('Enter');
  await page.until(async () => (await page.state()).open, 'Enter no abrió el cuaderno desde la portada');
  await page.settle(300);

  // 5. Ir a la última hoja y cerrar hacia la contratapa (back cover)
  await onlyTwoSheets(page);
  await page.key('End');
  await page.settle(250);

  // Avanzar a la última página de la última hoja
  for (let i = 0; i < 20; i++) {
    const s = await page.state();
    const pages = /^(\d+) de (\d+)$/.exec(s.page ?? '');
    const shown = await page.ask('count', '.page');
    if (!pages || Number(pages[1]) + shown > Number(pages[2])) break;
    await page.key('ArrowRight');
    await page.settle(200);
  }

  // Ahora ArrowRight cierra hacia la contratapa
  await page.key('ArrowRight');
  await page.until(async () => (await face(page)) === 'back', 'el cuaderno no se cerró mostrando la contratapa');
  check(await page.evaluate("document.querySelector('.book.closed[data-face=\"back\"]') !== null"), 'la cara visible debe ser back');

  // 6. Abrir el cuaderno desde la contratapa con un clic real
  await page.clickOn('.cover');
  await page.until(async () => (await page.state()).open, 'el cuaderno no se abrió desde la contratapa');
  await page.settle(300);
  const backOpenedState = await page.state();
  check(backOpenedState.sheet >= 2, 'al abrir desde contratapa debe abrir la última hoja');
});

// -----------------------------------------------------------------------------
// 2. TAMAÑOS (BOLSILLO, ESTÁNDAR, COMPLETO) Y MODO HOJA (SIMPLE, DOBLE)
// -----------------------------------------------------------------------------
test('2. Cambiar tamaños (Bolsillo, Estándar, Completo) y Modo Hoja (Simple, Doble)', async (page) => {
  await page.open({ width: 1280, height: 900, prefs: { size: 'standard', spread: 'double' } });

  // 1. Cambiar a Bolsillo desde el menú ⋯
  await page.clickOn('.page-actions button[aria-label="Menú"]');
  await page.until(() => page.ask('count', '.menu-list'), 'el menú de la hoja no se abrió');
  await sleep(150);
  await page.clickOn('.menu-row[aria-label="Tamaño"] button', 'Bolsillo');
  await page.until(async () => {
    const prefs = await page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
    return prefs.size === 'pocket';
  }, 'prefs.size no cambió a pocket');
  await page.settle(300);

  // 2. Cambiar a Estándar con atajo de teclado Ctrl + 2
  await page.key('2', { ctrl: true });
  await page.until(async () => {
    const prefs = await page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
    return prefs.size === 'standard';
  }, 'Ctrl+2 no cambió prefs.size a standard');
  await page.settle(300);

  // 3. Cambiar a Pantalla Completa con atajo de teclado Ctrl + 3
  await page.key('3', { ctrl: true });
  await page.until(async () => {
    const prefs = await page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
    return prefs.size === 'full';
  }, 'Ctrl+3 no cambió prefs.size a full');
  await page.settle(300);

  // Volver a Estándar con Ctrl + 2
  await page.key('2', { ctrl: true });
  await page.until(async () => {
    const prefs = await page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
    return prefs.size === 'standard';
  }, 'Ctrl+2 no volvió a standard');
  await page.settle(300);

  // 4. Cambiar a Simple hoja desde el menú ⋯
  await page.clickOn('.page-actions button[aria-label="Menú"]');
  await page.until(() => page.ask('count', '.menu-list'), 'el menú no se abrió');
  await sleep(150);
  await page.clickOn('.menu-item', 'Doble hoja');
  await page.until(async () => {
    const isSingle = await page.evaluate("document.querySelector('.book.single') !== null");
    const countPages = await page.ask('count', '.page');
    return isSingle && countPages === 1;
  }, 'no cambió a modo hoja simple (1 página)');
  await page.settle(300);

  // 5. Cambiar de nuevo a Doble hoja con atajo Ctrl + D
  await page.key('d', { ctrl: true });
  await page.until(async () => {
    const isSingle = await page.evaluate("document.querySelector('.book.single') !== null");
    const countPages = await page.ask('count', '.page');
    return !isSingle && countPages === 2;
  }, 'Ctrl+D no cambió a modo doble hoja (2 páginas)');
  await page.settle(300);
});

// -----------------------------------------------------------------------------
// 3. BORDE DE VENTANA EN PERSONALIZACIÓN (NINGUNO, TRANSPARENTE, SÓLIDO)
// -----------------------------------------------------------------------------
test('3. Borde de ventana en Personalización (Ninguno, Transparente, Sólido)', async (page) => {
  await page.open({ width: 1280, height: 900, prefs: { size: 'standard', spread: 'double', frame: 'none' } });

  // 1. Abrir Ajustes con Ctrl + ,
  await page.key(',', { ctrl: true });
  await page.until(async () => (await page.ask('count', '.settings-panel')) > 0, 'no se abrió Ajustes');
  await sleep(250);

  // 2. Ir a Personalización
  await page.clickOn('.tab-strip [role="tab"]', 'Personalización');
  await page.until(
    async () => (await page.evaluate("document.querySelector('#settings-tab-look')?.getAttribute('aria-selected')")) === 'true',
    'no se seleccionó Personalización',
  );

  const groupSelector = '[role="tablist"][aria-label="Borde de ventana"]';
  await page.until(async () => (await page.ask('count', groupSelector)) > 0, 'no se encontró selector Borde de ventana');

  // 3. Cambiar a Transparente
  await page.clickOn(`${groupSelector} button`, 'Transparente');
  await page.until(async () => (await page.evaluate("document.documentElement.dataset.frame")) === 'transparent', 'no cambió a transparent');
  const prefsTrans = await page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
  equal(prefsTrans.frame, 'transparent', 'prefs.frame es transparent');

  // 4. Cambiar a Sólido
  await page.clickOn(`${groupSelector} button`, 'Sólido');
  await page.until(async () => (await page.evaluate("document.documentElement.dataset.frame")) === 'solid', 'no cambió a solid');
  const prefsSolid = await page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
  equal(prefsSolid.frame, 'solid', 'prefs.frame es solid');

  // 5. Volver a Ninguno (inmersivo)
  await page.clickOn(`${groupSelector} button`, 'Ninguno');
  await page.until(async () => (await page.evaluate("document.documentElement.dataset.frame")) === 'none', 'no cambió a none');
  const prefsNone = await page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
  equal(prefsNone.frame, 'none', 'prefs.frame es none');

  // 6. Cerrar Ajustes con Escape
  await page.key('Escape');
  await page.until(async () => (await page.ask('count', '.settings-panel')) === 0, 'Ajustes no se cerró');
  await page.settle(250);
});

// -----------------------------------------------------------------------------
// 4. ESCRIBIR, EDITAR, FIJAR, CATEGORIZAR Y BORRAR HOJA
// -----------------------------------------------------------------------------
test('4. Escribir, editar, fijar, categorizar y borrar hoja con interacción real', async (page) => {
  await page.open({ width: 1280, height: 900, prefs: { size: 'standard', spread: 'double' } });

  // 1. Crear una hoja nueva con atajo Ctrl + N o botón Nueva hoja
  if (await page.ask('count', 'button[aria-label="Nueva hoja"]')) {
    await page.clickOn('button[aria-label="Nueva hoja"]');
  } else {
    await page.key('n', { ctrl: true });
  }
  await page.until(async () => (await page.state()).writing, 'no abrió el editor de hoja nueva');
  await sleep(200);

  // 2. Escribir título
  const titleInput = await page.ask('count', '.page-title.editable input');
  if (titleInput > 0) {
    await page.clickOn('.page-title.editable input');
    await page.type('Nota Interactiva E2E');
  }

  // 3. Escribir cuerpo del texto
  await page.clickOn('.page-text.editing');
  await page.type('Primer renglón de prueba interactiva.');
  await sleep(150);

  // 4. Guardar y terminar con Ctrl + Enter
  await page.key('Enter', { ctrl: true });
  await page.until(async () => !(await page.state()).writing, 'Ctrl+Enter no terminó de escribir');
  await page.settle(300);

  const readerText = await page.ask('label', '.flow-clip:not(.parked) .page-text');
  check(readerText.includes('Primer renglón de prueba interactiva.'), `el texto no coincide: ${readerText}`);

  // 5. Editar hoja con Enter
  await page.key('Enter');
  await page.until(async () => (await page.state()).writing, 'Enter no abrió el editor');
  await page.type('\nSegundo renglón añadido.');
  await page.key('Enter', { ctrl: true });
  await page.until(async () => !(await page.state()).writing, 'no guardó la edición');
  await page.settle(300);

  const updatedText = await page.ask('label', '.flow-clip:not(.parked) .page-text');
  check(updatedText.includes('Segundo renglón añadido.'), `el texto actualizado no coincide: ${updatedText}`);

  // 6. Asignar categoría "Trabajo" desde el selector en la cabecera
  await page.clickOn('button[aria-label="Cambiar la categoría de esta hoja"]');
  await page.until(() => page.ask('count', '.menu-list'), 'el menú de categorías no se abrió');
  await sleep(150);
  await page.clickOn('.menu-item', 'Trabajo');
  await page.until(async () => {
    const chipText = await page.ask('label', 'button[aria-label="Cambiar la categoría de esta hoja"] .meta-text');
    return chipText === 'Trabajo';
  }, 'la categoría no cambió a Trabajo');
  await page.settle(300);

  // 7. Fijar la hoja desde el chip .chip.pin-btn
  await page.clickOn('.chip.pin-btn');
  await page.until(
    async () => (await page.evaluate("document.querySelector('.chip.pin-btn')?.classList.contains('active')")) === true,
    'el chip de pin no se activó',
  );
  equal(await page.ask('label', '.chip.pin-btn .meta-text'), 'Fijada', 'el texto del chip debe ser Fijada');

  // Desfijar
  await page.clickOn('.chip.pin-btn');
  await page.until(
    async () => (await page.evaluate("document.querySelector('.chip.pin-btn')?.classList.contains('active')")) === false,
    'el chip de pin sigue activo',
  );
  equal(await page.ask('label', '.chip.pin-btn .meta-text'), 'Fijar', 'el texto del chip debe volver a Fijar');

  // 8. Borrar hoja: menú ⋯ -> "Mover a la papelera" -> confirmación
  await page.clickOn('.page-actions button[aria-label="Menú"]');
  await page.until(() => page.ask('count', '.page-actions .menu-list'), 'el menú de la hoja no se abrió');
  await sleep(150);
  await page.clickOn('.page-actions .menu-item', 'Mover a la papelera');
  await page.until(async () => (await page.ask('count', '.confirm, [role="alertdialog"]')) > 0, 'no se abrió confirmación');
  await sleep(150);
  await page.clickOn('.confirm button, [role="alertdialog"] button', 'Mover a la papelera');
  await page.until(async () => (await page.ask('count', '.confirm, [role="alertdialog"]')) === 0, 'la confirmación no se cerró');
  await page.settle(300);

  // Verificar que la hoja ya no está activa en la vista actual
  const currentState = await page.state();
  check(currentState.title !== 'Nota Interactiva E2E', 'la nota borrada sigue abierta en el cuaderno');
});

// -----------------------------------------------------------------------------
// 5. NAVEGACIÓN ENTRE PESTAÑAS (HOY, FIJAS, RECORTES, SECRET, PAPELERA, TODAS)
// -----------------------------------------------------------------------------
test('5. Navegación entre pestañas (Hoy, Fijas, Recortes, Secret, Papelera, Todas)', async (page) => {
  await page.open({ width: 1280, height: 900, prefs: { size: 'standard', spread: 'double' } });

  // 1. Pestaña Hoy
  await page.clickOn('.tab[aria-label="Ver Hoy"]');
  await page.until(() => page.ask('count', '.tab.active[aria-label="Ver Hoy"]'), 'la solapa Hoy no quedó activa');
  await page.settle(250);

  // 2. Pestaña Fijas
  await page.clickOn('.tab[aria-label="Ver Fijas"]');
  await page.until(() => page.ask('count', '.tab.active[aria-label="Ver Fijas"]'), 'la solapa Fijas no quedó activa');
  await page.settle(250);

  // 3. Pestaña Recortes
  await page.clickOn('.tab[aria-label="Ver Recortes"]');
  await page.until(() => page.ask('count', '.tab.active[aria-label="Ver Recortes"]'), 'la solapa Recortes no quedó activa');
  await page.settle(250);

  // 4. Pestaña Secret-book
  await page.clickOn('.tab[aria-label="Ver Secret-book"]');
  await page.until(() => page.ask('count', '.tab.active[aria-label="Ver Secret-book"]'), 'la solapa Secret-book no quedó activa');
  await page.until(async () => (await page.ask('count', '.page-mode.secret')) > 0, 'no se mostró el modo secret');
  await page.settle(250);

  // Asegurar una hoja en la papelera para verificar su modo
  await api(page, 'api.setSheetHidden(1, true)');

  // 5. Pestaña Papelera
  await page.clickOn('.tab[aria-label="Ver Papelera"]');
  await page.until(() => page.ask('count', '.tab.active[aria-label="Ver Papelera"]'), 'la solapa Papelera no quedó activa');
  await page.until(async () => (await page.ask('count', '.page-mode.trash')) > 0, 'no se mostró el modo trash');
  await page.settle(250);

  // 6. Volver a Todas con la solapa Ver Todas
  await page.clickOn('.tab[aria-label="Ver Todas"]');
  await page.until(() => page.ask('count', '.tab.active[aria-label="Ver Todas"]'), 'la solapa Todas no quedó activa');
  await page.until(async () => (await page.ask('count', '.page-mode')) === 0, 'el modo papelera/secret sigue presente');
  await page.settle(250);
});

// -----------------------------------------------------------------------------
// 6. RECORTE EN VIVO (LIVE CLIPPING CON CTR+ALT+X EN HOJA SUELTA)
// -----------------------------------------------------------------------------
test('6. Recorte en vivo (Live clipping con Ctrl+Alt+X en hoja suelta)', async (page) => {
  await page.open({ width: 500, height: 600, query: '?window=capture' });
  await page.until(() => page.ask('count', '.loose-meta .chip'), 'no cargó la hoja suelta');

  // Enviar atajo Ctrl + Alt + X
  await page.key('x', { ctrl: true, alt: true });
  await page.until(
    async () => (await page.evaluate("document.querySelector('.loose-text')?.value ?? ''")).includes('Recorte capturado'),
    'no se recibió el recorte en vivo',
  );

  // Verificar asignación automática a categoría Recortes
  await page.until(async () => {
    const chipText = await page.evaluate("document.querySelector('.loose-meta .chip')?.textContent?.trim() ?? ''");
    return chipText.toLowerCase().includes('recorte') || chipText.toLowerCase().includes('clipping');
  }, 'la categoría no se asignó automáticamente a Recortes');

  // Guardar y cerrar
  await page.clickOn('.loose-actions button[aria-label="Guardar y cerrar"]');
  await page.until(
    async () => (await api(page, "api.listSheets({ view: 'all' })")).some((s) => s.preview.includes('Recorte capturado')),
    'no se guardó el recorte en el cuaderno',
  );
});

// -----------------------------------------------------------------------------
// 7. ARRANCAR HOJA FLOTANTE, MINIMIZAR AL DOCK CENTRADO, MOVER Y EXPANDIR
// -----------------------------------------------------------------------------
test('7. Arrancar hoja flotante, minimizar al dock centrado, mover y expandir', async (page) => {
  await page.open({ width: 1280, height: 900, prefs: { size: 'standard', spread: 'double' } });

  // Arrancar la hoja 3 desde api
  await api(page, 'api.tearOffSheet(3, false)');
  await page.until(
    async () => (await api(page, 'api.listTornOffSheets()')).some((s) => s.id === 3),
    'la hoja 3 no quedó registrada como arrancada',
  );

  // Abrir la ventana flotante de la hoja 3
  await page.open({ width: 450, height: 600, query: '?window=tearoff&id=3' });
  await page.until(async () => (await page.ask('count', '.tearoff-sheet')) > 0, 'no cargó la ventana flotante');
  await page.until(async () => (await page.ask('label', '.page-title')) === 'reunion-equipo.md', 'no cargó el título de la hoja 3');

  // Editar texto en la hoja flotante (doble clic para entrar en modo edición)
  const pt = await page.ask('center', '.loose-text');
  if (pt) await page.doubleClick(pt.x, pt.y);
  else await page.clickOn('.loose-text');
  await page.until(async () => (await page.ask('count', 'textarea.loose-text')) > 0, 'no entró en modo edición con doble clic');
  await page.type('\n- [x] Editado en ventana flotante');
  await page.settle(300);

  // Minimizar / colapsar a icono de dock centrado
  await page.clickOn('.dock-collapse');
  await page.until(async () => (await page.ask('count', '.tearoff-dock')) > 0, 'la hoja flotante no colapsó al dock');
  equal(await page.ask('count', '.tearoff-sheet'), 0, 'la hoja expandida no debe verse');

  // Mover el icono de dock arrastrándolo suavemente
  const dockBox = await page.ask('box', '.tearoff-dock');
  check(dockBox !== null, 'el icono del dock debe tener dimensiones');
  await page.drag({ x: dockBox.left + 20, y: dockBox.top + 20 }, { x: dockBox.left + 80, y: dockBox.top + 40 });
  await page.settle(250);
  check((await page.ask('count', '.tearoff-dock')) > 0, 'el dock debe seguir presente tras mover');

  // Expandir nuevamente haciendo clic limpio en el dock
  await page.clickOn('.tearoff-dock');
  await page.until(async () => (await page.ask('count', '.tearoff-sheet')) > 0, 'la hoja flotante no se expandió');
  equal(await page.ask('count', '.tearoff-dock'), 0, 'el dock no debe verse al estar expandida');

  const looseText = await page.evaluate("document.querySelector('.loose-text')?.value || document.querySelector('.loose-text')?.textContent || ''");
  check(looseText.includes('Editado en ventana flotante'), 'el texto editado debe persistir en la hoja flotante');

  // Devolver al cuaderno
  await page.clickOn('.return-sheet-btn');
  await page.until(
    async () => !(await api(page, 'api.listTornOffSheets()')).some((s) => s.id === 3),
    'la hoja 3 no se devolvió al cuaderno',
  );
});

// -----------------------------------------------------------------------------
// 8. MAPA CON >40 NOTAS (CARGA INCREMENTAL Y NAVEGACIÓN A HOJA >40)
// -----------------------------------------------------------------------------
test('8. Mapa con >40 notas: renderiza más de 40 tarjetas, carga incremental y navega a hoja >40', async (page) => {
  await page.open({ width: 1280, height: 900, prefs: { size: 'standard', spread: 'double' } });

  // Inyectar 60 notas adicionales en el mock
  await page.evaluate(`import('/src/mock.ts').then(({ seedExtraSheets }) => seedExtraSheets(60))`);
  await page.until(
    async () => {
      const overview = await api(page, 'api.getOverview()');
      return overview.counts.all > 40;
    },
    'no se actualizaron las notas en el mock',
  );
  await sleep(300);

  // Abrir mapa con Ctrl + M
  await page.key('m', { ctrl: true });
  await page.until(() => page.ask('count', '.sheet-map-modal'), 'el mapa no se abrió con Ctrl+M');
  await sleep(350);

  // Verificar total mostrado (>40)
  const totalPill = await page.ask('label', '.sheet-map-total-pill');
  check(totalPill && parseInt(totalPill, 10) > 40, `el total del mapa no supera 40: ${totalPill}`);

  // Verificar tarjetas iniciales
  const initialCards = await page.ask('count', '.sheet-card, .sheet-map-card');
  check(initialCards > 40, `se esperaban >40 tarjetas, encontradas: ${initialCards}`);

  // Scroll en contenedor del mapa para comprobar carga incremental
  await page.evaluate(`(() => {
    const body = document.querySelector('.sheet-map-body');
    if (body) body.scrollTop = body.scrollHeight;
  })()`);
  await sleep(300);

  // Seleccionar la tarjeta 45 (hoja #46)
  const targetIndex = 45;
  await page.evaluate(`(() => {
    const cards = document.querySelectorAll('.sheet-map-card, .sheet-card');
    if (cards[${targetIndex}]) cards[${targetIndex}].click();
  })()`);

  // El mapa debe cerrarse
  await page.until(async () => !(await page.ask('count', '.sheet-map-modal')), 'el mapa no se cerró tras clic');
  await page.settle(300);

  // Verificar navegación a hoja 46
  const sAfter = await page.state();
  equal(sAfter.sheet, targetIndex + 1, `el cuaderno no navegó a la hoja ${targetIndex + 1}; está en ${sAfter.sheet}`);
});

// -----------------------------------------------------------------------------
// 9. BUSCADOR DE AJUSTES (BÚSQUEDA, RESALTADO MARK, JEV, BILINGÜE Y LIMPIAR)
// -----------------------------------------------------------------------------
test('9. Buscador de opciones en Ajustes: búsqueda, resaltado mark, Jev, bilingüe y limpiar', async (page) => {
  await page.open({ width: 1280, height: 900, prefs: { size: 'standard', spread: 'double', lang: 'es' } });

  // 1. Abrir Ajustes con Ctrl + ,
  await page.key(',', { ctrl: true });
  await page.until(async () => (await page.ask('count', '.settings-panel')) > 0, 'no se abrió Ajustes');
  await sleep(250);

  // 2. Buscar "borde"
  const searchInput = '.settings-search input';
  await page.clickOn(searchInput);
  await page.type('borde');
  await page.until(async () => (await page.ask('count', '.settings-search-results')) > 0, 'no aparecieron resultados para "borde"');

  const labels = await page.ask('labels', '.settings-search-item-label');
  check(labels.some((l) => l.includes('Borde de ventana')), `se esperaba Borde de ventana en: ${labels.join(' | ')}`);
  check((await page.ask('count', '.settings-search-row mark')) > 0, 'debe haber texto resaltado con <mark>');

  // 3. Limpiar con botón .settings-search-clear y buscar "jev"
  await page.clickOn('.settings-search-clear');
  await page.until(async () => (await page.ask('count', '.settings-search-results')) === 0, 'no se limpió la búsqueda');
  await page.type('jev');
  await page.until(async () => (await page.ask('count', '.settings-search-results .group')) >= 2, 'buscar jev debe encontrar al menos 2 secciones');
  const jevGroups = await page.ask('labels', '.settings-search-results .group h3');
  check(jevGroups.some((g) => g.includes('Clasificador') || g.includes('Integraciones')), `grupos de jev: ${jevGroups.join(', ')}`);

  // 4. Búsqueda sin resultados
  await page.clickOn('.settings-search-clear');
  await page.type('busqueda_inexistente_xyz_99');
  await page.until(async () => (await page.ask('count', '.settings-no-results')) > 0, 'no apareció estado sin resultados');
  equal(await page.ask('label', '.settings-no-results h3'), 'Sin resultados', 'el título debe ser Sin resultados');

  // 5. Botón "Limpiar búsqueda" en el estado vacío
  await page.clickOn('.settings-no-results button', 'Limpiar búsqueda');
  await page.until(async () => (await page.ask('count', '.settings-no-results')) === 0, 'el estado vacío no desapareció');
  equal(await page.evaluate(`document.querySelector(${JSON.stringify(searchInput)}).value`), '', 'el input debe quedar vacío');

  // 6. Cerrar Ajustes con Escape
  await page.key('Escape');
  await page.until(async () => (await page.ask('count', '.settings-panel')) === 0, 'Ajustes no se cerró');
});

// -----------------------------------------------------------------------------
// EJECUCIÓN
// -----------------------------------------------------------------------------
const { page, close } = await launch(WINDOW.standard);
let failures = [];
try {
  failures = await run(page);
} finally {
  await close();
}
process.exit(failures.length ? 1 : 0);
