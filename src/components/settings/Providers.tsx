import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../../api';
import { formatNumber, mark, quote, t, useT } from '../../i18n';
import type { ClassifierTest, JevStatus, ProviderId, ProviderStatus } from '../../types';
import { Group, Row, type Act } from './shared';
import '../../styles/classifier.css';

/**
 * Las IAs que pueden clasificar las hojas: cuál elegir (con a dónde viaja el texto, que es
 * lo que hay que saber antes de elegir) y, de la elegida, su clave, su modelo, su dirección
 * y el botón de probarla. Lo que se consulta y cuándo es igual para todas (Jev.tsx).
 */

interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Quién la hace. */
  maker: string;
  /** Adónde viaja el texto de cada hoja. En Ollama es la dirección que se elija. */
  host: string;
  needsKey: boolean;
  /** La variable de entorno que puede dar la clave (a falta del llavero). */
  envVar?: string;
  /** Para elegir el modelo: el de fábrica (vacío si no hay), uno de ejemplo y qué escribir. */
  model?: { factory: string; example: string; hint: string };
}

const INFO: Record<ProviderId, ProviderInfo> = {
  jev: { id: 'jev', label: 'Jev', maker: 'TypeSafe', host: 'api.typesafe.ai', needsKey: true, envVar: 'TYPESAFE_API_KEY' },
  claude: {
    id: 'claude',
    label: 'Claude',
    maker: 'Anthropic',
    host: 'api.anthropic.com',
    needsKey: true,
    envVar: 'ANTHROPIC_API_KEY',
    model: {
      factory: 'claude-haiku-5-5',
      example: 'claude-haiku-5-5',
      hint: mark('Por defecto claude-haiku-5-5, el rápido y barato. Para uno más fino escribí su nombre, por ejemplo claude-sonnet-5-5.'),
    },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    maker: 'OpenAI',
    host: 'api.openai.com',
    needsKey: true,
    envVar: 'OPENAI_API_KEY',
    model: {
      factory: 'gpt-6-luna',
      example: 'gpt-6-luna',
      hint: mark('Por defecto gpt-6-luna, el más económico. Podés escribir el nombre de otro modelo de OpenAI.'),
    },
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    maker: 'Google',
    host: 'generativelanguage.googleapis.com',
    needsKey: true,
    envVar: 'GEMINI_API_KEY',
    model: {
      factory: 'gemini-3.5-flash-lite',
      example: 'gemini-3.5-flash-lite',
      hint: mark('Por defecto gemini-3.5-flash-lite, el más rápido y barato. Podés escribir el nombre de otro modelo de Gemini.'),
    },
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    maker: 'local',
    host: 'localhost:11434',
    needsKey: false,
    model: {
      factory: '',
      example: 'llama3.2',
      hint: mark('El modelo que tengas instalado en Ollama, tal cual figura en «ollama list». Por ejemplo llama3.2.'),
    },
  },
};

const ORDER: ProviderId[] = ['jev', 'claude', 'openai', 'gemini', 'ollama'];

export const providerLabel = (id: ProviderId) => INFO[id].label;

/** Si el servicio corre en esta misma PC (la dirección es la de este equipo). */
function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Adónde viaja el texto de cada hoja con esa IA, en una línea. */
function destination(info: ProviderInfo, ollamaUrl: string): string {
  if (info.id !== 'ollama') return t('El texto de cada hoja se envía a {host}.', { host: info.host });
  return isLocal(ollamaUrl)
    ? t('No sale nada de esta PC.')
    : t('Un Ollama de otra máquina: el texto de cada hoja se envía a {host}.', { host: hostOf(ollamaUrl) });
}

/** Lo que hay que saber de privacidad con esa IA activa: el destino real del texto. */
function privacy(info: ProviderInfo, ollamaUrl: string): string {
  const never = t('Las hojas del secret-book y las descartadas nunca se envían.');
  if (info.id === 'ollama') {
    const host = hostOf(ollamaUrl);
    return isLocal(ollamaUrl)
      ? t('Con Ollama activo, el texto de cada hoja lo lee un modelo que corre en esta PC ({host}): no sale a Internet. {never}', { host, never })
      : t('Con Ollama activo, el texto de cada hoja se envía a {host}, que no es esta PC. {never}', { host, never });
  }
  const sent = t('Con {provider} activo, el texto de cada hoja se envía a {host} ({maker}) para elegir su categoría. {never}', {
    provider: info.label,
    host: info.host,
    maker: info.maker,
    never,
  });
  const free = t('Con una clave gratuita de Gemini, Google puede usar lo que le enviás para mejorar sus productos; con una cuenta de pago, no.');
  return info.id === 'gemini' ? `${sent} ${free}` : sent;
}

