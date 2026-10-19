// Pruebas de punta a punta del cifrado del secret-book: estado en Ajustes → Datos,
// copia de la clave de respaldo, bloqueo al perder la clave, desbloqueo y lectura
// de las hojas secretas en el cuaderno. Corren sobre la interfaz con datos de muestra
// (src/mock.ts), en un Edge sin ventana.
//
// Uso (desde la carpeta del proyecto):
//   node tests/e2e/secret.mjs
//
// Ver tests/e2e/README.md para los puertos y lo que hace falta tener instalado.

import { check, equal, launch, sleep, suite } from './harness.mjs';

const { test, run } = suite();

const BACKUP_KEY = Buffer.from('mock-secret-key-256-bits-base64').toString('base64');

/** Abre Ajustes en su propia ventana y navega a la pestaña Datos. */
async function openDataTab(page, width = 760) {
  await page.open({ width, height: 900, query: '?window=settings' });
  await page.until(async () => (await page.ask('count', '.settings-tabs [role="tab"]')) > 0, 'no cargaron las pestañas de Ajustes');
  await page.clickOn('.settings-tabs [role="tab"]', 'Datos');
  await page.until(
    async () => (await page.evaluate(`[...document.querySelectorAll('.settings-body .group h3')].some((e) => e.textContent === 'Cuaderno secreto')`)),
    'no apareció la sección Cuaderno secreto',
  );
  await sleep(250);
}

// ---- las pruebas ------------------------------------------------------------------------

test('la sección Cuaderno secreto en Datos muestra el estado activo y permite copiar la clave de respaldo', async (page) => {
  await openDataTab(page);

  // Verifica que exista el grupo "Cuaderno secreto".
  const titles = await page.evaluate(`[...document.querySelectorAll('.settings-body .group h3')].map((e) => e.textContent)`);
  check(titles.includes('Cuaderno secreto'), `no se encontró el grupo Cuaderno secreto en: ${titles.join(', ')}`);

  // Verifica el renglón de estado activo.
  const row = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.settings-body .row')];
    const secretRow = rows.find((r) => r.textContent.includes('Cifrado activo'));
    return secretRow ? secretRow.textContent : null;
  })()`);
  check(row !== null, 'no se encontró el renglón con Cifrado activo');
  check(row.includes('disponible en este equipo') || row.includes('Windows'), `el detalle no menciona la clave o Windows: ${row}`);

  // Verifica que estén los botones de acción.
  const buttons = await page.evaluate(`[...document.querySelectorAll('.settings-body button')].map((b) => b.textContent)`);
  check(buttons.includes('Copiar clave') || buttons.includes('Copiar clave de respaldo'), 'falta el botón Copiar clave');
  check(buttons.includes('Restaurar clave…') || buttons.includes('Ingresar clave de respaldo…'), 'falta el botón Restaurar clave…');

  // Copia la clave de respaldo y verifica la respuesta visual.
  await page.clickOn('button', 'Copiar clave');
  await page.until(
    async () => (await page.evaluate(`[...document.querySelectorAll('.settings-body button')].some((b) => b.textContent === 'Copiada')`)),
    'el botón no mostró el aviso Copiada tras hacer clic',
  );

  // Prueba abrir el formulario de ingreso y cancelarlo.
  await page.clickOn('button', 'Restaurar clave…');
  await page.until(
    async () => (await page.ask('count', 'input[aria-label="Clave de respaldo"]')) > 0,
    'no se abrió el campo para ingresar la clave',
  );
  await page.clickOn('button', 'Cancelar');
  await page.until(
    async () => (await page.ask('count', 'input[aria-label="Clave de respaldo"]')) === 0,
    'no se cerró el campo tras cancelar',
  );
});

test('al perder la clave muestra el aviso de bloqueo y se desbloquea ingresando la clave de respaldo', async (page) => {
  await openDataTab(page);

  // Simula la pérdida de la clave del llavero.
  await page.evaluate(`window.simulateSecretKeyLoss && window.simulateSecretKeyLoss()`);

  // Espera a que la sección de ajustes refleje el estado bloqueado.
  await page.until(
    async () => (await page.evaluate(`[...document.querySelectorAll('.settings-body .row')].some((r) => r.textContent.includes('Hojas secretas bloqueadas'))`)),
    'no apareció el aviso de hojas secretas bloqueadas',
  );

  const lockedText = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.settings-body .row')];
    return rows.find((r) => r.textContent.includes('Hojas secretas bloqueadas'))?.textContent ?? '';
  })()`);
  check(lockedText.includes('1 hoja secreta bloqueada') || lockedText.includes('bloqueada'), `no indicó la cantidad de hojas bloqueadas: ${lockedText}`);

  // Verifica el botón de desbloqueo deshabilitado sin clave.
  const unlockBtnDisabled = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.settings-body button')].find((b) => b.textContent.includes('Desbloquear hojas secretas'));
    return btn ? btn.disabled : null;
  })()`);
  equal(unlockBtnDisabled, true, 'el botón de desbloquear debe estar deshabilitado cuando el campo está vacío');

  // Ingresa la clave de respaldo y desbloquea.
  await page.clickOn('input[aria-label="Clave de respaldo"]');
  await page.type(BACKUP_KEY);
  await sleep(200);

  const unlockBtnEnabled = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.settings-body button')].find((b) => b.textContent.includes('Desbloquear hojas secretas'));
    return btn ? !btn.disabled : false;
  })()`);
  check(unlockBtnEnabled, 'el botón de desbloquear no se habilitó con la clave ingresada');

  await page.clickOn('button', 'Desbloquear hojas secretas');

  // Verifica que volvió al estado activo.
  await page.until(
    async () => (await page.evaluate(`[...document.querySelectorAll('.settings-body .row')].some((r) => r.textContent.includes('Cifrado activo'))`)),
    'no volvió al estado activo luego de desbloquear',
  );

  // Abre el cuaderno principal y verifica que la hoja secreta se lee correctamente.
  await page.open({ width: 1280, height: 900 });
  await page.until(async () => !(await page.state()).busy, 'el cuaderno no cargó');

  await page.clickOn('.tab[aria-label="Ver Secret-book"]');
  await page.until(async () => ((await page.state()).mode ?? '').startsWith('Secret-book'), 'no se abrió el secret-book');

  // Espera a que la hoja secreta esté a la vista.
  await page.until(async () => (await page.state()).title === 'Accesos servidor de pruebas', 'no mostró la hoja secreta');
  const sheetState = await page.state();
  check(
    (sheetState.text ?? '').includes('demo-cuenta') || (sheetState.text ?? '').includes('secreto-de-muestra'),
    `no se pudo leer el contenido descifrado de la hoja secreta: ${sheetState.text}`,
  );
});

// ---- correr --------------------------------------------------------------------------

const { page, close } = await launch({ width: 760, height: 900 });
let failures = [];
try {
  failures = await run(page);
} finally {
  await close();
}
process.exit(failures.length ? 1 : 0);
