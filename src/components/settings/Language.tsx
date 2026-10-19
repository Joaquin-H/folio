import { useT } from '../../i18n';
import type { Lang, Prefs } from '../../types';
import { Segmented } from '../ui';
import { Row } from './shared';

/**
 * Idioma de la interfaz. Cada idioma se escribe en sí mismo, para que se encuentre aunque
 * la interfaz esté en uno que no se lee; «Automático» sigue al del sistema.
 */
export function Language(props: { prefs: Prefs; onPrefs: (patch: Partial<Prefs>) => void }) {
  const t = useT();
  return (
    <Row label={t('Idioma')} detail={t('Automático sigue al idioma del sistema: español, o inglés si es otro.')}>
      <Segmented<Lang>
        label={t('Idioma')}
        value={props.prefs.lang}
        onChange={(lang) => props.onPrefs({ lang })}
        options={[
          { value: 'auto', label: t('Automático') },
          { value: 'es', label: 'Español' },
          { value: 'en', label: 'English' },
        ]}
      />
    </Row>
  );
}
