// Pruebas e2e de integración de Folio - Fase 3 (Parte A: Features 1 a 5)
//
// 1. Mapa con >40 notas (sin truncado, carga incremental y navegación a hoja >40).
// 2. Navegación entre hojas (Alt+flechas y chevrons en el pie de página).
// 3. Modo bolsillo sin overlap (sin colisiones de getBoundingClientRect entre controles, búsqueda, carteles e indicador).
// 4. Categoría Recortes + Ctrl+Alt+X (existencia de categoría y autocategorización de recortes capturados).
// 5. Hojas del día (Hoy) (vista "today", inclusión de notas de hoy, exclusión de días anteriores y contador).
//
// Uso:
//   $env:BOOK_E2E_PORT=1432; $env:BOOK_E2E_DEBUG_PORT=9342; node tests/e2e/features-a.mjs

import { check, equal, launch, sleep, suite } from './harness.mjs';

const WINDOW = { standard: { width: 1280, height: 900 }, full: { width: 1920, height: 1080 } };

const { test, run } = suite();

const api = (page, code) => page.evaluate(`import('/src/api.ts').then(({ api }) => (${code}))`);

// -----------------------------------------------------------------------------
// FEATURE 1: Mapa con >40 notas
// -----------------------------------------------------------------------------
test('1. Mapa con >40 notas: renderiza más de 40 tarjetas y navega a hoja >40', async (page) => {
  // Abrimos el cuaderno normalmente y luego inyectamos 60 notas adicionales en el mock
  await page.open({
    width: 1280,
    height: 900,
    prefs: { size: 'standard', spread: 'double', markdown: false },
  });

  const stateInitial = await page.state();
  equal(stateInitial.sheet, 1, 'inicia en la primera hoja');

  // Inyectamos 60 notas adicionales para superar el límite de 40
  await page.evaluate(`import('/src/mock.ts').then(({ seedExtraSheets }) => seedExtraSheets(60))`);
  await page.until(
    async () => {
      const overview = await api(page, 'api.getOverview()');
      return overview.counts.all > 40;
    },
    'no se actualizaron las notas adicionales en el mock',
  );
  await sleep(350);

  // Abrir mapa con el atajo Ctrl + M
  await page.key('m', { ctrl: true });
  await page.until(() => page.ask('count', '.sheet-map-modal'), 'el modal del mapa no se abrió con Ctrl+M');
  await sleep(350);

  // Verificar total de hojas mostrado en la cabecera del mapa (>40)
  const totalPill = await page.ask('label', '.sheet-map-total-pill');
  check(totalPill && parseInt(totalPill, 10) > 40, `el indicador del mapa no muestra >40 hojas: ${totalPill}`);

  // Verificar cantidad de tarjetas renderizadas (.sheet-card / .sheet-map-card)
  const renderedInitial = await page.ask('count', '.sheet-card, .sheet-map-card');
  check(renderedInitial > 40, `se esperaban más de 40 tarjetas renderizadas inicialmente, pero hay ${renderedInitial}`);

  // Hacer scroll en el contenedor para probar la carga incremental del mapa
  await page.evaluate(`(() => {
    const body = document.querySelector('.sheet-map-body');
    if (body) body.scrollTop = body.scrollHeight;
  })()`);
  await sleep(350);

  const renderedAfterScroll = await page.ask('count', '.sheet-card, .sheet-map-card');
  check(renderedAfterScroll >= renderedInitial, 'las tarjetas renderizadas disminuyeron tras el scroll');

  // Seleccionar la tarjeta de índice 45 (hoja #46)
  const targetIndex = 45;
  const targetCard = await page.evaluate(`(() => {
    const cards = document.querySelectorAll('.sheet-map-card, .sheet-card');
    if (cards[${targetIndex}]) {
      cards[${targetIndex}].click();
      return true;
    }
    return false;
  })()`);
  check(targetCard, `no se encontró la tarjeta en el índice ${targetIndex}`);

  // El mapa debe cerrarse tras seleccionar una tarjeta
  await page.until(async () => !(await page.ask('count', '.sheet-map-modal')), 'el mapa no se cerró tras seleccionar la hoja');
  await page.settle(300);

  // Verificar que el cuaderno navegó efectivamente a la hoja 46 (targetIndex + 1)
  const stateAfter = await page.state();
  equal(stateAfter.sheet, targetIndex + 1, `el cuaderno no navegó a la hoja ${targetIndex + 1}; está en ${stateAfter.sheet}`);

  // Verificar que también se puede abrir el mapa haciendo clic en .sheet-indicator-badge
  await page.clickOn('.sheet-indicator-badge');
  await page.until(() => page.ask('count', '.sheet-map-modal'), 'el mapa no se abrió al hacer clic en .sheet-indicator-badge');
  await page.key('Escape');
  await page.until(async () => !(await page.ask('count', '.sheet-map-modal')), 'Escape no cerró el modal del mapa');
});

