// Atajos de teclado de Book: el registro de acciones con sus combinaciones de fábrica, las
// que elige cada persona (se guardan en este equipo y se comparten entre las ventanas),
// cómo se reconoce una combinación en el teclado y cómo se muestra.
//
// Una combinación se escribe así: modificadores en este orden (Ctrl, Alt, Mayús = Shift,
// Super) y una tecla, unidos con «+»: "Ctrl+Shift+Plus", "PageDown", "Ctrl+Enter".
// La tecla es una letra mayúscula, un número, una F1…F24 o un nombre (Enter, Escape, Tab,
// Space, Backspace, Delete, Insert, Home, End, PageUp, PageDown, ArrowLeft…, y Plus, Minus,
// Comma, Period, que no dependen del teclado).
import { useSyncExternalStore } from 'react';
import { mark, t } from './i18n';
import type { GlobalShortcut } from './types';

const isMac = /Mac/i.test(navigator.userAgent);

// ---- el registro -----------------------------------------------------------------

/**
 * Cuándo vale una acción: con el cuaderno cerrado, leyendo, escribiendo, en la hoja suelta
 * o desde cualquier programa. Dos acciones solo chocan si pueden estar activas a la vez.
 */
export type Scope = 'closed' | 'reading' | 'writing' | 'capture' | 'global';

export type ShortcutGroup = 'Cuaderno' | 'Escribiendo' | 'Ventana y tamaño' | 'Hoja suelta';

export type ShortcutId =
  | 'next'
  | 'prev'
  | 'sheet-next'
  | 'sheet-prev'
  | 'first'
  | 'last'
  | 'write'
  | 'tear-off'
  | 'new'
  | 'search'
  | 'back'
  | 'flip'
  | 'finish'
  | 'save'
  | 'preview'
  | 'write-next'
  | 'write-prev'
  | 'indent'
  | 'settings'
  | 'spread'
  | 'size-pocket'
  | 'size-standard'
  | 'size-full'
  | 'bigger'
  | 'smaller'
  | 'text-bigger'
  | 'text-smaller'
  | 'hide-window'
  | 'capture-save';

export interface ShortcutAction {
  id: ShortcutId;
  /** Cómo se llama en Ajustes. */
  label: string;
  group: ShortcutGroup;
  /** Aclaración corta debajo del nombre. */
  detail?: string;
  /** Combinaciones de fábrica; la primera es la que muestran los menús. */
  defaults: readonly string[];
  scopes: readonly Scope[];
  /**
   * Puede ser una tecla suelta (una letra, una flecha…): solo para lo que vale cuando no
   * se está escribiendo. Donde se escribe, una tecla suelta escribiría en vez de actuar.
   */
  bare?: boolean;
}

/** Todo lo que vale en la ventana del cuaderno, esté como esté. */
const NOTEBOOK: readonly Scope[] = ['closed', 'reading', 'writing'];

