import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { ChevronDown, PaintBucket } from 'lucide-react';
import { useDismiss, usePresence } from '../hooks';
import { useT } from '../i18n';

interface Hsv {
  h: number;
  s: number;
  v: number;
}

function hexToHsv(hex: string): Hsv {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? '2b2c31';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    const value = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}

/** Tonos de tela y cuero que quedan bien en una tapa. */
const SUGGESTED = ['#7A3B2E', '#A65A3A', '#8C6B3F', '#5E6B3A', '#2F5D50', '#2D4F6C', '#3D3A6B', '#6B3A5E', '#4A4A4F', '#D8CDBA'];

/** Alto aproximado del panel abierto, para decidir si se abre hacia abajo o hacia arriba. */
const PANEL_HEIGHT = 262;

/** El contenedor más cercano que se desplaza, o `null` si es la ventana. */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let parent = node?.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/**
 * Selector de color propio, en lugar del cuadro del sistema: un botón abre un panel con
 * el plano de tonos, el matiz, algunas sugerencias y el código. Sirve a dos usos: el de
 * la tapa (botón con un balde) y el de una categoría (círculo del color actual con una
 * flecha, que se lee como botón), con sus propias sugerencias.
 */
export function ColorPicker(props: {
  value: string | null;
  onChange: (hex: string) => void;
  /** Con el balde: el color es uno propio, no uno de los sugeridos. Se marca el botón. */
  active?: boolean;
  /** 'bucket' es un balde; 'well' es el círculo del color actual con una flecha. */
  variant?: 'bucket' | 'well';
  /** Colores a la vista dentro del panel; por defecto, los de tela y cuero de las tapas. */
  suggested?: readonly string[];
  /** Qué botón es, para el lector de pantalla y el cartelito: "Cambiar el color de Trabajo". */
  title?: string;
  /** Nombre del panel. */
  label?: string;
  /** De qué lado del botón queda alineado el panel. */
  align?: 'left' | 'right';
}) {
  const t = useT();
  const { variant = 'bucket', suggested = SUGGESTED, align = 'right' } = props;
  const title = props.title ?? t('Elegir otro color');
  const label = props.label ?? t('Color de la tapa');
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(props.value ?? '#2b2c31'));
  const [code, setCode] = useState(props.value ?? '');
  const ref = useDismiss(open, () => setOpen(false));
  const panel = usePresence(open, 120);
  const plane = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // Esc cierra solo el panel: si el selector vive dentro de un modal, el modal sigue abierto.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  // Si abajo no queda lugar (por ejemplo en la última fila de una lista), el panel se abre hacia arriba.
  const toggle = () => {
    if (!open && trigger.current) {
      const rect = trigger.current.getBoundingClientRect();
      const bounds = scrollParent(trigger.current)?.getBoundingClientRect();
      const below = Math.min(bounds?.bottom ?? Infinity, window.innerHeight) - rect.bottom;
      const upward = rect.top - Math.max(bounds?.top ?? 0, 0);
      setAbove(below < PANEL_HEIGHT && upward > below);
    }
    setOpen((value) => !value);
  };

  // Al abrir, el panel arranca en el color actual de la tapa.
  useEffect(() => {
    if (!open) return;
    const start = props.value ?? '#2b2c31';
    setHsv(hexToHsv(start));
    setCode(start.toUpperCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const commit = (next: Hsv) => {
    const hex = hsvToHex(next);
    setHsv(next);
    setCode(hex.toUpperCase());
    props.onChange(hex);
  };

  // Un color sugerido se entrega tal cual, sin pasar por el plano (que lo redondearía).
  const choose = (hex: string) => {
    setHsv(hexToHsv(hex));
    setCode(hex.toUpperCase());
    props.onChange(hex);
  };

  const pick = (event: PointerEvent) => {
    const rect = plane.current?.getBoundingClientRect();
    if (!rect) return;
    const s = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const v = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    commit({ ...hsv, s, v });
  };

  return (
    <div className="menu" ref={ref}>
      <button
        ref={trigger}
        type="button"
        className={variant === 'well' ? 'color-well' : `bucket${props.active ? ' active' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={title}
        title={title}
        onClick={toggle}
      >
        {variant === 'well' ? (
          <>
            <span className="color-well-dot" style={{ background: props.value ?? undefined }} />
            <ChevronDown size={11} strokeWidth={2.5} />
          </>
        ) : (
          <PaintBucket size={14} />
        )}
      </button>
      {panel.mounted && (
        <div
          className={`color-panel${align === 'left' ? ' left' : ''}${above ? ' above' : ''}${panel.leaving ? ' leaving' : ''}`}
          role="dialog"
          aria-label={label}
        >
          <div
            ref={plane}
            className="color-plane"
            style={{ '--hue': hsv.h } as CSSProperties}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              pick(event);
            }}
            onPointerMove={(event) => event.buttons & 1 && pick(event)}
          >
            <span className="color-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
          </div>
          <input
            type="range"
            className="color-hue"
            min={0}
            max={359}
            value={Math.round(hsv.h)}
            aria-label={t('Matiz')}
            onChange={(event) => commit({ ...hsv, h: Number(event.target.value) })}
          />
          <div className="color-suggested" role="radiogroup" aria-label={t('Colores sugeridos')}>
            {suggested.map((hex) => (
              <button
                key={hex}
                type="button"
                role="radio"
                aria-checked={hex.toLowerCase() === props.value?.toLowerCase()}
                className="swatch-button"
                style={{ background: hex }}
                aria-label={hex}
                title={hex}
                onClick={() => choose(hex)}
              />
            ))}
          </div>
          <label className="color-code">
            <span className="swatch-button" style={{ background: hsvToHex(hsv) }} />
            <input
              value={code}
              maxLength={7}
              spellCheck={false}
              aria-label={t('Código del color')}
              onChange={(event) => {
                const next = event.target.value.trim();
                setCode(next);
                if (/^#[0-9a-f]{6}$/i.test(next)) {
                  setHsv(hexToHsv(next));
                  props.onChange(next.toLowerCase());
                }
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
