import { mark } from '../../i18n';
import { EN } from '../../i18n/en';
import type { SettingsTab } from '../Settings';

export interface SearchSettingItem {
  id: string;
  tab: SettingsTab;
  section: string;
  group?: string;
  label: string;
  detail?: string;
  keywords?: string[];
}

export interface MatchedSetting {
  item: SearchSettingItem;
  matchedField: 'label' | 'detail' | 'keyword' | 'section' | 'group';
  matchedKeyword?: string;
}

export interface SearchResultSection {
  tab: SettingsTab;
  tabLabel: string;
  matches: MatchedSetting[];
}

/** Quita acentos y pasa a minúsculas para comparaciones insensibles a diacríticos y mayúsculas. */
export function normalize(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Distancia de edición Damerau-Levenshtein (inserción, borrado, sustitución o transposición adyacente). */
export function editDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return 2;
  const dp: number[][] = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[la][lb];
}

/** Tokeniza texto normalizado en palabras con sus índices [inicio, fin] en el texto original. */
function tokenizeWithRanges(normText: string): { word: string; start: number; end: number }[] {
  const tokens: { word: string; start: number; end: number }[] = [];
  const re = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normText)) !== null) {
    tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/**
 * Comprueba si `term` (normalizado) coincide con `normText`:
 * 1. Substring directo o prefijo de palabra
 * 2. Tolerancia a 1 error tipográfico (fuzzy 1 typo) sobre palabras o prefijos de palabra (cuando term.length >= 3)
 */
export function matchesText(normText: string, term: string): boolean {
  if (!term) return false;
  if (normText.includes(term)) return true;
  if (term.length < 3) return false;

  const tokens = tokenizeWithRanges(normText);
  for (const { word } of tokens) {
    if (word.startsWith(term)) return true;
    if (word.length >= 3 && editDistance(word, term) <= 1) return true;
    if (term.length >= 4 && word.length > term.length) {
      const prefix = word.slice(0, term.length);
      if (editDistance(prefix, term) <= 1) return true;
      const prefixPlus = word.slice(0, term.length + 1);
      if (editDistance(prefixPlus, term) <= 1) return true;
    }
  }
  return false;
}

/**
 * Encuentra rangos [inicio, fin] en `text` que coinciden con `query` (insensible a acentos, mayúsculas y 1 typo).
 * Se devuelven rangos combinados y ordenados.
 */
export function getMatchRanges(text: string, query: string): [number, number][] {
  const normText = normalize(text);
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const ranges: [number, number][] = [];
  const tokens = tokenizeWithRanges(normText);

  for (const term of terms) {
    let foundExact = false;
    let idx = 0;
    while ((idx = normText.indexOf(term, idx)) !== -1) {
      ranges.push([idx, idx + term.length]);
      idx += term.length;
      foundExact = true;
    }
    if (!foundExact && term.length >= 3) {
      for (const tok of tokens) {
        if (tok.word.length >= 3 && editDistance(tok.word, term) <= 1) {
          ranges.push([tok.start, tok.end]);
        } else if (term.length >= 4 && tok.word.length > term.length) {
          const prefix = tok.word.slice(0, term.length);
          if (editDistance(prefix, term) <= 1) {
            ranges.push([tok.start, tok.start + term.length]);
          }
        }
      }
    }
  }

  if (!ranges.length) return [];
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  const merged: [number, number][] = [];
  for (const r of ranges) {
    if (!merged.length || merged[merged.length - 1][1] < r[0]) {
      merged.push(r);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]);
    }
  }
  return merged;
}