// -----------------------------------------------------------------------------
// FEATURE 2: Navegación entre hojas (Alt+flechas / chevrons)
// -----------------------------------------------------------------------------
test('2. Navegación entre hojas: atajos Alt+flechas y chevrons en el pie de página', async (page) => {
  await page.open({
    width: 1280,
    height: 900,
    prefs: { size: 'standard', spread: 'double', markdown: false },
  });

  const s1 = await page.state();
  equal(s1.sheet, 1, 'inicia en la hoja 1');

  // En la primera hoja, el botón de hoja anterior debe estar deshabilitado
  const prevDisabled = await page.evaluate("document.querySelector('.nav-btn.prev-sheet')?.disabled ?? false");
  check(prevDisabled, 'el botón de hoja anterior debe estar deshabilitado en la primera hoja');

  // 1. Clic en chevron de siguiente hoja (.nav-btn.next-sheet)
  await page.clickOn('.nav-btn.next-sheet');
  await page.settle(300);
  const s2 = await page.state();
  equal(s2.sheet, 2, 'clic en next-sheet no avanzó a la hoja 2');

  // 2. Clic en chevron de hoja anterior (.nav-btn.prev-sheet)
  await page.clickOn('.nav-btn.prev-sheet');
  await page.settle(300);
  const s1Back = await page.state();
  equal(s1Back.sheet, 1, 'clic en prev-sheet no retrocedió a la hoja 1');

  // 3. Atajo de teclado Alt + ArrowRight para avanzar a la hoja siguiente
  await page.key('ArrowRight', { alt: true });
  await page.settle(300);
  const s2Alt = await page.state();
  equal(s2Alt.sheet, 2, 'Alt+ArrowRight no avanzó a la hoja 2');

  // Avanzar una hoja más con Alt + ArrowRight
  await page.key('ArrowRight', { alt: true });
  await page.settle(300);
  const s3Alt = await page.state();
  equal(s3Alt.sheet, 3, 'segundo Alt+ArrowRight no avanzó a la hoja 3');

  // 4. Atajo de teclado Alt + ArrowLeft para retroceder a la hoja anterior
  await page.key('ArrowLeft', { alt: true });
  await page.settle(300);
  const s2BackAlt = await page.state();
  equal(s2BackAlt.sheet, 2, 'Alt+ArrowLeft no retrocedió a la hoja 2');

  // Volver a hoja 1 con Alt + ArrowLeft
  await page.key('ArrowLeft', { alt: true });
  await page.settle(300);
  const s1ReturnAlt = await page.state();
  equal(s1ReturnAlt.sheet, 1, 'segundo Alt+ArrowLeft no retrocedió a la hoja 1');
});