export const ACTIONS: readonly ShortcutAction[] = [
  // El cuaderno
  { id: 'next', label: mark('Página siguiente'), group: 'Cuaderno', defaults: ['ArrowRight', 'PageDown'], scopes: ['closed', 'reading'], bare: true },
  { id: 'prev', label: mark('Página anterior'), group: 'Cuaderno', defaults: ['ArrowLeft', 'PageUp'], scopes: ['closed', 'reading'], bare: true },
  { id: 'sheet-next', label: mark('Hoja siguiente'), group: 'Cuaderno', defaults: ['Alt+ArrowRight', 'Ctrl+PageDown'], scopes: ['closed', 'reading'], bare: true },
  { id: 'sheet-prev', label: mark('Hoja anterior'), group: 'Cuaderno', defaults: ['Alt+ArrowLeft', 'Ctrl+PageUp'], scopes: ['closed', 'reading'], bare: true },
  { id: 'first', label: mark('Primera hoja'), group: 'Cuaderno', defaults: ['Home'], scopes: ['closed', 'reading'], bare: true },
  { id: 'last', label: mark('Última hoja'), group: 'Cuaderno', defaults: ['End'], scopes: ['closed', 'reading'], bare: true },
  { id: 'write', label: mark('Escribir en la hoja'), group: 'Cuaderno', defaults: ['Enter', 'F2'], scopes: ['reading'], bare: true },
  {
    id: 'tear-off',
    label: mark('Arrancar hoja'),
    group: 'Cuaderno',
    detail: mark('Abre la hoja actual en una ventana flotante independiente.'),
    defaults: ['Ctrl+T'],
    scopes: ['reading', 'writing'],
  },
  { id: 'new', label: mark('Hoja nueva'), group: 'Cuaderno', defaults: ['Ctrl+N'], scopes: NOTEBOOK },
  { id: 'search', label: mark('Buscar y filtrar'), group: 'Cuaderno', defaults: ['Ctrl+F'], scopes: NOTEBOOK },
  {
    id: 'back',
    label: mark('Volver de la papelera o del secret-book'),
    group: 'Cuaderno',
    defaults: ['Escape'],
    scopes: ['reading'],
    bare: true,
  },
  {
    id: 'flip',
    label: mark('Dar vuelta el cuaderno'),
    group: 'Cuaderno',
    detail: mark('Solo con el cuaderno cerrado.'),
    defaults: ['V'],
    scopes: ['closed'],
    bare: true,
  },

  // Escribiendo
  { id: 'finish', label: mark('Guardar y terminar de escribir'), group: 'Escribiendo', defaults: ['Ctrl+Enter', 'Escape'], scopes: ['writing'] },
  { id: 'save', label: mark('Guardar y seguir escribiendo'), group: 'Escribiendo', defaults: ['Ctrl+S'], scopes: ['writing'] },
  {
    id: 'preview',
    label: mark('Previsualizar Markdown'),
    group: 'Escribiendo',
    detail: mark('Alterna entre el editor y la vista con formato de la nota.'),
    defaults: ['Ctrl+P'],
    scopes: ['writing'],
  },
  {
    id: 'write-next',
    label: mark('Página siguiente de la nota'),
    group: 'Escribiendo',
    detail: mark('Pasa de página sin salir de la nota; las flechas mueven el cursor.'),
    defaults: ['PageDown'],
    scopes: ['writing'],
  },
  { id: 'write-prev', label: mark('Página anterior de la nota'), group: 'Escribiendo', defaults: ['PageUp'], scopes: ['writing'] },
  { id: 'indent', label: mark('Escribir una tabulación'), group: 'Escribiendo', defaults: ['Tab', 'Shift+Tab'], scopes: ['writing'] },

  // La ventana y el tamaño
  { id: 'settings', label: mark('Ajustes'), group: 'Ventana y tamaño', defaults: ['Ctrl+Comma'], scopes: NOTEBOOK },
  { id: 'spread', label: mark('Una o dos hojas'), group: 'Ventana y tamaño', defaults: ['Ctrl+D'], scopes: NOTEBOOK },
  { id: 'size-pocket', label: mark('Cuaderno de bolsillo'), group: 'Ventana y tamaño', defaults: ['Ctrl+1'], scopes: NOTEBOOK },
  { id: 'size-standard', label: mark('Cuaderno estándar'), group: 'Ventana y tamaño', defaults: ['Ctrl+2'], scopes: NOTEBOOK },
  { id: 'size-full', label: mark('Cuaderno a pantalla completa'), group: 'Ventana y tamaño', defaults: ['Ctrl+3'], scopes: NOTEBOOK },
  { id: 'bigger', label: mark('Agrandar el cuaderno un poco'), group: 'Ventana y tamaño', defaults: ['Ctrl+Plus'], scopes: NOTEBOOK },
  { id: 'smaller', label: mark('Achicar el cuaderno un poco'), group: 'Ventana y tamaño', defaults: ['Ctrl+Minus'], scopes: NOTEBOOK },
  {
    id: 'text-bigger',
    label: mark('Letra más grande'),
    group: 'Ventana y tamaño',
    // Con un teclado en inglés, Ctrl + Mayús + «+» es lo mismo que Ctrl + «+»: la segunda queda para ese caso.
    defaults: ['Ctrl+Shift+Plus', 'Ctrl+Shift+Period'],
    scopes: NOTEBOOK,
  },
  { id: 'text-smaller', label: mark('Letra más chica'), group: 'Ventana y tamaño', defaults: ['Ctrl+Shift+Minus', 'Ctrl+Shift+Comma'], scopes: NOTEBOOK },
  {
    id: 'hide-window',
    label: mark('Cerrar la ventana'),
    group: 'Ventana y tamaño',
    detail: mark('Folio sigue en la bandeja, junto al reloj.'),
    defaults: ['Ctrl+W'],
    scopes: NOTEBOOK,
  },

  // La hoja suelta
  {
    id: 'capture-save',
    label: mark('Guardar y cerrar la hoja suelta'),
    group: 'Hoja suelta',
    defaults: ['Ctrl+Enter', 'Ctrl+S', 'Escape'],
    scopes: ['capture'],
  },
];

