import { useEffect, useState } from 'react';
import { api } from '../../api';
import { count, plural } from '../../format';
import { t, tn, useT } from '../../i18n';
import type { ProviderId, Settings } from '../../types';
import { Segmented, Switch } from '../ui';
import { ProviderPicker, ProviderSetup, providerLabel } from './Providers';
import { Group, Row, type Act } from './shared';

/** Cada cuántos días se revisan las hojas ya clasificadas que cambiaron; 0 es nunca. */
const RECHECK_DAYS = [0, 7, 30];
const recheckLabel = (days: number) => (days === 0 ? t('Nunca') : tn(days, 'Cada {n} día', 'Cada {n} días'));

/** Qué pasa con las hojas pendientes: lo que falta para consultar, o que se procesan solas. */
function pendingDetail(provider: ProviderId, ready: boolean, enabled: boolean): string {
  if (!ready) return provider === 'ollama' ? t('Falta el modelo de Ollama.') : t('Falta la clave de {provider}.', { provider: providerLabel(provider) });
  return enabled ? t('Se procesan en segundo plano.') : t('La clasificación automática está desactivada.');
}

/** Volver a clasificar todo cuesta una consulta por hoja: se pide confirmar en un segundo paso. */
function ReclassifyAll(props: { disabled: boolean; sheets: number | undefined; provider: string; act: Act }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);

  // Si no se confirma, el pedido se retira solo.
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 6000);
    return () => clearTimeout(timer);
  }, [confirming]);
  useEffect(() => {
    if (props.disabled) setConfirming(false);
  }, [props.disabled]);

  return (
    <Row
      label={t('Volver a clasificar todo')}
      detail={
        confirming
          ? props.sheets
            ? t('Es una consulta a {provider} por cada hoja (hasta {sheets}). No se tocan las categorías que pusiste a mano.', {
                provider: props.provider,
                sheets: plural(props.sheets, 'hoja', 'hojas'),
              })
            : t('Es una consulta a {provider} por cada hoja. No se tocan las categorías que pusiste a mano.', { provider: props.provider })
          : t('Consulta de nuevo a {provider} por todas las hojas, salvo las que pusiste en una categoría a mano. Cuesta una consulta por hoja.', {
              provider: props.provider,
            })
      }
    >
      {confirming ? (
        <>
          <button type="button" className="button quiet" onClick={() => setConfirming(false)}>
            {t('Cancelar')}
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              setConfirming(false);
              props.act(api.reclassifyAll());
            }}
          >
            {t('Sí, consultar todo')}
          </button>
        </>
      ) : (
        <button type="button" className="button" disabled={props.disabled} onClick={() => setConfirming(true)}>
          {t('Volver a clasificar')}
        </button>
      )}
    </Row>
  );
}

/**
 * El clasificador: con qué IA (Jev, Claude, OpenAI, Gemini u Ollama), su clave y su modelo, y la
 * clasificación automática: umbral, cuándo consulta, uso y hojas pendientes. (Se llama Jev por
 * historia; es la pestaña «Clasificador».)
 */
export function Jev(props: { settings: Settings; sheets: number | undefined; act: Act }) {
  const t = useT();
  const { settings, act } = props;
  const status = settings.jev;
  const provider = providerLabel(status.provider);
  const ready = status.enabled && status.ready;
  // Un valor guardado que no sea ninguno de los tres (por ejemplo editado a mano) igual se ve.
  const recheckOptions = (RECHECK_DAYS.includes(settings.jevRecheckDays) ? RECHECK_DAYS : [...RECHECK_DAYS, settings.jevRecheckDays]).map((value) => ({
    value,
    label: recheckLabel(value),
  }));

  return (
    <>
      <ProviderPicker status={status} act={act} />
      <ProviderSetup key={status.provider} status={status} threshold={settings.jevThreshold} act={act} />

      <Group title={t('Clasificación automática')}>
        <Row
          label={t('Clasificar automáticamente')}
          detail={
            status.ready
              ? t('Cada hoja nueva pasa por {provider} cuando deja de cambiar.', { provider })
              : status.provider === 'ollama'
                ? t('Primero escribí el modelo de Ollama.')
                : t('Primero guardá la clave de {provider}.', { provider })
          }
        >
          <Switch
            label={t('Clasificar automáticamente')}
            checked={status.enabled}
            disabled={!status.ready}
            onChange={(value) => act(api.updateSettings({ jevEnabled: value }))}
          />
        </Row>
        <Row label={t('Confianza mínima')} detail={t('Por debajo de este valor, la hoja queda en “Sin clasificar”.')}>
          <Segmented
            label={t('Confianza mínima')}
            value={settings.jevThreshold}
            onChange={(value) => act(api.updateSettings({ jevThreshold: value }))}
            options={[
              { value: 0.4, label: '40%' },
              { value: 0.6, label: '60%' },
              { value: 0.8, label: '80%' },
            ]}
          />
        </Row>
      </Group>

      <Group title={t('Cuándo consulta {provider}', { provider })}>
        <p className="settings-note">
          {t(
            '{provider} no se consulta todo el tiempo. Una hoja se consulta cuando es nueva y dejó de cambiar; si ya está clasificada, no se vuelve a consultar aunque la edites, salvo que elijas revisarlas cada tanto. Y al crear o describir categorías, solo se revisan las hojas que quedaron sin categoría. Cambiar de IA tampoco vuelve a clasificar lo que ya está clasificado.',
            { provider },
          )}
        </p>
        <Row
          label={t('Revisar hojas ya clasificadas')}
          detail={t('Volver a consultar a {provider} por las hojas ya clasificadas que cambiaron.', { provider })}
        >
          <Segmented
            label={t('Cada cuánto volver a consultar las hojas ya clasificadas que cambiaron')}
            value={settings.jevRecheckDays}
            onChange={(value) => act(api.updateSettings({ jevRecheckDays: value }))}
            options={recheckOptions}
          />
        </Row>
        <Row label={t('Consultas')} detail={t('Cuenta las de todas las IAs, y también las pruebas.')}>
          <span className="row-value">
            {t('{today} hoy · {total} en total', { today: count(status.callsToday), total: count(status.callsTotal) })}
          </span>
        </Row>
      </Group>

      <Group>
        <Row
          label={t('Hojas pendientes de clasificar')}
          detail={status.error ?? pendingDetail(status.provider, status.ready, status.enabled)}
        >
          <span className="row-count">{status.pending}</span>
          <button type="button" className="button" disabled={!ready || status.pending === 0} onClick={() => act(api.classifyNow())}>
            {t('Clasificar ahora')}
          </button>
        </Row>
        <ReclassifyAll disabled={!ready} sheets={props.sheets} provider={provider} act={act} />
      </Group>
    </>
  );
}
