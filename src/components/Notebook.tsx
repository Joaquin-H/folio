import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEvent,
  type WheelEvent,
} from 'react';
import {
  ArrowLeft,
  Book,
  Check,
  ChevronDown,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Compass,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  FolderDown,
  History,
  Layers,
  LoaderCircle,
  Lock,
  Mic,
  NotebookPen,
  PenLine,
  Pin,
  PinOff,
  Quote,
  Search,
  Sparkles,
  SquarePen,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';
import { api, isConflict } from '../api';
import { count, dayHeading, extensionOf, plural, stemOf, timeOf, titleFromContent } from '../format';
import { useSheets, useSize } from '../hooks';
import { mark, useT } from '../i18n';
import { textVars, TEXT_STYLES, type Box, type Grip } from '../layout';
import { frontMatter, isMarkdownName, parseMarkdown } from '../markdown';
import { belongsToTarget, describe, hintOf, matches, useShortcuts, which } from '../shortcuts';
import { playKeySound, playSound } from '../sounds';
import type { Category, CoverStyle, ListFilter, SheetDetail, SheetSummary, Spread, TextSize, View } from '../types';
import { Cover, useFaces } from './Cover';
import { checkAt, linkAt, MarkdownBlocks, sourceOffset } from './Markdown';
import { SheetMapModal } from './SheetMapModal';
import { SheetBadges, SOURCE_ICON, sourceLabel, useSheetDetail, useSheetMenus } from './sheet';
import type { Face } from './stickers';
import { Menu, Presence, type MenuItem } from './ui';
import { Versions } from './Versions';
import {
  caretAnchor,
  caretFromPoint,
  DRAFT,
  getEditorCaret,
  offsetNear,
  placeCaret,
  placeCaretNear,
  readEditor,
  setEditorCaret,
  toEditor,
  useWriter,
  type Writer,
} from './writer';

type Side = 'left' | 'right' | 'only';
type Direction = 'next' | 'prev';

/** Márgenes de la hoja alrededor del área de escritura. */
const TOP = 34;
const FOOT = 34;
const PAD_RIGHT = 26;
const PAD_LEFT: Record<Spread, number> = { double: 62, single: 74 };
const RINGS = 17;
/**
 * Franjas de los bordes de afuera que pasan página con un clic: una parte del ancho de
 * la hoja, entre un mínimo y un máximo. La de la izquierda además no pasa del margen
 * (deja `gutter` píxeles antes del texto): el principio de cada renglón queda libre
 * para empezar a seleccionar desde ahí.
 */
const TURN_EDGE = { share: 0.12, min: 48, max: 96, gutter: 6 };
/**
 * Deslizar para pasar página: cuánto hay que arrastrar (`distance`) y cuántas veces más a
 * lo ancho que a lo alto (`slope`). Mientras tanto las hojas acompañan a la mano una
 * parte del recorrido (`follow`) hasta unos pocos píxeles (`reach`), y si no se llega a
 * pasar vuelven a su lugar en `back` milisegundos.
 */
const SWIPE = { distance: 55, slope: 2, follow: 0.15, reach: 6, back: 200 };
/** Lo que es de un control: ahí un clic o un doble clic no son para la hoja. */
const CONTROLS = 'button, a, input, label, .menu';
/** Al seleccionar arrastrando: espera en el borde antes de pasar de página y de nota. */
const PAGE_HOLD = 450;
const NOTE_HOLD = 950;
/** Duración de las salidas: lo que se va se desvanece antes de que entre lo nuevo. */
const TURN_OUT = 90;
const COVER_OUT = 160;
/** Con una flecha apretada, cada cuánto se pasa de página: lo justo para llegar a ver cada una. */
const HOLD_PACE = 280;
/** Rueda del mouse: cuánto hay que girarla para pasar una página y la pausa entre dos. */
const WHEEL_STEP = 60;
const WHEEL_PAUSE = 260;
const NOTICE_MS = 6000;
/** Una tarea recién marcada se ve así hasta que llega el archivo guardado; como mucho, este tiempo. */
const TICK_LIFE = 4000;
/** Fuentes que suenan a asistente de IA: su etiqueta lleva un ícono de chispas. */
const AI_SOURCE = /claude|codex|gemini|gpt|copilot|cursor|(ai|ia)/i;
const GRIPS: Grip[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

interface Geometry {
  perView: 1 | 2;
  pageWidth: number;
  padLeft: number;
  /** Ancho de la columna de texto de una hoja. */
  column: number;
  /** Espacio entre la columna de una hoja y la de la siguiente (sus dos márgenes). */
  gap: number;
  /** Alto de un renglón, según el tamaño de la letra: el texto y el rayado usan la misma medida. */
  line: number;
  /** Alto del área de escritura, siempre un número entero de renglones. */
  bodyHeight: number;
  /** Ancho de las franjas que pasan página: la de volver y la de avanzar. */
  turnBack: number;
  turnOn: number;
}

export interface FilterChip {
  label: string;
  onClear: () => void;
}

/** Solapa sobre el cuaderno: filtra las hojas por categoría. */
export interface NotebookTab {
  key: string;
  view: View;
  label: string;
  count: number;
  color: string;
  ink: string;
  icon?: ReactNode;
  colorOnly?: boolean;
  /** Va agrupada a la derecha (secret-book, papelera). */
  atEnd?: boolean;
}

/** Lo que el cuaderno le pide a la ventana. */
export interface NotebookActions {
  /** Deja el cuaderno listo para una hoja nueva (sin filtros que la escondan). */
  onCompose: () => void;
  onSearch: () => void;
  /** Cierra la ventana; Book sigue en la bandeja. */
  onHide: () => void;
}

const sameView = (a: View, b: View) => a.kind === b.kind && (a.kind !== 'category' || (b.kind === 'category' && a.id === b.id));

/** La hoja vive en la carpeta donde Book guarda lo que se escribe en él. */
function inFolder(path: string | null, folder: string): boolean {
  if (!path || !folder) return false;
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut > 0 && path.slice(0, cut).toLowerCase() === folder.toLowerCase();
}

/** Resumen de una hoja a partir de su detalle, con el texto completo como vista previa. */
function summaryOf(detail: SheetDetail): SheetSummary {
  const { content, versions: _versions, hash: _hash, ...summary } = detail;
  return { ...summary, preview: content };
}

function Tabs(props: { tabs: NotebookTab[]; view: View; onView: (view: View) => void }) {
  const t = useT();
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ x: number; scrollLeft: number } | null>(null);
  const isDraggingRef = useRef(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const container = tabsRef.current;
    if (!container) return;
    const isOverflow = container.scrollWidth > container.clientWidth;
    if (isOverflow) {
      dragStartRef.current = { x: e.clientX, scrollLeft: container.scrollLeft };
      isDraggingRef.current = false;
    } else if (!(e.target as Element).closest('button, a, input')) {
      api.window.drag();
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current || !tabsRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    if (Math.abs(dx) > 4) {
      isDraggingRef.current = true;
      tabsRef.current.scrollLeft = dragStartRef.current.scrollLeft - dx;
    }
  };

  const handlePointerUp = () => {
    dragStartRef.current = null;
    setTimeout(() => {
      isDraggingRef.current = false;
    }, 50);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const container = tabsRef.current;
    if (!container) return;
    if (container.scrollWidth > container.clientWidth) {
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      container.scrollLeft += delta;
    }
  };

  return (
    <div
      ref={tabsRef}
      className="tabs"
      role="tablist"
      aria-label={t('Filtrar el cuaderno por categoría')}
      data-tour="tabs"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
    >
      {props.tabs.map((tab) => {
        const active = sameView(tab.view, props.view);
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={t('Ver {label}', { label: tab.label })}
            title={`${tab.label}, ${plural(tab.count, 'hoja', 'hojas')}`}
            className={`tab${active ? ' active' : ''}${tab.atEnd ? ' at-end' : ''}${tab.icon ? ' icon-only' : ''}${tab.colorOnly ? ' color-only' : ''}`}
            style={{ background: tab.color, color: tab.ink }}
            // Volver a tocar la solapa activa quita el filtro.
            onClick={() => {
              if (isDraggingRef.current) return;
              props.onView(active && tab.view.kind !== 'all' ? { kind: 'all' } : tab.view);
            }}
          >
            {tab.icon ?? (tab.colorOnly ? null : <span className="tab-name">{tab.label}</span>)}
          </button>
        );
      })}
    </div>
  );
}

function Footer(props: { geometry: Geometry; left?: ReactNode; right?: ReactNode }) {
  const isSingle = props.geometry.perView === 1;
  return (
    <footer
      className="page-foot"
      style={{
        left: isSingle ? props.geometry.padLeft - 7 : props.geometry.padLeft,
        right: isSingle ? 8 : PAD_RIGHT,
      }}
    >
      <span className="page-foot-main">{props.left}</span>
      <span>{props.right}</span>
    </footer>
  );
}

function Chips(props: { chips: FilterChip[] }) {
  const t = useT();
  return (
    <>
      {props.chips.map((chip) => (
        <button key={chip.label} type="button" className="pill" onClick={chip.onClear} title={t('Quitar este filtro')}>
          {chip.label} <X size={11} />
        </button>
      ))}
    </>
  );
}

/**
 * Franjas que pasan página con un clic: la del borde izquierdo vuelve y la del derecho
 * avanza. Ocupan el alto del área de escritura (arriba y abajo quedan los botones) y van
 * por encima del texto, para que el cursor avise antes de hacer clic. El resto de la hoja
 * no pasa página: ahí un clic no hace nada y un doble clic entra a escribir.
 */
function TurnZones(props: { geometry: Geometry; canGoOn: boolean }) {
  const { geometry: g } = props;
  return (
    <>
      <div className="turn-zone prev" style={{ top: 0, bottom: 0, width: g.turnBack }} aria-hidden="true" data-tour="turn-prev" />
      {props.canGoOn && (
        <div className="turn-zone next" style={{ top: 0, bottom: 0, width: g.turnOn }} aria-hidden="true" data-tour="turn-next" />
      )}
    </>
  );
}

/** Controles sobre el papel: a la izquierda los del cuaderno, a la derecha los de las hojas. */
function PageButtons(props: {
  geometry: Geometry;
  menu: MenuItem[];
  actions: NotebookActions;
  onClose: () => void;
  onOpenMap?: () => void;
  banner?: ReactNode;
  allTabs?: NotebookTab[];
  view?: View;
  onView?: (view: View) => void;
  hideTabs?: boolean;
}) {
  const t = useT();
  const showMapButton = Boolean(props.onOpenMap && (props.geometry.perView === 2 || props.geometry.pageWidth >= 325));
  const isSingle = props.geometry.perView === 1;
  const newHint = hintOf('new');
  const searchHint = hintOf('search');
  const hideHint = hintOf('hide-window');

  const currentTab = useMemo(() => {
    if (!props.view || !props.allTabs) return undefined;
    return props.allTabs.find((tab) => sameView(tab.view, props.view!));
  }, [props.view, props.allTabs]);

  const activeLabel = currentTab?.label ?? t('Todas');
  const activeIcon = currentTab?.icon ? (
    currentTab.icon
  ) : currentTab?.color && currentTab.colorOnly ? (
    <span className="cat-selector-dot" style={{ background: currentTab.color }} />
  ) : (
    <Layers size={14} />
  );

  const categoryMenuItems = useMemo<MenuItem[]>(() => {
    if (!props.allTabs || !props.onView) return [];
    return props.allTabs.map((tab, idx, arr) => {
      const isFirstAtEnd = tab.atEnd && !arr[idx - 1]?.atEnd;
      const isSelected = props.view ? sameView(tab.view, props.view) : false;
      return {
        label: tab.label,
        icon: tab.icon ?? (tab.colorOnly ? <span className="dot" style={{ background: tab.color }} /> : <Layers size={14} />),
        badge: tab.count > 0 ? tab.count : undefined,
        checked: isSelected,
        separator: isFirstAtEnd,
        onSelect: () => props.onView?.(isSelected && tab.view.kind !== 'all' ? { kind: 'all' } : tab.view),
      };
    });
  }, [props.allTabs, props.view, props.onView]);

  const showCatLabel = Boolean(props.hideTabs && (props.geometry.perView === 2 || props.geometry.pageWidth >= 320));

  const controls = (
    <div className="page-controls" data-tour="controls">
      <button type="button" className="icon-button" onClick={props.onClose} aria-label={t('Cerrar el cuaderno')} title={t('Cerrar el cuaderno')}>
        <Book size={15} />
      </button>
      <button
        type="button"
        className="icon-button"
        onClick={props.actions.onHide}
        aria-label={t('Cerrar la ventana')}
        title={
          hideHint
            ? `${t('Cerrar la ventana: Folio sigue en la bandeja, junto al reloj')} (${hideHint})`
            : t('Cerrar la ventana: Folio sigue en la bandeja, junto al reloj')
        }
      >
        <X size={15} />
      </button>
    </div>
  );

  const onBarMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0 && !(e.target as Element).closest('button, input, textarea, a, [role="button"], [role="menuitem"], .menu-list')) {
      api.window.drag();
    }
  };

  const actions = (
    <div
      className="page-actions"
      data-tour="actions"
      data-tauri-drag-region
      onMouseDown={onBarMouseDown}
    >
      <button
        type="button"
        className="icon-button"
        data-tour="new"
        onClick={props.actions.onCompose}
        aria-label={t('Nueva hoja')}
        title={newHint ? `${t('Nueva hoja')} (${newHint})` : t('Nueva hoja')}
      >
        <SquarePen size={15} />
      </button>
      <button
        type="button"
        className="icon-button"
        data-tour="search"
        onClick={props.actions.onSearch}
        aria-label={t('Buscar y filtrar')}
        title={searchHint ? `${t('Buscar y filtrar')} (${searchHint})` : t('Buscar y filtrar')}
      >
        <Search size={15} />
      </button>
      {categoryMenuItems.length > 0 && (
        <Menu
          label={t('Cambiar categoría o vista')}
          heading={t('Categorías y vistas')}
          align="right"
          containerClassName="cat-dropdown"
          className={`cat-selector-btn${showCatLabel ? ' with-label' : ' icon-only icon-button'}`}
          items={categoryMenuItems}
          trigger={
            <>
              {activeIcon}
              {showCatLabel && (
                <>
                  <span className="cat-selector-name">{activeLabel}</span>
                  <ChevronDown size={11} className="cat-selector-arrow" />
                </>
              )}
            </>
          }
        />
      )}
      {showMapButton && (
        <button
          type="button"
          className="icon-button"
          onClick={props.onOpenMap}
          aria-label={t('Mapa del cuaderno (Ctrl + M)')}
          title={t('Mapa del cuaderno (Ctrl + M)')}
        >
          <Compass size={15} />
        </button>
      )}
      <span className="page-actions-sep" aria-hidden="true" />
      <Menu label={t('Menú')} className="icon-button" items={props.menu} trigger={<Ellipsis size={17} />} />
    </div>
  );

  const leftEdge = isSingle ? 20 : 8;

  if (isSingle) {
    return (
      <div
        className="page-bar single"
        style={{ left: leftEdge, right: 8 }}
        data-tauri-drag-region
        onMouseDown={onBarMouseDown}
      >
        {controls}
        {props.banner}
        {actions}
      </div>
    );
  }

  return (
    <>
      <div
        className="page-bar left"
        style={{
          left: leftEdge,
          width: props.geometry.pageWidth - leftEdge - 8,
        }}
        data-tauri-drag-region
        onMouseDown={onBarMouseDown}
      >
        {controls}
        {props.banner}
      </div>
      {actions}
    </>
  );
}

