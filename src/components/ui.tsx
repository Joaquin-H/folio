import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, X } from 'lucide-react';
import { useDismiss, usePresence } from '../hooks';
import { useT } from '../i18n';

/** Tecla de los atajos, como se la nombra en cada sistema. */
export const MOD = /Mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl';

export function Switch(props: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      className="switch"
      onClick={() => props.onChange(!props.checked)}
    />
  );
}

export function Segmented<T extends string | number>(props: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={`segmented${props.className ? ` ${props.className}` : ''}`} role="tablist" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === props.value}
          aria-label={option.title}
          title={option.title}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper(props: { value: number; min: number; max: number; onChange: (next: number) => void; label: string }) {
  const t = useT();
  const set = (next: number) => props.onChange(Math.min(props.max, Math.max(props.min, next)));
  return (
    <div className="stepper" role="group" aria-label={props.label}>
      <button type="button" onClick={() => set(props.value - 1)} disabled={props.value <= props.min} aria-label={t('Menos')}>
        −
      </button>
      <output>{props.value}</output>
      <button type="button" onClick={() => set(props.value + 1)} disabled={props.value >= props.max} aria-label={t('Más')}>
        +
      </button>
    </div>
  );
}

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  separator?: boolean;
  /** Atajo de teclado, mostrado a la derecha. */
  hint?: string;
  onSelect: () => void;
}

/** Renglón del menú con varias opciones a la vista, para elegir una sin pasar por las demás. */
export interface MenuChoices {
  label: string;
  separator?: boolean;
  choices: { label: string; title?: string; selected: boolean; onSelect: () => void }[];
}

export type MenuItem = MenuAction | MenuChoices;

