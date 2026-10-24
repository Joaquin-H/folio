import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { usePrefs } from '../hooks';
import { mark, useT } from '../i18n';
import type { FolderStat, MissingSheet, Overview, Prefs, Settings } from '../types';
import { Modal } from './ui';
import { About } from './settings/About';
import { Bans } from './settings/Bans';
import { Categories } from './settings/Categories';
import { Data } from './settings/Data';
import { Folders } from './settings/Folders';
import { Integrations } from './settings/Integrations';
import { Jev } from './settings/Jev';
import { Look } from './settings/Look';
import { Shortcuts } from './settings/Shortcuts';
import { PANEL_ID, TabStrip, tabId, type Tab } from './settings/TabStrip';
import { Versions } from './settings/Versions';
import { requestTour } from './Tutorial';

/**
 * Ajustes: este archivo arma las pestañas y la ventana; el contenido de cada sección
 * vive en su propio archivo dentro de `settings/`.
 */

export type SettingsTab =
  | 'look'
  | 'shortcuts'
  | 'folders'
  | 'bans'
  | 'categories'
  | 'jev'
  | 'integrations'
  | 'versions'
  | 'data'
  | 'about';

// En el orden en que se recorre la app: cómo se ve y se maneja, de dónde salen las hojas,
// cómo se ordenan (las categorías y la IA que elige entre ellas), con qué se conecta y,
// al final, las redes de seguridad (versiones y datos).
const TABS: Tab<SettingsTab>[] = [
  { value: 'look', label: mark('Personalización') },
  { value: 'shortcuts', label: mark('Atajos') },
  { value: 'folders', label: mark('Carpetas') },
  { value: 'bans', label: mark('Exclusiones') },
  { value: 'categories', label: mark('Categorías') },
  { value: 'jev', label: mark('Clasificador') },
  { value: 'integrations', label: mark('Integraciones') },
  { value: 'versions', label: mark('Versiones') },
  { value: 'data', label: mark('Datos') },
  { value: 'about', label: mark('Acerca de') },
];

/** Contenido de Ajustes: las pestañas y la sección elegida. */
function SettingsPanel(props: {
  initialTab: SettingsTab;
  overview: Overview | null;
  revision: number;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  /** Vuelve al cuaderno y muestra el recorrido. */
  onTour: () => void;
}) {
  const { prefs, onPrefs } = props;
  const [tab, setTab] = useState<SettingsTab>(props.initialTab);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [folders, setFolders] = useState<FolderStat[]>([]);
  const [missing, setMissing] = useState<MissingSheet[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.getSettings().then(setSettings).catch((reason) => setError(String(reason)));
    api.folderStats().then(setFolders).catch(() => {});
    api.listMissing().then(setMissing).catch(() => {});
  }, []);
  useEffect(reload, [reload, props.revision]);

  const act = useCallback(
    (action: Promise<unknown>) => {
      setError(null);
      action.then(reload).catch((reason) => setError(String(reason)));
    },
    [reload],
  );

  const overview = props.overview;
  const t = useT();
  const options = useMemo(() => TABS.map((tabItem) => ({ ...tabItem, label: t(tabItem.label) })), [t]);

  return (
    <div className="settings-layout">
      <div className="settings-tabs">
        <TabStrip label={t('Sección de ajustes')} value={tab} options={options} onChange={setTab} />
      </div>
      <div className="settings-body" id={PANEL_ID} role="tabpanel" aria-labelledby={tabId(tab)}>
        {error && <p className="form-error">{error}</p>}
        {!settings ? null : tab === 'look' ? (
          <Look settings={settings} prefs={prefs} onPrefs={onPrefs} act={act} onTour={props.onTour} />
        ) : tab === 'shortcuts' ? (
          <Shortcuts settings={settings} act={act} />
        ) : tab === 'folders' ? (
          <Folders settings={settings} folders={folders} scan={overview?.scan} act={act} />
        ) : tab === 'bans' ? (
          <Bans settings={settings} act={act} />
        ) : tab === 'categories' ? (
          <Categories categories={overview?.categories ?? []} act={act} overview={overview} />
        ) : tab === 'versions' ? (
          <Versions settings={settings} act={act} />
        ) : tab === 'data' ? (
          <Data settings={settings} missing={missing} notesDir={overview?.notesDir} act={act} />
        ) : tab === 'integrations' ? (
          <Integrations notesDir={overview?.notesDir} revision={props.revision} />
        ) : tab === 'about' ? (
          <About settings={settings} onTour={props.onTour} />
        ) : (
          <Jev settings={settings} sheets={overview?.counts.all} act={act} />
        )}
      </div>
    </div>
  );
}

/** Ajustes dentro de un modal: tiene un botón arriba a la derecha para abrirlos en una ventana aparte si se prefiere. */
export function SettingsSheet(props: {
  initialTab: SettingsTab;
  overview: Overview | null;
  revision: number;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  leaving?: boolean;
  onClose: () => void;
  onTour: () => void;
}) {
  const t = useT();
  return (
    <Modal
      title={t('Ajustes')}
      onClose={props.onClose}
      onPopOut={() => {
        props.onClose();
        void api.openSettings().catch(() => {});
      }}
      leaving={props.leaving}
      wide
    >
      <SettingsPanel {...props} />
    </Modal>
  );
}

/**
 * Ajustes en su propia ventana. Las preferencias se guardan en el almacenamiento que
 * comparte con la ventana del cuaderno, que las aplica al instante.
 */
export function SettingsWindow() {
  const [prefs, setPrefs] = usePrefs();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api
        .getOverview()
        .then((next) => alive && setOverview(next))
        .catch(() => {});
    refresh();
    const stop = api.onChanged(() => {
      refresh();
      setRevision((value) => value + 1);
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  return (
    <div className="settings-window">
      <SettingsPanel
        initialTab="look"
        overview={overview}
        revision={revision}
        prefs={prefs}
        onPrefs={setPrefs}
        // El recorrido es del cuaderno, que es otra ventana: se le pide desde acá y esta se cierra para dejarlo ver.
        onTour={() => {
          requestTour();
          api.window.hide();
        }}
      />
    </div>
  );
}