/** Hojas en las que ya se avisó, tras un doble clic, por qué no se pueden escribir. */
const explained = new Set<number>();

const STATUS_TEXT = {
  saved: mark('Guardado'),
  pending: mark('Guardando…'),
  saving: mark('Guardando…'),
  conflict: mark('Sin guardar'),
  error: mark('No se pudo guardar'),
};

/** Atajos que atiende el texto mientras se escribe en él. */
const EDITOR_ACTIONS = ['finish', 'save', 'preview', 'write-next', 'write-prev', 'indent'] as const;
/** Pasar de página y saltar a la primera o a la última, con el cuaderno cerrado o leyendo. */
const TURN_ACTIONS = ['next', 'prev', 'sheet-next', 'sheet-prev', 'first', 'last'] as const;
/** Guardar con el teclado desde cualquier parte de la hoja que se escribe. */
const SAVE_ACTIONS = ['finish', 'save'] as const;

/**
 * Una nota abierta en el cuaderno. El texto fluye en columnas del ancho de una hoja:
 * si no entra en una, sigue en la de al lado y después en las páginas siguientes.
 * Con `active` en falso queda fuera de la vista pero en el documento, para que una
 * selección que empezó en ella siga viva al pasar a la nota siguiente.
 *
 * Con doble clic en cualquier parte de la hoja (o con Enter, o desde el menú) pasa a
 * escribirse ahí mismo, con el cursor en el lugar del texto más cercano: el texto se
 * vuelve editable, las páginas se recalculan mientras se escribe y la vista sigue al cursor.
 *
 * Una hoja `.md` se lee con formato (si no se lo apagó en Ajustes) y se escribe en texto
 * plano: lo que se edita es el original. El doble clic sobre la hoja con formato busca el
 * lugar del original que corresponde a lo que se tocó (ver `Markdown.tsx`).
 */
