export type Source = 'file' | 'notepad' | 'sticky' | 'capture';

export type View =
  | { kind: 'all' }
  | { kind: 'uncategorized' }
  | { kind: 'secret' }
  | { kind: 'hidden' }
  | { kind: 'category'; id: number };

export interface SheetSummary {
  id: number;
  source: Source;
  title: string;
  path: string | null;
  preview: string;
  /** Largo del contenido completo, en caracteres. */
  length: number;
  size: number;
  modifiedAt: number;
  categoryId: number | null;
  categorySource: 'jev' | 'manual' | null;
  categoryConfidence: number | null;
  noteScore: number | null;
  secret: boolean;
  secretSource: 'auto' | 'manual' | 'cleared' | null;
  hidden: boolean;
  /** El original ya no existe (archivo borrado o pestaña cerrada). */
  missing: boolean;
  versionCount: number;
}

export interface Version {
  id: number;
  savedAt: number;
  content: string;
}

export interface SheetDetail extends SheetSummary {
  content: string;
  /** Huella del contenido: al guardar una edición sirve para saber si el original cambió. */
  hash: string;
  versions: Version[];
}

export interface ListFilter {
  view: View['kind'];
  categoryId?: number;
  query?: string;
  beforeTs?: number;
  beforeId?: number;
  until?: number;
  limit?: number;
}

export interface Category {
  id: number;
  name: string;
  description: string;
  color: string;
  count: number;
}

export interface Counts {
  all: number;
  uncategorized: number;
  secret: number;
  hidden: number;
}

export interface ScanStatus {
  running: boolean;
  lastScanAt: number | null;
  lastScanMs: number | null;
  lastScanFiles: number | null;
}

/** Las IAs que pueden clasificar las hojas. */
export type ProviderId = 'jev' | 'claude' | 'openai' | 'gemini' | 'ollama';

/** Cómo está una IA: si tiene clave y qué modelo se usa con ella. */
export interface ProviderStatus {
  id: ProviderId;
  hasKey: boolean;
  /** La clave viene de una variable de entorno (ANTHROPIC_API_KEY…), no del llavero. */
  keyFromEnv: boolean;
  /**
   * El modelo que se usa con esa IA: el que se eligió o, si no, el de fábrica. Vacío en Jev
   * (tiene uno solo) y en Ollama mientras no se escriba el que se tiene instalado.
   */
  model: string;
}

/**
 * El clasificador automático. Se llama `jev` por historia: ahora vale para cualquiera de las
 * IAs (el interruptor, las consultas y lo pendiente son de la IA activa).
 */
export interface JevStatus {
  enabled: boolean;
  /** La IA activa tiene clave. En Ollama, que no usa, es siempre `false`: ahí vale `ready`. */
  hasKey: boolean;
  keyFromEnv: boolean;
  /** Con lo que hay se puede consultar a la IA activa: tiene clave o, en Ollama, modelo. */
  ready: boolean;
  /** La IA activa. */
  provider: ProviderId;
  /** Todas las IAs, cada una con su clave y su modelo. */
  providers: ProviderStatus[];
  /** Dónde escucha Ollama; de fábrica, esta PC. */
  ollamaUrl: string;
  pending: number;
  error: string | null;
  /** Consultas hechas a la IA hoy y desde que se instaló Book: para ver cuánto se la usa. */
  callsToday: number;
  callsTotal: number;
}

/** Lo que eligió la IA al «Probar» con una hoja de ejemplo. */
export interface ClassifierTest {
  /** La categoría elegida; `null` si eligió «otro» (ninguna encajó). */
  category: string | null;
  /** De 0 a 1. */
  confidence: number;
  noteScore: number | null;
  /** Cuánto tardó, en milisegundos. */
  tookMs: number;
  /** La hoja de ejemplo que se envió. */
  sample: string;
}

export interface Overview {
  counts: Counts;
  categories: Category[];
  scan: ScanStatus;
  jev: JevStatus;
  /** Carpeta donde Book guarda, como archivos de texto, las hojas que se escriben en él. */
  notesDir: string;
}

export interface Root {
  id: number;
  path: string;
}

export type BanKind = 'dir' | 'file' | 'path';

export interface Ban {
  id: number;
  kind: BanKind;
  pattern: string;
  enabled: boolean;
  builtin: boolean;
}

export type SecretState = 'ready' | 'locked' | 'empty';

export interface Settings {
  roots: Root[];
  bans: Ban[];
  versionsKeep: number;
  sessionGapMin: number;
  ignoreGitRepos: boolean;
  ignoreDotDirs: boolean;
  maxFileKb: number;
  jevThreshold: number;
  /**
   * Cada cuántos días se vuelve a consultar a Jev por una hoja ya clasificada cuyo texto
   * cambió; 0 = nunca (una hoja clasificada no se vuelve a consultar sola).
   */
  jevRecheckDays: number;
  jev: JevStatus;
  /** Book se abre junto con el sistema, directo en la bandeja. */
  autostart: boolean;
  /** Dónde vive la base de datos de Book. */
  dataPath: string;
  /** Estado del cifrado del secret-book en este equipo. */
  secretState: SecretState;
  /** Cantidad de hojas secretas bloqueadas por falta de clave. */
  secretLockedCount: number;
  /** Atajo global para anotar desde cualquier programa; `null` si no se pudo registrar. */
  captureShortcut: string | null;
  /** Atajo global para traer el cuaderno al frente; `null` si no se pudo registrar. */
  openShortcut: string | null;
  /** Atajo global para enviar al Book lo seleccionado en otro programa; `null` si no se pudo registrar. */
  sendShortcut: string | null;
  /**
   * Combinaciones elegidas para los tres atajos globales, como "Ctrl+Alt+N" (modificadores
   * Ctrl, Alt, Shift, Super y una tecla, unidos con +), se hayan podido registrar o no.
   */
  captureKeys: string;
  openKeys: string;
  sendKeys: string;
  /** A dónde va lo que se envía con ese atajo. */
  sendTo: SendTarget;
  /** Guarda el encabezado con la hora y el programa de origen en los recortes. */
  sendOrigin: boolean;
  /** Formato de notas nuevas: 'txt' o 'md'. */
  noteFormat: 'txt' | 'md';
  /** Versión de Folio. */
  version: string;
}

