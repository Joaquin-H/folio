import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Bot,
  Check,
  CheckCircle2,
  Cpu,
  LoaderCircle,
  MousePointerClick,
  Scissors,
  Settings2,
  Shield,
  Sparkles,
} from 'lucide-react';
import { api } from '../api';
import { usePresence } from '../hooks';
import { useT } from '../i18n';
import { combosOf, format, GLOBAL_ACTIONS, hintOf, useShortcuts, type ShortcutId } from '../shortcuts';
import type { CategorySuggestion, ProviderId } from '../types';
import { suggestColor, SuggestedCategoryList } from './settings/SuggestionList';
import '../styles/suggest.css';
import '../styles/tutorial.css';

/**
 * El recorrido de la primera vez: globos chicos, uno por paso, junto al elemento real del
 * cuaderno que explican. Lo demás se atenúa y no responde; solo el elemento resaltado deja
 * pasar los clics, y únicamente en los pasos donde se pide probar algo. No toca el cuaderno:
 * mira el documento (con `data-tour` donde hacía falta) y se hace a un lado cuando algo más
 * pide la atención (se escribe, se abre un menú, Ajustes…).
 */

const SEEN_KEY = 'book.tutorial';
const WELCOME_KEY = 'book.welcome';
/** Otra ventana (Ajustes) le pide a esta que muestre el recorrido escribiendo acá la hora. */
const REPLAY_KEY = 'book.tutorial.replay';
/** Versión del recorrido: si cambia tanto que vale volver a mostrarlo, se sube y lo ven todos de nuevo. */
export const TOUR_VERSION = 2;
export const WELCOME_VERSION = 2;

/** Cuánto espera el cuaderno a asentarse (animación de entrada, tamaño de la ventana) antes del primer globo. */
const FIRST_DELAY = 900;
/** Al empezar un paso, cuánto se espera antes de anotar cómo estaba todo para notar qué cambió. */
const ARM_DELAY = 350;
const BALLOON_WIDTH = 300;
/** Aire entre el globo y el borde de la ventana, entre el globo y lo resaltado, y alrededor de lo resaltado. */
const MARGIN = 10;
const GAP = 12;
/** Cuánto se aleja el globo, de a pasos, cuando pegado a lo resaltado taparía un botón. */
const AWAY = 28;
const PAD = 7;

// ---- lo ya visto -------------------------------------------------------------------

let seenHere = false;
let welcomeSeenHere = false;

/**
 * ¿Ya se mostró este recorrido? Si el almacenamiento no responde no se sabe, y entonces no
 * se insiste: el recorrido no vuelve a salir en cada arranque. Un dato roto sí lo muestra,
 * una vez, y lo deja bien escrito.
 */
export function tourSeen(): boolean {
  if (seenHere) return true;
  let raw: string | null;
  try {
    raw = localStorage.getItem(SEEN_KEY);
  } catch {
    return true;
  }
  if (raw === null) return false;
  try {
    const saved = JSON.parse(raw) as { version?: unknown } | null;
    return typeof saved?.version === 'number' && saved.version >= TOUR_VERSION;
  } catch {
    return false;
  }
}

export function welcomeSeen(): boolean {
  if (welcomeSeenHere) return true;
  let raw: string | null;
  try {
    raw = localStorage.getItem(WELCOME_KEY);
  } catch {
    return true;
  }
  if (raw === null) return false;
  try {
    const saved = JSON.parse(raw) as { version?: unknown } | null;
    return typeof saved?.version === 'number' && saved.version >= WELCOME_VERSION;
  } catch {
    return false;
  }
}

function markSeen() {
  seenHere = true;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ version: TOUR_VERSION, at: Date.now() }));
  } catch {
    // sin almacenamiento, no se vuelve a mostrar hasta que se cierre la ventana
  }
}

export function markWelcomeSeen() {
  welcomeSeenHere = true;
  try {
    localStorage.setItem(WELCOME_KEY, JSON.stringify({ version: WELCOME_VERSION, at: Date.now() }));
  } catch {
    // sin almacenamiento
  }
}

/** Desde la ventana de Ajustes: pide a la del cuaderno que muestre el recorrido (se avisan por el almacenamiento, como las preferencias). */
export function requestTour() {
  try {
    localStorage.setItem(REPLAY_KEY, String(Date.now()));
  } catch {
    // sin almacenamiento no hay cómo avisarle
  }
}

// ---- mirar el cuaderno ---------------------------------------------------------------

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const find = (selector: string) => document.querySelector<HTMLElement>(selector);
const visible = (node: Element | null): node is Element => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
const half = (value: number) => Math.round(value * 2) / 2;
const boxOf = (node: Element): Rect => {
  const r = node.getBoundingClientRect();
  return { left: half(r.left), top: half(r.top), right: half(r.right), bottom: half(r.bottom) };
};
const rectOf = (selector: string): Rect | null => {
  const node = find(selector);
  return visible(node) ? boxOf(node) : null;
};
const merge = (rects: (Rect | null)[]): Rect | null => {
  const some = rects.filter((rect): rect is Rect => rect !== null);
  return some.length === 0
    ? null
    : {
        left: Math.min(...some.map((r) => r.left)),
        top: Math.min(...some.map((r) => r.top)),
        right: Math.max(...some.map((r) => r.right)),
        bottom: Math.max(...some.map((r) => r.bottom)),
      };
};
const grow = (rect: Rect, by: number): Rect => ({ left: rect.left - by, top: rect.top - by, right: rect.right + by, bottom: rect.bottom + by });
const within = (inner: Rect, outer: Rect) => inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
const overlap = (a: Rect, b: Rect) => {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
};

/** Cómo está el cuaderno ahora, mirado en el documento. */
interface Scene {
  /** Se ve la tapa (o la contratapa). */
  closed: boolean;
  back: boolean;
  /** Abierto pero sin hojas que mostrar: el primer escaneo, o un filtro que no trae nada. */
  bare: boolean;
  /** La hoja a la vista no se puede escribir desde Book (el Bloc de notas, Sticky Notes, la papelera). */
  locked: boolean;
  writing: boolean;
  menu: boolean;
}

