import { useState } from 'react';
import { shortDateTime } from '../format';
import { useT } from '../i18n';
import type { SheetSummary } from '../types';
import { useSheetDetail } from './sheet';
import { Modal, Segmented } from './ui';

/** Versiones anteriores de una hoja: se elige una y se lee, sin tocar la actual. */
export function Versions(props: { sheet: SheetSummary; leaving?: boolean; onClose: () => void }) {
  const t = useT();
  const detail = useSheetDetail(props.sheet);
  /** -1 es la hoja actual; 0 en adelante, las versiones anteriores. */
  const [version, setVersion] = useState(0);
  const versions = detail?.versions ?? [];
  const shown = versions[version];

  return (
    <Modal title={t('Versiones de {title}', { title: props.sheet.title })} onClose={props.onClose} leaving={props.leaving} wide>
      <div className="versions">
        <Segmented
          label={t('Versión de la hoja')}
          value={shown ? version : -1}
          onChange={setVersion}
          options={[
            ...versions.map((v, index) => ({ value: index, label: shortDateTime(v.savedAt) })),
            { value: -1, label: t('Actual') },
          ]}
        />
        <pre className="versions-text">{detail ? (shown ? shown.content : detail.content) : ''}</pre>
      </div>
      <footer className="modal-footer">
        <span className="hint">{t('Folio guarda una versión por sesión de edición. Podés copiar el texto de cualquiera.')}</span>
        <button type="button" className="button primary" onClick={props.onClose}>
          {t('Listo')}
        </button>
      </footer>
    </Modal>
  );
}