/** Índice completo de opciones y ajustes en Folio (todas las secciones y controles). */
export const SETTINGS_SEARCH_INDEX: SearchSettingItem[] = [
  // --- Personalización (look) ---
  {
    id: 'look-language',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Apariencia'),
    label: mark('Idioma'),
    detail: mark('Automático sigue al idioma del sistema: español, o inglés si es otro.'),
    keywords: [
      'idioma',
      'lenguaje',
      'language',
      'locale',
      'traduccion',
      'traducciones',
      'translation',
      'ingles',
      'english',
      'español',
      'spanish',
      'auto',
      'automatico',
      'automatic',
    ],
  },
  {
    id: 'look-theme',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Apariencia'),
    label: mark('Tema'),
    detail: mark('Automático sigue al sistema: claro de día, oscuro de noche.'),
    keywords: [
      'tema',
      'theme',
      'claro',
      'oscuro',
      'dark',
      'light',
      'dark mode',
      'light mode',
      'modo oscuro',
      'modo claro',
      'automatico',
      'automatic',
      'noche',
      'dia',
      'colores',
      'apariencia',
      'appearance',
      'fondo',
    ],
  },
  {
    id: 'look-text-size',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Apariencia'),
    label: mark('Tamaño de la letra'),
    detail: mark('De las hojas del cuaderno; los renglones acompañan.'),
    keywords: [
      'letra',
      'fuente',
      'tamano',
      'texto',
      'font',
      'font size',
      'text size',
      'size',
      'chica',
      'mediana',
      'grande',
      'muy grande',
      'small',
      'medium',
      'large',
      'very large',
      'renglones',
      'tipografia',
      'typography',
    ],
  },
  {
    id: 'look-name',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Nombre'),
    detail: mark('Aparece en la etiqueta de la tapa.'),
    keywords: ['nombre', 'titulo', 'etiqueta', 'tapa', 'portada', 'name', 'notebook name', 'title', 'label', 'mi cuaderno', 'my notebook'],
  },
  {
    id: 'look-size',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Tamaño'),
    detail: mark('Para darle cualquier tamaño a medida, mantené Mayús, arrastrá un borde o una esquina del cuaderno y soltá Mayús.'),
    keywords: [
      'tamano',
      'dimensiones',
      'bolsillo',
      'estandar',
      'pantalla completa',
      'a medida',
      'ventana',
      'size',
      'notebook size',
      'pocket',
      'standard',
      'full screen',
      'custom',
      'resize',
      'ancho',
      'alto',
    ],
  },
  {
    id: 'look-borderless',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Cuaderno sin marco'),
    detail: mark('Elimina el fondo de la ventana para que solo se vea el cuaderno flotando sobre el escritorio.'),
    keywords: [
      'marco',
      'sin marco',
      'borderless',
      'borderless notebook',
      'ventana sin marco',
      'cuaderno sin marco',
      'sin bordes',
      'frameless',
      'borde',
      'bordes',
      'borde de ventana',
      'border',
      'frame',
      'window border',
      'transparente',
      'transparent',
      'solido',
      'solid',
      'inmersivo',
      'immersive',
      'ninguno',
      'none',
    ],
  },
  {
    id: 'look-spread',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Doble hoja'),
    detail: mark('Una nota larga sigue en la hoja de al lado. Si la apagás, se ve de a una hoja, con espiral.'),
    keywords: [
      'doble hoja',
      'dos hojas',
      'espiral',
      'hoja simple',
      'una hoja',
      'spread',
      'two-page spread',
      'single page',
      'spiral',
      'paginas',
      'vistas',
    ],
  },
  {
    id: 'look-tabs',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Solapas de categorías'),
    detail: mark('Asoman arriba del cuaderno y filtran las hojas. Si las ocultás, se filtra desde Buscar y filtrar.'),
    keywords: ['solapas', 'pestanas', 'categorias', 'separadores', 'tabs', 'category tabs', 'dividers', 'filtrar', 'filter'],
  },
  {
    id: 'look-markdown',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Ver los .md con formato'),
    detail: mark('Títulos, listas, tareas y tablas, sobre el rayado. Al escribir se ve el texto plano, que es lo que se guarda.'),
    keywords: [
      'markdown',
      'md',
      'formato',
      'render formatted .md',
      'listas',
      'tareas',
      'tablas',
      'rayado',
      'texto plano',
      'preview',
      'render',
    ],
  },
  {
    id: 'look-hide-header',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Ocultar encabezado'),
    detail: mark('Oculta el título, la fecha y los datos de la hoja para dejar más espacio al texto.'),
    keywords: [
      'ocultar encabezado',
      'encabezado',
      'header',
      'hide header',
      'titulo',
      'fecha',
      'datos',
      'metadata',
      'espacio',
    ],
  },
  {
    id: 'look-center-title',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Centrar título de la hoja'),
    detail: mark('Ubica el título en el centro de la hoja en lugar de alinearlo a la izquierda.'),
    keywords: [
      'centrar titulo',
      'centrar titulo de la hoja',
      'center title',
      'center sheet title',
      'alineacion',
      'alignment',
      'titulo centrado',
      'medio',
      'centro',
    ],
  },
  {
    id: 'look-cover-color',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Tapa'),
    label: mark('Color de la tapa'),
    detail: mark('Personalizado'),
    keywords: [
      'color',
      'cover color',
      'tapa',
      'portada',
      'cover',
      'grafito',
      'graphite',
      'verde botella',
      'bottle green',
      'azul marino',
      'navy blue',
      'bordo',
      'burgundy',
      'mostaza',
      'mustard',
      'kraft',
      'negro',
      'black',
      'personalizado',
      'custom',
      'swatches',
      'paleta',
    ],
  },
  {
    id: 'look-cover-style',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Tapa'),
    label: mark('Estilo de la tapa'),
    detail: mark('Lisa: solo el color.'),
    keywords: [
      'estilo',
      'estilo de la tapa',
      'cover style',
      'tapa',
      'lisa',
      'plain',
      'manchas',
      'speckled',
      'con tira',
      'tira elastica',
      'strap',
      'con lomo',
      'lomo',
      'cloth spine',
      'cuero',
      'leather',
      'estilos',
    ],
  },
  {
    id: 'look-stickers',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Tapa'),
    label: mark('Imágenes de la tapa'),
    detail: mark('Con el cuaderno cerrado, elegí «Pegar una imagen…» en el menú de la tapa o usá {key} + V. Para la contratapa, dalo vuelta antes.'),
    keywords: [
      'stickers',
      'imagenes',
      'imagenes de la tapa',
      'cover images',
      'fotos',
      'calcomanias',
      'pegatinas',
      'tapa',
      'contratapa',
      'back cover',
    ],
  },
  {
    id: 'look-autostart',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('General'),
    label: mark('Abrir Folio al iniciar la PC'),
    detail: mark('Arranca en la bandeja, junto al reloj, sin abrir la ventana.'),
    keywords: [
      'inicio',
      'iniciar',
      'arranque',
      'autostart',
      'launch folio on pc startup',
      'pc',
      'windows',
      'bandeja',
      'tray',
      'system tray',
      'reloj',
      'boot',
      'startup',
      'segundo plano',
    ],
  },
  {
    id: 'look-sounds',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('General'),
    label: mark('Sonidos'),
    detail: mark('Al pasar de hoja, escribir y borrar.'),
    keywords: ['sonidos', 'sounds', 'audio', 'efectos', 'pasar hoja', 'escribir', 'borrar', 'volumen', 'sound', 'ruido'],
  },
  {
    id: 'look-tour',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('General'),
    label: mark('Recorrido inicial'),
    detail: mark('Una vuelta corta por lo que hace cada cosa: pasar de hoja, escribir, buscar, las solapas y los atajos.'),
    keywords: ['recorrido', 'recorrido inicial', 'initial tour', 'tutorial', 'guia', 'tour', 'ayuda', 'aprender', 'introduccion'],
  },

  // --- Atajos (shortcuts) ---
  {
    id: 'shortcuts-reset-all',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Atajos'),
    label: mark('Atajos de teclado'),
    detail: mark('Cambialos a tu gusto. Los que valen en la hoja suelta y desde cualquier programa están más abajo.'),
    keywords: ['atajos', 'atajos de teclado', 'keyboard shortcuts', 'shortcuts', 'restablecer todos', 'reset all', 'teclado', 'hotkeys', 'keybindings'],
  },
  {
    id: 'shortcuts-nav',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Cuaderno'),
    label: mark('Página siguiente'),
    detail: mark('Página anterior'),
    keywords: ['atajos', 'pasar pagina', 'siguiente', 'anterior', 'next page', 'previous page', 'flechas', 'arrows', 'pagedown', 'pageup', 'avanzar', 'retroceder', 'teclado', 'keys'],
  },
  {
    id: 'shortcuts-sheet-nav',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Cuaderno'),
    label: mark('Hoja siguiente'),
    detail: mark('Hoja anterior'),
    keywords: ['hoja siguiente', 'hoja anterior', 'next sheet', 'previous sheet', 'alt+arrowright', 'alt+arrowleft', 'pasar hoja'],
  },
  {
    id: 'shortcuts-first-last',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Cuaderno'),
    label: mark('Primera hoja'),
    detail: mark('Última hoja'),
    keywords: ['primera hoja', 'ultima hoja', 'first page', 'last page', 'home', 'end', 'inicio', 'fin', 'saltar', 'primer', 'ultimo'],
  },
  {
    id: 'shortcuts-write',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Cuaderno'),
    label: mark('Escribir en la hoja'),
    detail: mark('Enter o F2 para comenzar a escribir en la hoja abierta.'),
    keywords: ['escribir', 'write on page', 'editar', 'edit', 'enter', 'f2', 'comenzar', 'modificar'],
  },
  {
    id: 'shortcuts-new',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Cuaderno'),
    label: mark('Hoja nueva'),
    detail: mark('Ctrl+N para agregar una hoja nueva en blanco.'),
    keywords: ['hoja nueva', 'new page', 'new sheet', 'crear', 'nueva', 'ctrl+n', 'blanco', 'nota nueva'],
  },
  {
    id: 'shortcuts-search',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Cuaderno'),
    label: mark('Buscar y filtrar'),
    detail: mark('Ctrl+F para buscar texto en todas las hojas o filtrar por separador.'),
    keywords: ['buscar', 'filtrar', 'buscar y filtrar', 'search and filter', 'ctrl+f', 'encontrar', 'search', 'filter', 'lupa'],
  },
  {
    id: 'shortcuts-flip',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Cuaderno'),
    label: mark('Dar vuelta el cuaderno'),
    detail: mark('Solo con el cuaderno cerrado.'),
    keywords: ['dar vuelta', 'flip the notebook', 'contratapa', 'cerrado', 'volver de la papelera'],
  },
  {
    id: 'shortcuts-writing',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Escribiendo'),
    label: mark('Guardar y terminar de escribir'),
    detail: mark('Alterna entre el editor y la vista con formato de la nota.'),
    keywords: [
      'escribiendo',
      'writing',
      'guardar y terminar',
      'save and stop writing',
      'guardar y seguir',
      'save and keep writing',
      'previsualizar markdown',
      'preview markdown',
      'ctrl+s',
      'ctrl+enter',
      'ctrl+p',
      'tabulacion',
      'insert a tab',
    ],
  },
  {
    id: 'shortcuts-window-size',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Ventana y tamaño'),
    label: mark('Una o dos hojas'),
    detail: mark('Folio sigue en la bandeja, junto al reloj.'),
    keywords: [
      'ventana y tamano',
      'window and size',
      'una o dos hojas',
      'one or two pages',
      'cuaderno de bolsillo',
      'pocket notebook',
      'cuaderno estandar',
      'standard notebook',
      'pantalla completa',
      'full screen notebook',
      'agrandar',
      'achicar',
      'letra mas grande',
      'larger text',
      'letra mas chica',
      'smaller text',
      'cerrar la ventana',
      'close window',
      'ctrl+d',
      'ctrl+w',
    ],
  },
  {
    id: 'shortcuts-detached-sheet',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Hoja suelta'),
    label: mark('Guardar y cerrar la hoja suelta'),
    detail: mark('Valen en la hoja suelta, la ventana que se abre con el atajo de «Nueva hoja suelta».'),
    keywords: ['hoja suelta', 'detached sheet', 'guardar y cerrar la hoja suelta', 'save and close detached sheet'],
  },
  {
    id: 'shortcuts-global-open',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Desde cualquier programa'),
    label: mark('Abrir el cuaderno'),
    detail: mark('Ctrl+Alt+B: atajo global para traer Folio al frente desde cualquier programa.'),
    keywords: ['atajo global', 'global shortcuts', 'abrir cuaderno', 'open notebook', 'ctrl+alt+b', 'traer al frente', 'global shortcut', 'abrir folio'],
  },
  {
    id: 'shortcuts-global-capture',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Desde cualquier programa'),
    label: mark('Nueva hoja suelta'),
    detail: mark('Ctrl+Alt+N: atajo global para abrir la captura rápida.'),
    keywords: ['hoja suelta', 'nueva hoja suelta', 'new detached sheet', 'captura rapida', 'ctrl+alt+n', 'nota rapida', 'quick capture'],
  },
  {
    id: 'shortcuts-global-send',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Desde cualquier programa'),
    label: mark('Enviar lo seleccionado a Folio'),
    detail: mark('Selecciona un texto en cualquier programa, aprietalo y Folio lo guarda con su origen.'),
    keywords: ['enviar seleccionado', 'send selection to folio', 'ctrl+alt+x', 'capturar texto', 'copiar a folio', 'recortes', 'clippings', 'origen'],
  },
  {
    id: 'shortcuts-send-target',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Desde cualquier programa'),
    label: mark('Al enviar lo seleccionado'),
    detail: mark('Qué hace Folio con el texto cuando apretás el atajo de enviar.'),
    keywords: [
      'al enviar lo seleccionado',
      'when sending selection',
      'hoja unica',
      'single sheet',
      'por dia',
      'daily',
      'por semana',
      'weekly',
      'por mes',
      'monthly',
      'recortes.txt',
      'incluir origen en los recortes',
      'include source in clippings',
    ],
  },
  {
    id: 'shortcuts-mouse',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Con el mouse'),
    label: mark('Pasar página'),
    detail: mark('Estos gestos no se cambian.'),
    keywords: ['con el mouse', 'mouse gestures', 'doble clic', 'double click', 'rueda del mouse', 'mouse wheel', 'gestos'],
  },

  // --- Carpetas (folders) ---
  {
    id: 'folders-roots',
    tab: 'folders',
    section: mark('Carpetas'),
    group: mark('Carpetas'),
    label: mark('Carpetas que Folio recorre'),
    detail: mark('Folio entra en todas las subcarpetas, salvo las excluidas. Los archivos no se mueven, y solo cambian si escribís en ellos desde el cuaderno.'),
    keywords: [
      'carpetas',
      'folders',
      'folders folio scans',
      'directorios',
      'directories',
      'agregar carpeta',
      'add folder',
      'quitar carpeta',
      'remove folder',
      'rutas',
      'paths',
      'disco',
      'indexar',
      'donde aparecieron hojas',
      'where sheets turned up',
    ],
  },
  {
    id: 'folders-git',
    tab: 'folders',
    section: mark('Carpetas'),
    group: mark('Carpetas'),
    label: mark('Ignorar repositorios git'),
    detail: mark('Carpetas de proyectos con control de versiones.'),
    keywords: ['git', 'repositorios', 'repositories', 'ignore git repositories', 'control de versiones', 'version control', 'ignorar git', '.git', 'repo'],
  },
  {
    id: 'folders-dot',
    tab: 'folders',
    section: mark('Carpetas'),
    group: mark('Carpetas'),
    label: mark('Ignorar carpetas ocultas'),
    detail: mark('Las que empiezan con punto, como .codex o .vscode.'),
    keywords: ['carpetas ocultas', 'ignore hidden folders', 'hidden folders', 'punto', 'dot dirs', '.codex', '.vscode', 'ocultas', 'hidden'],
  },
  {
    id: 'folders-max-size',
    tab: 'folders',
    section: mark('Carpetas'),
    group: mark('Carpetas'),
    label: mark('Tamaño máximo de archivo'),
    detail: mark('Los archivos más grandes casi nunca son notas: suelen ser registros o exportaciones.'),
    keywords: ['tamano maximo', 'maximum file size', 'limite de archivo', 'kb', 'mb', '256 kb', '1 mb', '4 mb', 'peso', 'archivos grandes'],
  },
  {
    id: 'folders-format',
    tab: 'folders',
    section: mark('Carpetas'),
    group: mark('Carpetas'),
    label: mark('Formato de notas nuevas'),
    detail: mark('Guardar las notas creadas en Folio como archivos .txt o .md con formato Markdown.'),
    keywords: ['formato de notas', 'new notes format', 'txt', 'md', '.txt', '.md', 'markdown', 'extension', 'texto plano'],
  },
  {
    id: 'folders-rescan',
    tab: 'folders',
    section: mark('Carpetas'),
    group: mark('Carpetas'),
    label: mark('Volver a escanear'),
    detail: mark('Escaneando…'),
    keywords: ['escanear', 'volver a escanear', 'scan again', 'scan', 're-escanear', 'rescan', 'sincronizar', 'actualizar'],
  },

  // --- Exclusiones (bans) ---
  {
    id: 'bans-folder',
    tab: 'bans',
    section: mark('Exclusiones'),
    group: mark('Exclusiones'),
    label: mark('Excluir una carpeta'),
    detail: mark('Elegila en el explorador: Folio deja de recorrerla, con todo lo que contiene.'),
    keywords: [
      'exclusiones',
      'exclusions',
      'excluir carpeta',
      'exclude a folder',
      'elegir carpeta',
      'choose folder',
      'ban folder',
      'omitir',
      'ignorar carpeta',
      'carpetas concretas',
      'specific folders',
    ],
  },
  {
    id: 'bans-pattern',
    tab: 'bans',
    section: mark('Exclusiones'),
    group: mark('Exclusiones'),
    label: mark('Excluir por nombre'),
    detail: mark('Para lo que se repite en muchos lugares, como node_modules o los README.'),
    keywords: [
      'excluir por nombre',
      'exclude by name',
      'carpetas por nombre',
      'folders by name',
      'archivos por nombre',
      'files by name',
      'comodin',
      'patron',
      'pattern',
      'node_modules',
      'readme',
      'wildcard',
      'blacklist',
    ],
  },

  // --- Categorías (categories) ---
  {
    id: 'categories-manage',
    tab: 'categories',
    section: mark('Categorías'),
    group: mark('Categorías'),
    label: mark('Categorías'),
    detail: mark('Tocá el círculo de color de una categoría para cambiarlo: se aplica al elegirlo. La IA que clasifica elige entre estas categorías; la descripción le indica qué va en cada una. Eliminar una categoría pide confirmación y deja sus hojas sin categoría: las hojas no se borran.'),
    keywords: [
      'categorias',
      'categories',
      'nueva categoria',
      'new category',
      'color de la categoria',
      'category color',
      'separadores',
      'solapas',
      'colores',
      'etiquetas',
      'tags',
      'paleta',
      'recortes',
      'clippings',
    ],
  },
  {
    id: 'categories-suggestions',
    tab: 'categories',
    section: mark('Categorías'),
    group: mark('Categorías'),
    label: mark('Sugerir categorías a partir de mis notas'),
    detail: mark('Se analizan en esta PC; no se envía nada.'),
    keywords: [
      'sugerencias',
      'sugerir categorias',
      'suggest categories',
      'suggest categories from my notes',
      'sugerir con ia',
      'suggest with ai',
      'ia',
      'inteligencia artificial',
      'sparkles',
    ],
  },

  // --- Clasificador (jev) ---
  {
    id: 'jev-provider',
    tab: 'jev',
    section: mark('Clasificador'),
    group: mark('IA que clasifica'),
    label: mark('IA que clasifica'),
    detail: mark('Con {provider} activo, el texto de cada hoja se envía a {host} ({maker}) para elegir su categoría. {never}'),
    keywords: [
      'clasificador',
      'classifier',
      'ia que clasifica',
      'ai that classifies',
      'jev',
      'typesafe',
      'api.typesafe.ai',
      'typesafe_api_key',
      'ia',
      'ai',
      'proveedor',
      'provider',
      'openai',
      'gpt',
      'gpt-6-luna',
      'anthropic',
      'claude',
      'claude-haiku',
      'claude-sonnet',
      'gemini',
      'google',
      'ollama',
      'llama',
      'localhost:11434',
      'local',
      'llm',
      'modelo',
      'model',
    ],
  },
  {
    id: 'jev-setup',
    tab: 'jev',
    section: mark('Clasificador'),
    group: mark('Clasificador'),
    label: mark('Clave de API'),
    detail: mark('Se guarda en el llavero del sistema, no en la base de Folio. También puede venir de la variable de entorno {envVar}.'),
    keywords: [
      'api key',
      'clave de api',
      'clave de la api',
      'clave',
      'token',
      'llavero',
      'keychain',
      'modelo',
      'model',
      'direccion',
      'address',
      'probar',
      'test',
      'configurar ia',
      'credenciales',
      'jev',
      'typesafe',
      'anthropic_api_key',
      'openai_api_key',
      'gemini_api_key',
    ],
  },
  {
    id: 'jev-auto',
    tab: 'jev',
    section: mark('Clasificador'),
    group: mark('Clasificación automática'),
    label: mark('Clasificar automáticamente'),
    detail: mark('Las notas nuevas o modificadas se clasifican solas en segundo plano.'),
    keywords: [
      'clasificacion automatica',
      'automatic classification',
      'classify automatically',
      'confianza minima',
      'minimum confidence',
      'umbral',
      'threshold',
      'revisar hojas ya clasificadas',
      'review classified sheets',
      'consultas',
      'queries',
      'hojas pendientes',
      'clasificar ahora',
      'classify now',
      'background',
      'auto clasificar',
      'organizar',
      'jev',
    ],
  },
  {
    id: 'jev-reclassify',
    tab: 'jev',
    section: mark('Clasificador'),
    group: mark('Clasificador'),
    label: mark('Volver a clasificar todo'),
    detail: mark('Consulta de nuevo a {provider} por todas las hojas, salvo las que pusiste en una categoría a mano. Cuesta una consulta por hoja.'),
    keywords: ['volver a clasificar', 'volver a clasificar todo', 'classify everything again', 'classify again', 'reclasificar todo', 'recheck', 'procesar notas', 'jev'],
  },

  // --- Integraciones (integrations) ---
  {
    id: 'integrations-assistants',
    tab: 'integrations',
    section: mark('Integraciones'),
    group: mark('Asistentes de IA'),
    label: mark('Asistentes de IA'),
    detail: mark('Claude Code, Codex y Gemini CLI pueden anotarte cosas en Folio cuando se lo pidas («anotá esto», «guardalo en Folio»). Las instrucciones les explican dónde guardar las notas y con qué formato, para que en el cuaderno se lean con título, categoría y etiquetas.'),
    keywords: [
      'integraciones',
      'integrations',
      'asistentes de ia',
      'ai assistants',
      'carpeta de notas',
      'notes folder',
      'conectar',
      'connect',
      'claude',
      'claude code',
      'codex',
      'gemini',
      'gemini cli',
      'jev',
      'typesafe',
      'cursor',
      'windsurf',
      'copilot',
      'cline',
      'antigravity',
      'mcp',
      'skills',
      'skill.md',
      'agents.md',
      'gemini.md',
      'agentes',
      'agents',
      'ai tools',
      'instrucciones',
      'instructions',
    ],
  },
  {
    id: 'integrations-tools',
    tab: 'integrations',
    section: mark('Integraciones'),
    group: mark('Herramientas'),
    label: mark('Herramientas'),
    detail: mark('«Copiar instrucciones» sirve para pegarlas a mano en otro lugar, o en otra herramienta.'),
    keywords: [
      'herramientas',
      'tools',
      'integraciones',
      'integrations',
      'claude code',
      'codex',
      'gemini cli',
      'jev',
      'copiar instrucciones',
      'copy instructions',
      'instalar',
      'install',
      'actualizar',
      'update',
      'quitar',
      'remove',
      'skill',
      'folio-notes',
      '.claude',
      '.codex',
      '.gemini',
    ],
  },

  // --- Versiones (versions) ---
  {
    id: 'versions-keep',
    tab: 'versions',
    section: mark('Versiones'),
    group: mark('Versiones'),
    label: mark('Versiones anteriores a conservar'),
    detail: mark('Cuando una hoja cambia, la anterior pasa al historial. Se guarda una versión por sesión de edición, no una por cada guardado.'),
    keywords: ['versiones', 'versions', 'previous versions to keep', 'historial', 'history', 'copias', 'backup', 'conservar', 'recuperar'],
  },
  {
    id: 'versions-gap',
    tab: 'versions',
    section: mark('Versiones'),
    group: mark('Versiones'),
    label: mark('Fin de la sesión de edición'),
    detail: mark('Minutos sin cambios para dar una versión por terminada.'),
    keywords: ['sesion de edicion', 'end of an editing session', 'minutos', 'minutes without changes', 'inactividad', 'gap', 'tiempo'],
  },

  // --- Datos (data) ---
  {
    id: 'data-path',
    tab: 'data',
    section: mark('Datos'),
    group: mark('Datos'),
    label: mark('Dónde guarda Folio sus datos'),
    detail: mark('En ese archivo están las hojas indexadas, sus versiones, las categorías y estos ajustes. Si lo borrás, Folio vuelve a empezar de cero; tus notas originales no se tocan.'),
    keywords: [
      'datos',
      'data',
      'where folio keeps its data',
      'base de datos',
      'database',
      'sqlite',
      'mostrar en la carpeta',
      'show in folder',
      'archivo db',
      'almacenamiento',
      'storage',
      'tus notas originales',
      'your original notes',
    ],
  },
  {
    id: 'data-secret-key',
    tab: 'data',
    section: mark('Datos'),
    group: mark('Cuaderno secreto'),
    label: mark('Cuaderno secreto'),
    detail: mark('Las hojas secretas se guardan cifradas en la base de datos con XChaCha20-Poly1305. La clave vive en el Administrador de credenciales de Windows. Con la clave de respaldo podés recuperarlas en otro equipo o tras reinstalar el sistema.'),
    keywords: [
      'cuaderno secreto',
      'secret-book',
      'secret book',
      'clave secreta',
      'clave de respaldo',
      'backup key',
      'copiar clave',
      'copy key',
      'restaurar clave',
      'restore key',
      'secret key',
      'cifrado',
      'encryption',
      'xchacha20',
      'encriptacion',
      'password',
      'proteger',
    ],
  },
  {
    id: 'data-missing',
    tab: 'data',
    section: mark('Datos'),
    group: mark('Originales que desaparecieron'),
    label: mark('Originales que desaparecieron'),
    detail: mark('Cuando un archivo se borra o una pestaña del Bloc de notas se cierra sin guardar, la hoja queda en el cuaderno con su último contenido. Si el archivo solo se movió o cambió de nombre, Folio lo reconoce y no aparece acá.'),
    keywords: [
      'originales que desaparecieron',
      'originals that went missing',
      'hojas desaparecidas',
      'archivos faltantes',
      'missing sheets',
      'bloc de notas',
      'notepad',
      'sticky notes',
      'borrados',
      'limpiar',
    ],
  },

  // --- Acerca de (about) ---
  {
    id: 'about-version',
    tab: 'about',
    section: mark('Acerca de'),
    group: mark('Acerca de'),
    label: mark('Acerca de'),
    detail: mark('Un cuaderno que reúne tus notas, vengan de donde vengan.'),
    keywords: ['acerca de', 'about', 'version', 'folio', 'autor', 'creado por', 'created by', 'joaquin hernandez', 'informacion'],
  },
  {
    id: 'about-updates',
    tab: 'about',
    section: mark('Acerca de'),
    group: mark('Actualizaciones'),
    label: mark('Buscar actualizaciones'),
    detail: mark('Comprueba si hay una versión más reciente de Folio en GitHub.'),
    keywords: [
      'actualizaciones',
      'updates',
      'actualizar',
      'buscar actualizaciones',
      'check for updates',
      'buscar ahora',
      'check now',
      'nueva version',
      'github',
      'update',
    ],
  },
  {
    id: 'about-license',
    tab: 'about',
    section: mark('Acerca de'),
    group: mark('Licencia'),
    label: mark('Licencia'),
    detail: mark('Licencia MIT con la condición Commons Clause: el código está abierto, pero no se puede vender.'),
    keywords: [
      'licencia',
      'license',
      'mit',
      'commons clause',
      'hecho con',
      'built with',
      'tauri',
      'react',
      'sqlite',
      'lucide',
      'inter',
      'open source',
      'tecnologias',
    ],
  },
];

