// Markdown de las hojas `.md`: lo justo para dibujarlas con formato sobre el rayado sin
// perder de dónde sale cada cosa en el original. Cada bloque recuerda su renglón y cada
// trozo de texto que se dibuja tal cual está escrito, su posición en el original: así un
// doble clic sobre la hoja con formato deja el cursor en el lugar correcto del texto plano.
//
// No es un CommonMark completo, a propósito:
// - un salto de línea dentro de un párrafo se respeta: en un cuaderno, cada renglón es uno;
// - la sangría sola no vuelve nada código: en las notas se sangra para ordenar, no para
//   programar (el código va entre ``` o ~~~);
// - el HTML no se interpreta: se ve tal cual, como cualquier texto;
// - no hay referencias ([texto][ref]) ni notas al pie.

// ---- encabezado ---------------------------------------------------------------

/**
 * Encabezado YAML de una nota (entre dos `---`, al principio): las claves que Book
 * entiende, en español o en inglés. Ver `integrations/formato-de-notas.md`.
 */
export interface Front {
  title?: string;
  category?: string;
  tags: string[];
  /** Quién escribió la nota, por ejemplo «Claude Code». */
  source?: string;
  date?: string;
  /** Dónde empieza el cuerpo: posición en el texto y número de renglón. */
  end: number;
  line: number;
}

type FrontField = 'title' | 'category' | 'tags' | 'source' | 'date';

const FRONT_KEYS: Record<string, FrontField> = {
  titulo: 'title',
  title: 'title',
  categoria: 'category',
  category: 'category',
  etiquetas: 'tags',
  etiqueta: 'tags',
  tags: 'tags',
  tag: 'tags',
  fuente: 'source',
  source: 'source',
  fecha: 'date',
  date: 'date',
};

