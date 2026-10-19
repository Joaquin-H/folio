import { useEffect, useState } from 'react';
import { Plus, RotateCcw } from 'lucide-react';
import { api } from '../../api';
import { mark, useT } from '../../i18n';
import {
  ACTIONS,
  anyCustom,
  combosOf,
  format,
  GLOBAL_ACTIONS,
  GROUPS,
  isCustom,
  MAX_COMBOS,
  normalize,
  ownerOf,
  problemWith,
  problemWithGlobal,
  readCapture,
  reset,
  resetAll,
  setCombos,
  useShortcuts,
  type GlobalKeys,
  type Owner,
  type ShortcutAction,
  type ShortcutGroup,
  type ShortcutId,
} from '../../shortcuts';
import type { GlobalShortcut, SendTarget, Settings } from '../../types';
import { Confirm, Presence, Segmented, Switch } from '../ui';
import { Group, Row, type Act } from './shared';
import '../../styles/shortcuts.css';

/** Qué tecla de la pantalla está esperando la combinación nueva: una que ya está, o una por agregar (`index` -1). */
type Target = { kind: 'app'; id: ShortcutId; index: number } | { kind: 'global'; which: GlobalShortcut };

/** Aviso debajo de un renglón: algo no sirve, o choca con otra acción y se puede reemplazar. */
interface Notice {
  row: string;
  kind: 'error' | 'conflict';
  text: string;
  /** Quita la combinación de la otra acción y se la deja a esta. */
  replace?: () => void;
}

const rowOf = (target: Target) => (target.kind === 'app' ? `app:${target.id}` : `global:${target.which}`);
const sameKey = (a: Target | null, b: Target) =>
  a !== null && a.kind === b.kind && (a.kind === 'app' && b.kind === 'app' ? a.id === b.id && a.index === b.index : a.kind === 'global' && b.kind === 'global' && a.which === b.which);

const FOOTERS: Partial<Record<ShortcutGroup, string>> = {
  Cuaderno: mark('Tocá una combinación y apretá la nueva. Esc cancela; Retroceso o Supr la quitan. Cada acción puede tener más de una.'),
  'Hoja suelta': mark('Valen en la hoja suelta, la ventana que se abre con el atajo de «Nueva hoja suelta».'),
};

/** Lo que se hace con el mouse: se muestra para tenerlo a mano, pero no se cambia. */
const MOUSE: { what: string; keys: string[] }[] = [
  { what: mark('Escribir en la hoja'), keys: [mark('doble clic')] },
  { what: mark('Pasar página'), keys: [mark('clic en el borde de afuera'), mark('rueda del mouse'), mark('deslizar hacia un costado')] },
  { what: mark('Seguir una selección en la hoja de al lado'), keys: [mark('arrastrar hasta el borde')] },
  { what: mark('Cambiar el tamaño del cuaderno a mano'), keys: [mark('Mayús + arrastrar un borde')] },
  { what: mark('Cerrar un menú o un diálogo'), keys: [mark('Esc')] },
];

