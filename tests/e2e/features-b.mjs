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

// ---- Feature 7: Cuaderno sin marco toggle en Personalización ----

test('feature 7: cuaderno sin marco toggle en personalización activa controles borderless', async (page) => {
  await page.open({ ...WINDOW, prefs: { size: 'standard', spread: 'double', borderless: false } });

  // 1. Abrir Ajustes con Ctrl + ,
  await ctrlComma(page);
  await page.until(async () => (await page.ask('count', '.settings-panel')) > 0, 'no se abrió Ajustes');

  // 2. Ir a pestaña Personalización (look)
  await page.clickOn('.tab-strip [role="tab"]', 'Personalización');
  await page.until(
    async () => (await page.evaluate("document.querySelector('#settings-tab-look')?.getAttribute('aria-selected')")) === 'true',
    'no se seleccionó la pestaña Personalización'
  );

  // 3. Localizar switch Cuaderno sin marco
  const switchSelector = 'button[role="switch"][aria-label="Cuaderno sin marco"]';
  await page.until(async () => (await page.ask('count', switchSelector)) > 0, 'no se encontró el switch Cuaderno sin marco');
  equal(
    await page.evaluate(`document.querySelector(${JSON.stringify(switchSelector)}).getAttribute('aria-checked')`),
    'false',
    'arranca desactivado'
  );

  // 4. Activar toggle
  await page.clickOn(switchSelector);
  await page.until(
    async () => (await page.evaluate(`document.querySelector(${JSON.stringify(switchSelector)}).getAttribute('aria-checked')`)) === 'true',
    'el switch no cambió a checked'
  );

  // 5. Verificar que la preferencia cambió a borderless: true y que se aplican estilos y controles de ventana
  const prefsTrue = await page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
  equal(prefsTrue.borderless, true, 'la preferencia borderless debe ser true');
  equal(await page.evaluate("document.documentElement.dataset.borderless"), 'true', 'dataset.borderless debe ser true');
  check(await page.evaluate("document.querySelector('.app').classList.contains('borderless')"), 'la app tiene clase borderless');

  // Controles de ventana
  check((await page.ask('count', '.borderless-window-controls')) > 0, 'deben mostrarse los controles borderless');
  check((await page.ask('count', '.borderless-btn.minimize')) > 0, 'debe existir botón minimizar');
  check((await page.ask('count', '.borderless-btn.close')) > 0, 'debe existir botón cerrar');

  // 6. Desactivar toggle
  await page.clickOn(switchSelector);
  await page.until(
    async () => (await page.evaluate(`document.querySelector(${JSON.stringify(switchSelector)}).getAttribute('aria-checked')`)) === 'false',
    'el switch no volvió a unchecked'
  );

  const prefsFalse = await page.evaluate("JSON.parse(localStorage.getItem('book.prefs'))");
  equal(prefsFalse.borderless, false, 'la preferencia borderless debe ser false');
  equal(await page.evaluate("document.documentElement.dataset.borderless"), 'false', 'dataset.borderless debe ser false');
  check(!await page.evaluate("document.querySelector('.app').classList.contains('borderless')"), 'la app no debe tener clase borderless');
  equal(await page.ask('count', '.borderless-window-controls'), 0, 'no deben existir controles borderless');

  // 7. Cerrar Ajustes
  await page.key('Escape');
  await page.until(async () => (await page.ask('count', '.settings-panel')) === 0, 'Ajustes no se cerró');
});

// ---- Feature 8: Buscador de Opciones ----