function OpenSheet(props: {
  sheet: SheetSummary;
  active: boolean;
  categories: Category[];
  geometry: Geometry;
  page: number;
  pageCount: number;
  turn: { direction: Direction; tick: number };
  /** La página se está yendo: se desvanece antes de mostrar la siguiente. */
  fading: boolean;
  fontsReady: boolean;
  counter: string;
  chips: FilterChip[];
  writer: Writer;
  /** Carpeta de las hojas escritas en Book: esas pueden cambiar de título. */
  notesDir: string;
  /** Las hojas `.md` se leen con formato. */
  markdown: boolean;
  hideHeader?: boolean;
  centerTitle?: boolean;
  revision?: number;

  onPageTurn?: (delta: 1 | -1) => void;
  /** Salta de hoja entera. */
  onSheetTurn?: (delta: 1 | -1) => void;
  canGoPrevSheet?: boolean;
  canGoNextSheet?: boolean;
  /** La nota ocupa tantas páginas con ese alto de renglón (si el renglón cambió, la cuenta es otra). */
  onPages: (pages: number, line: number) => void;
  /** El cursor quedó en esa página de la nota: la vista tiene que mostrarla. */
  onCaretPage: (page: number) => void;
  /** Pasa de página sin salir de esta nota (mientras se la escribe). */
  onTurn: (delta: 1 | -1) => void;
  onDraftCategory?: (categoryId: number | null) => void;
  onNotice: (text: string) => void;
  onClose: () => void;
  /** Vuelve al cuaderno de siempre; solo en la papelera y en el secret-book. */
  onBack?: () => void;
  actions: NotebookActions;
  menuBefore: MenuItem[];
  menuAfter: MenuItem[];
  navItems?: MenuItem[];
  onOpenMap?: () => void;
  noteFormat?: 'txt' | 'md';
  onSavedNote?: (detail: SheetDetail) => void;
  allTabs?: NotebookTab[];
  view?: View;
  onView?: (view: View) => void;
  hideTabs?: boolean;
}) {
  const { sheet, active, categories, geometry: g, page, pageCount, onPages, onCaretPage, writer } = props;
  const t = useT();
  const dictationLabel = /Win/i.test(navigator.userAgent) ? t('Dictar con la voz (Win + H)') : t('Dictar con la voz');
  // Los menús y los botones muestran las combinaciones vigentes: si cambian, se redibujan.
  useShortcuts();
  const isDraft = sheet.id === DRAFT;
  const detail = useSheetDetail(sheet, !isDraft);
  const [showVersions, setShowVersions] = useState(false);
  const { categoryItems, secretItem, trashItem, actionItems, error, restore, togglePinned, tearOff, dialogs } = useSheetMenus(sheet, categories, isDraft ? props.onDraftCategory : undefined);
  const [head, headSize] = useSize<HTMLElement>();
  const flow = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLPreElement>(null);
  /** El texto a la vista mientras se lee: el bloque de texto plano o el de la hoja con formato. */
  const reader = useRef<HTMLElement | null>(null);
  const setReader = useCallback((node: HTMLElement | null) => {
    reader.current = node;
  }, []);
  /** Dónde poner el cursor al empezar a escribir. */
  const caretAt = useRef<number | 'end'>('end');

  const writing = writer.writing?.id === sheet.id ? writer.writing : null;
  const isWriting = writing !== null;
  // Lo recién escrito se muestra hasta que el cuaderno lo recibe de vuelta ya guardado.
  const recent = writer.recent?.id === sheet.id ? writer.recent : null;
  const settled = recent !== null && recent.hash !== undefined && detail?.hash === recent.hash;
  /** Tarea recién marcada con un clic: el texto con la marca, hasta que el cuaderno lo recibe guardado. */
  const [ticked, setTicked] = useState<{ text: string; hash?: string } | null>(null);
  const tickSettled = ticked !== null && ticked.hash !== undefined && detail?.hash === ticked.hash;
  const text = (ticked && !tickSettled ? ticked.text : null) ?? (recent && !settled ? recent.text : null) ?? detail?.content ?? sheet.preview;

  // Con formato: el encabezado YAML le da título, etiquetas y fuente a la hoja, y el cuerpo
  // se dibuja con su formato mientras se lee. Se vuelve a leer solo si cambia el texto.
  const markdown = props.markdown && isMarkdownName(sheet.title);
  const [livePreview, setLivePreview] = useState(false);
  const [previewText, setPreviewText] = useState('');

  useEffect(() => {
    if (!isWriting) setLivePreview(false);
  }, [isWriting]);

  const toggleLivePreview = useCallback(() => {
    setLivePreview((prev) => {
      const next = !prev;
      if (next) {
        const current = editor.current ? readEditor(editor.current) : (writer.text() || text);
        setPreviewText(current);
      } else {
        requestAnimationFrame(() => {
          if (editor.current) {
            editor.current.focus();
            placeCaret(editor.current, 'end');
          }
        });
      }
      return next;
    });
  }, [writer, text]);

  const doc = useMemo(() => {
    if (!markdown) return null;
    if (isWriting) return livePreview ? parseMarkdown(previewText) : null;
    return parseMarkdown(text);
  }, [markdown, isWriting, livePreview, previewText, text]);
  const front = useMemo(() => (markdown ? frontMatter(isWriting && livePreview ? previewText : text) : null), [markdown, isWriting, livePreview, previewText, text]);

  const category = categories.find((c) => c.id === sheet.categoryId);
  const heading = dayHeading(sheet.modifiedAt);
  const relative = heading.relative;
  const Icon = SOURCE_ICON[sheet.source];
  // Papelera y secret-book se distinguen a simple vista del resto del cuaderno.
  const mode = sheet.hidden ? 'trash' : sheet.secret ? 'secret' : '';
  // El encabezado ocupa renglones enteros para que el texto arranque sobre el rayado.
  const maxSpacer = Math.max(0, g.bodyHeight - g.line * 2);
  const spacer = Math.min(maxSpacer, Math.ceil(headSize.height / g.line) * g.line);

  /** Por qué esta hoja no se puede escribir desde Book, si es el caso. */
  const locked = sheet.hidden
    ? t('Esta hoja está en la papelera: recuperala para poder escribir en ella.')
    : sheet.source === 'notepad'
      ? t('Es una pestaña sin guardar del Bloc de notas: guardala en Folio para poder escribirla.')
      : sheet.source === 'sticky'
        ? t('Las Sticky Notes se escriben desde su propia aplicación.')
        : sheet.missing
          ? t('El archivo original ya no está, así que no hay dónde guardar los cambios.')
          : null;
  // Mientras se guarda una tarea marcada no se empieza a escribir: se partiría del texto de antes.
  const ready = detail !== null && recent === null && ticked === null;

  const { consumeRecent } = writer;
  useEffect(() => {
    if (settled) consumeRecent();
  }, [settled, consumeRecent]);

  // La tarea marcada ya llegó guardada (o se la esperó demasiado): se ve lo que hay.
  useEffect(() => {
    if (!ticked?.hash) return;
    if (tickSettled) return setTicked(null);
    const timer = window.setTimeout(() => setTicked((current) => (current === ticked ? null : current)), TICK_LIFE);
    return () => window.clearTimeout(timer);
  }, [ticked, tickSettled]);

  const measure = useCallback(() => {
    const node = flow.current;
    if (!node || g.column <= 0) return;
    onPages(Math.max(1, Math.round((node.scrollWidth + g.gap) / (g.column + g.gap))), g.line);
  }, [g.column, g.gap, g.line, onPages]);

  /**
   * Lleva la vista a la página donde está el cursor. Su renglón sale de contar: el del
   * último carácter visible que tiene antes, más los saltos de línea que los separan.
   */
  const followCaret = useCallback(() => {
    const node = editor.current;
    const origin = flow.current?.getBoundingClientRect();
    const anchor = node && caretAnchor(node);
    if (!anchor || !origin || g.pageWidth <= 0 || g.column <= 0) return;
    const perPage = g.bodyHeight / g.line;
    // Las hojas pueden estar a mitad de una animación que las achica apenas: las
    // distancias en pantalla se llevan a la medida real antes de contar.
    const scale = origin.width / g.column || 1;
    const lines = anchor.rect
      ? Math.floor(((anchor.rect.left - origin.left) / scale + 2) / g.pageWidth) * perPage +
        Math.floor(((anchor.rect.top - origin.top) / scale + 2) / g.line)
      : spacer / g.line;
    onCaretPage(Math.max(0, Math.floor((lines + anchor.breaks) / perPage)));
  }, [g.pageWidth, g.column, g.bodyHeight, g.line, spacer, onCaretPage]);

  // Al empezar a escribir, el editor recibe el texto y el cursor; después manda él.
  const { attach, text: currentText, syncExternal } = writer;
  useLayoutEffect(() => {
    const node = editor.current;
    if (!isWriting || !node) return;
    node.textContent = toEditor(currentText());
    attach(() => readEditor(node));
    placeCaret(node, caretAt.current);
    caretAt.current = 'end';
    return () => attach(null);
  }, [isWriting, attach, currentText]);

  useEffect(() => {
    if (!detail || detail.id !== sheet.id) return;
    if (!isWriting) {
      syncExternal(sheet.id, detail.content, detail.hash ?? undefined);
    }
  }, [detail, sheet.id, isWriting, syncExternal]);

  // Si llega un recorte a esta hoja mientras se está editando, se agrega al final sin perder
  // lo que se escribió ni el cursor ni el foco.
  useEffect(() => {
    if (!isWriting) return;
    const stopClip = api.onClippingSaved(async (payload) => {
      if (!payload.sheetId || payload.sheetId !== sheet.id) return;
      try {
        const fresh = await api.getSheet(sheet.id);
        if (!fresh) return;
        const node = editor.current;
        if (!node) return;
        const currentVal = readEditor(node);
        const saved = writer.getSavedText(sheet.id) ?? '';
        let added = '';
        if (saved && fresh.content.startsWith(saved)) {
          added = fresh.content.slice(saved.length);
        } else {
          const linesFresh = fresh.content.split('\n');
          const linesSaved = saved.split('\n');
          if (linesFresh.length > linesSaved.length) {
            added = '\n' + linesFresh.slice(linesSaved.length).join('\n');
          } else {
            added = '\n\n' + fresh.content;
          }
        }
        if (!added.trim()) return;

        const caret = getEditorCaret(node);
        const hasFocus = document.activeElement === node;
        const cleanAdded = added.replace(/^\n+/, '');
        const updated = currentVal.trim()
          ? `${currentVal.replace(/\n+$/, '')}\n\n${cleanAdded}`
          : cleanAdded;

        node.textContent = toEditor(updated);
        writer.appendExternal(sheet.id, updated, fresh.content, fresh.hash ?? undefined);

        if (caret !== null) {
          setEditorCaret(node, caret);
        } else if (hasFocus) {
          node.focus({ preventScroll: true });
        }
      } catch (err) {
        console.error('Error handling clipping during edit:', err);
      }
    });
    return stopClip;
  }, [isWriting, sheet.id, writer]);

  useLayoutEffect(() => {
    if (active) measure();
  }, [active, text, isWriting, doc, livePreview, spacer, g.bodyHeight, g.line, props.fontsReady, measure]);

  // Una letra que llega después (la itálica, que se descarga recién cuando una hoja la usa)
  // puede mover los renglones: se vuelven a contar las páginas.
  useEffect(() => {
    if (!active) return;
    document.fonts.addEventListener('loadingdone', measure);
    return () => document.fonts.removeEventListener('loadingdone', measure);
  }, [active, measure]);

  useEffect(() => {
    if (!isWriting) return;
    const frame = requestAnimationFrame(followCaret);
    document.addEventListener('selectionchange', followCaret);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', followCaret);
    };
  }, [isWriting, followCaret]);

  const { onNotice, onSavedNote } = props;
  const saveNotepadToFolio = useCallback(async () => {
    try {
      const rawTitle = stemOf(sheet.title);
      const content = text || '';
      const created = await api.createNote(rawTitle, content, sheet.categoryId ?? undefined);
      onNotice(t('Hoja guardada en Folio'));
      onSavedNote?.(created);
    } catch (err) {
      onNotice(t('No se pudo guardar en Folio: {reason}', { reason: String(err) }));
    }
  }, [sheet.title, sheet.categoryId, text, onNotice, onSavedNote, t]);

  const startWriting = useCallback(
    (at: number | 'end', asked = true) => {
      // La hoja se está yendo (se acaba de pedir pasar página): no se empieza a escribir
      // en algo que deja de estar a la vista.
      if (props.fading) return;
      if (locked) {
        // El doble clic sobre el texto también sirve para seleccionar una palabra: ahí se
        // explica una sola vez.
        if (asked || !explained.has(sheet.id)) props.onNotice(locked);
        explained.add(sheet.id);
        return;
      }
      if (!detail || !ready || isWriting) return;
      caretAt.current = at;
      writer.begin({
        id: detail.id,
        title: stemOf(detail.title),
        text: detail.content,
        hash: detail.hash,
        renamable: detail.source === 'file' && inFolder(detail.path, props.notesDir),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.fading, locked, sheet.id, detail, ready, isWriting, writer.begin, props.notesDir, props.onNotice],
  );

  // Enter entra a escribir (y F2, el atajo de siempre para "editar esto"); Esc sale.
  // Ctrl+T (o el atajo elegido para 'tear-off') arranca la hoja en su propia ventana flotante.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('.backdrop')) return;
      if (!isDraft && matches(event, 'tear-off')) {
        event.preventDefault();
        void (isWriting ? writer.finish() : Promise.resolve()).then(() => tearOff());
        return;
      }
      // Enter sobre un botón o un campo es de ese control, no de la hoja.
      if (isWriting || !matches(event, 'write') || belongsToTarget(event)) return;
      event.preventDefault();
      if (sheet.source === 'notepad') {
        void saveNotepadToFolio();
        return;
      }
      startWriting('end');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, isDraft, isWriting, writer, tearOff, startWriting, sheet.source, saveNotepadToFolio]);

  const onReadDoubleClick = (event: MouseEvent<HTMLPreElement>) => {
    // El cursor queda al final de la palabra que se tocó, sin seleccionarla: así lo
    // primero que se escriba no reemplaza nada.
    const selection = getSelection();
    const node = event.currentTarget.firstChild;
    if (!selection || !node || selection.focusNode !== node || selection.anchorNode !== node) return startWriting('end', false);
    const from = Math.min(selection.anchorOffset, selection.focusOffset);
    const to = Math.max(selection.anchorOffset, selection.focusOffset);
    // Si el doble clic cayó en un blanco (después del final de un renglón, en un renglón
    // vacío) no hay palabra: el cursor va ahí mismo, no al principio de lo que sigue.
    const onWord = (node.textContent ?? '').slice(from, to).trim() !== '';
    startWriting(onWord ? to : from, false);
  };

  /** Posición del original para un lugar de la hoja con formato (ver `sourceOffset`). */
  const toSource = useCallback(
    (node: Node, offset: number) => (reader.current && doc ? sourceOffset(reader.current, doc, node, offset) : null),
    [doc],
  );

  /**
   * Doble clic sobre la hoja con formato. Sobre una palabra, como en el texto plano, el
   * cursor queda donde termina lo que eligió el navegador (la palabra; en Windows, con el
   * espacio que la sigue). En un blanco (a la derecha de un renglón, en un renglón vacío)
   * va al lugar del original más cercano al punto; donde el dibujo no es el texto tal cual
   * (una viñeta, un separador), al principio de su renglón.
   */
  const onMarkdownDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest(CONTROLS)) return;
    const { clientX: x, clientY: y } = event;
    let at: number | null = null;
    const selection = getSelection();
    const word = selection?.toString().trimEnd() ?? '';
    if (selection && selection.rangeCount && word.trim() !== '') {
      // La palabra que eligió el navegador tiene que estar bajo el puntero: en un renglón
      // vacío, el doble clic puede elegir una de otro renglón.
      const range = selection.getRangeAt(0);
      const box = range.getBoundingClientRect();
      const under = x >= box.left - 4 && x <= box.right + 4 && y >= box.top - 4 && y <= box.bottom + 4;
      const start = range.startContainer;
      // El cursor va al final de la palabra, sin el espacio que el navegador elige con ella
      // (y que puede estar en el trozo siguiente, después de un `**` del original).
      if (under && start.nodeType === Node.TEXT_NODE && (start as Text).data.startsWith(word, range.startOffset)) {
        at = toSource(start, range.startOffset + word.length);
      } else if (under) {
        at = toSource(range.endContainer, range.endOffset);
      }
    }
    if (at === null) {
      const hit = caretFromPoint(x, y);
      at = hit ? toSource(hit.node, hit.offset) : null;
    }
    startWriting(at ?? toSource(event.target as Node, 0) ?? 'end', false);
  };

  /** Abre un enlace afuera; si no se puede, lo dice. */
  const openLink = useCallback(
    (href: string) => void api.openLink(href).catch((reason) => onNotice(t('No se pudo abrir el enlace: {reason}', { reason: String(reason) }))),
    [onNotice, t],
  );

  /**
   * Marca o desmarca una tarea (`- [ ]`) en el archivo, con el mismo control que al
   * escribir: si el original cambió por fuera, no se pisa. Los clics seguidos se guardan
   * de a uno y en orden, cada uno sobre el resultado del anterior.
   */
  const tasks = useRef({ queue: Promise.resolve(), busy: 0, failed: false, text, hash: undefined as string | undefined });
  if (tasks.current.busy === 0) {
    tasks.current.text = text;
    tasks.current.hash = ticked && !tickSettled ? ticked.hash : detail?.hash;
  }
  const toggleTask = (at: number) => {
    if (locked) return props.onNotice(locked);
    if (!detail || recent !== null || isWriting) return;
    const state = tasks.current;
    state.busy++;
    state.queue = state.queue.then(async () => {
      try {
        const before = state.text;
        const mark = before[at];
        if (state.failed || (mark !== ' ' && mark !== 'x' && mark !== 'X')) return;
        const after = `${before.slice(0, at)}${mark === ' ' ? 'x' : ' '}${before.slice(at + 1)}`;
        state.text = after;
        setTicked({ text: after });
        try {
          const saved = await api.saveSheet(sheet.id, after, { baseHash: state.hash });
          state.hash = saved.hash;
          setTicked((current) => (current?.text === after ? { text: after, hash: saved.hash } : current));
        } catch (reason) {
          state.failed = true;
          setTicked(null);
          props.onNotice(
            isConflict(reason)
              ? t('El archivo cambió fuera de Folio: la tarea no se marcó. Ya se ve lo que tiene ahora.')
              : t('No se pudo marcar la tarea: {reason}', { reason: String(reason) }),
          );
        }
      } finally {
        if (--state.busy === 0) state.failed = false;
      }
    });
  };

  /** Clics en la hoja con formato: las casillas de tareas y los enlaces. */
  const onMarkdownClick = (event: MouseEvent<HTMLElement>) => {
    const box = checkAt(event.target);
    if (box) {
      event.preventDefault();
      if (box.enabled) toggleTask(box.at);
      else if (locked) props.onNotice(locked);
      return;
    }
    const href = linkAt(event.target);
    // Si se estaba seleccionando texto, el clic que termina la selección no abre nada.
    if (href && (getSelection()?.isCollapsed ?? true)) {
      event.preventDefault();
      openLink(href);
    }
  };

  // Un clic en una casilla o en un enlace no les deja el foco: así Enter sigue siendo
  // «escribir en esta hoja» y no vuelve a marcar la casilla ni a abrir el enlace.
  const onMarkdownMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (event.button === 0 && (checkAt(event.target) || linkAt(event.target))) event.preventDefault();
  };

  const onMarkdownKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    const href = event.key === 'Enter' ? linkAt(event.target) : null;
    if (!href) return;
    event.preventDefault();
    openLink(href);
  };

  /**
   * Doble clic en el papel, fuera del texto (un margen, el encabezado, el pie, el blanco
   * que queda debajo): también entra a escribir, con el cursor en el lugar del texto más
   * cercano. `currentTarget` es la hoja donde cayó, así que el área de texto sale de ella.
   */
  const onPaperDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest(CONTROLS)) return;
    const paper = event.currentTarget.getBoundingClientRect();
    const left = paper.left + g.padLeft;
    const top = paper.top + TOP;
    const area = { left, right: left + g.column, top, bottom: top + g.bodyHeight };
    const at = reader.current ? offsetNear(reader.current, event.clientX, event.clientY, area, doc ? toSource : undefined) : 'end';
    // En el título, como en el texto, el doble clic también selecciona una palabra.
    startWriting(at, !target.closest('.page-title'));
  };

  const onInput = () => {
    writer.touched();
    measure();
    followCaret();
  };

  const onEditorKey = (event: ReactKeyboardEvent) => {
    playKeySound(event);
    const action = which(event.nativeEvent, EDITOR_ACTIONS);
    if (!action) return;
    event.preventDefault();
    if (action === 'finish') void writer.finish();
    else if (action === 'save') void writer.flush();
    else if (action === 'preview') {
      if (markdown) toggleLivePreview();
    } else if (action === 'indent') document.execCommand('insertText', false, '\t');
    else props.onTurn(action === 'write-next' ? 1 : -1);
  };

  useEffect(() => {
    if (!active || !isWriting) return;
    const onKey = (event: KeyboardEvent) => {
      const isCtrlP = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p';
      if (isCtrlP || matches(event, 'preview')) {
        event.preventDefault();
        event.stopPropagation();
        if (markdown) toggleLivePreview();
        return;
      }
      if (livePreview) {
        if (document.querySelector('.backdrop') || belongsToTarget(event)) return;
        const action = which(event, ['finish', 'save']);
        if (action === 'finish') {
          event.preventDefault();
          void writer.finish();
        } else if (action === 'save') {
          event.preventDefault();
          void writer.flush();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          toggleLivePreview();
        }
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [active, isWriting, livePreview, markdown, toggleLivePreview, writer]);

  // El navegador corre el contenido para dejar el cursor a la vista: acá la vista se
  // mueve por páginas, así que se deshace ese corrimiento y se va a la página del cursor.
  const onClipScroll = (event: UIEvent<HTMLDivElement>) => {
    const clip = event.currentTarget;
    if (clip.scrollLeft === 0 && clip.scrollTop === 0) return;
    clip.scrollLeft = 0;
    clip.scrollTop = 0;
    if (isWriting) followCaret();
  };

  const sides: Side[] = g.perView === 2 ? ['left', 'right'] : ['only'];
  const sheetColor = category?.color;
  const finishHint = hintOf('finish');
  const saveHint = hintOf('save');
  const tearHint = hintOf('tear-off');
  const writeItem: MenuItem = isWriting
    ? { label: t('Guardar y terminar de escribir'), icon: <Check size={14} />, hint: finishHint, onSelect: () => void writer.finish() }
    : sheet.source === 'notepad'
      ? {
          label: t('Guardar en Folio para editar'),
          icon: <FolderDown size={14} />,
          hint: hintOf('write'),
          onSelect: () => void saveNotepadToFolio(),
        }
      : { label: t('Escribir en esta hoja'), icon: <PenLine size={14} />, hint: hintOf('write'), onSelect: () => startWriting('end') };

  const secondaryItems: MenuItem[] = [
    ...(props.navItems ?? []),
    writeItem,
    ...actionItems,
  ];

  const sheetMenu: MenuItem[] = isDraft
    ? [
        ...props.menuBefore,
        writeItem,
        ...(props.navItems && props.navItems.length > 0
          ? [
              {
                type: 'collapsible' as const,
                label: t('Más opciones…'),
                expandedLabel: t('Menos opciones…'),
                separator: true,
                items: props.navItems,
              },
            ]
          : []),
        ...props.menuAfter,
      ]
    : [
        ...props.menuBefore,
        secretItem,
        trashItem,
        {
          type: 'collapsible' as const,
          label: t('Más opciones…'),
          expandedLabel: t('Menos opciones…'),
          separator: true,
          items: secondaryItems,
        },
        ...props.menuAfter,
      ];

  const draftUnsaved = isDraft && writing?.status === 'saved';
  // Dentro de la nota, las flechas del modo escritura pasan de página sin salir de ella.
  const canTurnBack = page > 0;
  const canTurnOn = page + g.perView < pageCount;
  // Con un cuaderno chico el espacio para el cartel es angosto: el cartel dice lo mismo con menos palabras.
  const leftControlsRight = (g.perView === 1 ? 38 : 8) + 64 + 8;
  const showCatLabel = Boolean(props.hideTabs && (g.perView === 2 || g.pageWidth >= 320));
  const catWidth = props.allTabs && props.allTabs.length > 0 ? (showCatLabel ? 86 : 32) : 0;
  const rightActionsWidth = (g.perView === 1 ? (g.pageWidth >= 325 ? 136 : 104) + catWidth + 8 : 8);
  const availableRoom = g.pageWidth - leftControlsRight - rightActionsWidth;
  const snug = availableRoom < 340;
  const tight = availableRoom < 250;
  const narrow = availableRoom < 170;
  const ultraNarrow = availableRoom < 120;

  const banner =
    writing && writing.status !== 'conflict' ? (
      <div
        className={`page-mode edit-banner ${writing.isNew ? 'new' : 'write'}`}
        title={writing.isNew ? t('Hoja nueva') : t('Escribiendo')}
        aria-label={writing.isNew ? t('Hoja nueva') : t('Escribiendo')}
      >
        {writing.isNew ? <SquarePen size={12} /> : <PenLine size={12} />}
        <span className={narrow ? 'banner-text sr-only' : 'banner-text'}>
          {writing.isNew ? t('Hoja nueva') : t('Escribiendo')}
        </span>
        {markdown && (
          <button
            type="button"
            className={`banner-tool preview-btn${livePreview ? ' active' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleLivePreview}
            aria-label={livePreview ? t('Volver a escribir (Ctrl + P)') : t('Previsualizar (Ctrl + P)')}
            title={livePreview ? t('Volver a escribir (Ctrl + P)') : t('Previsualizar (Ctrl + P)')}
          >
            {livePreview ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
        <button
          type="button"
          className="banner-tool dict-btn"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (livePreview) setLivePreview(false);
            editor.current?.focus();
            void api.startDictation().catch(() => {});
          }}
          aria-label={dictationLabel}
          title={dictationLabel}
        >
          <Mic size={13} />
        </button>
        {/* El atajo va escrito en el botón: si no se ve, no se descubre. */}
        <button
          type="button"
          onClick={() => void writer.finish()}
          aria-label={t('Guardar y terminar de escribir')}
          title={
            finishHint && saveHint
              ? t('Guardar y terminar de escribir ({finish}). Con {save} se guarda y se sigue escribiendo.', { finish: describe('finish'), save: saveHint })
              : finishHint
                ? t('Guardar y terminar de escribir ({finish}).', { finish: describe('finish') })
                : saveHint
                  ? t('Guardar y terminar de escribir. Con {save} se guarda y se sigue escribiendo.', { save: saveHint })
                  : t('Guardar y terminar de escribir.')
          }
        >
          {ultraNarrow ? <Check size={12} /> : t('Listo')}
          {!tight && finishHint && <kbd>{finishHint}</kbd>}
        </button>
      </div>
    ) : mode && !writing ? (
      <div className={`page-mode ${mode}`}>
        {mode === 'trash' ? <Trash2 size={12} /> : <Lock size={12} />}
        <span className={narrow ? 'banner-text sr-only' : 'banner-text'}>
          {mode === 'trash' ? (tight ? t('Papelera') : t('En la papelera')) : t('Secret-book')}
        </span>
        {mode === 'trash' && (
          <button type="button" onClick={restore} aria-label={t('Recuperar')} title={t('Sacar esta hoja de la papelera')}>
            {tight ? <Undo2 size={12} /> : t('Recuperar')}
          </button>
        )}
        {props.onBack && (
          <button
            type="button"
            onClick={props.onBack}
            aria-label={t('Volver al cuaderno')}
            title={hintOf('back') ? t('Volver a todas las hojas ({hint})', { hint: hintOf('back') }) : t('Volver a todas las hojas')}
          >
            <ArrowLeft size={12} />
            {tight ? null : snug && mode === 'trash' ? t('Volver') : t('Volver al cuaderno')}
          </button>
        )}
      </div>
    ) : writing?.status === 'conflict' ? (
      <div className="page-mode conflict" role="alert">
        <TriangleAlert size={12} />
        <span className={narrow ? 'banner-text sr-only' : 'banner-text'}>
          {snug ? t('Cambió afuera') : t('El archivo cambió fuera de Folio')}
        </span>
        <button type="button" onClick={() => writer.resolve('mine')} title={t('Guardar lo que escribiste: lo de afuera queda como versión anterior')}>
          {tight ? t('Lo mío') : t('Guardar lo mío')}
        </button>
        <button
          type="button"
          onClick={() => writer.resolve('theirs')}
          title={t('Dejar el archivo como quedó afuera: lo que escribiste pasa a una hoja nueva, no se pierde')}
        >
          {tight ? t('El de afuera') : t('Quedarme con el de afuera')}
        </button>
      </div>
    ) : null;

  const isCompactHeader = g.pageWidth < 430;
  const isCompactActions = g.pageWidth < 460 || isCompactHeader;
  const sourceText = isDraft ? t('Hoja nueva') : sourceLabel(sheet);
  const versionText = plural(sheet.versionCount, 'versión anterior', 'versiones anteriores');
  const dateText = relative ? `${heading.title}, ${heading.subtitle}` : `${heading.title} ${heading.subtitle}`;

  return (
    <>
      {active &&
        sides.map((side, index) => (
          <div
            className={`page ${side} ${mode}${sheetColor ? ' categorized' : ''}${writing ? (writing.isNew ? ' writing new' : ' writing') : ''}`}
            key={`page-${index}`}
            style={sheetColor ? ({ '--sheet-cat-color': sheetColor } as CSSProperties) : undefined}
            onDoubleClick={isWriting ? undefined : onPaperDoubleClick}
          >
            {isWriting && <div className="write-bar" />}
            <div className="page-lines" style={{ top: TOP, height: g.bodyHeight }} />
            {index === 0 && !props.hideHeader && (
              <header
                ref={head}
                className={`page-head page-header${props.fading ? ' fading' : ''}${props.centerTitle ? ' centered-title' : ''}${isCompactHeader ? ' compact' : ''}`}
                style={{
                  top: TOP,
                  paddingLeft: g.padLeft,
                  paddingRight: PAD_RIGHT,
                  visibility: page === 0 ? 'visible' : 'hidden',
                }}
              >
                {/* Línea 1: Título (protagonista, editable al hacer clic) */}
                <div className="page-title-row">
                  {writing && writing.title !== null ? (
                    <label className="page-title editable" title={t('Cambiar el título de la hoja')}>
                      <input
                        value={writing.title}
                        maxLength={80}
                        spellCheck={false}
                        aria-label={t('Título de la hoja')}
                        placeholder={titleFromContent(text) || t('Sin título')}
                        onChange={(event) => writer.rename(event.target.value)}
                        onKeyDown={(event) => {
                          // Los atajos de guardar valen igual acá que en el texto.
                          const action = which(event.nativeEvent, ['finish', 'save']);
                          if (action === 'finish') {
                            event.preventDefault();
                            void writer.finish();
                          } else if (action === 'save') {
                            event.preventDefault();
                            void writer.flush();
                          } else if (event.key === 'Enter' && editor.current) {
                            placeCaret(editor.current, 'end');
                          }
                        }}
                      />
                      <span>{extensionOf(sheet.title) || (props.noteFormat === 'md' ? '.md' : '.txt')}</span>
                    </label>
                  ) : (
                    // Con encabezado, el título es el de la nota; el nombre del archivo queda a mano.
                    <h2
                      className="page-title"
                      title={front?.title ? sheet.title : t('Cambiar el título de la hoja')}
                      onClick={isWriting ? undefined : () => startWriting(0, true)}
                    >
                      {front?.title || sheet.title}
                    </h2>
                  )}
                </div>

                {/* Línea 2: Fecha · Guardado · Etiquetas */}
                <div className="page-date page-meta-row" data-tauri-drag-region>
                  <div className="page-meta" data-tauri-drag-region>
                    <span className="page-date-main meta-item" data-tauri-drag-region title={`${dateText} ${timeOf(sheet.modifiedAt)}`}>
                      <span data-tauri-drag-region>{dateText}</span>
                      <time data-tauri-drag-region dateTime={new Date(sheet.modifiedAt).toISOString()}>{timeOf(sheet.modifiedAt)}</time>
                    </span>
                    <span className="meta-sep" aria-hidden="true">·</span>
                    <span className="page-source meta-item" title={sourceText}>
                      <Icon size={12} />
                      <span className="meta-text">{sourceText}</span>
                    </span>
                    {front?.source && (
                      <>
                        <span className="meta-sep" aria-hidden="true">·</span>
                        <span className="page-tag source meta-item" title={t('Fuente: {source}', { source: front.source })}>
                          {AI_SOURCE.test(front.source) ? <Sparkles size={11} /> : <Quote size={11} />}
                          <span className="meta-text">{front.source}</span>
                        </span>
                      </>
                    )}
                    {front?.tags.map((tag) => (
                      <span key={tag} className="meta-tag-wrap" style={{ display: 'inline-flex', alignItems: 'center' }}>
                        <span className="meta-sep" aria-hidden="true">·</span>
                        <span className="page-tag tag meta-item" title={t('Etiqueta: {tag}', { tag })}>
                          <span className="meta-text">{tag}</span>
                        </span>
                      </span>
                    ))}
                    <SheetBadges sheet={sheet} />
                  </div>
                </div>

                {/* Línea 3: Acciones (Categoría, Fijar, Arrancar, Versiones) */}
                <div className={`page-actions-row${isCompactActions ? ' compact icon-only' : ''}`}>
                  <Menu
                    label={t('Cambiar la categoría de esta hoja')}
                    heading={t('Categoría de esta hoja')}
                    align="left"
                    anchorClassName="cat-picker"
                    popoverClassName="cat-pop"
                    className={`chip meta-btn category-chip${category ? '' : ' unset'}`}
                    items={categoryItems}
                    trigger={
                      <span title={category ? category.name : t('Sin categoría')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {category ? (
                          <span className="dot" style={{ background: category.color }} />
                        ) : (
                          <span className="dot unset-dot" />
                        )}
                        <span className="meta-text">{category ? category.name : t('Sin categoría')}</span>
                        <ChevronDown size={11} className="cat-arrow" style={{ opacity: 0.6 }} />
                      </span>
                    }
                  />
                  {sheet.source === 'notepad' && (
                    <button
                      type="button"
                      className="chip meta-btn action-chip"
                      onClick={() => void saveNotepadToFolio()}
                      title={t('Guardar esta nota en Folio para poder escribirla')}
                      aria-label={t('Guardar en Folio')}
                    >
                      <FolderDown size={12} />
                      <span className="meta-text">{t('Guardar en Folio')}</span>
                    </button>
                  )}
                  {!isDraft && (
                    <>
                      <button
                        type="button"
                        className={`chip meta-btn pin-btn${sheet.pinned ? ' active' : ''}`}
                        onClick={togglePinned}
                        aria-label={sheet.pinned ? t('Desfijar esta hoja') : t('Fijar esta hoja')}
                        title={sheet.pinned ? t('Desfijar esta hoja') : t('Fijar esta hoja')}
                      >
                        {sheet.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                        <span className="meta-text">{sheet.pinned ? t('Fijada') : t('Fijar')}</span>
                      </button>
                      <button
                        type="button"
                        className="chip meta-btn tear-btn"
                        onClick={() => void (isWriting ? writer.finish() : Promise.resolve()).then(() => tearOff())}
                        aria-label={t('Arrancar hoja')}
                        title={tearHint ? `${t('Arrancar hoja')} (${tearHint})` : t('Arrancar hoja')}
                      >
                        <ExternalLink size={12} />
                        <span className="meta-text">{t('Arrancar')}</span>
                      </button>
                    </>
                  )}
                  {sheet.versionCount > 0 && (
                    <button
                      type="button"
                      className="chip meta-btn versions-btn"
                      onClick={() => setShowVersions(true)}
                      title={versionText}
                      aria-label={versionText}
                    >
                      <History size={12} />
                      <span className="meta-text">{versionText}</span>
                    </button>
                  )}
                </div>
                {error && <p className="page-error">{error}</p>}
              </header>
            )}
            <Footer
              geometry={g}
              left={
                index === 0 && (
                  <>
                    <div className="sheet-nav-group">
                      <button
                        type="button"
                        className="nav-btn prev-sheet"
                        onClick={() => props.onSheetTurn?.(-1)}
                        disabled={!props.canGoPrevSheet}
                        aria-label={t('Hoja anterior')}
                        title={hintOf('sheet-prev') ? t('Hoja anterior ({hint})', { hint: hintOf('sheet-prev') }) : t('Hoja anterior')}
                      >
                        <ChevronsLeft size={13} />
                      </button>
                      {props.onOpenMap ? (
                        <button
                          type="button"
                          className="counter-btn sheet-indicator-badge"
                          onClick={props.onOpenMap}
                          aria-label={t('Mapa del cuaderno (Ctrl + M)')}
                          title={t('Mapa del cuaderno (Ctrl + M)')}
                        >
                          <span className="sheet-indicator-accent" aria-hidden="true" />
                          <span className="sheet-indicator-text">{props.counter}</span>
                          <Compass size={11} className="sheet-map-icon" style={{ opacity: 0.6 }} />
                        </button>
                      ) : (
                        <span className="sheet-indicator-badge">
                          <span className="sheet-indicator-accent" aria-hidden="true" />
                          <span className="sheet-indicator-text">{props.counter}</span>
                        </span>
                      )}
                      <button
                        type="button"
                        className="nav-btn next-sheet"
                        onClick={() => props.onSheetTurn?.(1)}
                        disabled={!props.canGoNextSheet}
                        aria-label={t('Hoja siguiente')}
                        title={hintOf('sheet-next') ? t('Hoja siguiente ({hint})', { hint: hintOf('sheet-next') }) : t('Hoja siguiente')}
                      >
                        <ChevronsRight size={13} />
                      </button>
                    </div>
                    {writing && (
                      <>
                        <span className={`write-status ${writing.status}`} title={writing.message}>
                          {draftUnsaved ? t('Sin guardar todavía') : t(STATUS_TEXT[writing.status])}
                        </span>
                      </>
                    )}
                    <Chips chips={props.chips} />
                  </>
                )
              }
              right={
                pageCount > 1 && page + index < pageCount && (
                  <div className="page-nav-group">
                    <button
                      type="button"
                      className="nav-btn prev-page"
                      onClick={() => (isWriting ? props.onTurn(-1) : props.onPageTurn?.(-1))}
                      disabled={!canTurnBack}
                      aria-label={t('Página anterior')}
                      title={
                        hintOf(isWriting ? 'write-prev' : 'prev')
                          ? t('Página anterior ({hint})', { hint: hintOf(isWriting ? 'write-prev' : 'prev') })
                          : t('Página anterior')
                      }
                    >
                      <ChevronLeft size={13} />
                    </button>
                    <span className="page-nav-counter">
                      {t('{page} de {total}', { page: page + index + 1, total: pageCount })}
                    </span>
                    <button
                      type="button"
                      className="nav-btn next-page"
                      onClick={() => (isWriting ? props.onTurn(1) : props.onPageTurn?.(1))}
                      disabled={!canTurnOn}
                      aria-label={t('Página siguiente')}
                      title={
                        hintOf(isWriting ? 'write-next' : 'next')
                          ? t('Página siguiente ({hint})', { hint: hintOf(isWriting ? 'write-next' : 'next') })
                          : t('Página siguiente')
                      }
                    >
                      <ChevronRight size={13} />
                    </button>
                  </div>
                )
              }
            />
          </div>
        ))}

      <div
        key="flow"
        className={`flow-clip ${mode}${
          active ? ` turn-${props.turn.direction}-${props.turn.tick % 2 ? 'a' : 'b'}${props.fading ? ' fading' : ''}` : ' parked'
        }`}
        style={{ left: g.padLeft, top: TOP, width: g.perView * g.pageWidth - g.gap, height: g.bodyHeight }}
        onScroll={onClipScroll}
      >
        <div
          ref={flow}
          className="flow"
          style={{
            width: g.column,
            height: g.bodyHeight,
            columnWidth: `${g.column}px`,
            columnGap: `${g.gap}px`,
            transform: `translateX(${-page * g.pageWidth}px)`,
          }}
        >
          <div className="flow-spacer" style={{ height: spacer }} />
          {isWriting && (
            // El contenido de este bloque lo maneja el navegador mientras se escribe.
            <pre
              key="editor"
              ref={editor}
              className="page-text editing sheet-editor"
              contentEditable="plaintext-only"
              suppressContentEditableWarning
              spellCheck={false}
              role="textbox"
              aria-multiline="true"
              aria-label={t('Texto de {title}', { title: sheet.title })}
              data-placeholder={t('Escribí acá…')}
              style={livePreview ? { display: 'none' } : undefined}
              onInput={onInput}
              onKeyDown={onEditorKey}
              onBlur={() => void writer.flush()}
            />
          )}
          {(!isWriting || livePreview) && doc && (
            <div
              key="markdown"
              ref={setReader}
              className="page-text md"
              onDoubleClick={active ? (isWriting ? toggleLivePreview : onMarkdownDoubleClick) : undefined}
              onClick={onMarkdownClick}
              onMouseDown={onMarkdownMouseDown}
              onKeyDown={onMarkdownKey}
            >
              <MarkdownBlocks doc={doc} tasks={!locked} />
            </div>
          )}
          {!isWriting && !doc && (
            <pre key="reader" ref={setReader} className="page-text" onDoubleClick={active ? onReadDoubleClick : undefined}>
              {text}
            </pre>
          )}
        </div>
      </div>

      {active && isWriting && pageCount > g.perView && (
        <>
          <button
            type="button"
            className="icon-button turn-button prev"
            style={{ left: g.padLeft - 34 }}
            disabled={!canTurnBack}
            onClick={() => props.onTurn(-1)}
            aria-label={t('Página anterior')}
            title={hintOf('write-prev') ? t('Página anterior ({hint})', { hint: hintOf('write-prev') }) : t('Página anterior')}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="icon-button turn-button next"
            disabled={!canTurnOn}
            onClick={() => props.onTurn(1)}
            aria-label={t('Página siguiente')}
            title={hintOf('write-next') ? t('Página siguiente ({hint})', { hint: hintOf('write-next') }) : t('Página siguiente')}
          >
            <ChevronRight size={16} />
          </button>
        </>
      )}
      {active && (
        <PageButtons
          key="buttons"
          geometry={g}
          menu={sheetMenu}
          actions={props.actions}
          onClose={props.onClose}
          onOpenMap={props.onOpenMap}
          banner={banner}
          allTabs={props.allTabs}
          view={props.view}
          onView={props.onView}
          hideTabs={props.hideTabs}
        />
      )}
      <Presence show={showVersions}>
        {(leaving) => <Versions sheet={sheet} leaving={leaving} onClose={() => setShowVersions(false)} />}
      </Presence>
      {dialogs}
    </>
  );
}

/** Cuaderno sin hojas para mostrar: páginas en blanco con una indicación. */
function EmptyLeaves(props: {
  geometry: Geometry;
  chips: FilterChip[];
  menu: MenuItem[];
  actions: NotebookActions;
  onClose: () => void;
  onOpenMap?: () => void;
  children: ReactNode;
  allTabs?: NotebookTab[];
  view?: View;
  onView?: (view: View) => void;
  hideTabs?: boolean;
}) {
  const sides: Side[] = props.geometry.perView === 2 ? ['left', 'right'] : ['only'];
  return (
    <>
      {sides.map((side, index) => (
        <div className={`page ${side}`} key={side}>
          {index === 0 && <div className="page-empty">{props.children}</div>}
          {index === 0 && <Footer geometry={props.geometry} left={<Chips chips={props.chips} />} />}
        </div>
      ))}
      <PageButtons
        geometry={props.geometry}
        menu={props.menu}
        actions={props.actions}
        onClose={props.onClose}
        onOpenMap={props.onOpenMap}
        allTabs={props.allTabs}
        view={props.view}
        onView={props.onView}
        hideTabs={props.hideTabs}
      />
    </>
  );
}

function Spiral() {
  return (
    <div className="spiral" aria-hidden="true">
      {Array.from({ length: RINGS }, (_, ring) => (
        <i key={ring} />
      ))}
    </div>
  );
}

/** El cuaderno: una nota por vez, de la más reciente hacia atrás. */
export function Notebook(props: {
  filter: ListFilter;
  revision: number;
  categories: Category[];
  scanning: boolean;
  spread: Spread;
  /** Tamaño de la letra: de él salen el alto del renglón, el rayado y cuánto entra en cada página. */
  textSize: TextSize;
  /** Tamaño del cuaderno en pantalla; la ventana se ajusta a él. */
  book: Box;
  closed: boolean;
  onClosed: (closed: boolean) => void;
  name: string;
  onName: (name: string) => void;
  /** Cantidad total de hojas de la vista, si se conoce. */
  total?: number;
  emptyTitle: string;
  emptyHint: string;
  /** Lo que dice la etiqueta de la tapa debajo del nombre. */
  coverNote: string;
  /** Estilo de la tapa y de la contratapa; sin él, lisa. */
  coverStyle?: CoverStyle;
  /** Acciones generales que se suman al menú de la hoja. */
  menuBefore: MenuItem[];
  menuAfter: MenuItem[];
  chips: FilterChip[];
  /** Solapas de filtro; `null` si el usuario las ocultó. */
  tabs: NotebookTab[] | null;
  allTabs?: NotebookTab[];
  hideTabs?: boolean;
  view: View;
  onView: (view: View) => void;
  actions: NotebookActions;
  /** Cada vez que cambia, el cuaderno abre una hoja nueva para escribir. */
  compose: number;
  notesDir: string;
  /** Las hojas `.md` se leen con formato. */
  markdown: boolean;
  hideHeader?: boolean;
  centerTitle?: boolean;

  onPageTurn?: (delta: 1 | -1) => void;
  /** Salta de hoja entera. */
  onSheetTurn?: (delta: 1 | -1) => void;
  canGoPrevSheet?: boolean;
  canGoNextSheet?: boolean;
  /** En modo tamaño, se agarró un borde o una esquina del cuaderno. */
  onStretch: (grip: Grip, event: ReactPointerEvent<HTMLElement>) => void;
  /** Acá el cuaderno deja cómo guardar lo que se esté escribiendo, para antes de cerrar. */
  flush: MutableRefObject<() => Promise<void>>;
}) {
  const { spread, closed, onClosed, textSize } = props;
  const t = useT();
  // Los menús muestran las combinaciones vigentes: si cambian, se redibujan.
  useShortcuts();
  const { items, loading, done, loadMore, loadAll, filterKey } = useSheets(props.filter, props.revision);
  const [measureLeaves, size] = useSize<HTMLDivElement>();
  const leaves = useRef<HTMLDivElement | null>(null);
  const setLeaves = useCallback(
    (node: HTMLDivElement | null) => {
      leaves.current = node;
      measureLeaves(node);
    },
    [measureLeaves],
  );
  const perView = spread === 'double' ? 2 : 1;

  const geometry = useMemo<Geometry>(() => {
    const pageWidth = size.width / perView;
    const padLeft = PAD_LEFT[spread];
    const edge = Math.round(Math.min(TURN_EDGE.max, Math.max(TURN_EDGE.min, pageWidth * TURN_EDGE.share)));
    const { line } = TEXT_STYLES[textSize];
    return {
      perView,
      pageWidth,
      padLeft,
      column: Math.max(0, pageWidth - padLeft - PAD_RIGHT),
      gap: padLeft + PAD_RIGHT,
      line,
      bodyHeight: Math.max(line * 3, Math.floor((size.height - TOP - FOOT) / line) * line),
      turnBack: Math.min(edge, padLeft - TURN_EDGE.gutter),
      turnOn: edge,
    };
  }, [size.width, size.height, perView, spread, textSize]);

  interface Pos { sheet: number; page: number }
  const [pos, setPos] = useState<Pos>({ sheet: 0, page: 0 });
  const [pageCount, setPageCount] = useState(1);
  const [mapOpen, setMapOpen] = useState(false);

  useEffect(() => {
    if (mapOpen && !done) {
      void loadAll();
    }
  }, [mapOpen, done, loadAll]);
  const [noteFormat, setNoteFormat] = useState<'txt' | 'md'>('txt');

  useEffect(() => {
    void api
      .getSettings()
      .then((s) => {
        if (s.noteFormat === 'md' || s.noteFormat === 'txt') {
          setNoteFormat(s.noteFormat);
        }
      })
      .catch(() => {});
  }, [props.revision]);
  const [turn, setTurn] = useState<{ direction: Direction; tick: number }>({ direction: 'next', tick: 0 });
  const [fading, setFading] = useState(false);
  /** La tapa o las hojas se están yendo, antes de abrir o cerrar el cuaderno. */
  const [swapping, setSwapping] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  /** Notas que siguen en el documento porque una selección empezó en ellas. */
  const [retained, setRetained] = useState<number[]>([]);
  /**
   * Hoja que se está escribiendo: sigue en el cuaderno aunque la lista todavía no la
   * traiga (una hoja nueva sin guardar) o deje de traerla (por el filtro activo).
   */
  const [pinned, setPinned] = useState<{ sheet: SheetSummary; release: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** El último aviso sigue escrito mientras se desvanece. */
  const shownNotice = useRef('');
  if (notice) shownNotice.current = notice;
  /** Nota que está abierta, para no perder el lugar cuando la lista se actualiza. */
  const anchor = useRef<number | null>(null);
  /** Al volver a la nota anterior se abre por su última página. */
  const stickToEnd = useRef(false);
  const timers = useRef({ turn: 0, swap: 0, nudge: 0 });
  /** Una hoja nueva conserva su lugar en pantalla cuando pasa a tener archivo e id propios. */
  const keys = useRef(new Map<number, string>());
  const drafts = useRef(0);

  const writer = useWriter({
    onCreated: (detail) => {
      const key = keys.current.get(DRAFT);
      if (key) keys.current.set(detail.id, key);
      setPinned({ sheet: summaryOf(detail), release: false });
    },
    onEnded: (id) =>
      setPinned((current) => (!current || current.sheet.id !== id ? current : id === DRAFT ? null : { ...current, release: true })),
    onNotice: setNotice,
  });
  const writingId = writer.writing?.id ?? null;
  const { finish: finishWriting, flush: saveWriting, begin: beginWriting } = writer;
  props.flush.current = finishWriting;

  /**
   * Mientras se desliza, corre apenas el contenido de las hojas (`offset` píxeles). Con
   * `null` lo suelta: de una, o volviendo suave a su lugar (`ease`) si no se pasó página.
   * Va directo al documento, sin pasar por React: se llama con cada movimiento del mouse.
   */
  const nudge = useCallback((offset: number | null, ease = false) => {
    const node = leaves.current;
    window.clearTimeout(timers.current.nudge);
    if (!node) return;
    if (offset !== null) {
      node.dataset.swipe = 'drag';
      node.style.setProperty('--swipe', `${offset}px`);
      return;
    }
    node.style.removeProperty('--swipe');
    if (ease && node.dataset.swipe) {
      node.dataset.swipe = 'back';
      timers.current.nudge = window.setTimeout(() => delete node.dataset.swipe, SWIPE.back);
    } else {
      delete node.dataset.swipe;
    }
  }, []);

  /** Hay una pasada de página en camino: lo que se ve se está desvaneciendo. */
  const turning = useRef(false);

  /** Deja sin efecto una pasada de página que todavía no llegó a verse. */
  const cancelTurn = useCallback(() => {
    window.clearTimeout(timers.current.turn);
    turning.current = false;
    setFading(false);
    nudge(null);
  }, [nudge]);

  /** Dónde se apretó sobre las hojas y si eso puede terminar siendo un deslizamiento. */
  const press = useRef<{ x: number; y: number; swipe: boolean } | null>(null);
  const drag = useRef({ selecting: false, direction: 0 as 0 | 1 | -1, timer: 0 });
  const wheel = useRef({ sum: 0, last: 0, free: 0 });

  const stopHold = useCallback(() => {
    window.clearTimeout(drag.current.timer);
    drag.current.timer = 0;
    drag.current.direction = 0;
  }, []);

  const sheets = useMemo(
    () => (pinned && !items.some((item) => item.id === pinned.sheet.id) ? [pinned.sheet, ...items] : items),
    [items, pinned],
  );

  useEffect(() => {
    let alive = true;
    void document.fonts.ready.then(() => alive && setFontsReady(true));
    const pending = timers.current;
    return () => {
      alive = false;
      window.clearTimeout(pending.turn);
      window.clearTimeout(pending.swap);
      window.clearTimeout(pending.nudge);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Lo que se terminó de escribir deja de estar fijado cuando la lista ya lo trae.
  useEffect(() => {
    if (!pinned?.release) return;
    if (items.some((item) => item.id === pinned.sheet.id)) return setPinned(null);
    const timer = window.setTimeout(() => setPinned(null), 1500);
    return () => window.clearTimeout(timer);
  }, [pinned, items]);

  // Al perder el foco la ventana, lo escrito se guarda sin esperar.
  useEffect(() => {
    const onBlur = () => void saveWriting();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [saveWriting]);

  const live = useRef({ writingId, sheets });
  live.current.writingId = writingId;
  live.current.sheets = sheets;

  // La hoja que se escribe queda fijada: si el filtro deja de traerla, sigue a la vista.
  useEffect(() => {
    if (writingId === null || writingId === DRAFT) return;
    setPinned((current) => {
      if (current && current.sheet.id === writingId && !current.release) return current;
      const found = live.current.sheets.find((item) => item.id === writingId);
      return found ? { sheet: found, release: false } : current;
    });
  }, [writingId]);

  useEffect(() => {
    // Cambiar de filtro termina la escritura, salvo que sea una hoja nueva: esa sigue adelante.
    if (live.current.writingId !== null && live.current.writingId !== DRAFT) void finishWriting();
    // Una pasada de página pendiente era del filtro anterior: ya no va a ningún lado.
    cancelTurn();
    anchor.current = null;
    stickToEnd.current = false;
    setPos({ sheet: 0, page: 0 });
    setPageCount(1);
    setRetained([]);
  }, [filterKey, finishWriting, cancelTurn]);

  // La lista cambió (entraron notas, o la que se escribe se guardó y pasó adelante): se
  // busca dónde quedó la hoja abierta. Se resuelve acá, en el mismo dibujo, y no en un
  // efecto: si no, por un instante quedaría a la vista la hoja vecina y la que se estaba
  // escribiendo perdería su editor, con el cursor y lo que se tecleara en el medio. Además,
  // para cuando un efecto llegara a mover la vista, `anchor` ya apuntaría a la vecina.
  const [listed, setListed] = useState(sheets);
  let activePos = pos;
  if (listed !== sheets) {
    setListed(sheets);
    const kept = writingId !== null ? writingId : anchor.current;
    // Si entraron notas nuevas adelante, se sigue mostrando la que se estaba leyendo;
    // en la primera no, porque ahí lo esperable es ver lo más reciente (salvo que se
    // la esté escribiendo: una hoja no cambia debajo del cursor).
    const follow = kept !== null && (pos.sheet > 0 || writingId !== null);
    const found = follow ? sheets.findIndex((item) => item.id === kept) : -1;
    const clamped = Math.max(0, Math.min(pos.sheet, sheets.length - 1));
    if (typeof window !== 'undefined') {
      (window as any).__listedLog = (window as any).__listedLog || [];
      (window as any).__listedLog.push({ posSheet: pos.sheet, kept, writingId, found, sheetsCount: sheets.length, firstSheetId: sheets[0]?.id });
    }
    if (found >= 0) {
      if (found !== pos.sheet) {
        setPos({ sheet: found, page: pos.page });
        activePos = { sheet: found, page: pos.page };
      }
    } else if (clamped !== pos.sheet) {
      setPos({ sheet: clamped, page: 0 });
      activePos = { sheet: clamped, page: 0 };
    }
  }

  useEffect(() => {
    anchor.current = sheets[activePos.sheet]?.id ?? null;
  }, [sheets, activePos.sheet]);

  useEffect(() => {
    setPos((current) => (current.page % perView === 0 ? current : { ...current, page: current.page - (current.page % perView) }));
  }, [perView]);

  useEffect(() => {
    if (!done && pos.sheet + 3 >= sheets.length) loadMore();
  }, [pos.sheet, sheets.length, done, loadMore]);

  /** Cuántas páginas y con qué renglón se contó la última vez: si la letra cambia, se sabe de dónde se viene. */
  const counted = useRef({ line: TEXT_STYLES[textSize].line, pages: 1 });
  const handlePages = useCallback(
    (pages: number, line: number) => {
      const toEnd = stickToEnd.current;
      const before = counted.current;
      counted.current = { line, pages };
      setPageCount(pages);
      setPos((current) => {
        const last = pages - 1;
        const lastAligned = last - (last % perView);
        if (toEnd) return current.page === lastAligned ? current : { ...current, page: lastAligned };
        // Con otra letra la nota ocupa otra cantidad de páginas: se sigue en el mismo punto de
        // la lectura (a la mitad, por ejemplo) y no en el mismo número de página.
        const scaled = before.line !== line && before.pages > 1 ? Math.round((current.page / before.pages) * pages) : current.page;
        const page = Math.min(scaled - (scaled % perView), lastAligned);
        return page === current.page ? current : { ...current, page };
      });
    },
    [perView],
  );

  const handleCaretPage = useCallback(
    (page: number) => {
      const aligned = page - (page % perView);
      stickToEnd.current = false;
      setPos((current) => (current.page === aligned ? current : { ...current, page: aligned }));
    },
    [perView],
  );

  /**
   * Abre o cierra el cuaderno: lo que está a la vista se desvanece y después cambia.
   * Con `quiet` no suena (cuando lo que lo abre ya tiene su propio sonido).
   */
  const setClosed = useCallback(
    (next: boolean, _quiet = false) => {
      if (next === closed) return;
      if (next) {
        void finishWriting();
        cancelTurn();
        stopHold();
        press.current = null;
        coverBusy.current = false;
      }
      window.clearTimeout(timers.current.swap);
      setSwapping(true);
      timers.current.swap = window.setTimeout(() => {
        onClosed(next);
        setSwapping(false);
      }, COVER_OUT);
    },
    [closed, onClosed, finishWriting, cancelTurn, stopHold],
  );

  // Cerrado, el cuaderno tiene dos caras: la tapa y la contratapa.
  const faces = useFaces();
  const { face, show: showFace } = faces;
  /** Cara por la que se cerró: si se lo abre por la otra, se abre por la otra punta. */
  const closedOn = useRef<Face>('front');
  /** La tapa deja dicho acá si se están acomodando sus imágenes: mientras tanto no se abre. */
  const coverBusy = useRef(false);

  /** Cierra el cuaderno dejando a la vista esa cara. */
  const closeTo = useCallback(
    (side: Face) => {
      cancelTurn();
      stopHold();
      press.current = null;
      closedOn.current = side;
      showFace(side);
      setClosed(true);
    },
    [showFace, setClosed, cancelTurn, stopHold],
  );

  useEffect(() => {
    if (closed) {
      cancelTurn();
      stopHold();
      press.current = null;
      coverBusy.current = false;
    }
  }, [closed, cancelTurn, stopHold]);

  /**
   * Abre el cuaderno por la cara que se está viendo. Por la contratapa, siempre en la
   * última página de la última hoja. Por la tapa queda donde estaba, salvo que se lo
   * haya cerrado por atrás y después dado vuelta: entonces, en la primera hoja.
   */
  const openBook = useCallback(() => {
    if (face === 'front') {
      if (closedOn.current === 'back') {
        anchor.current = null;
        stickToEnd.current = false;
        setPos({ sheet: 0, page: 0 });
      }
      return setClosed(false);
    }
    // La última hoja es la más antigua: se traen todas las que falten antes de abrir. Sus
    // páginas se cuentan de nuevo al abrir, y la vista queda en la última (`stickToEnd`).
    void loadAll()
      .then((all) => {
        const last = all[all.length - 1];
        if (!last) return;
        anchor.current = last.id;
        stickToEnd.current = true;
        setPageCount(1);
        setPos({ sheet: all.length - 1 + (live.current.sheets[0]?.id === DRAFT ? 1 : 0), page: 0 });
      })
      .catch(() => {})
      .finally(() => setClosed(false));
  }, [face, setClosed, loadAll]);

  const sheet = sheets[activePos.sheet];

  /**
   * Pasa de página y avisa si pasó algo (si no había a dónde ir, no). Antes de la primera
   * está la tapa: ir hacia atrás cierra el cuaderno. `selecting` indica que el usuario
   * está arrastrando una selección: la nota que se deja atrás no se desmonta, así la
   * selección puede seguir en la siguiente. Con `within` no se sale de la nota abierta:
   * es como se pasa de página mientras se la escribe.
   */
  const go = useCallback(
    (delta: 1 | -1, selecting = false, within = false): boolean => {
      const direction: Direction = delta > 0 ? 'next' : 'prev';
      if (closed) {
        // Cerrado se abre hacia adentro: desde la tapa o contratapa, cualquier intento de pasar de página lo abre.
        const opens = !coverBusy.current;
        if (opens) openBook();
        return opens;
      }
      // Con una pasada en camino, la siguiente espera a que esa se vea: si cada pedido
      // volviera a empezar la cuenta, con una flecha apretada la hoja quedaría en blanco.
      if (turning.current && !selecting) return false;
      let next = pos;
      let toEnd = false;
      if (delta > 0) {
        if (pos.page + perView < pageCount) next = { sheet: pos.sheet, page: pos.page + perView };
        else if (!within && pos.sheet + 1 < sheets.length) next = { sheet: pos.sheet + 1, page: 0 };
        else if (!within && !selecting && done) {
          // Después de la última página de la última hoja está la contratapa. Solo cuando
          // ya se sabe que no quedan hojas por traer.
          closeTo('back');
          return true;
        }
      } else if (pos.page > 0) {
        next = { sheet: pos.sheet, page: Math.max(0, pos.page - perView) };
      } else if (within) {
        return false;
      } else if (pos.sheet > 0) {
        next = { sheet: pos.sheet - 1, page: 0 };
        toEnd = true;
      } else if (!selecting) {
        closeTo('front');
        return true;
      }
      if (next === pos) return false;
      const changesNote = next.sheet !== pos.sheet;
      const leaving = changesNote ? sheets[pos.sheet]?.id : undefined;
      const target = sheets[next.sheet]?.id;
      // Pasar a otra nota termina la escritura: lo escrito se guarda solo.
      if (changesNote) void finishWriting();
      const apply = () => {
        turning.current = false;
        playSound(delta > 0 ? 'turn-next' : 'turn-prev');
        stickToEnd.current = toEnd;
        if (changesNote) setPageCount(1);
        if (selecting && leaving !== undefined) setRetained((kept) => (kept.includes(leaving) ? kept : [...kept, leaving]));
        if (!selecting) setRetained((kept) => (kept.length ? [] : kept));
        setTurn((current) => ({ direction, tick: current.tick + 1 }));
        // La lista pudo cambiar mientras tanto (una hoja nueva que se guardó o se
        // descartó): se va a la nota elegida, esté donde esté ahora.
        const found = changesNote ? live.current.sheets.findIndex((item) => item.id === target) : -1;
        if (changesNote && target !== undefined) anchor.current = target;
        setPos(found >= 0 ? { sheet: found, page: next.page } : next);
        setFading(false);
      };
      // Mientras se selecciona no hay desvanecido: el texto tiene que seguir a la vista.
      if (selecting) {
        apply();
        return true;
      }
      window.clearTimeout(timers.current.turn);
      turning.current = true;
      setFading(true);
      timers.current.turn = window.setTimeout(apply, TURN_OUT);
      return true;
    },
    [closed, face, openBook, closeTo, done, pos, perView, pageCount, sheets, finishWriting],
  );

  /** Pasa de hoja entera (anterior o siguiente) sin recorrer página por página. */
  const goSheet = useCallback(
    (delta: 1 | -1): boolean => {
      const direction: Direction = delta > 0 ? 'next' : 'prev';
      if (closed) {
        const opens = !coverBusy.current;
        if (opens) openBook();
        return opens;
      }
      if (turning.current) return false;
      let next = pos;
      if (delta > 0) {
        if (pos.sheet + 1 < sheets.length) {
          next = { sheet: pos.sheet + 1, page: 0 };
        } else if (!done) {
          loadMore();
          return false;
        } else {
          closeTo('back');
          return true;
        }
      } else {
        if (pos.sheet > 0) {
          next = { sheet: pos.sheet - 1, page: 0 };
        } else if (pos.page > 0) {
          next = { sheet: 0, page: 0 };
        } else {
          closeTo('front');
          return true;
        }
      }
      if (next.sheet === pos.sheet && next.page === pos.page) return false;
      const changesNote = next.sheet !== pos.sheet;
      const target = sheets[next.sheet]?.id;
      if (changesNote) void finishWriting();
      const apply = () => {
        turning.current = false;
        playSound(delta > 0 ? 'turn-next' : 'turn-prev');
        stickToEnd.current = false;
        if (changesNote) setPageCount(1);
        setRetained((kept) => (kept.length ? [] : kept));
        setTurn((current) => ({ direction, tick: current.tick + 1 }));
        const found = changesNote ? live.current.sheets.findIndex((item) => item.id === target) : -1;
        if (changesNote && target !== undefined) anchor.current = target;
        setPos(found >= 0 ? { sheet: found, page: next.page } : next);
        setFading(false);
      };
      window.clearTimeout(timers.current.turn);
      turning.current = true;
      setFading(true);
      timers.current.turn = window.setTimeout(apply, TURN_OUT);
      return true;
    },
    [closed, face, openBook, closeTo, done, loadMore, pos, sheets, finishWriting],
  );

  const goFirst = useCallback(() => {
    void finishWriting();
    cancelTurn();
    if (now.current.pos.sheet > 0 || now.current.pos.page > 0) playSound('turn-prev');
    anchor.current = null;
    stickToEnd.current = false;
    setTurn((current) => ({ direction: 'prev', tick: current.tick + 1 }));
    setPos({ sheet: 0, page: 0 });
  }, [finishWriting, cancelTurn]);

  /** La última hoja es la más antigua: hay que traer todas las que falten antes de saltar. */
  const goLast = useCallback(() => {
    void finishWriting();
    cancelTurn();
    void loadAll().then((all) => {
      const last = all[all.length - 1];
      if (!last) return;
      if (live.current.sheets[now.current.pos.sheet]?.id !== last.id) playSound('turn-next');
      // Se anota a qué hoja se va: si la lista se reacomoda, la vista la sigue.
      anchor.current = last.id;
      stickToEnd.current = false;
      setPageCount(1);
      setTurn((current) => ({ direction: 'next', tick: current.tick + 1 }));
      setPos({ sheet: all.length - 1 + (live.current.sheets.length > 0 && live.current.sheets[0].id === DRAFT ? 1 : 0), page: 0 });
    });
  }, [loadAll, finishWriting, cancelTurn]);

  /** Abre una hoja en blanco al principio del cuaderno, lista para escribir. */
  const startDraft = useCallback(() => {
    if (live.current.writingId === DRAFT) {
      const node = leaves.current?.querySelector<HTMLElement>('.page-text.editing');
      if (node) placeCaret(node, 'end');
      return;
    }
    const ext = noteFormat === 'md' ? '.md' : '.txt';
    keys.current.set(DRAFT, `new-${++drafts.current}`);
    // Si se acababa de pedir pasar página, ya no: la vista se queda en la hoja nueva.
    cancelTurn();
    beginWriting({ id: DRAFT, title: '', text: '', hash: null, renamable: true, categoryId: props.filter.categoryId });
    setPinned({
      sheet: {
        id: DRAFT,
        source: 'file',
        title: `${t('Sin título')}${ext}`,
        path: null,
        preview: '',
        length: 0,
        size: 0,
        modifiedAt: Date.now(),
        categoryId: props.filter.categoryId ?? null,
        categorySource: null,
        categoryConfidence: null,
        noteScore: null,
        secret: false,
        secretSource: null,
        hidden: false,
        missing: false,
        versionCount: 0,
        pinned: false,
      },
      release: false,
    });
    anchor.current = DRAFT;
    stickToEnd.current = false;
    setRetained([]);
    setPageCount(1);
    setTurn((current) => ({ direction: 'prev', tick: current.tick + 1 }));
    setPos({ sheet: 0, page: 0 });
    setClosed(false, true);
  }, [beginWriting, cancelTurn, noteFormat, props.filter.categoryId, setClosed, t]);

  const composed = useRef(props.compose);
  useEffect(() => {
    if (composed.current === props.compose) return;
    composed.current = props.compose;
    startDraft();
  }, [props.compose, startDraft]);

  // Estado más reciente para los manejadores que viven fuera del ciclo de React.
  const now = useRef({ go, pos, pageCount, perView, geometry });
  now.current = { go, pos, pageCount, perView, geometry };

  /** Cuándo fue la última pasada de página con una tecla que se mantiene apretada. */
  const lastHeldTurn = useRef(0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const busy = target?.closest('input, textarea, [contenteditable], [role="menu"]') || document.querySelector('.backdrop');
      if (busy) return;
      const action = which(event, TURN_ACTIONS);
      if (!action) return;
      if (action === 'next' || action === 'prev') {
        // Con la tecla apretada el teclado repite mucho más rápido de lo que se puede
        // ver: se pasa una página cada tanto, y entre una y otra se llega a ver la hoja.
        const at = performance.now();
        if (!event.repeat || at - lastHeldTurn.current >= HOLD_PACE) {
          lastHeldTurn.current = at;
          go(action === 'next' ? 1 : -1);
        }
      } else if (action === 'sheet-next' || action === 'sheet-prev') {
        const at = performance.now();
        if (!event.repeat || at - lastHeldTurn.current >= HOLD_PACE) {
          lastHeldTurn.current = at;
          goSheet(action === 'sheet-next' ? 1 : -1);
        }
      } else if (action === 'first') goFirst();
      else goLast();
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go, goSheet, goFirst, goLast]);

  // Guardar y dejar de escribir con el teclado, esté donde esté el foco (el texto, el
  // título, un botón de la hoja): Ctrl + Enter guarda y termina; Ctrl + S guarda y se sigue.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // El texto y el título ya atendieron los suyos. Una tecla suelta (Esc) es del control
      // que tiene el foco, por ejemplo para cerrar un menú: acá solo valen las que llevan Ctrl o Alt.
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey || event.altKey)) return;
      if (live.current.writingId === null || document.querySelector('.backdrop')) return;
      const action = which(event, SAVE_ACTIONS);
      if (action === 'finish') void finishWriting();
      else if (action === 'save') void saveWriting();
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [finishWriting, saveWriting]);

  // De la papelera y del secret-book se vuelve al cuaderno de siempre con Esc, salvo que
  // Esc esté ocupada en otra cosa: dejar de escribir, cerrar un menú o un panel, cancelar
  // el modo tamaño.
  const away = props.view.kind === 'hidden' || props.view.kind === 'secret';
  const { onView: changeView } = props;
  const backToAll = useCallback(() => {
    void finishWriting();
    changeView({ kind: 'all' });
  }, [finishWriting, changeView]);
  useEffect(() => {
    if (!away) return;
    const onKey = (event: KeyboardEvent) => {
      if (!matches(event, 'back') || event.defaultPrevented || live.current.writingId !== null) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [contenteditable]') || document.querySelector('.backdrop, .menu-list, .app.sizing')) return;
      event.preventDefault();
      backToAll();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [away, backToAll]);

  // ---- clic en los bordes, deslizar y selección que sigue en la hoja siguiente ----

  // Lo que entra después de pasar página llega derecho a su lugar: el corrimiento del
  // deslizamiento era de lo que se fue.
  useLayoutEffect(() => nudge(null), [turn.tick, nudge]);

  useEffect(() => {
    const across = (dx: number, dy: number) => Math.abs(dx) >= Math.abs(dy) * SWIPE.slope;
    const onMove = (event: PointerEvent) => {
      const held = press.current;
      if (held?.swipe) {
        // Se soltó fuera de la ventana: no llegó a ser un deslizamiento.
        if (!(event.buttons & 1)) {
          held.swipe = false;
          return nudge(null, true);
        }
        // Las hojas acompañan a la mano apenas, y solo si el arrastre va de costado.
        const dx = event.clientX - held.x;
        const sideways = Math.abs(dx) > 5 && across(dx, event.clientY - held.y);
        if (sideways) nudge(Math.sign(dx) * Math.min(SWIPE.reach, Math.abs(dx) * SWIPE.follow));
        else if (leaves.current?.dataset.swipe) nudge(0);
        return;
      }
      if (!drag.current.selecting) return;
      const node = leaves.current;
      if (!node || !(event.buttons & 1)) return stopHold();
      const { geometry: g, perView: shown } = now.current;
      const rect = node.getBoundingClientRect();
      const middle = rect.left + rect.width / 2;
      const onLastPage = shown === 1 || event.clientX > middle;
      const onFirstPage = shown === 1 || event.clientX < middle;
      // Hay que salirse del texto con ganas: llegar al final del renglón no pasa de página.
      const forward = event.clientX > rect.right - PAD_RIGHT + 10 || (onLastPage && event.clientY > rect.top + TOP + g.bodyHeight + 6);
      const backward = event.clientX < rect.left + g.padLeft - 10 || (onFirstPage && event.clientY < rect.top + TOP - 6);
      const direction = forward ? 1 : backward ? -1 : 0;
      if (direction === 0) return stopHold();
      if (drag.current.direction === direction) return;
      stopHold();
      drag.current.direction = direction;
      const hold = () => {
        const { pos: at, pageCount: pages, perView: step } = now.current;
        const leavesNote = direction > 0 ? at.page + step >= pages : at.page === 0;
        // Escribiendo, la selección no sale de la nota: salir de ella termina la escritura.
        if (leavesNote && live.current.writingId !== null) return;
        drag.current.timer = window.setTimeout(
          () => {
            now.current.go(direction, true);
            hold();
          },
          leavesNote ? NOTE_HOLD : PAGE_HOLD,
        );
      };
      hold();
    };
    const onUp = (event: PointerEvent) => {
      const held = press.current;
      if (held?.swipe) {
        held.swipe = false;
        const dx = event.clientX - held.x;
        const swiped = event.type === 'pointerup' && Math.abs(dx) >= SWIPE.distance && across(dx, event.clientY - held.y);
        // La hoja sigue a la mano: hacia la izquierda se va a la siguiente; hacia la derecha,
        // a la anterior. Si no había a dónde pasar, las hojas vuelven a su lugar.
        if (!(swiped && now.current.go(dx < 0 ? 1 : -1))) nudge(null, true);
      }
      drag.current.selecting = false;
      stopHold();
    };
    // Sin selección activa ya no hace falta conservar las notas anteriores.
    const onSelection = () => {
      if (!drag.current.selecting && (getSelection()?.isCollapsed ?? true)) setRetained((kept) => (kept.length ? [] : kept));
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    document.addEventListener('selectionchange', onSelection);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('selectionchange', onSelection);
      stopHold();
    };
  }, [stopHold, nudge]);

  /**
   * Los diálogos que se abren desde una hoja (versiones, la pregunta de la papelera) se
   * dibujan fuera de las hojas, pero para React siguen siendo hijos de ellas y sus eventos
   * suben hasta acá: un clic, un arrastre o la rueda dentro de un diálogo no son de las hojas.
   */
  const fromOutside = (event: { target: EventTarget; currentTarget: EventTarget }) =>
    !(event.currentTarget as Element).contains(event.target as Node);

  const onPointerDown = (event: ReactPointerEvent) => {
    if (fromOutside(event)) return;
    const target = event.target as Element;
    const onText = !!target.closest('.page-text');
    drag.current.selecting = event.button === 0 && onText;
    // Deslizar empieza en el papel: sobre el texto (o el título) se selecciona, y los
    // controles son de quien los usa. Tampoco escribiendo, ni con Mayús (modo tamaño).
    const swipe =
      event.button === 0 && !onText && !event.shiftKey && live.current.writingId === null && !target.closest(`${CONTROLS}, .page-title`);
    press.current = { x: event.clientX, y: event.clientY, swipe };
    // Si quedaba un corrimiento de un deslizamiento anterior, hasta acá llegó.
    if (swipe) nudge(null);
  };

  const canGoPrevSheet = pos.sheet > 0 || pos.page > 0;
  const canGoNextSheet = pos.sheet + 1 < sheets.length || !done;
  /** Queda algo adelante: más páginas de esta nota u otra hoja. */
  const canGoOn = pos.page + perView < pageCount || pos.sheet + 1 < sheets.length;

  /**
   * Leyendo, solo pasa página un clic en las franjas de los bordes de afuera (`TurnZones`):
   * en el resto de la hoja un clic no hace nada, y por eso no hay que esperar para saber si
   * era un doble clic. Escribiendo, ningún clic pasa página: todos son del cursor. Sobre el
   * texto lo pone el navegador; en un margen, en el pie o en el papel en blanco, va al lugar
   * del texto más cercano. Las páginas se pasan con la rueda, con Re Pág y Av Pág o con las
   * flechas del pie.
   */
  const onClick = (event: MouseEvent) => {
    const target = event.target as Element;
    if (fromOutside(event) || target.closest(CONTROLS)) return;
    const start = press.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return; // fue un arrastre
    const editing = event.currentTarget.querySelector<HTMLElement>('.page-text.editing');
    if (editing) {
      if (target.closest('.page-text')) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const g = geometry;
      const shown = Math.min(g.perView - 1, Math.max(0, Math.floor((event.clientX - rect.left) / g.pageWidth)));
      const left = rect.left + shown * g.pageWidth + g.padLeft;
      const top = rect.top + TOP;
      return placeCaretNear(editing, event.clientX, event.clientY, { left, right: left + g.column, top, bottom: top + g.bodyHeight });
    }
    const zone = target.closest('.turn-zone');
    if (zone) {
      go(zone.classList.contains('prev') ? -1 : 1);
      return;
    }
    // Clic simple en los bordes y esquinas de la hoja para pasar página:
    if (!target.closest(`.page-text, .page-head, .page-bar, .page-foot, ${CONTROLS}`)) {
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left + geometry.turnBack) {
        go(-1);
        return;
      }
      if ((canGoOn || done) && event.clientX > rect.right - geometry.turnOn) {
        go(1);
        return;
      }
    }
  };

  /**
   * La rueda pasa páginas; no cierra el cuaderno ni se dispara varias veces por un solo
   * giro. Escribiendo no sale de la nota: un toque de más no termina la escritura.
   */
  const onWheel = (event: WheelEvent) => {
    if (fromOutside(event) || event.ctrlKey) return;
    const state = wheel.current;
    const at = performance.now();
    if (at - state.last > WHEEL_PAUSE) state.sum = 0;
    state.last = at;
    if (at < state.free) return;
    const effectiveDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (Math.abs(effectiveDelta) === 0) return;
    state.sum += effectiveDelta;
    if (Math.abs(state.sum) < WHEEL_STEP) return;
    const delta = state.sum > 0 ? 1 : -1;
    state.sum = 0;
    state.free = at + WHEEL_PAUSE;
    if (delta < 0 && pos.sheet === 0 && pos.page === 0) return;
    // Tampoco por el final: a la contratapa se llega con la franja, la flecha o deslizando.
    if (delta > 0 && pos.page + perView >= pageCount && pos.sheet + 1 >= sheets.length) return;
    go(delta, false, writingId !== null);
  };

  /** Escribiendo, Re Pág, Av Pág y las flechas del pie pasan de página dentro de la nota. */
  const turnWithin = useCallback((delta: 1 | -1) => void go(delta, false, true), [go]);

  const handleDraftCategory = useCallback(
    (categoryId: number | null) => {
      writer.setCategory(categoryId);
      setPinned((current) =>
        current
          ? {
              ...current,
              sheet: {
                ...current.sheet,
                categoryId,
                categorySource: categoryId !== null ? 'manual' : null,
              },
            }
          : current,
      );
    },
    [writer],
  );

  const handleSavedNote = useCallback(
    (detail: SheetDetail) => {
      setPinned({ sheet: summaryOf(detail), release: false });
      anchor.current = detail.id;
      stickToEnd.current = false;
      setPos({ sheet: 0, page: 0 });
      writer.begin({
        id: detail.id,
        title: stemOf(detail.title),
        text: detail.content,
        hash: detail.hash,
        renamable: true,
      });
    },
    [writer],
  );

  const onView = useCallback(
    (view: View) => {
      void finishWriting();
      props.onView(view);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [finishWriting, props.onView],
  );

  // Atajo Ctrl + M para abrir o cerrar el mapa del cuaderno
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'm' || event.key === 'M') && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        setMapOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => api.onOpenMap(() => setMapOpen(true)), []);

  useEffect(
    () =>
      api.onFocusSheet((targetId) => {
        void finishWriting();
        cancelTurn();
        setClosed(false, true);
        const found = live.current.sheets.findIndex((item) => item.id === targetId);
        if (found >= 0) {
          anchor.current = targetId;
          stickToEnd.current = false;
          setPageCount(1);
          setPos({ sheet: found, page: 0 });
        } else {
          void loadAll().then((all) => {
            const idx = all.findIndex((item) => item.id === targetId);
            if (idx >= 0) {
              anchor.current = targetId;
              stickToEnd.current = false;
              setPageCount(1);
              setPos({ sheet: idx, page: 0 });
            }
          });
        }
      }),
    [finishWriting, cancelTurn, setClosed, loadAll],
  );

  const extra = sheets.length - items.length;
  const total = props.total !== undefined ? props.total + extra : done ? sheets.length : undefined;
  const counter = sheet
    ? total !== undefined
      ? t('Hoja {n} de {total}', { n: count(activePos.sheet + 1), total: count(Math.max(total, activePos.sheet + 1)) })
      : t('Hoja {n}', { n: count(activePos.sheet + 1) })
    : '';
  const mounted = sheets.filter((item, index) => index === activePos.sheet || retained.includes(item.id));
  const closeBook = useCallback(() => closeTo('front'), [closeTo]);
  const coverMenu = [...props.menuBefore, ...props.menuAfter];
  const navItems: MenuItem[] = [
    { label: t('Hoja anterior'), icon: <ChevronsLeft size={14} />, hint: hintOf('sheet-prev'), onSelect: () => goSheet(-1) },
    { label: t('Hoja siguiente'), icon: <ChevronsRight size={14} />, hint: hintOf('sheet-next'), onSelect: () => goSheet(1) },
    { label: t('Ir a la primera hoja'), icon: <ChevronFirst size={14} />, hint: hintOf('first'), onSelect: goFirst },
    { label: t('Ir a la última hoja'), icon: <ChevronLast size={14} />, hint: hintOf('last'), onSelect: goLast },
    { label: t('Mapa del cuaderno (Ctrl + M)'), icon: <Compass size={14} />, hint: 'Ctrl+M', onSelect: () => setMapOpen(true) },
  ];

  return (
    // La letra se mide acá, en el mismo dibujo que la geometría de las páginas.
    <div
      className={`stage${props.tabs ? '' : ' no-tabs'}`}
      style={textVars(textSize)}
      data-tauri-drag-region={closed ? undefined : ''}
      onMouseDown={(e) => {
        if (e.button === 0 && !(e.target as Element).closest('.book, button, a, input, textarea, .menu-list, [role="button"], [role="menuitem"]')) {
          api.window.drag();
        }
      }}
    >
      <div
        className={`book ${spread}${closed ? ' closed' : ''}`}
        style={{ width: props.book.width, height: props.book.height }}
        // Qué cara se ve y en qué mitad del giro va, para darlo vuelta (styles/cover.css).
        data-face={closed ? face : undefined}
        data-flip={(closed && faces.flip) || undefined}
      >
        {props.tabs && <Tabs tabs={props.tabs} view={props.view} onView={onView} />}
        {spread === 'single' && <Spiral />}

        {closed ? (
          <Cover
            face={face}
            skin={props.coverStyle ?? 'plain'}
            name={props.name}
            onName={props.onName}
            note={props.coverNote}
            leaving={swapping}
            menuBefore={props.menuBefore}
            menuAfter={props.menuAfter}
            actions={props.actions}
            onOpen={openBook}
            onFlip={faces.turn}
            busy={coverBusy}
          />
        ) : (
          <div
            className={`leaves${swapping ? ' leaving' : ''}`}
            ref={setLeaves}
            onPointerDown={onPointerDown}
            onClick={onClick}
            onWheel={onWheel}
          >
            {sheet && size.width > 0 ? (
              mounted.map((item) => (
                <OpenSheet
                  key={keys.current.get(item.id) ?? item.id}
                  sheet={item}
                  active={item.id === sheet.id}
                  categories={props.categories}
                  geometry={geometry}
                  page={item.id === sheet.id ? activePos.page : 0}
                  pageCount={pageCount}
                  turn={turn}
                  fading={fading}
                  fontsReady={fontsReady}
                  counter={counter}
                  chips={props.chips}
                  writer={writer}
                  notesDir={props.notesDir}
                  hideHeader={props.hideHeader}
                  centerTitle={props.centerTitle}
                  onPageTurn={go}
                  onSheetTurn={goSheet}
                  canGoPrevSheet={canGoPrevSheet}
                  canGoNextSheet={canGoNextSheet}
                  markdown={props.markdown}
                  onPages={handlePages}
                  onCaretPage={handleCaretPage}
                  onTurn={turnWithin}
                  onDraftCategory={handleDraftCategory}
                  onNotice={setNotice}
                  onClose={closeBook}
                  onBack={away ? backToAll : undefined}
                  onOpenMap={() => setMapOpen(true)}
                  noteFormat={noteFormat}
                  revision={props.revision}
                  actions={props.actions}
                  menuBefore={props.menuBefore}
                  navItems={navItems}
                  menuAfter={props.menuAfter}
                  allTabs={props.allTabs ?? props.tabs ?? []}
                  view={props.view}
                  onView={onView}
                  hideTabs={props.hideTabs ?? (props.tabs === null)}
                  onSavedNote={handleSavedNote}
                />
              ))
            ) : (
              <EmptyLeaves
                geometry={geometry}
                chips={props.chips}
                menu={coverMenu}
                actions={props.actions}
                onClose={closeBook}
                onOpenMap={() => setMapOpen(true)}
                allTabs={props.allTabs ?? props.tabs ?? []}
                view={props.view}
                onView={onView}
                hideTabs={props.hideTabs ?? (props.tabs === null)}
              >
                {loading || sheet ? (
                  <LoaderCircle size={18} className="spin late" />
                ) : (
                  <>
                    {props.scanning ? <LoaderCircle size={22} className="spin" /> : <NotebookPen size={24} />}
                    <h2>{props.scanning ? t('Buscando tus notas…') : props.emptyTitle}</h2>
                    <p>{props.scanning ? t('El primer recorrido del disco puede tardar un momento.') : props.emptyHint}</p>
                    {away && (
                      <button
                        type="button"
                        className="button"
                        onClick={backToAll}
                        title={hintOf('back') ? t('Volver a todas las hojas ({hint})', { hint: hintOf('back') }) : t('Volver a todas las hojas')}
                      >
                        <ArrowLeft size={14} />
                        {t('Volver al cuaderno')}
                      </button>
                    )}
                  </>
                )}
              </EmptyLeaves>
            )}
            {/* Leyendo, las franjas de los bordes pasan página; escribiendo no hay: los clics son del cursor. */}
            {/* En la última página la franja de avanzar sigue estando: lleva a la contratapa. */}
            {sheet && size.width > 0 && writingId === null && <TurnZones geometry={geometry} canGoOn={canGoOn || done} />}
            <Presence show={notice !== null}>
              {(leaving) => (
                <div className={`toast${leaving ? ' leaving' : ''}`} role="status">
                  {shownNotice.current}
                </div>
              )}
            </Presence>
          </div>
        )}
      </div>
      <SheetMapModal
        open={mapOpen}
        onClose={() => setMapOpen(false)}
        sheets={sheets}
        currentIndex={pos.sheet}
        categories={props.categories}
        onSelectSheet={(index) => {
          void finishWriting();
          setPos({ sheet: index, page: 0 });
        }}
      />
      {/* Agarraderas del modo tamaño (Mayús apretada): bordes y esquinas del cuaderno. */}
      {GRIPS.map((grip) => (
        <div key={grip} className={`grip ${grip}`} onPointerDown={(event) => props.onStretch(grip, event)} />
      ))}
    </div>
  );
}
