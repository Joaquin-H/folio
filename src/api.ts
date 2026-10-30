import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { mockApi } from './mock';
import type {
  BanKind,
  CaptureSeed,
  CategorySuggestion,
  ClassifierTest,
  FloatingRect,
  GlobalShortcut,
  DayCount,
  FolderStat,
  Integration,
  IntegrationTool,
  MissingSheet,
  ListFilter,
  Overview,
  ProviderId,
  Settings,
  SettingsPatch,
  SheetDetail,
  SheetSummary,
  TornOffSheetState,
} from './types';

export interface Api {
  listSheets(filter: ListFilter): Promise<SheetSummary[]>;
  listDays(filter: ListFilter): Promise<DayCount[]>;
  getSheet(id: number): Promise<SheetDetail | null>;
  getOverview(): Promise<Overview>;
  setSheetCategory(id: number, categoryId: number | null): Promise<void>;
  setSheetSecret(id: number, secret: boolean): Promise<void>;
  setSheetHidden(id: number, hidden: boolean): Promise<void>;
  setSheetPinned(id: number, pinned: boolean): Promise<void>;
  /**
   * Crea una hoja escrita en Book: un archivo de texto en la carpeta de Book con ese
   * título como nombre. Con `categoryId` nace en esa categoría; con `open`, además se
   * abre en el Bloc de notas.
   */
  createNote(title: string, content: string, categoryId?: number, open?: boolean): Promise<SheetDetail>;
  /**
   * Guarda lo editado de una hoja en su original. `baseHash` es la huella del contenido
   * del que se partió: si el original cambió por fuera, falla con CONFLICT salvo `force`.
   */
  saveSheet(id: number, content: string, options?: SaveOptions): Promise<SheetDetail>;
  listMissing(): Promise<MissingSheet[]>;
  /** Abre los ajustes en su propia ventana. */
  openSettings(): Promise<void>;
  openOriginal(id: number, reveal: boolean): Promise<void>;
  /** Abre un enlace de una hoja afuera, en el navegador o el correo. Solo http, https y mailto. */
  openLink(url: string): Promise<void>;
  createCategory(name: string, description: string, color: string): Promise<number>;
  updateCategory(id: number, name: string, description: string, color: string): Promise<void>;
  deleteCategory(id: number): Promise<void>;
  ensureClippingsCategory(): Promise<number>;
  migrateClippings(): Promise<number>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<void>;
  pickFolder(): Promise<string | null>;
  addRoot(path: string): Promise<void>;
  removeRoot(id: number): Promise<void>;
  addBan(kind: BanKind, pattern: string): Promise<void>;
  setBanEnabled(id: number, enabled: boolean): Promise<void>;
  removeBan(id: number): Promise<void>;
  folderStats(): Promise<FolderStat[]>;
  rescan(): Promise<void>;
  /** Muestra la base de datos de Book en el explorador de archivos. */
  revealData(): Promise<void>;
  /** La clave de Jev. Lo mismo que `setProviderKey('jev', key)`. */
  setJevKey(key: string): Promise<void>;
  clearJevKey(): Promise<void>;
  /**
   * Elige con qué IA se clasifica. Lo ya clasificado no se toca ni se vuelve a consultar:
   * solo las hojas que falten pasan por la nueva.
   */
  setAiProvider(provider: ProviderId): Promise<void>;
  /** Elige el modelo de una IA (Jev no tiene); vacío vuelve al de fábrica. */
  setAiModel(provider: ProviderId, model: string): Promise<void>;
  /** Dónde escucha Ollama, por ejemplo "http://localhost:11434"; vacío vuelve a esta PC. */
  setOllamaUrl(url: string): Promise<void>;
  /** Guarda la clave de una IA en el llavero del sistema: es el permiso para enviarle hojas. */
  setProviderKey(provider: ProviderId, key: string): Promise<void>;
  clearProviderKey(provider: ProviderId): Promise<void>;
  /**
   * Le pide a la IA elegida que clasifique una hoja de ejemplo con las categorías de ahora y
   * devuelve qué eligió. Cuenta como una consulta. Falla con el motivo si no se pudo.
   */
  testClassifier(): Promise<ClassifierTest>;
  classifyNow(): Promise<void>;
  /** Vuelve a consultar a Jev por todas las hojas que no tienen categoría puesta a mano. */
  reclassifyAll(): Promise<void>;
  /**
   * Analiza en esta PC (sin enviar nada a ningún lado) las hojas del cuaderno y propone
   * categorías de base. No crea nada: el usuario elige cuáles aceptar.
   */
  suggestCategories(): Promise<CategorySuggestion[]>;
  /**
   * Propone categorías de base para el cuaderno usando la IA activa (Claude, OpenAI, Gemini u Ollama).
   */
  suggestCategoriesAi(): Promise<CategorySuggestion[]>;
  /**
   * Cambia la combinación de un atajo global (por ejemplo "Ctrl+Alt+N"). Falla con un
   * mensaje claro si la combinación no es válida o si otro programa ya la usa.
   */
  setGlobalShortcut(which: GlobalShortcut, keys: string): Promise<void>;
  /** Cómo está, en esta PC, la integración con cada asistente de IA. */
  integrations(): Promise<Integration[]>;
  /**
   * Deja las instrucciones de Book donde las lee ese asistente. En un archivo que ya
   * existe solo agrega (o reemplaza) el bloque de Book: lo demás queda como estaba.
   */
  installIntegration(tool: IntegrationTool): Promise<void>;
  /** Saca lo de Book de ese asistente y nada más. */
  removeIntegration(tool: IntegrationTool): Promise<void>;
  /** Las instrucciones para ese asistente, con la carpeta de notas de esta PC, para pegarlas a mano. */
  integrationText(tool: IntegrationTool): Promise<string>;
  /** Exporta la clave de respaldo del secret-book en base64. */
  exportSecretKey(): Promise<string>;
  /** Restaura la clave del secret-book a partir de un respaldo. */
  importSecretKey(key: string): Promise<void>;
  /**
   * El texto con el que tiene que nacer la hoja suelta cuando se la abre desde «Enviar lo
   * seleccionado al Book» (con el destino «abrir la hoja suelta»). Se entrega una sola vez;
   * `null` si no hay nada esperando.
   */
  takeCaptureSeed(): Promise<CaptureSeed | null>;
  /** Inicia el dictado por voz de Windows (Win + H). */
  startDictation(): Promise<void>;
  /**
   * Abre una hoja del cuaderno en su propia ventana flotante («Arrancar hoja»).
   * Si ya está abierta, la trae al frente sin duplicar la ventana.
   */
  tearOffSheet(id: number, collapsed?: boolean): Promise<TornOffSheetState>;
  /** Devuelve una hoja arrancada al cuaderno (cierra su ventana flotante y la saca de la lista persistida). */
  returnTornOffSheet(id: number): Promise<void>;
  /** Lista las hojas arrancadas actualmente abiertas/persistidas. */
  listTornOffSheets(): Promise<TornOffSheetState[]>;
  /** Actualiza el estado (colapsada, fijada, posición) de una hoja arrancada. */
  updateTornOffState(id: number, patch: { collapsed?: boolean; pinned?: boolean; x?: number; y?: number }): Promise<void>;
  /**
   * Expande o colapsa una ventana flotante respetando los bordes del monitor actual (`work_area`)
   * y apilando los íconos colapsados sin superponerlos.
   */
  setFloatingMode(collapsed: boolean, preferredX?: number, preferredY?: number): Promise<FloatingRect>;
  /**
   * Avisa a la hoja suelta, si ya estaba abierta, de que le llegó un texto nuevo
   * (`takeCaptureSeed` lo entrega). Devuelve la función para dejar de escuchar.
   */
  onCaptureSeed(callback: () => void): () => void;
  /**
   * Book está por cerrarse sin pasar por la ventana (por ejemplo, «Salir» en la bandeja):
   * se guarda lo pendiente y recién entonces se cierra. Devuelve cómo dejar de escuchar.
   */
  onQuitRequested(handler: () => Promise<void>): () => void;
  /** Avisa cuando el Book cambió. Devuelve la función para dejar de escuchar. */
  onChanged(callback: () => void): () => void;
  /** Avisa cuando un recorte se guardó exitosamente o hubo feedback de captura. */
  onClippingSaved(callback: (payload: { name: string; title: string; body: string; message: string; sheetId?: number | null }) => void): () => void;
  /** Avisa cuando un agente o comando externo pidió abrir el mapa del cuaderno. */
  onOpenMap(callback: () => void): () => void;
  /** Avisa cuando un agente o comando externo pidió abrir una hoja concreta en el cuaderno. */
  onFocusSheet(callback: (id: number) => void): () => void;
  window: {
    /** Cierra la ventana; Book sigue en la bandeja del sistema. */
    hide(): void;
    /** Minimiza la ventana. */
    minimize(): void;
    /** Cierra Book del todo. */
    quit(): void;
    /** Lleva la ventana a ese tamaño (píxeles lógicos) sin que se salga de la pantalla. */
    fit(width: number, height: number, center: boolean): Promise<void>;
    /**
     * Lleva la ventana, en un solo paso, a ese tamaño corriéndola `dx, dy` desde donde
     * está (píxeles lógicos), sin que se salga de la pantalla.
     */
    place(spot: Spot): Promise<void>;
    /**
     * Muestra el fantasma del cuaderno donde quedaría con ese cambio, o lo esconde con
     * `null`. `inset` es la mesa que rodea al cuaderno: izquierda, arriba, derecha, abajo.
     */
    ghost(spot: Spot | null, inset?: [number, number, number, number]): Promise<void>;
    /** Empieza a mover la ventana con el mouse. */
    drag(): void;
    /** Avisa justo antes de que la ventana se cierre y espera a que termine lo pendiente. */
    onClosing(handler: () => Promise<void>): () => void;
  };
}