/** Sin tildes, sin mayúsculas y sin espacios de más: así se comparan claves y categorías. */
export const fold = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Un valor de YAML simple: sin comillas, y sin el comentario del final si no las tenía. */
function scalar(value: string): string {
  const quoted = /^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/.exec(value) ?? /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(value);
  if (quoted) return value[0] === '"' ? quoted[1].replace(/\\(.)/g, '$1') : quoted[1].replace(/''/g, "'");
  return value.replace(/\s+#.*$/, '').trim();
}

/** Una lista de YAML en un renglón (`[a, b]`) o separada por comas. */
const listOf = (value: string) =>
  (/^\[(.*)\]$/.exec(value)?.[1] ?? value)
    .split(',')
    .map((item) => scalar(item.trim()))
    .filter(Boolean);

/**
 * Lee el encabezado YAML del principio del texto, si lo tiene. Solo cuenta como
 * encabezado si todo lo que hay entre los dos `---` parece YAML (`clave: valor`, listas
 * con guiones, comentarios) y tiene alguna clave que Book entiende: una nota que empieza
 * con un separador no pierde su texto.
 */
export function frontMatter(text: string): Front | null {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!text.startsWith('---', start)) return null;
  const first = text.indexOf('\n', start);
  if (first < 0 || text.slice(start + 3, first).trim() !== '') return null;
  const front: Front = { tags: [], end: 0, line: 0 };
  /** La última clave quedó sin valor: los renglones con guión que siguen son su lista. */
  let pending: FrontField | 'other' | null = null;
  let keys = 0;
  /** Claves que Book entiende: sin ninguna, no es un encabezado para Book y se ve tal cual. */
  let known = 0;
  let at = first + 1;
  for (let line = 1; line < 200 && at <= text.length; line++) {
    const next = text.indexOf('\n', at);
    const stop = next < 0 ? text.length : next;
    const raw = text.slice(at, stop).replace(/\r$/, '');
    at = stop + 1;
    if (/^(---|\.\.\.)\s*$/.test(raw)) {
      if (known === 0) return null;
      front.end = Math.min(at, text.length);
      front.line = line + 1;
      front.tags = [...new Set(front.tags.map((tag) => tag.replace(/^#/, '').trim()).filter(Boolean))].slice(0, 12);
      return front;
    }
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (/^-(\s|$)/.test(trimmed)) {
      if (pending === null) return null;
      if (pending === 'tags') front.tags.push(scalar(trimmed.slice(1).trim()));
      continue;
    }
    const pair = /^([^\s:#-][^:]*?)\s*:(?:\s+(.*))?$/.exec(raw);
    if (!pair) {
      // Un renglón sangrado sigue a la clave anterior (un valor de varios renglones).
      if (/^\s/.test(raw) && keys > 0) continue;
      return null;
    }
    keys++;
    const field = FRONT_KEYS[fold(pair[1])];
    const value = (pair[2] ?? '').trim();
    pending = value === '' ? (field ?? 'other') : null;
    if (field) known++;
    if (!field || value === '') continue;
    if (field === 'tags') front.tags.push(...listOf(value));
    else front[field] = scalar(value);
  }
  return null;
}

// ---- lo que se dibuja --------------------------------------------------------

/** Trozo de un renglón con formato. `at` es su posición en el original. */
export type Inline =
  /** Texto que se dibuja tal cual está escrito en el original, desde `at`. */
  | { t: 'text'; text: string; at: number }
  | { t: 'br' }
  | { t: 'strong' | 'em' | 'del'; children: Inline[] }
  | { t: 'code'; text: string; at: number }
  | { t: 'link'; href: string; children: Inline[] }
  /** Las imágenes no se cargan: se ve su texto alternativo. */
  | { t: 'image'; alt: string; at: number; src: string };

export type Align = 'left' | 'center' | 'right' | null;

export interface Task {
  checked: boolean;
  /** Posición, en el original, de la letra entre los corchetes (` ` o `x`). */
  at: number;
}

export interface Item {
  line: number;
  task: Task | null;
  children: Block[];
}

export interface Row {
  line: number;
  cells: Inline[][];
}

/** Bloque de la hoja; `line` es el renglón del original donde empieza. */
export type Block =
  /** Un renglón en blanco del original: también lo es en la hoja. */
  | { t: 'blank'; line: number }
  | { t: 'heading'; line: number; level: number; children: Inline[] }
  | { t: 'paragraph'; line: number; children: Inline[] }
  | { t: 'code'; line: number; lang: string; lines: { text: string; at: number }[] }
  | { t: 'quote'; line: number; children: Block[] }
  | { t: 'list'; line: number; ordered: boolean; start: number; items: Item[] }
  | { t: 'rule'; line: number }
  | { t: 'table'; line: number; align: Align[]; rows: Row[] };

export interface Doc {
  front: Front | null;
  blocks: Block[];
  /** Dónde empieza cada renglón del original. */
  lineStarts: number[];
}

/** Las hojas que se dibujan con formato: las de extensión `.md` o `.markdown`. */
export const isMarkdownName = (name: string) => /\.(md|markdown)$/i.test(name.trim());

/** Direcciones que un enlace puede abrir (afuera, en el navegador o el correo). */
export const openable = (href: string) => /^(https?:\/\/|mailto:)/i.test(href.trim());

// ---- renglones -----------------------------------------------------------------

/** Un renglón (o lo que queda de él dentro de una cita o de una lista) y dónde empieza. */
interface Line {
  text: string;
  at: number;
  line: number;
}

/** Sangría de un renglón, en columnas (un tab llega al próximo múltiplo de 4), y cuántos caracteres ocupa. */
function lead(text: string): { cols: number; len: number } {
  let cols = 0;
  let len = 0;
  for (; len < text.length; len++) {
    const char = text[len];
    if (char === ' ') cols++;
    else if (char === '\t') cols += 4 - (cols % 4);
    else break;
  }
  return { cols, len };
}

/** Le saca al renglón hasta `cols` columnas de sangría, corriendo su comienzo. */
function dedent(line: Line, cols: number): Line {
  let done = 0;
  let index = 0;
  while (index < line.text.length && done < cols) {
    const char = line.text[index];
    if (char === ' ') done++;
    else if (char === '\t') done += 4 - (done % 4);
    else break;
    index++;
  }
  return { text: line.text.slice(index), at: line.at + index, line: line.line };
}

const skip = (line: Line, chars: number): Line => ({ text: line.text.slice(chars), at: line.at + chars, line: line.line });
const blank = (text: string) => /^[ \t]*$/.test(text);

const RULE = /^([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const HEADING = /^(#{1,6})(?:[ \t]+|$)/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const ITEM = /^([-+*]|(\d{1,9})[.)])(?:([ \t]+)|$)/;
const TABLE_DIVIDER = /^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT = /^(={2,}|-{2,})[ \t]*$/;

/** Cerco que abre un bloque de código, si el renglón lo es. */
function fenceOf(text: string): { char: string; size: number; lang: string } | null {
  const match = FENCE.exec(text);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { char: match[1][0], size: match[1].length, lang: match[2].trim().split(/\s+/)[0] ?? '' };
}

interface Marker {
  ordered: boolean;
  number: number;
  /** Columna donde empieza el contenido del ítem: lo que va más adentro le pertenece. */
  width: number;
  /** Caracteres hasta el contenido, en el renglón del ítem. */
  skip: number;
  empty: boolean;
}

/** Viñeta o número de lista al principio del renglón, si lo hay. */
function markerOf(text: string): Marker | null {
  const { cols, len } = lead(text);
  const match = ITEM.exec(text.slice(len));
  if (!match) return null;
  const marker = match[1].length;
  const spaces = match[3] ? lead(match[3]).cols : 0;
  const empty = blank(text.slice(len + match[0].length));
  // Muchos espacios después de la viñeta no corren el contenido: con uno alcanza.
  const gap = empty || spaces > 4 ? 1 : spaces;
  return {
    ordered: match[2] !== undefined,
    number: match[2] !== undefined ? Number(match[2]) : 0,
    width: cols + marker + gap,
    skip: len + marker + (empty || spaces > 4 ? Math.min(1, match[3]?.length ?? 0) : (match[3]?.length ?? 0)),
    empty,
  };
}

/** Divide un renglón de tabla en celdas (sin los `|` de las puntas), con su posición. */
function cellsOf(line: Line): { text: string; at: number }[] {
  const cells: { text: string; at: number }[] = [];
  const { text } = line;
  let from = 0;
  const push = (start: number, end: number) => {
    const raw = text.slice(start, end);
    const left = raw.length - raw.trimStart().length;
    cells.push({ text: raw.trim(), at: line.at + start + left });
  };
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === '|') {
      push(from, index);
      from = index + 1;
    }
  }
  push(from, text.length);
  // Los `|` de las puntas no separan celdas.
  if (cells.length > 1 && /^[ \t]*\|/.test(text)) cells.shift();
  if (cells.length > 1 && /\|[ \t]*$/.test(text) && !/\\\|[ \t]*$/.test(text)) cells.pop();
  return cells;
}

const alignOf = (cell: string): Align => {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
};

/** Empieza una tabla en este renglón: tiene `|` y el que sigue es la raya de los títulos. */
function tableAt(lines: Line[], index: number): boolean {
  const head = lines[index];
  const divider = lines[index + 1];
  if (!divider || !head.text.includes('|') || !divider.text.includes('|')) return false;
  if (lead(head.text).cols > 3 || !TABLE_DIVIDER.test(divider.text.trim())) return false;
  return cellsOf(head).length === cellsOf(divider).length;
}

/** El renglón empieza un bloque nuevo: corta el párrafo que se venía leyendo. */
function interrupts(lines: Line[], index: number): boolean {
  const { text } = lines[index];
  const { cols, len } = lead(text);
  const body = text.slice(len);
  if (cols <= 3 && (HEADING.test(body) || RULE.test(body) || fenceOf(body) || body.startsWith('>') || tableAt(lines, index))) return true;
  const marker = markerOf(text);
  // Como en CommonMark, una lista numerada corta un párrafo solo si empieza en 1.
  return marker !== null && !marker.empty && (!marker.ordered || marker.number === 1);
}

// ---- bloques -------------------------------------------------------------------

function parseBlocks(lines: Line[]): Block[] {
  const out: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (blank(line.text)) {
      out.push({ t: 'blank', line: line.line });
      index++;
      continue;
    }
    const { cols, len } = lead(line.text);
    const body = line.text.slice(len);

    if (cols <= 3) {
      const fence = fenceOf(body);
      if (fence) {
        const close = new RegExp(`^[ \\t]{0,3}\\${fence.char}{${fence.size},}[ \\t]*$`);
        const code: { text: string; at: number }[] = [];
        let end = index + 1;
        for (; end < lines.length && !close.test(lines[end].text); end++) {
          const inner = dedent(lines[end], cols);
          code.push({ text: inner.text, at: inner.at });
        }
        out.push({ t: 'code', line: line.line, lang: fence.lang, lines: code });
        index = end + 1;
        continue;
      }

      const heading = HEADING.exec(body);
      if (heading) {
        const content = skip(line, len + heading[0].length);
        // Los `#` de cierre son decoración.
        const text = content.text.replace(/(^|[ \t]+)#+[ \t]*$/, '').replace(/[ \t]+$/, '');
        out.push({ t: 'heading', line: line.line, level: heading[1].length, children: parseInlines([{ text, at: content.at }]) });
        index++;
        continue;
      }

      if (RULE.test(body)) {
        out.push({ t: 'rule', line: line.line });
        index++;
        continue;
      }

      if (body.startsWith('>')) {
        const inner: Line[] = [];
        let end = index;
        for (; end < lines.length; end++) {
          const current = lines[end];
          const own = lead(current.text);
          const rest = current.text.slice(own.len);
          if (own.cols <= 3 && rest.startsWith('>')) {
            const after = skip(current, own.len + 1);
            inner.push(after.text.startsWith(' ') || after.text.startsWith('\t') ? skip(after, 1) : after);
          } else if (!blank(current.text) && inner.length && !blank(inner[inner.length - 1].text) && !interrupts(lines, end)) {
            // Renglón perezoso: sigue el párrafo de la cita aunque no lleve `>`.
            inner.push(dedent(current, own.cols));
          } else {
            break;
          }
        }
        out.push({ t: 'quote', line: line.line, children: parseBlocks(inner) });
        index = end;
        continue;
      }

      if (tableAt(lines, index)) {
        const align = cellsOf(lines[index + 1]).map((cell) => alignOf(cell.text));
        const row = (current: Line): Row => {
          const cells = cellsOf(current).slice(0, align.length);
          while (cells.length < align.length) cells.push({ text: '', at: current.at + current.text.length });
          return { line: current.line, cells: cells.map((cell) => parseInlines([cell])) };
        };
        const rows = [row(line)];
        let end = index + 2;
        for (; end < lines.length && !blank(lines[end].text) && lines[end].text.includes('|') && !interrupts(lines, end); end++) {
          rows.push(row(lines[end]));
        }
        out.push({ t: 'table', line: line.line, align, rows });
        index = end;
        continue;
      }
    }

    const marker = markerOf(line.text);
    if (marker) {
      const parsed = parseList(lines, index, marker);
      out.push(parsed.list);
      index = parsed.end;
      continue;
    }

    // Párrafo: hasta un renglón en blanco o hasta algo que empiece otro bloque.
    const text: Line[] = [dedent(line, cols)];
    let end = index + 1;
    let level = 0;
    for (; end < lines.length; end++) {
      const current = lines[end];
      if (blank(current.text)) break;
      const own = lead(current.text);
      // Un renglón de `===` o `---` debajo convierte el párrafo en título.
      const underline = own.cols <= 3 ? SETEXT.exec(current.text.slice(own.len)) : null;
      if (underline) {
        level = underline[1][0] === '=' ? 1 : 2;
        end++;
        break;
      }
      if (interrupts(lines, end)) break;
      text.push(dedent(current, own.cols));
    }
    const children = parseInlines(text.map((part) => ({ text: part.text.replace(/[ \t]+$/, ''), at: part.at })));
    out.push(level ? { t: 'heading', line: line.line, level, children } : { t: 'paragraph', line: line.line, children });
    index = end;
  }
  return out;
}

/** Una lista desde el ítem `start`: sus ítems hermanos y, dentro de cada uno, lo que va más adentro. */
function parseList(lines: Line[], start: number, first: Marker): { list: Block; end: number } {
  const items: Item[] = [];
  let index = start;
  let marker: Marker | null = first;
  while (marker && marker.ordered === first.ordered && index < lines.length) {
    const head = lines[index];
    const content: Line[] = [skip(head, marker.skip)];
    let end = index + 1;
    for (; end < lines.length; end++) {
      const current = lines[end];
      if (blank(current.text)) {
        // Los renglones en blanco son del ítem solo si después sigue algo suyo.
        let after = end;
        while (after < lines.length && blank(lines[after].text)) after++;
        if (after < lines.length && lead(lines[after].text).cols >= marker.width) {
          for (; end < after; end++) content.push(skip(lines[end], lines[end].text.length));
          end--;
          continue;
        }
        break;
      }
      const own = lead(current.text);
      if (own.cols >= marker.width) {
        content.push(dedent(current, marker.width));
        continue;
      }
      // Renglón perezoso: sigue el texto del ítem aunque no esté sangrado.
      const previous = content[content.length - 1];
      if (!blank(previous.text) && !markerOf(current.text) && !interrupts(lines, end)) {
        content.push(dedent(current, own.cols));
        continue;
      }
      break;
    }
    // Ítem de tarea: `[ ]` o `[x]` al principio.
    let task: Task | null = null;
    const box = /^\[([ xX])\](?:[ \t]+|$)/.exec(content[0].text);
    if (box) {
      task = { checked: box[1] !== ' ', at: content[0].at + 1 };
      content[0] = skip(content[0], box[0].length);
    }
    const children = parseBlocks(content);
    // Un ítem vacío no deja un renglón en blanco de más.
    if (children.length === 1 && children[0].t === 'blank' && content[0].text === '') children.length = 0;
    items.push({ line: head.line, task, children });
    index = end;
    // Sigue la lista si el próximo renglón es otro ítem del mismo tipo (lo que iba más
    // adentro ya quedó en este ítem). Después de un renglón en blanco empieza otra lista,
    // que se ve igual: el renglón en blanco queda entre las dos.
    marker = index < lines.length ? markerOf(lines[index].text) : null;
  }
  return { list: { t: 'list', line: lines[start].line, ordered: first.ordered, start: first.number, items }, end: index };
}

// ---- dentro de un renglón -------------------------------------------------------

/** Separadores de una corrida de `*`, `_` o `~`: cuántos quedan y si abren o cierran. */
interface Delim {
  t: 'delim';
  char: '*' | '_' | '~';
  count: number;
  size: number;
  at: number;
  open: boolean;
  close: boolean;
}

type Node = Inline | Delim;

const PUNCTUATION = /[\p{P}\p{S}]/u;
const SPACE = /\s/;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const URL = /(?:https?:\/\/|www\.)[^\s<]+/iy;
const AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/y;
const EMAIL = /<([^\s@<>\\]+@[^\s@<>\\]+\.[^\s@<>\\]+)>/y;

/**
 * Lee lo que va dentro de un bloque. `parts` son sus renglones (uno por cada uno del
 * original), con la posición de cada uno: los trozos de texto que se dibujan tal cual
 * conservan la suya.
 */
export function parseInlines(parts: { text: string; at: number }[]): Inline[] {
  const source = parts.map((part) => part.text).join('\n');
  const starts: number[] = [];
  let sum = 0;
  for (const part of parts) {
    starts.push(sum);
    sum += part.text.length + 1;
  }
  /** Posición en el original de la letra `index` de `source`. */
  const origin = (index: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return parts[low].at + (index - starts[low]);
  };
  return emphasis(scan(source, 0, source.length, origin));
}

/** Busca dónde cierra el corchete que abre en `from`; -1 si no cierra. */
function closingBracket(source: string, from: number, end: number): number {
  let depth = 0;
  for (let index = from; index < end && index < from + 2000; index++) {
    const char = source[index];
    if (char === '\\') index++;
    else if (char === '`') {
      const run = /`+/y;
      run.lastIndex = index;
      const ticks = run.exec(source)![0];
      const close = source.indexOf(ticks, index + ticks.length);
      if (close >= 0 && close < end) index = close + ticks.length - 1;
      else index += ticks.length - 1;
    } else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) return index;
  }
  return -1;
}

/** Destino (y título, que no se usa) de un enlace: `(url "título")` desde `from`. */
function destination(source: string, from: number, end: number): { href: string; end: number } | null {
  if (source[from] !== '(') return null;
  let index = from + 1;
  const spaces = () => {
    while (index < end && SPACE.test(source[index])) index++;
  };
  spaces();
  let href = '';
  if (source[index] === '<') {
    const close = source.indexOf('>', index);
    if (close < 0 || close >= end || source.slice(index, close).includes('\n')) return null;
    href = source.slice(index + 1, close);
    index = close + 1;
  } else {
    let depth = 0;
    const startHref = index;
    for (; index < end; index++) {
      const char = source[index];
      if (char === '\\' && index + 1 < end) index++;
      else if (SPACE.test(char)) break;
      else if (char === '(') depth++;
      else if (char === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    href = source.slice(startHref, index);
  }
  spaces();
  const quote = source[index];
  if (quote === '"' || quote === "'" || quote === '(') {
    const close = source.indexOf(quote === '(' ? ')' : quote, index + 1);
    if (close < 0 || close >= end) return null;
    index = close + 1;
    spaces();
  }
  if (source[index] !== ')') return null;
  return { href: href.replace(/\\([!-/:-@[-`{-~])/g, '$1'), end: index + 1 };
}

/** Recorre `source` entre `from` y `to` y lo separa en trozos y separadores de énfasis. */
function scan(source: string, from: number, to: number, origin: (index: number) => number): Node[] {
  const nodes: Node[] = [];
  let plain = from;
  /** Agrega el texto pendiente hasta `end`, cortado en renglones. */
  const flush = (end: number) => {
    let start = plain;
    while (start < end) {
      const nl = source.indexOf('\n', start);
      const stop = nl < 0 || nl >= end ? end : nl;
      if (stop > start) pushText(nodes, source.slice(start, stop), origin(start));
      if (stop < end) nodes.push({ t: 'br' });
      start = stop + 1;
    }
    plain = end;
  };

  let index = from;
  while (index < to) {
    const char = source[index];
    const before = index > from ? source[index - 1] : '\n';

    if (char === '\\' && index + 1 < to) {
      const next = source[index + 1];
      if (next === '\n') {
        flush(index);
        nodes.push({ t: 'br' });
        index += 2;
        plain = index;
        continue;
      }
      if (ASCII_PUNCTUATION.test(next)) {
        flush(index);
        pushText(nodes, next, origin(index + 1));
        index += 2;
        plain = index;
        continue;
      }
    }

    if (char === '`') {
      const run = /`+/y;
      run.lastIndex = index;
      const ticks = run.exec(source)![0];
      let close = source.indexOf(ticks, index + ticks.length);
      // Tiene que ser una corrida del mismo largo exacto.
      while (close >= 0 && close < to && source[close + ticks.length] === '`') {
        let after = close;
        while (source[after] === '`') after++;
        close = source.indexOf(ticks, after);
      }
      if (close >= 0 && close + ticks.length <= to) {
        flush(index);
        let start = index + ticks.length;
        let end = close;
        const inner = source.slice(start, end);
        if (inner.length > 1 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') {
          start++;
          end--;
        }
        nodes.push({ t: 'code', text: source.slice(start, end).replace(/\n/g, ' '), at: origin(start) });
        index = close + ticks.length;
        plain = index;
        continue;
      }
      index += ticks.length;
      continue;
    }

    if (char === '*' || char === '_' || char === '~') {
      let end = index;
      while (end < to && source[end] === char) end++;
      const size = end - index;
      const after = end < to ? source[end] : '\n';
      if (char === '~' && size !== 2) {
        index = end;
        continue;
      }
      const leftFlanking = !SPACE.test(after) && (!PUNCTUATION.test(after) || SPACE.test(before) || PUNCTUATION.test(before));
      const rightFlanking = !SPACE.test(before) && (!PUNCTUATION.test(before) || SPACE.test(after) || PUNCTUATION.test(after));
      const open = char === '_' ? leftFlanking && (!rightFlanking || PUNCTUATION.test(before)) : leftFlanking;
      const close = char === '_' ? rightFlanking && (!leftFlanking || PUNCTUATION.test(after)) : rightFlanking;
      flush(index);
      nodes.push({ t: 'delim', char, count: size, size, at: origin(index), open, close });
      index = end;
      plain = index;
      continue;
    }

    if (char === '[' || (char === '!' && source[index + 1] === '[')) {
      const image = char === '!';
      const label = image ? index + 1 : index;
      const close = closingBracket(source, label, to);
      const target = close >= 0 ? destination(source, close + 1, to) : null;
      if (target) {
        flush(index);
        if (image) {
          nodes.push({ t: 'image', alt: source.slice(label + 1, close), at: origin(label + 1), src: target.href });
        } else {
          nodes.push({ t: 'link', href: target.href, children: emphasis(scan(source, label + 1, close, origin)) });
        }
        index = target.end;
        plain = index;
        continue;
      }
      index++;
      continue;
    }

    if (char === '<') {
      AUTOLINK.lastIndex = index;
      EMAIL.lastIndex = index;
      const link = AUTOLINK.exec(source) ?? EMAIL.exec(source);
      if (link && index + link[0].length <= to) {
        flush(index);
        const href = link[1].includes(':') ? link[1] : `mailto:${link[1]}`;
        nodes.push({ t: 'link', href, children: [{ t: 'text', text: link[1], at: origin(index + 1) }] });
        index += link[0].length;
        plain = index;
        continue;
      }
    }

    // Direcciones sueltas (https://… o www.…) también son enlaces, como en GitHub.
    if ((char === 'h' || char === 'H' || char === 'w' || char === 'W') && (index === from || /[\s*_~(]/.test(before))) {
      URL.lastIndex = index;
      const match = URL.exec(source);
      if (match) {
        let text = match[0].slice(0, to - index);
        // La puntuación del final es de la oración, no de la dirección.
        text = text.replace(/[?!.,:;*_~'"]+$/, '');
        while (text.endsWith(')') && (text.match(/\(/g)?.length ?? 0) < (text.match(/\)/g)?.length ?? 0)) text = text.slice(0, -1);
        if (text.length > 4 && !/^www\.$/i.test(text)) {
          flush(index);
          const href = /^www\./i.test(text) ? `https://${text}` : text;
          nodes.push({ t: 'link', href, children: [{ t: 'text', text, at: origin(index) }] });
          index += text.length;
          plain = index;
          continue;
        }
      }
    }

    index++;
  }
  flush(to);
  return nodes;
}

/** Agrega un trozo de texto; si sigue justo al anterior en el original, se suman. */
function pushText(nodes: Node[], text: string, at: number) {
  const last = nodes[nodes.length - 1];
  if (last?.t === 'text' && last.at + last.text.length === at) last.text += text;
  else nodes.push({ t: 'text', text, at });
}

/** Los separadores sin pareja quedan como texto. */
function settle(nodes: Node[]): Inline[] {
  const out: Node[] = [];
  for (const node of nodes) {
    if (node.t === 'text') pushText(out, node.text, node.at);
    else if (node.t !== 'delim') out.push(node);
    else if (node.count > 0) pushText(out, node.char.repeat(node.count), node.at);
  }
  return out as Inline[];
}

/** Empareja los separadores de énfasis (la regla de CommonMark, simplificada). */
function emphasis(nodes: Node[]): Inline[] {
  let closerAt = 0;
  while (closerAt < nodes.length) {
    const closer = nodes[closerAt];
    if (closer.t !== 'delim' || !closer.close || closer.count === 0) {
      closerAt++;
      continue;
    }
    let openerAt = -1;
    for (let index = closerAt - 1; index >= 0; index--) {
      const opener = nodes[index];
      if (opener.t !== 'delim' || opener.char !== closer.char || !opener.open || opener.count === 0) continue;
      if (closer.char === '~') {
        if (opener.count === closer.count) {
          openerAt = index;
          break;
        }
        continue;
      }
      // La regla del 3: `*a**` no empareja un separador que abre y cierra a la vez.
      const both = opener.close || closer.open;
      if (both && (opener.size + closer.size) % 3 === 0 && !(opener.size % 3 === 0 && closer.size % 3 === 0)) continue;
      openerAt = index;
      break;
    }
    if (openerAt < 0) {
      closerAt++;
      continue;
    }
    const opener = nodes[openerAt] as Delim;
    const used = closer.char === '~' ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    const kind = closer.char === '~' ? 'del' : used === 2 ? 'strong' : 'em';
    const wrapped: Inline = { t: kind, children: settle(nodes.slice(openerAt + 1, closerAt)) };
    opener.count -= used;
    closer.count -= used;
    // Lo que queda del separador que cierra son sus últimos caracteres.
    closer.at += used;
    nodes.splice(openerAt + 1, closerAt - openerAt - 1, wrapped);
    closerAt = openerAt + 2;
    if (opener.count === 0) {
      nodes.splice(openerAt, 1);
      closerAt--;
    }
    if (closer.count === 0) nodes.splice(closerAt, 1);
  }
  return settle(nodes);
}

// ---- todo junto ------------------------------------------------------------------

/** Lee una nota en markdown: su encabezado, si lo tiene, y los bloques del cuerpo. */
export function parseMarkdown(text: string): Doc {
  const lineStarts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lineStarts.push(index + 1);
  const front = frontMatter(text);
  const lines: Line[] = [];
  for (let line = front?.line ?? 0; line < lineStarts.length; line++) {
    const at = lineStarts[line];
    const end = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
    lines.push({ text: text.slice(at, end).replace(/\r$/, ''), at, line });
  }
  // Los renglones en blanco del principio y del final no suman hojas vacías.
  while (lines.length && blank(lines[0].text)) lines.shift();
  while (lines.length && blank(lines[lines.length - 1].text)) lines.pop();
  const blocks = parseBlocks(lines);
  // El título del encabezado ya está arriba de la hoja: si el cuerpo empieza con el mismo
  // título (es lo habitual, para que se lea bien en cualquier otro lado), no se repite.
  const first = blocks[0];
  if (front?.title && first?.t === 'heading' && first.level === 1 && fold(plain(first.children)) === fold(front.title)) {
    blocks.shift();
    while (blocks[0]?.t === 'blank') blocks.shift();
  }
  return { front, blocks, lineStarts };
}

/** El texto de unos trozos, sin formato. */
function plain(nodes: Inline[]): string {
  return nodes
    .map((node) =>
      node.t === 'text' || node.t === 'code' ? node.text : node.t === 'br' ? ' ' : node.t === 'image' ? node.alt : plain(node.children),
    )
    .join('');
}
