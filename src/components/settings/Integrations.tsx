import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { api } from '../../api';
import { useT } from '../../i18n';
import type { Integration, IntegrationTool } from '../../types';
import { Confirm, Presence } from '../ui';
import { Group, Row } from './shared';

/** Lo que se está por hacer en un archivo que ya existe: se pregunta antes. */
interface Ask {
  item: Integration;
  action: 'install' | 'remove';
}

/** Cuánto queda escrito «Copiadas» en el botón. */
const COPIED_MS = 1600;

/** Copia texto al portapapeles; si el navegador no deja, con el método de siempre. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

function statusOf(item: Integration, t: (key: string) => string): string {
  if (!item.installed) return t('No instalada');
  return item.current ? t('Instalada') : t('Instalada, de una versión anterior de Folio');
}

/** Qué se va a tocar, dicho en la pregunta. */
function askDetail(ask: Ask, t: (key: string) => string) {
  const { item, action } = ask;
  const where = <span className="mono">{item.path}</span>;
  if (item.tool === 'claude') {
    return action === 'install' ? (
      <>
        {t('Folio reemplaza su skill en')} {where}. {t('Las otras skills de esa carpeta no se tocan.')}
      </>
    ) : (
      <>
        {t('Folio borra su skill:')} {where}. {t('Las otras skills de esa carpeta no se tocan.')}
      </>
    );
  }
  return action === 'install' ? (
    <>
      {t('Folio agrega sus instrucciones al final de')} {where}
      {t(', entre dos marcadores (o reemplaza las que ya había puesto). Lo que ya tenías en ese archivo no se toca.')}
    </>
  ) : (
    <>
      {t('Folio saca su bloque de instrucciones de')} {where}. {t('Lo demás del archivo queda como está.')}
    </>
  );
}

/**
 * Integraciones con asistentes de IA: Book les deja instrucciones para que, cuando se lo
 * pidas, te anoten cosas en la carpeta de Book con un formato cómodo de leer en el cuaderno.
 */
export function Integrations(props: { notesDir: string | undefined; revision: number }) {
  const t = useT();
  const [items, setItems] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const asked = useRef<Ask | null>(null);
  if (ask) asked.current = ask;
  const [copied, setCopied] = useState<IntegrationTool | null>(null);
  const [busy, setBusy] = useState<IntegrationTool | null>(null);

  const reload = useCallback(
    () =>
      api
        .integrations()
        .then(setItems)
        .catch((reason) => setError(String(reason))),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload, props.revision]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const run = (item: Integration, action: 'install' | 'remove') => {
    setError(null);
    setBusy(item.tool);
    (action === 'install' ? api.installIntegration(item.tool) : api.removeIntegration(item.tool))
      .then(reload)
      .catch((reason) => setError(String(reason)))
      .finally(() => setBusy(null));
  };

  // Antes de tocar un archivo que ya existe se pregunta, diciendo cuál.
  const request = (item: Integration, action: 'install' | 'remove') => (item.exists ? setAsk({ item, action }) : run(item, action));

  const copy = (item: Integration) => {
    setError(null);
    api
      .integrationText(item.tool)
      .then(copyText)
      .then(() => setCopied(item.tool))
      .catch((reason) => setError(t('No se pudieron copiar las instrucciones: {reason}', { reason: String(reason) })));
  };

  return (
    <>
      <Group
        title={t('Asistentes de IA')}
        footer={t('Instalar deja las instrucciones en la configuración de cada herramienta, en esta PC. Nada se manda a ningún lado.')}
      >
        <p className="settings-note">
          {t('Claude Code, Codex y Gemini CLI pueden anotarte cosas en Folio cuando se lo pidas («anotá esto», «guardalo en Folio»). Las instrucciones les explican dónde guardar las notas y con qué formato, para que en el cuaderno se lean con título, categoría y etiquetas.')}
        </p>
        <Row label={t('Carpeta de notas')} detail={props.notesDir ?? '…'} />
      </Group>

      {error && <p className="form-error">{error}</p>}

      <Group title={t('Herramientas')} footer={t('«Copiar instrucciones» sirve para pegarlas a mano en otro lugar, o en otra herramienta.')}>
        {(items ?? []).map((item) => (
          <Row
            key={item.tool}
            label={item.name}
            detail={
              <>
                <span className={`integration-status${item.installed ? ' on' : ''}`}>{statusOf(item, t)}</span>
                <span className="integration-path mono">{item.path}</span>
                {item.note && <span className="integration-note">{item.note}</span>}
              </>
            }
          >
            <button type="button" className="button small quiet" onClick={() => copy(item)} title={t('Copiar las instrucciones al portapapeles')}>
              {copied === item.tool ? <Check size={13} /> : <Copy size={13} />}
              {copied === item.tool ? t('Copiadas') : t('Copiar instrucciones')}
            </button>
            {item.installed && (
              <button type="button" className="button small" disabled={busy !== null} onClick={() => request(item, 'remove')}>
                {t('Quitar')}
              </button>
            )}
            {(!item.installed || !item.current) && (
              <button type="button" className="button small primary" disabled={busy !== null} onClick={() => request(item, 'install')}>
                {item.installed ? t('Actualizar') : t('Instalar')}
              </button>
            )}
          </Row>
        ))}
      </Group>

      <Presence show={ask !== null}>
        {(leaving) => {
          const shown = asked.current;
          if (!shown) return null;
          const installing = shown.action === 'install';
          return (
            <Confirm
              title={installing ? t('¿Instalar en {name}?', { name: shown.item.name }) : t('¿Quitar lo de Folio de {name}?', { name: shown.item.name })}
              detail={askDetail(shown, t)}
              confirm={installing ? (shown.item.installed ? t('Actualizar') : t('Instalar')) : t('Quitar')}
              danger={!installing}
              leaving={leaving}
              onCancel={() => setAsk(null)}
              onConfirm={() => {
                setAsk(null);
                run(shown.item, shown.action);
              }}
            />
          );
        }}
      </Presence>
    </>
  );
}
