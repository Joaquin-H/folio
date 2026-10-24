// Datos de muestra para ver la interfaz en el navegador (`pnpm dev`) sin el backend.
import type { Api } from './api';
import { defaultNoteTitle, titleFromContent } from './format';
import { fold, frontMatter } from './markdown';
import type { Ban, CaptureSeed, Category, Integration, IntegrationTool, ListFilter, ProviderId, ProviderStatus, Root, Settings, SheetDetail, SendTarget, Source } from './types';
// Las instrucciones de las integraciones son las mismas que instala el backend.
import claudeSkill from '../integrations/claude/folio-notes/SKILL.md?raw';
import codexBlock from '../integrations/codex/AGENTS.md?raw';
import geminiBlock from '../integrations/gemini/GEMINI.md?raw';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();

let categories: Omit<Category, 'count'>[] = [
  { id: 1, name: 'Trabajo', description: 'Tareas, reuniones, pendientes y temas laborales', color: '#007AFF' },
  { id: 2, name: 'Proyectos', description: 'Planes, ideas y avances de proyectos', color: '#5856D6' },
  { id: 3, name: 'Código', description: 'Fragmentos de código y comandos', color: '#30B0C7' },
  { id: 4, name: 'Casa', description: 'Hogar, trámites y familia', color: '#34C759' },
  { id: 5, name: 'Compras', description: 'Listas de compras, productos y precios', color: '#FF9500' },
  { id: 6, name: 'Finanzas', description: 'Gastos, pagos y presupuestos', color: '#FFCC00' },
  { id: 7, name: 'Salud', description: 'Turnos médicos, medicación y ejercicio', color: '#FF2D55' },
  { id: 8, name: 'Ideas', description: 'Ideas sueltas y cosas para investigar', color: '#AF52DE' },
];

type Seed = [title: string, source: Source, ageHours: number, categoryId: number | null, content: string];

/** Nota larga para probar cómo sigue el texto en las hojas siguientes. */
const longNote = [
  'Apuntes del curso',
  '',
  ...Array.from({ length: 14 }, (_, unit) => [
    `Unidad ${unit + 1}`,
    '- Repasar los conceptos de la clase y rehacer los ejercicios que salieron mal.',
    '- Anotar las dudas para la consulta del jueves.',
    '- Leer el capítulo correspondiente antes de la práctica.',
    '',
  ]).flat(),
  'Fin de los apuntes.',
].join('\n');

/** Nota en markdown con todo lo que se dibuja con formato, y con el encabezado de las integraciones. */
const richNote = `---
titulo: Plan del cuaderno con formato
categoria: proyectos
etiquetas: [book, markdown, diseño]
fuente: Claude Code
fecha: 2026-10-01
---

# Plan del cuaderno

Las notas en **markdown** se leen con formato, *sin perder* el rayado. Al escribir se ve el texto plano: es el original lo que se edita.

## Pendientes
- [x] Títulos, listas y citas
- [ ] Tablas sobre el rayado
- [ ] Probar con la letra muy grande

## Cómo se usa
1. Abrir una hoja \`.md\`
2. Hacer doble clic donde se quiera escribir
   - el cursor va al renglón del original
   - y ~~se pierde~~ sigue ahí al guardar

### Detalle
> Lo que no se entiende como markdown se ve tal cual,
> como en el Bloc de notas.

\`\`\`js
const hoja = await api.getSheet(id);
console.log(hoja.title);
\`\`\`

| Elemento | Renglones |
|:--|--:|
| Título grande | 2 |
| Párrafo | 1 o más |
| Separador | 1 |

---

Más en [la guía de CommonMark](https://commonmark.org/help/), en <https://www.markdownguide.org> o en [la copia local](guia.md).
![captura del cuaderno](captura.png)
<b>Esto no es HTML</b>, se ve como texto.`;

/** Nota larga en markdown: varias páginas con títulos, listas y código. */
const longMarkdown = [
  '# Bitácora del proyecto',
  '',
  ...Array.from({ length: 12 }, (_, week) => [
    `## Semana ${week + 1}`,
    `Se avanzó con **la parte ${week + 1}** y quedó *casi* lista.`,
    '- Revisar lo hecho con el equipo',
    '- [ ] Anotar lo que falta',
    week % 3 === 0 ? '```\npnpm test\n```' : '> Ojo con los tiempos de la semana que viene.',
    '',
  ]).flat(),
  'Fin de la bitácora.',
].join('\n');

