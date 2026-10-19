import { invoke } from '@tauri-apps/api/core';
import { useMemo, useSyncExternalStore } from 'react';
import type { Lang } from '../types';
import { EN } from './en';

/**
 * Idiomas de la interfaz. La fuente es el español: la clave de cada frase ES la frase en
 * español, escrita tal cual en el componente, y el inglés vive aparte (`./en`), de a una
 * frase por clave. Una frase sin traducción se muestra en español: así se traduce de a
 * poco, sin romper nada.
 *
 *   const t = useT();                                  // en un componente
 *   t('Cancelar')                                      // "Cancel"
 *   t('Hoja {n} de {total}', { n, total })             // "Sheet 3 of 40"
 *   tn(n, '{n} hoja', '{n} hojas')                     // "1 sheet" / "2 sheets"
 *   const KINDS = [{ label: mark('Archivos') }]        // en una constante: se marca y se traduce al dibujar
 *   t(KINDS[0].label)
 *
 * Los textos que llegan del backend (errores, nombres de categorías, notas) no se traducen.
 * Para ver qué frases usadas con `t()` no tienen inglés: `pnpm i18n` (revisa el código) o,
 * con la interfaz en inglés, `window.__i18n.missing()` en la consola (las que se dibujaron).
 */

/** El idioma que se muestra: lo que queda después de resolver «automático». */
export type Locale = 'es' | 'en';
export type Vars = Record<string, string | number>;

/** Primer idioma de la lista del sistema; si es español (`es`, `es-AR`…), español; si no, inglés. */
function systemLocale(): Locale {
  const first = typeof navigator === 'undefined' ? '' : (navigator.languages?.[0] ?? navigator.language ?? '');
  return first === '' || /^es\b/i.test(first) ? 'es' : 'en';
}

let chosen: Lang = 'auto';
let current: Locale = systemLocale();
const listeners = new Set<() => void>();

/** Elige el idioma (el de las preferencias) y avisa a los componentes que lo muestran. */
export function setLanguage(lang: Lang) {
  chosen = lang;
  const next = lang === 'auto' ? systemLocale() : lang;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  const changed = next !== current;
  current = next;
  if (changed) {
    listeners.forEach((listener) => listener());
  }
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    void invoke('set_locale', { locale: next }).catch(() => {});
  }
}

// En automático, si el sistema cambia de idioma con la app abierta, la interfaz lo sigue.
if (typeof window !== 'undefined') window.addEventListener('languagechange', () => chosen === 'auto' && setLanguage('auto'));

/** El idioma que se está mostrando. Para decidir cosas que no son una frase (formatos, orden). */
export const locale = (): Locale => current;

/**
 * Etiqueta con la que se formatean fechas y números en ese idioma. El español queda en `es`;
 * el inglés toma la variante del sistema (`en-GB` da relojes de 24 horas) y, si no hay, `en-US`.
 */
export function intlTag(of: Locale = current): string {
  if (of === 'es') return 'es';
  const own = typeof navigator === 'undefined' ? undefined : navigator.languages?.find((tag) => /^en\b/i.test(tag));
  try {
    return own ? Intl.getCanonicalLocales(own)[0] : 'en-US';
  } catch {
    return 'en-US';
  }
}

const numbers = new Map<string, Intl.NumberFormat>();

/** Un número con los separadores del idioma: 12.345 en español y 12,345 en inglés. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  const key = `${intlTag()}${options ? JSON.stringify(options) : ''}`;
  let format = numbers.get(key);
  if (!format) {
    format = new Intl.NumberFormat(intlTag(), options);
    numbers.set(key, format);
  }
  return format.format(value);
}

/** Frases que se pidieron en inglés y no tenían traducción (solo en desarrollo). */
const missing = new Set<string>();

function render(at: Locale, key: string, vars?: Vars): string {
  let text = key;
  if (at === 'en' && key !== '') {
    if (Object.hasOwn(EN, key)) text = EN[key];
    else if (import.meta.env.DEV) missing.add(key);
  }
  return vars ? text.replace(/\{(\w+)\}/g, (hole, name: string) => (name in vars ? String(vars[name]) : hole)) : text;
}

/** Traduce una frase (la clave es el texto en español). `{nombre}` se reemplaza con `vars.nombre`. */
export function t(key: string, vars?: Vars): string {
  return render(current, key, vars);
}

/**
 * Plurales: elige la frase según `n` (`one` si es 1, `many` en cualquier otro caso) y le
 * pone el número, con los separadores del idioma, en `{n}`. Las dos formas son claves.
 */
export function tn(n: number, one: string, many: string, vars?: Vars): string {
  return render(current, n === 1 ? one : many, { n: formatNumber(n), ...vars });
}

/** Una cita entre comillas, las de cada idioma: «así» en español, “this” en inglés. */
export const quote = (text: string) => t('«{text}»', { text });

/**
 * Marca un texto para traducirlo más tarde y lo devuelve igual. Para frases que viven en una
 * constante fuera de un componente (listas de opciones, por ejemplo): se marcan ahí, y se
 * traducen al dibujar con `t(constante.texto)`. Sirve a `pnpm i18n` para encontrarlas.
 */
export const mark = <T extends string>(key: T): T => key;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** El idioma que se muestra, y el componente se redibuja cuando cambia. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, locale);
}

/**
 * `t` para un componente: lo redibuja cuando cambia el idioma (también si el cambio se hizo
 * en otra ventana), y su identidad cambia con él, así que sirve como dependencia de un
 * `useMemo`. Es la forma de usarlo dentro de los componentes.
 */
export function useT(): typeof t {
  const at = useLocale();
  return useMemo(() => (key: string, vars?: Vars) => render(at, key, vars), [at]);
}

// Para revisar a mano desde la consola o desde las pruebas: `window.__i18n.missing()`.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  Object.assign(window, {
    __i18n: {
      /** Las frases que se pidieron en inglés sin traducción desde que se cargó la página. */
      missing: () => [...missing].sort(),
      clear: () => missing.clear(),
      locale,
    },
  });
}