const stateOf = (status: JevStatus, id: ProviderId): ProviderStatus =>
  status.providers.find((candidate) => candidate.id === id) ?? { id, hasKey: false, keyFromEnv: false, model: '' };

/** Con lo que tiene, se puede consultar a esa IA: clave, o modelo en Ollama. */
const isReady = (info: ProviderInfo, state: ProviderStatus) => (info.needsKey ? state.hasKey : state.model.trim() !== '');

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** Elegir la IA. Cada una dice adónde viaja el texto; la elegida, además, cómo está. */
export function ProviderPicker(props: { status: JevStatus; act: Act }) {
  const t = useT();
  const { status, act } = props;
  const buttons = useRef<Partial<Record<ProviderId, HTMLButtonElement | null>>>({});
  const active = INFO[status.provider];

  // Como en cualquier grupo de opciones: las flechas pasan de una a otra.
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = ORDER[(index + step + ORDER.length) % ORDER.length];
    buttons.current[next]?.focus();
    act(api.setAiProvider(next));
  };

  return (
    <Group
      title={t('IA que clasifica')}
      footer={
        <span key={`${active.id}${isLocal(status.ollamaUrl)}`} className="swap-in">
          {privacy(active, status.ollamaUrl)}
        </span>
      }
    >
      <div role="radiogroup" aria-label={t('IA que clasifica las hojas')}>
        {ORDER.map((id, index) => {
          const info = INFO[id];
          const state = stateOf(status, id);
          const selected = id === status.provider;
          const ready = isReady(info, state);
          return (
            <button
              key={id}
              ref={(node) => {
                buttons.current[id] = node;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              className="row provider-option"
              onClick={() => !selected && act(api.setAiProvider(id))}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <span className="radio-dot" aria-hidden="true" />
              <span className="provider-text">
                <span className="provider-name">
                  {info.label}
                  <small className="provider-maker">{id === 'ollama' ? (isLocal(status.ollamaUrl) ? 'local' : t('en la red')) : info.maker}</small>
                </span>
                <small>{destination(info, status.ollamaUrl)}</small>
              </span>
              <span className={`provider-state${ready ? ' ready' : ''}`}>
                {ready ? (info.needsKey ? t('Con clave') : t('Lista')) : info.needsKey ? t('Sin clave') : t('Sin modelo')}
              </span>
            </button>
          );
        })}
      </div>
    </Group>
  );
}

function KeyRow(props: { info: ProviderInfo; state: ProviderStatus; act: Act }) {
  const t = useT();
  const { info, state, act } = props;
  const [apiKey, setApiKey] = useState('');
  return (
    <Row
      label={t('Clave de API')}
      detail={
        state.keyFromEnv
          ? t('Tomada de la variable de entorno {envVar}.', { envVar: info.envVar ?? '' })
          : state.hasKey
            ? t('Guardada en el llavero del sistema.')
            : t('Se guarda en el llavero del sistema, no en la base de Folio. También puede venir de la variable de entorno {envVar}.', {
                envVar: info.envVar ?? '',
              })
      }
    >
      {state.hasKey && !state.keyFromEnv ? (
        <button type="button" className="button" onClick={() => act(api.clearProviderKey(info.id))}>
          {t('Quitar clave')}
        </button>
      ) : state.keyFromEnv ? null : (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            act(api.setProviderKey(info.id, apiKey));
            setApiKey('');
          }}
        >
          <input
            type="password"
            value={apiKey}
            aria-label={t('Clave de API de {provider}', { provider: info.label })}
            placeholder={t('Pegá tu clave')}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
          />
          <button type="submit" className="button primary" disabled={!apiKey.trim()}>
            {t('Guardar')}
          </button>
        </form>
      )}
    </Row>
  );
}

/** Un campo de texto que se guarda aparte (con Guardar o Enter), para el modelo y la dirección. */
function TextRow(props: {
  label: string;
  detail: string;
  value: string;
  placeholder: string;
  ariaLabel: string;
  /** Si se puede volver al valor de fábrica, cuál es (para ofrecerlo cuando se cambió). */
  factory?: string;
  onSave: (value: string) => void;
}) {
  const t = useT();
  const { value } = props;
  const [draft, setDraft] = useState(value);
  // Si el valor guardado cambia por otro lado (o el backend lo acomoda), el campo lo sigue.
  useEffect(() => setDraft(value), [value]);
  const changed = draft.trim() !== value;
  return (
    <Row label={props.label} detail={props.detail}>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) props.onSave(draft.trim());
        }}
      >
        <input
          className="provider-input"
          value={draft}
          aria-label={props.ariaLabel}
          placeholder={props.placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className={`button${changed ? ' primary' : ''}`} disabled={!changed}>
          {t('Guardar')}
        </button>
        {props.factory !== undefined && props.factory !== value && !changed && (
          <button type="button" className="button quiet" onClick={() => props.onSave('')}>
            {t('De fábrica')}
          </button>
        )}
      </form>
    </Row>
  );
}