const seeds: Seed[] = [
  ['Apuntes del curso', 'notepad', 1.2, null, longNote],
  ['Pendientes de hoy', 'notepad', 0.4, 1, 'Pendientes de hoy\n\n- Revisar el reporte de guardias antes de las 11\n- Responder a Martina por el acceso al gestor\n- Pasar a Jira lo que quedó de la reunión\n- Llamar a sistemas por la impresora del 3er piso\n\nSi sobra tiempo: ordenar la carpeta de Descargas.'],
  ['reunion-equipo.md', 'file', 2.5, 1, '# Reunión de equipo\n\nAsistentes: Lucía, Tomás, Martina, yo\n\n## Temas\n- Migración del gestor unificado: se posterga dos semanas\n- Nuevo tablero de indicadores\n- Capacitación de noviembre\n\n## Acciones\n- [ ] Enviar minuta\n- [ ] Pedir presupuesto actualizado\n- [x] Reservar la sala'],
  ['Lista del súper', 'sticky', 5, 5, 'Lista del súper\nyerba\ncafé\ntomates\nqueso rallado\npapel de cocina\ndetergente'],
  ['comandos-git.txt', 'file', 7, 3, 'git log --oneline --graph --decorate\ngit stash push -m "wip"\ngit rebase -i HEAD~3\ngit bisect start\n\n# deshacer el último commit sin perder cambios\ngit reset --soft HEAD~1'],
  ['Idea: cuaderno visual', 'capture', 26, 2, 'Idea: cuaderno visual\n\nUn solo lugar donde caigan todas las notas sueltas de la PC. Que se ordene solo por fecha y que una IA sugiera la categoría.\n\nPreguntas abiertas:\n- ¿cómo detectar lo sensible?\n- ¿cuántas versiones guardar?'],
  ['Turno dentista', 'notepad', 28, 7, 'Turno dentista\nJueves 15, 9:30\nLlevar la orden y los estudios anteriores.'],
  ['gastos-octubre.txt', 'file', 30, 6, 'Gastos de octubre\n\nAlquiler ........ pagado\nExpensas ........ pendiente\nInternet ........ pagado\nSeguro .......... vence el 20\n\nRevisar el resumen de la tarjeta.'],
  ['Para investigar', 'notepad', 51, 8, 'Para investigar\n\n- Búsqueda de texto completo en SQLite\n- Cómo guarda el Bloc de notas las pestañas sin guardar\n- Atajos globales por sistema operativo'],
  ['arreglos-casa.md', 'file', 54, 4, '# Arreglos pendientes\n\n- Canilla del baño que gotea\n- Burlete de la puerta del balcón\n- Colgar el estante del escritorio\n\nPlomero: pedir contacto a Sergio.'],
  ['Notas sueltas', 'notepad', 76, null, 'Notas sueltas\n\nEl código de la reserva es el que llegó por mail.\nConfirmar horario con Pablo.\n\nNo olvidar el cargador.'],
  ['capacitacion-noviembre.md', 'file', 98, 1, '# Capacitación de noviembre\n\nTemario tentativo\n1. Uso del gestor unificado\n2. Carga de incidentes\n3. Buenas prácticas de documentación\n\nFalta definir la fecha y quién da el módulo 3.'],
  ['Regalos', 'sticky', 122, 5, 'Regalos\nMamá: libro de recetas\nJuli: auriculares\nAbuelo: ajedrez nuevo'],
  ['snippet-fechas.txt', 'file', 148, 3, "const fmt = new Intl.DateTimeFormat('es-AR', { dateStyle: 'full' });\nconsole.log(fmt.format(new Date()));\n\n// ojo con la zona horaria al guardar"],
  ['Rutina', 'notepad', 171, 7, 'Rutina\nLunes y jueves: caminata 40 min\nMartes: pileta\nSábado: bici si no llueve'],
  ['viaje-bariloche.md', 'file', 220, null, '# Viaje a Bariloche\n\n- Pasajes: ver precios para enero\n- Alojamiento cerca del centro\n- Excursiones: Circuito Chico, Cerro Campanario\n\nPresupuesto estimado a definir.'],
  ['Accesos servidor de pruebas', 'notepad', 12, null, 'Accesos servidor de pruebas (privado)\ncuenta: demo-cuenta\nacceso: secreto-de-muestra\n\n(datos de muestra)'],
  // Las dos .md con formato van al final del cuaderno: no corren de lugar a las demás.
  ['bitacora-del-proyecto.md', 'file', 380, null, longMarkdown],
  ['2026-10-01-plan-del-cuaderno.md', 'file', 400, null, richNote],
];

type MockSheet = SheetDetail;

const NOTES_DIR = 'C:\\Users\\demo\\Documents\\Folio';
/** Alcanza con que cambie cuando cambia el texto. */
const fakeHash = (text: string) => `${text.length}:${[...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7)}`;

