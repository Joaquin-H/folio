import { api } from '../../api';
import { useT } from '../../i18n';
import type { Settings } from '../../types';
import { Segmented, Stepper } from '../ui';
import { Group, Row, type Act } from './shared';

/** Cuántas versiones anteriores de cada hoja se conservan, y el tamaño máximo de archivo. */
export function Versions(props: { settings: Settings; act: Act }) {
  const t = useT();
  const { settings, act } = props;
  return (
    <>
      <Group footer={t('Cuando una hoja cambia, la anterior pasa al historial. Se guarda una versión por sesión de edición, no una por cada guardado.')}>
        <Row label={t('Versiones anteriores a conservar')} detail={t('Por cada hoja, además de la actual.')}>
          <Stepper
            label={t('Versiones anteriores a conservar')}
            value={settings.versionsKeep}
            min={0}
            max={10}
            onChange={(value) => act(api.updateSettings({ versionsKeep: value }))}
          />
        </Row>
        <Row label={t('Fin de la sesión de edición')} detail={t('Minutos sin cambios para dar una versión por terminada.')}>
          <Stepper
            label={t('Minutos sin cambios')}
            value={settings.sessionGapMin}
            min={1}
            max={60}
            onChange={(value) => act(api.updateSettings({ sessionGapMin: value }))}
          />
        </Row>
      </Group>
      <Group footer={t('Los archivos más grandes casi nunca son notas: suelen ser registros o exportaciones.')}>
        <Row label={t('Tamaño máximo de archivo')} detail={`${settings.maxFileKb} KB`}>
          <Segmented
            label={t('Tamaño máximo de archivo')}
            value={settings.maxFileKb}
            onChange={(value) => act(api.updateSettings({ maxFileKb: value }))}
            options={[
              { value: 256, label: '256 KB' },
              { value: 1024, label: '1 MB' },
              { value: 4096, label: '4 MB' },
            ]}
          />
        </Row>
      </Group>
    </>
  );
}