const BY_ID = new Map<ShortcutId, ShortcutAction>(ACTIONS.map((action) => [action.id, action]));

export const GROUPS: readonly ShortcutGroup[] = [
  mark('Cuaderno'),
  mark('Escribiendo'),
  mark('Ventana y tamaño'),
  mark('Hoja suelta'),
];

/** Acciones de la ventana del cuaderno que atiende `App`, esté el cuaderno como esté. */
export const WINDOW_ACTIONS = [
  'search',
  'new',
  'settings',
  'size-pocket',
  'size-standard',
  'size-full',
  'bigger',
  'smaller',
  'text-bigger',
  'text-smaller',
  'spread',
  'hide-window',
] as const satisfies readonly ShortcutId[];

/** Atajos que valen desde cualquier programa: los registra el sistema, no esta ventana. */
export interface GlobalAction {
  which: GlobalShortcut;
  label: string;
  detail?: string;
  /** Combinación de fábrica, en el formato de Ajustes («Ctrl+Alt+N»). */
  default: string;
}

export const GLOBAL_ACTIONS: readonly GlobalAction[] = [
  { which: 'open', label: mark('Abrir el cuaderno'), default: 'Ctrl+Alt+B' },
  { which: 'capture', label: mark('Nueva hoja suelta'), default: 'Ctrl+Alt+N' },
  // Ctrl + Alt es AltGr en los teclados en español; la X no escribe nada con AltGr ni en el de
  // España ni en el de Latinoamérica (la E da «€» y la Q «@»), y no pisa lo de Word y Excel.
  {
    which: 'send',
    label: mark('Enviar lo seleccionado a Folio'),
    detail: mark('Selecciona un texto en cualquier programa, aprietalo y Folio lo guarda con su origen.'),
    default: 'Ctrl+Alt+X',
  },
];

export const actionOf = (id: ShortcutId): ShortcutAction => BY_ID.get(id)!;

// ---- combinaciones: leerlas, armarlas y mostrarlas ------------------------------------

export interface Parsed {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** La tecla de Windows (Super); solo en los atajos globales. */
  meta: boolean;
  key: string;
}

const NAMED_KEYS = new Set([
  'Enter',
  'Escape',
  'Tab',
  'Space',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Plus',
  'Minus',
  'Comma',
  'Period',
]);
const FKEY = /^F([1-9]|1\d|2[0-4])$/;

export function parse(combo: string): Parsed | null {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  const mods = new Set(parts);
  if (mods.size !== parts.length || [...mods].some((mod) => !['Ctrl', 'Alt', 'Shift', 'Super'].includes(mod))) return null;
  // Una letra o un símbolo suelto (nunca «+», que es el separador); el resto, por su nombre.
  const valid = NAMED_KEYS.has(key) || FKEY.test(key) || (key.length === 1 && key !== ' ' && key === key.toUpperCase());
  if (!valid) return null;
  return { ctrl: mods.has('Ctrl'), alt: mods.has('Alt'), shift: mods.has('Shift'), meta: mods.has('Super'), key };
}