const readScene = (): Scene => ({
  closed: !!find('.book.closed'),
  back: !!find('.cover.back'),
  bare: !!find('.page-empty'),
  locked: /Bloc de notas|Notepad|Sticky Notes/.test(find('.page-head .page-source')?.textContent ?? '') || !!find('.page.trash'),
  writing: !!find('.page-text.editing'),
  menu: !!find('.menu-list:not(.leaving)'),
});

/** Qué hoja y qué página se ven: cambia al pasar de página, no cuando se recalcula cuántas hay. */
function spot(): string {
  const sheet = /^(?:Hoja|Sheet) ([\d.,]+)/.exec(find('.page-foot-main')?.textContent ?? '')?.[1] ?? '';
  const page = /^(\d+) (?:de|of)/.exec(find('.page-foot > span:last-child')?.textContent ?? '')?.[1] ?? '1';
  return `${sheet}|${page}`;
}

const searchButton = () => rectOf('[data-tour="search"]') ?? rectOf('[data-tour="actions"] > button:nth-child(2)');
const newButton = () => rectOf('[data-tour="new"]') ?? rectOf('[data-tour="actions"] > button:nth-child(1)');
/** Lo que hay en una hoja en blanco: el ícono y lo que dice. */
const emptyNotice = () => merge([...document.querySelectorAll('.page-empty > *')].filter(visible).map(boxOf));

/** Las primeras líneas del texto de la hoja, sin las franjas de los bordes: ahí el doble clic escribe. */
function firstLines(): Rect | null {
  const clip = find('.flow-clip:not(.parked)');
  const flow = find('.flow-clip:not(.parked) .flow');
  const spacer = find('.flow-clip:not(.parked) .flow-spacer');
  if (!visible(clip) || !flow) return null;
  const line = parseFloat(getComputedStyle(flow).getPropertyValue('--line')) || 28;
  const area = boxOf(clip);
  const colWidth = flow.clientWidth || (area.right - area.left);
  const spacerBox = spacer && visible(spacer) ? boxOf(spacer) : null;
  const top =
    spacerBox && spacerBox.right > area.left + 4 && spacerBox.left < area.left + colWidth
      ? Math.max(area.top, spacerBox.bottom)
      : area.top;
  const edge = find('[data-tour="turn-next"]');
  const rightEdge = Math.min(area.left + colWidth, edge && visible(edge) ? boxOf(edge).left - 2 : area.right);
  return {
    left: area.left,
    top,
    right: rightEdge,
    bottom: Math.min(area.bottom, top + line * 4),
  };
}

/** Algo más pide la atención (un diálogo, un menú, escribir, el modo tamaño…): el recorrido espera. */
function distracted(): boolean {
  if (find('.backdrop, .menu-list:not(.leaving), .page-text.editing, .app.sizing, .app.resizing, .cover.arranging')) return true;
  const focus = document.activeElement;
  return focus instanceof HTMLElement && !focus.closest('.tour') && (focus.matches('input, textarea, select') || focus.isContentEditable);
}

// ---- los pasos -------------------------------------------------------------------------

type StepId = 'cover' | 'sheet' | 'turn' | 'write' | 'find' | 'tabs' | 'menu' | 'away';
type Side = 'top' | 'bottom' | 'left' | 'right';

/** Un paso donde se pide probar algo: avanza solo cuando se lo hace, y «Siguiente» sigue estando. */
interface Try {
  hint: string;
  /** Cómo estaba todo cuando empezó el paso, para notar después qué cambió. */
  baseline: (scene: Scene) => unknown;
  done: (scene: Scene, baseline: unknown) => boolean;
  /** Cuánto se espera, ya hecho, antes de seguir: lo justo para ver que salió bien. */
  settle: number;
}

interface Step {
  /** Abierto, el cuaderno muestra hojas; cerrado, la tapa. Con el otro estado el paso espera. */
  needs: 'open' | 'closed';
  /** Lo que se resalta; `null` si todavía no está a la vista (el recorrido espera a que aparezca). */
  target: (scene: Scene) => Rect | null;
  /** Dónde deja pasar los clics, en los pasos donde se prueba algo; si no, el mismo lugar resaltado. */
  reach?: (scene: Scene) => Rect | null;
  /** De qué lado del resaltado prefiere ponerse el globo, en orden. */
  sides: Side[];
  title: (scene: Scene) => string;
  text: (scene: Scene) => ReactNode;
  tryIt?: (scene: Scene) => Try | null;
}

/** Las teclas vigentes de una acción, cada una en su recuadro: si se cambian en Ajustes, el recorrido las sigue. */
function Keys(props: { id: ShortcutId; all?: boolean }) {
  const t = useT();
  const combos = props.all ? combosOf(props.id) : combosOf(props.id).slice(0, 1);
  return (
    <>
      {combos.map((combo, index) => (
        <Fragment key={combo}>
          {index > 0 && (index === combos.length - 1 ? ` ${t('o')} ` : ', ')}
          <kbd className="tour-key">{format(combo)}</kbd>
        </Fragment>
      ))}
    </>
  );
}

/** « (Ctrl + F)» si la acción tiene atajo; nada si se lo sacaron. */
const Shortcut = (props: { id: ShortcutId }) => (hintOf(props.id) ? <> (<Keys id={props.id} />)</> : null);

/** Los atajos que valen desde cualquier programa, como están en Ajustes; `null` si no se pudieron registrar. */
interface Globals {
  open: string | null;
  capture: string | null;
}
const FACTORY_GLOBALS: Globals = { open: GLOBAL_ACTIONS[0].default, capture: GLOBAL_ACTIONS[1].default };

