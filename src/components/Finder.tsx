import type { CSSProperties } from 'react';
import { Search } from 'lucide-react';
import { count, readableOn } from '../format';
import { useT } from '../i18n';
import type { ListFilter, Overview, View } from '../types';
import { Calendar } from './Calendar';
import { Modal } from './ui';

interface Divider {
  key: string;
  view: View;
  label: string;
  count: number;
  color: string;
  /** Color del texto sobre `color`; si falta, se calcula (solo se puede con un `#RRGGBB`). */
  ink?: string;
}

const sameView = (a: View, b: View) => a.kind === b.kind && (a.kind !== 'category' || (b.kind === 'category' && a.id === b.id));

/**
 * Buscar y filtrar: todo lo que achica el cuaderno a un subconjunto de hojas vive acá,
 * fuera de la vista principal. Los separadores muestran cuántas hojas tiene cada uno.
 */
export function Finder(props: {
  overview: Overview | null;
  filter: ListFilter;
  view: View;
  query: string;
  until: number | null;
  onView: (view: View) => void;
  onQuery: (query: string) => void;
  onUntil: (until: number | null) => void;
  leaving?: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const counts = props.overview?.counts;
  const categories = props.overview?.categories ?? [];
  const clippingsId = props.overview?.clippingsCategoryId;
  const sortedCategories = [...categories].sort((a, b) => {
    if (a.id === clippingsId) return -1;
    if (b.id === clippingsId) return 1;
    return 0;
  });
  const dividers: Divider[] = [
    // «Todas» lleva el color del cuaderno, con el texto que le corresponde encima.
    { key: 'all', view: { kind: 'all' }, label: t('Todas'), count: counts?.all ?? 0, color: 'var(--accent)', ink: 'var(--on-accent, #fff)' },
    { key: 'today', view: { kind: 'today' }, label: t('Hoy'), count: counts?.today ?? 0, color: '#4e4b47' },
    { key: 'pinned', view: { kind: 'pinned' }, label: t('Fijas'), count: counts?.pinned ?? 0, color: '#494d58' },
    { key: 'uncategorized', view: { kind: 'uncategorized' }, label: t('Sin categoría'), count: counts?.uncategorized ?? 0, color: '#8E8E93' },
    ...sortedCategories.map<Divider>((category) => ({
      key: `category-${category.id}`,
      view: { kind: 'category', id: category.id },
      label: category.id === clippingsId || category.name === 'Recortes' ? t('Recortes') : category.name,
      count: category.count,
      color: category.color,
    })),
    { key: 'secret', view: { kind: 'secret' }, label: 'Secret-book', count: counts?.secret ?? 0, color: '#48484A' },
    { key: 'hidden', view: { kind: 'hidden' }, label: t('Papelera'), count: counts?.hidden ?? 0, color: '#AEAEB2' },
  ];
  const filtered = props.view.kind !== 'all' || props.query.trim() !== '' || props.until !== null;

  return (
    <Modal title={t('Buscar y filtrar')} onClose={props.onClose} leaving={props.leaving} wide>
      <div className="finder">
        <label className="search">
          <Search size={15} />
          <input
            autoFocus
            type="search"
            value={props.query}
            placeholder={t('Buscar en todas las hojas')}
            aria-label={t('Buscar en todas las hojas')}
            onChange={(event) => props.onQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && props.onClose()}
          />
        </label>

        <div className="finder-columns">
          <section>
            <h3>{t('Separadores')}</h3>
            <div className="dividers" role="tablist" aria-label={t('Filtrar por categoría')}>
              {dividers.map((divider) => {
                const active = sameView(divider.view, props.view);
                return (
                  <button
                    key={divider.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`divider${active ? ' active' : ''}`}
                    style={{ '--divider': divider.color, '--divider-ink': divider.ink ?? readableOn(divider.color) } as CSSProperties}
                    onClick={() => props.onView(divider.view)}
                  >
                    <span className="dot" />
                    <span className="divider-name">{divider.label}</span>
                    <span className="divider-count">{count(divider.count)}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <h3>{t('Abrir en una fecha')}</h3>
            <Calendar filter={props.filter} until={props.until} onPick={props.onUntil} />
          </section>
        </div>
      </div>

      <footer className="modal-footer">
        <span className="hint">{t('Enter para volver al cuaderno')}</span>
        <button
          type="button"
          className="button"
          disabled={!filtered}
          onClick={() => {
            props.onView({ kind: 'all' });
            props.onQuery('');
            props.onUntil(null);
          }}
        >
          {t('Quitar filtros')}
        </button>
        <button type="button" className="button primary" onClick={props.onClose}>
          {t('Ver las hojas')}
        </button>
      </footer>
    </Modal>
  );
}