let nextId = 1;
const sheets: MockSheet[] = seeds.map(([title, source, age, seeded, content]): MockSheet => {
  const modifiedAt = now - age * HOUR;
  // Como en el backend: la categoría que pide el encabezado, si existe, como puesta a mano.
  const asked = frontMatter(content)?.category;
  const header = asked ? categories.find((c) => fold(c.name) === fold(asked)) : undefined;
  const categoryId = seeded ?? header?.id ?? null;
  const secret = /secreto/i.test(content);
  const versions =
    source === 'notepad' && !secret
      ? [
          { id: nextId * 100 + 1, savedAt: modifiedAt - 3 * HOUR, content: content.split('\n').slice(0, -1).join('\n') },
          { id: nextId * 100 + 2, savedAt: modifiedAt - DAY, content: content.split('\n').slice(0, 2).join('\n') },
        ]
      : [];
  return {
    id: nextId++,
    source,
    title,
    path: source === 'file' ? `C:\\Users\\demo\\Documents\\Notas\\${title}` : null,
    preview: content.slice(0, 900),
    length: content.length,
    size: content.length,
    modifiedAt,
    categoryId,
    categorySource: seeded ? 'jev' : header ? 'manual' : null,
    categoryConfidence: seeded ? 0.86 : null,
    noteScore: 0.95,
    secret,
    secretSource: secret ? 'auto' : null,
    hidden: false,
    missing: false,
    versionCount: versions.length,
    content,
    hash: fakeHash(content),
    versions,
  };
});

const roots: Root[] = [{ id: 1, path: 'C:\\Users\\demo' }];
let bans: Ban[] = [
  { id: 1, kind: 'dir', pattern: 'node_modules', enabled: true, builtin: true },
  { id: 2, kind: 'dir', pattern: 'appdata', enabled: true, builtin: true },
  { id: 3, kind: 'file', pattern: 'README*', enabled: true, builtin: true },
  { id: 4, kind: 'file', pattern: 'LICENSE*', enabled: true, builtin: true },
];
const settings = {
  versionsKeep: 2,
  sessionGapMin: 5,
  ignoreGitRepos: true,
  ignoreDotDirs: true,
  maxFileKb: 1024,
  jevThreshold: 0.6,
  jevEnabled: false,
  jevRecheckDays: 0,
  autostart: true,
  captureKeys: 'Ctrl+Alt+N',
  openKeys: 'Ctrl+Alt+B',
  sendKeys: 'Ctrl+Alt+X',
  sendTo: 'day' as SendTarget,
  sendOrigin: true,
  noteFormat: 'txt' as 'txt' | 'md',
};

/** Enlaces que la interfaz pidió abrir afuera: las pruebas miran acá. */
export const openedLinks: string[] = [];

/** Veces que se pidió iniciar el dictado por voz de Windows. */
export let dictationCalls = 0;

const INTEGRATIONS: Record<IntegrationTool, { name: string; path: string; text: string; ownsFile: boolean }> = {
  claude: { name: 'Claude Code', path: 'C:\\Users\\demo\\.claude\\skills\\folio-notes\\SKILL.md', text: claudeSkill, ownsFile: true },
  codex: { name: 'Codex', path: 'C:\\Users\\demo\\.codex\\AGENTS.md', text: codexBlock, ownsFile: false },
  gemini: { name: 'Gemini CLI', path: 'C:\\Users\\demo\\.gemini\\GEMINI.md', text: geminiBlock, ownsFile: false },
};
/** Qué hay instalado y qué archivos ya existían (el AGENTS.md de Codex, con cosas del usuario). */
const installed = new Set<IntegrationTool>();
const existing = new Set<IntegrationTool>(['codex']);
const integrationOf = (tool: IntegrationTool): Integration => ({
  tool,
  name: INTEGRATIONS[tool].name,
  path: INTEGRATIONS[tool].path,
  exists: existing.has(tool) || installed.has(tool),
  installed: installed.has(tool),
  current: installed.has(tool),
  note: null,
});

// Lo que el backend le deja a la hoja suelta cuando lo seleccionado en otro programa se envía
// con el destino «abrir la hoja suelta». Una prueba puede dejarlo en `sessionStorage`
// ('book.mock.seed') antes de que la hoja abra, o llamar a `simulateSend` con la hoja abierta.
let pendingSeed: CaptureSeed | null = (() => {
  try {
    return JSON.parse(sessionStorage.getItem('book.mock.seed') ?? 'null') as CaptureSeed | null;
  } catch {
    return null;
  }
})();
const seedListeners = new Set<() => void>();

/** Solo para las pruebas: hace de cuenta que se envió ese texto desde otro programa. */
export function simulateSend(seed: CaptureSeed) {
  pendingSeed = seed;
  seedListeners.forEach((fn) => fn());
}

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());
const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 60));

const MOCK_SECRET_KEY = btoa('mock-secret-key-256-bits-base64');
let secretKey: string | null = MOCK_SECRET_KEY;

export function simulateSecretKeyLoss() {
  secretKey = null;
  changed();
}

