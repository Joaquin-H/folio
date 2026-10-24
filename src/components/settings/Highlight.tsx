import type { ReactNode } from 'react';
import { getMatchRanges } from './searchIndex';

/**
 * Resalta en `text` los fragmentos que coinciden con `query` envolviéndolos
 * en una etiqueta `<mark className="settings-search-highlight">`.
 * Es insensible a acentos y mayúsculas.
 */
export function Highlight(props: { text: string; query: string; className?: string }): ReactNode {
  const { text, query, className } = props;
  if (!query.trim() || !text) {
    return <>{text}</>;
  }

  const ranges = getMatchRanges(text, query);
  if (!ranges.length) {
    return <>{text}</>;
  }

  const parts: ReactNode[] = [];
  let lastIdx = 0;

  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i];
    if (start > lastIdx) {
      parts.push(text.slice(lastIdx, start));
    }
    parts.push(
      <mark key={i} className={className ?? 'settings-search-highlight'}>
        {text.slice(start, end)}
      </mark>,
    );
    lastIdx = end;
  }

  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }

  return <>{parts}</>;
}