type Trial = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; result: ClassifierTest } | { kind: 'failed'; message: string };

const seconds = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;

/** «Probar»: clasifica una hoja de ejemplo y muestra qué eligió la IA, o por qué no pudo. */
function TestRow(props: { info: ProviderInfo; state: ProviderStatus; status: JevStatus; threshold: number }) {
  const t = useT();
  const { info, state, status, threshold } = props;
  const [trial, setTrial] = useState<Trial>({ kind: 'idle' });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Un resultado de otro modelo, otra dirección o otra clave ya no cuenta.
  useEffect(() => setTrial({ kind: 'idle' }), [state.model, state.hasKey, status.ollamaUrl]);

  const ready = isReady(info, state);
  const run = () => {
    setTrial({ kind: 'running' });
    api
      .testClassifier()
      .then((result) => alive.current && setTrial({ kind: 'done', result }))
      .catch((reason) => alive.current && setTrial({ kind: 'failed', message: messageOf(reason) }));
  };

  return (
    <>
      <Row
        label={t('Probar')}
        detail={
          ready
            ? t('Clasifica una hoja de ejemplo con tus categorías de ahora y muestra qué elige. Cuenta como una consulta.')
            : info.needsKey
              ? t('Primero guardá la clave de {provider}.', { provider: info.label })
              : t('Primero escribí el modelo que tenés instalado.')
        }
      >
        <button type="button" className="button" disabled={!ready || trial.kind === 'running'} onClick={run}>
          {trial.kind === 'running' ? t('Probando…') : t('Probar')}
        </button>
      </Row>
      {trial.kind !== 'idle' && (
        <div className="test-panel">
          <div className="test-panel-inner">
            <div className={`test-result ${trial.kind}`} role="status">
              {trial.kind === 'running' ? (
                <>
                  <span className="test-working" aria-hidden="true" />
                  <div className="test-text">{t('Consultando a {provider}…', { provider: info.label })}</div>
                </>
              ) : trial.kind === 'done' ? (
                <>
                  <span className="test-mark" aria-hidden="true">
                    ✓
                  </span>
                  <div className="test-text">
                    <span>
                      <strong>
                        {trial.result.category
                          ? t('Eligió «{category}»', { category: trial.result.category })
                          : t('Eligió «otro» (ninguna categoría encajó)')}
                      </strong>{' '}
                      {t('con {pct}% de confianza · {time}', { pct: Math.round(trial.result.confidence * 100), time: seconds(trial.result.tookMs) })}
                    </span>
                    <small>
                      {trial.result.confidence < threshold &&
                        `${t('Es menos que tu confianza mínima ({pct}%): una hoja así quedaría en «Sin clasificar».', { pct: Math.round(threshold * 100) })} `}
                      {t('Hoja de ejemplo: {sample}', { sample: quote(trial.result.sample.replace(/\s+/g, ' ')) })}
                    </small>
                  </div>
                </>
              ) : (
                <>
                  <span className="test-mark" aria-hidden="true">
                    ✕
                  </span>
                  <div className="test-text">
                    <strong>{t('No se pudo probar {provider}.', { provider: info.label })}</strong>
                    <small>{trial.message}</small>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Lo de la IA elegida: su clave, su modelo, su dirección y la prueba. Se vuelve a armar al cambiar de IA. */
export function ProviderSetup(props: { status: JevStatus; threshold: number; act: Act }) {
  const t = useT();
  const { status, threshold, act } = props;
  const info = INFO[status.provider];
  const state = stateOf(status, info.id);
  const local = isLocal(status.ollamaUrl);
  return (
    <div className="provider-panel">
      <Group title={info.label}>
        {info.needsKey && <KeyRow info={info} state={state} act={act} />}
        {info.model && (
          <TextRow
            label={t('Modelo')}
            detail={t(info.model.hint)}
            value={state.model}
            placeholder={info.model.example}
            ariaLabel={t('Modelo de {provider}', { provider: info.label })}
            factory={info.model.factory || undefined}
            onSave={(model) => act(api.setAiModel(info.id, model))}
          />
        )}
        {info.id === 'ollama' && (
          <TextRow
            label={t('Dirección')}
            detail={
              local
                ? t('Dónde escucha Ollama. Por defecto, en esta misma PC.')
                : t('Es otra máquina: el texto de las hojas viaja hasta ella por la red.')
            }
            value={status.ollamaUrl}
            placeholder="http://localhost:11434"
            ariaLabel={t('Dirección de Ollama')}
            onSave={(url) => act(api.setOllamaUrl(url))}
          />
        )}
        <TestRow info={info} state={state} status={status} threshold={threshold} />
      </Group>
    </div>
  );
}
