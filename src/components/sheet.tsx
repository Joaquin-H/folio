// Datos y acciones de una hoja, separados de cómo se dibuja en el cuaderno.
import { useEffect, useState } from 'react';
import {
  ExternalLink,
  EyeOff,
  FileText,
  FolderOpen,
  Lock,
  LockOpen,
  NotebookPen,
  PenLine,
  Pin,
  PinOff,
  SquareArrowOutUpRight,
  StickyNote,
  Undo2,
} from 'lucide-react';
import { api } from '../api';
import { parentFolder } from '../format';
import { quote, t, useT } from '../i18n';
import { hintOf } from '../shortcuts';
import type { Category, SheetDetail, SheetSummary, Source } from '../types';
import { Confirm, Presence, type MenuItem } from './ui';

/** Cuánto tarda en irse la pregunta de la papelera: recién después la hoja deja el cuaderno. */
const CONFIRM_OUT = 170;

export const SOURCE_ICON: Record<Source, typeof FileText> = {
  file: FileText,
  notepad: NotebookPen,
  sticky: StickyNote,
  capture: PenLine,
};

export function sourceLabel(sheet: SheetSummary): string {
  switch (sheet.source) {
    case 'file': {
      const folder = sheet.path ? parentFolder(sheet.path) : '';
      const display = folder.toLowerCase() === 'book' || folder.toLowerCase() === 'folio' ? 'Folio' : folder;
      return display ? t('en {folder}', { folder: display }) : t('Archivo');
    }
    case 'notepad':
      return sheet.missing ? t('Bloc de notas, pestaña cerrada') : t('Bloc de notas, sin guardar');
    case 'sticky':
      return 'Sticky Notes';
    case 'capture':
      return t('Escrita en Folio');
  }
}

/** Contenido completo y versiones de una hoja; se recarga cuando la hoja cambia. */
export function useSheetDetail(sheet: SheetSummary | undefined, enabled = true, revision?: number): SheetDetail | null {
  const [detail, setDetail] = useState<SheetDetail | null>(null);
  const id = sheet?.id;
  const stamp = sheet ? `${sheet.modifiedAt}:${sheet.versionCount}` : '';
  useEffect(() => {
    if (id === undefined || !enabled) return;
    let alive = true;
    api
      .getSheet(id)
      .then((result) => alive && setDetail(result))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, stamp, enabled, revision]);
  return detail && detail.id === id ? detail : null;
}

/**
 * Menús de una hoja (categoría y acciones) y el último error al ejecutarlos. Mandar una
 * hoja a la papelera se pregunta antes: `dialogs` es esa pregunta, para dibujarla.
 */
export function useSheetMenus(
  sheet: SheetSummary,
  categories: Category[],
  onSelectCategory?: (categoryId: number | null) => void,
) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [askTrash, setAskTrash] = useState(false);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const run = (action: Promise<unknown>) => void action.catch((reason) => setError(String(reason)));
  const selectCategory = (categoryId: number | null) => {
    if (onSelectCategory) onSelectCategory(categoryId);
    else run(api.setSheetCategory(sheet.id, categoryId));
  };

  const categoryItems: MenuItem[] = [
    ...categories.map((c) => ({
      label: c.name,
      icon: <span className="dot" style={{ background: c.color }} />,
      checked: c.id === sheet.categoryId,
      onSelect: () => selectCategory(c.id),
    })),
    {
      label: t('Sin categoría'),
      separator: true,
      checked: sheet.categoryId === null,
      onSelect: () => selectCategory(null),
    },
  ];

  const togglePinned = () => run(api.setSheetPinned(sheet.id, !sheet.pinned));
  const tearOff = () => run(api.tearOffSheet(sheet.id, false));

  const moreItems: MenuItem[] = [
    {
      label: t('Arrancar hoja'),
      icon: <ExternalLink size={14} />,
      hint: hintOf('tear-off'),
      onSelect: tearOff,
    },
    {
      label: sheet.pinned ? t('Desfijar hoja') : t('Fijar hoja'),
      icon: sheet.pinned ? <PinOff size={14} /> : <Pin size={14} />,
      onSelect: togglePinned,
    },
  ];
  if (sheet.path && !sheet.missing) {
    moreItems.push(
      {
        label: t('Abrir el original'),
        icon: <SquareArrowOutUpRight size={14} />,
        onSelect: () => run(api.openOriginal(sheet.id, false)),
      },
      {
        label: t('Mostrar en la carpeta'),
        icon: <FolderOpen size={14} />,
        onSelect: () => run(api.openOriginal(sheet.id, true)),
      },
    );
  }
  moreItems.push(
    sheet.secret
      ? {
          label: t('Quitar del secret-book'),
          icon: <LockOpen size={14} />,
          separator: moreItems.length > 0,
          onSelect: () => run(api.setSheetSecret(sheet.id, false)),
        }
      : {
          label: t('Mover al secret-book'),
          icon: <Lock size={14} />,
          separator: moreItems.length > 0,
          onSelect: () => run(api.setSheetSecret(sheet.id, true)),
        },
    sheet.hidden
      ? {
          label: t('Sacar de la papelera'),
          icon: <Undo2 size={14} />,
          onSelect: () => run(api.setSheetHidden(sheet.id, false)),
        }
      : {
          label: t('Mover a la papelera'),
          icon: <EyeOff size={14} />,
          danger: true,
          // Un clic de más en el menú no alcanza para sacar una hoja del cuaderno.
          onSelect: () => setAskTrash(true),
        },
  );

  const dialogs = (
    <Presence show={askTrash} exitMs={CONFIRM_OUT}>
      {(leaving) => (
        <Confirm
          title={t('¿Mover esta hoja a la papelera?')}
          detail={t('{title} sale del cuaderno, pero no se borra: podés recuperarla cuando quieras desde la papelera.', {
            title: quote(sheet.title),
          })}
          confirm={t('Mover a la papelera')}
          danger
          leaving={leaving}
          onCancel={() => setAskTrash(false)}
          onConfirm={() => {
            setAskTrash(false);
            // La hoja se va cuando la pregunta terminó de irse: si no, la pregunta
            // desaparecería de golpe junto con la hoja.
            window.setTimeout(() => run(api.setSheetHidden(sheet.id, true)), CONFIRM_OUT);
          }}
        />
      )}
    </Presence>
  );

  return {
    categoryItems,
    moreItems,
    error,
    togglePinned,
    tearOff,
    /** Saca la hoja de la papelera. */
    restore: () => run(api.setSheetHidden(sheet.id, false)),
    dialogs,
  };
}

/** Avisos de una hoja: original eliminado, detectada como sensible, confianza del clasificador. */
export function SheetBadges(props: { sheet: SheetSummary }) {
  const t = useT();
  const { sheet } = props;
  return (
    <>
      {sheet.source === 'file' && sheet.missing && (
        <>
          <span className="meta-sep" aria-hidden="true">·</span>
          <span className="badge warn">{t('Original eliminado')}</span>
        </>
      )}
      {sheet.secret && sheet.secretSource === 'auto' && (
        <>
          <span className="meta-sep" aria-hidden="true">·</span>
          <span className="badge warn">{t('Detectada como sensible')}</span>
        </>
      )}
      {sheet.categorySource === 'jev' && sheet.categoryConfidence !== null && (
        <>
          <span className="meta-sep" aria-hidden="true">·</span>
          <span className="badge" title={t('Confianza de la IA que eligió la categoría')}>
            {t('IA {percent}%', { percent: Math.round(sheet.categoryConfidence * 100) })}
          </span>
        </>
      )}
    </>
  );
}