// -----------------------------------------------------------------------------
// FEATURE 3: Modo bolsillo sin overlap
// -----------------------------------------------------------------------------
test('3. Modo bolsillo sin overlap: controles, buscador, indicador y carteles no colisionan', async (page) => {
  const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;

  for (const config of [
    { label: 'bolsillo', width: 420, height: 600, prefs: { size: 'pocket', spread: 'single', markdown: false } },
    { label: 'mínimo 390x480', width: 390, height: 480, prefs: { size: 'custom', height: 480, spread: 'single', markdown: false } },
  ]) {
    await page.open({ width: config.width, height: config.height, prefs: config.prefs });

    // 1. En modo lectura:
    // Controles superiores (.page-controls button) vs botones de acción (.page-actions button)
    const controlButtons = await page.ask('boxes', '.page-controls button');
    const actionButtons = await page.ask('boxes', '.page-actions > button, .page-actions .menu > button');
    const searchBtn = await page.ask('box', '.page-actions button[aria-label="Buscar y filtrar"]');
    check(searchBtn, `${config.label}: no se encontró el botón de búsqueda`);

    for (const ctrl of controlButtons) {
      for (const act of actionButtons) {
        check(apart(ctrl, act), `${config.label}: control superior y botón de acción se solapan`);
      }
    }

    // Pie de página: grupo de navegación vs número de página
    const navGroup = await page.ask('box', '.sheet-nav-group');
    const pageNum = await page.ask('box', '.page-foot > span:last-child');
    if (navGroup && pageNum && pageNum.width > 0) {
      check(apart(navGroup, pageNum), `${config.label}: navegación de hojas y contador de página se solapan`);
    }

    // Botones dentro del grupo de navegación inferior (prev, indicador, next)
    const navButtons = await page.ask('boxes', '.sheet-nav-group .nav-btn, .sheet-nav-group .sheet-indicator-badge');
    for (let i = 0; i < navButtons.length; i++) {
      for (let j = i + 1; j < navButtons.length; j++) {
        check(apart(navButtons[i], navButtons[j]), `${config.label}: botones del grupo de navegación inferior se solapan`);
      }
    }

    // 2. En modo edición (banner .page-mode presente):
    await page.key('Enter');
    await page.until(async () => (await page.state()).writing, `${config.label}: no entró en modo escritura`);
    await sleep(200);

    const cartelWriting = await page.ask('box', '.page-mode');
    check(cartelWriting, `${config.label}: no se muestra el cartel en modo escritura`);

    for (const ctrl of await page.ask('boxes', '.page-controls button')) {
      check(apart(ctrl, cartelWriting), `${config.label}: cartel de escritura pisa un botón de controles`);
    }
    for (const act of await page.ask('boxes', '.page-actions > button, .page-actions .menu > button')) {
      check(apart(cartelWriting, act), `${config.label}: cartel de escritura pisa un botón de acciones / búsqueda`);
    }

    await page.key('Escape');
    await page.until(async () => !(await page.state()).writing, `${config.label}: Esc no salió de escritura`);
    await page.settle(250);

    // 3. Al abrir hoja nueva (banner .page-mode "Hoja nueva"):
    await page.clickOn('.page-actions button[aria-label="Nueva hoja"]');
    await page.until(async () => (await page.state()).writing, `${config.label}: no abrió hoja nueva`);
    await sleep(200);

    const cartelNew = await page.ask('box', '.page-mode');
    check(cartelNew, `${config.label}: no se muestra el cartel de hoja nueva`);
    for (const act of await page.ask('boxes', '.page-actions > button, .page-actions .menu > button')) {
      check(apart(cartelNew, act), `${config.label}: cartel de hoja nueva pisa botón de acciones / búsqueda`);
    }

    await page.key('Escape');
    await page.settle(250);
  }

  // 4. Orden de la barra superior y menú ⋯ visible a 390px de alto:
  await page.open({ width: 520, height: 390, prefs: { size: 'custom', height: 390, spread: 'single', markdown: false } });
  const leftLabels = await page.evaluate(`
    [...document.querySelectorAll('.page-controls button')].map((b) => b.getAttribute('aria-label'))
  `);
  equal(leftLabels[0], 'Cerrar el cuaderno', 'primer botón izquierdo: Cerrar el cuaderno');
  equal(leftLabels[1], 'Cerrar la ventana', 'segundo botón izquierdo: Cerrar la ventana');

  const rightOrder = await page.evaluate(`
    [...document.querySelectorAll('.page-actions > *')].map((el) =>
      el.classList.contains('page-actions-sep')
        ? 'sep'
        : el.classList.contains('menu')
          ? 'menu'
          : el.getAttribute('aria-label')
    )
  `);
  equal(rightOrder[0], 'Nueva hoja', 'primer botón derecho: Nueva hoja');
  equal(rightOrder[1], 'Buscar y filtrar', 'segundo botón derecho: Buscar y filtrar');
  equal(rightOrder[2], 'Mapa del cuaderno (Ctrl + M)', 'tercer botón derecho: Mapa');
  equal(rightOrder[3], 'sep', 'separador antes del menú ⋯');
  equal(rightOrder[4], 'menu', 'menú ⋯ al final');

  // Abrir menú ⋯ a 390px de alto y verificar que el último ítem ("Cerrar Folio") es visible dentro del viewport
  await page.clickOn('.page-actions .menu > button');
  await page.until(() => page.ask('count', '.page-actions .menu-list'), 'el menú ⋯ no se abrió a 390px de alto');
  await sleep(160);

  const menuCheck = await page.evaluate(`(() => {
    const list = document.querySelector('.page-actions .menu-list');
    const items = [...list.querySelectorAll('.menu-item')];
    const last = items[items.length - 1];
    last.scrollIntoView({ block: 'nearest' });
    const listRect = list.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    return {
      vh: window.innerHeight,
      lastLabel: last.textContent?.trim() ?? '',
      listTop: listRect.top,
      listBottom: listRect.bottom,
      lastTop: lastRect.top,
      lastBottom: lastRect.bottom,
    };
  })()`);
  equal(menuCheck.vh, 390, 'el alto del viewport debe ser 390px');
  check(menuCheck.lastLabel.includes('Cerrar Folio'), `el último ítem del menú debe ser Cerrar Folio (fue: ${menuCheck.lastLabel})`);
  check(menuCheck.listBottom <= 390 && menuCheck.lastBottom <= 390 && menuCheck.lastTop >= 0, `el último ítem debe quedar visible en 390px de alto (${JSON.stringify(menuCheck)})`);

  // Verificar encabezado rediseñado: metadatos discretos a la derecha y modo compacto en cuaderno chico
  const metaRight = await page.evaluate(`(() => {
    const head = document.querySelector('.page-head')?.getBoundingClientRect();
    const meta = document.querySelector('.page-meta')?.getBoundingClientRect();
    return head && meta ? meta.right >= head.right - 36 : false;
  })()`);
  check(metaRight, 'los metadatos del encabezado están ubicados a la derecha');
});

