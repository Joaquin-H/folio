import { invoke } from '@tauri-apps/api/core';

/**
 * Verificador de actualizaciones de Folio a través de GitHub Releases.
 *
 * Consulta la API pública de GitHub para saber si hay una versión más nueva que la
 * instalada, sin telemetría ni rastreo. Si no hay conexión a internet o el repositorio
 * todavía no tiene publicaciones, se comporta de forma limpia sin alertas intrusivas.
 */

export interface UpdateInfo {
  /** Si hay una versión más reciente disponible para descargar. */
  available: boolean;
  /** Número de versión remota más reciente (ej. "1.0.1"). */
  latestVersion?: string;
  /** Enlace a la página de la versión o al repositorio en GitHub. */
  url?: string;
  /** Título o nombre de la versión remota, si vino en la respuesta. */
  name?: string;
  /** Error en caso de que la consulta haya fallado. */
  error?: 'offline' | 'not_found' | 'rate_limited' | 'unknown';
}

/** Compara dos versiones semver numéricas (ej. "1.0.1" vs "1.0.0"). */
export function isNewerVersion(remoteTag: string, currentVersion: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^[vV]/, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => {
        const n = parseInt(part, 10);
        return Number.isNaN(n) ? 0 : n;
      });

  const remote = parse(remoteTag);
  const current = parse(currentVersion);
  const len = Math.max(remote.length, current.length);

  for (let i = 0; i < len; i += 1) {
    const r = remote[i] ?? 0;
    const c = current[i] ?? 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
}

export const GITHUB_REPO = 'Joaquin-H/folio';

export async function checkUpdate(
  currentVersion: string,
  repo = GITHUB_REPO,
): Promise<UpdateInfo> {
  // En la aplicación instalada usamos el comando nativo de Rust para evitar bloqueos de CSP
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const data = await invoke<{
        tag_name: string;
        html_url: string;
        name?: string;
      } | null>('check_update', { repo });

      if (!data) {
        return { available: false, error: 'not_found' };
      }

      const tagName = data.tag_name ?? '';
      const cleanVersion = tagName.replace(/^[vV]/, '').trim();
      const newer = Boolean(cleanVersion && isNewerVersion(cleanVersion, currentVersion));

      return {
        available: newer,
        latestVersion: cleanVersion || undefined,
        url: data.html_url || `https://github.com/${repo}/releases`,
        name: data.name,
      };
    } catch (err) {
      const msg = String(err);
      if (msg === 'rate_limited') return { available: false, error: 'rate_limited' };
      if (msg.startsWith('status_404')) return { available: false, error: 'not_found' };
      return { available: false, error: 'offline' };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
      },
      signal: controller.signal,
    });

    if (response.status === 404) {
      return { available: false, error: 'not_found' };
    }

    if (response.status === 403) {
      return { available: false, error: 'rate_limited' };
    }

    if (!response.ok) {
      return { available: false, error: 'unknown' };
    }

    const data = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      name?: string;
    };

    const tagName = data.tag_name ?? '';
    const cleanVersion = tagName.replace(/^[vV]/, '').trim();
    const newer = Boolean(cleanVersion && isNewerVersion(cleanVersion, currentVersion));

    return {
      available: newer,
      latestVersion: cleanVersion || undefined,
      url: data.html_url || `https://github.com/${repo}/releases`,
      name: data.name,
    };
  } catch {
    return { available: false, error: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}
