import { useRef, useState } from 'react';
import { FolderPlus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { plural, relativeTime } from '../../format';
import { tn, useT } from '../../i18n';
import type { FolderStat, ScanStatus, Settings } from '../../types';
import { Confirm, Presence, Segmented, Switch } from '../ui';
import { Group, Row, type Act } from './shared';

/** Lo que se está por confirmar: dejar de recorrer una carpeta, o excluir una donde aparecieron hojas. */
type Ask = { kind: 'root'; id: number; path: string; count: number } | { kind: 'ban'; folder: string; count: number };

/** La misma ruta escrita de una única manera, para compararlas. */
const pathKey = (path: string) => path.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
const isInside = (folder: string, root: string) => pathKey(folder) === pathKey(root) || pathKey(folder).startsWith(`${pathKey(root)}\\`);
/** Cuántas carpetas trae como mucho `folderStats`: si llegan tantas, la cuenta de una carpeta puede quedar corta. */
const STATS_LIMIT = 300;

/** Cuántas hojas salen del cuaderno, dicho para una pregunta. */
const leaving = (count: number, atLeast = false) =>
  atLeast
    ? tn(count, 'Salen al menos {n} hoja del cuaderno', 'Salen al menos {n} hojas del cuaderno')
    : tn(count, 'Sale {n} hoja del cuaderno', 'Salen {n} hojas del cuaderno');

/** Carpetas que Book recorre, repositorios y ocultas, y dónde aparecieron hojas. */
export function Folders(props: { settings: Settings; folders: FolderStat[]; scan: ScanStatus | undefined; act: Act }) {
  const t = useT();
  const { settings, folders, scan, act } = props;
  // Sacar una carpeta saca de un golpe todas sus hojas del cuaderno: se pregunta antes.
  const [ask, setAsk] = useState<Ask | null>(null);
  const asked = useRef<Ask | null>(null);
  if (ask) asked.current = ask;
  const truncated = folders.length >= STATS_LIMIT;
  const sheetsUnder = (root: string) => folders.filter((stat) => isInside(stat.folder, root)).reduce((sum, stat) => sum + stat.count, 0);
  const confirm = () => {
    if (!ask) return;
    setAsk(null);
    act(ask.kind === 'root' ? api.removeRoot(ask.id) : api.addBan('path', ask.folder));
  };
  return (
    <>
      <Group
        title={t('Carpetas que Folio recorre')}
        footer={t('Folio entra en todas las subcarpetas, salvo las excluidas. Los archivos no se mueven, y solo cambian si escribís en ellos desde el cuaderno.')}
      >
        {settings.roots.map((root) => (
          <Row key={root.id} label={root.path} mono>
            <button
              type="button"
              className="icon-button"
              aria-label={t('Quitar {path}', { path: root.path })}
              title={t('Quitar')}
              onClick={() => setAsk({ kind: 'root', id: root.id, path: root.path, count: sheetsUnder(root.path) })}
            >
              <Trash2 size={15} />
            </button>
          </Row>
        ))}
        <button
          type="button"
          className="row row-action"
          onClick={() => act(api.pickFolder().then((path) => (path ? api.addRoot(path) : undefined)))}
        >
          <FolderPlus size={15} /> {t('Agregar carpeta…')}
        </button>
      </Group>

      <Group>
        <Row label={t('Ignorar repositorios git')} detail={t('Carpetas de proyectos con control de versiones.')}>
          <Switch
            label={t('Ignorar repositorios git')}
            checked={settings.ignoreGitRepos}
            onChange={(value) => act(api.updateSettings({ ignoreGitRepos: value }))}
          />
        </Row>
        <Row label={t('Ignorar carpetas ocultas')} detail={t('Las que empiezan con punto, como .codex o .vscode.')}>
          <Switch
            label={t('Ignorar carpetas ocultas')}
            checked={settings.ignoreDotDirs}
            onChange={(value) => act(api.updateSettings({ ignoreDotDirs: value }))}
          />
        </Row>
        <Row label={t('Tamaño máximo de archivo')} detail={t('Los archivos más grandes casi nunca son notas: suelen ser registros o exportaciones.')}>
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
        <Row
          label={t('Formato de notas nuevas')}
          detail={t('Guardar las notas creadas en Folio como archivos .txt o .md con formato Markdown.')}
        >
          <Segmented
            label={t('Formato de notas nuevas')}
            value={settings.noteFormat ?? 'txt'}
            onChange={(value) => act(api.updateSettings({ noteFormat: value as 'txt' | 'md' }))}
            options={[
              { value: 'txt', label: '.txt' },
              { value: 'md', label: '.md' },
            ]}
          />
        </Row>
        <Row
          label={t('Volver a escanear')}
          detail={
            scan?.running
              ? t('Escaneando…')
              : scan?.lastScanAt
                ? t('{files} en {secs} s · {when}', {
                    files: plural(scan.lastScanFiles ?? 0, 'archivo', 'archivos'),
                    secs: ((scan.lastScanMs ?? 0) / 1000).toFixed(1),
                    when: relativeTime(scan.lastScanAt),
                  })
                : undefined
          }
        >
          <button type="button" className="button" disabled={scan?.running} onClick={() => act(api.rescan())}>
            <RefreshCw size={14} className={scan?.running ? 'spin' : undefined} /> {t('Escanear')}
          </button>
        </Row>
      </Group>

      <Group
        title={t('Dónde aparecieron hojas')}
        footer={t('Si una carpeta solo trae ruido, excluila: sus hojas salen de Folio y no se vuelve a recorrer.')}
      >
        {folders.length === 0 && <Row label={t('Todavía no hay hojas de archivos.')} />}
        {folders.slice(0, 60).map((stat) => (
          <Row key={stat.folder} label={stat.folder} mono>
            <span className="row-count">{stat.count}</span>
            <button type="button" className="button small" onClick={() => setAsk({ kind: 'ban', folder: stat.folder, count: stat.count })}>
              {t('Excluir')}
            </button>
          </Row>
        ))}
      </Group>

      <Presence show={ask !== null}>
        {(leavingNow) => {
          const shown = asked.current;
          if (!shown) return null;
          return shown.kind === 'root' ? (
            <Confirm
              title={t('¿Dejar de recorrer esta carpeta?')}
              detail={
                <>
                  <span className="mono">{shown.path}</span>
                  <br />
                  {shown.count > 0 ? `${leaving(shown.count, truncated)}.` : t('Si tiene hojas en el cuaderno, salen.')}{' '}
                  {t('Las notas originales no se tocan: siguen en tu disco.')}
                </>
              }
              confirm={t('Quitar')}
              danger
              leaving={leavingNow}
              onCancel={() => setAsk(null)}
              onConfirm={confirm}
            />
          ) : (
            <Confirm
              title={t('¿Excluir esta carpeta?')}
              detail={
                <>
                  <span className="mono">{shown.folder}</span>
                  <br />
                  {t('{leaving} y Folio no vuelve a recorrer esa carpeta.', { leaving: leaving(shown.count) })}{' '}
                  {t('Las notas originales no se tocan: siguen en tu disco.')}
                </>
              }
              confirm={t('Excluir')}
              danger
              leaving={leavingNow}
              onCancel={() => setAsk(null)}
              onConfirm={confirm}
            />
          );
        }}
      </Presence>
    </>
  );
}
