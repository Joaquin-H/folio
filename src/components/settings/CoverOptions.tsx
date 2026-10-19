import { useState } from 'react';
import { X } from 'lucide-react';
import { plural } from '../../format';
import { mark, useT } from '../../i18n';
import type { CoverStyle, Prefs } from '../../types';
import { clearStickers, removeSticker, stickersOn, useStickerImage, useStickers, type Face, type Sticker } from '../stickers';
import { Confirm, MOD, Presence } from '../ui';
import { Row } from './shared';
import '../../styles/cover.css';

/** Estilos de tapa, en el orden en que se ofrecen. */
const STYLES: { value: CoverStyle; name: string; detail: string }[] = [
  { value: 'plain', name: mark('Lisa'), detail: mark('Lisa: solo el color.') },
  { value: 'spots', name: mark('Manchas'), detail: mark('Con manchas y cinta en el lomo, como un cuaderno de composición.') },
  { value: 'strap', name: mark('Con tira'), detail: mark('Con tira elástica, como una agenda.') },
  { value: 'spine', name: mark('Con lomo'), detail: mark('Con lomo de tela.') },
  { value: 'leather', name: mark('Cuero'), detail: mark('De cuero, cosida por el borde.') },
];

const FACES: { face: Face; title: string }[] = [
  { face: 'front', title: mark('Tapa') },
  { face: 'back', title: mark('Contratapa') },
];

/** Dónde está pegada una imagen, para completar una frase. */
const WHERE: Record<Face, string> = { front: mark('la tapa'), back: mark('la contratapa') };

/** Cuánto tarda en irse la pregunta de «Quitar todas»: recién después se quitan. */
const CONFIRM_OUT = 170;

function Chip(props: { sticker: Sticker }) {
  const t = useT();
  const url = useStickerImage(props.sticker.id);
  const where = t(WHERE[props.sticker.face]);
  return (
    <li className="sticker-chip">
      {url && <img src={url} alt="" draggable={false} />}
      <button type="button" onClick={() => removeSticker(props.sticker.id)} aria-label={t('Quitar esta imagen de {where}', { where })} title={t('Quitar de {where}', { where })}>
        <X size={11} />
      </button>
    </li>
  );
}

/**
 * Lo que personaliza la tapa además del color: su estilo, con una miniatura de cada uno en
 * el color elegido, y las imágenes pegadas en la tapa y en la contratapa.
 */
export function CoverOptions(props: { prefs: Prefs; onPrefs: (patch: Partial<Prefs>) => void }) {
  const t = useT();
  const { prefs, onPrefs } = props;
  const stickers = useStickers();
  const [asking, setAsking] = useState(false);
  const front = stickersOn(stickers, 'front').length;
  const back = stickersOn(stickers, 'back').length;
  const counted = [
    front > 0 && t('{images} en la tapa', { images: plural(front, 'imagen', 'imágenes') }),
    back > 0 && t('{n} en la contratapa', { n: back }),
  ].filter((part): part is string => part !== false);
  const countedText = counted.length === 2 ? t('{a} y {b}', { a: counted[0], b: counted[1] }) : (counted[0] ?? '');
  const styleDetail = STYLES.find((style) => style.value === prefs.coverStyle)?.detail;

  return (
    <>
      <Row label={t('Estilo de la tapa')} detail={styleDetail ? t(styleDetail) : undefined}>
        <div className="cover-styles" role="radiogroup" aria-label={t('Estilo de la tapa')}>
          {STYLES.map((style) => (
            <button
              key={style.value}
              type="button"
              role="radio"
              aria-checked={prefs.coverStyle === style.value}
              aria-label={t(style.name)}
              title={t(style.name)}
              className="cover-thumb"
              data-cover-style={style.value}
              onClick={() => onPrefs({ coverStyle: style.value })}
            >
              <i className="cover-skin" />
              <i className="cover-thumb-label" />
              <i className="cover-over" />
            </button>
          ))}
        </div>
      </Row>
      <Row
        label={t('Imágenes de la tapa')}
        detail={
          counted.length > 0
            ? t('{list}. Se acomodan desde el menú de la tapa.', { list: countedText })
            : t('Con el cuaderno cerrado, elegí «Pegar una imagen…» en el menú de la tapa o usá {key} + V. Para la contratapa, dalo vuelta antes.', {
                key: MOD,
              })
        }
      >
        {stickers.length > 0 && (
          <button type="button" className="button small" onClick={() => setAsking(true)}>
            {t('Quitar todas')}
          </button>
        )}
      </Row>
      {stickers.length > 0 && (
        <div className="row sticker-row">
          {FACES.map(({ face, title }) => {
            const mine = stickersOn(stickers, face);
            return (
              mine.length > 0 && (
                <div key={face} className="sticker-face">
                  <span>{t(title)}</span>
                  <ul className="sticker-chips" aria-label={t('Imágenes de {where}', { where: t(WHERE[face]) })}>
                    {mine.map((sticker) => (
                      <Chip key={sticker.id} sticker={sticker} />
                    ))}
                  </ul>
                </div>
              )
            );
          })}
        </div>
      )}
      <Presence show={asking} exitMs={CONFIRM_OUT}>
        {(leaving) => (
          <Confirm
            title={t('¿Quitar todas las imágenes?')}
            detail={t('Se despegan las de la tapa y las de la contratapa. No se pueden recuperar: habría que pegarlas de nuevo.')}
            confirm={t('Quitar todas')}
            danger
            leaving={leaving}
            onCancel={() => setAsking(false)}
            onConfirm={() => {
              setAsking(false);
              // Se quitan cuando la pregunta terminó de irse, así no desaparecen de golpe con ella.
              window.setTimeout(clearStickers, CONFIRM_OUT);
            }}
          />
        )}
      </Presence>
    </>
  );
}
