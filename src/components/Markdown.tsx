// Hojas `.md` con formato: cómo se dibuja lo que lee `markdown.ts`, sobre el rayado.
// Cada bloque lleva su renglón del original (`data-line`) y cada trozo de texto que se
// dibuja tal cual está escrito, su posición (`data-o`): con eso, un doble clic sobre la
// hoja con formato encuentra el lugar del texto plano donde dejar el cursor.
import { memo, type CSSProperties, type ReactNode } from 'react';
import { Check, Image } from 'lucide-react';
// La itálica de verdad (sin ella, el navegador inclina la letra derecha). Solo se
// descarga si una hoja la usa.
import '@fontsource-variable/inter/wght-italic.css';
import '../styles/markdown.css';
import { openable, type Block, type Doc, type Inline, type Item } from '../markdown';

function inlines(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.t) {
      case 'text':
        return (
          <span key={index} data-o={node.at}>
            {node.text}
          </span>
        );
      case 'br':
        return <br key={index} />;
      case 'strong':
        return <strong key={index}>{inlines(node.children)}</strong>;
      case 'em':
        return <em key={index}>{inlines(node.children)}</em>;
      case 'del':
        return <del key={index}>{inlines(node.children)}</del>;
      case 'code':
        return (
          <code key={index} data-o={node.at}>
            {node.text}
          </code>
        );
      case 'link':
        // Sin `href`: la vista nunca navega. El clic lo atiende la hoja (ver `linkAt`).
        return openable(node.href) ? (
          <a key={index} className="md-link" role="link" tabIndex={0} data-href={node.href} title={node.href}>
            {inlines(node.children)}
          </a>
        ) : (
          <span key={index} className="md-link off" title={node.href}>
            {inlines(node.children)}
          </span>
        );
      case 'image':
        return (
          <span key={index} className="md-image" title={node.src}>
            <Image aria-hidden="true" />
            {node.alt ? <span data-o={node.at}>{node.alt}</span> : 'imagen'}
          </span>
        );
    }
  });
}

function item(entry: Item, index: number, number: number | null, tasks: boolean): ReactNode {
  const { task } = entry;
  return (
    <li key={index} data-line={entry.line} className={task ? `md-task${task.checked ? ' done' : ''}` : undefined}>
      {task ? (
        <button
          type="button"
          role="checkbox"
          className="md-check"
          aria-checked={task.checked}
          aria-disabled={!tasks || undefined}
          aria-label={task.checked ? 'Desmarcar esta tarea' : 'Marcar esta tarea como hecha'}
          data-at={task.at}
        >
          {task.checked && <Check aria-hidden="true" />}
        </button>
      ) : (
        number !== null && <span className="md-num">{number}.</span>
      )}
      {blocks(entry.children, tasks)}
    </li>
  );
}

