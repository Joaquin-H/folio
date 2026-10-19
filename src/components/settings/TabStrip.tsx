import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

/** Una pestaña de Ajustes. */
export interface Tab<T extends string> {
  value: T;
  label: string;
}

export const tabId = (value: string) => `settings-tab-${value}`;
export const PANEL_ID = 'settings-panel';

/**
 * Las pestañas de Ajustes. Con diez secciones no entran en la ventana más angosta, así que la
 * fila se desplaza en horizontal y se desvanece en el borde que tiene más pestañas detrás.
 * Con el teclado: las flechas, Inicio y Fin pasan de una pestaña a otra (la elegida es la
 * única que recibe el foco con Tab, y de ahí se sigue hacia el contenido).
 */
export function TabStrip<T extends string>(props: { value: T; options: Tab<T>[]; onChange: (value: T) => void; label: string }) {
  const { value, options, onChange } = props;
  const list = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const node = list.current;
    if (!node) return;
    const start = node.scrollLeft > 1;
    const end = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
    setFade((current) => (current.start === start && current.end === end ? current : { start, end }));
  }, []);

  useEffect(() => {
    const node = list.current;
    if (!node) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  // La pestaña elegida queda a la vista (y con vecinas a los costados, no pegada al borde).
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [value]);

  const onKeyDown = (event: KeyboardEvent) => {
    const index = options.findIndex((option) => option.value === value);
    const target =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % options.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index - 1 + options.length) % options.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? options.length - 1
      : -1;
    if (target < 0) return;
    event.preventDefault();
    onChange(options[target].value);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus();
  };

  return (
    <div className="tab-strip" data-fade-start={fade.start || undefined} data-fade-end={fade.end || undefined}>
      {fade.start && (
        <button
          type="button"
          className="tab-scroll prev"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => list.current?.scrollBy({ left: -160, behavior: 'smooth' })}
        >
          ‹
        </button>
      )}
      <div
        ref={list}
        className="segmented tab-list"
        role="tablist"
        aria-label={props.label}
        onScroll={measure}
        onKeyDown={onKeyDown}
        // Con la rueda del mouse (que se mueve en vertical) también se recorre la fila.
        onWheel={(event) => {
          if (list.current && Math.abs(event.deltaY) > Math.abs(event.deltaX)) list.current.scrollLeft += event.deltaY;
        }}
      >
        {options.map((option) => (
          <button
            key={option.value}
            id={tabId(option.value)}
            type="button"
            role="tab"
            aria-selected={option.value === value}
            aria-controls={PANEL_ID}
            tabIndex={option.value === value ? 0 : -1}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {fade.end && (
        <button
          type="button"
          className="tab-scroll next"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => list.current?.scrollBy({ left: 160, behavior: 'smooth' })}
        >
          ›
        </button>
      )}
    </div>
  );
}
