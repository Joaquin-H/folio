import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from 'react';
import { Ellipsis, FlipHorizontal2, ImagePlus, Move, RotateCw, SquarePen, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { useSize } from '../hooks';
import { useT } from '../i18n';
import { belongsToTarget, format, hintOf, matches, useShortcuts } from '../shortcuts';
import type { CoverStyle } from '../types';
import {
  addSticker,
  FACE_NAME,
  fitPlacement,
  placeSticker,
  raiseSticker,
  removeSticker,
  StickerError,
  stickersOn,
  useStickerImage,
  useStickers,
  type Face,
  type Sticker,
} from './stickers';
import { Menu, Presence, type MenuItem } from './ui';
import '../styles/cover.css';

/** Dar vuelta el cuaderno: cuánto tarda en ponerse de canto y cuánto en volver a quedar de frente. */
const FLIP_OUT = 170;
const FLIP_IN = 230;
const NOTICE_MS = 6000;
/** Al girar una imagen arrastrando, se "pega" a derecha, de costado y cabeza abajo si pasa cerca. */
const TURN_SNAP = 4;
/** Cuánto gira cada paso de la rueda, en grados, y cuánto hay que girarla para un paso. */
const WHEEL_TURN = 5;
const WHEEL_STEP = 40;
/** Con el teclado: cuánto corre cada flecha (fracción de la tapa) y cuánto agranda cada + o −. */
const NUDGE = 0.01;
const GROW = 1.08;
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * Las dos caras del cuaderno cerrado y el giro que lleva de una a la otra: el cuaderno se
 * pone de canto, cambia de cara y vuelve a quedar de frente. `flip` dice en qué mitad del
 * giro va, para animarlo (styles/cover.css).
 */
export function useFaces() {
  const [face, setFace] = useState<Face>('front');
  const [flip, setFlip] = useState<'out' | 'in' | null>(null);
  const shown = useRef<Face>('front');
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  /** Muestra esa cara sin giro (al cerrar el cuaderno por una punta o por la otra). */
  const show = useCallback((next: Face) => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    shown.current = next;
    setFlip(null);
    setFace(next);
  }, []);

  /** Da vuelta el cuaderno. Mientras gira, un segundo pedido no hace nada. */
  const turn = useCallback(() => {
    if (timer.current) return;
    const next: Face = shown.current === 'front' ? 'back' : 'front';
    shown.current = next;
    // Sin animaciones (preferencia del sistema) no hay giro: cambia de cara y listo.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setFace(next);
    setFlip('out');
    timer.current = window.setTimeout(() => {
      setFace(next);
      setFlip('in');
      timer.current = window.setTimeout(() => {
        timer.current = 0;
        setFlip(null);
      }, FLIP_IN);
    }, FLIP_OUT);
  }, []);

  return { face, flip, show, turn };
}

/**
 * Dónde va una imagen sobre la tapa: todo en proporción a ella, así acompaña su tamaño.
 * Cuál queda encima lo dice `zIndex` y no el orden en el documento: traer una al frente
 * no mueve su nodo, que puede tener el mouse capturado en medio de un arrastre.
 */
const placement = (sticker: Sticker): CSSProperties => ({
  left: `${sticker.x * 100}%`,
  top: `${sticker.y * 100}%`,
  width: `${sticker.width * 100}%`,
  aspectRatio: `1 / ${sticker.ratio}`,
  rotate: `${sticker.turn}deg`,
  zIndex: sticker.order,
});

function StickerImage(props: { sticker: Sticker }) {
  const url = useStickerImage(props.sticker.id);
  return url ? <img className="sticker" src={url} alt="" draggable={false} style={placement(props.sticker)} /> : null;
}

type Gesture = 'move' | 'size' | 'turn';

/**
 * Tapa y contratapa del cuaderno cerrado. La tapa lleva la etiqueta con el nombre
 * (editable), cuántas hojas tiene y lo esencial; la contratapa es sobria, con el pie de
 * imprenta. Un clic abre el cuaderno y arrastrar mueve la ventana.
 *
 * En las dos se pueden pegar imágenes, como calcomanías (stickers.ts): desde el menú,
 * con Ctrl + V o soltando un archivo encima. Quedan inertes, salvo en el modo acomodar,
 * donde cada una se mueve, se agranda, se gira y se quita.
 */