export function seedMockEnglish() {
  const enCats: [number, string, string][] = [
    [1, 'Work', 'Tasks, meetings, action items, and team updates'],
    [2, 'Projects', 'Roadmaps, architecture, and project milestones'],
    [3, 'Code', 'Code snippets, terminal commands, and scripts'],
    [4, 'Home', 'Household tasks, errands, and family'],
    [5, 'Shopping', 'Groceries, wishlists, and supplies'],
    [6, 'Finance', 'Monthly expenses, budgets, and invoices'],
    [7, 'Health', 'Appointments, workouts, and routines'],
    [8, 'Ideas', 'Quick thoughts and topics to research'],
  ];
  for (const [id, name, description] of enCats) {
    const cat = categories.find((c) => c.id === id);
    if (cat) Object.assign(cat, { name, description });
  }
  const enSheets: [number, string, string][] = [
    [1, 'Course Notes', "Course Notes\n\nUnit 1 — Core Principles\n- Review lecture notes and complete the practice exercises.\n- Write down questions for Thursday's session.\n- Read chapter 3 before the lab."],
    [2, "Today's Tasks", "Today's Tasks\n\n- Review the on-call report before 11:00 AM\n- Reply to Sarah about dashboard access\n- Move sprint action items to Linear\n- Check the release build on Windows 11\n\nIf time permits: clean up the Downloads folder."],
    [3, 'team-sync.md', '# Team Sync\n\nAttendees: Sarah, Alex, Mia, me\n\n## Topics\n- Unified service migration: scheduled for next Tuesday\n- New metrics dashboard review\n- November onboarding workshop\n\n## Action Items\n- [ ] Send meeting notes\n- [ ] Request updated cloud quote\n- [x] Book conference room'],
    [4, 'Grocery List', 'Grocery List\ncoffee beans\nolive oil\ncherry tomatoes\nparmesan cheese\nsourdough bread\navocados'],
    [5, 'git-commands.txt', 'git log --oneline --graph --decorate\ngit stash push -m "wip"\ngit rebase -i HEAD~3\ngit bisect start\n\n# undo last commit keeping changes staged\ngit reset --soft HEAD~1'],
    [6, 'Idea: Visual Notebook', 'Idea: Visual Notebook\n\nA single place where every loose note on the PC lands automatically, sorted by date, with optional local AI categorization.\n\nOpen questions:\n- How to detect sensitive credentials automatically?\n- How many version snapshots to keep per sheet?'],
    [7, 'Dentist Appointment', 'Dentist Appointment\nThursday 15, 9:30 AM\nBring previous X-rays and insurance card.'],
    [8, 'october-budget.txt', 'October Expenses\n\nRent ............ paid\nUtilities ....... pending\nInternet ........ paid\nInsurance ....... due on the 20th\n\nCheck credit card statement.'],
    [9, 'To Research', 'To Research\n\n- Full-text search with SQLite FTS5\n- How Windows 11 Notepad stores unsaved tabs\n- Global shortcuts across desktop platforms'],
    [10, 'home-repairs.md', '# Home Repairs\n\n- Fix leaking bathroom faucet\n- Weatherstrip balcony door\n- Mount desk bookshelf'],
    [11, 'Quick Notes', 'Quick Notes\n\nBooking confirmation code arrived by email.\nConfirm schedule with Paul.\n\nDo not forget laptop charger.'],
    [12, 'november-workshop.md', '# November Workshop\n\nTentative Agenda\n1. Unified dashboard overview\n2. Incident reporting workflow\n3. Documentation best practices'],
    [19, '2026-10-01-notebook-roadmap.md', '---\ntitle: Visual Notebook Roadmap\ncategory: projects\ntags: [book, markdown, design]\nsource: Claude Code\ndate: 2026-10-01\n---\n\n# Notebook Architecture\n\nNotes written in **Markdown** render with clean typography *without losing* the lined paper feel. Double-click anywhere to edit the original file.\n\n## Milestones\n- [x] Headings, lists, and blockquotes\n- [ ] Tables aligned to paper rules\n- [ ] Voice dictation and formatting bar\n\n## How It Works\n1. Open any `.md` or `.txt` sheet\n2. Double-click the line you want to edit\n   - the cursor lands right on that word\n   - and saves straight to disk\n\n```ts\nconst sheet = await api.getSheet(id);\nconsole.log(sheet.title);\n```\n\n| Element | Paper Lines |\n|:--|--:|\n| Large heading | 2 |\n| Paragraph | 1 or more |\n| Divider | 1 |'],
  ];
  for (const [id, title, content] of enSheets) {
    const s = sheets.find((item) => item.id === id);
    if (s) {
      Object.assign(s, {
        title,
        content,
        preview: content.slice(0, 900),
        length: content.length,
        size: content.length,
        path: s.source === 'file' ? `C:\\Users\\demo\\Documents\\Notes\\${title}` : null,
        hash: fakeHash(content),
      });
    }
  }
  changed();
}

if (typeof window !== 'undefined') {
  (window as unknown as { simulateSecretKeyLoss?: typeof simulateSecretKeyLoss }).simulateSecretKeyLoss = simulateSecretKeyLoss;
}

