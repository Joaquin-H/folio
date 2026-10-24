import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Book, Check, FileText, Mic, Minimize2, NotebookPen, Pin, Trash2 } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, isTauri } from '../api';
import { dayHeading, extensionOf, stemOf, timeOf, titleFromContent } from '../format';
import { usePrefs } from '../hooks';
import { useT } from '../i18n';
import { describe, hintOf, matches, useShortcuts } from '../shortcuts';
import { playKeySound } from '../sounds';
import type { Category, FloatingRect, SheetDetail } from '../types';
import { Menu, type MenuItem } from './ui';

const closeWindow = () => {
  if (isTauri) void getCurrentWindow().close();
};

/** Cuánto espera «Descartar» el segundo clic antes de volver a ser un botón común. */
const DISCARD_WAIT = 4000;

/**
 * Hoja suelta: se abre con el atajo global desde cualquier programa, siempre encima de
 * las demás ventanas, y se ve como una hoja del cuaderno. Nace con un título con la
 * fecha, que se puede cambiar ahí mismo. Como en el Bloc de notas, lo escrito no se
 * pierde: cerrarla la guarda en el cuaderno, salvo que se la descarte. Y descartarla con
 * algo escrito pide un segundo clic, para que no pase por error.
 */
export function CaptureWindow() {
  const t = useT();
  // La hoja usa la letra elegida para el cuaderno (también si se cambia con la hoja abierta),
  // y muestra los atajos vigentes.
  usePrefs();
  useShortcuts();

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('folio:capture:collapsed') === 'true';
    } catch {
      return false;
    }
  });

  const [pinned, setPinned] = useState(() => {
    try {
      return localStorage.getItem('folio:capture:pinned') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    document.title = collapsed ? t('Hoja suelta') : t('Nueva hoja');
  }, [t, collapsed]);

  const born = useMemo(() => Date.now(), []);
  const [title, setTitle] = useState<string>(() => {
    try {
      const draft = localStorage.getItem('folio:capture:draft');
      if (draft) return String(JSON.parse(draft).title ?? '');
    } catch {}
    return '';
  });
  const [text, setText] = useState<string>(() => {
    try {
      const draft = localStorage.getItem('folio:capture:draft');
      if (draft) return String(JSON.parse(draft).text ?? '');
    } catch {}
    return '';
  });
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState<number | null>(() => {
    try {
      const draft = localStorage.getItem('folio:capture:draft');
      if (draft) return JSON.parse(draft).categoryId ?? null;
    } catch {}
    return null;
  });
  const [noteFormat, setNoteFormat] = useState<'txt' | 'md'>('txt');
  useEffect(() => {
    void api.getSettings().then((s) => setNoteFormat(s.noteFormat ?? 'txt')).catch(() => {});
  }, []);
  useEffect(() => {
    const loadCategories = () => {
      void api
        .getOverview()
        .then((overview) => setCategories(overview.categories))
        .catch(() => {});
    };
    loadCategories();
    return api.onChanged(loadCategories);
  }, []);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Se tocó «Descartar» con texto escrito: falta el segundo clic que lo confirma. */
  const [discarding, setDiscarding] = useState(false);
  const busy = useRef(false);
  /** El guardado que está en camino (con el botón o el atajo), para esperarlo antes de cerrar. */
  const saving = useRef<Promise<boolean> | null>(null);
  /** La hoja ya se guardó o se descartó a propósito: al cerrarse la ventana no queda nada por hacer. */
  const settled = useRef(false);
  const latest = useRef({ title, text, categoryId });
  latest.current = { title, text, categoryId };

  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const discardingRef = useRef(discarding);
  discardingRef.current = discarding;

  useEffect(() => {
    if (text || title || categoryId !== null) {
      try {
        localStorage.setItem('folio:capture:draft', JSON.stringify({ title, text, categoryId }));
      } catch {}
    } else {
      try {
        localStorage.removeItem('folio:capture:draft');
      } catch {}
    }
  }, [title, text, categoryId]);
  const heading = dayHeading(born);
  const saveHint = hintOf('capture-save');
  const saveKeys = describe('capture-save');
  const category = categories.find((c) => c.id === categoryId);
  const categoryItems: MenuItem[] = useMemo(
    () => [
      ...categories.map((c) => ({
        label: c.name,
        icon: <span className="dot" style={{ background: c.color }} />,
        checked: c.id === categoryId,
        onSelect: () => setCategoryId(c.id),
      })),
      {
        label: t('Sin categoría'),
        separator: true,
        checked: categoryId === null,
        onSelect: () => setCategoryId(null),
      },
    ],
    [categories, categoryId, t],
  );

  const finish = useCallback(
    (how: 'save' | 'notepad' | 'discard') => {
      if (busy.current) return;
      if (how === 'discard' || !text.trim()) {
        settled.current = true;
        try {
          localStorage.removeItem('folio:capture:draft');
          localStorage.removeItem('folio:capture:collapsed');
        } catch {}
        return closeWindow();
      }
      busy.current = true;
      const finalTitle = title.trim() || titleFromContent(text) || t('Sin título');
      saving.current = api
        .createNote(finalTitle, text, categoryId ?? undefined, how === 'notepad')
        .then(() => {
          settled.current = true;
          try {
            localStorage.removeItem('folio:capture:draft');
            localStorage.removeItem('folio:capture:collapsed');
          } catch {}
          closeWindow();
          return true;
        })
        .catch((reason) => {
          busy.current = false;
          setError(String(reason));
          return false;
        });
    },
    [title, text, categoryId, t],
  );

  /**
   * Guarda lo escrito si hay algo y todavía no se guardó (si ya se está guardando, espera
   * a que termine). Devuelve `false` si no se pudo, y dice por qué en la hoja: así quien la
   * cierra sabe que no tiene que seguir.
   */
  const saveWritten = useCallback(async () => {
    if (settled.current) return true;
    if (saving.current) return saving.current;
    const { title: name, text: written, categoryId: chosenCategory } = latest.current;
    if (busy.current || !written.trim()) return true;
    busy.current = true;
    try {
      const finalTitle = name.trim() || titleFromContent(written) || t('Sin título');
      await api.createNote(finalTitle, written, chosenCategory ?? undefined);
      settled.current = true;
      try {
        localStorage.removeItem('folio:capture:draft');
        localStorage.removeItem('folio:capture:collapsed');
      } catch {}
      return true;
    } catch (reason) {
      busy.current = false;
      setError(String(reason));
      return false;
    }
  }, [t]);

  const [floatingRect, setFloatingRect] = useState<FloatingRect | null>(null);

  const expand = useCallback(async () => {
    try {
      let prefX: number | undefined;
      let prefY: number | undefined;
      if (!isTauri) {
        try {
          const savedDock = localStorage.getItem('folio:capture:pos:collapsed');
          if (savedDock) {
            const parsed = JSON.parse(savedDock);
            if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
              prefX = parsed.x;
              prefY = parsed.y;
            }
          }
        } catch {}
      } else {
        try {
          const win = getCurrentWindow();
          const pos = await win.outerPosition();
          const scale = await win.scaleFactor();
          const logX = scale > 0 ? pos.x / scale : pos.x;
          const logY = scale > 0 ? pos.y / scale : pos.y;
          localStorage.setItem(
            'folio:capture:pos:collapsed',
            JSON.stringify({ x: Math.round(logX), y: Math.round(logY) }),
          );
        } catch {}
      }
      const rect = await api.setFloatingMode(false, prefX, prefY);
      setFloatingRect(rect);
      try {
        localStorage.setItem('folio:capture:pos:expanded', JSON.stringify({ x: rect.x, y: rect.y }));
      } catch {}
    } catch (err) {
      console.error('No se pudo expandir la hoja suelta:', err);
    }
    setCollapsed(false);
    try {
      localStorage.setItem('folio:capture:collapsed', 'false');
    } catch {}
    setTimeout(() => areaRef.current?.focus(), 60);
  }, []);

  const collapse = useCallback(async () => {
    if (busy.current || settled.current) return;
    try {
      let prefX: number | undefined;
      let prefY: number | undefined;
      if (isTauri) {
        try {
          const win = getCurrentWindow();
          const pos = await win.outerPosition();
          const scale = await win.scaleFactor();
          const logX = scale > 0 ? pos.x / scale : pos.x;
          const logY = scale > 0 ? pos.y / scale : pos.y;
          localStorage.setItem(
            'folio:capture:pos:expanded',
            JSON.stringify({ x: Math.round(logX), y: Math.round(logY) }),
          );
        } catch {}
      }
      try {
        const savedDock = localStorage.getItem('folio:capture:pos:collapsed');
        if (savedDock) {
          const parsed = JSON.parse(savedDock);
          if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            prefX = parsed.x;
            prefY = parsed.y;
          }
        }
      } catch {}
      const rect = await api.setFloatingMode(true, prefX, prefY);
      setFloatingRect(rect);
      try {
        localStorage.setItem('folio:capture:pos:collapsed', JSON.stringify({ x: rect.x, y: rect.y }));
      } catch {}
    } catch (err) {
      console.error('No se pudo colapsar la hoja suelta:', err);
    }
    setCollapsed(true);
    try {
      localStorage.setItem('folio:capture:collapsed', 'true');
    } catch {}
  }, []);

  const togglePin = () => {
    setPinned((curr) => {
      const next = !curr;
      try {
        localStorage.setItem('folio:capture:pinned', String(next));
      } catch {}
      return next;
    });
  };

  useEffect(() => {
    const initWindow = async () => {
      try {
        const key = collapsedRef.current ? 'folio:capture:pos:collapsed' : 'folio:capture:pos:expanded';
        const saved = localStorage.getItem(key);
        let px: number | undefined;
        let py: number | undefined;
        if (saved) {
          const parsed = JSON.parse(saved);
          if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            px = parsed.x;
            py = parsed.y;
          }
        }
        const rect = await api.setFloatingMode(collapsedRef.current, px, py);
        setFloatingRect(rect);
      } catch {}
    };
    void initWindow();
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let timer: number | null = null;
    const unlisten = getCurrentWindow().onMoved(async ({ payload: pos }) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const win = getCurrentWindow();
          const scale = await win.scaleFactor();
          const logX = scale > 0 ? pos.x / scale : pos.x;
          const logY = scale > 0 ? pos.y / scale : pos.y;
          const key = collapsedRef.current ? 'folio:capture:pos:collapsed' : 'folio:capture:pos:expanded';
          localStorage.setItem(key, JSON.stringify({ x: Math.round(logX), y: Math.round(logY) }));
        } catch {}
      }, 250);
    });
    return () => {
      if (timer) window.clearTimeout(timer);
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let blurTimer: number | null = null;
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        if (blurTimer) {
          window.clearTimeout(blurTimer);
          blurTimer = null;
        }
      } else {
        if (!pinnedRef.current && !collapsedRef.current && !discardingRef.current && !busy.current) {
          blurTimer = window.setTimeout(() => {
            if (!pinnedRef.current && !collapsedRef.current && !discardingRef.current && !busy.current) {
              void collapse();
            }
          }, 200);
        }
      }
    });
    return () => {
      if (blurTimer) window.clearTimeout(blurTimer);
      void unlisten.then((stop) => stop());
    };
  }, [collapse]);

  // Si la ventana se cierra por otro lado (Alt + F4), lo escrito se guarda igual: el pie
  // dice que al cerrarla queda en el cuaderno. Tauri espera a que esto termine antes de
  // cerrarla; si no se pudo guardar, la ventana se queda abierta y dice por qué.
  useEffect(() => {
    if (!isTauri) return;
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await saveWritten())) event.preventDefault();
    });
    return () => void unlisten.then((stop) => stop());
  }, [saveWritten]);

  // «Salir» desde la bandeja cierra Book sin pasar por esta ventana: lo escrito se guarda
  // antes (si no se puede, el backend cierra igual cuando esto termina).
  useEffect(() => api.onQuitRequested(async () => void (await saveWritten())), [saveWritten]);

  // Cuando se envía lo seleccionado desde otro programa con el destino «Abrir en hoja suelta»,
  // el texto y su encabezado de origen llegan por acá: si la hoja estaba vacía, nacen ahí; si
  // ya había algo escrito, se suman al final separados por una línea en blanco, igual que en
  // la hoja del día.
  useEffect(() => {
    const pullSeed = () => {
      void api.takeCaptureSeed().then((seed) => {
        if (!seed) return;
        const entry = [seed.origin, seed.text].filter(Boolean).join('\n');
        if (!entry) return;
        setText((current) => {
          const kept = current.replace(/\n+$/, '');
          return kept.trim() ? `${kept}\n\n${entry}` : entry;
        });
        setCategoryId((prev) => {
          if (prev === null) {
            void api.ensureClippingsCategory().then((id) => {
              setCategoryId((current) => (current === null ? id : current));
            }).catch(() => {});
          }
          return prev;
        });
        setDiscarding(false);
        if (collapsedRef.current) {
          void expand();
        }
      });
    };
    pullSeed();
    return api.onCaptureSeed(pullSeed);
  }, [expand]);

  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const wasDraggedRef = useRef(false);
  const windowStartPosRef = useRef<{ x: number; y: number } | null>(null);

  const handleDockPointerDown = async (e: React.PointerEvent) => {
    pointerStartRef.current = { x: e.screenX, y: e.screenY };
    wasDraggedRef.current = false;
    if (isTauri) {
      try {
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        windowStartPosRef.current = { x: pos.x, y: pos.y };
      } catch {}
    }
  };

  const handleDockPointerMove = (e: React.PointerEvent) => {
    if (pointerStartRef.current) {
      const dist = Math.hypot(e.screenX - pointerStartRef.current.x, e.screenY - pointerStartRef.current.y);
      if (dist > 5) {
        wasDraggedRef.current = true;
      }
    }
  };

  const handleDockClick = async (e: React.MouseEvent) => {
    if (wasDraggedRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (isTauri && windowStartPosRef.current) {
      try {
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        const dx = Math.abs(pos.x - windowStartPosRef.current.x);
        const dy = Math.abs(pos.y - windowStartPosRef.current.y);
        if (dx > 4 || dy > 4) {
          return;
        }
      } catch {}
    }
    void expand();
  };

  const discard = () => {
    // Sin nada escrito no hay nada que perder: se cierra directo.
    if (discarding || !text.trim()) return finish('discard');
    setDiscarding(true);
  };

  // Si el segundo clic no llega, «Descartar» vuelve a ser un botón común.
  useEffect(() => {
    if (!discarding) return;
    const timer = window.setTimeout(() => setDiscarding(false), DISCARD_WAIT);
    return () => window.clearTimeout(timer);
  }, [discarding]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Esc primero se arrepiente del descarte; si no había ninguno, guarda y cierra
      // (como los demás atajos de guardar, que salen de shortcuts.ts; Ctrl + Alt es AltGr y no cuenta).
      if (event.key === 'Escape' && discarding) {
        event.preventDefault();
        setDiscarding(false);
      } else if (matches(event, 'capture-save')) {
        event.preventDefault();
        finish('save');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [finish, discarding]);

  if (collapsed) {
    const hasContent = Boolean(text.trim() || title.trim());
    const preview = title.trim() || titleFromContent(text);
    const dockTooltip = hasContent
      ? `${t('Hoja suelta')}${preview ? `: ${preview}` : ''}\n${t('Clic para expandir')}`
      : `${t('Hoja suelta')}\n${t('Clic para expandir')}`;

    return (
      <div
        className="loose-dock"
        data-tauri-drag-region
        data-floating-x={floatingRect?.x}
        data-floating-y={floatingRect?.y}
        onPointerDown={handleDockPointerDown}
        onPointerMove={handleDockPointerMove}
        onClick={handleDockClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void expand();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={t('Expandir hoja suelta')}
        title={dockTooltip}
      >
        <div className="loose-dock-inner" data-tauri-drag-region>
          <FileText size={20} className="loose-dock-icon" />
          {hasContent && <span className="loose-dock-badge" aria-hidden="true" />}
        </div>
      </div>
    );
  }

  return (
    <div className="loose" data-floating-x={floatingRect?.x} data-floating-y={floatingRect?.y}>
      <header className="loose-head capture-head" data-tauri-drag-region>
        <div className="page-date" data-tauri-drag-region>
          <span data-tauri-drag-region>
            {heading.title}, {heading.subtitle}
          </span>
          <div className="capture-head-tools" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {(() => {
              const dictationLabel = /Win/i.test(navigator.userAgent) ? t('Dictar con la voz (Win + H)') : t('Dictar con la voz');
              return (
                <button
                  type="button"
                  className="icon-button icon-btn small dict-btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    areaRef.current?.focus();
                    void api.startDictation().catch(() => {});
                  }}
                  aria-label={dictationLabel}
                  title={dictationLabel}
                >
                  <Mic size={14} />
                </button>
              );
            })()}
            <button
              type="button"
              className={`icon-button icon-btn small capture-pin-btn${pinned ? ' pinned' : ''}`}
              onClick={togglePin}
              aria-label={pinned ? t('Desfijar hoja (se colapsa al cambiar de ventana)') : t('Fijar expandida')}
              title={
                pinned
                  ? t('Desfijar hoja (se colapsa al cambiar de ventana)')
                  : t('Fijar expandida para comparar con otras ventanas')
              }
            >
              <Pin size={13} />
            </button>
            <button
              type="button"
              className="icon-button icon-btn small capture-collapse-btn dock-collapse"
              onClick={() => void collapse()}
              aria-label={t('Colapsar hoja')}
              title={t('Colapsar en el dock')}
            >
              <Minimize2 size={13} />
            </button>
            <time dateTime={new Date(born).toISOString()}>{timeOf(born)}</time>
          </div>
        </div>
        <label className="page-title editable" title={t('Cambiar el título de la hoja')}>
          <input
            value={title}
            maxLength={80}
            spellCheck={false}
            aria-label={t('Título de la hoja')}
            placeholder={titleFromContent(text) || t('Sin título')}
            onChange={(event) => setTitle(event.target.value)}
          />
          <span>.{noteFormat}</span>
        </label>
        <div className="page-meta loose-meta">
          <Menu
            label={t('Cambiar la categoría de esta hoja')}
            heading={t('Categoría de esta hoja')}
            align="left"
            className={`chip${category ? '' : ' unset'}`}
            items={categoryItems}
            trigger={
              category ? (
                <>
                  <span className="dot" style={{ background: category.color }} />
                  {category.name}
                </>
              ) : (
                t('Sin categoría')
              )
            }
          />
        </div>
      </header>
      <textarea
        ref={areaRef}
        className="loose-text"
        autoFocus
        value={text}
        spellCheck={false}
        placeholder={t('Escribí acá…')}
        aria-label={t('Texto de la hoja')}
        onKeyDown={(event) => {
          playKeySound(event);
        }}
        onChange={(event) => {
          setText(event.target.value);
          setDiscarding(false);
        }}
      />
      {error && <p className="form-error">{error}</p>}
      <footer className="loose-foot">
        {discarding ? (
          <span key="discard" className="loose-hint warn" role="status">
            {t('¿Descartar lo escrito? Tocá otra vez')}
          </span>
        ) : (
          <span
            key="save"
            className="loose-hint"
            title={
              saveKeys
                ? t('Al cerrarla, la hoja queda guardada en el cuaderno. También con el botón de la derecha o con {saveKeys}.', { saveKeys })
                : t('Al cerrarla, la hoja queda guardada en el cuaderno. También con el botón de la derecha.')
            }
          >
            {saveHint ? (
              <>
                <kbd>{saveHint}</kbd> {t('guarda y cierra')}
              </>
            ) : (
              t('Al cerrarla, queda guardada')
            )}
          </span>
        )}
        <span className="loose-actions">
          <button
            type="button"
            className={`icon-button${discarding ? ' armed' : ''}`}
            onClick={discard}
            aria-label={discarding ? t('Confirmar: descartar lo escrito') : t('Descartar')}
            title={discarding ? t('Tocá de nuevo para descartar lo escrito') : t('Descartar sin guardar')}
          >
            <Trash2 size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => finish('notepad')}
            disabled={!text.trim()}
            aria-label={t('Guardar y seguir en el Bloc de notas')}
            title={t('Guardar y seguir en el Bloc de notas')}
          >
            <NotebookPen size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => finish('save')}
            aria-label={t('Guardar y cerrar')}
            title={saveKeys ? t('Guardar y cerrar ({saveKeys})', { saveKeys }) : t('Guardar y cerrar')}
          >
            <Check size={16} />
          </button>
        </span>
      </footer>
    </div>
  );
}

