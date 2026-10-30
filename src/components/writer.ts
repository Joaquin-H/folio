// Escribir en una hoja del cuaderno: qué se está escribiendo, cuándo se guarda y qué
// pasa si no se puede. El texto vive en el editor de la hoja; acá solo se lo lee.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isConflict } from '../api';
import { noteTitle, stemOf } from '../format';
import type { SheetDetail } from '../types';

/** Id de una hoja nueva que todavía no se guardó nunca: no tiene archivo. */
export const DRAFT = -1;
/** Cuánto se espera sin teclear antes de guardar. */
const SAVE_DELAY = 900;
/**
 * Cuánto puede seguir mostrándose lo recién escrito en lugar de lo guardado. Normalmente
 * lo suelta la propia hoja apenas recibe el texto guardado; si la hoja ya no está a la
 * vista para hacerlo, se suelta solo.
 */
const RECENT_LIFE = 4000;

export interface Writing {
  /** Hoja que se está escribiendo; `DRAFT` si es nueva y todavía no tiene archivo. */
  id: number;
  status: 'saved' | 'pending' | 'saving' | 'conflict' | 'error';
  /** Por qué falló el último guardado. */
  message?: string;
  /** Título que se está editando; `null` si esta hoja no puede cambiar de nombre. */
  title: string | null;
  /** Es una hoja que se está creando ahora, no una que ya existía. */
  isNew: boolean;
}

/** Texto que se acaba de dejar de escribir, hasta que el cuaderno lo recibe ya guardado. */
export interface Recent {
  id: number;
  text: string;
  /** Huella con la que quedó guardado; sin ella, todavía se está guardando. */
  hash?: string;
}

export interface WriterTarget {
  id: number;
  title: string;
  text: string;
  hash: string | null;
  /** El título se puede cambiar (y con él, el nombre del archivo). */
  renamable: boolean;
  /** Categoría en la que nace una hoja nueva. */
  categoryId?: number;
}

interface Session extends WriterTarget {
  savedText: string;
  savedTitle: string;
  /** Lee el texto del editor; `null` cuando el editor no está en pantalla. */
  read: (() => string) | null;
  timer: number;
  /** Los guardados van de a uno, en orden. */
  queue: Promise<boolean>;
  /** El original cambió por fuera: no se guarda más hasta que el usuario decida. */
  blocked: boolean;
}

export interface WriterEvents {
  /** Una hoja nueva acaba de convertirse en archivo. */
  onCreated: (detail: SheetDetail) => void;
  /** Se dejó de escribir esa hoja (`DRAFT` si nunca llegó a guardarse). */
  onEnded: (id: number) => void;
  onNotice: (text: string) => void;
}

export type Writer = ReturnType<typeof useWriter>;