// -----------------------------------------------------------------------------
// FEATURE 4: Categoría Recortes + Ctrl+Alt+X
// -----------------------------------------------------------------------------
test('4. Categoría Recortes + Ctrl+Alt+X: categoría existe y recorte se asigna a Recortes', async (page) => {
  // 1. Abrir ventana de captura (hoja suelta)
  await page.open({ width: 500, height: 600, query: '?window=capture' });
  await page.until(() => page.ask('count', '.loose-meta .chip'), 'no apareció el chip de categoría en la hoja suelta');

  // Inicialmente sin categoría
  const initialCat = await page.evaluate("document.querySelector('.loose-meta .chip')?.textContent?.trim() ?? ''");
  equal(initialCat, 'Sin categoría', 'inicialmente la hoja suelta no tiene categoría asignada');

  // 2. Simular atajo global Ctrl + Alt + X mediante pulsación de teclas
  await page.key('x', { ctrl: true, alt: true });
  await sleep(350);

  // 3. Verificar que el texto del recorte capturado llegó a la hoja suelta
  await page.until(
    async () => (await page.evaluate("document.querySelector('.loose-text')?.value ?? ''")).includes('Recorte capturado'),
    'la hoja suelta no recibió el recorte capturado vía Ctrl+Alt+X',
  );

  // 4. Verificar que la categoría se asignó automáticamente a "Recortes" (o "Clippings")
  await page.until(
    async () => {
      const chip = await page.evaluate("document.querySelector('.loose-meta .chip')?.textContent?.trim() ?? ''");
      return chip.toLowerCase().includes('recorte') || chip.toLowerCase().includes('clipping');
    },
    'la categoría de la hoja suelta no se asignó automáticamente a Recortes',
  );

  const assignedCat = await page.evaluate("document.querySelector('.loose-meta .chip')?.textContent?.trim() ?? ''");
  check(
    assignedCat.toLowerCase().includes('recorte') || assignedCat.toLowerCase().includes('clipping'),
    `categoría inesperada en el chip: ${assignedCat}`,
  );

  // 5. Guardar la hoja suelta y verificar en las hojas que la nota creada tiene asignada la categoría Recortes
  await page.clickOn('.loose-actions button[aria-label="Guardar y cerrar"]');
  await sleep(350);

  const sheets = await api(page, "api.listSheets({ view: 'all' })");
  const savedNote = sheets.find((s) => s.preview.includes('Recorte capturado'));
  check(savedNote, 'no se encontró la nota del recorte guardado');
  check(savedNote.categoryId !== null, 'la nota guardada no tiene categoryId');

  const overview = await api(page, 'api.getOverview()');
  const cat = overview.categories.find((c) => c.id === savedNote.categoryId);
  check(cat && (cat.name.toLowerCase().includes('recorte') || cat.name.toLowerCase().includes('clipping')), `categoría errónea: ${cat?.name}`);
});

