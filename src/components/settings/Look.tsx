import { api } from '../../api';
import { mark, useT } from '../../i18n';
import { playSound } from '../../sounds';
import type { BookSize, Prefs, Settings, TextSize, Theme } from '../../types';
import { ColorPicker } from '../ColorPicker';
import { Segmented, Switch } from '../ui';
import { CoverOptions } from './CoverOptions';
import { Language } from './Language';
import { Group, Row, type Act } from './shared';

/** Colores de tapa; `null` es el de fábrica, que acompaña al tema claro u oscuro. */
const COVERS: { name: string; color: string | null; swatch: string }[] = [
  { name: mark('Grafito'), color: null, swatch: '#2B2C31' },
  { name: mark('Verde botella'), color: '#1F4D3A', swatch: '#1F4D3A' },
  { name: mark('Azul marino'), color: '#1E3558', swatch: '#1E3558' },
  { name: mark('Bordó'), color: '#6E2433', swatch: '#6E2433' },
  { name: mark('Mostaza'), color: '#C28F2C', swatch: '#C28F2C' },
  { name: mark('Kraft'), color: '#B59A76', swatch: '#B59A76' },
  { name: mark('Negro'), color: '#141416', swatch: '#141416' },
];

/** Personalización: tema, cuaderno, sonidos e inicio con el sistema. Los atajos tienen su propia pestaña. */
export function Look(props: {
  settings: Settings;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  act: Act;
  onTour?: () => void;
}) {
  const { settings, prefs, onPrefs, act } = props;
  const t = useT();
  const coverObj = COVERS.find((c) => c.color === prefs.cover);
  const coverDetail = coverObj ? t(coverObj.name) : t('Personalizado');

  return (
    <>
      <Group title={t('Apariencia')}>
        <Language prefs={prefs} onPrefs={onPrefs} />
        <Row label={t('Tema')} detail={t('Automático sigue al sistema: claro de día, oscuro de noche.')}>
          <Segmented<Theme>
            label={t('Tema')}
            value={prefs.theme}
            onChange={(theme) => onPrefs({ theme })}
            options={[
              { value: 'auto', label: t('Automático') },
              { value: 'light', label: t('Claro') },
              { value: 'dark', label: t('Oscuro') },
            ]}
          />
        </Row>
        <Row label={t('Tamaño de la letra')} detail={t('De las hojas del cuaderno; los renglones acompañan.')}>
          <Segmented<TextSize>
            label={t('Tamaño de la letra')}
            value={prefs.textSize}
            onChange={(textSize) => onPrefs({ textSize })}
            options={[
              { value: 'small', label: t('Chica') },
              { value: 'medium', label: t('Mediana') },
              { value: 'large', label: t('Grande') },
              { value: 'xlarge', label: t('Muy grande') },
            ]}
          />
        </Row>
      </Group>

      <Group title={t('Cuaderno')}>
        <Row label={t('Nombre')} detail={t('Aparece en la etiqueta de la tapa.')}>
          <input
            className="name-input"
            value={prefs.name}
            maxLength={40}
            placeholder={t('Mi cuaderno')}
            aria-label={t('Nombre del cuaderno')}
            onChange={(event) => onPrefs({ name: event.target.value })}
          />
        </Row>
        <Row
          label={t('Tamaño')}
          detail={t('Para darle cualquier tamaño a medida, mantené Mayús, arrastrá un borde o una esquina del cuaderno y soltá Mayús.')}
        >
          <Segmented<BookSize>
            label={t('Tamaño del cuaderno')}
            value={prefs.size}
            onChange={(size) => onPrefs({ size })}
            options={[
              { value: 'pocket', label: t('De bolsillo') },
              { value: 'standard', label: t('Estándar') },
              { value: 'full', label: t('Pantalla completa') },
              { value: 'custom', label: t('A medida'), title: t('Mantener Mayús y arrastrar un borde del cuaderno') },
            ]}
          />
        </Row>
        <Row label={t('Doble hoja')} detail={t('Una nota larga sigue en la hoja de al lado. Si la apagás, se ve de a una hoja, con espiral.')}>
          <Switch
            label={t('Doble hoja')}
            checked={prefs.spread === 'double'}
            onChange={(value) => onPrefs({ spread: value ? 'double' : 'single' })}
          />
        </Row>
        <Row
          label={t('Solapas de categorías')}
          detail={t('Asoman arriba del cuaderno y filtran las hojas. Si las ocultás, se filtra desde Buscar y filtrar.')}
        >
          <Switch label={t('Solapas de categorías')} checked={prefs.tabs} onChange={(tabs) => onPrefs({ tabs })} />
        </Row>
        <Row
          label={t('Ver los .md con formato')}
          detail={t('Títulos, listas, tareas y tablas, sobre el rayado. Al escribir se ve el texto plano, que es lo que se guarda.')}
        >
          <Switch label={t('Ver los .md con formato')} checked={prefs.markdown} onChange={(markdown) => onPrefs({ markdown })} />
        </Row>
      </Group>

      <Group title={t('Tapa')}>
        <Row label={t('Color de la tapa')} detail={coverDetail}>
          <div className="swatches" role="radiogroup" aria-label={t('Color de la tapa')}>
            {COVERS.map((cover) => (
              <button
                key={cover.name}
                type="button"
                role="radio"
                aria-checked={prefs.cover === cover.color}
                aria-label={t(cover.name)}
                title={t(cover.name)}
                className={`swatch-button${cover.color === null ? ' factory' : ''}`}
                style={cover.color === null ? undefined : { background: cover.swatch }}
                onClick={() => onPrefs({ cover: cover.color })}
              />
            ))}
            <ColorPicker
              value={prefs.cover}
              active={prefs.cover !== null && !COVERS.some((c) => c.color === prefs.cover)}
              onChange={(cover) => onPrefs({ cover })}
            />
          </div>
        </Row>
        <CoverOptions prefs={prefs} onPrefs={onPrefs} />
      </Group>

      <Group title={t('General')}>
        <Row label={t('Abrir Folio al iniciar la PC')} detail={t('Arranca en la bandeja, junto al reloj, sin abrir la ventana.')}>
          <Switch
            label={t('Abrir Folio al iniciar la PC')}
            checked={settings.autostart}
            onChange={(autostart) => act(api.updateSettings({ autostart }))}
          />
        </Row>
        <Row label={t('Sonidos')} detail={t('Al pasar de hoja, escribir y borrar.')}>
          <button type="button" className="button small" disabled={!prefs.sounds} onClick={() => playSound('turn-next')}>
            {t('Probar')}
          </button>
          <Switch label={t('Sonidos')} checked={prefs.sounds} onChange={(sounds) => onPrefs({ sounds })} />
        </Row>
        {props.onTour && (
          <Row
            label={t('Recorrido inicial')}
            detail={t('Una vuelta corta por lo que hace cada cosa: pasar de hoja, escribir, buscar, las solapas y los atajos.')}
          >
            <button type="button" className="button" onClick={props.onTour}>
              {t('Ver el recorrido')}
            </button>
          </Row>
        )}
      </Group>
    </>
  );
}