/** Atajos: las combinaciones de cada acción, que se cambian tocándolas y apretando la nueva. */
export function Shortcuts(props: { settings: Settings; act: Act }) {
  const { settings, act } = props;
  useShortcuts();
  const t = useT();
  const [capturing, setCapturing] = useState<Target | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [asking, setAsking] = useState(false);

  const globals: GlobalKeys = {
    capture: normalize(settings.captureKeys) ?? settings.captureKeys,
    open: normalize(settings.openKeys) ?? settings.openKeys,
    send: normalize(settings.sendKeys) ?? settings.sendKeys,
  };
  const shownGlobals = (which: GlobalShortcut) =>
    which === 'capture' ? settings.captureShortcut : which === 'open' ? settings.openShortcut : settings.sendShortcut;
  const globalsChanged = GLOBAL_ACTIONS.some((global) => globals[global.which] !== global.default);

  /** Cambia un atajo global; si el sistema no lo acepta, el motivo queda a la vista. */
  const setGlobal = async (which: GlobalShortcut, keys: string): Promise<boolean> => {
    try {
      await api.setGlobalShortcut(which, keys);
      act(Promise.resolve());
      return true;
    } catch (reason) {
      setNotice({ row: rowOf({ kind: 'global', which }), kind: 'error', text: String(reason).replace(/^Error:\s*/, '') });
      return false;
    }
  };

  const conflict = (row: string, owner: Owner, combo: string, apply: () => Promise<boolean> | boolean) => {
    setCapturing(null);
    if (owner.kind === 'global') {
      setNotice({ row, kind: 'error', text: t('Ya se usa para «{label}», que vale desde cualquier programa: cambiá ese primero.', { label: t(owner.label) }) });
      return;
    }
    setNotice({
      row,
      kind: 'conflict',
      text: t('Ya se usa para «{label}».', { label: t(owner.label) }),
      replace: async () => {
        if (!(await apply())) return;
        setCombos(owner.id, combosOf(owner.id).filter((other) => other !== combo));
        setNotice(null);
      },
    });
  };

  /** Se apretó una combinación para esa tecla: se comprueba y, si sirve, queda. */
  const choose = (target: Target, combo: string) => {
    const row = rowOf(target);
    if (target.kind === 'global') {
      const problem = problemWithGlobal(combo);
      if (problem) return setNotice({ row, kind: 'error', text: problem });
      if (combo === globals[target.which]) return finish();
      const apply = () => setGlobal(target.which, combo);
      const owner = ownerOf(combo, { which: target.which }, globals);
      if (owner) return conflict(row, owner, combo, apply);
      finish();
      void apply();
      return;
    }
    const problem = problemWith(target.id, combo);
    if (problem) return setNotice({ row, kind: 'error', text: problem });
    const current = combosOf(target.id);
    if (current[target.index] === combo) return finish();
    if (current.includes(combo)) return setNotice({ row, kind: 'error', text: t('Esa combinación ya es de esta acción.') });
    const apply = () => {
      const next = [...current];
      if (target.index < 0) next.push(combo);
      else next[target.index] = combo;
      setCombos(target.id, next);
      return true;
    };
    const owner = ownerOf(combo, { id: target.id }, globals);
    if (owner) return conflict(row, owner, combo, apply);
    finish();
    apply();
  };

  const finish = () => {
    setCapturing(null);
    setNotice(null);
  };

  const start = (target: Target) => {
    setNotice(null);
    setCapturing((current) => (sameKey(current, target) ? null : target));
  };

  // Mientras espera la combinación, el teclado es de esta pantalla: ni los atajos de la
  // ventana ni Esc (que cerraría Ajustes) llegan a nadie más.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      const bare = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
      if (bare && event.key === 'Escape') return finish();
      if (bare && (event.key === 'Backspace' || event.key === 'Delete')) {
        // Quitar la combinación; un atajo global no puede quedarse sin ninguna.
        if (capturing.kind === 'app' && capturing.index >= 0) {
          setCombos(capturing.id, combosOf(capturing.id).filter((_, index) => index !== capturing.index));
        }
        return finish();
      }
      const read = readCapture(event, capturing.kind === 'global' ? 'global' : 'app');
      if (read.kind === 'wait') return;
      if (read.kind === 'invalid') return setNotice({ row: rowOf(capturing), kind: 'error', text: read.reason });
      choose(capturing, read.combo);
    };
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.keycap.listening')) setCapturing(null);
    };
    const onBlur = () => setCapturing(null);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('blur', onBlur);
    };
    // `choose` y `finish` se rehacen en cada dibujo; lo que cambia lo que hacen es `capturing` y los ajustes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, settings]);

  const resetEverything = async () => {
    setAsking(false);
    setNotice(null);
    resetAll();
    for (const global of GLOBAL_ACTIONS) {
      if (globals[global.which] !== global.default && !(await setGlobal(global.which, global.default))) break;
    }
  };

  const noticeFor = (row: string) =>
    notice?.row === row && (
      <div className={`shortcut-notice ${notice.kind}`} role="alert">
        <span>{notice.text}</span>
        {notice.replace && (
          <span className="shortcut-notice-actions">
            <button type="button" className="button small primary" onClick={notice.replace}>
              {t('Reemplazar')}
            </button>
            <button type="button" className="button small" onClick={() => setNotice(null)}>
              {t('Cancelar')}
            </button>
          </span>
        )}
      </div>
    );

  const keycap = (target: Target, combo: string | null, label: string) => {
    const listening = sameKey(capturing, target);
    const adding = combo === null;
    return (
      <button
        key={adding ? 'add' : `${combo}`}
        type="button"
        className={`keycap${listening ? ' listening' : ''}${adding ? ' add' : ''}`}
        aria-label={adding ? t('Agregar otra combinación para {label}', { label: t(label) }) : t('{label}: {combo}. Tocá para cambiarla', { label: t(label), combo: format(combo) })}
        title={adding ? t('Agregar otra combinación') : t('Tocá para cambiarla')}
        data-combo={combo ?? undefined}
        onClick={() => start(target)}
      >
        {listening ? t('Apretá la combinación nueva…') : adding ? <Plus size={14} /> : format(combo)}
      </button>
    );
  };

  const restore = (label: string, shown: boolean, factory: string, onReset: () => void) => (
    <button
      type="button"
      className={`icon-button shortcut-reset${shown ? ' shown' : ''}`}
      aria-label={t('Restablecer {label}', { label: t(label) })}
      title={t('Volver a la de fábrica: {factory}', { factory })}
      tabIndex={shown ? 0 : -1}
      aria-hidden={shown ? undefined : true}
      onClick={onReset}
    >
      <RotateCcw size={14} />
    </button>
  );

  const actionRow = (action: ShortcutAction) => {
    const combos = combosOf(action.id);
    const row = `app:${action.id}`;
    return (
      <div className="row shortcut-row" key={action.id} data-action={action.id}>
        <div className="row-text">
          <span>{t(action.label)}</span>
          {action.detail && <small>{t(action.detail)}</small>}
        </div>
        <div className="row-control shortcut-keys">
          {combos.length === 0 && !sameKey(capturing, { kind: 'app', id: action.id, index: -1 }) && <span className="shortcut-none">{t('Sin atajo')}</span>}
          {combos.map((combo, index) => keycap({ kind: 'app', id: action.id, index }, combo, action.label))}
          {combos.length < MAX_COMBOS && keycap({ kind: 'app', id: action.id, index: -1 }, null, action.label)}
          {restore(action.label, isCustom(action.id), action.defaults.map(format).join(', '), () => {
            setNotice(null);
            reset(action.id);
          })}
        </div>
        {noticeFor(row)}
      </div>
    );
  };

  return (
    <>
      <Group>
        <div className="row shortcut-row">
          <div className="row-text">
            <span>{t('Atajos de teclado')}</span>
            <small>{t('Cambialos a tu gusto. Los que valen en la hoja suelta y desde cualquier programa están más abajo.')}</small>
          </div>
          <div className="row-control">
            <button
              type="button"
              className="button"
              disabled={!anyCustom() && !globalsChanged}
              onClick={() => setAsking(true)}
            >
              <RotateCcw size={14} /> {t('Restablecer todos')}
            </button>
          </div>
        </div>
      </Group>

      {GROUPS.map((group) => (
        <Group key={group} title={t(group)} footer={FOOTERS[group] ? t(FOOTERS[group]!) : undefined}>
          {ACTIONS.filter((action) => action.group === group).map(actionRow)}
        </Group>
      ))}

      <Group
        title={t('Desde cualquier programa')}
        footer={t('Funcionan aunque Folio esté en la bandeja. La hoja nueva se abre encima de lo que estés haciendo, como una hoja suelta: al cerrarla queda guardada en el cuaderno. Enviar lo seleccionado usa un atajo de teclado porque Windows no tiene un menú de clic derecho común a todos los programas; la hoja del día es recortes-AAAA-MM-DD.txt, en la carpeta de Folio.')}
      >
        {GLOBAL_ACTIONS.map((global) => {
          const target: Target = { kind: 'global', which: global.which };
          const keys = globals[global.which];
          const unavailable = shownGlobals(global.which) === null;
          return (
            <div className="row shortcut-row" key={global.which} data-action={`global-${global.which}`}>
              <div className="row-text">
                <span>{t(global.label)}</span>
                {global.detail && <small>{t(global.detail)}</small>}
                {unavailable && <small className="shortcut-warn">{t('No se pudo activar: otra aplicación ya usa esa combinación.')}</small>}
              </div>
              <div className="row-control shortcut-keys">
                {keycap(target, keys, global.label)}
                {restore(global.label, keys !== global.default, format(global.default), () => {
                  setNotice(null);
                  void setGlobal(global.which, global.default);
                })}
              </div>
              {noticeFor(rowOf(target))}
            </div>
          );
        })}
        <Row className="shortcut-send-target" label={t('Al enviar lo seleccionado')} detail={t('Qué hace Folio con el texto cuando apretás el atajo de enviar.')}>
          <Segmented<SendTarget>
            label={t('Al enviar lo seleccionado')}
            value={settings.sendTo}
            onChange={(sendTo) => act(api.updateSettings({ sendTo }))}
            options={[
              { value: 'all', label: t('Hoja única'), title: t('Agregar siempre a recortes.txt') },
              { value: 'day', label: t('Por día'), title: t('Agregar a la hoja del día (recortes-AAAA-MM-DD.txt)') },
              { value: 'week', label: t('Por semana'), title: t('Agregar a la hoja de la semana (recortes-semana-AAAA-MM-DD.txt)') },
              { value: 'month', label: t('Por mes'), title: t('Agregar a la hoja del mes (recortes-AAAA-MM.txt)') },
              { value: 'sheet', label: t('Hoja suelta'), title: t('Abrir en hoja suelta') },
            ]}
          />
        </Row>
        <Row
          label={t('Incluir origen en los recortes')}
          detail={t('Agrega la hora, el programa y la ventana de donde copiaste el texto antes de cada recorte.')}
        >
          <Switch
            label={t('Incluir origen en los recortes')}
            checked={settings.sendOrigin}
            onChange={(sendOrigin) => act(api.updateSettings({ sendOrigin }))}
          />
        </Row>
      </Group>

      <Group title={t('Con el mouse')} footer={t('Estos gestos no se cambian.')}>
        {MOUSE.map((gesture) => (
          <div className="row" key={gesture.what}>
            <div className="row-text">
              <span>{t(gesture.what)}</span>
            </div>
            <div className="row-control">
              {gesture.keys.map((keys) => (
                <kbd key={keys} className="keys fixed">
                  {t(keys)}
                </kbd>
              ))}
            </div>
          </div>
        ))}
      </Group>

      <Presence show={asking}>
        {(leaving) => (
          <Confirm
            title={t('¿Restablecer todos los atajos?')}
            detail={t('Cada atajo vuelve a su combinación de fábrica, también los que valen desde cualquier programa.')}
            confirm={t('Restablecer')}
            leaving={leaving}
            onCancel={() => setAsking(false)}
            onConfirm={() => void resetEverything()}
          />
        )}
      </Presence>
    </>
  );
}
