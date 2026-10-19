import { formatNumber, intlTag, locale, t } from './i18n';

const DAY_MS = 86_400_000;

// Las fechas se formatean en el idioma elegido, que puede cambiar con la app abierta: el
// formateador se arma una vez por idioma y por opciones, en lugar de al cargar el módulo.
const formatters = new Map<string, Intl.DateTimeFormat>();
function dates(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const tag = intlTag();
  const key = `${tag}${JSON.stringify(options)}`;
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(tag, options);
    formatters.set(key, format);
  }
  return format;
}

/** La hora lleva dos dígitos en español ("09:30") y uno en inglés ("9:30 AM"). */
const hourDigits = () => (locale() === 'es' ? '2-digit' : 'numeric');

const weekday = (date: Date) => dates({ weekday: 'long' }).format(date);
const dayMonth = (date: Date) => dates({ day: 'numeric', month: 'long' }).format(date);
const dayMonthYear = (date: Date) => dates({ day: 'numeric', month: 'long', year: 'numeric' }).format(date);
const clock = (date: Date) => dates({ hour: hourDigits(), minute: '2-digit' }).format(date);
const shortDate = (date: Date) => dates({ day: 'numeric', month: 'short', hour: hourDigits(), minute: '2-digit' }).format(date);
const monthYear = (date: Date) => dates({ month: 'long', year: 'numeric' }).format(date);

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Clave YYYY-MM-DD en hora local, igual a la que devuelve el backend. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Encabezado de una página del cuaderno: "Hoy" + "sábado 10 de octubre" (en inglés,
 * "Today" + "Saturday, October 10"). `relative` dice si el título es "Hoy" o "Ayer", en
 * cualquier idioma: para decidirlo no se compara el texto del título.
 */
export function dayHeading(ts: number): { title: string; subtitle: string; relative: boolean } {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY_MS);
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const full = sameYear ? dayMonth(date) : dayMonthYear(date);
  const withWeekday = `${weekday(date)}${locale() === 'es' ? ' ' : ', '}${full}`;
  if (days === 0) return { title: t('Hoy'), subtitle: withWeekday, relative: true };
  if (days === 1) return { title: t('Ayer'), subtitle: withWeekday, relative: true };
  return { title: capitalize(weekday(date)), subtitle: full, relative: false };
}

export const timeOf = (ts: number) => clock(new Date(ts));
export const shortDateTime = (ts: number) => shortDate(new Date(ts));
export const monthTitle = (date: Date) => capitalize(monthYear(date));