/** La hoja vive en la carpeta donde Book guarda lo que se escribe en él. */
function inNotesDir(path: string | null, folder: string): boolean {
  if (!path || !folder) return false;
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut > 0 && path.slice(0, cut).toLowerCase() === folder.toLowerCase();
}

/**
 * Hoja arrancada del cuaderno («Arrancar hoja»): se abre en su propia ventana flotante,
 * siempre encima de las demás, colapsable a un ícono en el dock, con botón de pin,
 * editable con guardado automático y un botón «Devolver al cuaderno» para guardarla
 * y cerrar la ventana flotante.
 */
export function TearOffWindow() {
  const t = useT();
  usePrefs();
  useShortcuts();

  const sheetId = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get('id');
    return raw ? Number(raw) : 0;
  }, []);

  const storagePrefix = `folio:tearoff:${sheetId}`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(`${storagePrefix}:collapsed`) === 'true';
    } catch {
      return false;
    }
  });
  const [pinned, setPinned] = useState(() => {
    try {
      return localStorage.getItem(`${storagePrefix}:pinned`) === 'true';
    } catch {
      return false;
    }
  });

  const [detail, setDetail] = useState<SheetDetail | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [notesDir, setNotesDir] = useState('');
  const [status, setStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [error, setError] = useState<string | null>(null);
  const [floatingRect, setFloatingRect] = useState<FloatingRect | null>(null);
  const [returned, setReturned] = useState(false);

  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const dirtyRef = useRef(false);
  const baseHashRef = useRef<string | undefined>(undefined);
  const saveTimerRef = useRef<number | null>(null);
  const savingPromiseRef = useRef<Promise<boolean> | null>(null);
  const latestRef = useRef({ title: '', text: '', renamable: false });
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const renamable = Boolean(detail && detail.source === 'file' && inNotesDir(detail.path, notesDir));
  const editable = Boolean(detail && !detail.hidden && !detail.missing && (detail.source === 'file' || detail.source === 'capture'));
  latestRef.current = { title, text, renamable };

  useEffect(() => {
    const displayTitle = title.trim() || detail?.title || t('Hoja flotante');
    document.title = displayTitle;
  }, [title, detail?.title, t]);

  const loadData = useCallback(() => {
    if (!sheetId) return;
    void api
      .getOverview()
      .then((ov) => {
        setCategories(ov.categories);
        setNotesDir(ov.notesDir);
      })
      .catch(() => {});
    void api
      .getSheet(sheetId)
      .then((loaded) => {
        if (!loaded) return;
        setDetail(loaded);
        if (!dirtyRef.current) {
          setTitle(stemOf(loaded.title));
          setText(loaded.content);
          baseHashRef.current = loaded.hash;
        }
      })
      .catch((reason) => setError(String(reason)));
  }, [sheetId]);

  useEffect(() => {
    loadData();
    return api.onChanged(loadData);
  }, [loadData]);

  // Sincronizar estado inicial desde `listTornOffSheets` (por si se restauró colapsada o fijada).
  useEffect(() => {
    if (!sheetId) return;
    void api
      .listTornOffSheets()
      .then(async (list) => {
        const entry = list.find((item) => item.id === sheetId);
        const initCollapsed = entry ? entry.collapsed : collapsedRef.current;
        const initPinned = entry ? entry.pinned : pinnedRef.current;
        setCollapsed(initCollapsed);
        setPinned(initPinned);
        try {
          localStorage.setItem(`${storagePrefix}:collapsed`, String(initCollapsed));
          localStorage.setItem(`${storagePrefix}:pinned`, String(initPinned));
        } catch {}
        const px = initCollapsed ? (entry?.collapsedX ?? undefined) : (entry?.expandedX ?? undefined);
        const py = initCollapsed ? (entry?.collapsedY ?? undefined) : (entry?.expandedY ?? undefined);
        const rect = await api.setFloatingMode(initCollapsed, px, py);
        setFloatingRect(rect);
      })
      .catch(() => {});
  }, [sheetId, storagePrefix]);

  const flushSave = useCallback(async (): Promise<boolean> => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!dirtyRef.current || !sheetId || !editable) return true;
    if (savingPromiseRef.current) return savingPromiseRef.current;

    const { title: currentTitle, text: currentText, renamable: canRename } = latestRef.current;
    setStatus('saving');
    setError(null);
    const promise = api
      .saveSheet(sheetId, currentText, {
        title: canRename && currentTitle.trim() ? currentTitle.trim() : undefined,
        baseHash: baseHashRef.current,
        force: true,
      })
      .then((saved) => {
        baseHashRef.current = saved.hash;
        setDetail(saved);
        dirtyRef.current = false;
        setStatus('saved');
        savingPromiseRef.current = null;
        return true;
      })
      .catch((reason) => {
        setStatus('error');
        setError(String(reason));
        savingPromiseRef.current = null;
        return false;
      });
    savingPromiseRef.current = promise;
    return promise;
  }, [sheetId, editable]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    setStatus('saving');
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void flushSave();
    }, 450);
  }, [flushSave]);

  const expand = useCallback(async () => {
    try {
      let prefX: number | undefined;
      let prefY: number | undefined;
      if (!isTauri) {
        try {
          const savedDock = localStorage.getItem(`${storagePrefix}:pos:collapsed`);
          if (savedDock) {
            const parsed = JSON.parse(savedDock);
            if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
              prefX = parsed.x;
              prefY = parsed.y;
            }
          }
        } catch {}
      } else {
        try {
          const win = getCurrentWindow();
          const pos = await win.outerPosition();
          const scale = await win.scaleFactor();
          const logX = scale > 0 ? pos.x / scale : pos.x;
          const logY = scale > 0 ? pos.y / scale : pos.y;
          localStorage.setItem(
            `${storagePrefix}:pos:collapsed`,
            JSON.stringify({ x: Math.round(logX), y: Math.round(logY) }),
          );
        } catch {}
      }
      const rect = await api.setFloatingMode(false, prefX, prefY);
      setFloatingRect(rect);
      try {
        localStorage.setItem(`${storagePrefix}:pos:expanded`, JSON.stringify({ x: rect.x, y: rect.y }));
      } catch {}
    } catch (err) {
      console.error('No se pudo expandir la hoja flotante:', err);
    }
    setCollapsed(false);
    try {
      localStorage.setItem(`${storagePrefix}:collapsed`, 'false');
    } catch {}
    setTimeout(() => areaRef.current?.focus(), 60);
  }, [storagePrefix]);

  const collapse = useCallback(async () => {
    await flushSave();
    try {
      let prefX: number | undefined;
      let prefY: number | undefined;
      if (isTauri) {
        try {
          const win = getCurrentWindow();
          const pos = await win.outerPosition();
          const scale = await win.scaleFactor();
          const logX = scale > 0 ? pos.x / scale : pos.x;
          const logY = scale > 0 ? pos.y / scale : pos.y;
          localStorage.setItem(
            `${storagePrefix}:pos:expanded`,
            JSON.stringify({ x: Math.round(logX), y: Math.round(logY) }),
          );
        } catch {}
      }
      try {
        const savedDock = localStorage.getItem(`${storagePrefix}:pos:collapsed`);
        if (savedDock) {
          const parsed = JSON.parse(savedDock);
          if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            prefX = parsed.x;
            prefY = parsed.y;
          }
        }
      } catch {}
      const rect = await api.setFloatingMode(true, prefX, prefY);
      setFloatingRect(rect);
      try {
        localStorage.setItem(`${storagePrefix}:pos:collapsed`, JSON.stringify({ x: rect.x, y: rect.y }));
      } catch {}
    } catch (err) {
      console.error('No se pudo colapsar la hoja flotante:', err);
    }
    setCollapsed(true);
    try {
      localStorage.setItem(`${storagePrefix}:collapsed`, 'true');
    } catch {}
  }, [flushSave, storagePrefix]);

  const togglePin = () => {
    setPinned((curr) => {
      const next = !curr;
      try {
        localStorage.setItem(`${storagePrefix}:pinned`, String(next));
      } catch {}
      void api.updateTornOffState(sheetId, { pinned: next }).catch(() => {});
      return next;
    });
  };

  const returnToNotebook = useCallback(async () => {
    const ok = await flushSave();
    if (!ok) return;
    await api.returnTornOffSheet(sheetId);
    setReturned(true);
    closeWindow();
  }, [flushSave, sheetId]);

  useEffect(() => {
    if (!isTauri) return;
    const unlisten = listen<boolean>('book:tearoff-mode', ({ payload: targetCollapsed }) => {
      if (targetCollapsed && !collapsedRef.current) {
        void collapse();
      } else if (!targetCollapsed && collapsedRef.current) {
        void expand();
      }
    });
    return () => void unlisten.then((stop) => stop());
  }, [collapse, expand]);

  useEffect(() => {
    if (!isTauri) return;
    let timer: number | null = null;
    const unlisten = getCurrentWindow().onMoved(async ({ payload: pos }) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const win = getCurrentWindow();
          const scale = await win.scaleFactor();
          const logX = Math.round(scale > 0 ? pos.x / scale : pos.x);
          const logY = Math.round(scale > 0 ? pos.y / scale : pos.y);
          const key = collapsedRef.current ? `${storagePrefix}:pos:collapsed` : `${storagePrefix}:pos:expanded`;
          localStorage.setItem(key, JSON.stringify({ x: logX, y: logY }));
          void api.updateTornOffState(sheetId, { x: logX, y: logY }).catch(() => {});
        } catch {}
      }, 250);
    });
    return () => {
      if (timer) window.clearTimeout(timer);
      void unlisten.then((stop) => stop());
    };
  }, [sheetId, storagePrefix]);

  useEffect(() => {
    if (!isTauri) return;
    let blurTimer: number | null = null;
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        if (blurTimer) {
          window.clearTimeout(blurTimer);
          blurTimer = null;
        }
      } else {
        void flushSave();
        if (!pinnedRef.current && !collapsedRef.current) {
          blurTimer = window.setTimeout(() => {
            if (!pinnedRef.current && !collapsedRef.current) {
              void collapse();
            }
          }, 200);
        }
      }
    });
    return () => {
      if (blurTimer) window.clearTimeout(blurTimer);
      void unlisten.then((stop) => stop());
    };
  }, [collapse, flushSave]);

  useEffect(() => {
    if (!isTauri) return;
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await flushSave())) {
        event.preventDefault();
        return;
      }
      await api.returnTornOffSheet(sheetId).catch(() => {});
    });
    return () => void unlisten.then((stop) => stop());
  }, [flushSave, sheetId]);

  useEffect(() => api.onQuitRequested(async () => void (await flushSave())), [flushSave]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void flushSave();
      } else if (matches(event, 'capture-save')) {
        event.preventDefault();
        void returnToNotebook();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [flushSave, returnToNotebook]);

  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const wasDraggedRef = useRef(false);
  const windowStartPosRef = useRef<{ x: number; y: number } | null>(null);

  const handleDockPointerDown = async (e: React.PointerEvent) => {
    pointerStartRef.current = { x: e.screenX, y: e.screenY };
    wasDraggedRef.current = false;
    if (isTauri) {
      try {
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        windowStartPosRef.current = { x: pos.x, y: pos.y };
      } catch {}
    }
  };

  const handleDockPointerMove = (e: React.PointerEvent) => {
    if (pointerStartRef.current) {
      const dist = Math.hypot(e.screenX - pointerStartRef.current.x, e.screenY - pointerStartRef.current.y);
      if (dist > 5) {
        wasDraggedRef.current = true;
      }
    }
  };

  const handleDockClick = async (e: React.MouseEvent) => {
    if (wasDraggedRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (isTauri && windowStartPosRef.current) {
      try {
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        const dx = Math.abs(pos.x - windowStartPosRef.current.x);
        const dy = Math.abs(pos.y - windowStartPosRef.current.y);
        if (dx > 4 || dy > 4) {
          return;
        }
      } catch {}
    }
    void expand();
  };

  const category = categories.find((c) => c.id === detail?.categoryId);
  const categoryItems: MenuItem[] = useMemo(
    () => [
      ...categories.map((c) => ({
        label: c.name,
        icon: <span className="dot" style={{ background: c.color }} />,
        checked: c.id === detail?.categoryId,
        onSelect: () => {
          if (sheetId) void api.setSheetCategory(sheetId, c.id);
        },
      })),
      {
        label: t('Sin categoría'),
        separator: true,
        checked: (detail?.categoryId ?? null) === null,
        onSelect: () => {
          if (sheetId) void api.setSheetCategory(sheetId, null);
        },
      },
    ],
    [categories, detail?.categoryId, sheetId, t],
  );

  if (returned) {
    return (
      <div className="loose returned" data-returned="true">
        <p className="loose-hint" style={{ padding: '24px 62px' }}>
          {t('Devuelta al cuaderno')}
        </p>
      </div>
    );
  }

  if (collapsed) {
    const preview = title.trim() || detail?.title || titleFromContent(text);
    const dockTooltip = `${preview || t('Hoja flotante')}\n${t('Clic para expandir')}`;
    return (
      <div
        className="loose-dock tearoff-dock"
        data-tauri-drag-region
        data-sheet-id={sheetId}
        data-floating-x={floatingRect?.x}
        data-floating-y={floatingRect?.y}
        onPointerDown={handleDockPointerDown}
        onPointerMove={handleDockPointerMove}
        onClick={handleDockClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void expand();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={t('Expandir hoja suelta')}
        title={dockTooltip}
      >
        <div className="loose-dock-inner" data-tauri-drag-region>
          <FileText size={20} className="loose-dock-icon" />
          <span className="loose-dock-badge" aria-hidden="true" />
        </div>
      </div>
    );
  }

  const ts = detail?.modifiedAt ?? Date.now();
  const heading = dayHeading(ts);
  const ext = detail ? extensionOf(detail.title) : '';

  return (
    <div
      className="loose tearoff-sheet"
      data-sheet-id={sheetId}
      data-floating-x={floatingRect?.x}
      data-floating-y={floatingRect?.y}
    >
      <header className="loose-head capture-head" data-tauri-drag-region>
        <div className="page-date" data-tauri-drag-region>
          <span data-tauri-drag-region>
            {heading.title}, {heading.subtitle}
          </span>
          <div className="capture-head-tools" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {editable &&
              (() => {
                const dictationLabel = /Win/i.test(navigator.userAgent)
                  ? t('Dictar con la voz (Win + H)')
                  : t('Dictar con la voz');
                return (
                  <button
                    type="button"
                    className="icon-button icon-btn small dict-btn"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      areaRef.current?.focus();
                      void api.startDictation().catch(() => {});
                    }}
                    aria-label={dictationLabel}
                    title={dictationLabel}
                  >
                    <Mic size={14} />
                  </button>
                );
              })()}
            <button
              type="button"
              className={`icon-button icon-btn small capture-pin-btn${pinned ? ' pinned' : ''}`}
              onClick={togglePin}
              aria-label={pinned ? t('Desfijar hoja (se colapsa al cambiar de ventana)') : t('Fijar expandida')}
              title={
                pinned
                  ? t('Desfijar hoja (se colapsa al cambiar de ventana)')
                  : t('Fijar expandida para comparar con otras ventanas')
              }
            >
              <Pin size={13} />
            </button>
            <button
              type="button"
              className="icon-button icon-btn small capture-collapse-btn dock-collapse"
              onClick={() => void collapse()}
              aria-label={t('Colapsar hoja')}
              title={t('Colapsar en el dock')}
            >
              <Minimize2 size={13} />
            </button>
            <time dateTime={new Date(ts).toISOString()}>{timeOf(ts)}</time>
          </div>
        </div>
        {renamable ? (
          <label className="page-title editable" title={t('Cambiar el título de la hoja')}>
            <input
              value={title}
              maxLength={80}
              spellCheck={false}
              aria-label={t('Título de la hoja')}
              placeholder={titleFromContent(text) || t('Sin título')}
              onChange={(event) => {
                setTitle(event.target.value);
                scheduleSave();
              }}
              onBlur={() => void flushSave()}
            />
            <span>{ext || '.txt'}</span>
          </label>
        ) : (
          <h2 className="page-title">{detail?.title || t('Sin título')}</h2>
        )}
        <div className="page-meta loose-meta">
          <Menu
            label={t('Cambiar la categoría de esta hoja')}
            heading={t('Categoría de esta hoja')}
            align="left"
            className={`chip${category ? '' : ' unset'}`}
            items={categoryItems}
            trigger={
              category ? (
                <>
                  <span className="dot" style={{ background: category.color }} />
                  {category.name}
                </>
              ) : (
                t('Sin categoría')
              )
            }
          />
        </div>
      </header>
      <textarea
        ref={areaRef}
        className="loose-text"
        autoFocus
        readOnly={!editable}
        value={text}
        spellCheck={false}
        placeholder={t('Escribí acá…')}
        aria-label={t('Texto de la hoja')}
        onKeyDown={(event) => {
          if (editable) playKeySound(event);
        }}
        onChange={(event) => {
          if (!editable) return;
          setText(event.target.value);
          scheduleSave();
        }}
        onBlur={() => void flushSave()}
      />
      {error && <p className="form-error">{error}</p>}
      <footer className="loose-foot">
        <span className="loose-hint" role="status">
          {status === 'saving' ? t('Guardando…') : status === 'error' ? t('No se pudo guardar') : t('Guardado')}
        </span>
        <span className="loose-actions">
          <button
            type="button"
            className="icon-button return-sheet-btn"
            onClick={() => void returnToNotebook()}
            aria-label={t('Devolver al cuaderno')}
            title={t('Devolver al cuaderno')}
          >
            <Book size={15} />
          </button>
        </span>
      </footer>
    </div>
  );
}
