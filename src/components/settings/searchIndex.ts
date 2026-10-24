import { mark } from '../../i18n';
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

/**
 * Encuentra rangos [inicio, fin] en `text` que coinciden con `query` (insensible a acentos y mayúsculas).
 * Se devuelven rangos combinados y ordenados.
 */
export function getMatchRanges(text: string, query: string): [number, number][] {
  const normText = normalize(text);
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const ranges: [number, number][] = [];
  for (const term of terms) {
    let idx = 0;
    while ((idx = normText.indexOf(term, idx)) !== -1) {
      ranges.push([idx, idx + term.length]);
      idx += term.length;
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

/** Índice completo de opciones y ajustes en Folio. */
export const SETTINGS_SEARCH_INDEX: SearchSettingItem[] = [
  // --- Personalización (look) ---
  {
    id: 'look-language',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Apariencia'),
    label: mark('Idioma'),
    detail: mark('Automático sigue al idioma del sistema: español, o inglés si es otro.'),
    keywords: ['idioma', 'lenguaje', 'language', 'traduccion', 'traducciones', 'ingles', 'english', 'español', 'spanish'],
  },
  {
    id: 'look-theme',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Apariencia'),
    label: mark('Tema'),
    detail: mark('Automático sigue al sistema: claro de día, oscuro de noche.'),
    keywords: ['tema', 'theme', 'claro', 'oscuro', 'dark', 'light', 'automatico', 'modo', 'colores', 'apariencia', 'fondo'],
  },
  {
    id: 'look-text-size',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Apariencia'),
    label: mark('Tamaño de la letra'),
    detail: mark('De las hojas del cuaderno; los renglones acompañan.'),
    keywords: ['letra', 'fuente', 'tamano', 'texto', 'font', 'size', 'chica', 'mediana', 'grande', 'muy grande', 'renglones'],
  },
  {
    id: 'look-name',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Nombre'),
    detail: mark('Aparece en la etiqueta de la tapa.'),
    keywords: ['nombre', 'titulo', 'etiqueta', 'tapa', 'portada', 'name', 'title', 'mi cuaderno'],
  },
  {
    id: 'look-size',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Tamaño'),
    detail: mark('Para darle cualquier tamaño a medida, mantené Mayús, arrastrá un borde o una esquina del cuaderno y soltá Mayús.'),
    keywords: ['tamano', 'dimensiones', 'bolsillo', 'estandar', 'pantalla completa', 'a medida', 'ventana', 'size', 'ancho', 'alto'],
  },
  {
    id: 'look-borderless',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Cuaderno sin marco'),
    detail: mark('Quita el marco exterior y la barra de título de la ventana para una apariencia limpia (borderless).'),
    keywords: [
      'marco',
      'sin marco',
      'borderless',
      'ventana sin marco',
      'cuaderno sin marco',
      'sin bordes',
      'frameless',
      'borde',
      'bordes',
      'frame',
      'window border',
    ],
  },
  {
    id: 'look-spread',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Doble hoja'),
    detail: mark('Una nota larga sigue en la hoja de al lado. Si la apagás, se ve de a una hoja, con espiral.'),
    keywords: ['doble hoja', 'dos hojas', 'espiral', 'hoja simple', 'una hoja', 'spread', 'paginas', 'vistas'],
  },
  {
    id: 'look-tabs',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Solapas de categorías'),
    detail: mark('Asoman arriba del cuaderno y filtran las hojas. Si las ocultás, se filtra desde Buscar y filtrar.'),
    keywords: ['solapas', 'pestanas', 'categorias', 'separadores', 'tabs', 'filtrar'],
  },
  {
    id: 'look-markdown',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Cuaderno'),
    label: mark('Ver los .md con formato'),
    detail: mark('Títulos, listas, tareas y tablas, sobre el rayado. Al escribir se ve el texto plano, que es lo que se guarda.'),
    keywords: ['markdown', 'md', 'formato', 'listas', 'tareas', 'tablas', 'rayado', 'texto plano', 'preview', 'render'],
  },
  {
    id: 'look-cover-color',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Tapa'),
    label: mark('Color de la tapa'),
    detail: mark('Personalizado'),
    keywords: ['color', 'tapa', 'portada', 'grafito', 'verde', 'azul', 'bordo', 'mostaza', 'kraft', 'negro', 'personalizado', 'swatches', 'paleta'],
  },
  {
    id: 'look-cover-style',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Tapa'),
    label: mark('Lisa'),
    detail: mark('Lisa: solo el color.'),
    keywords: ['estilo', 'tapa', 'lisa', 'manchas', 'tira elastica', 'lomo', 'cuero', 'estilos'],
  },
  {
    id: 'look-stickers',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('Tapa'),
    label: mark('Tapa'),
    detail: mark('la tapa'),
    keywords: ['stickers', 'imagenes', 'fotos', 'calcomanias', 'pegatinas', 'tapa', 'contratapa'],
  },
  {
    id: 'look-autostart',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('General'),
    label: mark('Abrir Folio al iniciar la PC'),
    detail: mark('Arranca en la bandeja, junto al reloj, sin abrir la ventana.'),
    keywords: ['inicio', 'iniciar', 'arranque', 'autostart', 'pc', 'windows', 'bandeja', 'tray', 'reloj', 'boot', 'startup', 'segundo plano'],
  },
  {
    id: 'look-sounds',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('General'),
    label: mark('Sonidos'),
    detail: mark('Al pasar de hoja, escribir y borrar.'),
    keywords: ['sonidos', 'audio', 'efectos', 'pasar hoja', 'escribir', 'borrar', 'volumen', 'sound', 'ruido'],
  },
  {
    id: 'look-tour',
    tab: 'look',
    section: mark('Personalización'),
    group: mark('General'),
    label: mark('Recorrido inicial'),
    detail: mark('Una vuelta corta por lo que hace cada cosa: pasar de hoja, escribir, buscar, las solapas y los atajos.'),
    keywords: ['recorrido', 'tutorial', 'guia', 'tour', 'ayuda', 'aprender', 'introduccion'],
  },

  // --- Atajos (shortcuts) ---
  {
    id: 'shortcuts-nav',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Cuaderno'),
    label: mark('Página siguiente'),
    detail: mark('Página anterior'),
    keywords: ['atajos', 'pasar pagina', 'siguiente', 'anterior', 'flechas', 'avanzar', 'retroceder', 'teclado', 'keys'],
  },
  {
    id: 'shortcuts-first-last',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Cuaderno'),
    label: mark('Primera hoja'),
    detail: mark('Última hoja'),
    keywords: ['primera hoja', 'ultima hoja', 'inicio', 'fin', 'saltar', 'primer', 'ultimo'],
  },
  {
    id: 'shortcuts-write',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Cuaderno'),
    label: mark('Escribir en la hoja'),
    detail: mark('Enter o F2 para comenzar a escribir en la hoja abierta.'),
    keywords: ['escribir', 'editar', 'enter', 'f2', 'comenzar', 'modificar'],
  },
  {
    id: 'shortcuts-new',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Cuaderno'),
    label: mark('Hoja nueva'),
    detail: mark('Ctrl+N para agregar una hoja nueva en blanco.'),
    keywords: ['hoja nueva', 'crear', 'nueva', 'ctrl+n', 'blanco', 'nota nueva'],
  },
  {
    id: 'shortcuts-search',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Cuaderno'),
    label: mark('Buscar y filtrar'),
    detail: mark('Ctrl+F para buscar texto en todas las hojas o filtrar por separador.'),
    keywords: ['buscar', 'filtrar', 'ctrl+f', 'encontrar', 'search', 'lupa'],
  },
  {
    id: 'shortcuts-global-open',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Atajos'),
    label: mark('Abrir el cuaderno'),
    detail: mark('Ctrl+Alt+B: atajo global para traer Folio al frente desde cualquier programa.'),
    keywords: ['atajo global', 'abrir cuaderno', 'ctrl+alt+b', 'traer al frente', 'global shortcut', 'abrir folio'],
  },
  {
    id: 'shortcuts-global-capture',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Atajos'),
    label: mark('Nueva hoja suelta'),
    detail: mark('Ctrl+Alt+N: atajo global para abrir la captura rápida.'),
    keywords: ['hoja suelta', 'captura rapida', 'ctrl+alt+n', 'nota rapida', 'quick capture'],
  },
  {
    id: 'shortcuts-global-send',
    tab: 'shortcuts',
    section: mark('Atajos'),
    group: mark('Atajos'),
    label: mark('Enviar lo seleccionado a Folio'),
    detail: mark('Selecciona un texto en cualquier programa, aprietalo y Folio lo guarda con su origen.'),
    keywords: ['enviar seleccionado', 'ctrl+alt+x', 'capturar texto', 'copiar a folio', 'origen'],
  },

  // --- Carpetas (folders) ---
  {
    id: 'folders-roots',
    tab: 'folders',
    section: mark('Carpetas'),
    group: mark('Carpetas'),
    label: mark('Carpetas que Folio recorre'),
    detail: mark('Folio entra en todas las subcarpetas, salvo las excluidas. Los archivos no se mueven, y solo cambian si escribís en ellos desde el cuaderno.'),
    keywords: ['carpetas', 'folders', 'directorios', 'agregar carpeta', 'quitar carpeta', 'rutas', 'disco', 'indexar'],
  },
  {
    id: 'folders-git',
    tab: 'folders',
    section: mark('Carpetas'),
    group: mark('Carpetas'),
    label: mark('Ignorar repositorios git'),
    detail: mark('Carpetas de proyectos con control de versiones.'),
    keywords: ['git', 'repositorios', 'control de versiones', 'ignorar git', '.git', 'repo'],
  },
  {
    id: 'folders-dot',
    tab: 'folders',
    section: mark('Carpetas'),
    group: mark('Carpetas'),
    label: mark('Ignorar carpetas ocultas'),
    detail: mark('Las que empiezan con punto, como .codex o .vscode.'),
    keywords: ['carpetas ocultas', 'punto', 'dot dirs', '.vscode', 'ocultas', 'hidden'],
  },
  {
    id: 'folders-max-size',
    tab: 'folders',
    section: mark('Carpetas'),
    group: mark('Carpetas'),
    label: mark('Tamaño máximo de archivo'),
    detail: mark('Los archivos más grandes casi nunca son notas: suelen ser registros o exportaciones.'),
    keywords: ['tamano maximo', 'limite de archivo', 'kb', 'mb', 'peso', 'archivos grandes'],
  },
  {
    id: 'folders-format',
    tab: 'folders',
    section: mark('Carpetas'),
    group: mark('Carpetas'),
    label: mark('Formato de notas nuevas'),
    detail: mark('Guardar las notas creadas en Folio como archivos .txt o .md con formato Markdown.'),
    keywords: ['formato de notas', 'txt', 'md', 'markdown', 'extension', 'texto plano'],
  },
  {
    id: 'folders-rescan',
    tab: 'folders',
    section: mark('Carpetas'),
    group: mark('Carpetas'),
    label: mark('Volver a escanear'),
    detail: mark('Escaneando…'),
    keywords: ['escanear', 'volver a escanear', 're-escanear', 'sincronizar', 'actualizar', 'scan'],
  },

  // --- Exclusiones (bans) ---
  {
    id: 'bans-folder',
    tab: 'bans',
    section: mark('Exclusiones'),
    group: mark('Exclusiones'),
    label: mark('Excluir una carpeta'),
    detail: mark('Elegila en el explorador: Folio deja de recorrerla, con todo lo que contiene.'),
    keywords: ['excluir carpeta', 'ban folder', 'omitir', 'ignorar carpeta'],
  },
  {
    id: 'bans-pattern',
    tab: 'bans',
    section: mark('Exclusiones'),
    group: mark('Exclusiones'),
    label: mark('Excluir por nombre'),
    detail: mark('Para lo que se repite en muchos lugares, como node_modules o los README.'),
    keywords: ['excluir por nombre', 'comodin', 'patron', 'node_modules', 'readme', 'wildcard', 'blacklist'],
  },

  // --- Categorías (categories) ---
  {
    id: 'categories-manage',
    tab: 'categories',
    section: mark('Categorías'),
    group: mark('Categorías'),
    label: mark('Categorías'),
    detail: mark('Color de la categoría'),
    keywords: ['categorias', 'separadores', 'solapas', 'colores', 'etiquetas', 'tags', 'paleta'],
  },
  {
    id: 'categories-suggestions',
    tab: 'categories',
    section: mark('Categorías'),
    group: mark('Categorías'),
    label: mark('Sugerir categorías'),
    detail: mark('La IA sugiere categorías nuevas a partir del contenido de tus notas.'),
    keywords: ['sugerencias', 'sugerir categorias', 'ia', 'inteligencia artificial', 'sparkles'],
  },

  // --- Clasificador (jev) ---
  {
    id: 'jev-provider',
    tab: 'jev',
    section: mark('Clasificador'),
    group: mark('Clasificador'),
    label: mark('Proveedor de IA'),
    detail: mark('Ollama (local)'),
    keywords: ['clasificador', 'ia', 'ai', 'proveedor', 'openai', 'anthropic', 'claude', 'gemini', 'ollama', 'llm', 'modelo'],
  },
  {
    id: 'jev-setup',
    tab: 'jev',
    section: mark('Clasificador'),
    group: mark('Clasificador'),
    label: mark('Clave de la API'),
    detail: mark('Modelo de {provider}'),
    keywords: ['api key', 'clave', 'token', 'modelo', 'configurar ia', 'credenciales'],
  },
  {
    id: 'jev-auto',
    tab: 'jev',
    section: mark('Clasificador'),
    group: mark('Clasificador'),
    label: mark('Clasificar automáticamente'),
    detail: mark('Las notas nuevas o modificadas se clasifican solas en segundo plano.'),
    keywords: ['clasificacion automatica', 'background', 'auto clasificar', 'organizar'],
  },
  {
    id: 'jev-reclassify',
    tab: 'jev',
    section: mark('Clasificador'),
    group: mark('Clasificador'),
    label: mark('Volver a clasificar todo'),
    detail: mark('Consulta de nuevo a {provider} por todas las hojas, salvo las que pusiste en una categoría a mano. Cuesta una consulta por hoja.'),
    keywords: ['volver a clasificar', 'reclasificar todo', 'recheck', 'procesar notas'],
  },

  // --- Integraciones (integrations) ---
  {
    id: 'integrations-tools',
    tab: 'integrations',
    section: mark('Integraciones'),
    group: mark('Integraciones'),
    label: mark('Integraciones'),
    detail: mark('Conectar Folio con herramientas y asistentes de IA.'),
    keywords: ['integraciones', 'claude code', 'cursor', 'windsurf', 'copilot', 'cline', 'mcp', 'skills', 'agentes', 'ai tools'],
  },

  // --- Versiones (versions) ---
  {
    id: 'versions-keep',
    tab: 'versions',
    section: mark('Versiones'),
    group: mark('Versiones'),
    label: mark('Versiones anteriores a conservar'),
    detail: mark('Por cada hoja, además de la actual.'),
    keywords: ['versiones', 'historial', 'copias', 'backup', 'conservar', 'recuperar'],
  },
  {
    id: 'versions-gap',
    tab: 'versions',
    section: mark('Versiones'),
    group: mark('Versiones'),
    label: mark('Fin de la sesión de edición'),
    detail: mark('Minutos sin cambios para dar una versión por terminada.'),
    keywords: ['sesion de edicion', 'minutos', 'inactividad', 'gap', 'tiempo'],
  },

  // --- Datos (data) ---
  {
    id: 'data-path',
    tab: 'data',
    section: mark('Datos'),
    group: mark('Datos'),
    label: mark('Dónde guarda Folio sus datos'),
    detail: mark('En ese archivo están las hojas indexadas, sus versiones, las categorías y estos ajustes. Si lo borrás, Folio vuelve a empezar de cero; tus notas originales no se tocan.'),
    keywords: ['datos', 'base de datos', 'sqlite', 'mostrar en carpeta', 'archivo db', 'almacenamiento'],
  },
  {
    id: 'data-secret-key',
    tab: 'data',
    section: mark('Datos'),
    group: mark('Datos'),
    label: mark('Cuaderno secreto'),
    detail: mark('Clave de respaldo'),
    keywords: ['clave secreta', 'secret-book', 'secret key', 'cifrado', 'encriptacion', 'password', 'proteger'],
  },
  {
    id: 'data-missing',
    tab: 'data',
    section: mark('Datos'),
    group: mark('Datos'),
    label: mark('Originales que desaparecieron'),
    detail: mark('Archivos que desaparecieron de las carpetas que Folio recorre.'),
    keywords: ['hojas desaparecidas', 'archivos faltantes', 'missing sheets', 'borrados', 'limpiar'],
  },

  // --- Acerca de (about) ---
  {
    id: 'about-version',
    tab: 'about',
    section: mark('Acerca de'),
    group: mark('Acerca de'),
    label: mark('Acerca de'),
    detail: mark('Un cuaderno que reúne tus notas, vengan de donde vengan.'),
    keywords: ['acerca de', 'version', 'folio', 'autor', 'joaquin hernandez', 'informacion'],
  },
  {
    id: 'about-updates',
    tab: 'about',
    section: mark('Acerca de'),
    group: mark('Actualizaciones'),
    label: mark('Buscar actualizaciones'),
    detail: mark('Comprueba si hay una versión más reciente de Folio en GitHub.'),
    keywords: ['actualizaciones', 'actualizar', 'buscar actualizaciones', 'nueva version', 'github', 'update'],
  },
  {
    id: 'about-license',
    tab: 'about',
    section: mark('Acerca de'),
    group: mark('Licencia'),
    label: mark('Licencia'),
    detail: mark('Licencia MIT con la condición Commons Clause: el código está abierto, pero no se puede vender.'),
    keywords: ['licencia', 'license', 'mit', 'tauri', 'react', 'sqlite', 'open source', 'tecnologias'],
  },
];

/**
 * Busca en el índice y devuelve los resultados organizados por sección.
 * Se busca en títulos de pestaña, grupos, etiquetas, descripciones y palabras clave.
 * La búsqueda es insensible a mayúsculas y acentos.
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
    const sectionT = t(item.section);
    const groupT = item.group ? t(item.group) : '';
    const labelT = t(item.label);
    const detailT = item.detail ? t(item.detail) : '';

    const normSection = normalize(sectionT);
    const normGroup = normalize(groupT);
    const normLabel = normalize(labelT);
    const normDetail = normalize(detailT);

    // Verificar si todos los términos de la consulta coinciden con algún campo del item
    const matchTerm = (term: string) => {
      if (normLabel.includes(term)) return { field: 'label' as const };
      if (normDetail.includes(term)) return { field: 'detail' as const };
      if (normSection.includes(term)) return { field: 'section' as const };
      if (normGroup.includes(term)) return { field: 'group' as const };
      if (item.keywords) {
        for (const kw of item.keywords) {
          if (normalize(kw).includes(term)) {
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