function makeSteps(globals: Globals, t: (key: string, vars?: Record<string, string | number>) => string): Record<StepId, Step> {
  const anywhere = [
    globals.open && (
      <Fragment key="open">
        <kbd className="tour-key">{format(globals.open)}</kbd> {t('abre el cuaderno')}
      </Fragment>
    ),
    globals.capture && (
      <Fragment key="capture">
        <kbd className="tour-key">{format(globals.capture)}</kbd> {t('abre una hoja suelta para tomar una nota rápida')}
      </Fragment>
    ),
  ].filter(Boolean);

  return {
    cover: {
      needs: 'closed',
      target: (scene) => (scene.back ? rectOf('.cover') : rectOf('.cover .cover-label')),
      reach: () => rectOf('.cover'),
      sides: ['bottom', 'top'],
      title: () => t('¡Hola! Esto es Folio'),
      text: (scene) =>
        scene.back ? (
          <>
            {t('Estás viendo el cuaderno por atrás. Tocalo para abrirlo por la última hoja')}
            {hintOf('flip') && (
              <>
                {t(', o dalo vuelta con')} <Keys id="flip" /> {t('para ver la tapa')}
              </>
            )}
            .
          </>
        ) : (
          <>{t('Esta es la tapa. Tocala para abrirlo y ver tus notas de a una, de la más reciente hacia atrás. El nombre de la etiqueta se cambia con un clic.')}</>
        ),
      tryIt: () => ({ hint: t('Probá: tocá la tapa.'), baseline: () => null, done: (scene) => !scene.closed, settle: 380 }),
    },

    sheet: {
      needs: 'open',
      target: (scene) =>
        scene.bare ? emptyNotice() : merge(['.page-head .page-date', '.page-head .page-title', '.page-head .page-meta'].map(rectOf)),
      sides: ['bottom', 'right', 'top'],
      title: (scene) => (scene.bare ? t('Todavía no hay hojas') : t('¡Hola! Esto es Folio')),
      text: (scene) =>
        scene.bare ? (
          <>
            {t('Folio está buscando tus notas por la PC (o este filtro no trae ninguna). Cuando aparezcan, las vas a ver acá, de la más reciente hacia atrás.')}
          </>
        ) : (
          <>{t('Cada hoja es una nota: arriba ves su fecha, su título y su categoría. Van de la más reciente hacia atrás.')}</>
        ),
    },

    turn: {
      needs: 'open',
      target: (scene) => (scene.bare ? emptyNotice() : rectOf('[data-tour="turn-next"]')),
      sides: ['left', 'bottom', 'top'],
      title: (scene) => (scene.bare ? t('Pasar de hoja') : t('Pasá de hoja')),
      text: (scene) =>
        scene.bare ? (
          <>{t('Cuando haya hojas, vas a pasar de una a otra con las franjas de los bordes, deslizando la hoja, con la rueda o con el teclado.')}</>
        ) : (
          <>
            {t('Tocá la franja del borde: la derecha avanza y la izquierda vuelve. También podés deslizar la hoja, usar la rueda o el teclado')} (
            <Keys id="prev" /> {t('y')} <Keys id="next" />).
          </>
        ),
      tryIt: (scene) =>
        scene.bare ? null : { hint: t('Probá: tocá el borde derecho.'), baseline: spot, done: (now, was) => !now.closed && spot() !== was, settle: 700 },
    },

    write: {
      needs: 'open',
      target: (scene) => (scene.bare ? newButton() : firstLines()),
      sides: ['bottom', 'right', 'top'],
      title: (scene) => (scene.bare ? t('Escribí en el cuaderno') : t('Escribí en la hoja')),
      text: (scene) =>
        scene.bare ? (
          <>{t('El botón de hoja nueva abre una hoja en blanco para escribir ahí mismo. Cuando haya hojas, con doble clic escribís en cualquiera.')}</>
        ) : scene.locked ? (
          <>
            {t('Con doble clic escribís ahí mismo, en las hojas que son archivos .txt o .md; esta no se puede, porque viene de otra aplicación. Con')}{' '}
            <Keys id="finish" all /> {t('se guarda y se termina.')}
          </>
        ) : (
          <>
            {t('Hacé doble clic en cualquier parte de la hoja y escribís ahí mismo, en el archivo original. Con')} <Keys id="finish" all /> {t('se guarda y se termina.')}
          </>
        ),
      // En una hoja que no se puede escribir el doble clic solo avisa por qué: no se pide probarlo.
      tryIt: (scene) =>
        scene.bare || scene.locked
          ? null
          : { hint: t('Probá: doble clic sobre el texto.'), baseline: (now) => now.writing, done: (now, was) => now.writing && !was, settle: 0 },
    },

    find: {
      needs: 'open',
      target: () => merge([searchButton(), newButton()]),
      sides: ['bottom', 'left'],
      title: () => t('Buscar y hoja nueva'),
      text: () => (
        <>
          {t('La lupa busca en todas las hojas y filtra por fecha')}
          <Shortcut id="search" />. {t('La hoja con lápiz abre una en blanco, lista para escribir')}
          <Shortcut id="new" />.
        </>
      ),
    },

    tabs: {
      needs: 'open',
      target: () => rectOf('[data-tour="tabs"]'),
      sides: ['bottom'],
      title: () => t('Las solapas'),
      text: () => <>{t('Cada solapa es una categoría y filtra las hojas. Tocá una para ver solo esas; volvé a tocarla para ver todas de nuevo.')}</>,
    },

    menu: {
      needs: 'open',
      target: () => rectOf('[data-tour="actions"] .menu > button'),
      sides: ['bottom', 'left'],
      title: () => t('El menú'),
      text: () => (
        <>
          {t('Acá elegís una o dos hojas, el tamaño del cuaderno y Ajustes')}
          <Shortcut id="settings" />. {t('Para darle el tamaño que quieras, mantené Mayús y arrastrá un borde. Este recorrido se puede volver a ver desde Ajustes.')}
        </>
      ),
      tryIt: () => ({ hint: t('Probá: abrí el menú.'), baseline: (scene) => scene.menu, done: (scene, was) => scene.menu && !was, settle: 0 }),
    },

    away: {
      needs: 'open',
      target: () => rectOf('[data-tour="controls"] > button:nth-child(2)'),
      sides: ['right', 'bottom'],
      title: () => t('Siempre a mano'),
      text: () => (
        <>
          {t('La cruz cierra la ventana, pero Folio queda en la bandeja, junto al reloj.')}
          {anywhere.length > 0 && (
            <>
              {' '}
              {t('Desde cualquier programa,')} {anywhere[0]}
              {anywhere[1] && <> {t('y')} {anywhere[1]}</>}.
            </>
          )}
        </>
      ),
    },
  };
}