function build(parsed: Parsed): string {
  return [parsed.ctrl && 'Ctrl', parsed.alt && 'Alt', parsed.shift && 'Shift', parsed.meta && 'Super', parsed.key].filter(Boolean).join('+');
}

/** La misma combinación escrita de una única manera, o `null` si no es una combinación. */
export function normalize(combo: string): string | null {
  const parsed = typeof combo === 'string' ? parse(combo) : null;
  return parsed ? build(parsed) : null;
}

const KEY_LABEL: Record<string, string> = {
  Escape: 'Esc',
  Space: 'Espacio',
  Backspace: 'Retroceso',
  Delete: 'Supr',
  Insert: 'Ins',
  Home: 'Inicio',
  End: 'Fin',
  PageUp: 'Re Pág',
  PageDown: 'Av Pág',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Plus: '+',
  Minus: '−',
  Comma: ',',
  Period: '.',
};
const MOD_LABEL = { Ctrl: isMac ? '⌘' : 'Ctrl', Alt: isMac ? '⌥' : 'Alt', Shift: 'Mayús', Super: isMac ? '⌘' : 'Win' };

/** Cómo se muestra una combinación: «Ctrl + Enter», «Av Pág», «←», «Ctrl + Mayús + +». */
export function format(combo: string): string {
  const parsed = parse(combo);
  if (!parsed) return combo;
  const label = parsed.key.length === 1 ? parsed.key : (KEY_LABEL[parsed.key] ?? parsed.key);
  return [parsed.ctrl && MOD_LABEL.Ctrl, parsed.alt && MOD_LABEL.Alt, parsed.shift && MOD_LABEL.Shift, parsed.meta && MOD_LABEL.Super, label]
    .filter(Boolean)
    .join(' + ');
}

// ---- leer una combinación del teclado -------------------------------------------------

/** Lo que se necesita de un evento de teclado (el de React se pasa con `nativeEvent`). */
export type KeyInput = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'> &
  Partial<Pick<KeyboardEvent, 'isComposing' | 'getModifierState'>>;

/** Qué se leyó al apretar una tecla: todavía nada (solo un modificador), una combinación, o algo que no sirve. */
export type Capture = { kind: 'wait' } | { kind: 'combo'; combo: string } | { kind: 'invalid'; reason: string };

const ONLY_MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'Hyper', 'Super', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock']);

/**
 * El nombre de la tecla. En la app se mira lo que la tecla escribe (así «+», «−» y «,» valen
 * en un teclado en español y en uno en inglés, aunque estén en lugares distintos); en los
 * atajos globales, la tecla física, porque el sistema los registra por ella.
 */
function keyName(event: KeyInput, physical: boolean): string | null {
  const { key, code } = event;
  if (key === ' ' || code === 'Space') return 'Space';
  if (NAMED_KEYS.has(key) && key.length > 1) return key;
  if (FKEY.test(key)) return key;
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  const digit = /^Digit(\d)$/.exec(code)?.[1];
  if (physical) return letter ?? digit ?? (/^Numpad(\d)$/.exec(code)?.[1] ?? null);
  // El «+» de un teclado en español es otra tecla física que en uno en inglés; con Mayús
  // da «*». «=» solo cuenta si es la tecla del «=» de un teclado en inglés: en español es
  // Mayús + 0 y no tiene que pasar por «+».
  if (key === '+' || code === 'NumpadAdd' || (key === '=' && code === 'Equal') || (key === '*' && event.shiftKey && code === 'BracketRight')) return 'Plus';
  if (key === '-' || key === '_' || code === 'NumpadSubtract') return 'Minus';
  if (key === ',' || code === 'Comma') return 'Comma';
  if (key === '.' || code === 'Period') return 'Period';
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  // Letras de otros alfabetos, o con Alt en el Mac (que escribe símbolos): por la tecla física.
  if (letter) return letter;
  if (digit) return digit;
  if (/^\d$/.test(key)) return key;
  return key.length === 1 ? key.toUpperCase() : null;
}

