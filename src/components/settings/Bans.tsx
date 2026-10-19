import { useState } from 'react';
import { FolderMinus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { mark, useT } from '../../i18n';
import type { BanKind, Settings } from '../../types';
import { Segmented, Switch } from '../ui';
import { Group, Row, type Act } from './shared';

const BAN_KINDS: { value: BanKind; label: string; hint: string; placeholder: string }[] = [
  { value: 'dir', label: mark('Carpetas por nombre'), hint: mark('Se saltean en cualquier lugar del disco.'), placeholder: 'node_modules' },
  { value: 'file', label: mark('Archivos por nombre'), hint: mark('Aceptan * como comodín.'), placeholder: 'README*' },
  { value: 'path', label: mark('Carpetas concretas'), hint: mark('Una ubicación puntual y todo lo que contiene.'), placeholder: 'C:\\Users\\yo\\Descargas\\viejo' },
];

/** Lo que Book no recorre: carpetas puntuales y nombres que se repiten en muchos lugares. */
export function Bans(props: { settings: Settings; act: Act }) {
  const t = useT();
  const { settings, act } = props;
  const [banKind, setBanKind] = useState<BanKind>('dir');
  const [banPattern, setBanPattern] = useState('');

  return (
    <>
      <Group title={t('Excluir una carpeta')} footer={t('Elegila en el explorador: Folio deja de recorrerla, con todo lo que contiene.')}>
        <button
          type="button"
          className="row row-action"
          onClick={() => act(api.pickFolder().then((folder) => (folder ? api.addBan('path', folder) : undefined)))}
        >
          <FolderMinus size={15} /> {t('Elegir carpeta…')}
        </button>
      </Group>
      <Group title={t('Excluir por nombre')} footer={t('Para lo que se repite en muchos lugares, como node_modules o los README.')}>
        <div className="row add-row">
          <Segmented
            label={t('Tipo de exclusión')}
            value={banKind}
            onChange={setBanKind}
            options={[
              { value: 'dir', label: t('Carpetas') },
              { value: 'file', label: t('Archivos') },
            ]}
          />
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!banPattern.trim()) return;
              act(api.addBan(banKind, banPattern));
              setBanPattern('');
            }}
          >
            <input
              value={banPattern}
              aria-label={t('Patrón a excluir')}
              placeholder={BAN_KINDS.find((k) => k.value === banKind)?.placeholder}
              onChange={(event) => setBanPattern(event.target.value)}
            />
            <button type="submit" className="button primary" disabled={!banPattern.trim()}>
              {t('Agregar')}
            </button>
          </form>
        </div>
      </Group>
      {BAN_KINDS.map((kind) => {
        const bans = settings.bans.filter((ban) => ban.kind === kind.value);
        if (bans.length === 0) return null;
        return (
          <Group key={kind.value} title={t(kind.label)} footer={t(kind.hint)}>
            {bans.map((ban) => (
              <Row key={ban.id} label={ban.pattern} mono>
                {!ban.builtin && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t('Eliminar {pattern}', { pattern: ban.pattern })}
                    title={t('Eliminar')}
                    onClick={() => act(api.removeBan(ban.id))}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
                <Switch
                  label={t('Excluir {pattern}', { pattern: ban.pattern })}
                  checked={ban.enabled}
                  onChange={(value) => act(api.setBanEnabled(ban.id, value))}
                />
              </Row>
            ))}
          </Group>
        );
      })}
    </>
  );
}