/** Qué pasos tiene el recorrido según cómo está el cuaderno al empezar: la tapa si está cerrado, la hoja si está abierto. */
function planSteps(): StepId[] {
  const ids: StepId[] = [find('.book.closed') ? 'cover' : 'sheet', 'turn', 'write', 'find'];
  if (find('.tabs')) ids.push('tabs');
  return [...ids, 'menu', 'away'];
}

// ---- cada cuadro ----------------------------------------------------------------------

/** Lo que se ve del recorrido en un momento: se vuelve a calcular en cada cuadro de animación. */
interface Frame {
  view: { w: number; h: number };
  hole: Rect | null;
  /** Por dónde pasan los clics al cuaderno; `null` si no pasa ninguno. */
  reach: Rect | null;
  /** Controles del cuaderno que el globo no tiene que tapar. */
  avoid: Rect[];
  /** Se hace a un lado: algo más pide la atención, o lo que señala todavía no está. */
  hidden: boolean;
  achieved: boolean;
  scene: Scene;
}

/** Lo que el bucle de cuadros necesita saber sin pasar por React. */
interface Live {
  step: Step;
  index: number;
  count: number;
  /** Se puede volver al paso anterior (no a la tapa: para eso habría que cerrar el cuaderno). */
  canBack: boolean;
  since: number;
  /** Lo que se pide probar se anotó (`baseline`) y ya se puede notar un cambio. */
  armed: boolean;
  baseline: unknown;
  /** El paso pedía probar algo en el cuadro anterior. */
  asking: boolean;
  signature: string;
  hidden: boolean;
}

function look(live: Live): Frame {
  const scene = readScene();
  const { step } = live;
  const hole = step.target(scene);
  const tryIt = step.tryIt?.(scene) ?? null;
  const reach = tryIt && hole ? (step.reach?.(scene) ?? hole) : null;
  // Si lo que se pide probar aparece recién ahora (llegaron las hojas, o pasó a una que se puede escribir), se anota de nuevo cómo estaba todo.
  if (tryIt && !live.asking) Object.assign(live, { armed: false, since: Date.now() });
  live.asking = !!tryIt;
  if (tryIt && !live.armed && Date.now() - live.since >= ARM_DELAY) {
    live.baseline = tryIt.baseline(scene);
    live.armed = true;
  }
  const achieved = !!tryIt && live.armed && tryIt.done(scene, live.baseline);
  const mismatch = step.needs === 'open' ? scene.closed : !scene.closed;
  const avoid = ['[data-tour="controls"]', '[data-tour="actions"]', '.cover-controls', '.cover-actions', '[data-tour="tabs"]']
    .map(rectOf)
    .filter((rect): rect is Rect => rect !== null && !(hole && within(rect, hole)));
  return {
    view: { w: window.innerWidth, h: window.innerHeight },
    hole,
    reach,
    avoid,
    hidden: distracted() || hole === null || (mismatch && !achieved),
    achieved,
    scene,
  };
}

/** Las cuatro franjas que rodean a un lugar que sí deja pasar los clics. */
const blocks = (open: Rect): CSSProperties[] => [
  { left: 0, top: 0, right: 0, height: Math.max(0, open.top) },
  { left: 0, top: open.bottom, right: 0, bottom: 0 },
  { left: 0, top: open.top, width: Math.max(0, open.left), height: open.bottom - open.top },
  { left: open.right, top: open.top, right: 0, height: open.bottom - open.top },
];

// ---- dónde va el globo -------------------------------------------------------------------

interface Placed {
  left: number;
  top: number;
  arrow: { side: Side; at: number } | null;
}

/**
 * Elige dónde poner el globo: de los lados que prefiere el paso (alineado al centro o a un
 * extremo de lo resaltado, y pegado a él o un poco más lejos), el que menos tapa lo resaltado
 * y los controles de arriba y menos se corre para entrar en la ventana. La flecha apunta a
 * lo resaltado.
 */
function placeBalloon(hole: Rect, size: { w: number; h: number }, view: { w: number; h: number }, avoid: Rect[], sides: Side[]): Placed {
  const lit = grow(hole, PAD);
  const centre = { x: (lit.left + lit.right) / 2, y: (lit.top + lit.bottom) / 2 };
  const fit = (value: number, extent: number, room: number) => Math.max(MARGIN, Math.min(value, room - extent - MARGIN));
  let best: Placed = { left: (view.w - size.w) / 2, top: (view.h - size.h) / 2, arrow: null };
  let bestScore = Infinity;
  for (const [rank, side] of sides.entries()) {
    const across = side === 'top' || side === 'bottom';
    for (const [align, push] of [0, 1, 2].flatMap((align) => [0, 1, 2].map((push) => [align, push] as const))) {
      // Más lejos solo si no hay otra manera de no tapar un botón.
      const away = GAP + push * AWAY;
      const wantedLeft = across ? [centre.x - size.w / 2, lit.left, lit.right - size.w][align] : side === 'left' ? lit.left - away - size.w : lit.right + away;
      const wantedTop = across ? (side === 'top' ? lit.top - away - size.h : lit.bottom + away) : [centre.y - size.h / 2, lit.top, lit.bottom - size.h][align];
      const left = fit(wantedLeft, size.w, view.w);
      const top = fit(wantedTop, size.h, view.h);
      const rect = { left, top, right: left + size.w, bottom: top + size.h };
      const covered = overlap(rect, lit) * 3 + avoid.reduce((sum, other) => sum + overlap(rect, other) * 2, 0);
      const score = covered + (Math.abs(left - wantedLeft) + Math.abs(top - wantedTop)) * 40 + rank * 300 + (align ? 120 : 0) + push * 150;
      if (score >= bestScore) continue;
      bestScore = score;
      // La flecha sale del lado que mira a lo resaltado, si el globo quedó claramente de ese lado.
      const facing: Side | null =
        rect.top >= lit.bottom - 1 ? 'top' : rect.bottom <= lit.top + 1 ? 'bottom' : rect.left >= lit.right - 1 ? 'left' : rect.right <= lit.left + 1 ? 'right' : null;
      const horizontal = facing === 'top' || facing === 'bottom';
      const at = horizontal ? centre.x - left : centre.y - top;
      best = { left, top, arrow: facing && { side: facing, at: Math.max(26, Math.min(at, (horizontal ? size.w : size.h) - 26)) } };
    }
  }
  return best;
}

