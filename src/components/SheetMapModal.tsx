import { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, Search, X } from 'lucide-react';
import { dayHeading } from '../format';
import { useT } from '../i18n';
import type { Category, SheetSummary } from '../types';

const INITIAL_BATCH = 60;
const BATCH_SIZE = 60;

export function SheetMapModal(props: {
  open: boolean;
  onClose: () => void;
  sheets: SheetSummary[];
  currentIndex: number;
  categories: Category[];
  onSelectSheet: (index: number) => void;
}) {
  const t = useT();
  const { open, onClose, sheets, currentIndex, categories, onSelectSheet } = props;

  const [query, setQuery] = useState('');
  const [filterCat, setFilterCat] = useState<number | 'all' | 'none'>('all');
  const activeCardRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledRef = useRef(false);

  // Mapeo rápido de categorías por ID
  const catMap = useMemo(() => {
    const map = new Map<number, Category>();
    for (const c of categories) map.set(c.id, c);
    return map;
  }, [categories]);

  // Hojas filtradas para la grilla combinando categoría y buscador
  const visibleSheets = useMemo(() => {
    const q = query.trim().toLowerCase();
    const isNumSearch = /^(?:#|\b)?(\d+)\b/.exec(q);
    const targetSheetNum = isNumSearch ? parseInt(isNumSearch[1], 10) : null;

    return sheets
      .map((sheet, index) => ({ sheet, index }))
      .filter(({ sheet, index }) => {
        if (filterCat !== 'all') {
          if (filterCat === 'none' && sheet.categoryId !== null) return false;
          if (filterCat !== 'none' && sheet.categoryId !== filterCat) return false;
        }

        if (!q) return true;

        if (targetSheetNum !== null && index + 1 === targetSheetNum) return true;
        if (sheet.title.toLowerCase().includes(q)) return true;
        if (sheet.preview.toLowerCase().includes(q)) return true;

        const cat = sheet.categoryId !== null ? catMap.get(sheet.categoryId) : undefined;
        if (cat && cat.name.toLowerCase().includes(q)) return true;

        return false;
      });
  }, [sheets, filterCat, query, catMap]);

  // Cantidad inicial de tarjetas para que la tarjeta activa esté renderizada al abrir
  const defaultCount = useMemo(() => {
    if (query.trim()) return INITIAL_BATCH;
    const activeVisibleIndex = visibleSheets.findIndex((item) => item.index === currentIndex);
    if (activeVisibleIndex >= 0) {
      return Math.max(INITIAL_BATCH, activeVisibleIndex + 20);
    }
    return INITIAL_BATCH;
  }, [query, currentIndex, visibleSheets]);

  const [renderedCount, setRenderedCount] = useState(INITIAL_BATCH);

  // Al cambiar el default (por cambio en búsqueda, categoría o lista de hojas), reseteamos renderedCount
  useEffect(() => {
    setRenderedCount(defaultCount);
  }, [defaultCount]);

  // Carga incremental al hacer scroll hacia el final
  const hasMore = renderedCount < visibleSheets.length;

  useEffect(() => {
    if (!open || !hasMore) return;
    const sentinel = sentinelRef.current;
    const body = bodyRef.current;
    if (!sentinel || !body) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setRenderedCount((prev) => Math.min(visibleSheets.length, prev + BATCH_SIZE));
        }
      },
      {
        root: body,
        rootMargin: '400px',
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [open, hasMore, visibleSheets.length]);

  // Reset del indicador de scroll al cerrar el modal
  useEffect(() => {
    if (!open) {
      hasScrolledRef.current = false;
    }
  }, [open]);

  // Auto-scroll a la tarjeta activa al abrir o cambiar filtro
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      if (activeCardRef.current) {
        activeCardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        hasScrolledRef.current = true;
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [open, filterCat]);

  // Si las hojas se terminaron de cargar después del timeout inicial, scrollear una vez
  useEffect(() => {
    if (!open || hasScrolledRef.current) return;
    if (activeCardRef.current) {
      activeCardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      hasScrolledRef.current = true;
    }
  }, [open, visibleSheets]);

  // Atajos de teclado (Esc para cerrar)
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const renderedSheets = visibleSheets.slice(0, renderedCount);

  return (
    <div className="sheet-map-overlay" role="dialog" aria-modal="true" aria-label={t('Mapa del cuaderno')}>
      <div className="modal sheet-map-modal">
        {/* Encabezado del Mapa */}
        <div className="sheet-map-head">
          <div className="sheet-map-title-row">
            <div className="sheet-map-title-group">
              <Compass size={18} className="sheet-map-icon" />
              <h2>{t('Mapa del cuaderno')}</h2>
              <span className="sheet-map-total-pill">
                {t('{total} hojas', { total: sheets.length })}
              </span>
            </div>
            <button
              type="button"
              className="icon-button sheet-map-close"
              onClick={onClose}
              aria-label={t('Cerrar')}
              title={t('Cerrar (Esc)')}
            >
              <X size={16} />
            </button>
          </div>

          {/* Buscador dentro del mapa */}
          <div className="sheet-map-search-row">
            <Search size={15} className="sheet-map-search-icon" />
            <input
              type="search"
              className="sheet-map-search-input"
              placeholder={t('Buscar por título, contenido o #número…')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            {query && (
              <button
                type="button"
                className="icon-button sheet-map-clear-btn"
                onClick={() => setQuery('')}
                aria-label={t('Borrar búsqueda')}
                title={t('Borrar búsqueda')}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Filtros de categoría */}
          <div className="sheet-map-filters" role="tablist" aria-label={t('Filtrar por categoría')}>
            <button
              type="button"
              className={`sheet-map-filter-pill${filterCat === 'all' ? ' active' : ''}`}
              onClick={() => setFilterCat('all')}
            >
              {t('Todas ({total})', { total: sheets.length })}
            </button>
            {categories.map((c) => {
              const count = sheets.filter((s) => s.categoryId === c.id).length;
              if (count === 0) return null;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`sheet-map-filter-pill${filterCat === c.id ? ' active' : ''}`}
                  onClick={() => setFilterCat(c.id)}
                >
                  <span className="sheet-map-cat-dot" style={{ backgroundColor: c.color }} />
                  {c.name} ({count})
                </button>
              );
            })}
            {sheets.some((s) => s.categoryId === null) && (
              <button
                type="button"
                className={`sheet-map-filter-pill${filterCat === 'none' ? ' active' : ''}`}
                onClick={() => setFilterCat('none')}
              >
                <span className="sheet-map-cat-dot unset" />
                {t('Sin categoría')} ({sheets.filter((s) => s.categoryId === null).length})
              </button>
            )}
          </div>
        </div>

        {/* Grilla de Hojas en Miniatura */}
        <div className="sheet-map-body" ref={bodyRef}>
          {visibleSheets.length === 0 ? (
            <p className="sheet-map-empty">{t('No hay hojas que coincidan con este filtro.')}</p>
          ) : (
            <>
              <div className="sheet-map-grid">
                {renderedSheets.map(({ sheet, index }) => {
                  const isCurrent = index === currentIndex;
                  const cat = sheet.categoryId !== null ? catMap.get(sheet.categoryId) : undefined;
                  return (
                    <button
                      key={sheet.id}
                      ref={isCurrent ? activeCardRef : null}
                      type="button"
                      className={`sheet-map-card sheet-card${isCurrent ? ' current' : ''}`}
                      onClick={() => {
                        onSelectSheet(index);
                        onClose();
                      }}
                    >
                      {/* Encabezado de la tarjeta */}
                      <div className="sheet-map-card-head">
                        <span className="sheet-map-card-num">#{index + 1}</span>
                        {cat ? (
                          <span className="sheet-map-card-cat" style={{ color: cat.color }}>
                            <span className="sheet-map-cat-dot" style={{ backgroundColor: cat.color }} />
                            {cat.name}
                          </span>
                        ) : (
                          <span className="sheet-map-card-cat muted">
                            {t('Sin categoría')}
                          </span>
                        )}
                        {isCurrent && <span className="sheet-map-active-badge">{t('Actual')}</span>}
                      </div>

                      {/* Título de la nota */}
                      <div className="sheet-map-card-title" title={sheet.title}>
                        {sheet.title}
                      </div>

                      {/* Fecha */}
                      <div className="sheet-map-card-date">
                        {sheet.modifiedAt
                          ? (() => {
                              const h = dayHeading(sheet.modifiedAt);
                              return `${h.title}, ${h.subtitle}`;
                            })()
                          : ''}
                      </div>

                      {/* Vista previa / extracto de texto */}
                      <div className="sheet-map-card-preview">
                        {sheet.preview.trim() || t('Hoja sin contenido adicional')}
                      </div>
                    </button>
                  );
                })}
              </div>
              {hasMore && <div ref={sentinelRef} className="sheet-map-sentinel" aria-hidden="true" />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