export function Cover(props: {
  face: Face;
  skin: CoverStyle;
  name: string;
  onName: (name: string) => void;
  note: string;
  leaving: boolean;
  /** Acciones generales del menú; las de la tapa van entre unas y otras. */
  menuBefore: MenuItem[];
  menuAfter: MenuItem[];
  actions: { onCompose: () => void; onHide: () => void };
  onOpen: () => void;
  onFlip: () => void;
  /** Acá la tapa deja dicho si se están acomodando imágenes: mientras tanto no se abre. */
  busy: MutableRefObject<boolean>;
}) {
  const { face, onFlip } = props;
  const t = useT();
  const back = face === 'back';
  // Si se cambia el atajo de dar vuelta, el menú lo muestra al momento.
  useShortcuts();
  const everySticker = useStickers();
  /** Las de esta cara, en el orden en que se pegaron. */
  const stickers = useMemo(() => everySticker.filter((sticker) => sticker.face === face), [everySticker, face]);
  const [arranging, setArranging] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** La imagen que se está moviendo, agrandando o girando: se guarda recién al soltar. */
  const [draft, setDraft] = useState<Sticker | null>(null);
  const [dropping, setDropping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** El último aviso sigue escrito mientras se desvanece. */
  const shownNotice = useRef('');
  if (notice) shownNotice.current = notice;

  const [measure, size] = useSize<HTMLDivElement>();
  const root = useRef<HTMLDivElement | null>(null);
  const setRoot = useCallback(
    (node: HTMLDivElement | null) => {
      root.current = node;
      measure(node);
    },
    [measure],
  );
  const picker = useRef<HTMLInputElement>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const wheel = useRef(0);

  const shown = stickers.map((sticker) => (draft && draft.id === sticker.id ? draft : sticker));
  const chosen = arranging ? shown.find((sticker) => sticker.id === selected) : undefined;

  const { busy } = props;
  useEffect(() => {
    busy.current = arranging;
    // Acomodando, el teclado es de las imágenes: si el foco quedó en el nombre, lo suelta.
    if (arranging && document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    return () => {
      busy.current = false;
    };
  }, [busy, arranging]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const select = useCallback((id: string) => {
    setSelected(id);
    raiseSticker(id);
  }, []);

  const finish = useCallback(() => {
    setArranging(false);
    setSelected(null);
    setDraft(null);
  }, []);

  // Sin imágenes en esta cara no queda nada que acomodar.
  const none = stickers.length === 0;
  useEffect(() => {
    if (arranging && none) finish();
  }, [arranging, none, finish]);

  /** Pega esas imágenes en la cara que se está viendo y pasa a acomodarlas. */
  const paste = useCallback(
    async (files: Blob[], at?: { x: number; y: number }) => {
      let last: string | null = null;
      for (const [index, file] of files.entries()) {
        try {
          const spot = at && { x: at.x + index * 0.035, y: at.y + index * 0.035 };
          last = (await addSticker(file, face, spot)).id;
        } catch (reason) {
          setNotice(reason instanceof StickerError ? reason.message : t('No se pudo pegar la imagen.'));
          break;
        }
      }
      if (!last) return;
      setArranging(true);
      setSelected(last);
    },
    [face],
  );

  // Ctrl + V con una imagen en el portapapeles la pega en la cara que se está viendo.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (document.querySelector('.backdrop')) return;
      const files = [...(event.clipboardData?.files ?? [])];
      // Sin archivos es texto: sigue su curso (por ejemplo, hacia el nombre del cuaderno).
      if (files.length === 0) return;
      event.preventDefault();
      void paste(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [paste]);

  // Dar vuelta el cuaderno con el teclado (de fábrica, V): solo vale cerrado.
  useEffect(() => {
    if (arranging || props.leaving) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !matches(event, 'flip') || belongsToTarget(event)) return;
      if (document.querySelector('.backdrop, .menu-list')) return;
      event.preventDefault();
      onFlip();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [arranging, props.leaving, onFlip]);

  // Acomodando, el teclado es de la imagen elegida: las flechas la corren, + y − la
  // agrandan y la achican, Supr la quita; Esc o Enter terminan. Se escucha antes que
  // nadie para que esas teclas no lleguen a los atajos del cuaderno.
  useEffect(() => {
    if (!arranging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || document.querySelector('.backdrop')) return;
      const target = event.target instanceof Element ? event.target : null;
      const step = ARROWS[event.key];
      if (event.key === 'Escape' || (event.key === 'Enter' && !target?.closest('button'))) finish();
      else if (event.key === 'Delete' || event.key === 'Backspace') chosen && removeSticker(chosen.id);
      else if (step) chosen && placeSticker(chosen.id, { x: chosen.x + step[0] * NUDGE, y: chosen.y + step[1] * NUDGE });
      else if (event.key === '+' || event.key === '-') chosen && placeSticker(chosen.id, { width: chosen.width * (event.key === '+' ? GROW : 1 / GROW) });
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [arranging, chosen, finish]);

  /** Empieza a mover, agrandar o girar una imagen; lo hecho se guarda al soltar. */
  const begin = (kind: Gesture, sticker: Sticker) => (event: ReactPointerEvent<HTMLElement>) => {
    const cover = root.current?.getBoundingClientRect();
    if (event.button !== 0 || !cover) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    // Con el mouse capturado, los movimientos siguen llegando aunque salga de la tapa.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // sin captura igual sirve mientras el mouse no salga de la manija
    }
    select(sticker.id);
    const centre = { x: cover.left + sticker.x * cover.width, y: cover.top + sticker.y * cover.height };
    const from = { x: event.clientX, y: event.clientY };
    const reach = Math.hypot(from.x - centre.x, from.y - centre.y) || 1;
    const angle = Math.atan2(from.y - centre.y, from.x - centre.x);
    let latest = sticker;
    const onMove = (move: PointerEvent) => {
      if (kind === 'move') {
        latest = fitPlacement({ ...sticker, x: sticker.x + (move.clientX - from.x) / cover.width, y: sticker.y + (move.clientY - from.y) / cover.height });
      } else if (kind === 'size') {
        // Desde cualquier esquina, en proporción: crece o se achica alrededor de su centro.
        latest = fitPlacement({ ...sticker, width: (sticker.width * Math.hypot(move.clientX - centre.x, move.clientY - centre.y)) / reach });
      } else {
        const turned = sticker.turn + ((Math.atan2(move.clientY - centre.y, move.clientX - centre.x) - angle) * 180) / Math.PI;
        const square = Math.round(turned / 90) * 90;
        latest = fitPlacement({ ...sticker, turn: Math.abs(turned - square) <= TURN_SNAP ? square : turned });
      }
      setDraft(latest);
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      setDraft(null);
      if (latest !== sticker) placeSticker(sticker.id, { x: latest.x, y: latest.y, width: latest.width, turn: latest.turn });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  };

  /** La rueda sobre una imagen la gira de a pasos. */
  const spin = (sticker: Sticker) => (event: WheelEvent) => {
    event.stopPropagation();
    wheel.current += event.deltaY;
    if (Math.abs(wheel.current) < WHEEL_STEP) return;
    const direction = wheel.current > 0 ? 1 : -1;
    wheel.current = 0;
    if (selected !== sticker.id) select(sticker.id);
    placeSticker(sticker.id, { turn: Math.round((sticker.turn + direction * WHEEL_TURN) / WHEEL_TURN) * WHEEL_TURN });
  };

  const hasFiles = (event: DragEvent) => [...event.dataTransfer.types].includes('Files');
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDropping(false);
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    const cover = event.currentTarget.getBoundingClientRect();
    void paste(files, { x: (event.clientX - cover.left) / cover.width, y: (event.clientY - cover.top) / cover.height });
  };

  const interactive = (target: EventTarget) => !!(target as Element).closest('input, button, .menu, .cover-mode, .cover-arrange');
  const menu: MenuItem[] = [
    ...props.menuBefore,
    { label: t('Dar vuelta el cuaderno'), icon: <FlipHorizontal2 size={14} />, hint: hintOf('flip'), separator: true, onSelect: onFlip },
    // El menú abre el selector de archivos; el atajo pega lo que haya en el portapapeles.
    { label: t('Pegar una imagen…'), icon: <ImagePlus size={14} />, hint: format('Ctrl+V'), onSelect: () => picker.current?.click() },
    ...(none
      ? []
      : [
          {
            label: t('Acomodar las imágenes'),
            icon: <Move size={14} />,
            onSelect: () => {
              setArranging(true);
              // Arranca con la de más arriba elegida, así las manijas ya están a la vista.
              setSelected(stickersOn(stickers, face).at(-1)?.id ?? null);
            },
          },
        ]),
    ...props.menuAfter,
  ];
  const close = (
    <button
      type="button"
      className="icon-button cover-close"
      onClick={props.actions.onHide}
      aria-label={t('Cerrar la ventana')}
      title={t('Cerrar la ventana: Folio sigue en la bandeja, junto al reloj')}
    >
      <X size={15} />
    </button>
  );
  // Con una tapa angosta el cartel dice lo mismo con menos palabras.
  const tight = size.width > 0 && size.width < 350;

  return (
    <div
      ref={setRoot}
      className={`cover ${face}${props.leaving ? ' leaving' : ''}${arranging ? ' arranging' : ''}${dropping ? ' dropping' : ''}`}
      data-cover-style={props.skin}
      data-tauri-drag-region={arranging ? undefined : ''}
      onMouseDown={(event) => {
        if (event.button === 0 && !arranging && !interactive(event.target)) {
          api.window.drag();
        }
      }}
      onPointerDown={(event) => {
        dragged.current = false;
        press.current = arranging || interactive(event.target) ? null : { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        const start = press.current;
        if (!start || dragged.current || !(event.buttons & 1)) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) {
          dragged.current = true;
          api.window.drag();
        }
      }}
      onClick={(event) => {
        if (!arranging && !interactive(event.target) && !dragged.current) props.onOpen();
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      {/* El estilo de la tapa se dibuja en dos capas: una debajo de las imágenes pegadas
          (el color, el patrón, el lomo) y otra encima (la tira elástica, las costuras). */}
      <div className="cover-skin" aria-hidden="true" />
      <div className="cover-stickers" aria-hidden="true">
        {shown.map((sticker) => (
          <StickerImage key={sticker.id} sticker={sticker} />
        ))}
      </div>
      <div className="cover-over" aria-hidden="true" />

      {back ? (
        <>
          <div className="cover-controls">
            <Menu label={t('Menú')} className="icon-button" items={menu} trigger={<Ellipsis size={17} />} />
            {close}
          </div>
          {/* pie de imprenta */}
          <p className="cover-imprint">
            <strong>Folio</strong>
            <span>{t('Hecho por J.')}</span>
          </p>
        </>
      ) : (
        <>
          <div className="cover-controls">{close}</div>
          <div className="cover-label">
            <input
              className="cover-name"
              value={props.name}
              maxLength={40}
              placeholder={t('Mi cuaderno')}
              aria-label={t('Nombre del cuaderno')}
              title={t('Cambiar el nombre del cuaderno')}
              spellCheck={false}
              onChange={(event) => props.onName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
            />
            <div className="cover-row">
              <span>{props.note}</span>
              <span className="cover-actions">
                <button type="button" className="icon-button" onClick={props.actions.onCompose} aria-label={t('Nueva hoja')} title={t('Nueva hoja')}>
                  <SquarePen size={15} />
                </button>
                <Menu label={t('Menú')} className="icon-button" items={menu} trigger={<Ellipsis size={17} />} />
              </span>
            </div>
          </div>
          <span className="cover-brand">Folio</span>
        </>
      )}

      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          void paste(files);
        }}
      />

      <Presence show={arranging}>
        {(leaving) => (
          <>
            <div
              className={`cover-arrange${leaving ? ' leaving' : ''}`}
              onPointerDown={(event) => event.target === event.currentTarget && setSelected(null)}
            >
              {shown.map((sticker, index) => {
                const active = sticker.id === chosen?.id;
                return (
                  <div
                    key={sticker.id}
                    className={`sticker-box${active ? ' selected' : ''}`}
                    style={placement(sticker)}
                    role="button"
                    tabIndex={0}
                    aria-label={t('Imagen {n} de {total}', { n: index + 1, total: shown.length })}
                    aria-pressed={active}
                    title={active ? undefined : t('Elegir esta imagen')}
                    onPointerDown={begin('move', sticker)}
                    onFocus={() => selected !== sticker.id && select(sticker.id)}
                    onWheel={spin(sticker)}
                  >
                    {active && (
                      <>
                        {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                          <i
                            key={corner}
                            className={`sticker-handle size ${corner}`}
                            title={t('Cambiar el tamaño')}
                            onPointerDown={begin('size', sticker)}
                          />
                        ))}
                        <i className="sticker-handle turn" title={t('Girar (también con la rueda sobre la imagen)')} onPointerDown={begin('turn', sticker)}>
                          <RotateCw size={11} />
                        </i>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <div className={`page-mode cover-mode${leaving ? ' leaving' : ''}`}>
              <Move size={12} />
              {tight ? t('Acomodando') : t('Acomodando las imágenes')}
              {chosen && (
                <button
                  type="button"
                  className="cover-mode-remove"
                  onClick={() => removeSticker(chosen.id)}
                  aria-label={t('Quitar la imagen elegida')}
                  title={t('Quitar la imagen elegida de {face} (Supr)', { face: t(FACE_NAME[face]) })}
                >
                  <Trash2 size={12} />
                </button>
              )}
              <button type="button" onClick={finish} title={t('Terminar de acomodar (Enter o Esc)')}>
                {t('Listo')}{!tight && <kbd>Esc</kbd>}
              </button>
            </div>
          </>
        )}
      </Presence>

      <Presence show={notice !== null}>
        {(leaving) => (
          <div className={`toast${leaving ? ' leaving' : ''}`} role="status">
            {shownNotice.current}
          </div>
        )}
      </Presence>
    </div>
  );
}