function matches(sheet: MockSheet, filter: ListFilter): boolean {
  const visible = !sheet.secret && !sheet.hidden;
  const inView =
    filter.view === 'secret'
      ? sheet.secret && !sheet.hidden
      : filter.view === 'hidden'
        ? sheet.hidden
        : filter.view === 'uncategorized'
          ? visible && sheet.categoryId === null
          : filter.view === 'category'
            ? visible && sheet.categoryId === filter.categoryId
            : visible;
  if (!inView) return false;
  const query = filter.query?.trim().toLowerCase();
  if (!query) return true;
  if (sheet.secret && secretKey === null) {
    return sheet.title.toLowerCase().includes(query);
  }
  return `${sheet.title}\n${sheet.content}`.toLowerCase().includes(query);
}

const summary = ({ content: _content, versions: _versions, ...rest }: MockSheet) => rest;

// Las IAs de mentira: la elegida, el modelo y la clave de cada una, y la dirección de
// Ollama. Los modelos de fábrica son los del backend (provider.rs).
const PROVIDERS: ProviderId[] = ['jev', 'claude', 'openai', 'gemini', 'ollama'];
const FACTORY_MODEL: Record<ProviderId, string> = {
  jev: '',
  claude: 'claude-haiku-5-5',
  openai: 'gpt-6-luna',
  gemini: 'gemini-3.5-flash-lite',
  ollama: '',
};
const ai = {
  provider: 'jev' as ProviderId,
  models: { ...FACTORY_MODEL },
  keys: { jev: false, claude: false, openai: false, gemini: false, ollama: false } as Record<ProviderId, boolean>,
  ollamaUrl: 'http://localhost:11434',
};
const LABELS: Record<ProviderId, string> = { jev: 'Jev', claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini', ollama: 'Ollama' };
/** Se puede consultar a la IA elegida: tiene clave o, en Ollama, modelo. */
const aiReady = () => (ai.provider === 'ollama' ? ai.models.ollama.trim() !== '' : ai.keys[ai.provider]);

/** Como el backend: con `http://` si falta, sin barra al final; vacía es esta PC. */
function normalizeOllamaUrl(input: string): string {
  const text = input.trim();
  if (!text) return 'http://localhost:11434';
  if (/\s/.test(text)) throw new Error('La dirección no puede tener espacios');
  const url = (text.includes('://') ? text : `http://${text}`).replace(/\/+$/, '').replace(/\/api(\/chat)?$/, '');
  if (!/^https?:\/\/[^/:]/.test(url)) throw new Error('La dirección tiene que empezar con http:// o https://');
  return url;
}

// Jev de mentira, con la misma política que el de verdad: cada hoja se consulta una sola
// vez; las secretas, las de la papelera y las de categoría puesta a mano, nunca.
const jevCalls = { today: 0, total: 0 };
/** Hojas por las que todavía no se consultó (las que ya traen categoría, sí). */
const unasked = new Set(sheets.filter((s) => s.categoryId === null).map((s) => s.id));
const askable = (sheet: MockSheet) => !sheet.secret && !sheet.hidden && sheet.categorySource !== 'manual';
const pendingSheets = () => sheets.filter((s) => askable(s) && unasked.has(s.id));
/** Consulta por lo pendiente: suma una consulta por hoja y las deja como evaluadas. */
function askJev() {
  if (!settings.jevEnabled || !aiReady()) return;
  const asked = pendingSheets();
  asked.forEach((sheet) => unasked.delete(sheet.id));
  jevCalls.today += asked.length;
  jevCalls.total += asked.length;
}
/** Cambiaron las categorías: las hojas evaluadas que quedaron sin categoría vuelven a pasar. */
function reopenUncategorized() {
  sheets.filter((s) => s.categoryId === null && s.categorySource === null).forEach((s) => unasked.add(s.id));
  askJev();
}
const jevStatus = () => ({
  enabled: settings.jevEnabled,
  hasKey: ai.keys[ai.provider],
  keyFromEnv: false,
  ready: aiReady(),
  provider: ai.provider,
  providers: PROVIDERS.map((id): ProviderStatus => ({ id, hasKey: ai.keys[id], keyFromEnv: false, model: ai.models[id] })),
  ollamaUrl: ai.ollamaUrl,
  pending: pendingSheets().length,
  error: null,
  callsToday: jevCalls.today,
  callsTotal: jevCalls.total,
});

export const mockApi: Api = {
  listSheets(filter) {
    const rows = sheets
      .filter((s) => matches(s, filter))
      .filter((s) => filter.until === undefined || s.modifiedAt <= filter.until)
      .filter(
        (s) =>
          filter.beforeTs === undefined ||
          s.modifiedAt < filter.beforeTs ||
          (s.modifiedAt === filter.beforeTs && s.id < (filter.beforeId ?? 0)),
      )
      .sort((a, b) => b.modifiedAt - a.modifiedAt || b.id - a.id);
    const limited = filter.limit !== undefined ? rows.slice(0, Math.max(1, filter.limit)) : rows;
    const summaries = limited
      .map(summary)
      .map((s) => {
        if (s.secret && secretKey === null) {
          return { ...s, preview: '' };
        }
        return s;
      });
    return later(summaries);
  },
  listDays(filter) {
    const counts = new Map<string, number>();
    for (const sheet of sheets.filter((s) => matches(s, filter))) {
      const d = new Date(sheet.modifiedAt);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return later([...counts].map(([day, count]) => ({ day, count })));
  },
  getSheet(id) {
    const sheet = sheets.find((s) => s.id === id);
    if (!sheet) return later(null);
    if (sheet.secret && secretKey === null) {
      return Promise.reject(new Error('Falta la clave de cifrado para leer las hojas secretas.'));
    }
    return later({ ...sheet, hash: fakeHash(sheet.content) });
  },
  getOverview() {
    const visible = sheets.filter((s) => !s.secret && !s.hidden);
    return later({
      counts: {
        all: visible.length,
        uncategorized: visible.filter((s) => s.categoryId === null).length,
        secret: sheets.filter((s) => s.secret && !s.hidden).length,
        hidden: sheets.filter((s) => s.hidden).length,
      },
      categories: categories.map((c) => ({
        ...c,
        count: visible.filter((s) => s.categoryId === c.id).length,
      })),
      scan: { running: false, lastScanAt: now - 90_000, lastScanMs: 4200, lastScanFiles: sheets.length },
      jev: jevStatus(),
      notesDir: NOTES_DIR,
    });
  },
  async setSheetCategory(id, categoryId) {
    const sheet = sheets.find((s) => s.id === id);
    if (sheet) Object.assign(sheet, { categoryId, categorySource: 'manual', categoryConfidence: null });
    changed();
  },
  async setSheetSecret(id, secret) {
    if (!secret && secretKey === null) {
      throw new Error('Falta la clave de cifrado para sacar esta hoja del cuaderno secreto.');
    }
    const sheet = sheets.find((s) => s.id === id);
    if (sheet) Object.assign(sheet, { secret, secretSource: secret ? 'manual' : 'cleared' });
    changed();
  },
  async setSheetHidden(id, hidden) {
    const sheet = sheets.find((s) => s.id === id);
    if (sheet) sheet.hidden = hidden;
    changed();
  },
  async createNote(title, content, categoryId) {
    const raw = title.trim() || titleFromContent(content) || defaultNoteTitle();
    const name = raw.endsWith('.txt') || raw.endsWith('.md') ? raw : `${raw}.txt`;
    const sheet: MockSheet = {
      id: nextId++, source: 'file', title: name, path: `${NOTES_DIR}\\${name}`, preview: content.slice(0, 900),
      length: content.length, size: content.length, modifiedAt: Date.now(), categoryId: categoryId ?? null,
      categorySource: categoryId ? 'manual' : null, categoryConfidence: null, noteScore: null, secret: false,
      secretSource: null, hidden: false, missing: false, versionCount: 0, content, hash: fakeHash(content), versions: [],
    };
    sheets.push(sheet);
    // Recién escrita: queda pendiente hasta que esté quieta (acá, hasta «Clasificar ahora»).
    unasked.add(sheet.id);
    changed();
    return later({ ...sheet });
  },
  async saveSheet(id, content, options = {}) {
    const sheet = sheets.find((s) => s.id === id);
    if (!sheet) throw new Error('La hoja ya no existe');
    if (sheet.source === 'notepad' || sheet.source === 'sticky') throw new Error('Esta hoja no se puede editar desde Folio');
    if (options.baseHash && options.baseHash !== fakeHash(sheet.content) && !options.force) throw new Error('CONFLICT');
    Object.assign(sheet, { content, preview: content.slice(0, 900), length: content.length, size: content.length, modifiedAt: Date.now() });
    if (options.title && sheet.path?.startsWith(NOTES_DIR)) {
      sheet.title = `${options.title}.txt`;
      sheet.path = `${NOTES_DIR}\\${sheet.title}`;
    }
    changed();
    return later({ ...sheet, hash: fakeHash(content) });
  },
  listMissing: () =>
    later([
      { id: 901, title: 'presupuesto-viejo.txt', source: 'file' as const, path: 'C:\\Users\\demo\\Desktop\\presupuesto-viejo.txt', modifiedAt: now - 9 * DAY, missingAt: now - 2 * DAY },
      { id: 902, title: 'Borrador de mail', source: 'notepad' as const, path: null, modifiedAt: now - 3 * DAY, missingAt: now - 3 * DAY + HOUR },
    ]),
  async openSettings() {},
  async openOriginal() {},
  async openLink(url) {
    if (!/^(https?:\/\/|mailto:)/i.test(url)) throw new Error('Ese enlace no se abre desde Folio');
    openedLinks.push(url);
  },
  async createCategory(name, description, color) {
    const id = Math.max(0, ...categories.map((c) => c.id)) + 1;
    categories.push({ id, name, description, color });
    reopenUncategorized();
    changed();
    return id;
  },
  async updateCategory(id, name, description, color) {
    const before = categories.find((c) => c.id === id);
    categories = categories.map((c) => (c.id === id ? { id, name, description, color } : c));
    // El color solo no cambia lo que lee Jev.
    if (before && (before.name !== name || before.description !== description)) reopenUncategorized();
    changed();
  },
  async deleteCategory(id) {
    categories = categories.filter((c) => c.id !== id);
    for (const sheet of sheets.filter((s) => s.categoryId === id)) {
      Object.assign(sheet, { categoryId: null, categorySource: null, categoryConfidence: null });
      unasked.add(sheet.id);
    }
    askJev();
    changed();
  },
  getSettings: () => {
    const lockedCount = sheets.filter((s) => s.secret && !s.hidden).length;
    const secretState = secretKey !== null ? 'ready' : lockedCount > 0 ? 'locked' : 'empty';
    const secretLockedCount = secretKey === null ? lockedCount : 0;
    return later<Settings>({
      roots,
      bans,
      versionsKeep: settings.versionsKeep,
      sessionGapMin: settings.sessionGapMin,
      ignoreGitRepos: settings.ignoreGitRepos,
      ignoreDotDirs: settings.ignoreDotDirs,
      maxFileKb: settings.maxFileKb,
      jevThreshold: settings.jevThreshold,
      jevRecheckDays: settings.jevRecheckDays,
      autostart: settings.autostart,
      captureKeys: settings.captureKeys,
      openKeys: settings.openKeys,
      sendKeys: settings.sendKeys,
      sendTo: settings.sendTo,
      sendOrigin: settings.sendOrigin,
      noteFormat: settings.noteFormat,
      jev: jevStatus(),
      secretState,
      secretLockedCount,
      captureShortcut: settings.captureKeys.split('+').join(' + '),
      openShortcut: settings.openKeys.split('+').join(' + '),
      sendShortcut: settings.sendKeys.split('+').join(' + '),
      version: '1.0.0',
      dataPath: 'C:\\Users\\demo\\AppData\\Roaming\\com.j-playground.folio\\folio.db',
    });
  },
  async updateSettings(patch) {
    Object.assign(settings, patch);
    askJev();
    changed();
  },
  pickFolder: async () => 'C:\\Users\\demo\\Notas',
  async addRoot(path) {
    roots.push({ id: roots.length + 1, path });
  },
  async removeRoot(id) {
    roots.splice(roots.findIndex((r) => r.id === id), 1);
  },
  async addBan(kind, pattern) {
    bans.push({ id: Math.max(0, ...bans.map((b) => b.id)) + 1, kind, pattern, enabled: true, builtin: false });
  },
  async setBanEnabled(id, enabled) {
    bans = bans.map((b) => (b.id === id ? { ...b, enabled } : b));
  },
  async removeBan(id) {
    bans = bans.filter((b) => b.id !== id);
  },
  folderStats: () =>
    later([
      { folder: 'C:\\Users\\demo\\Documents\\Notas', count: 9 },
      { folder: 'C:\\Users\\demo\\Desktop', count: 4 },
      { folder: 'C:\\Users\\demo\\Downloads', count: 2 },
    ]),
  async rescan() {},
  async revealData() {},
  async setJevKey(key) {
    return mockApi.setProviderKey('jev', key);
  },
  async clearJevKey() {
    return mockApi.clearProviderKey('jev');
  },
  async setAiProvider(provider) {
    // Como el backend: elegir otra IA apaga la clasificación automática hasta que se la prenda.
    if (provider !== ai.provider) settings.jevEnabled = false;
    ai.provider = provider;
    askJev();
    changed();
  },
  async setAiModel(provider, model) {
    if (provider === 'jev') throw new Error('Jev tiene un solo modelo: no hay nada que elegir');
    if (/\s/.test(model.trim())) throw new Error('El nombre del modelo no puede tener espacios');
    ai.models[provider] = model.trim() || FACTORY_MODEL[provider];
    askJev();
    changed();
  },
  async setOllamaUrl(url) {
    ai.ollamaUrl = normalizeOllamaUrl(url);
    changed();
  },
  async setProviderKey(provider, key) {
    if (!key.trim()) throw new Error('La clave está vacía');
    if (provider === 'ollama') throw new Error('Ollama no usa clave');
    ai.keys[provider] = true;
    settings.jevEnabled = true;
    askJev();
    changed();
  },
  async clearProviderKey(provider) {
    if (provider === 'ollama') throw new Error('Ollama no usa clave');
    ai.keys[provider] = false;
    // Sin la clave de la IA que se usa no hay a quién consultar.
    if (provider === ai.provider) settings.jevEnabled = false;
    changed();
  },
  async testClassifier() {
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (!aiReady()) {
      throw new Error(ai.provider === 'ollama' ? 'Falta elegir el modelo de Ollama.' : `Falta la clave de ${LABELS[ai.provider]}.`);
    }
    if (ai.provider === 'ollama' && ai.models.ollama.includes('inexistente')) {
      throw new Error(`Ollama respondió HTTP 404. model "${ai.models.ollama}" not found, try pulling it first`);
    }
    // Cuenta como una consulta, igual que las del clasificador.
    jevCalls.today += 1;
    jevCalls.total += 1;
    changed();
    return {
      category: categories.find((c) => c.name === 'Compras')?.name ?? null,
      confidence: 0.91,
      noteScore: 0.96,
      tookMs: 640,
      sample: 'Lista del súper\n\nyerba, café, tomates, queso rallado, papel de cocina y detergente. Pasar por la farmacia.',
    };
  },
  async classifyNow() {
    askJev();
    changed();
  },
  async reclassifyAll() {
    sheets.filter((s) => s.categorySource !== 'manual').forEach((s) => unasked.add(s.id));
    askJev();
    changed();
  },
  suggestCategories: () =>
    later([
      // Como las del backend, nunca repiten el nombre de una categoría que ya existe.
      { name: 'Cliente', keywords: ['cliente', 'presupuesto', 'reunión', 'entrega', 'informe', 'proyecto'], count: 6, samples: ['Reunión con el cliente', 'Pendientes de la semana', 'Agenda reunión'] },
      { name: 'Receta', keywords: ['receta', 'cocinar', 'horno', 'ingredientes', 'harina'], count: 5, samples: ['Tarta de manzana', 'Bizcochuelo', 'Pan casero'] },
      { name: 'Álgebra', keywords: ['álgebra', 'profesor', 'parcial', 'apuntes'], count: 4, samples: ['Apuntes de álgebra', 'Parcial de álgebra'] },
    ]),
  async suggestCategoriesAi() {
    if (ai.provider === 'jev') {
      throw new Error('Elegí Claude, OpenAI, Gemini u Ollama para sugerir categorías con una IA.');
    }
    if (!aiReady()) {
      throw new Error(ai.provider === 'ollama' ? 'Falta elegir el modelo de Ollama.' : `Falta la clave de ${LABELS[ai.provider]}.`);
    }
    jevCalls.today += 1;
    jevCalls.total += 1;
    changed();
    return later([
      { name: 'Clientes y entregas', keywords: ['cliente', 'presupuesto', 'reunión', 'entrega', 'informe', 'facturación'], count: 6, samples: ['Reunión con el cliente', 'Pendientes de la semana', 'Agenda reunión'] },
      { name: 'Cocina y recetas', keywords: ['receta', 'cocinar', 'horno', 'ingredientes', 'harina', 'repostería'], count: 5, samples: ['Tarta de manzana', 'Bizcochuelo', 'Pan casero'] },
      { name: 'Facultad y estudio', keywords: ['álgebra', 'profesor', 'parcial', 'apuntes', 'finales', 'universidad'], count: 4, samples: ['Apuntes de álgebra', 'Parcial de álgebra'] },
    ]);
  },
  integrations: () => later((['claude', 'codex', 'gemini'] as const).map(integrationOf)),
  async installIntegration(tool) {
    installed.add(tool);
  },
  async removeIntegration(tool) {
    installed.delete(tool);
    if (INTEGRATIONS[tool].ownsFile) existing.delete(tool);
  },
  integrationText: (tool) => later(INTEGRATIONS[tool].text.replace(/\r\n/g, '\n').replaceAll('{{CARPETA_DE_NOTAS}}', NOTES_DIR)),
  async exportSecretKey() {
    if (!secretKey) {
      secretKey = MOCK_SECRET_KEY;
    }
    return secretKey;
  },
  async importSecretKey(key: string) {
    const trimmed = key.trim();
    if (!trimmed) throw new Error('La clave no puede estar vacía');
    if (trimmed !== MOCK_SECRET_KEY) {
      throw new Error('Esa clave no abre las hojas secretas de este cuaderno.');
    }
    secretKey = trimmed;
    changed();
  },
  async setGlobalShortcut(which, keys) {
    Object.assign(settings, which === 'capture' ? { captureKeys: keys } : which === 'open' ? { openKeys: keys } : { sendKeys: keys });
    changed();
  },
  async takeCaptureSeed() {
    const seed = pendingSeed;
    pendingSeed = null;
    return seed;
  },
  startDictation: () => {
    dictationCalls += 1;
    return Promise.resolve();
  },
  onCaptureSeed(callback) {
    seedListeners.add(callback);
    return () => seedListeners.delete(callback);
  },
  onQuitRequested: () => () => {},
  onChanged(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
  window: { hide() {}, quit() {}, async fit() {}, async place() {}, async ghost() {}, drag() {}, onClosing: () => () => {} },
};