/** Traduce al inglés (o devuelve la cadena original si no está en EN). */
function toEn(key: string): string {
  return key && Object.hasOwn(EN, key) ? EN[key] : key;
}

/**
 * Busca en el índice y devuelve los resultados organizados por sección.
 * Se busca en títulos de pestaña, grupos, etiquetas, descripciones y palabras clave,
 * siempre en español E inglés sin importar el idioma activo de la interfaz.
 * La búsqueda es insensible a mayúsculas, acentos, admite prefijos y tolera 1 typo.
 */
export function searchSettings(
  query: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): SearchResultSection[] {
  const q = normalize(query.trim());
  if (!q) return [];

  const terms = q.split(/\s+/).filter(Boolean);
  const byTab = new Map<SettingsTab, MatchedSetting[]>();

  for (const item of SETTINGS_SEARCH_INDEX) {
    // Textos tanto en español (clave original) como en inglés (EN) y en el idioma activo (t)
    const sectionTexts = [item.section, toEn(item.section), t(item.section)].map(normalize);
    const groupTexts = item.group ? [item.group, toEn(item.group), t(item.group)].map(normalize) : [];
    const labelTexts = [item.label, toEn(item.label), t(item.label)].map(normalize);
    const detailTexts = item.detail ? [item.detail, toEn(item.detail), t(item.detail)].map(normalize) : [];

    // Verificar si todos los términos de la consulta coinciden con algún campo del item
    const matchTerm = (term: string) => {
      if (labelTexts.some((txt) => matchesText(txt, term))) return { field: 'label' as const };
      if (detailTexts.some((txt) => matchesText(txt, term))) return { field: 'detail' as const };
      if (sectionTexts.some((txt) => matchesText(txt, term))) return { field: 'section' as const };
      if (groupTexts.some((txt) => matchesText(txt, term))) return { field: 'group' as const };
      if (item.keywords) {
        for (const kw of item.keywords) {
          if (matchesText(normalize(kw), term)) {
            return { field: 'keyword' as const, keyword: kw };
          }
        }
      }
      return null;
    };

    let allMatch = true;
    let primaryMatch: { field: 'label' | 'detail' | 'keyword' | 'section' | 'group'; keyword?: string } | null = null;

    for (const term of terms) {
      const m = matchTerm(term);
      if (!m) {
        allMatch = false;
        break;
      }
      if (!primaryMatch) primaryMatch = m;
    }

    if (allMatch && primaryMatch) {
      const list = byTab.get(item.tab) ?? [];
      list.push({
        item,
        matchedField: primaryMatch.field,
        matchedKeyword: primaryMatch.keyword,
      });
      byTab.set(item.tab, list);
    }
  }

  // Ordenar según el orden de pestañas estándar
  const result: SearchResultSection[] = [];
  const TAB_ORDER: SettingsTab[] = [
    'look',
    'shortcuts',
    'folders',
    'bans',
    'categories',
    'jev',
    'integrations',
    'versions',
    'data',
    'about',
  ];

  for (const tab of TAB_ORDER) {
    const matches = byTab.get(tab);
    if (matches && matches.length > 0) {
      result.push({
        tab,
        tabLabel: t(matches[0].item.section),
        matches,
      });
    }
  }

  return result;
}
