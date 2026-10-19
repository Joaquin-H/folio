import { useState } from 'react';
import { api } from '../../api';
import { shortDateTime } from '../../format';
import { tn, useT } from '../../i18n';
import type { MissingSheet, Settings } from '../../types';
import { Group, Row, type Act } from './shared';

/** Dónde vive la base de Book, qué queda afuera de ella y los originales que desaparecieron. */
export function Data(props: { settings: Settings; missing: MissingSheet[]; notesDir: string | undefined; act: Act }) {
  const t = useT();
  const { settings, missing, notesDir, act } = props;
  const [copied, setCopied] = useState(false);
  const [enteringKey, setEnteringKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');

  const copyKey = async () => {
    try {
      const key = await api.exportSecretKey();
      let ok = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(key);
          ok = true;
        }
      } catch {
        // En entornos sin foco
      }
      if (!ok) {
        try {
          const el = document.createElement('textarea');
          el.value = key;
          el.style.position = 'fixed';
          el.style.opacity = '0';
          document.body.appendChild(el);
          el.select();
          document.execCommand('copy');
          document.body.removeChild(el);
        } catch {
          // ignore
        }
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      //
    }
  };

  return (
    <>
      <Group
        title={t('Dónde guarda Folio sus datos')}
        footer={t('En ese archivo están las hojas indexadas, sus versiones, las categorías y estos ajustes. Si lo borrás, Folio vuelve a empezar de cero; tus notas originales no se tocan.')}
      >
        <Row label={settings.dataPath} mono>
          <button type="button" className="button" onClick={() => act(api.revealData())}>
            {t('Mostrar en la carpeta')}
          </button>
        </Row>
      </Group>
      <Group title={t('Qué no está ahí')}>
        <Row
          label={t('Tus notas originales')}
          detail={t('Siguen en sus carpetas. Folio no las mueve, y solo las modifica cuando escribís en una hoja desde el cuaderno.')}
        />
        <Row
          label={t('Las hojas que escribís en Folio')}
          detail={
            notesDir
              ? t('Son archivos de texto comunes, en {folder}: se pueden abrir con cualquier programa.', { folder: notesDir })
              : t('Son archivos de texto comunes: se pueden abrir con cualquier programa.')
          }
        />
        <Row label={t('Las claves de las IAs')} detail={t('Se guardan en el llavero del sistema operativo, no en el archivo de Folio.')} />
        <Row label={t('La personalización')} detail={t('Tema, idioma, color de tapa, tamaño de la letra, sonidos y solapas se recuerdan en la propia ventana.')} />
      </Group>
      <Group
        title={t('Originales que desaparecieron')}
        footer={t('Cuando un archivo se borra o una pestaña del Bloc de notas se cierra sin guardar, la hoja queda en el cuaderno con su último contenido. Si el archivo solo se movió o cambió de nombre, Folio lo reconoce y no aparece acá.')}
      >
        {missing.length === 0 && <Row label={t('Ninguno: todas las hojas tienen su original.')} />}
        {missing.map((sheet) => (
          <Row
            key={sheet.id}
            label={sheet.title}
            detail={`${t('Guardada el {date}.', { date: shortDateTime(sheet.modifiedAt) })} ${
              sheet.missingAt
                ? t('Desapareció el {date}.', { date: shortDateTime(sheet.missingAt) })
                : t('Desapareció antes de que Folio registrara la fecha.')
            }`}
          >
            <span className="row-count">{sheet.source === 'file' ? t('Archivo') : sheet.source === 'notepad' ? t('Bloc de notas') : 'Sticky Notes'}</span>
          </Row>
        ))}
      </Group>
      <Group
        title={t('Cuaderno secreto')}
        footer={t('Las hojas secretas se guardan cifradas en la base de datos con XChaCha20-Poly1305. La clave vive en el Administrador de credenciales de Windows. Con la clave de respaldo podés recuperarlas en otro equipo o tras reinstalar el sistema.')}
      >
        <Row
          label={
            settings.secretState === 'locked'
              ? t('Hojas secretas bloqueadas')
              : settings.secretState === 'empty'
                ? t('Sin hojas secretas')
                : t('Cifrado activo')
          }
          detail={
            settings.secretState === 'locked'
              ? tn(
                  settings.secretLockedCount,
                  'Hay {n} hoja secreta bloqueada porque falta la clave en este equipo.',
                  'Hay {n} hojas secretas bloqueadas porque falta la clave en este equipo.',
                )
              : settings.secretState === 'empty'
                ? t('Todavía no hay hojas secretas. Podés copiar la clave de respaldo o ingresar una que ya tengas.')
                : t('La clave de cifrado está disponible en este equipo.')
          }
        >
          {settings.secretState !== 'locked' && !enteringKey && (
            <>
              <button
                type="button"
                className="button"
                aria-label={t('Copiar clave de respaldo')}
                title={t('Copiar clave de respaldo')}
                onClick={copyKey}
              >
                {copied ? t('Copiada') : t('Copiar clave')}
              </button>
              <button
                type="button"
                className="button"
                aria-label={t('Ingresar clave de respaldo…')}
                title={t('Ingresar clave de respaldo…')}
                onClick={() => setEnteringKey(true)}
              >
                {t('Restaurar clave…')}
              </button>
            </>
          )}
        </Row>
        {(settings.secretState === 'locked' || enteringKey) && (
          <form
            className="row add-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (keyInput.trim()) {
                act(
                  api.importSecretKey(keyInput.trim()).then(() => {
                    setKeyInput('');
                    setEnteringKey(false);
                  }),
                );
              }
            }}
          >
            <input
              type="password"
              style={{ flex: 1 }}
              value={keyInput}
              placeholder={t('Pegá tu clave de respaldo')}
              aria-label={t('Clave de respaldo')}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <button type="submit" className="button primary" disabled={!keyInput.trim()}>
              {settings.secretState === 'locked' ? t('Desbloquear hojas secretas') : t('Guardar')}
            </button>
            {enteringKey && (
              <button
                type="button"
                className="button quiet"
                onClick={() => {
                  setEnteringKey(false);
                  setKeyInput('');
                }}
              >
                {t('Cancelar')}
              </button>
            )}
          </form>
        )}
      </Group>
    </>
  );
}
