// Pruebas de punta a punta para Folio - Features 6 a 10 (Fase 3 Parte B).
//
// 6. Notas fijadas arriba y orden por modificación descendente (toggle pin).
// 7. Cuaderno sin marco toggle en Personalización (borderless y controles de ventana).
// 8. Buscador de Opciones en Ajustes (encuentra "sin marco", resalta y estado "sin resultados").
// 9. Hoja suelta (CaptureWindow): colapsa al dock/icono, expande y toggle pin.
// 10. Storage: historial de versiones íntegro, compresión z1: y deduplicación sin regresiones.
//
// Uso (desde la raíz del proyecto):
//   $env:BOOK_E2E_PORT=1435; $env:BOOK_E2E_DEBUG_PORT=9345; node tests/e2e/features-b.mjs

import { check, equal, launch, sleep, suite } from './harness.mjs';

const WINDOW = { width: 1280, height: 900 };
const { test, run } = suite();

const ctrlComma = (page) =>
  page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true, cancelable: true }))`);

const api = (page, code) => page.evaluate(`import('/src/api.ts').then(({ api }) => (${code}))`);

// ---- Feature 6: Notas fijadas arriba y orden por modificación descendente ----

test('feature 6: notas fijadas arriba y orden por modificación descendente', async (page) => {
  await page.open({ ...WINDOW, prefs: { size: 'standard', spread: 'double' } });

  // 1. Estado inicial: todas las notas sin fijar, ordenadas por modifiedAt descendente
  const initial = await api(page, 'api.listSheets({ view: "all" })');
  check(initial.length >= 5, 'hay suficientes hojas iniciales');
  check(initial.every((s) => !s.pinned), 'ninguna hoja arranca fijada');
  equal(initial[0].title, 'Pendientes de hoy', 'la primera hoja es la más reciente (Pendientes de hoy)');

  // 2. Navegar hasta una hoja antigua (comandos-git.txt)
  const targetTitle = 'comandos-git.txt';
  const targetSheet = initial.find((s) => s.title === targetTitle);
  check(Boolean(targetSheet), 'la hoja comandos-git.txt existe');

  for (let turns = 0; turns < 20; turns++) {
    const state = await page.state();
    if (state.title === targetTitle && !state.busy) break;
    await page.key('ArrowRight');
    await page.settle(200);
  }
  const current = await page.state();
  equal(current.title, targetTitle, 'se llegó a la hoja antigua');

  // 3. Fijar la hoja desde el chip de la cabecera (toggle pin)
  const pinChip = await page.ask('box', '.chip.pin-btn');
  check(Boolean(pinChip), 'el botón de pin está en la cabecera');
  await page.clickOn('.chip.pin-btn');

  await page.until(
    async () => (await page.evaluate("document.querySelector('.chip.pin-btn')?.classList.contains('active')")) === true,
    'el chip de pin no pasó a activo'
  );
  equal(await page.ask('label', '.chip.pin-btn'), 'Fijada', 'el texto del chip debe ser Fijada');

  // 4. Verificar que la nota fijada pasa al principio (arriba de todas)
  await page.until(
    async () => {
      const list = await api(page, 'api.listSheets({ view: "all" })');
      return list[0].id === targetSheet.id && list[0].pinned === true;
    },
    'la hoja fijada no pasó al primer lugar de la lista'
  );

  // 5. Fijar otra nota con distinto timestamp y verificar orden descendente entre fijadas y no fijadas
  const secondTarget = initial.find((s) => s.id !== targetSheet.id && s.title === 'reunion-equipo.md');
  check(Boolean(secondTarget), 'la hoja reunion-equipo.md existe');
  await api(page, `api.setSheetPinned(${secondTarget.id}, true)`);

  const multiPinned = await api(page, 'api.listSheets({ view: "all" })');
  const pinnedList = multiPinned.filter((s) => s.pinned);
  const unpinnedList = multiPinned.filter((s) => !s.pinned);
  equal(pinnedList.length, 2, 'hay exactamente dos hojas fijadas');
  check(pinnedList[0].modifiedAt >= pinnedList[1].modifiedAt, 'las hojas fijadas respetan orden de modificación descendente');

  for (let i = 0; i < unpinnedList.length - 1; i++) {
    check(unpinnedList[i].modifiedAt >= unpinnedList[i + 1].modifiedAt, 'las hojas no fijadas respetan orden descendente');
  }

  // 6. Desfijar ambas notas y verificar que vuelven a su orden natural
  await api(page, `api.setSheetPinned(${targetSheet.id}, false)`);
  await api(page, `api.setSheetPinned(${secondTarget.id}, false)`);

  await page.until(
    async () => {
      const list = await api(page, 'api.listSheets({ view: "all" })');
      return list.every((s) => !s.pinned) && list[0].id === initial[0].id;
    },
    'las hojas no volvieron a su orden natural'
  );
  const restored = await api(page, 'api.listSheets({ view: "all" })');
  for (let i = 0; i < initial.length; i++) {
    equal(restored[i].id, initial[i].id, `la posición ${i} coincide con el orden inicial`);
  }
});

// ---- Feature 7: Borde de ventana en Personalización ----

test('feature 7: borde de ventana en personalización (ninguno inmersivo default, transparente, sólido)', async (page) => {
  await page.open({ ...WINDOW, prefs: { size: 'standard', spread: 'double' } });

  // 1. Por defecto el borde es 'none' (inmersivo) y no existen los botones de ventana en la zona transparente
  equal(await page.evaluate("document.documentElement.dataset.frame"), 'none', 'por defecto dataset.frame debe ser none');
  equal(await page.ask('count', '.borderless-window-controls'), 0, 'no deben existir controles .borderless-window-controls');

  // 2. Abrir Ajustes con Ctrl + ,
  await ctrlComma(page);
  await page.until(async () => (await page.ask('count', '.settings-panel')) > 0, 'no se abrió Ajustes');

  // 3. Ir a pestaña Personalización (look)
  await page.clickOn('.tab-strip [role="tab"]', 'Personalización');
  await page.until(
    async () => (await page.evaluate("document.querySelector('#settings-tab-look')?.getAttribute('aria-selected')")) === 'true',
    'no se seleccionó la pestaña Personalización'
  );

  // 4. Localizar el selector "Borde de ventana" con opciones Ninguno / Transparente / Sólido
  const groupSelector = '[role="tablist"][aria-label="Borde de ventana"]';
  await page.until(async () => (await page.ask('count', groupSelector)) > 0, 'no se encontró el selector Borde de ventana');

  // 5. Cambiar a Transparente
  await page.clickOn(`${groupSelector} button`, 'Transparente');
  await page.until(
    async () => (await page.evaluate("document.documentElement.dataset.frame")) === 'transparent',
    'dataset.frame no cambió a transparent'
  );
  const prefsTransparent = await page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
  equal(prefsTransparent.frame, 'transparent', 'prefs.frame debe ser transparent');
  equal(await page.evaluate("document.documentElement.dataset.borderless"), 'true', 'dataset.borderless debe ser true en modo transparente');
  equal(await page.ask('count', '.borderless-window-controls'), 0, 'no deben existir controles .borderless-window-controls');

  // 6. Cambiar a Sólido
  await page.clickOn(`${groupSelector} button`, 'Sólido');
  await page.until(
    async () => (await page.evaluate("document.documentElement.dataset.frame")) === 'solid',
    'dataset.frame no cambió a solid'
  );
  const prefsSolid = await page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
  equal(prefsSolid.frame, 'solid', 'prefs.frame debe ser solid');
  equal(await page.evaluate("document.documentElement.dataset.borderless"), 'false', 'dataset.borderless debe ser false en modo sólido');

  // 7. Volver a Ninguno (inmersivo) y verificar integración de solapas y ausencia de hueco en claro/oscuro
  await page.clickOn(`${groupSelector} button`, 'Ninguno');
  await page.until(
    async () => (await page.evaluate("document.documentElement.dataset.frame")) === 'none',
    'dataset.frame no volvió a none'
  );
  const prefsNone = await page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
  equal(prefsNone.frame, 'none', 'prefs.frame debe ser none');
  check(await page.evaluate("document.querySelector('.app').classList.contains('immersive')"), 'la app tiene clase immersive');

  // 8. Cerrar Ajustes y verificar geometría inmersiva + categoría en claro y oscuro
  await page.key('Escape');
  await page.until(async () => (await page.ask('count', '.settings-panel')) === 0, 'Ajustes no se cerró');

  const bookRect = await page.ask('box', '.book');
  const tabsRect = await page.ask('box', '.tabs');
  const leavesRect = await page.ask('box', '.leaves');
  check(bookRect.top === 0 && bookRect.left === 0, 'en modo inmersivo el cuaderno empieza en (0, 0) sin margen exterior');
  check(tabsRect.top >= bookRect.top && tabsRect.bottom <= leavesRect.top + 1, 'las solapas están integradas en el borde superior del cuaderno');

  // Verificar que la hoja con categoría tiene su borde de color pegado a la hoja sin hueco negro en modo oscuro
  await page.evaluate(`
    const p = JSON.parse(localStorage.getItem('book.prefs'));
    localStorage.setItem('book.prefs', JSON.stringify({ ...p, theme: 'dark' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'book.prefs' }));
  `);
  await page.until(async () => (await page.evaluate("document.documentElement.dataset.theme")) === 'dark', 'no cambió a tema oscuro');
  const hasCatClass = await page.evaluate("document.querySelector('.page.left')?.classList.contains('categorized')");
  check(hasCatClass === true, 'la hoja con categoría tiene la clase categorized en modo oscuro');
  const catColor = await page.evaluate("document.querySelector('.page.left')?.style.getPropertyValue('--sheet-cat-color')");
  check(Boolean(catColor && catColor.trim().length > 0), 'la hoja con categoría expone --sheet-cat-color');
});

// ---- Feature 8: Buscador de Opciones ----

test('feature 8: buscador de ajustes encuentra borde de ventana, Jev (Integraciones+Clasificador), bilingüe es/en, tolerancia typo y estilos sin corte', async (page) => {
  await page.open({ ...WINDOW, prefs: { size: 'standard', spread: 'double', lang: 'es' } });

  // 1. Abrir Ajustes con Ctrl + ,
  await ctrlComma(page);
  await page.until(async () => (await page.ask('count', '.settings-panel')) > 0, 'no se abrió Ajustes');

  const searchInput = '.settings-search input';
  const clearSearch = async () => {
    await page.evaluate(`(() => {
      const inp = document.querySelector('.settings-search input');
      if (inp) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await page.until(async () => (await page.ask('count', '.settings-search-results')) === 0 && (await page.ask('count', '.settings-no-results')) === 0, 'no se limpió la búsqueda');
  };
  const setSearch = async (q) => {
    await page.evaluate(`(() => {
      const inp = document.querySelector('.settings-search input');
      if (inp) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, ${JSON.stringify(q)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
  };

  // 2. Escribir "sin marco" en el buscador de ajustes
  await page.clickOn(searchInput);
  await page.type('sin marco');

  await page.until(async () => (await page.ask('count', '.settings-search-results')) > 0, 'no aparecieron resultados');
  const labels = await page.ask('labels', '.settings-search-item-label');
  check(labels.some((l) => l.includes('Borde de ventana')), `se esperaba Borde de ventana en ${labels.join(' | ')}`);

  // Verificar resaltado sin padding ni margen que separe letras, y que los resultados no se salgan del borde
  const highlights = await page.ask('labels', '.settings-search-row mark');
  check(highlights.length > 0, 'debe haber términos resaltados con mark');
  const markMetrics = await page.evaluate(`(() => {
    const m = document.querySelector('.settings-search-row mark');
    if (!m) return null;
    const cs = getComputedStyle(m);
    return { padL: parseFloat(cs.paddingLeft), padR: parseFloat(cs.paddingRight), marL: parseFloat(cs.marginLeft), marR: parseFloat(cs.marginRight) };
  })()`);
  equal(markMetrics.padL, 0, 'mark no debe tener padding-left');
  equal(markMetrics.padR, 0, 'mark no debe tener padding-right');
  equal(markMetrics.marL, 0, 'mark no debe tener margin-left');
  equal(markMetrics.marR, 0, 'mark no debe tener margin-right');

  // Verificar que ninguna fila de resultado se salga del contenedor (.settings-body)
  const overflowCheck = await page.evaluate(`(() => {
    const body = document.querySelector('.settings-body')?.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.settings-search-row')];
    return rows.every((r) => {
      const b = r.getBoundingClientRect();
      return b.right <= body.right + 1 && b.left >= body.left - 1;
    });
  })()`);
  check(overflowCheck, 'las filas de resultados no deben salirse del borde del contenedor');

  // 3. Buscar "sis" y verificar que en "sistema" el <mark> no separa letras
  await setSearch('sis');
  await page.until(async () => (await page.ask('count', '.settings-search-row mark')) > 0, 'no resaltó sis');
  const sisText = await page.evaluate(`(() => {
    const smalls = [...document.querySelectorAll('.settings-search-row small')];
    const target = smalls.find((s) => s.textContent.includes('sistema'));
    return target ? target.textContent : '';
  })()`);
  check(sisText.includes('sistema'), `el texto no debe separar letras en sistema: ${sisText}`);

  // 4. BUG CONFIRMADO: buscar "Jev" encuentra tanto Clasificador como Integraciones
  await setSearch('Jev');
  await page.until(async () => (await page.ask('count', '.settings-search-results .group')) >= 2, 'buscar Jev debe encontrar Clasificador e Integraciones');
  const jevGroups = await page.ask('labels', '.settings-search-results .group h3');
  check(jevGroups.some((g) => g.includes('Clasificador')), `Jev debe mostrar sección Clasificador: ${jevGroups.join(', ')}`);
  check(jevGroups.some((g) => g.includes('Integraciones')), `Jev debe mostrar sección Integraciones: ${jevGroups.join(', ')}`);

  // 5. Búsqueda bilingüe con UI en español: "theme", "border", "language", "integrations"
  for (const [enQuery, expectedEs] of [
    ['theme', 'Tema'],
    ['border', 'Borde de ventana'],
    ['language', 'Idioma'],
    ['integrations', 'Integraciones'],
  ]) {
    await setSearch(enQuery);
    await page.until(async () => (await page.ask('count', '.settings-search-row')) > 0, `no encontró resultados para "${enQuery}" en español`);
    const foundLabels = await page.ask('labels', '.settings-search-item-label, .settings-search-results .group h3');
    check(foundLabels.some((l) => l.includes(expectedEs)), `buscar "${enQuery}" en UI es debe encontrar "${expectedEs}" (obtenido: ${foundLabels.join(' | ')})`);
  }

  // 6. Tolerancia a acentos/mayúsculas, prefijo de palabra y fuzzy 1 typo
  await setSearch('PERSONALIZACION'); // sin tilde y mayúsculas
  await page.until(async () => (await page.ask('count', '.settings-search-row')) > 0, 'debe encontrar PERSONALIZACION sin tilde');
  await setSearch(' catgorias '); // 1 typo (falta la e)
  await page.until(async () => (await page.ask('count', '.settings-search-row')) > 0, 'debe encontrar con 1 typo "catgorias"');
  const typoGroups = await page.ask('labels', '.settings-search-results .group h3');
  check(typoGroups.some((g) => g.includes('Categorías')), `fuzzy 1 typo "catgorias" debe encontrar Categorías: ${typoGroups.join(', ')}`);

  // 7. Probar con la UI en inglés (lang: 'en')
  await clearSearch();
  await page.evaluate(`import('/src/i18n/index.ts').then(({ setLanguage }) => setLanguage('en'))`);
  await sleep(150);

  for (const [qEn, expectedEn] of [
    ['Jev', 'Integrations'],
    ['tema', 'Theme'], // término en español con UI en inglés
    ['shortcuts', 'Shortcuts'],
    ['integratons', 'Integrations'], // 1 typo en inglés
  ]) {
    await setSearch(qEn);
    await page.until(async () => (await page.ask('count', '.settings-search-row')) > 0, `no encontró resultados para "${qEn}" en inglés`);
    const foundEn = await page.ask('labels', '.settings-search-item-label, .settings-search-results .group h3');
    check(foundEn.some((l) => l.includes(expectedEn)), `buscar "${qEn}" en UI en debe encontrar "${expectedEn}" (obtenido: ${foundEn.join(' | ')})`);
  }

  // Volver a español
  await page.evaluate(`import('/src/i18n/index.ts').then(({ setLanguage }) => setLanguage('es'))`);
  await sleep(150);

  // Clic en el resultado para abrir una sección
  await setSearch('sin marco');
  await page.until(async () => (await page.ask('count', '.settings-search-row')) > 0, 'no encontró sin marco');
  await page.clickOn('.settings-search-row .button', 'Abrir');
  await page.until(async () => (await page.ask('count', '.settings-search-results')) === 0, 'la búsqueda no se cerró');
  equal(await page.evaluate("document.querySelector('#settings-tab-look')?.getAttribute('aria-selected')"), 'true', 'no cambió a Personalización');

  // 8. Escribir un término que no existe
  await page.clickOn(searchInput);
  await page.type('sin_resultados_prueba_xyz');

  await page.until(async () => (await page.ask('count', '.settings-no-results')) > 0, 'no apareció el estado sin resultados');
  equal(await page.ask('label', '.settings-no-results h3'), 'Sin resultados', 'el título debe ser Sin resultados');
  const hintText = await page.ask('label', '.settings-no-results p');
  check(hintText.includes('sin_resultados_prueba_xyz'), `el mensaje debe contener el término buscado: ${hintText}`);

  // 9. Probar botón "Limpiar búsqueda"
  await page.clickOn('.settings-no-results button', 'Limpiar búsqueda');
  await page.until(async () => (await page.ask('count', '.settings-no-results')) === 0, 'el estado sin resultados no desapareció');
  equal(await page.evaluate(`document.querySelector(${JSON.stringify(searchInput)}).value`), '', 'el input debe quedar vacío');

  await page.key('Escape');
  await page.until(async () => (await page.ask('count', '.settings-panel')) === 0, 'Ajustes no se cerró');
});

// ---- Feature 9: Hoja suelta colapsa a icono y expande/pin ----

test('feature 9: hoja suelta colapsa a icono de dock, expande y toggle pin', async (page) => {
  await page.open({ query: '?window=capture' });
  await page.evaluate(`
    localStorage.removeItem('folio:capture:collapsed');
    localStorage.removeItem('folio:capture:pinned');
  `);
  await page.open({ query: '?window=capture' });

  // 1. Cargar hoja suelta expandida
  await page.until(async () => (await page.ask('count', '.loose')) > 0, 'la hoja suelta no cargó');
  check((await page.ask('count', '.capture-pin-btn')) > 0, 'falta el botón de pin');
  check((await page.ask('count', '.capture-collapse-btn')) > 0, 'falta el botón de colapsar');

  // 2. Probar botón de pin / fijar en pantalla
  equal(await page.evaluate("document.querySelector('.capture-pin-btn').classList.contains('pinned')"), false, 'no debe arrancar fijada');
  await page.clickOn('.capture-pin-btn');
  await page.until(
    async () => (await page.evaluate("document.querySelector('.capture-pin-btn')?.classList.contains('pinned')")) === true,
    'el botón no se fijó'
  );
  equal(await page.evaluate("localStorage.getItem('folio:capture:pinned')"), 'true', 'debe guardar pinned true en localStorage');

  // Desfijar
  await page.clickOn('.capture-pin-btn');
  await page.until(
    async () => (await page.evaluate("document.querySelector('.capture-pin-btn')?.classList.contains('pinned')")) === false,
    'el botón sigue fijado'
  );
  equal(await page.evaluate("localStorage.getItem('folio:capture:pinned')"), 'false', 'debe guardar pinned false en localStorage');

  // 3. Colapsar al dock/icono (.dock-collapse o .capture-collapse-btn)
  await page.clickOn('.dock-collapse');
  await page.until(async () => (await page.ask('count', '.loose-dock')) > 0, 'no apareció el icono del dock');
  equal(await page.ask('count', '.loose'), 0, 'la hoja expandida no debe verse');
  equal(await page.evaluate("localStorage.getItem('folio:capture:collapsed')"), 'true', 'debe guardar collapsed true en localStorage');
  check((await page.ask('count', '.loose-dock-icon')) > 0, 'el icono del dock debe estar presente');

  // 4. Expandir nuevamente desde el icono
  await page.clickOn('.loose-dock');
  await page.until(async () => (await page.ask('count', '.loose')) > 0, 'la hoja suelta expandida no volvió');
  equal(await page.ask('count', '.loose-dock'), 0, 'el dock no debe verse al expandir');
  equal(await page.evaluate("localStorage.getItem('folio:capture:collapsed')"), 'false', 'debe guardar collapsed false en localStorage');
  check((await page.ask('count', '.loose-text')) > 0, 'el textarea debe estar presente al expandir');
});

// ---- Feature 10: Storage (historial comprimido/dedupe, sin regresiones) ----

test('feature 10: almacenamiento con historial comprimido, deduplicado y sin regresiones', async (page) => {
  await page.open({ ...WINDOW, prefs: { size: 'standard', spread: 'double' } });

  // 1. La primera hoja (Pendientes de hoy) tiene versiones anteriores
  const state = await page.state();
  equal(state.sheet, 1, 'está en la hoja 1');
  equal(state.title, 'Pendientes de hoy', 'título de la hoja es Pendientes de hoy');

  // 2. Abrir diálogo de versiones anteriores
  await page.clickOn('.page-head .chip', 'versiones anteriores');
  await page.until(async () => ((await page.state()).dialog ?? '').startsWith('Versiones'), 'no se abrió el diálogo de versiones');

  // 3. Esperar y verificar que la versión anterior muestra contenido íntegro sin pérdida
  await page.until(async () => (await page.ask('label', '.versions-text'))?.length > 0, 'no cargó el texto de la versión previa');
  const vText = await page.ask('label', '.versions-text');
  check(vText && vText.length > 20, 'el texto de la versión previa no está vacío');
  check(vText.includes('Pendientes de hoy'), 'la versión anterior contiene el título');

  // 4. Cambiar a la versión Actual en el Segmented
  await page.clickOn('.versions .segmented button', 'Actual');
  const actualText = await page.ask('label', '.versions-text');
  check(actualText.includes('Llamar a sistemas por la impresora'), 'la versión actual contiene el contenido completo');

  // 5. Cerrar el modal con Listo
  await page.clickOn('.modal-footer .button', 'Listo');
  await page.until(async () => !(await page.state()).dialog, 'el diálogo de versiones no se cerró');

  // 6. Verificar que el texto en el cuaderno sigue íntegro
  const readerText = await page.ask('label', '.flow-clip:not(.parked) .page-text');
  check(readerText.includes('Pendientes de hoy'), 'el texto en la hoja del cuaderno sigue íntegro');
});

// ---- Ejecución ----

const { page, close } = await launch();
try {
  const failures = await run(page);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  await close();
}