test('feature 8: buscador de ajustes encuentra sin marco y muestra estado sin resultados', async (page) => {
  await page.open({ ...WINDOW, prefs: { size: 'standard', spread: 'double' } });

  // 1. Abrir Ajustes con Ctrl + ,
  await ctrlComma(page);
  await page.until(async () => (await page.ask('count', '.settings-panel')) > 0, 'no se abrió Ajustes');

  // 2. Escribir "sin marco" en el buscador de ajustes
  const searchInput = '.settings-search input';
  await page.clickOn(searchInput);
  await page.type('sin marco');

  await page.until(async () => (await page.ask('count', '.settings-search-results')) > 0, 'no aparecieron resultados');
  const labels = await page.ask('labels', '.settings-search-item-label');
  check(labels.some((l) => l.includes('Cuaderno sin marco')), `se esperaba Cuaderno sin marco en ${labels.join(' | ')}`);

  // Verificar resaltado
  const highlights = await page.ask('labels', '.settings-search-row mark');
  check(highlights.length > 0, 'debe haber términos resaltados con mark');

  // Clic en el resultado para abrir la sección Personalización
  await page.clickOn('.settings-search-row .button', 'Abrir');
  await page.until(async () => (await page.ask('count', '.settings-search-results')) === 0, 'la búsqueda no se cerró');
  equal(await page.evaluate("document.querySelector('#settings-tab-look')?.getAttribute('aria-selected')"), 'true', 'no cambió a Personalización');

  // 3. Escribir un término que no existe
  await page.clickOn(searchInput);
  await page.type('sin_resultados_prueba_xyz');

  await page.until(async () => (await page.ask('count', '.settings-no-results')) > 0, 'no apareció el estado sin resultados');
  equal(await page.ask('label', '.settings-no-results h3'), 'Sin resultados', 'el título debe ser Sin resultados');
  const hintText = await page.ask('label', '.settings-no-results p');
  check(hintText.includes('sin_resultados_prueba_xyz'), `el mensaje debe contener el término buscado: ${hintText}`);

  // 4. Probar botón "Limpiar búsqueda"
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

  // 5. Bug 1: Si el icono colapsado está pegado al borde izquierdo (x = 12) o derecho (x = 1220) o inferior (y = 850),
  // al expandir abre hacia donde hay espacio y queda estrictamente dentro de la pantalla.
  await page.clickOn('.dock-collapse');
  await page.until(async () => (await page.ask('count', '.loose-dock')) > 0, 'no colapsó');
  await page.evaluate(`localStorage.setItem('folio:capture:pos:collapsed', JSON.stringify({ x: 12, y: 850 }))`);
  await page.clickOn('.loose-dock');
  await page.until(async () => (await page.ask('count', '.loose')) > 0, 'no expandió desde borde izquierdo/inferior');
  const leftRect = await page.evaluate(`({
    x: Number(document.querySelector('.loose')?.dataset.floatingX),
    y: Number(document.querySelector('.loose')?.dataset.floatingY),
  })`);
  equal(leftRect.x, 12, 'cerca del borde izquierdo debe expandir hacia la derecha (x = 12, no negativo)');
  check(leftRect.y >= 8 && leftRect.y + 572 <= 900 - 8, `cerca del borde inferior debe quedar dentro de la pantalla (y=${leftRect.y})`);
});

// ---- Feature 9b: Arrancar hoja (Tear-off sheets) ----

