import { Check } from 'lucide-react';
import { plural } from '../../format';
import { quote, useT } from '../../i18n';
import type { CategorySuggestion } from '../../types';

/** Colores sugeridos para las categorías (sin el gris, reservado para «sin color»). */
export const SUGGEST_PALETTE = ['#007AFF', '#5856D6', '#AF52DE', '#FF2D55', '#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#30B0C7'];

/** Devuelve el color de la paleta que corresponde a una categoría según su posición. */
export function suggestColor(index: number, base = 0): string {
  return SUGGEST_PALETTE[(base + index) % SUGGEST_PALETTE.length];
}

/** Alterna la selección de un ítem en una lista. */
export function toggleSuggested<T extends { checked: boolean }>(items: T[], index: number): T[] {
  return items.map((item, i) => (i === index ? { ...item, checked: !item.checked } : item));
}

/** Cambia el nombre de un ítem en una lista. */
export function renameSuggested<T extends { name: string }>(items: T[], index: number, name: string): T[] {
  return items.map((item, i) => (i === index ? { ...item, name } : item));
}

export interface SuggestedCategoryEntry extends Partial<CategorySuggestion> {
  id?: number | string;
  name: string;
  keywords?: string[];
  count?: number;
  samples?: string[];
  checked: boolean;
  created?: boolean;
  color?: string;
  problem?: string | null;
}

export interface SuggestedCategoryListProps {
  items: SuggestedCategoryEntry[];
  variant?: 'default' | 'welcome';
  disabled?: boolean;
  colorBase?: number;
  onToggle: (index: number) => void;
  onNameChange: (index: number, name: string) => void;
}

/** Lista compartida de categorías sugeridas para Ajustes → Categorías y la Bienvenida. */
export function SuggestedCategoryList(props: SuggestedCategoryListProps) {
  const t = useT();
  const { items, variant = 'default', disabled = false, colorBase = 0, onToggle, onNameChange } = props;
  const isWelcome = variant === 'welcome';

  return (
    <ul className={`suggest-list${isWelcome ? ' welcome-list' : ''}`} aria-label={t('Categorías sugeridas')}>
      {items.map((item, index) => {
        const checked = item.checked;
        const color = item.color ?? (checked ? suggestColor(index, colorBase) : 'var(--label-3)');
        const trouble = item.problem ?? null;
        const keywords = item.keywords ?? [];
        const samples = item.samples ?? [];
        const count = item.count ?? 0;
        const itemClass = [
          'suggest-item',
          isWelcome ? 'welcome-item' : '',
          checked ? (isWelcome ? 'selected' : '') : 'off',
          item.created ? 'done' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <li
            key={item.id ?? index}
            className={itemClass}
            style={{ animationDelay: `${Math.min(index, 8) * (isWelcome ? 25 : 35)}ms` }}
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-label={t('Crear la categoría {name}', { name: item.name })}
              disabled={item.created || disabled}
              className={`suggest-check${isWelcome ? ' welcome-check' : ''}`}
              onClick={() => onToggle(index)}
            >
              <Check size={12} strokeWidth={3} />
            </button>
            <div className="suggest-title">
              <span className={`dot${isWelcome ? ' welcome-item-color' : ''}`} style={{ backgroundColor: color }} />
              <input
                className={isWelcome ? 'welcome-item-name' : undefined}
                value={item.name}
                disabled={item.created || disabled || !checked}
                aria-label={t('Nombre de la categoría')}
                aria-invalid={trouble !== null}
                title={trouble ?? undefined}
                onChange={(e) => onNameChange(index, e.target.value)}
              />
            </div>
            <span className={`suggest-count${isWelcome ? ' welcome-item-count' : ''}`}>
              {item.created ? t('Creada') : plural(count, 'hoja', 'hojas')}
            </span>
            <p className={`suggest-words${isWelcome ? ' welcome-item-words' : ''}`}>
              {keywords.join(' · ')}
            </p>
            {samples.length > 0 && (
              <p className={`suggest-samples${isWelcome ? ' welcome-item-samples' : ''}`} title={samples.join('\n')}>
                {t('Por ejemplo: {samples}', { samples: samples.map((s) => quote(s)).join(', ') })}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
