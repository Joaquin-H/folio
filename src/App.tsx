import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BookOpen, Lock, Minus, Power, Settings2, Trash2, X } from 'lucide-react';
import { api, isTauri, type Spot } from './api';
import { Finder } from './components/Finder';
import { Notebook, type FilterChip, type NotebookActions, type NotebookTab } from './components/Notebook';
import { SettingsSheet } from './components/Settings';
import { Tutorial } from './components/Tutorial';
import { Presence, type MenuItem } from './components/ui';
import { dayHeading, plural, readableOn } from './format';
import { useDebounced, usePrefs } from './hooks';
import { mark, useT } from './i18n';
import {
  bookBox,
  boxForHeight,
  DESK,
  heightForWidth,
  maxHeight,
  MIN_HEIGHT,
  sizeForHeight,
  snapHeight,
  TEXT_ORDER,
  windowBox,
  type Grip,
  type Shape,
} from './layout';
import { hintOf, useShortcuts, which, WINDOW_ACTIONS } from './shortcuts';
import type { BookSize, ListFilter, Overview, PresetSize, View } from './types';

const isMac = /Mac/i.test(navigator.userAgent);

const EMPTY: Record<View['kind'], { title: string; hint: string }> = {
  all: { title: mark('Todavía no hay hojas'), hint: mark('Escribí en el Bloc de notas o guardá un .txt o .md: va a aparecer acá solo.') },
  uncategorized: { title: mark('Todo tiene categoría'), hint: mark('Las hojas sin categoría aparecen acá.') },
  secret: { title: mark('El secret-book está vacío'), hint: mark('Las hojas marcadas como sensibles se guardan acá, fuera del cuaderno y de la búsqueda.') },
  hidden: { title: mark('La papelera está vacía'), hint: mark('Lo que mandes a la papelera deja el cuaderno, pero podés recuperarlo desde acá.') },
  category: { title: mark('Sin hojas en esta categoría'), hint: mark('Asigná la categoría desde el encabezado de cualquier hoja.') },
};

const VIEW_LABEL: Record<Exclude<View['kind'], 'category'>, string> = {
  all: mark('Todas las hojas'),
  uncategorized: mark('Sin categoría'),
  secret: mark('Secret-book'),
  hidden: mark('Papelera'),
};

type Panel = 'finder' | 'settings' | null;

/** Tamaños estándar, como se eligen desde el menú: nombre corto y nombre completo. */
const SIZES: { size: PresetSize; label: string; title: string }[] = [
  { size: 'pocket', label: mark('Bolsillo'), title: mark('De bolsillo') },
  { size: 'standard', label: mark('Estándar'), title: mark('Estándar') },
  { size: 'full', label: mark('Completo'), title: mark('Pantalla completa') },
];
const SIZE_NAME: Record<BookSize, string> = { pocket: mark('De bolsillo'), standard: mark('Estándar'), full: mark('Pantalla completa'), custom: mark('A medida') };
/** Cuánto tarda el cuaderno en desvanecerse antes de que la ventana cambie de tamaño. */
const RESIZE_FADE = 110;
/** Lo máximo que se espera a que se guarde lo que se estaba escribiendo antes de cerrar. */
const CLOSE_PATIENCE = 2500;
/** Cuánto hay que mantener Mayús para entrar al modo tamaño: un toque no alcanza. */
const SIZING_DELAY = 180;
/** Cuánto agranda o achica el cuaderno cada toque de Ctrl + y Ctrl −. */
const SIZE_STEP = 48;

const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Modo tamaño: lo que se aplicará al soltar. `dx, dy` es cuánto se corre la ventana
 * (cuando se estira desde la izquierda o desde arriba) y `height` el alto del cuaderno.
 */
interface Sizing {
  dx: number;
  dy: number;
  height: number;
  dragging: boolean;
}