/** Botón con menú desplegable. */
export function Menu(props: {
  trigger: ReactNode;
  items: MenuItem[];
  label: string;
  /** Renglón de título dentro del menú: dice sobre qué actúan las opciones. */
  heading?: string;
  className?: string;
  /** Clase extra para el contenedor, por ejemplo para posicionarlo. */
  anchorClassName?: string;
  style?: CSSProperties;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const list = usePresence(open, 110);
  const listRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.left < 8) {
      node.style.right = 'auto';
      node.style.left = `${Math.max(0, 8 - (node.parentElement?.getBoundingClientRect().left ?? 0))}px`;
    }
    if (rect.right > window.innerWidth - 8) {
      node.style.left = 'auto';
      node.style.right = '0';
    }
    const triggerRect = node.parentElement?.getBoundingClientRect();
    if (triggerRect) {
      const spaceBelow = window.innerHeight - triggerRect.bottom - 10;
      const spaceAbove = triggerRect.top - 10;
      if (rect.height > spaceBelow && spaceAbove > spaceBelow && spaceAbove >= 140) {
        node.classList.add('above');
        node.style.maxHeight = `${Math.max(120, Math.floor(spaceAbove))}px`;
      } else {
        node.classList.remove('above');
        node.style.maxHeight = `${Math.max(120, Math.floor(spaceBelow))}px`;
      }
      if (node.scrollHeight > Math.floor(Math.max(spaceBelow, spaceAbove)) || window.innerHeight <= 440) {
        node.classList.add('compact');
      }
    }
  }, []);
  return (
    <div className={`menu${props.anchorClassName ? ` ${props.anchorClassName}` : ''}`} ref={ref}>
      <button
        type="button"
        className={props.className}
        style={props.style}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.label}
        title={props.label}
        onClick={() => setOpen((value) => !value)}
      >
        {props.trigger}
      </button>
      {list.mounted && (
        <div ref={listRef} className={`menu-list ${props.align === 'left' ? 'left' : 'right'}${list.leaving ? ' leaving' : ''}`} role="menu">
          {props.heading && <div className="menu-heading">{props.heading}</div>}
          {props.items.map((item) =>
            'choices' in item ? (
              <div key={item.label} className={`menu-row${item.separator ? ' separated' : ''}`} role="group" aria-label={item.label}>
                <span className="menu-label">{item.label}</span>
                <span className="menu-choices">
                  {item.choices.map((choice) => (
                    <button
                      key={choice.label}
                      type="button"
                      role="menuitemradio"
                      aria-checked={choice.selected}
                      title={choice.title}
                      onClick={() => {
                        setOpen(false);
                        choice.onSelect();
                      }}
                    >
                      {choice.label}
                    </button>
                  ))}
                </span>
              </div>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`menu-item${item.danger ? ' danger' : ''}${item.separator ? ' separated' : ''}`}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span className="menu-icon">{item.checked ? '✓' : item.icon}</span>
                <span className="menu-label">{item.label}</span>
                {item.hint && <kbd>{item.hint}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Mantiene a sus hijos un instante más cuando `show` pasa a falso, avisándoles que se van. */
export function Presence(props: { show: boolean; exitMs?: number; children: (leaving: boolean) => ReactNode }) {
  const { mounted, leaving } = usePresence(props.show, props.exitMs);
  return mounted ? <>{props.children(leaving)}</> : null;
}

/**
 * Hoja modal centrada, al estilo de las hojas de iOS. Se dibuja sobre el documento
 * entero, sin importar desde qué parte de la interfaz se abra.
 */
export function Modal(props: {
  title: string;
  onClose: () => void;
  onPopOut?: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Se está yendo: reproduce la transición de salida. */
  leaving?: boolean;
}) {
  const { onClose, onPopOut } = props;
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className={`backdrop${props.leaving ? ' leaving' : ''}`} onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title}>
        <header className="modal-header">
          <h2>{props.title}</h2>
          <div className="modal-header-actions">
            {onPopOut && (
              <button
                type="button"
                className="icon-button modal-popout"
                onClick={onPopOut}
                aria-label={t('Abrir en una ventana aparte')}
                title={t('Abrir en una ventana aparte')}
              >
                <ArrowUpRight size={16} />
              </button>
            )}
            <button type="button" className="icon-button" onClick={onClose} aria-label={t('Cerrar')}>
              <X size={16} />
            </button>
          </div>
        </header>
        {props.children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Pregunta corta antes de hacer algo que conviene no hacer por accidente. El foco arranca
 * en «Cancelar», así Enter no confirma si no se lo eligió; Esc o un clic afuera cancelan.
 */
export function Confirm(props: {
  title: string;
  /** Aclaración debajo de la pregunta: qué va a pasar. */
  detail?: ReactNode;
  /** Lo que dice el botón que confirma. */
  confirm: string;
  cancel?: string;
  /** La acción saca algo de la vista: el botón que confirma va en rojo. */
  danger?: boolean;
  /** Se está yendo: reproduce la transición de salida. */
  leaving?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { onCancel, leaving } = props;
  const t = useT();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Al cerrarse, el foco vuelve a donde estaba (si eso sigue en pantalla).
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return onCancel();
      if (event.key !== 'Tab') return;
      // El foco no sale de la pregunta: de un botón pasa al otro.
      const buttons = [...(panel.current?.querySelectorAll('button') ?? [])];
      if (buttons.length === 0) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div className={`backdrop${leaving ? ' leaving' : ''}`} onPointerDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div
        ref={panel}
        className="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={props.title}
        aria-describedby={props.detail ? `${id}-detail` : undefined}
      >
        <h2>{props.title}</h2>
        {props.detail && <p id={`${id}-detail`}>{props.detail}</p>}
        <div className="confirm-actions">
          <button ref={cancel} type="button" className="button" onClick={leaving ? undefined : onCancel}>
            {props.cancel ?? t('Cancelar')}
          </button>
          <button type="button" className={`button ${props.danger ? 'danger' : 'primary'}`} onClick={leaving ? undefined : props.onConfirm}>
            {props.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