/**
 * Lee la combinación de un evento de teclado. `app` es para los atajos de las ventanas de
 * Book: Ctrl y ⌘ valen lo mismo, y Ctrl + Alt no vale, porque en muchos teclados es AltGr
 * (el que escribe @, #, \ y otros). `global` es para los que registra el sistema: la tecla
 * física, y Ctrl, Alt, Mayús y Windows por separado.
 */
export function readCapture(event: KeyInput, mode: 'app' | 'global' = 'app'): Capture {
  if (event.isComposing || event.key === 'Process') return { kind: 'wait' };
  if (ONLY_MODIFIERS.has(event.key) || event.key === 'Dead' || event.key === 'Unidentified') return { kind: 'wait' };
  const global = mode === 'global';
  const altGr = !global && ((event.ctrlKey && event.altKey) || event.getModifierState?.('AltGraph') === true);
  if (altGr) return { kind: 'invalid', reason: 'Ctrl + Alt es AltGr en muchos teclados y escribe letras y símbolos: usá otra combinación.' };
  const key = keyName(event, global);
  if (!key) return { kind: 'invalid', reason: 'Esa tecla no se puede usar en un atajo.' };
  // En un teclado en inglés, el «+» ya es Mayús + «=»: esa Mayús no es un modificador más.
  const shiftSpent = !global && event.key === '+' && event.code === 'Equal';
  return {
    kind: 'combo',
    combo: build({
      ctrl: event.ctrlKey || (!global && event.metaKey),
      alt: event.altKey,
      shift: event.shiftKey && !shiftSpent,
      meta: global && event.metaKey,
      key,
    }),
  };
}

/** La combinación de un evento de teclado, o `null` si no es una (solo un modificador, AltGr…). */
export function comboOf(event: KeyInput): string | null {
  const read = readCapture(event);
  return read.kind === 'combo' ? read.combo : null;
}

// ---- las combinaciones elegidas ------------------------------------------------------

const STORAGE_KEY = 'book.shortcuts';
/** Cuántas combinaciones puede tener una acción. */
export const MAX_COMBOS = 4;

type Overrides = Partial<Record<ShortcutId, string[]>>;

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
const overlap = (a: readonly Scope[], b: readonly Scope[]) => a.some((scope) => b.includes(scope));

/** Combinaciones que no se pueden usar para nada: son del texto (copiar, pegar, deshacer…) o de Windows. */
const RESERVED: Record<string, string> = {
  'Ctrl+C': 'copia',
  'Ctrl+V': 'pega',
  'Ctrl+X': 'corta',
  'Ctrl+Z': 'deshace',
  'Ctrl+Y': 'rehace',
  'Ctrl+A': 'selecciona todo',
  'Alt+F4': 'cierra la ventana en Windows',
};

/** Teclas que no escriben nada: solas pueden ser un atajo. */
const SILENT_KEYS = (key: string) => key === 'Escape' || FKEY.test(key) || key === 'PageUp' || key === 'PageDown';

/** Por qué una combinación no sirve para esa acción, o `null` si sirve. No mira los choques con otras acciones. */
export function problemWith(id: ShortcutId, combo: string): string | null {
  const action = actionOf(id);
  const parsed = parse(combo);
  if (!parsed || parsed.meta) return 'Esa combinación no es válida.';
  if (action.defaults.includes(combo)) return null;
  if (parsed.ctrl && parsed.alt) return 'Ctrl + Alt es AltGr en muchos teclados y escribe letras y símbolos: usá otra combinación.';
  const reserved = RESERVED[combo];
  if (reserved) return `${format(combo)} ${reserved}: la usa el texto.`;
  if (parsed.key === 'Escape' && !parsed.ctrl && !parsed.alt && !parsed.shift) return 'Esc está para cerrar menús y diálogos: usá otra tecla.';
  const modified = parsed.ctrl || parsed.alt;
  if (!modified && !SILENT_KEYS(parsed.key)) {
    // Sin escribir, una tecla suelta sirve; menos el espacio y el tabulador, que son de los botones.
    if (!action.bare) return 'Sola, esa tecla escribiría en la hoja: sumale Ctrl o Alt.';
    if (parsed.key === 'Space' || parsed.key === 'Tab') return 'Esa tecla es de los botones y los campos: sumale Ctrl o Alt.';
  }
  return null;
}