export function relativeTime(ts: number): string {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return t('recién');
  if (minutes < 60) return t('hace {n} min', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('hace {n} h', { n: hours });
  return t('hace {n} d', { n: Math.round(hours / 24) });
}

export const count = (n: number) => formatNumber(n);

/** "1 hoja" / "3 hojas": el número y la palabra que corresponde (las dos formas son claves de `t`). */
export function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${t(n === 1 ? one : many)}`;
}

/** Color de texto legible sobre un fondo `#RRGGBB`: oscuro sobre tonos claros, blanco sobre el resto. */
export function readableOn(background: string): string {
  const hex = /^#?([0-9a-f]{6})$/i.exec(background.trim())?.[1];
  if (!hex) return '#fff';
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#1d1d1f' : '#fff';
}

// ---- color: el acento de la interfaz sale del color de la tapa ---------------------------

type Rgb = [number, number, number];

const parseHex = (hex: string): Rgb | null => {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1];
  return value ? [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as Rgb : null;
};

const toHex = (rgb: Rgb) => `#${rgb.map((n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')).join('')}`;

/** Luminancia relativa (WCAG) de un color `#RRGGBB`: 0 es negro y 1 es blanco. */
export function luminance(hex: string): number {
  const [r, g, b] = (parseHex(hex) ?? [0, 0, 0]).map((n) => {
    const channel = n / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Relación de contraste (WCAG) entre dos colores `#RRGGBB`, de 1 (iguales) a 21 (negro sobre blanco). */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return [0, 0, l];
  const s = delta / (1 - Math.abs(2 * l - 1));
  const h = max === rn ? ((gn - bn) / delta) % 6 : max === gn ? (bn - rn) / delta + 2 : (rn - gn) / delta + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return (l - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [channel(0), channel(8), channel(4)];
}

/**
 * Fondos sobre los que se lee el acento en cada tema: `--surface` y `--paper` de styles.css.
 * Si cambian allá, cambian acá.
 */
const ACCENT_BACKDROPS = {
  light: ['#ffffff', '#fffefa'],
  dark: ['#2c2c2e', '#2a2a2d'],
} as const;

/** Contraste mínimo del acento contra esos fondos; el azul de fábrica da 4,0 en claro y 3,8 en oscuro. */
export const MIN_ACCENT_CONTRAST = 4;

const INK = '#1d1d1f';

export interface Accent {
  /** El color en sí, para interruptores, enlaces, anillos de foco y fondos de acento. */
  accent: string;
  /** El mismo color, muy tenue, para fondos de campos enfocados y de rótulos. */
  soft: string;
  /** Color del texto y de los íconos que van encima del acento: blanco o casi negro. */
  on: string;
}

/**
 * Acento a partir del color de la tapa: conserva el tono y la saturación y mueve solo la
 * luminosidad hasta que se lea sobre los fondos del tema (más oscuro en el claro, más
 * claro en el oscuro). Así una tapa negra en tema oscuro no da un acento invisible ni una
 * tapa clara en tema claro da uno desvaído. El texto encima es blanco, salvo que el negro
 * se lea bastante mejor.
 */
export function accentFor(cover: string, dark: boolean): Accent {
  const rgb = parseHex(cover);
  if (!rgb) return { accent: cover, soft: 'transparent', on: '#fff' };
  const [h, s, l] = rgbToHsl(rgb);
  const backdrops = dark ? ACCENT_BACKDROPS.dark : ACCENT_BACKDROPS.light;
  const readable = (lightness: number) =>
    Math.min(...backdrops.map((bg) => contrast(toHex(hslToRgb(h, s, lightness)), bg))) >= MIN_ACCENT_CONTRAST;

  let lightness = l;
  if (!readable(lightness)) {
    // El contraste crece de forma continua hacia el negro (claro) o el blanco (oscuro): se busca el
    // cambio más chico que alcanza.
    let near = l;
    let far = dark ? 1 : 0;
    for (let i = 0; i < 14; i++) {
      const middle = (near + far) / 2;
      if (readable(middle)) far = middle;
      else near = middle;
    }
    lightness = far;
  }
  const accent = toHex(hslToRgb(h, s, lightness));
  const [r, g, b] = parseHex(accent)!;
  const onWhite = contrast(accent, '#ffffff');
  const onInk = contrast(accent, INK);
  return { accent, soft: `rgba(${r}, ${g}, ${b}, ${dark ? 0.24 : 0.14})`, on: onWhite >= onInk * 0.75 ? '#fff' : INK };
}

/**
 * Título derivado de la primera línea con contenido (hasta 80 caracteres),
 * quitando marcas típicas de markdown (`#`, `-`, `*`, `>`).
 */
export function titleFromContent(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[#\-*> ]+/, '').trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** Título por defecto según el idioma cuando la hoja queda vacía: "Sin título" / "Untitled". */
export const defaultNoteTitle = () => (locale() === 'en' ? 'Untitled' : 'Sin título');

/** Título con el que nace una hoja escrita en Folio a partir de su contenido o por defecto. */
export const noteTitle = (content = '') => titleFromContent(content) || defaultNoteTitle();

/** Nombre de un archivo sin su extensión: lo que se edita como título de la hoja. */
export function stemOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** Extensión de un archivo, con el punto (".txt"), o vacío si no tiene. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot) : '';
}

/** Nombre de la carpeta que contiene el archivo, para mostrar de dónde viene una hoja. */
export function parentFolder(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}