/** La ventana es el cuaderno: mide lo que mide él y no tiene barra ni botones propios. */
export function App() {
  const t = useT();
  const [prefs, setPrefs] = usePrefs();
  // Los menús muestran las combinaciones vigentes: si cambian (acá o en Ajustes), se redibujan.
  useShortcuts();
  const [closed, setClosed] = useState(false);
  const [view, setView] = useState<View>({ kind: 'all' });
  const [query, setQuery] = useState('');
  const [until, setUntil] = useState<number | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [revision, setRevision] = useState(0);
  const [panel, setPanel] = useState<Panel>(null);
  /** Cada hoja nueva que se pide suma uno: el cuaderno la abre para escribir. */
  const [compose, setCompose] = useState(0);
  /** Cada vez que sube, se muestra el recorrido (menú, Ajustes). La primera vez se muestra solo. */
  const [tour, setTour] = useState(0);
  const [sizing, setSizing] = useState<Sizing | null>(null);
  const debouncedQuery = useDebounced(query.trim(), 200);
  /** Guarda lo que se esté escribiendo en el cuaderno; lo completa el propio cuaderno. */
  const flush = useRef<() => Promise<void>>(async () => {});
  /** El próximo ajuste de la ventana no la centra (viene de estirarla a mano). */
  const keepPlace = useRef(false);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api
        .getOverview()
        .then((next) => alive && setOverview(next))
        .catch(() => {});
    refresh();
    const stop = api.onChanged(() => {
      refresh();
      setRevision((value) => value + 1);
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  /** Antes de cerrar la ventana o la aplicación, lo que se estaba escribiendo se guarda. */
  const settle = useCallback(() => Promise.race([flush.current(), pause(CLOSE_PATIENCE)]), []);
  useEffect(() => api.window.onClosing(settle), [settle]);
  // «Salir» desde la bandeja no pasa por la ventana: el backend avisa y espera esto.
  useEffect(() => api.onQuitRequested(settle), [settle]);
  const quit = useCallback(() => void settle().finally(api.window.quit), [settle]);

  // Bloqueo global de atajos nativos no deseados de Chromium / WebView2:
  // - Ctrl+P (diálogo de impresión nativo)
  // - Ctrl+G y F3 (barra nativa de búsqueda en la página)
  // - Ctrl+U (código fuente)
  // - Ctrl+J (descargas)
  // - F7 (navegación con cursor)
  useEffect(() => {
    const preventBrowserShortcuts = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isCtrlOrMeta = event.ctrlKey || event.metaKey;
      if (
        (isCtrlOrMeta && (key === 'p' || key === 'g' || key === 'u' || key === 'j')) ||
        event.key === 'F3' ||
        event.key === 'F7'
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', preventBrowserShortcuts, { capture: true });
    return () => window.removeEventListener('keydown', preventBrowserShortcuts, { capture: true });
  }, []);

  // Los ajustes se abren siempre dentro del cuaderno (y tienen un botón arriba a la derecha
  // para sacarlos a una ventana aparte si se prefiere).
  const openSettings = useCallback(() => {
    setPanel('settings');
  }, []);

  /** Hoja nueva: el cuaderno queda sin filtros que la escondan y la abre para escribir. */
  const composeSheet = useCallback(() => {
    setView((current) => (current.kind === 'secret' || current.kind === 'hidden' ? { kind: 'all' } : current));
    setQuery('');
    setUntil(null);
    setPanel(null);
    setCompose((value) => value + 1);
  }, []);

  // El tamaño de la ventana sale del cuaderno: tamaño elegido, una o dos hojas, abierto o cerrado.
  const shape = useMemo<Shape>(() => ({ spread: prefs.spread, closed, tabs: prefs.tabs }), [prefs.spread, closed, prefs.tabs]);
  const book = useMemo(() => bookBox(prefs.size, prefs.height, shape), [prefs.size, prefs.height, shape]);
  const sizingNow = sizing !== null;
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    // En modo tamaño la ventana no se toca: el cambio se aplica al soltar, de una sola vez.
    if (!isTauri || sizingNow) return;
    const box = windowBox(book, prefs.tabs);
    const center = prefs.size === 'full' && !keepPlace.current;
    keepPlace.current = false;
    const fits = () => Math.abs(window.innerWidth - box.width) <= 1 && Math.abs(window.innerHeight - box.height) <= 1;
    let tries = 0;
    let timer = 0;
    // Un pedido de tamaño puede perderse (por ejemplo, si justo se está arrastrando la
    // ventana) o algo externo puede cambiarlo: se comprueba y se insiste hasta que coincide.
    const enforce = () => {
      if (fits() || tries++ >= 10) return setResizing(false);
      void api.window.fit(box.width, box.height, center).catch(() => {});
      timer = window.setTimeout(enforce, 200);
    };
    const recheck = () => {
      window.clearTimeout(timer);
      tries = 0;
      timer = window.setTimeout(enforce, 150);
    };
    if (fits()) {
      // Mismo tamaño: igual se pide el ajuste, que además deja la ventana dentro de la pantalla.
      setResizing(false);
      void api.window.fit(box.width, box.height, center).catch(() => {});
    } else {
      // Para que el cambio no se vea como un salto: el cuaderno se desvanece, la ventana
      // toma su nueva medida y el cuaderno vuelve a aparecer.
      setResizing(true);
      timer = window.setTimeout(() => {
        void api.window
          .fit(box.width, box.height, center)
          .catch(() => {})
          .finally(() => {
            timer = window.setTimeout(enforce, 60);
          });
      }, RESIZE_FADE);
    }
    window.addEventListener('resize', recheck);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', recheck);
    };
  }, [book, prefs.tabs, prefs.size, sizingNow]);

  // ---- modo tamaño ---------------------------------------------------------
  //
  // Manteniendo Mayús se entra al modo: aparecen las agarraderas en los bordes y las
  // esquinas. Al arrastrar una, un fantasma muestra cómo quedaría el cuaderno; la
  // ventana no cambia hasta que se suelta Mayús, y entonces lo hace de una sola vez.

  /** Lo más reciente, para los manejadores que viven fuera del ciclo de React. */
  const now = useRef({ sizing, shape, book, prefs });
  now.current = { sizing: now.current.sizing, shape, book, prefs };
  const shiftHeld = useRef(false);
  const applying = useRef(false);
  /** Los pedidos al fantasma van de a uno y en orden; si se juntan, queda el último. */
  const ghost = useRef<{ chain: Promise<void>; wanted?: Spot | null; queued: boolean }>({ chain: Promise.resolve(), queued: false });

  const updateSizing = useCallback((next: Sizing | null) => {
    now.current.sizing = next;
    setSizing(next);
  }, []);

  const spotFor = useCallback((state: Sizing, like: Shape): Spot => {
    const box = windowBox(boxForHeight(state.height, like), like.tabs);
    return { dx: state.dx, dy: state.dy, width: box.width, height: box.height };
  }, []);

  const paintGhost = useCallback((spot: Spot | null) => {
    const job = ghost.current;
    job.wanted = spot;
    if (job.queued) return;
    job.queued = true;
    job.chain = job.chain.then(async () => {
      job.queued = false;
      const target = job.wanted;
      job.wanted = undefined;
      if (target === undefined) return;
      const tabs = now.current.shape.tabs;
      await api.window.ghost(target, [DESK.side, tabs ? DESK.top : DESK.topWithoutTabs, DESK.side, DESK.bottom]).catch(() => {});
    });
  }, []);

  const cancelSizing = useCallback(() => {
    paintGhost(null);
    updateSizing(null);
  }, [paintGhost, updateSizing]);

  /** Aplica lo elegido: el cuaderno se desvanece, la ventana va a donde estaba el fantasma y vuelve. */
  const applySizing = useCallback(async () => {
    const { sizing: state, shape: like, book: current } = now.current;
    if (!state || applying.current) return;
    if (state.dx === 0 && state.dy === 0 && state.height === current.height) return cancelSizing();
    applying.current = true;
    const spot = spotFor(state, like);
    setResizing(true);
    await pause(RESIZE_FADE);
    await api.window.place(spot).catch(() => {});
    keepPlace.current = true;
    setPrefs({ size: sizeForHeight(state.height, like), height: state.height });
    paintGhost(null);
    // La ventana tarda un instante en tomar su medida: recién ahí vuelve lo normal.
    const arrived = () => Math.abs(window.innerWidth - spot.width) <= 1 && Math.abs(window.innerHeight - spot.height) <= 1;
    for (let tries = 0; tries < 16 && !arrived(); tries++) await pause(25);
    applying.current = false;
    updateSizing(null);
    if (!isTauri) setResizing(false);
  }, [cancelSizing, paintGhost, setPrefs, spotFor, updateSizing]);

  useEffect(() => {
    let timer = 0;
    const typing = () => {
      const focused = document.activeElement;
      return focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || (focused instanceof HTMLElement && focused.isContentEditable);
    };
    const onDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        if (event.repeat || shiftHeld.current) return;
        shiftHeld.current = true;
        // Escribiendo, Mayús es para las mayúsculas y para seleccionar: ahí no hay modo tamaño.
        if (event.ctrlKey || event.altKey || event.metaKey || typing() || document.querySelector('.backdrop') || now.current.sizing) return;
        timer = window.setTimeout(() => {
          if (shiftHeld.current && !now.current.sizing) updateSizing({ dx: 0, dy: 0, height: now.current.book.height, dragging: false });
        }, SIZING_DELAY);
        return;
      }
      // Otra tecla junto con Mayús: era un atajo, no el modo tamaño.
      window.clearTimeout(timer);
      const state = now.current.sizing;
      if (!state || applying.current) return;
      const untouched = !state.dragging && state.dx === 0 && state.dy === 0 && state.height === now.current.book.height;
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelSizing();
      } else if (untouched) {
        cancelSizing();
      }
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.key !== 'Shift') return;
      shiftHeld.current = false;
      window.clearTimeout(timer);
      const state = now.current.sizing;
      // Si todavía se está arrastrando, se aplica cuando se suelte el mouse.
      if (state && !state.dragging) void applySizing();
    };
    const onBlur = () => {
      shiftHeld.current = false;
      window.clearTimeout(timer);
      if (now.current.sizing && !applying.current) cancelSizing();
    };
    document.addEventListener('keydown', onDown);
    document.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onDown);
      document.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [applySizing, cancelSizing, updateSizing]);

  /** Se agarró un borde o una esquina: el fantasma sigue al mouse, con la proporción del cuaderno. */
  const startStretch = useCallback(
    (grip: Grip, event: ReactPointerEvent<HTMLElement>) => {
      const base = now.current.sizing;
      if (!base || applying.current || event.button !== 0) return;
      event.preventDefault();
      // Con el mouse capturado, los movimientos siguen llegando aunque salga de la ventana.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // sin captura igual sirve mientras el mouse no salga de la ventana
      }
      const like = now.current.shape;
      const pullX = grip.includes('e') ? 1 : grip.includes('w') ? -1 : 0;
      const pullY = grip.includes('s') ? 1 : grip.includes('n') ? -1 : 0;
      const origin = { x: event.screenX, y: event.screenY };
      const before = windowBox(boxForHeight(base.height, like), like.tabs);
      // El cartel se pone al día como mucho unas cuarenta veces por segundo.
      let refresh = 0;

      const onMove = (move: PointerEvent) => {
        const byWidth = heightForWidth((move.screenX - origin.x) * pullX, like);
        const byHeight = (move.screenY - origin.y) * pullY;
        // En una esquina manda el eje que más se movió.
        const change = pullX && pullY ? (Math.abs(byWidth) > Math.abs(byHeight) ? byWidth : byHeight) : pullX ? byWidth : byHeight;
        const height = snapHeight(base.height + change, like);
        const after = windowBox(boxForHeight(height, like), like.tabs);
        // El lado opuesto al que se arrastra no se mueve.
        const next: Sizing = {
          dx: base.dx + (pullX < 0 ? before.width - after.width : 0),
          dy: base.dy + (pullY < 0 ? before.height - after.height : 0),
          height,
          dragging: true,
        };
        now.current.sizing = next;
        paintGhost(spotFor(next, like));
        if (!refresh) {
          refresh = window.setTimeout(() => {
            refresh = 0;
            setSizing(now.current.sizing);
          }, 24);
        }
      };
      const onEnd = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        window.clearTimeout(refresh);
        const state = now.current.sizing;
        if (!state) return;
        updateSizing({ ...state, dragging: false });
        // Mayús ya se había soltado: no hay nada más que esperar.
        if (!shiftHeld.current) void applySizing();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
      updateSizing({ ...base, dragging: true });
    },
    [applySizing, paintGhost, spotFor, updateSizing],
  );

  // ---- atajos ---------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Las combinaciones salen de shortcuts.ts: las de fábrica o las que se eligieron en
      // Ajustes. Ctrl + Alt (AltGr, que escribe @, # y otros) nunca es un atajo.
      const action = which(event, WINDOW_ACTIONS);
      if (!action) return;
      const { prefs: current, book: size, shape: like } = now.current;
      if (action === 'search') setPanel('finder');
      else if (action === 'new') composeSheet();
      else if (action === 'settings') openSettings();
      else if (action === 'size-pocket' || action === 'size-standard' || action === 'size-full') {
        setPrefs({ size: SIZES.find((option) => action === `size-${option.size}`)!.size });
      } else if (action === 'bigger' || action === 'smaller') {
        const height = Math.max(MIN_HEIGHT, Math.min(size.height + (action === 'smaller' ? -SIZE_STEP : SIZE_STEP), maxHeight(like)));
        keepPlace.current = true;
        setPrefs({ size: sizeForHeight(height, like), height });
      } else if (action === 'text-bigger' || action === 'text-smaller') {
        // La letra recorre sus cuatro tamaños de a uno; en el primero o el último se queda.
        const at = TEXT_ORDER.indexOf(current.textSize) + (action === 'text-smaller' ? -1 : 1);
        const textSize = TEXT_ORDER[Math.max(0, Math.min(TEXT_ORDER.length - 1, at))];
        if (textSize !== current.textSize) setPrefs({ textSize });
      } else if (action === 'spread') setPrefs({ spread: current.spread === 'double' ? 'single' : 'double' });
      else api.window.hide();
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openSettings, composeSheet, setPrefs]);

  const filter = useMemo<ListFilter>(
    () => ({
      view: view.kind,
      categoryId: view.kind === 'category' ? view.id : undefined,
      query: debouncedQuery || undefined,
      until: until ?? undefined,
    }),
    [view, debouncedQuery, until],
  );

  const category = view.kind === 'category' ? overview?.categories.find((c) => c.id === view.id) : undefined;
  const total = view.kind === 'category' ? category?.count : overview ? overview.counts[view.kind] : undefined;
  const viewLabel = view.kind === 'category' ? (category?.name ?? t('Categoría')) : t(VIEW_LABEL[view.kind]);

  const tabs = useMemo<NotebookTab[] | null>(() => {
    if (!prefs.tabs) return null;
    const counts = overview?.counts;
    return [
      { key: 'all', view: { kind: 'all' }, label: t('Todas'), count: counts?.all ?? 0, color: 'var(--paper)', ink: 'var(--label)' },
      ...(overview?.categories ?? []).map<NotebookTab>((c) => ({
        key: `category-${c.id}`,
        view: { kind: 'category', id: c.id },
        label: c.name,
        count: c.count,
        color: c.color,
        ink: readableOn(c.color),
      })),
      { key: 'uncategorized', view: { kind: 'uncategorized' }, label: t('Sin categoría'), count: counts?.uncategorized ?? 0, color: '#8E8E93', ink: '#fff' },
      { key: 'secret', view: { kind: 'secret' }, label: t('Secret-book'), count: counts?.secret ?? 0, color: '#3A3A3C', ink: '#fff', icon: <Lock size={13} />, atEnd: true },
      { key: 'hidden', view: { kind: 'hidden' }, label: t('Papelera'), count: counts?.hidden ?? 0, color: '#AEAEB2', ink: '#1d1d1f', icon: <Trash2 size={13} />, atEnd: true },
    ];
  }, [prefs.tabs, overview, t]);

  // Lo que el cuaderno muestra de los filtros: qué está filtrando y cómo quitarlo.
  // La categoría ya se ve en la solapa activa; solo hace falta si las solapas están ocultas.
  const chips: FilterChip[] = [];
  if (view.kind !== 'all' && !prefs.tabs) chips.push({ label: viewLabel, onClear: () => setView({ kind: 'all' }) });
  if (debouncedQuery) chips.push({ label: `“${debouncedQuery}”`, onClear: () => setQuery('') });
  if (until !== null) chips.push({ label: t('Hasta el {date}', { date: dayHeading(until).subtitle }), onClear: () => setUntil(null) });

  const menuBefore: MenuItem[] = [
    {
      label: t('Doble hoja'),
      icon: <BookOpen size={14} />,
      hint: hintOf('spread'),
      checked: prefs.spread === 'double',
      onSelect: () => setPrefs({ spread: prefs.spread === 'double' ? 'single' : 'double' }),
    },
    {
      // Los tres tamaños a la vista: se elige uno sin pasar por los demás.
      label: t('Tamaño'),
      choices: SIZES.map(({ size, label, title }) => ({
        label: t(label),
        title: hintOf(`size-${size}`) ? `${t(title)} (${hintOf(`size-${size}`)})` : t(title),
        selected: prefs.size === size,
        onSelect: () => setPrefs({ size }),
      })),
    },
  ];
  const menuAfter: MenuItem[] = [
    { label: t('Ajustes'), icon: <Settings2 size={14} />, hint: hintOf('settings'), separator: true, onSelect: openSettings },
    { label: t('Cerrar Folio'), icon: <Power size={14} />, onSelect: quit },
  ];

  const actions = useMemo<NotebookActions>(
    () => ({
      onCompose: composeSheet,
      onSearch: () => setPanel('finder'),
      onHide: api.window.hide,
    }),
    [composeSheet],
  );
  const closePanel = useCallback(() => setPanel(null), []);

  const pending = sizing ? boxForHeight(sizing.height, shape) : null;
  const sizingChanged = sizing !== null && (sizing.dx !== 0 || sizing.dy !== 0 || sizing.height !== book.height);

  return (
    <div
      className={`app${isMac ? ' mac' : ''}${resizing ? ' resizing' : ''}${sizing ? ' sizing' : ''}${prefs.borderless ? ' borderless' : ''}`}
      data-tauri-drag-region
    >
      {prefs.borderless && (
        <div className="borderless-window-controls" data-tauri-drag-region="false">
          <button
            type="button"
            className="borderless-btn minimize"
            onClick={() => api.window.minimize()}
            aria-label={t('Minimizar')}
            title={t('Minimizar')}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            className="borderless-btn close"
            onClick={() => api.window.hide()}
            aria-label={t('Cerrar la ventana')}
            title={t('Cerrar la ventana: Folio sigue en la bandeja, junto al reloj')}
          >
            <X size={13} />
          </button>
        </div>
      )}
      <Notebook
        filter={filter}
        revision={revision}
        categories={overview?.categories ?? []}
        scanning={overview?.scan.running ?? true}
        spread={prefs.spread}
        textSize={prefs.textSize}
        book={book}
        closed={closed}
        onClosed={setClosed}
        name={prefs.name}
        onName={(name) => setPrefs({ name })}
        total={debouncedQuery || until !== null ? undefined : total}
        emptyTitle={debouncedQuery ? t('Sin resultados') : t(EMPTY[view.kind].title)}
        emptyHint={debouncedQuery ? t('Ninguna hoja contiene “{query}”.', { query: debouncedQuery }) : t(EMPTY[view.kind].hint)}
        coverNote={
          total === undefined
            ? viewLabel
            : view.kind === 'all'
              ? plural(total, 'hoja', 'hojas')
              : `${viewLabel}, ${plural(total, 'hoja', 'hojas')}`
        }
        coverStyle={prefs.coverStyle}
        menuBefore={menuBefore}
        menuAfter={menuAfter}
        chips={chips}
        tabs={tabs}
        view={view}
        onView={setView}
        actions={actions}
        compose={compose}
        notesDir={overview?.notesDir ?? ''}
        markdown={prefs.markdown}
        onStretch={startStretch}
        flush={flush}
      />

      {sizing && pending && (
        <div className="size-hud" role="status">
          <strong>{t(SIZE_NAME[sizeForHeight(pending.height, shape)])}</strong>
          <span className="size-hud-box">
            {pending.width} × {pending.height}
          </span>
          <span className="size-hud-hint">
            {sizing.dragging ? t('Soltá Mayús para aplicarlo') : sizingChanged ? t('Soltá Mayús para aplicarlo, Esc cancela') : t('Arrastrá un borde o una esquina')}
          </span>
        </div>
      )}

      <Presence show={panel === 'finder'}>
        {(leaving) => (
          <Finder
            overview={overview}
            filter={filter}
            view={view}
            query={query}
            until={until}
            onView={setView}
            onQuery={setQuery}
            onUntil={setUntil}
            leaving={leaving}
            onClose={closePanel}
          />
        )}
      </Presence>
      <Presence show={panel === 'settings'}>
        {(leaving) => (
          <SettingsSheet
            initialTab="look"
            overview={overview}
            revision={revision}
            prefs={prefs}
            onPrefs={setPrefs}
            leaving={leaving}
            onClose={closePanel}
            onTour={() => {
              setPanel(null);
              setTour((value) => value + 1);
            }}
          />
        )}
      </Presence>

      <Tutorial replay={tour} onOpenSettings={openSettings} />
    </div>
  );
}