/** Por qué una combinación no sirve de atajo global, o `null` si sirve. */
export function problemWithGlobal(combo: string): string | null {
  const parsed = parse(combo);
  const allowed = parsed && (/^[A-Z0-9]$/.test(parsed.key) || FKEY.test(parsed.key) || /^(Space|Enter|Insert|Delete|Home|End|PageUp|PageDown|Arrow(Left|Right|Up|Down))$/.test(parsed.key));
  if (!parsed || !allowed) return 'Para un atajo desde cualquier programa usá una letra, un número, una F o una flecha.';
  // Un atajo global le gana a lo que hagan los demás programas con esa combinación: tiene que ser una rara.
  if (!(parsed.alt || parsed.meta || (parsed.ctrl && parsed.shift))) {
    return 'Para que no pise a otros programas, sumale Alt, la tecla de Windows, o Ctrl y Mayús juntas.';
  }
  return null;
}

function load(): Overrides {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const saved = raw as Record<string, unknown>;
  const out: Overrides = {};
  for (const action of ACTIONS) {
    const list = saved[action.id];
    if (!Array.isArray(list)) continue;
    const combos = [
      ...new Set(
        list
          .slice(0, MAX_COMBOS * 2)
          .map((combo) => (typeof combo === 'string' ? normalize(combo) : null))
          .filter((combo): combo is string => combo !== null && problemWith(action.id, combo) === null),
      ),
    ].slice(0, MAX_COMBOS);
    // Una lista donde no sirvió ninguna es un dato roto, no un «sin atajo»: se queda la de fábrica.
    if (list.length > 0 && combos.length === 0) continue;
    if (!sameList(combos, action.defaults)) out[action.id] = combos;
  }
  // Dos acciones que pueden estar activas a la vez no comparten una combinación: si en lo
  // guardado pasa (un archivo tocado a mano), la que viene después en el registro la pierde.
  const taken: { scopes: readonly Scope[]; combos: readonly string[] }[] = [];
  for (const action of ACTIONS) {
    const mine = out[action.id];
    if (mine) {
      const free = mine.filter((combo) => !taken.some((other) => overlap(other.scopes, action.scopes) && other.combos.includes(combo)));
      if (free.length !== mine.length) out[action.id] = free;
    }
    taken.push({ scopes: action.scopes, combos: out[action.id] ?? action.defaults });
  }
  return out;
}