function block(node: Block, index: number, tasks: boolean): ReactNode {
  switch (node.t) {
    case 'blank':
      return <div key={index} className="md-blank" data-line={node.line} />;
    case 'heading': {
      const Tag = `h${node.level}` as 'h1';
      // El título grande ocupa dos renglones y se asienta sobre el de abajo (ver markdown.css).
      return (
        <Tag key={index} data-line={node.line}>
          {node.level === 1 ? <span className="md-lift">{inlines(node.children)}</span> : inlines(node.children)}
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p key={index} data-line={node.line}>
          {inlines(node.children)}
        </p>
      );
    case 'code':
      return (
        <pre key={index} className="md-code" data-line={node.line}>
          {node.lines.map((line, at) => (
            <span key={at} data-o={line.at}>
              {at < node.lines.length - 1 ? `${line.text}\n` : line.text}
            </span>
          ))}
        </pre>
      );
    case 'quote':
      return (
        <blockquote key={index} data-line={node.line}>
          {blocks(node.children, tasks)}
        </blockquote>
      );
    case 'list': {
      if (!node.ordered) {
        return (
          <ul key={index} data-line={node.line}>
            {node.items.map((entry, at) => item(entry, at, null, tasks))}
          </ul>
        );
      }
      // Los números van alineados a la derecha, con lugar para el más largo.
      const digits = String(node.start + node.items.length - 1).length;
      return (
        <ol key={index} data-line={node.line} style={{ '--digits': digits } as CSSProperties}>
          {node.items.map((entry, at) => item(entry, at, node.start + at, tasks))}
        </ol>
      );
    }
    case 'rule':
      return <div key={index} className="md-rule" role="separator" data-line={node.line} />;
    case 'table': {
      const [head, ...rows] = node.rows;
      const align = (column: number): CSSProperties | undefined => (node.align[column] ? { textAlign: node.align[column] } : undefined);
      return (
        <table key={index} data-line={node.line}>
          <thead>
            <tr data-line={head.line}>
              {head.cells.map((cell, column) => (
                <th key={column} style={align(column)}>
                  {inlines(cell)}
                </th>
              ))}
            </tr>
          </thead>
          {rows.length > 0 && (
            <tbody>
              {rows.map((row, at) => (
                <tr key={at} data-line={row.line}>
                  {row.cells.map((cell, column) => (
                    <td key={column} style={align(column)}>
                      {inlines(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      );
    }
  }
}

const blocks = (nodes: Block[], tasks: boolean) => nodes.map((node, index) => block(node, index, tasks));

/**
 * El cuerpo de una hoja con formato. Se vuelve a dibujar solo si cambia el texto (`doc`
 * sale de un `useMemo` sobre él) o si sus tareas pasan a poder marcarse o dejan de poder.
 * `tasks` en falso deja las casillas a la vista pero sin marcarse (hojas que no se
 * pueden escribir).
 */
export const MarkdownBlocks = memo(function MarkdownBlocks(props: { doc: Doc; tasks: boolean }) {
  return <>{blocks(props.doc.blocks, props.tasks)}</>;
});

// ---- del dibujo al original ---------------------------------------------------------

/**
 * Posición del original que corresponde a ese punto del texto dibujado (un nodo y un
 * desplazamiento, como los de una selección). Dentro de un trozo escrito tal cual, es
 * exacta; en lo demás (un renglón en blanco, una viñeta), es el principio del renglón del
 * bloque. `null` si el punto no es de la hoja.
 */
export function sourceOffset(root: HTMLElement, doc: Doc, node: Node, offset: number): number | null {
  if (!root.contains(node)) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return null;
  const run = element.closest<HTMLElement>('[data-o]');
  if (run && root.contains(run)) {
    const start = Number(run.dataset.o);
    const length = run.textContent?.length ?? 0;
    // En un nodo de texto, `offset` cuenta letras; en un elemento, hijos: antes o después de todo.
    const inside = node.nodeType === Node.TEXT_NODE && node.parentElement === run ? offset : offset > 0 ? length : 0;
    // El salto de línea del final de un renglón de código está en el original justo ahí.
    return start + Math.min(inside, length);
  }
  const owner = element.closest<HTMLElement>('[data-line]');
  if (!owner || !root.contains(owner)) return null;
  return doc.lineStarts[Number(owner.dataset.line)] ?? null;
}

/** El enlace que se tocó, si se tocó uno que se puede abrir. */
export const linkAt = (target: EventTarget | null): string | null =>
  (target instanceof Element && target.closest<HTMLElement>('.md-link[data-href]')?.dataset.href) || null;

/** La casilla de tarea que se tocó, con la posición de su letra en el original. */
export function checkAt(target: EventTarget | null): { at: number; enabled: boolean } | null {
  const box = target instanceof Element ? target.closest<HTMLElement>('.md-check') : null;
  return box ? { at: Number(box.dataset.at), enabled: box.getAttribute('aria-disabled') !== 'true' } : null;
}