export interface SaveOptions {
  /** Título nuevo; solo cambian de nombre las hojas de la carpeta de Book. */
  title?: string;
  baseHash?: string;
  force?: boolean;
}

/** Dónde y de qué tamaño quedaría la ventana, respecto de donde está ahora. */
export interface Spot {
  dx: number;
  dy: number;
  width: number;
  height: number;
}

/** Así responde `saveSheet` cuando el original cambió mientras se lo editaba. */
export const isConflict = (reason: unknown) => String(reason).includes('CONFLICT');

const tauriApi: Api = {
  listSheets: (filter) => invoke('list_sheets', { filter }),
  listDays: (filter) => invoke('list_days', { filter }),
  getSheet: (id) => invoke('get_sheet', { id }),
  getOverview: () => invoke('get_overview'),
  setSheetCategory: (id, categoryId) => invoke('set_sheet_category', { id, categoryId }),
  setSheetSecret: (id, secret) => invoke('set_sheet_secret', { id, secret }),
  setSheetHidden: (id, hidden) => invoke('set_sheet_hidden', { id, hidden }),
  setSheetPinned: (id, pinned) => invoke('set_sheet_pinned', { id, pinned }),
  createNote: (title, content, categoryId, open = false) => invoke('create_note', { title, content, categoryId, open }),
  saveSheet: (id, content, options = {}) =>
    invoke('save_sheet', { id, content, title: options.title, baseHash: options.baseHash, force: options.force ?? false }),
  listMissing: () => invoke('list_missing'),
  openSettings: () => invoke('open_settings'),
  openOriginal: (id, reveal) => invoke('open_original', { id, reveal }),
  openLink: (url) => invoke('open_link', { url }),
  createCategory: (name, description, color) => invoke('create_category', { name, description, color }),
  updateCategory: (id, name, description, color) =>
    invoke('update_category', { id, name, description, color }),
  deleteCategory: (id) => invoke('delete_category', { id }),
  ensureClippingsCategory: () => invoke('ensure_clippings_category'),
  migrateClippings: () => invoke('migrate_clippings'),
  getSettings: () => invoke('get_settings'),
  updateSettings: (patch) => invoke('update_settings', { patch }),
  pickFolder: () => invoke('pick_folder'),
  addRoot: (path) => invoke('add_root', { path }),
  removeRoot: (id) => invoke('remove_root', { id }),
  addBan: (kind, pattern) => invoke('add_ban', { kind, pattern }),
  setBanEnabled: (id, enabled) => invoke('set_ban_enabled', { id, enabled }),
  removeBan: (id) => invoke('remove_ban', { id }),
  folderStats: () => invoke('folder_stats'),
  rescan: () => invoke('rescan'),
  revealData: () => invoke('reveal_data'),
  setJevKey: (key) => invoke('set_jev_key', { key }),
  clearJevKey: () => invoke('clear_jev_key'),
  setAiProvider: (provider) => invoke('set_ai_provider', { provider }),
  setAiModel: (provider, model) => invoke('set_ai_model', { provider, model }),
  setOllamaUrl: (url) => invoke('set_ollama_url', { url }),
  setProviderKey: (provider, key) => invoke('set_provider_key', { provider, key }),
  clearProviderKey: (provider) => invoke('clear_provider_key', { provider }),
  testClassifier: () => invoke('test_classifier'),
  classifyNow: () => invoke('classify_now'),
  reclassifyAll: () => invoke('reclassify_all'),
  suggestCategories: () => invoke('suggest_categories'),
  suggestCategoriesAi: () => invoke('suggest_categories_ai'),
  setGlobalShortcut: (which, keys) => invoke('set_global_shortcut', { which, keys }),
  integrations: () => invoke('list_integrations'),
  installIntegration: (tool) => invoke('install_integration', { tool }),
  removeIntegration: (tool) => invoke('remove_integration', { tool }),
  integrationText: (tool) => invoke('integration_text', { tool }),
  takeCaptureSeed: () => invoke('take_capture_seed'),
  startDictation: () => invoke('start_dictation'),
  tearOffSheet: (id, collapsed) => invoke('tear_off_sheet', { id, collapsed }),
  returnTornOffSheet: (id) => invoke('return_torn_off_sheet', { id }),
  listTornOffSheets: () => invoke('list_torn_off_sheets'),
  updateTornOffState: (id, patch) => invoke('update_torn_off_state', { id, ...patch }),
  setFloatingMode: (collapsed, preferredX, preferredY) =>
    invoke('set_floating_mode', { collapsed, preferredX, preferredY }),
  onCaptureSeed(callback) {
    const unlisten = listen('book:capture-seed', callback);
    return () => void unlisten.then((stop) => stop());
  },
  exportSecretKey: () => invoke('export_secret_key'),
  importSecretKey: (key) => invoke('import_secret_key', { key }),
  onQuitRequested(handler) {
    // El backend espera este aviso (con un tope de tiempo) antes de terminar el proceso.
    const unlisten = listen('book:quit', () => void handler().catch(() => {}).finally(() => invoke('quit_ready')));
    return () => void unlisten.then((stop) => stop());
  },
  onChanged(callback) {
    const unlisten = listen('book:changed', callback);
    return () => void unlisten.then((stop) => stop());
  },
  onClippingSaved(callback) {
    const unlisten = listen<{ name: string; title: string; body: string; message: string; sheetId?: number | null }>('book:clipping-saved', ({ payload }) => callback(payload));
    return () => void unlisten.then((stop) => stop());
  },
  onOpenMap(callback) {
    const unlisten = listen('book:open-map', callback);
    return () => void unlisten.then((stop) => stop());
  },
  onFocusSheet(callback) {
    const unlisten = listen<number>('book:focus-sheet', ({ payload }) => callback(payload));
    return () => void unlisten.then((stop) => stop());
  },
  window: {
    hide: () => void getCurrentWindow().close(),
    minimize: () => void getCurrentWindow().minimize(),
    quit: () => void invoke('quit_app'),
    fit: (width, height, center) => invoke('fit_window', { width, height, center }),
    place: (spot) => invoke('place_window', { ...spot }),
    ghost: (spot, inset = [0, 0, 0, 0]) => (spot ? invoke('show_ghost', { ...spot, inset }) : invoke('hide_ghost')),
    drag: () => void getCurrentWindow().startDragging(),
    onClosing(handler) {
      // Con alguien escuchando, Tauri espera a que termine antes de destruir la ventana.
      const unlisten = getCurrentWindow().onCloseRequested(() => handler().catch(() => {}));
      return () => void unlisten.then((stop) => stop());
    },
  },
};

/** Fuera de Tauri (por ejemplo `pnpm dev` en el navegador) se usan datos de muestra. */
export const isTauri = '__TAURI_INTERNALS__' in window;

export const api: Api = isTauri ? tauriApi : mockApi;