let overrides: Overrides = load();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function commit(next: Overrides) {
  overrides = next;
  try {
    if (Object.keys(next).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // sin almacenamiento disponible, lo elegido dura lo que dure la ventana
  }
  notify();
}

// Lo que se cambia en una ventana (Ajustes) se refleja al instante en las demás.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    overrides = load();
    notify();
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Las combinaciones vigentes de una acción: las elegidas o, si no se tocó, las de fábrica. */
export const combosOf = (id: ShortcutId): readonly string[] => overrides[id] ?? actionOf(id).defaults;

/** ¿Esta acción tiene combinaciones distintas a las de fábrica? */
export const isCustom = (id: ShortcutId) => overrides[id] !== undefined;

/** ¿Hay alguna acción con combinaciones elegidas? */
export const anyCustom = () => Object.keys(overrides).length > 0;

/** Deja esas combinaciones a la acción (puede ser ninguna). No mira los choques: eso lo decide quien llama. */
export function setCombos(id: ShortcutId, combos: readonly string[]) {
  const clean = [...new Set(combos.map(normalize).filter((combo): combo is string => combo !== null))].slice(0, MAX_COMBOS);
  const next = { ...overrides };
  if (sameList(clean, actionOf(id).defaults)) delete next[id];
  else next[id] = clean;
  commit(next);
}

/** Vuelve una acción a sus combinaciones de fábrica. */
export function reset(id: ShortcutId) {
  if (!(id in overrides)) return;
  const next = { ...overrides };
  delete next[id];
  commit(next);
}

/** Vuelve todas las acciones a sus combinaciones de fábrica. */
export function resetAll() {
  if (anyCustom()) commit({});
}

/**
 * Hace que la interfaz se redibuje cuando cambian las combinaciones (en esta ventana o en
 * otra). Devuelve lo elegido, solo para eso: se consulta con `combosOf`, `hintOf` y demás.
 */
export function useShortcuts(): Readonly<Partial<Record<ShortcutId, readonly string[]>>> {
  return useSyncExternalStore(subscribe, () => overrides);
}

// ---- reconocer y mostrar --------------------------------------------------------------

/**
 * Cuál de esas acciones es la que se apretó, o `null` si ninguna. Con Ctrl + Alt (AltGr)
 * nunca hay acción. Que el foco esté en un campo, o que haya un diálogo abierto, lo
 * decide cada manejador: acá solo se reconoce la combinación.
 */
export function which<T extends ShortcutId>(event: KeyInput, ids: readonly T[]): T | null {
  const combo = comboOf(event);
  if (!combo) return null;
  return ids.find((id) => combosOf(id).includes(combo)) ?? null;
}

export const matches = (event: KeyInput, id: ShortcutId) => which(event, [id]) !== null;

/**
 * Esa tecla, sin Ctrl ni Alt, es del control donde está el foco y no de la hoja: un campo
 * donde se escribe, o un botón o un menú, que Enter y Espacio activan. Las F no (valen siempre).
 */
export function belongsToTarget(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || FKEY.test(event.key)) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input, textarea, select, [contenteditable]')) return true;
  return (event.key === 'Enter' || event.key === ' ') && !!target?.closest('button, a, [role="menu"]');
}

/** La primera combinación de una acción, para los menús («Ctrl + D»); vacío si no tiene ninguna. */
export const hintOf = (id: ShortcutId): string => {
  const first = combosOf(id)[0];
  return first ? format(first) : '';
};

/** Todas las combinaciones de una acción, para un texto: «Ctrl + Enter, Ctrl + S o Esc». */
export const describe = (id: ShortcutId): string => {
  const keys = combosOf(id).map(format);
  return keys.length > 1 ? `${keys.slice(0, -1).join(', ')} ${t('o')} ${keys[keys.length - 1]}` : (keys[0] ?? '');
};

// ---- choques ---------------------------------------------------------------------

/** Quién ya usa una combinación. */
export type Owner = { kind: 'app'; id: ShortcutId; label: string } | { kind: 'global'; which: GlobalShortcut; label: string };

/** Las combinaciones elegidas para los atajos globales (`settings.captureKeys` y `settings.openKeys`). */
export type GlobalKeys = Record<GlobalShortcut, string>;

/**
 * Quién usa ya esa combinación y chocaría con `subject`: otra acción que pueda estar activa
 * a la vez o un atajo global (el sistema se lo queda antes que cualquier ventana).
 */
export function ownerOf(combo: string, subject: { id: ShortcutId } | { which: GlobalShortcut }, globals?: GlobalKeys): Owner | null {
  const mine = 'id' in subject ? actionOf(subject.id) : null;
  for (const action of ACTIONS) {
    if (mine && action.id === mine.id) continue;
    // Un atajo global le gana a todo; uno de la app solo choca con lo que puede estar activo a la vez.
    if (mine && !overlap(action.scopes, mine.scopes)) continue;
    if (combosOf(action.id).includes(combo)) return { kind: 'app', id: action.id, label: action.label };
  }
  if (globals) {
    for (const global of GLOBAL_ACTIONS) {
      if (!('id' in subject) && global.which === subject.which) continue;
      if (globals[global.which] === combo) return { kind: 'global', which: global.which, label: global.label };
    }
  }
  return null;
}
