import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
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
import { Highlight } from './settings/Highlight';
import { Integrations } from './settings/Integrations';
import { Jev } from './settings/Jev';
import { Look } from './settings/Look';
import { normalize, searchSettings, type SearchResultSection } from './settings/searchIndex';
import { Group } from './settings/shared';
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

/** Contenido de Ajustes: buscador, pestañas y la sección elegida o resultados de búsqueda. */
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

  // Estado del buscador de ajustes
  const [query, setQuery] = useState('');
  const [activeFilterTab, setActiveFilterTab] = useState<SettingsTab | 'all'>('all');

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

  const isSearching = query.trim().length > 0;
  const searchResults = useMemo<SearchResultSection[]>(() => {
    if (!isSearching) return [];
    return searchSettings(query, t);
  }, [isSearching, query, t]);

  const totalMatches = useMemo(() => {
    return searchResults.reduce((acc, r) => acc + r.matches.length, 0);
  }, [searchResults]);

  type TabValue = SettingsTab | 'all';
  const searchTabOptions = useMemo<Tab<TabValue>[]>(() => {
    if (!isSearching) return [];
    if (searchResults.length <= 1) {
      return searchResults.map((r) => ({
        value: r.tab as TabValue,
        label: `${r.tabLabel} (${r.matches.length})`,
      }));
    }
    return [
      { value: 'all', label: `${t('Todas')} (${totalMatches})` },
      ...searchResults.map((r) => ({
        value: r.tab as TabValue,
        label: `${r.tabLabel} (${r.matches.length})`,
      })),
    ];
  }, [isSearching, searchResults, t, totalMatches]);

  const effectiveSearchTab: TabValue =
    searchResults.length === 1 ? searchResults[0].tab : activeFilterTab;

  const openSetting = useCallback((targetTab: SettingsTab) => {
    setTab(targetTab);
    setQuery('');
    setActiveFilterTab('all');
  }, []);

  // Limpiar la búsqueda con la tecla Escape globalmente mientras la búsqueda está activa
  useEffect(() => {
    if (!isSearching) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setQuery('');
        setActiveFilterTab('all');
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [isSearching]);

  return (
    <div className="settings-panel">
      <div className="settings-search-bar">
        <label className="search settings-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={t('Buscar en ajustes…')}
            aria-label={t('Buscar en ajustes')}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveFilterTab('all');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery('');
                setActiveFilterTab('all');
              }
            }}
          />
          {query.trim().length > 0 && (
            <button
              type="button"
              className="settings-search-clear"
              aria-label={t('Limpiar búsqueda')}
              title={t('Limpiar búsqueda (Esc)')}
              onClick={() => {
                setQuery('');
                setActiveFilterTab('all');
              }}
            >
              <X size={13} />
            </button>
          )}
        </label>
      </div>
      <div
        className="settings-layout"
        data-no-tabs={isSearching && searchResults.length === 0 ? 'true' : undefined}
      >
        {(!isSearching || searchResults.length > 0) && (
          <div className="settings-tabs">
            {isSearching ? (
              <TabStrip
                label={t('Secciones coincidentes')}
                value={effectiveSearchTab}
                options={searchTabOptions}
                onChange={setActiveFilterTab}
              />
            ) : (
              <TabStrip
                label={t('Sección de ajustes')}
                value={tab}
                options={options}
                onChange={setTab}
              />
            )}
          </div>
        )}
        <div
          className="settings-body"
          id={PANEL_ID}
          role="tabpanel"
          aria-labelledby={tabId(isSearching ? effectiveSearchTab : tab)}
        >
          {error && <p className="form-error">{error}</p>}
          {isSearching ? (
            searchResults.length === 0 ? (
              <div className="settings-no-results">
                <div className="settings-no-results-icon" aria-hidden="true">
                  <Search size={32} />
                </div>
                <h3>{t('Sin resultados')}</h3>
                <p>{t('No se encontraron ajustes para «{query}».', { query: query.trim() })}</p>
                <p className="settings-no-results-hint">
                  {t('Probá con otros términos como tema, marco, atajos, carpetas o sonido.')}
                </p>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setQuery('');
                    setActiveFilterTab('all');
                  }}
                >
                  {t('Limpiar búsqueda')}
                </button>
              </div>
            ) : (
              <div className="settings-search-results">
                {(effectiveSearchTab === 'all'
                  ? searchResults
                  : searchResults.filter((r) => r.tab === effectiveSearchTab)
                ).map((section) => (
                  <Group
                    key={section.tab}
                    title={section.tabLabel}
                    footer={
                      <button
                        type="button"
                        className="settings-open-full-section-btn"
                        onClick={() => openSetting(section.tab)}
                      >
                        {t('Abrir sección completa {name}', { name: section.tabLabel })} →
                      </button>
                    }
                  >
                    {section.matches.map(({ item, matchedKeyword }) => (
                      <div
                        key={item.id}
                        className="row settings-search-row"
                        role="button"
                        tabIndex={0}
                        onClick={() => openSetting(item.tab)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openSetting(item.tab);
                          }
                        }}
                      >
                        <div className="row-text">
                          <span className="settings-search-item-label">
                            <Highlight text={t(item.label)} query={query} />
                            {item.group && (
                              <span className="settings-search-item-group">
                                {' · '}
                                <Highlight text={t(item.group)} query={query} />
                              </span>
                            )}
                          </span>
                          {item.detail && (
                            <small>
                              <Highlight text={t(item.detail)} query={query} />
                            </small>
                          )}
                          {matchedKeyword &&
                            !normalize(t(item.label)).includes(normalize(matchedKeyword)) &&
                            (!item.detail || !normalize(t(item.detail)).includes(normalize(matchedKeyword))) && (
                              <span className="settings-search-keyword-badge">
                                {t('Palabra clave:')} <Highlight text={matchedKeyword} query={query} />
                              </span>
                            )}
                        </div>
                        <div className="row-control">
                          <button
                            type="button"
                            className="button small"
                            onClick={(e) => {
                              e.stopPropagation();
                              openSetting(item.tab);
                            }}
                            aria-label={t('Ir al ajuste {label}', { label: t(item.label) })}
                          >
                            {t('Abrir')} →
                          </button>
                        </div>
                      </div>
                    ))}
                  </Group>
                ))}
              </div>
            )
          ) : (
            <>
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
            </>
          )}
        </div>
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
