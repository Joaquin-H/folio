import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { accentFor } from './format';
import { setLanguage } from './i18n';
import { MIN_HEIGHT, PRESET_HEIGHT, textVars } from './layout';
import { setSoundsEnabled } from './sounds';
import type { ListFilter, Prefs, SheetSummary } from './types';

const PAGE = 40;

export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

const PREFS_KEY = 'book.prefs';
const DEFAULT_PREFS: Prefs = {
  theme: 'auto',
  lang: 'auto',
  cover: null,
  coverStyle: 'plain',
  tabs: true,
  spread: 'double',
  size: 'standard',
  height: PRESET_HEIGHT.standard,
  name: 'Mi cuaderno',
  sounds: true,
  textSize: 'medium',
  markdown: true,
};

export function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    const height = typeof saved.height === 'number' && saved.height >= MIN_HEIGHT ? Math.round(saved.height) : null;
    const lang = saved.lang === 'es' || saved.lang === 'en' ? saved.lang : 'auto';
    setLanguage(lang);
    return {
      theme: saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : 'auto',
      lang,
      cover: typeof saved.cover === 'string' && /^#[0-9a-f]{6}$/i.test(saved.cover) ? saved.cover : null,
      coverStyle:
        saved.coverStyle === 'spots' || saved.coverStyle === 'strap' || saved.coverStyle === 'spine' || saved.coverStyle === 'leather'
          ? saved.coverStyle
          : 'plain',
      tabs: saved.tabs !== false,
      spread: saved.spread === 'single' ? 'single' : 'double',
      size:
        saved.size === 'pocket' || saved.size === 'full' || (saved.size === 'custom' && height !== null)
          ? saved.size
          : 'standard',
      height: height ?? DEFAULT_PREFS.height,
      name: typeof saved.name === 'string' ? saved.name.slice(0, 40) : DEFAULT_PREFS.name,
      sounds: saved.sounds !== false,
      textSize: saved.textSize === 'small' || saved.textSize === 'large' || saved.textSize === 'xlarge' ? saved.textSize : 'medium',
      markdown: saved.markdown !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Variables que `applyPrefs` pone sobre el documento cuando hay una tapa de color propio. */
const COVER_VARS = ['--cover', '--accent', '--accent-soft', '--on-accent'];

/**
 * Aplica al documento el tema, el idioma, el color de tapa, el tamaño de la letra y los
 * sonidos elegidos. El acento de la interfaz sale del color de la tapa; con la tapa de
 * fábrica quedan los valores de styles.css (azul).
 */
export function applyPrefs(prefs: Prefs) {
  setLanguage(prefs.lang);
  const root = document.documentElement;
  const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.text = prefs.textSize;
  // Alto de renglón y cuerpo de la letra: los comparten las hojas, la hoja suelta y las versiones.
  Object.entries(textVars(prefs.textSize)).forEach(([name, value]) => root.style.setProperty(name, value));
  setSoundsEnabled(prefs.sounds);
  if (prefs.cover) {
    const { accent, soft, on } = accentFor(prefs.cover, dark);
    root.style.setProperty('--cover', prefs.cover);
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-soft', soft);
    root.style.setProperty('--on-accent', on);
  } else {
    COVER_VARS.forEach((name) => root.style.removeProperty(name));
  }
}

/** Preferencias de la ventana, recordadas entre sesiones. */
export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);

  useEffect(() => {
    applyPrefs(prefs);
    if (prefs.theme !== 'auto') return;
    // En automático, el cuaderno acompaña al sistema cuando cambia de claro a oscuro.
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyPrefs(prefs);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [prefs]);

  // Los ajustes viven en otra ventana: lo que se cambia allá se refleja acá al instante.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PREFS_KEY) return;
      const next = loadPrefs();
      // El idioma se cambia antes de dibujar: lo que no lo sigue por sí solo sale ya traducido.
      setLanguage(next.lang);
      setPrefs(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const update = useCallback((patch: Partial<Prefs>) => {
    if (patch.lang) setLanguage(patch.lang);
    setPrefs((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // sin almacenamiento disponible, la preferencia dura lo que dure la ventana
      }
      return next;
    });
  }, []);

  return [prefs, update] as const;
}

/**
 * Mantiene algo en pantalla un instante después de pedir que se vaya, para que pueda
 * despedirse con una transición en vez de desaparecer de golpe.
 */
export function usePresence(show: boolean, exitMs = 170) {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer);
  }, [show, exitMs]);
  return { mounted: show || mounted, leaving: !show && mounted };
}

/** Ancho actual de un elemento, para adaptar la vista cuando la ventana es angosta. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Ancho y alto actuales de un elemento. La ref es una función para que la medición
 * siga al elemento aunque React lo reemplace por otro nodo.
 */
export function useSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const measure = () => {
      const next = { width: node.offsetWidth, height: node.offsetHeight };
      setSize((current) => (current.width === next.width && current.height === next.height ? current : next));
    };
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
    measure();
  }, []);
  return [ref, size] as const;
}

/** Cierra un menú o panel al hacer clic afuera o apretar Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close();
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/**
 * Hojas del cuaderno, de la más reciente a la más antigua, cargadas de a páginas.
 * `revision` cambia cuando el backend avisa novedades: se recarga lo ya visible sin
 * perder la posición de lectura.
 */
export function useSheets(filter: ListFilter, revision: number) {
  const [items, setItems] = useState<SheetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const itemsRef = useRef<SheetSummary[]>([]);
  const request = useRef(0);
  const loadingMore = useRef(false);
  const lastKey = useRef('');
  const filterKey = JSON.stringify(filter);
  itemsRef.current = items;

  useEffect(() => {
    const isNewFilter = lastKey.current !== filterKey;
    lastKey.current = filterKey;
    const id = ++request.current;
    const limit = isNewFilter ? PAGE : Math.max(PAGE, itemsRef.current.length);
    if (isNewFilter) setLoading(true);
    api
      .listSheets({ ...filter, limit })
      .then((rows) => {
        if (id !== request.current) return;
        setItems(rows);
        setDone(rows.length < limit);
      })
      .catch(() => id === request.current && setItems([]))
      .finally(() => id === request.current && setLoading(false));
    // `filter` está representado por `filterKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, revision]);

  const loadMore = useCallback(() => {
    const last = itemsRef.current[itemsRef.current.length - 1];
    if (!last || loadingMore.current || done) return;
    loadingMore.current = true;
    const id = request.current;
    api
      .listSheets({ ...filter, beforePinned: last.pinned, beforeTs: last.modifiedAt, beforeId: last.id, limit: PAGE })
      .then((rows) => {
        if (id !== request.current) return;
        setItems((previous) => [...previous, ...rows]);
        setDone(rows.length < PAGE);
      })
      .catch(() => {})
      .finally(() => {
        loadingMore.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, done]);

  /** Trae todas las hojas que faltan y devuelve la lista completa. */
  const loadAll = useCallback(async () => {
    if (done) return itemsRef.current;
    const id = request.current;
    const all = [...itemsRef.current];
    for (;;) {
      const last = all[all.length - 1];
      const rows = await api.listSheets({
        ...filter,
        beforePinned: last?.pinned,
        beforeTs: last?.modifiedAt,
        beforeId: last?.id,
        limit: 500,
      });
      all.push(...rows);
      if (rows.length < 500) break;
    }
    if (id === request.current) {
      setItems(all);
      setDone(true);
    }
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, done]);

  return { items, loading, done, loadMore, loadAll, filterKey };
}
