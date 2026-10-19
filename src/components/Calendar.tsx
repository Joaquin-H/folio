import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { dayKey, monthTitle } from '../format';
import { locale, tn, useT } from '../i18n';
import type { ListFilter } from '../types';

/** Iniciales de los días de la semana, de lunes a domingo. */
const WEEKDAYS = { es: ['L', 'M', 'M', 'J', 'V', 'S', 'D'], en: ['M', 'T', 'W', 'T', 'F', 'S', 'S'] };

/** Celdas del mes en semanas que empiezan el lunes; `null` son los huecos. */
function monthCells(month: Date): (Date | null)[] {
  const year = month.getFullYear();
  const index = month.getMonth();
  const offset = (new Date(year, index, 1).getDay() + 6) % 7;
  const total = new Date(year, index + 1, 0).getDate();
  return [
    ...Array<null>(offset).fill(null),
    ...Array.from({ length: total }, (_, day) => new Date(year, index, day + 1)),
  ];
}

/** Calendario para abrir el cuaderno en un día: solo se pueden elegir días con hojas. */
export function Calendar(props: { filter: ListFilter; until: number | null; onPick: (until: number | null) => void }) {
  const t = useT();
  const [days, setDays] = useState<Map<string, number>>(new Map());
  const [month, setMonth] = useState(() => new Date(props.until ?? Date.now()));
  const { view, categoryId, query } = props.filter;

  useEffect(() => {
    let alive = true;
    api
      .listDays({ view, categoryId, query })
      .then((rows) => alive && setDays(new Map(rows.map((row) => [row.day, row.count]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [view, categoryId, query]);

  const cells = useMemo(() => monthCells(month), [month]);
  const selected = props.until ? dayKey(props.until) : null;
  const today = dayKey(Date.now());
  const shift = (delta: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button type="button" className="icon-button" onClick={() => shift(-1)} aria-label={t('Mes anterior')}>
          <ChevronLeft size={16} />
        </button>
        <strong>{monthTitle(month)}</strong>
        <button type="button" className="icon-button" onClick={() => shift(1)} aria-label={t('Mes siguiente')}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="calendar-grid">
        {WEEKDAYS[locale()].map((name, index) => (
          <span key={index} className="calendar-weekday">
            {name}
          </span>
        ))}
        {cells.map((date, index) => {
          if (!date) return <span key={index} />;
          const key = dayKey(date.getTime());
          const sheets = days.get(key) ?? 0;
          return (
            <button
              key={index}
              type="button"
              disabled={sheets === 0}
              className={`calendar-day${key === selected ? ' selected' : ''}${key === today ? ' today' : ''}`}
              title={sheets ? tn(sheets, '{n} hoja', '{n} hojas') : undefined}
              onClick={() =>
                props.onPick(
                  key === selected
                    ? null
                    : new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime(),
                )
              }
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