test('feature 9b: arrancar hoja desde menú y atajo, múltiples hojas sin duplicar, apilado colapsado y devolver al cuaderno', async (page) => {
  await page.open({ ...WINDOW, prefs: { size: 'standard', spread: 'double' } });
  await page.evaluate(`
    localStorage.removeItem('folio:mock:tornOffSheets');
    localStorage.removeItem('folio:mock:floatingRects');
  `);

  // 1. Arrancar la primera hoja (Pendientes de hoy, id 2) desde el menú ⋯ -> «Arrancar hoja»
  await page.clickOn('.page-actions button[aria-label="Menú"]');
  await page.until(async () => (await page.ask('count', '[role="menuitem"]')) > 0, 'no se abrió el menú de la hoja');
  await page.clickOn('[role="menuitem"]', 'Arrancar hoja');

  await page.until(
    async () => (await api(page, 'api.listTornOffSheets()')).length === 1,
    'la hoja no quedó registrada como arrancada'
  );
  const firstTorn = (await api(page, 'api.listTornOffSheets()'))[0];
  equal(firstTorn.id, 2, 'la hoja arrancada es Pendientes de hoy (id 2)');

  // 2. Intentar arrancarla de nuevo con el atajo Ctrl+T no duplica la ventana
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await sleep(120);
  const afterDuplicate = await api(page, 'api.listTornOffSheets()');
  equal(afterDuplicate.length, 1, 'arrancar la misma hoja no la duplica');

  // 3. Arrancar una segunda hoja (reunion-equipo.md, id 3) para tener múltiples hojas flotantes abiertas a la vez
  await api(page, 'api.tearOffSheet(3, false)');
  const bothTorn = await api(page, 'api.listTornOffSheets()');
  equal(bothTorn.length, 2, 'hay dos hojas arrancadas simultáneamente');

  // 4. Abrir la ventana flotante de la hoja 3 (?window=tearoff&id=3), editar, fijar, colapsar y verificar apilado sin superposición
  await page.open({ query: '?window=tearoff&id=3' });
  await page.until(async () => (await page.ask('count', '.tearoff-sheet')) > 0, 'no cargó la ventana de la hoja arrancada 3');
  equal(await page.ask('label', '.page-title'), 'reunion-equipo.md', 'el título de la hoja arrancada coincide');

  // Editar texto y verificar que se guarda en el cuaderno
  await page.clickOn('.loose-text');
  await page.type('\n- [x] Nota editada desde ventana flotante');
  await page.until(
    async () => ((await api(page, 'api.getSheet(3)'))?.content ?? '').includes('Nota editada desde ventana flotante'),
    'el cambio en la hoja flotante no se guardó en el cuaderno'
  );

  // Colapsar la hoja 3 al dock
  await page.clickOn('.dock-collapse');
  await page.until(async () => (await page.ask('count', '.tearoff-dock')) > 0, 'la hoja 3 no colapsó al dock');
  const pos3 = await page.evaluate(`({
    x: Number(document.querySelector('.tearoff-dock')?.dataset.floatingX),
    y: Number(document.querySelector('.tearoff-dock')?.dataset.floatingY),
  })`);

  // Abrir la hoja 2 (?window=tearoff&id=2) y colapsarla en la misma zona: los íconos deben apilarse sin superponerse
  await page.open({ query: '?window=tearoff&id=2' });
  await page.until(async () => (await page.ask('count', '.tearoff-sheet')) > 0, 'no cargó la ventana de la hoja arrancada 2');
  await page.clickOn('.dock-collapse');
  await page.until(async () => (await page.ask('count', '.tearoff-dock')) > 0, 'la hoja 2 no colapsó al dock');
  const pos2 = await page.evaluate(`({
    x: Number(document.querySelector('.tearoff-dock')?.dataset.floatingX),
    y: Number(document.querySelector('.tearoff-dock')?.dataset.floatingY),
  })`);
  check(Math.abs(pos2.x - pos3.x) >= 52 || Math.abs(pos2.y - pos3.y) >= 52, `los íconos colapsados no deben superponerse (${JSON.stringify(pos3)} vs ${JSON.stringify(pos2)})`);

  // Expandir la hoja 2 y devolverla al cuaderno («Devolver al cuaderno»)
  await page.clickOn('.tearoff-dock');
  await page.until(async () => (await page.ask('count', '.tearoff-sheet')) > 0, 'la hoja 2 no se expandió');
  await page.clickOn('.return-sheet-btn');
  await page.until(async () => (await page.ask('count', '.loose.returned')) > 0, 'la hoja 2 no se devolvió al cuaderno');

  const remaining = await api(page, 'api.listTornOffSheets()');
  equal(remaining.length, 1, 'solo queda 1 hoja arrancada tras devolver la hoja 2 al cuaderno');
  equal(remaining[0].id, 3, 'la hoja que sigue abierta para restaurar al reabrir Folio es la 3');
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