export type SettingsPatch = Partial<
  Pick<
    Settings,
    | 'versionsKeep'
    | 'sessionGapMin'
    | 'ignoreGitRepos'
    | 'ignoreDotDirs'
    | 'maxFileKb'
    | 'jevThreshold'
    | 'jevRecheckDays'
    | 'autostart'
    | 'sendTo'
    | 'sendOrigin'
    | 'noteFormat'
  >
> & { jevEnabled?: boolean };

/** Atajos que valen desde cualquier programa. */
export type GlobalShortcut = 'capture' | 'open' | 'send';

/**
 * Qué se hace con lo que se envía desde otro programa: agregarlo a una hoja única (`recortes.txt`),
 * a la hoja del día (`recortes-AAAA-MM-DD.txt`), de la semana (`recortes-semana-AAAA-MM-DD.txt`),
 * del mes (`recortes-AAAA-MM.txt`) o abrir la hoja suelta con el texto para revisarlo antes de guardar.
 */
export type SendTarget = 'all' | 'day' | 'week' | 'month' | 'sheet';

/**
 * Lo que espera la hoja suelta cuando se la abre desde «Enviar lo seleccionado al Book»:
 * el texto seleccionado y su origen, el encabezado «— 14:32 · Chrome · «Título de la página»».
 */
export interface CaptureSeed {
  text: string;
  origin: string;
}

/** Categoría propuesta a partir del contenido de las notas, como punto de partida. */
export interface CategorySuggestion {
  /** Nombre propuesto; el usuario puede cambiarlo antes de aceptarla. */
  name: string;
  /** Palabras que más distinguen a ese grupo de notas: sirven de descripción para Jev. */
  keywords: string[];
  /** Cuántas hojas caerían en ese grupo. */
  count: number;
  /** Títulos de algunas hojas del grupo, de ejemplo. */
  samples: string[];
}

/** Hoja cuyo original (archivo o pestaña) ya no existe. */
export interface MissingSheet {
  id: number;
  title: string;
  source: Source;
  path: string | null;
  /** Última vez que el original se guardó. */
  modifiedAt: number;
  /** Cuándo Book notó que ya no estaba. */
  missingAt: number | null;
}

export type Theme = 'auto' | 'light' | 'dark';
/** Idioma de la interfaz: el del sistema (inglés si no está en español) o uno elegido. */
export type Lang = 'auto' | 'es' | 'en';
export type Spread = 'double' | 'single';
/**
 * Tamaños del cuaderno: de bolsillo, el habitual, todo lo que entre en la pantalla, o
 * a medida (el que quedó al estirarlo a mano con Mayús).
 */
export type BookSize = 'pocket' | 'standard' | 'full' | 'custom';
export type PresetSize = Exclude<BookSize, 'custom'>;
/** Tamaño de la letra de las hojas; el renglón acompaña. */
export type TextSize = 'small' | 'medium' | 'large' | 'xlarge';
/**
 * Estilo de la tapa, siempre teñido con su color: lisa, con manchas (el cuaderno de
 * composición), con tira elástica como una agenda, con lomo de tela o de cuero cosido.
 */
export type CoverStyle = 'plain' | 'spots' | 'strap' | 'spine' | 'leather';

/** Preferencias de la ventana: cómo se ve el cuaderno. */
export interface Prefs {
  theme: Theme;
  lang: Lang;
  /** Color de la tapa (#RRGGBB) o `null` para el de fábrica. */
  cover: string | null;
  coverStyle: CoverStyle;
  /** Mostrar las solapas de categorías arriba del cuaderno. */
  tabs: boolean;
  spread: Spread;
  size: BookSize;
  /** Alto del cuaderno, en píxeles, cuando el tamaño es a medida. */
  height: number;
  /** Nombre que el usuario le puso al cuaderno; va en la etiqueta de la tapa. */
  name: string;
  /** Sonidos al pasar de hoja, escribir y borrar. */
  sounds: boolean;
  textSize: TextSize;
  /** Las hojas `.md` se leen con formato (títulos, listas, tablas); escribiendo, siempre en texto plano. */
  markdown: boolean;
  /** Ocultar el título de la hoja y los metadatos del encabezado. */
  hideHeader: boolean;
  /** Centrar el título de la hoja horizontalmente. */
  centerTitle: boolean;
}

export interface FolderStat {
  folder: string;
  count: number;
}

export interface DayCount {
  /** YYYY-MM-DD en hora local. */
  day: string;
  count: number;
}

/** Asistentes de IA a los que Book les puede dejar instrucciones para tomar notas. */
export type IntegrationTool = 'claude' | 'codex' | 'gemini';

/** Cómo está la integración con un asistente en esta PC. */
export interface Integration {
  tool: IntegrationTool;
  /** Nombre de la herramienta, como se la conoce («Claude Code»). */
  name: string;
  /** Archivo donde van las instrucciones de Book. */
  path: string;
  /** Ese archivo ya existe: instalar o quitar lo modifica, y se pregunta antes. */
  exists: boolean;
  installed: boolean;
  /** Lo instalado es igual a lo que instalaría esta versión de Book. */
  current: boolean;
  /** Algo a tener en cuenta, por ejemplo un archivo que tapa al de Book. */
  note: string | null;
}