interface WelcomeModalProps {
  onContinue: () => void;
  onSkip: () => void;
}

function WelcomeModal(props: WelcomeModalProps) {
  const t = useT();
  const { onContinue, onSkip } = props;
  const [tab, setTab] = useState<'local' | 'ai'>('local');

  const [localStatus, setLocalStatus] = useState<'idle' | 'working' | 'ready'>('idle');
  const [localSuggestions, setLocalSuggestions] = useState<CategorySuggestion[]>([]);
  const [localSelected, setLocalSelected] = useState<boolean[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  const [aiProvider, setAiProvider] = useState<ProviderId>('ollama');
  const [ollamaModel, setOllamaModel] = useState('llama3');
  const [apiKey, setApiKey] = useState('');
  const [aiStatus, setAiStatus] = useState<'idle' | 'working' | 'ready'>('idle');
  const [aiSuggestions, setAiSuggestions] = useState<CategorySuggestion[]>([]);
  const [aiSelected, setAiSelected] = useState<boolean[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);

  const analyseLocal = async () => {
    setLocalStatus('working');
    setLocalError(null);
    try {
      const items = await api.suggestCategories();
      setLocalSuggestions(items);
      setLocalSelected(items.map(() => true));
      setLocalStatus('ready');
    } catch (err) {
      setLocalError(String(err).replace(/^Error:\s*/, ''));
      setLocalStatus('ready');
    }
  };

  const analyseAi = async () => {
    setAiStatus('working');
    setAiError(null);
    try {
      if (aiProvider === 'ollama') {
        await api.setAiProvider('ollama');
        if (ollamaModel.trim()) await api.setAiModel('ollama', ollamaModel.trim());
      } else {
        if (apiKey.trim()) await api.setProviderKey(aiProvider, apiKey.trim());
        await api.setAiProvider(aiProvider);
      }
      const items = await api.suggestCategoriesAi();
      setAiSuggestions(items);
      setAiSelected(items.map(() => true));
      setAiStatus('ready');
    } catch (err) {
      setAiError(String(err).replace(/^Error:\s*/, ''));
      setAiStatus('ready');
    }
  };

  const createAndStart = async (suggestions: CategorySuggestion[], selected: boolean[]) => {
    setCreating(true);
    try {
      for (let i = 0; i < suggestions.length; i++) {
        if (!selected[i]) continue;
        const item = suggestions[i];
        const name = item.name.trim();
        if (!name) continue;
        const color = suggestColor(i);
        const desc = item.keywords.length > 0 ? t('Notas sobre: {words}', { words: item.keywords.join(', ') }) : '';
        await api.createCategory(name, desc, color);
      }
    } catch {
      // Ignora si alguna ya existía
    } finally {
      setCreating(false);
      onContinue();
    }
  };

  const renderSuggestions = (
    suggestions: CategorySuggestion[],
    setSuggestions: (next: CategorySuggestion[]) => void,
    selected: boolean[],
    setSelected: (next: boolean[]) => void,
  ) => (
    <div className="welcome-results suggest-body">
      <SuggestedCategoryList
        variant="welcome"
        items={suggestions.map((item, index) => ({
          name: item.name,
          keywords: item.keywords,
          count: item.count,
          samples: item.samples,
          checked: selected[index] ?? true,
          color: (selected[index] ?? true) ? suggestColor(index) : 'var(--label-3)',
        }))}
        disabled={creating}
        onToggle={(index) => {
          const next = [...selected];
          next[index] = !(selected[index] ?? true);
          setSelected(next);
        }}
        onNameChange={(index, name) => {
          const next = [...suggestions];
          next[index] = { ...suggestions[index], name };
          setSuggestions(next);
        }}
      />
      <div className="suggest-actions welcome-create-action">
        <button
          type="button"
          className="button primary welcome-create-start"
          disabled={creating || !selected.some(Boolean)}
          onClick={() => void createAndStart(suggestions, selected)}
        >
          {creating ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
          {t('Crear categorías y empezar el recorrido')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="welcome-overlay" role="dialog" aria-modal="true" aria-label={t('¡Bienvenido a Folio!')}>
      <div className="modal welcome-card">
        <div className="modal-header welcome-head">
          <h2>{t('¡Bienvenido a Folio!')}</h2>
        </div>

        <div className="modal-body welcome-body">
          <p className="welcome-intro">
            {t('Reunimos tus notas .txt, .md, del Bloc de notas y de Notas rápidas de la PC sin mover ni tocar tus archivos.')}
          </p>
          <p className="welcome-subintro">
            {t('Podés analizar y clasificar las categorías de tus notas con un algoritmo inteligente o una IA, o continuar directamente con las categorías de fábrica.')}
          </p>

          <section className="group">
            <div className="welcome-section-head">
              <h3>{t('Categorías iniciales')}</h3>
              <div className="segmented welcome-tabs" role="tablist" aria-label={t('Categorías iniciales')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'local'}
                  className={`welcome-tab${tab === 'local' ? ' active' : ''}`}
                  onClick={() => setTab('local')}
                >
                  <Cpu size={13} />
                  <span>{t('Analizar en esta PC')}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'ai'}
                  className={`welcome-tab${tab === 'ai' ? ' active' : ''}`}
                  onClick={() => setTab('ai')}
                >
                  <Bot size={13} />
                  <span>{t('Conectar mi propia IA')}</span>
                </button>
              </div>
            </div>

            <div className="group-body">
              {tab === 'local' ? (
                <>
                  <div className="row suggest-row">
                    <div className="row-text">
                      <span>{t('Sugerir categorías a partir de mis notas')}</span>
                      <small>
                        {t('Un algoritmo propio agrupa las palabras que más se repiten en tus notas para sugerir categorías sin enviar nada a internet.')}
                      </small>
                    </div>
                    <div className="row-control">
                      <button
                        type="button"
                        className="button suggest-go welcome-suggest-local"
                        disabled={localStatus === 'working' || creating}
                        onClick={() => void analyseLocal()}
                      >
                        {localStatus === 'working' ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
                        {localStatus === 'working'
                          ? t('Analizando notas…')
                          : localStatus === 'ready'
                            ? t('Volver a analizar')
                            : t('Sugerir en esta PC')}
                      </button>
                    </div>
                  </div>

                  {localError && (
                    <p className="suggest-empty welcome-error" role="alert">
                      {localError}
                    </p>
                  )}

                  {localStatus === 'ready' && !localError && (
                    localSuggestions.length === 0 ? (
                      <p className="suggest-empty welcome-empty">
                        {t('Todavía no hay suficientes notas parecidas entre sí para proponer categorías.')}
                      </p>
                    ) : (
                      renderSuggestions(localSuggestions, setLocalSuggestions, localSelected, setLocalSelected)
                    )
                  )}
                </>
              ) : (
                <>
                  <div className="row">
                    <div className="row-text">
                      <span>{t('Proveedor de IA')}</span>
                      <small>
                        {t('Elegí un modelo para proponer categorías amplias. Podés usar Ollama en tu PC (sin clave ni internet) o pegar tu clave de Claude, OpenAI o Gemini (guardada únicamente en el llavero de Windows).')}
                      </small>
                    </div>
                    <div className="row-control">
                      <div className="segmented welcome-provider-picker" role="tablist">
                        {(['ollama', 'claude', 'openai', 'gemini'] as const).map((prov) => (
                          <button
                            key={prov}
                            type="button"
                            role="tab"
                            aria-selected={aiProvider === prov}
                            className={`welcome-prov-pill${aiProvider === prov ? ' active' : ''}`}
                            onClick={() => setAiProvider(prov)}
                          >
                            {prov === 'ollama' ? 'Ollama' : prov === 'claude' ? 'Claude' : prov === 'openai' ? 'OpenAI' : 'Gemini'}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="row add-row">
                    {aiProvider === 'ollama' ? (
                      <input
                        type="text"
                        className="welcome-input"
                        aria-label={t('Modelo en Ollama:')}
                        placeholder={t('Por ejemplo: llama3, mistral o qwen')}
                        value={ollamaModel}
                        onChange={(e) => setOllamaModel(e.target.value)}
                      />
                    ) : (
                      <input
                        type="password"
                        className="welcome-input"
                        aria-label={t('Clave de API:')}
                        placeholder={t('Pegá tu clave de API')}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                      />
                    )}
                    <button
                      type="button"
                      className="button welcome-suggest-ai"
                      disabled={aiStatus === 'working' || creating}
                      onClick={() => void analyseAi()}
                    >
                      {aiStatus === 'working' ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
                      {aiStatus === 'working'
                        ? t('Consultando IA…')
                        : t('Sugerir con {provider}', {
                            provider: aiProvider === 'ollama' ? 'Ollama' : aiProvider === 'claude' ? 'Claude' : aiProvider === 'openai' ? 'OpenAI' : 'Gemini',
                          })}
                    </button>
                  </div>

                  {aiError && (
                    <p className="suggest-empty welcome-error" role="alert">
                      {aiError}
                    </p>
                  )}

                  {aiStatus === 'ready' && !aiError && (
                    aiSuggestions.length === 0 ? (
                      <p className="suggest-empty welcome-empty">
                        {t('Todavía no hay suficientes notas parecidas entre sí para proponer categorías.')}
                      </p>
                    ) : (
                      renderSuggestions(aiSuggestions, setAiSuggestions, aiSelected, setAiSelected)
                    )
                  )}
                </>
              )}
            </div>
          </section>
        </div>

        <div className="welcome-foot">
          <button type="button" className="button quiet welcome-skip" onClick={onSkip}>
            {t('Saltar todo')}
          </button>
          <button type="button" className="button primary welcome-start-default" onClick={onContinue}>
            {t('Usar categorías de fábrica y empezar')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface OutroModalProps {
  onOpenSettings?: () => void;
  onClose: () => void;
}

function OutroModal(props: OutroModalProps) {
  const t = useT();
  const { onOpenSettings, onClose } = props;

  return (
    <div className="tour-outro-overlay" role="dialog" aria-modal="true" aria-label={t('¡Todo listo! Qué más podés hacer en Folio')}>
      <div className="modal tour-outro">
        <div className="modal-header tour-outro-head">
          <h2>{t('¡Todo listo! Qué más podés hacer en Folio')}</h2>
          <CheckCircle2 size={18} className="tour-outro-check" />
        </div>

        <div className="modal-body tour-outro-body">
          <p className="welcome-intro">
            {t('Tu cuaderno personal ya está configurado. Acá tenés algunas funciones pensadas para tu día a día:')}
          </p>

          <section className="group">
            <div className="group-body tour-outro-grid">
              <div className="row tour-outro-card">
                <div className="tour-outro-card-icon">
                  <Scissors size={16} />
                </div>
                <div className="row-text">
                  <span>{t('Guardar recortes al instante (Ctrl + Alt + X)')}</span>
                  <small>
                    {t('Seleccioná texto en cualquier programa o navegador y apretá el atajo para guardarlo en la hoja recortes-AAAA-MM-DD.txt o en una hoja suelta.')}
                  </small>
                </div>
              </div>

              <div className="row tour-outro-card">
                <div className="tour-outro-card-icon">
                  <Bot size={16} />
                </div>
                <div className="row-text">
                  <span>{t('Clasificación automática con IA')}</span>
                  <small>
                    {t('Conectá Ollama (local y sin internet), Claude, OpenAI, Gemini o Jev para que cada nota nueva reciba su categoría sola.')}
                  </small>
                </div>
              </div>

              <div className="row tour-outro-card">
                <div className="tour-outro-card-icon">
                  <Sparkles size={16} />
                </div>
                <div className="row-text">
                  <span>{t('Integración con asistentes (Skills)')}</span>
                  <small>
                    {t('Conectá Claude Code, Codex o Gemini CLI en un clic para que guarden notas .md con formato directo en tu Folio.')}
                  </small>
                </div>
              </div>

              <div className="row tour-outro-card">
                <div className="tour-outro-card-icon">
                  <Shield size={16} />
                </div>
                <div className="row-text">
                  <span>{t('Personalización y cuaderno secreto cifrado')}</span>
                  <small>
                    {t('Elegí entre 6 tapas realistas, stickers, modo de 1 o 2 hojas, atajos a medida y hojas secretas cifradas con XChaCha20-Poly1305.')}
                  </small>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="welcome-foot tour-outro-foot">
          {onOpenSettings ? (
            <button
              type="button"
              className="button outro-settings"
              onClick={() => {
                onClose();
                onOpenSettings();
              }}
            >
              <Settings2 size={14} />
              {t('Abrir Ajustes')}
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="button primary outro-done" onClick={onClose}>
            {t('Empezar a usar Folio')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- el componente -----------------------------------------------------------------------

/** El recorrido. Se muestra solo la primera vez y cada vez que `replay` sube. */
export function Tutorial(props: { replay?: number; onOpenSettings?: () => void }) {
  // Los atajos que se nombran son los vigentes: si cambian, el texto cambia.
  useShortcuts();
  const t = useT();
  const [welcome, setWelcome] = useState(() => !welcomeSeen());
  const [outro, setOutro] = useState(false);
  const [running, setRunning] = useState(false);
  const [plan, setPlan] = useState<StepId[]>([]);
  const [index, setIndex] = useState(0);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [glide, setGlide] = useState(false);
  const [globals, setGlobals] = useState<Globals>(FACTORY_GLOBALS);
  const [size, setSize] = useState({ w: BALLOON_WIDTH, h: 180 });
  const { mounted, leaving } = usePresence(running, 260);
  const balloon = useRef<HTMLDivElement>(null);
  const before = useRef<HTMLElement | null>(null);
  const steps = makeSteps(globals, t);
  const step = steps[plan[index] ?? 'sheet'];
  const last = index >= plan.length - 1;
  const canBack = index > 0 && plan[index - 1] !== 'cover';
  const live = useRef<Live>({ step, index, count: 0, canBack, since: 0, armed: false, baseline: null, asking: false, signature: '', hidden: true });
  Object.assign(live.current, { step, index, count: plan.length, canBack, hidden: frame?.hidden ?? true });

  const start = useCallback(() => {
    markSeen();
    const ids = planSteps();
    before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    api
      .getSettings()
      .then((settings) =>
        setGlobals({ open: settings.openShortcut ? settings.openKeys : null, capture: settings.captureShortcut ? settings.captureKeys : null }),
      )
      .catch(() => {});
    setPlan(ids);
    setIndex(0);
    setFrame(null);
    setGlide(false);
    setRunning(true);
  }, []);

  const finish = useCallback(() => {
    markSeen();
    setRunning(false);
    const back = before.current;
    before.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, []);

  /** Pasa al paso de al lado; el último cierra el recorrido. */
  const move = useCallback(
    (delta: 1 | -1) => {
      const { index: at, count, step: now, canBack: back } = live.current;
      if (delta > 0) {
        if (at >= count - 1) {
          finish();
          setOutro(true);
          return;
        }
        // Desde la tapa, seguir es abrir el cuaderno: el recorrido avanza solo cuando se abre.
        if (now.needs === 'closed' && find('.book.closed')) return find('.cover')?.click();
        setIndex(at + 1);
      } else if (back) {
        setIndex(at - 1);
      }
    },
    [finish],
  );

  // La primera vez, cuando el cuaderno ya se asentó.
  useEffect(() => {
    if (tourSeen() || welcome) return;
    let timer = 0;
    const attempt = () => {
      const settled = find('.app') && !find('.app.resizing, .app.sizing, .backdrop') && (find('.cover') || find('.page, .page-empty'));
      if (settled) start();
      else timer = window.setTimeout(attempt, 200);
    };
    timer = window.setTimeout(attempt, FIRST_DELAY);
    return () => window.clearTimeout(timer);
  }, [start, welcome]);

  // Cuando se pide verlo de nuevo (el menú, o Ajustes cuando es otra ventana).
  const replayed = useRef(props.replay);
  useEffect(() => {
    if (replayed.current === props.replay) return;
    replayed.current = props.replay;
    setWelcome(false);
    setOutro(false);
    start();
  }, [props.replay, start]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === REPLAY_KEY) {
        setWelcome(false);
        setOutro(false);
        start();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [start]);

  useEffect(() => {
    if (!welcome) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        markWelcomeSeen();
        markSeen();
        setWelcome(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [welcome]);

  useEffect(() => {
    if (!outro) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOutro(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [outro]);

  // Cada paso arranca de cero y se mide en el mismo dibujo, para que su globo no aparezca con los datos del anterior.
  const refresh = useCallback(() => {
    const next = look(live.current);
    const signature = JSON.stringify(next);
    if (signature === live.current.signature) return;
    live.current.signature = signature;
    setFrame(next);
  }, []);
  useLayoutEffect(() => {
    if (!running) return;
    Object.assign(live.current, { since: Date.now(), armed: false, baseline: null, asking: false, signature: '' });
    refresh();
  }, [running, index, refresh]);

  // Mientras dura, se vuelve a mirar en cada cuadro: el cuaderno se anima, cambia de tamaño y cambia de hoja.
  useEffect(() => {
    if (!running) return;
    let frameId = 0;
    const tick = () => {
      refresh();
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [running, refresh]);

  // Al cambiar de paso, lo resaltado y el globo se deslizan hasta su lugar nuevo; el resto del tiempo siguen al cuaderno sin demora.
  const lastIndex = useRef(0);
  useEffect(() => {
    if (!running) {
      lastIndex.current = 0;
      return;
    }
    if (lastIndex.current === index) return;
    lastIndex.current = index;
    setGlide(true);
    const timer = window.setTimeout(() => setGlide(false), 460);
    return () => window.clearTimeout(timer);
  }, [running, index]);

  // Un paso donde se pidió probar algo y se lo hizo: se ve que salió bien y sigue.
  const achieved = frame?.achieved ?? false;
  const waiting = frame?.hidden ?? true;
  useEffect(() => {
    if (!running || !achieved) return;
    const at = live.current.index;
    const settle = live.current.step.tryIt?.(readScene())?.settle ?? 0;
    const timer = window.setTimeout(() => live.current.index === at && move(1), waiting ? 0 : settle);
    return () => window.clearTimeout(timer);
    // `waiting` se lee al empezar la espera: que cambie después no la reinicia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, achieved, index, move]);

  // Teclado: → y Enter siguen, ← vuelve, Esc salta. Las teclas sueltas del cuaderno (flechas, Inicio, V…) quedan
  // quietas mientras se mira; las que llevan Ctrl o Alt siguen valiendo, y entonces el recorrido se hace a un lado.
  useEffect(() => {
    if (!running) return;
    const onKey = (event: KeyboardEvent) => {
      if (live.current.hidden || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'F5', 'F11', 'F12'].includes(event.key)) return;
      const target = event.target instanceof Element ? event.target : null;
      const onButton = !!target?.closest('.tour-balloon button');
      if (event.key === 'Tab') {
        const buttons = [...(balloon.current?.querySelectorAll('button') ?? [])];
        if (buttons.length) buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
      } else if ((event.key === 'Enter' || event.key === ' ') && onButton) {
        // Un botón del globo hace lo suyo.
        event.stopPropagation();
        return;
      } else if (event.key === 'Escape') finish();
      else if (event.key === 'ArrowRight' || event.key === 'Enter') event.repeat || move(1);
      else if (event.key === 'ArrowLeft') event.repeat || move(-1);
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [running, move, finish]);

  // El foco pasa al botón que sigue, para que Tab y Enter sean del globo y no de lo que quedó atrás.
  const shown = !!frame && !frame.hidden;
  useEffect(() => {
    if (!running || !shown || leaving) return;
    if (!balloon.current?.contains(document.activeElement)) balloon.current?.querySelector<HTMLElement>('.button.primary')?.focus({ preventScroll: true });
  }, [running, shown, leaving, index]);

  // El globo se mide en el mismo dibujo en que cambia, para ponerlo bien sin que se vea corrido.
  useLayoutEffect(() => {
    const node = balloon.current;
    if (!node) return;
    const next = { w: node.offsetWidth, h: node.offsetHeight };
    setSize((current) => (current.w === next.w && current.h === next.h ? current : next));
  });

  const renderBalloon = () => {
    if (!mounted || !frame) return null;

    const { view, hole, reach, avoid, scene } = frame;
    const width = Math.min(BALLOON_WIDTH, view.w - 2 * MARGIN);
    const placed = hole ? placeBalloon(hole, { w: width, h: size.h }, view, avoid, step.sides) : { left: (view.w - width) / 2, top: MARGIN, arrow: null };
    const lit = hole && grow(hole, PAD);
    // Los clics pasan por donde se pide probar, ni un píxel más: al lado puede haber una franja que pasa de página.
    const open = reach;
    const tryIt = step.tryIt?.(scene) ?? null;
    const done = frame.achieved;
    const classes = ['tour', frame.hidden && 'hidden', glide && 'glide', leaving && 'leaving'].filter(Boolean).join(' ');

    return (
      <div className={classes} onContextMenu={(event) => event.preventDefault()}>
        {lit && (
          <div
            className={`tour-hole${tryIt ? ' try' : ''}`}
            style={{ left: lit.left, top: lit.top, width: lit.right - lit.left, height: lit.bottom - lit.top }}
          />
        )}
        {/* Nada del cuaderno responde, salvo lo que se pide probar: ahí el resguardo se abre. */}
        {(open ? blocks(open) : [{ inset: 0 }]).map((style, at) => (
          // Sin soltar el foco ni la selección de quien esté atrás.
          <div key={at} className="tour-block" style={style} onMouseDown={(event) => event.preventDefault()} />
        ))}
        <div
          ref={balloon}
          className="tour-balloon"
          style={{ left: placed.left, top: placed.top, width }}
          role="dialog"
          aria-label={t('Recorrido por Folio')}
          aria-describedby="tour-text"
        >
          {placed.arrow && (
            <i
              className={`tour-arrow ${placed.arrow.side}`}
              style={placed.arrow.side === 'top' || placed.arrow.side === 'bottom' ? { left: placed.arrow.at } : { top: placed.arrow.at }}
            />
          )}
          <div className="tour-content" key={plan[index]}>
            <h2 className="tour-title">{step.title(scene)}</h2>
            <p className="tour-text" id="tour-text">
              {step.text(scene)}
            </p>
            {tryIt && (
              <p className={`tour-try${done ? ' done' : ''}`}>
                {done ? <Check size={13} /> : <MousePointerClick size={13} />}
                {done ? t('¡Eso es!') : tryIt.hint}
              </p>
            )}
          </div>
          <footer className="tour-foot">
            <button type="button" className="button small quiet" onClick={finish}>
              {t('Saltar')}
            </button>
            <span className="tour-count" aria-label={t('Paso {n} de {total}', { n: index + 1, total: plan.length })}>
              {t('{n} de {total}', { n: index + 1, total: plan.length })}
            </span>
            {canBack && (
              <button type="button" className="button small" onClick={() => move(-1)}>
                {t('Atrás')}
              </button>
            )}
            <button type="button" className="button small primary" onClick={() => move(1)}>
              {last ? t('Listo') : t('Siguiente')}
            </button>
          </footer>
        </div>
      </div>
    );
  };

  return (
    <>
      {welcome && (
        <WelcomeModal
          onContinue={() => {
            markWelcomeSeen();
            setWelcome(false);
            start();
          }}
          onSkip={() => {
            markWelcomeSeen();
            markSeen();
            setWelcome(false);
          }}
        />
      )}
      {renderBalloon()}
      {outro && (
        <OutroModal
          onOpenSettings={props.onOpenSettings}
          onClose={() => setOutro(false)}
        />
      )}
    </>
  );
}