// -----------------------------------------------------------------------------
// FEATURE 5: Hojas del día (Hoy)
// -----------------------------------------------------------------------------
test('5. Hojas del día (Hoy): vista today, inclusión de notas de hoy, exclusión de anteriores y contador', async (page) => {
  await page.open({ width: 1280, height: 900, prefs: { size: 'standard', spread: 'double', markdown: false } });

  // 1. Obtener conteo inicial de notas de hoy
  const initialOverview = await api(page, 'api.getOverview()');
  const initialTodayCount = initialOverview.counts.today;

  // 2. Crear una nota nueva hoy
  const todayTitle = 'Nota Creada Hoy En Vivo';
  await api(page, `api.createNote(${JSON.stringify(todayTitle)}, 'Contenido redactado en el día de hoy')`);
  await sleep(250);

  // 3. Verificar que el contador counts.today aumentó en 1
  const afterOverview = await api(page, 'api.getOverview()');
  equal(afterOverview.counts.today, initialTodayCount + 1, 'el contador counts.today no se incrementó al crear una nota hoy');

  // 4. Verificar existencia de la solapa "Hoy"
  const todayTabCount = await page.ask('count', '.tab[aria-label="Ver Hoy"]');
  check(todayTabCount > 0, 'no se encontró la solapa "Ver Hoy"');

  // 5. Clic en la solapa "Hoy" para activar la vista today
  await page.clickOn('.tab[aria-label="Ver Hoy"]');
  await page.until(() => page.ask('count', '.tab.active[aria-label="Ver Hoy"]'), 'la solapa "Hoy" no quedó activa');
  await page.settle(300);

  // 6. Verificar que la nota de hoy aparece en la vista today
  const todaySheets = await api(page, "api.listSheets({ view: 'today' })");
  check(todaySheets.some((s) => s.title.includes(todayTitle)), 'la nota creada hoy no aparece en la vista today');

  // 7. Verificar que las notas de días anteriores (como "Regalos" o "viaje-bariloche.md") NO aparecen en today
  check(!todaySheets.some((s) => s.title === 'Regalos' || s.title.includes('viaje-bariloche')), 'notas de días anteriores aparecieron en Hoy');
  equal(todaySheets.length, afterOverview.counts.today, 'la cantidad de hojas en view: today no coincide con counts.today');

  // 8. Verificar que el indicador del pie refleja el contador de hojas de hoy
  const foot = await page.ask('label', '.sheet-indicator-text');
  check(foot && foot.includes(String(afterOverview.counts.today)), `el indicador de hoja (${foot}) no contiene el total de hoy (${afterOverview.counts.today})`);

  // 9. Volver a "Todas" haciendo clic en la solapa activa "Hoy"
  await page.clickOn('.tab[aria-label="Ver Hoy"]');
  await page.until(() => page.ask('count', '.tab.active[aria-label="Ver Todas"]'), 'hacer clic en la solapa activa Hoy no volvió a Todas');
  await page.settle(300);

  // 10. Verificar layout de pestañas: izquierda (Todas + categorías comunes solo-color con tooltip), derecha (Hoy, Fijas, Recortes, Secret-book, Papelera)
  const tabLayout = await page.evaluate(`(() => {
    const allTabs = [...document.querySelectorAll('.tabs .tab')];
    const leftTabs = allTabs.filter((t) => !t.classList.contains('at-end'));
    const rightTabs = allTabs.filter((t) => t.classList.contains('at-end'));
    const commonColorTabs = leftTabs.slice(1);
    return {
      firstLeftLabel: leftTabs[0]?.getAttribute('aria-label'),
      commonAllColorOnly: commonColorTabs.length > 0 && commonColorTabs.every((t) => t.classList.contains('color-only') && t.textContent.trim() === '' && (t.getAttribute('title') || '').includes(',')),
      rightLabels: rightTabs.map((t) => t.getAttribute('aria-label')),
    };
  })()`);
  equal(tabLayout.firstLeftLabel, 'Ver Todas', 'la primera pestaña izquierda debe ser Ver Todas');
  check(tabLayout.commonAllColorOnly, 'las pestañas de categorías comunes deben ser solo-color sin texto y con tooltip del nombre');
  equal(
    JSON.stringify(tabLayout.rightLabels),
    JSON.stringify(['Ver Hoy', 'Ver Fijas', 'Ver Recortes', 'Ver Secret-book', 'Ver Papelera']),
    `orden incorrecto en pestañas derechas: ${JSON.stringify(tabLayout.rightLabels)}`,
  );

  // 11. Verificar pestaña "Fijas": fijar una hoja incrementa counts.pinned y aparece en la vista Fijas
  const noteToPin = todaySheets.find((s) => s.title.includes(todayTitle));
  check(noteToPin, 'no se encontró la nota creada hoy para fijarla');
  await api(page, `api.setSheetPinned(${noteToPin.id}, true)`);
  await sleep(250);

  await page.clickOn('.tab[aria-label="Ver Fijas"]');
  await page.until(() => page.ask('count', '.tab.active[aria-label="Ver Fijas"]'), 'la solapa "Fijas" no quedó activa');
  await page.settle(300);

  const pinnedOverview = await api(page, 'api.getOverview()');
  const pinnedSheets = await api(page, "api.listSheets({ view: 'pinned' })");
  check(pinnedSheets.length > 0 && pinnedSheets.every((s) => s.pinned && !s.secret && !s.hidden), 'la vista pinned debe devolver solo hojas fijadas visibles');
  check(pinnedSheets.some((s) => s.id === noteToPin.id), 'la hoja fijada debe aparecer en la vista pinned');
  equal(pinnedSheets.length, pinnedOverview.counts.pinned, 'counts.pinned debe coincidir con las hojas de la vista pinned');
});

// -----------------------------------------------------------------------------
// Ejecución de la suite
// -----------------------------------------------------------------------------
const { page, close } = await launch(WINDOW.full);
let failures = [];
try {
  failures = await run(page);
} finally {
  await close();
}
process.exit(failures.length ? 1 : 0);
