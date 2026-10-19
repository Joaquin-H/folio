import { useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { api } from '../../api';
import { mark, useT } from '../../i18n';
import type { Settings } from '../../types';
import { checkUpdate, type UpdateInfo } from '../../update';
import { Group, Row } from './shared';
// El texto completo es el archivo LICENSE de la raíz: así no hay dos copias que se desfasen.
import licenseText from '../../../LICENSE?raw';

/** Con qué está hecho Folio, y bajo qué licencia llega cada pieza. */
const BUILT_WITH: { name: string; what: string; license: string }[] = [
  { name: 'Tauri', what: mark('La ventana, la bandeja y los atajos del sistema.'), license: 'MIT / Apache 2.0' },
  { name: 'React', what: mark('La interfaz.'), license: 'MIT' },
  { name: 'SQLite (con rusqlite)', what: mark('La base donde Folio guarda las hojas, las versiones y los ajustes.'), license: mark('Dominio público / MIT') },
  { name: 'Lucide', what: mark('Los íconos.'), license: 'ISC' },
  { name: 'Inter', what: mark('La tipografía.'), license: 'SIL Open Font License 1.1' },
];

/** Acerca de Folio: versión, autoría, actualizaciones, licencia y con qué está hecho. */
export function About(props: { settings: Settings; onTour: () => void }) {
  const t = useT();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateInfo | null>(null);

  const onCheck = async () => {
    setChecking(true);
    try {
      const info = await checkUpdate(props.settings.version);
      setResult(info);
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <Group>
        <Row label="Folio" detail={t('Un cuaderno que reúne tus notas, vengan de donde vengan.')}>
          <span className="row-value">{t('Versión {version}', { version: props.settings.version })}</span>
        </Row>
        <Row label={t('Creado por Joaquín Hernández')} />
      </Group>

      <Group title={t('Actualizaciones')}>
        {result === null && !checking && (
          <Row
            label={t('Buscar actualizaciones')}
            detail={t('Comprueba si hay una versión más reciente de Folio en GitHub.')}
          >
            <button type="button" className="button" onClick={onCheck}>
              {t('Buscar ahora')}
            </button>
          </Row>
        )}

        {checking && (
          <Row
            label={t('Buscar actualizaciones')}
            detail={t('Consultando versiones en GitHub…')}
          >
            <button type="button" className="button" disabled>
              <RefreshCw size={13} className="spin" />
              {t('Buscando…')}
            </button>
          </Row>
        )}

        {result !== null && !checking && result.available && (
          <Row
            label={t('¡Nueva versión disponible!')}
            detail={t('La versión {version} está lista para descargar en GitHub.', {
              version: result.latestVersion ?? '',
            })}
          >
            <button
              type="button"
              className="button primary"
              onClick={() => {
                if (result.url) void api.openLink(result.url);
              }}
            >
              <Download size={13} />
              {t('Descargar v{version}', { version: result.latestVersion ?? '' })}
            </button>
          </Row>
        )}

        {result !== null && !checking && !result.available && !result.error && (
          <Row
            label={t('Folio está al día')}
            detail={t('Tenés la versión más reciente (v{version}).', {
              version: props.settings.version,
            })}
          >
            <button type="button" className="button" onClick={onCheck}>
              {t('Volver a buscar')}
            </button>
          </Row>
        )}

        {result !== null && !checking && result.error && (
          <Row
            label={t('No se pudo comprobar')}
            detail={
              result.error === 'offline'
                ? t('Sin conexión a internet para consultar GitHub.')
                : t('No se encontraron publicaciones en el repositorio de GitHub.')
            }
          >
            <button type="button" className="button" onClick={onCheck}>
              {t('Reintentar')}
            </button>
          </Row>
        )}
      </Group>

      <Group title={t('Recorrido')}>
        <Row label={t('Conocer el cuaderno')} detail={t('Una vuelta corta por lo que hace cada cosa: pasar de hoja, escribir, buscar, las solapas y los atajos.')}>
          <button type="button" className="button" onClick={props.onTour}>
            {t('Ver el recorrido')}
          </button>
        </Row>
      </Group>

      <Group title={t('Licencia')} footer={t('Licencia MIT con la condición Commons Clause: el código está abierto, pero no se puede vender.')}>
        <p className="settings-note">
          {t('Podés usar Folio, copiarlo, modificarlo y compartirlo libremente, siempre que conserves el aviso de autoría y de licencia. Lo que no se puede es venderlo, ni cobrar por un producto o servicio cuyo valor sea Folio. Se ofrece tal cual, sin garantías de ningún tipo.')}
        </p>
        <details className="license">
          <summary>{t('Texto completo de la licencia')}</summary>
          <pre className="license-text">{licenseText.trim()}</pre>
        </details>
      </Group>

      <Group title={t('Hecho con')} footer={t('Cada una de estas piezas tiene su propia licencia, que Folio respeta.')}>
        {BUILT_WITH.map((piece) => (
          <Row key={piece.name} label={piece.name} detail={t(piece.what)}>
            <span className="row-value">{piece.license === 'Dominio público / MIT' ? t('Dominio público / MIT') : piece.license}</span>
          </Row>
        ))}
      </Group>
    </>
  );
}