export function useWriter(events: WriterEvents) {
  const [writing, setWriting] = useState<Writing | null>(null);
  const [recent, setRecent] = useState<Recent | null>(null);
  const session = useRef<Session | null>(null);
  const handlers = useRef(events);
  handlers.current = events;

  // Lo recién escrito no se queda para siempre tapando lo guardado: si nadie lo soltó
  // (la hoja se dejó de ver antes de recibir el texto guardado), vence solo. Si no, al
  // volver la hoja mostraría eso en vez de lo que hay y no dejaría escribir.
  useEffect(() => {
    if (!recent) return;
    const timer = window.setTimeout(() => setRecent((current) => (current === recent ? null : current)), RECENT_LIFE);
    return () => window.clearTimeout(timer);
  }, [recent]);

  /** Actualiza lo que se muestra, solo si esa sesión sigue siendo la actual. */
  const show = useCallback((s: Session, patch: Partial<Writing>) => {
    if (session.current === s) setWriting((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const save = useCallback(
    (s: Session, force = false): Promise<boolean> => {
      window.clearTimeout(s.timer);
      s.queue = s.queue.then(async () => {
        if (s.read) s.text = s.read();
        const text = s.text;
        const title = s.title.trim();
        const isDraft = s.id === DRAFT;
        const retitle = s.renamable && !isDraft && title !== '' && title !== s.savedTitle;
        // Una hoja nueva sin nada escrito todavía no existe; una sin cambios ya está guardada.
        if (isDraft ? text.trim() === '' : !force && text === s.savedText && !retitle) {
          show(s, { status: 'saved', message: undefined });
          return true;
        }
        show(s, { status: 'saving' });
        try {
          const detail = isDraft
            ? await api.createNote(title || noteTitle(text), text, s.categoryId)
            : await api.saveSheet(s.id, text, { title: retitle ? title : undefined, baseHash: s.hash ?? undefined, force });
          s.id = detail.id;
          s.hash = detail.hash;
          s.savedText = text;
          if (s.renamable) {
            // El archivo puede haber quedado con otro nombre (por ejemplo, numerado).
            s.savedTitle = stemOf(detail.title);
            if (!s.title.trim() || s.title.trim() === title) s.title = s.savedTitle;
          }
          if (isDraft) handlers.current.onCreated(detail);
          const typedMeanwhile = s.read !== null && s.read() !== text;
          show(s, {
            id: detail.id,
            status: typedMeanwhile ? 'pending' : 'saved',
            message: undefined,
            title: s.renamable ? s.title : null,
          });
          return true;
        } catch (reason) {
          if (isConflict(reason)) {
            s.blocked = true;
            show(s, { status: 'conflict' });
          } else {
            show(s, { status: 'error', message: String(reason) });
          }
          return false;
        }
      });
      return s.queue;
    },
    [show],
  );

  const schedule = useCallback(
    (s: Session) => {
      window.clearTimeout(s.timer);
      if (!s.blocked) s.timer = window.setTimeout(() => void save(s), SAVE_DELAY);
    },
    [save],
  );

  /**
   * Deja de escribir: guarda lo que falte y la hoja vuelve a ser de lectura. Si no se
   * pudo guardar en el original, lo escrito no se pierde: queda en una hoja nueva.
   */
  const finish = useCallback(async () => {
    const s = session.current;
    if (!s) return;
    window.clearTimeout(s.timer);
    // El texto se lee ahora, antes de que el editor desaparezca de la pantalla.
    if (s.read) s.text = s.read();
    s.read = null;
    session.current = null;
    setWriting(null);
    setRecent({ id: s.id, text: s.text });
    const saved = !s.blocked && (await save(s));
    if (saved) {
      setRecent((current) => (current && current.text === s.text ? { id: s.id, text: s.text, hash: s.hash ?? undefined } : current));
    } else {
      setRecent(null);
      if (s.text.trim() && s.text !== s.savedText) {
        try {
          const rescued = await api.createNote(`${s.savedTitle || 'notas'} (copia de Folio)`, s.text, s.categoryId);
          handlers.current.onNotice(`No se pudo guardar en el original. Lo que escribiste quedó en «${rescued.title}».`);
        } catch (reason) {
          handlers.current.onNotice(`No se pudo guardar lo que escribiste: ${String(reason)}`);
        }
      }
    }
    handlers.current.onEnded(s.id);
  }, [save]);

  /** Empieza a escribir una hoja. Si se estaba escribiendo otra, esa se guarda y se cierra. */
  const begin = useCallback(
    (target: WriterTarget) => {
      if (session.current) void finish();
      session.current = {
        ...target,
        savedText: target.text,
        savedTitle: target.title,
        read: null,
        timer: 0,
        queue: Promise.resolve(true),
        blocked: false,
      };
      setWriting({ id: target.id, status: 'saved', title: target.renamable ? target.title : null, isNew: target.id === DRAFT });
    },
    [finish],
  );

  /** El editor avisa que el texto cambió: se guarda cuando el usuario deja de teclear. */
  const touched = useCallback(() => {
    const s = session.current;
    if (!s) return;
    setWriting((current) => (current && (current.status === 'saved' || current.status === 'error') ? { ...current, status: 'pending' } : current));
    schedule(s);
  }, [schedule]);

  const rename = useCallback(
    (title: string) => {
      const s = session.current;
      if (!s || !s.renamable) return;
      s.title = title;
      setWriting((current) => (current ? { ...current, title, status: current.status === 'conflict' ? 'conflict' : 'pending' } : current));
      schedule(s);
    },
    [schedule],
  );

  /** Guarda ya, sin esperar (al perder el foco, con Ctrl + S). */
  const flush = useCallback(() => {
    const s = session.current;
    return s && !s.blocked ? save(s) : Promise.resolve(true);
  }, [save]);

  /** El editor de la hoja se conecta (o se desconecta, con `null`) para que se lo pueda leer. */
  const attach = useCallback((read: (() => string) | null) => {
    const s = session.current;
    if (!s) return;
    if (!read && s.read) s.text = s.read();
    s.read = read;
  }, []);

  /** El texto tal como está ahora mismo. */
  const text = useCallback(() => {
    const s = session.current;
    return s ? (s.read ? s.read() : s.text) : '';
  }, []);

  /**
   * El original cambió por fuera: o se guarda igual lo propio, o queda el de afuera. En
   * ese caso lo propio tampoco se pierde: pasa a una hoja nueva, y se avisa cuál.
   */
  const resolve = useCallback(
    (keep: 'mine' | 'theirs') => {
      const s = session.current;
      if (!s) return;
      if (keep === 'mine') {
        s.blocked = false;
        void save(s, true);
        return;
      }
      window.clearTimeout(s.timer);
      if (s.read) s.text = s.read();
      s.read = null;
      session.current = null;
      setWriting(null);
      setRecent(null);
      if (s.text.trim() && s.text !== s.savedText) {
        api
          .createNote(`${s.savedTitle || 'notas'} (copia de Folio)`, s.text, s.categoryId)
          .then((rescued) => handlers.current.onNotice(`Quedó el de afuera. Lo que habías escrito está en «${rescued.title}».`))
          .catch((reason) => handlers.current.onNotice(`No se pudo guardar lo que habías escrito: ${String(reason)}`));
      }
      handlers.current.onEnded(s.id);
    },
    [save],
  );

  const setCategory = useCallback((categoryId: number | null) => {
    const s = session.current;
    if (!s) return;
    s.categoryId = categoryId ?? undefined;
    if (s.id !== DRAFT) {
      void api.setSheetCategory(s.id, categoryId).catch(() => {});
    }
  }, []);

  const consumeRecent = useCallback(() => setRecent(null), []);

  const getSavedText = useCallback((id: number): string | null => {
    const s = session.current;
    return s && s.id === id ? s.savedText : null;
  }, []);

  /**
   * Incorpora un recorte recibido mientras se edita la hoja: actualiza la base guardada en disco
   * y el texto de la sesión sin pisar lo que el usuario está escribiendo.
   */
  const appendExternal = useCallback((id: number, currentText: string, onDiskContent: string, hash?: string) => {
    const s = session.current;
    if (s && s.id === id) {
      s.text = currentText;
      s.savedText = onDiskContent;
      if (hash) s.hash = hash;
      setRecent((current) => (current && current.id === id ? { id, text: currentText, hash } : current));
    }
  }, []);

  /**
   * Sincroniza el contenido de la sesión cuando la hoja fue actualizada externamente (ej. recorte recibido en background).
   * Solo sincroniza si NO se está escribiendo activamente esa hoja.
   */
  const syncExternal = useCallback((id: number, content: string, hash?: string) => {
    const s = session.current;
    if (s && s.id === id) {
      return;
    } else {
      setRecent((current) => (current && current.id === id ? null : current));
    }
  }, []);

  return useMemo(
    () => ({
      writing,
      recent,
      begin,
      finish,
      touched,
      rename,
      flush,
      attach,
      text,
      resolve,
      setCategory,
      consumeRecent,
      syncExternal,
      getSavedText,
      appendExternal,
    }),
    [
      writing,
      recent,
      begin,
      finish,
      touched,
      rename,
      flush,
      attach,
      text,
      resolve,
      setCategory,
      consumeRecent,
      syncExternal,
      getSavedText,
      appendExternal,
    ],
  );
}

// ---- el editor: un bloque de texto editable dentro de la hoja ----------------

/**
 * En un bloque editable el último salto de línea no se dibuja: hace falta uno de más
 * para que el renglón final exista y se pueda escribir en él.
 */
export const toEditor = (text: string) => (text.endsWith('\n') ? `${text}\n` : text);

/** Texto de un bloque editable, sin el salto de línea de más (ver `toEditor`). */
export function readEditor(node: HTMLElement): string {
  let text = '';
  const walk = (parent: Node) => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += (child as Text).data;
      else if (child.nodeName === 'BR') text += '\n';
      else walk(child);
    }
  };
  walk(node);
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** Obtiene el desplazamiento del cursor respecto al texto de `readEditor`. */
export function getEditorCaret(node: HTMLElement): number | null {
  const selection = getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!node.contains(range.startContainer)) return null;

  let offset = 0;
  let found = false;

  const walk = (parent: Node): boolean => {
    if (parent === range.startContainer) {
      if (parent.nodeType === Node.TEXT_NODE) {
        offset += range.startOffset;
      }
      found = true;
      return true;
    }

    if (parent.nodeType === Node.TEXT_NODE) {
      offset += (parent as Text).data.length;
      return false;
    }

    if (parent.nodeName === 'BR') {
      offset += 1;
      return false;
    }

    const children = parent.childNodes;
    for (let i = 0; i < children.length; i++) {
      if (parent === range.startContainer && i === range.startOffset) {
        found = true;
        return true;
      }
      const child = children[i];
      if (walk(child)) return true;
    }
    return false;
  };

  walk(node);
  return found ? offset : null;
}

/** Restaura el cursor a la posición exacta en el editor. */
export function setEditorCaret(node: HTMLElement, targetOffset: number) {
  const selection = getSelection();
  if (!selection) return;

  let current = 0;
  let targetNode: Node | null = null;
  let targetNodeOffset = 0;

  const walk = (parent: Node): boolean => {
    if (parent.nodeType === Node.TEXT_NODE) {
      const len = (parent as Text).data.length;
      if (current + len >= targetOffset) {
        targetNode = parent;
        targetNodeOffset = targetOffset - current;
        return true;
      }
      current += len;
      return false;
    }

    for (let i = 0; i < parent.childNodes.length; i++) {
      const child = parent.childNodes[i];
      if (child.nodeName === 'BR') {
        if (current + 1 > targetOffset) {
          targetNode = parent;
          targetNodeOffset = i;
          return true;
        }
        current += 1;
      } else if (child.nodeType === Node.TEXT_NODE) {
        const len = (child as Text).data.length;
        if (current + len >= targetOffset) {
          targetNode = child;
          targetNodeOffset = targetOffset - current;
          return true;
        }
        current += len;
      } else {
        if (walk(child)) return true;
      }
    }
    return false;
  };

  walk(node);

  const range = document.createRange();
  if (targetNode) {
    try {
      range.setStart(
        targetNode,
        Math.min(
          targetNodeOffset,
          targetNode.nodeType === Node.TEXT_NODE ? (targetNode as Text).length : targetNode.childNodes.length,
        ),
      );
    } catch {
      range.selectNodeContents(node);
      range.collapse(false);
    }
  } else {
    range.selectNodeContents(node);
    range.collapse(false);
  }
  range.collapse(true);
  node.focus({ preventScroll: true });
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Pone el cursor en esa posición del texto (o al final) y le da el foco al editor. */
export function placeCaret(node: HTMLElement, at: number | 'end') {
  if (typeof at === 'number') {
    setEditorCaret(node, at);
    return;
  }
  const selection = getSelection();
  if (!selection) return;
  const range = document.createRange();
  const last = node.lastChild;
  if (last?.nodeType === Node.TEXT_NODE) {
    // Después del salto de línea de más no se escribe: el final es justo antes.
    const text = last as Text;
    range.setStart(text, text.data.endsWith('\n') ? text.length - 1 : text.length);
  } else if (last?.nodeName === 'BR') {
    // Lo mismo si el último salto lo puso el navegador como elemento.
    range.setStart(node, node.childNodes.length - 1);
  } else {
    range.selectNodeContents(node);
    range.collapse(false);
  }
  range.collapse(true);
  node.focus({ preventScroll: true });
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Lugar del texto (nodo y desplazamiento) que queda bajo ese punto de la pantalla, si hay alguno. */
export function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const from = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = from.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = from.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** Rectángulo de la pantalla: el área de texto de una hoja. */
export interface Area {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Lugar del texto más cercano a ese punto. Sirve para los clics fuera del texto (un
 * margen, el pie, el papel en blanco): como en cualquier editor, a la izquierda de un
 * renglón es su principio, a la derecha su final, y debajo de todo es el final del
 * texto. `area` es el área de texto de la hoja donde cayó el clic.
 */
function nearest(node: HTMLElement, x: number, y: number, area: Area): { node: Node; offset: number } | 'start' | 'end' {
  const px = Math.min(area.right - 2, Math.max(area.left + 2, x));
  const py = Math.min(area.bottom - 3, Math.max(area.top + 3, y));
  const hit = caretFromPoint(px, py);
  if (hit && node.contains(hit.node)) return hit;
  // Ahí no hay texto. Arriba de donde empieza (el encabezado) es el principio; el resto, el final.
  const lead = node.previousElementSibling?.getBoundingClientRect();
  const aboveText = lead !== undefined && lead.height > 0 && px >= lead.left && px <= lead.right && py <= lead.bottom;
  return aboveText ? 'start' : 'end';
}

/** Lleva el cursor al lugar del texto más cercano a ese punto (ver `nearest`). */
export function placeCaretNear(node: HTMLElement, x: number, y: number, area: Area) {
  const hit = nearest(node, x, y, area);
  const selection = getSelection();
  if (typeof hit !== 'string' && selection) {
    node.focus({ preventScroll: true });
    selection.collapse(hit.node, hit.offset);
    return;
  }
  placeCaret(node, hit === 'start' ? 0 : 'end');
}

/**
 * Lo mismo, pero en una hoja que se está leyendo: devuelve la posición del texto, lista
 * para `placeCaret`, donde tiene que quedar el cursor cuando la hoja pase a escribirse.
 * Si lo que se ve no es el texto tal cual (una hoja con formato), `toSource` dice qué
 * posición del original corresponde a un lugar de lo dibujado.
 */
export function offsetNear(
  node: HTMLElement,
  x: number,
  y: number,
  area: Area,
  toSource?: (node: Node, offset: number) => number | null,
): number | 'end' {
  const hit = nearest(node, x, y, area);
  if (hit === 'start') return 0;
  if (hit === 'end') return 'end';
  if (toSource) return toSource(hit.node, hit.offset) ?? 'end';
  if (hit.node.nodeType === Node.TEXT_NODE) return hit.node === node.firstChild ? hit.offset : 'end';
  return hit.offset === 0 ? 0 : 'end';
}

/**
 * Para saber en qué renglón está el cursor: el último carácter visible que tiene antes
 * (`rect`, o `null` si no hay ninguno) y cuántos saltos de línea hay entre los dos.
 *
 * No se mide el cursor directamente porque, con el texto repartido en columnas, el
 * navegador informa mal la posición de un renglón vacío; la de una letra, en cambio,
 * siempre es buena.
 */
export function caretAnchor(node: HTMLElement): { rect: DOMRect | null; breaks: number } | null {
  const selection = getSelection();
  const focus = selection?.focusNode;
  if (!selection || !focus || !node.contains(focus)) return null;
  const range = document.createRange();
  let breaks = 0;
  let current: Node = focus;
  let index = selection.focusOffset;
  for (;;) {
    if (current.nodeType === Node.TEXT_NODE) {
      const data = (current as Text).data;
      while (index > 0) {
        index--;
        if (data[index] === '\n') {
          breaks++;
          continue;
        }
        range.setStart(current, index);
        range.setEnd(current, index + 1);
        const drawn = [...range.getClientRects()].filter((rect) => rect.height > 0);
        if (drawn.length) return { rect: drawn[drawn.length - 1], breaks };
      }
    } else {
      let inner: Node | null = null;
      while (index > 0 && !inner) {
        index--;
        const child = current.childNodes[index];
        if (child.nodeName === 'BR') breaks++;
        else inner = child;
      }
      if (inner) {
        // Se sigue hacia atrás por dentro de ese nodo, desde su final.
        current = inner;
        index = inner.nodeType === Node.TEXT_NODE ? (inner as Text).length : inner.childNodes.length;
        continue;
      }
    }
    // Se terminó este nodo: se sigue con lo que tiene antes, en su padre.
    if (current === node || !current.parentNode) return { rect: null, breaks };
    const parent: Node = current.parentNode;
    index = [...parent.childNodes].indexOf(current as ChildNode);
    current = parent;
  }
}
