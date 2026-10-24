mod classifier;
mod commands;
pub mod crypto;
mod db;
mod frontmatter;
mod ghost;
mod integrations;
mod jev;
mod llm;
mod model;
mod notepad;
mod provider;
mod scan;
mod scanner;
mod secrets;
mod selection;
mod send;
mod shortcuts;
mod sticky;
mod suggest;
mod text;
mod watcher;
mod wire;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::ShortcutState;

use classifier::Wake;
use db::Db;

/// Tamaño de la ventana la primera vez: cuaderno estándar a doble hoja.
const DEFAULT_WINDOW: (f64, f64) = (1216.0, 868.0);
/// Con este argumento Book arranca solo en la bandeja: así se inicia junto con el sistema.
const HIDDEN_ARG: &str = "--hidden";
/// Aviso a las ventanas de que Book está por cerrarse: guardan lo pendiente y responden
/// con el comando `quit_ready`.
const EVENT_QUIT: &str = "book:quit";
/// Ventanas en las que se escribe: el cuaderno y la hoja suelta.
const WRITING_WINDOWS: [&str; 2] = ["main", "capture"];
/// Cuánto se espera a que las ventanas guarden antes de cerrar de todos modos.
const QUIT_PATIENCE: Duration = Duration::from_secs(3);

/// La salida en curso: qué ventanas falta que avisen que ya guardaron lo suyo.
#[derive(Default)]
pub struct Quitting {
    /// `None` mientras nadie pidió salir.
    waiting: Mutex<Option<HashSet<String>>>,
    answered: Condvar,
}

impl Quitting {
    /// Empieza a esperar a esas ventanas. `false` si ya había una salida en curso.
    fn begin(&self, windows: HashSet<String>) -> bool {
        let mut waiting = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
        if waiting.is_some() {
            return false;
        }
        *waiting = Some(windows);
        true
    }

    /// Una ventana avisa que, por ella, Book ya puede cerrarse.
    pub fn ready(&self, window: &str) {
        if let Some(windows) = self.waiting.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            windows.remove(window);
        }
        self.answered.notify_all();
    }

    /// Espera a que avisen todas, como mucho `patience`. A las que ya no están abiertas
    /// (`open`) no se las espera. Devuelve `true` si no quedó ninguna sin avisar.
    fn wait(&self, patience: Duration, open: impl Fn(&str) -> bool) -> bool {
        let deadline = Instant::now() + patience;
        let mut waiting = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let Some(windows) = waiting.as_mut() else {
                return true;
            };
            windows.retain(|window| open(window));
            if windows.is_empty() {
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            // Se vuelve a mirar cada tanto, por si una ventana se cerró sin avisar.
            let step = left.min(Duration::from_millis(100));
            waiting = self.answered.wait_timeout(waiting, step).unwrap_or_else(|e| e.into_inner()).0;
        }
    }
}

/// Estado compartido entre la interfaz, el escáner, la vigilancia y el clasificador.
pub struct Shared {
    pub db: Db,
    /// Archivo de la base de datos (hojas, versiones, categorías y ajustes).
    pub db_path: PathBuf,
    pub scanning: AtomicBool,
    /// Se pidió un escaneo que todavía nadie atendió: si llega mientras corre otro (que
    /// empezó con los ajustes de antes), ese hace una pasada más al terminar.
    pub rescan: AtomicBool,
    pub watcher: Mutex<Option<watcher::Handle>>,
    pub classify_tx: Mutex<Option<mpsc::Sender<Wake>>>,
    pub jev_error: Mutex<Option<String>>,
    /// Atajo global para anotar desde cualquier programa, como se muestra («Ctrl + Alt + N»);
    /// `None` si no se pudo registrar (por ejemplo, porque otra aplicación ya lo usa).
    pub capture_shortcut: Mutex<Option<String>>,
    /// Atajo global para traer el cuaderno al frente; `None` si no se pudo registrar.
    pub open_shortcut: Mutex<Option<String>>,
    /// Atajo global para enviar al Book lo seleccionado en otro programa; `None` si no se
    /// pudo registrar.
    pub send_shortcut: Mutex<Option<String>>,
    /// Las combinaciones elegidas para esos tres atajos, se hayan podido registrar o no: el
    /// manejador de las teclas compara contra estas.
    pub shortcut_keys: Mutex<shortcuts::Keys>,
    /// Lo que tiene que mostrar la hoja suelta al abrirse (o al volver al frente) porque se
    /// lo envió desde otro programa; la hoja lo pide una sola vez (`take_capture_seed`).
    pub capture_seed: Mutex<Option<model::CaptureSeed>>,
    /// Un cambio de atajo por vez. Solo lo toma `shortcuts::change`: el manejador de las
    /// teclas corre en el hilo principal, que el registro espera, y no puede esperar acá.
    pub shortcut_change: Mutex<()>,
    /// La próxima vez que la ventana ajuste su tamaño tiene que centrarse en la pantalla
    /// (primera apertura, cuando todavía no hay una posición recordada).
    pub center_next: AtomicBool,
    pub quitting: Quitting,
}

impl Shared {
    /// Avisa al hilo de clasificación que algo cambió en el Book. No cuesta ninguna
    /// consulta: el hilo decide si hay hojas listas para el clasificador.
    pub fn ping_classifier(&self) {
        self.wake_classifier(Wake::Changed);
    }

    pub fn wake_classifier(&self, wake: Wake) {
        if let Some(tx) = self.classify_tx.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = tx.send(wake);
        }
    }
}

/// Carpeta donde Folio guarda, como archivos de texto, las hojas que se escriben en él.
pub(crate) fn notes_dir() -> Option<PathBuf> {
    dirs::document_dir().or_else(dirs::home_dir).map(|dir| {
        let folio_dir = dir.join("Folio");
        let legacy_dir = dir.join("Book");
        if !folio_dir.exists() && legacy_dir.exists() {
            if std::fs::rename(&legacy_dir, &folio_dir).is_ok() {
                folio_dir
            } else {
                legacy_dir
            }
        } else {
            folio_dir
        }
    })
}

/// Si Folio está anotado para iniciarse junto con el sistema (y Windows no lo tiene
/// desactivado desde el Administrador de tareas).
pub(crate) fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Activa o desactiva el inicio junto con el sistema. En Windows es un valor en la clave
/// `Run` del usuario: no pide permisos de administrador.
pub(crate) fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if !enabled {
        return app
            .autolaunch()
            .disable()
            .map_err(|err| format!("No se pudo quitar a Folio del inicio del sistema: {err}"));
    }
    // El ejecutable de desarrollo depende del servidor de la interfaz: registrarlo dejaría
    // un Folio que arranca con la PC y no abre.
    if cfg!(debug_assertions) {
        return Err("El inicio junto con el sistema se activa desde la versión instalada de Folio, no desde la de desarrollo.".into());
    }
    let failed = |err: String| format!("No se pudo anotar a Folio en el inicio del sistema: {err}");
    app.autolaunch().enable().map_err(|err| failed(err.to_string()))?;
    #[cfg(windows)]
    point_autostart_here(app).map_err(failed)?;
    Ok(())
}

/// Deja el inicio junto con el sistema, si está anotado, apuntando a este ejecutable y
/// con la ruta entre comillas. El plugin la anota sin comillas, y con espacios en la ruta
/// (`Documentos\Mis cosas\Book.exe`) Windows tendría que adivinar dónde termina el
/// programa y dónde empiezan los argumentos.
#[cfg(windows)]
fn point_autostart_here(app: &AppHandle) -> Result<(), String> {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};
    const RUN: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
    let command = autostart_command(&std::env::current_exe().map_err(|err| err.to_string())?);
    let name = &app.package_info().name;
    // Lo normal es la clave del usuario; la del equipo solo si Book corre como administrador.
    for root in [CURRENT_USER, LOCAL_MACHINE] {
        let Ok(key) = root.options().read().write().open(RUN) else {
            continue;
        };
        if key.get_string(name).is_ok_and(|current| current != command) {
            key.set_string(name, &command).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

/// Lo que Windows ejecuta al iniciar sesión: este Book, directo a la bandeja.
#[cfg(windows)]
fn autostart_command(exe: &std::path::Path) -> String {
    format!("\"{}\" {HIDDEN_ARG}", exe.display())
}

/// Cada versión de Folio es un ejecutable distinto. Si el inicio junto con el sistema está
/// activo, tiene que apuntar al que se está usando ahora y no a una versión anterior.
fn refresh_autostart(app: &AppHandle) {
    if cfg!(debug_assertions) || !autostart_enabled(app) {
        return;
    }
    #[cfg(windows)]
    let refreshed = point_autostart_here(app);
    #[cfg(not(windows))]
    let refreshed = app.autolaunch().enable().map_err(|err| err.to_string());
    if let Err(err) = refreshed {
        eprintln!("No se pudo actualizar el inicio junto con el sistema: {err}");
    }
}

/// Configura o refresca el inicio junto con el sistema. De fábrica viene activado: la primera
/// vez que corre la versión instalada (release), se anota en el inicio del sistema. Si el usuario
/// luego lo desactiva desde Ajustes, se respeta su decisión.
fn ensure_autostart(app: &AppHandle, shared: &Arc<Shared>) {
    if cfg!(debug_assertions) {
        return;
    }
    match shared.db.get_setting("autostart_configured").as_deref() {
        None => {
            let _ = set_autostart(app, true);
            let _ = shared.db.set_setting("autostart_configured", "true");
        }
        Some("true") => {
            refresh_autostart(app);
        }
        _ => {}
    }
}

pub fn restart_watcher(app: &AppHandle, shared: &Arc<Shared>) {
    let mut slot = shared.watcher.lock().unwrap_or_else(|e| e.into_inner());
    *slot = None; // soltar el anterior lo detiene
    *slot = watcher::start(app, shared);
}

/// Trae al frente una ventana que ya existe. Devuelve `false` si todavía no está creada.
fn focus_window(app: &AppHandle, label: &str) -> bool {
    let Some(window) = app.get_webview_window(label) else {
        return false;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    true
}

/// Si la ventana del cuaderno está abierta y visible (sin minimizar), la minimiza; si está
/// cerrada, oculta o minimizada, la abre y la trae al frente.
pub fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        if visible && !minimized {
            remember_window_size(app);
            let _ = window.minimize();
            return;
        }
    }
    open_main_window(app);
}

/// La ventana del cuaderno se crea a demanda y se destruye al cerrarla: en segundo plano
/// solo queda el proceso nativo, sin el motor web cargado. No tiene barra de título ni
/// se redimensiona a mano: su tamaño lo decide la interfaz, a la medida del cuaderno.
pub fn open_main_window(app: &AppHandle) {
    if focus_window(app, "main") {
        return;
    }
    // Vuelve a abrirse con el tamaño que tenía al cerrarla, para que no salte al cargar.
    let (width, height) = app
        .try_state::<Arc<Shared>>()
        .map(|s| {
            (
                s.db.get_f64("window_width", DEFAULT_WINDOW.0),
                s.db.get_f64("window_height", DEFAULT_WINDOW.1),
            )
        })
        .unwrap_or(DEFAULT_WINDOW);
    let shared = app.try_state::<Arc<Shared>>();
    let center_on_open = shared.as_ref().is_some_and(|s| s.center_next.load(Ordering::SeqCst));
    let place = if center_on_open {
        None
    } else {
        shared.as_ref().and_then(|s| {
            let x = s.db.get_setting("window_x")?.parse::<f64>().ok()?;
            let y = s.db.get_setting("window_y")?.parse::<f64>().ok()?;
            Some((x, y))
        })
    };
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Folio")
        .inner_size(width.clamp(390.0, 6000.0), height.clamp(480.0, 4000.0))
        .min_inner_size(390.0, 480.0)
        .resizable(false)
        .maximizable(false)
        .decorations(false)
        .transparent(true)
        // Sin esto, en Windows el manejador nativo de arrastrar y soltar se queda con los
        // archivos y el evento `drop` de la página nunca llega (soltar una imagen sobre la tapa).
        .disable_drag_drop_handler();
    // Vuelve a donde estaba; al iniciar (o la primera vez) se centra cuando ya tiene su tamaño definitivo.
    let builder = match place {
        Some((x, y)) => builder.position(x, y),
        None => {
            if let Some(s) = &shared {
                s.center_next.store(true, Ordering::SeqCst);
            }
            builder.center()
        }
    };
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    match builder.build() {
        Ok(window) => {
            if let Some(s) = &shared {
                restore_torn_off_windows(app, s);
            }
            let handle = app.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::CloseRequested { .. }) {
                    remember_window_size(&handle);
                }
            });
        }
        Err(err) => eprintln!("No se pudo abrir la ventana de Folio: {err}"),
    }
}

/// Guarda tamaño y posición de la ventana del cuaderno para la próxima vez que se abra.
pub(crate) fn remember_window_size(app: &AppHandle) {
    let (Some(window), Some(shared)) = (app.get_webview_window("main"), app.try_state::<Arc<Shared>>()) else {
        return;
    };
    // Minimizada, Windows informa una posición fuera de la pantalla: se conserva la anterior.
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
        let logical = size.to_logical::<f64>(scale);
        let _ = shared.db.set_setting("window_width", &logical.width.round().to_string());
        let _ = shared.db.set_setting("window_height", &logical.height.round().to_string());
    }
    if let (Ok(position), Ok(scale)) = (window.outer_position(), window.scale_factor()) {
        let logical = position.to_logical::<f64>(scale);
        let _ = shared.db.set_setting("window_x", &logical.x.round().to_string());
        let _ = shared.db.set_setting("window_y", &logical.y.round().to_string());
    }
}

/// Cierra Book del todo, dándoles antes a las ventanas donde se escribe la oportunidad de
/// guardar lo pendiente: se les avisa (`book:quit`) y se espera, con un tope, a que cada
/// una responda con `quit_ready`. `asked_by` es la ventana que pidió salir, si fue una:
/// esa ya guardó lo suyo antes de pedirlo y no se la espera.
pub(crate) fn quit_book(app: &AppHandle, asked_by: Option<&str>) {
    remember_window_size(app);
    let Some(shared) = app.try_state::<Arc<Shared>>().map(|shared| Arc::clone(&shared)) else {
        app.exit(0);
        return;
    };
    let mut windows: HashSet<String> = WRITING_WINDOWS
        .into_iter()
        .filter(|window| Some(*window) != asked_by && app.get_webview_window(window).is_some())
        .map(str::to_string)
        .collect();
    for label in app.webview_windows().keys() {
        if label.starts_with("tearoff-") && Some(label.as_str()) != asked_by {
            windows.insert(label.clone());
        }
    }
    let nobody = windows.is_empty();
    if !shared.quitting.begin(windows) {
        // Ya se estaba saliendo. Si la que insiste es una ventana, es que ya guardó.
        if let Some(window) = asked_by {
            shared.quitting.ready(window);
        }
        return;
    }
    if nobody {
        app.exit(0);
        return;
    }
    let _ = app.emit(EVENT_QUIT, ());
    // La espera va en otro hilo: las respuestas de las ventanas llegan por el de la
    // interfaz, que es desde donde se pide salir en la bandeja.
    let app = app.clone();
    thread::spawn(move || {
        shared.quitting.wait(QUIT_PATIENCE, |window| app.get_webview_window(window).is_some());
        app.exit(0);
    });
}

pub(crate) fn is_english(app: &AppHandle) -> bool {
    app.try_state::<Arc<Shared>>()
        .and_then(|s| s.db.get_setting("locale"))
        .as_deref()
        == Some("en")
}

pub(crate) fn refresh_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    let en = is_english(app);
    let open = MenuItem::with_id(app, "open", if en { "Open Folio" } else { "Abrir Folio" }, true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", if en { "New sheet" } else { "Nueva hoja" }, true, None::<&str>)?;
    let rescan = MenuItem::with_id(app, "rescan", if en { "Scan again" } else { "Volver a escanear" }, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", if en { "Quit" } else { "Salir" }, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &capture, &rescan, &quit])?;
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_menu(Some(menu));
    }
    Ok(())
}

/// Los ajustes van en una ventana propia, normal, para no depender del tamaño del cuaderno.
pub fn open_settings_window(app: &AppHandle) -> tauri::Result<()> {
    let title = if is_english(app) { "Folio Settings" } else { "Ajustes de Folio" };
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_title(title);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html?window=settings".into()))
        .title(title)
        .inner_size(760.0, 700.0)
        .min_inner_size(620.0, 480.0)
        .center()
        .build()?;
    Ok(())
}

/// Hoja suelta para anotar desde cualquier programa: siempre encima de las demás.
pub fn open_capture_window(app: &AppHandle) {
    let title = if is_english(app) { "New sheet" } else { "Nueva hoja" };
    if let Some(window) = app.get_webview_window("capture") {
        let _ = window.set_title(title);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "capture", WebviewUrl::App("index.html?window=capture".into()))
        .title(title)
        .inner_size(commands::FLOATING_EXPANDED_W, commands::FLOATING_EXPANDED_H)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .build();
    if let Err(err) = built {
        eprintln!("No se pudo abrir la ventana de captura: {err}");
    }
}

/// Abre una hoja del cuaderno en su propia ventana flotante («Arrancar hoja»).
/// Si ya está abierta en su ventana, la trae al frente (y la expande si se pidió) sin duplicarla.
pub(crate) fn open_tear_off_window(
    app: &AppHandle,
    shared: &Arc<Shared>,
    id: i64,
    collapsed_override: Option<bool>,
) -> Result<model::TornOffSheetState, String> {
    let sheet = shared
        .db
        .get_sheet(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "La hoja ya no existe".to_string())?;
    let existing_list = commands::load_torn_off_sheets(&shared.db);
    let existing = existing_list.into_iter().find(|item| item.id == id);
    let collapsed = collapsed_override.unwrap_or_else(|| existing.as_ref().is_some_and(|e| e.collapsed));
    let pinned = existing.as_ref().is_some_and(|e| e.pinned);
    let state_entry = model::TornOffSheetState {
        id,
        collapsed,
        pinned,
        expanded_x: existing.as_ref().and_then(|e| e.expanded_x),
        expanded_y: existing.as_ref().and_then(|e| e.expanded_y),
        collapsed_x: existing.as_ref().and_then(|e| e.collapsed_x),
        collapsed_y: existing.as_ref().and_then(|e| e.collapsed_y),
    };
    commands::upsert_torn_off(&shared.db, state_entry.clone());

    let label = format!("tearoff-{id}");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.set_title(&sheet.summary.title);
        let _ = window.unminimize();
        let _ = window.show();
        if let Some(target_collapsed) = collapsed_override {
            let _ = window.emit("book:tearoff-mode", target_collapsed);
        } else if !collapsed {
            let _ = window.emit("book:tearoff-mode", false);
        }
        let _ = window.set_focus();
        let _ = app.emit(scan::EVENT_CHANGED, ());
        return Ok(state_entry);
    }

    let (init_w, init_h) = if collapsed {
        (commands::FLOATING_COLLAPSED_SIZE, commands::FLOATING_COLLAPSED_SIZE)
    } else {
        (commands::FLOATING_EXPANDED_W, commands::FLOATING_EXPANDED_H)
    };
    let url = format!("index.html?window=tearoff&id={id}");
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(&sheet.summary.title)
        .inner_size(init_w, init_h)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true);

    let preferred_pos = if collapsed {
        state_entry.collapsed_x.zip(state_entry.collapsed_y)
    } else {
        state_entry.expanded_x.zip(state_entry.expanded_y)
    };
    if let Some((px, py)) = preferred_pos {
        builder = builder.position(px, py);
    } else {
        // Desplazar levemente cada hoja arrancada para que varias abiertas a la vez no queden
        // exactamente una encima de la otra.
        let open_count = app
            .webview_windows()
            .keys()
            .filter(|k| k.starts_with("tearoff-"))
            .count() as f64;
        if open_count > 0.0 && !collapsed {
            builder = builder.position(120.0 + (open_count * 28.0) % 280.0, 90.0 + (open_count * 28.0) % 220.0);
        } else {
            builder = builder.center();
        }
    }

    let window = builder
        .build()
        .map_err(|err| format!("No se pudo abrir la hoja flotante: {err}"))?;
    let _ = commands::apply_floating_mode(
        app,
        &window,
        collapsed,
        preferred_pos.map(|p| p.0),
        preferred_pos.map(|p| p.1),
    );
    let _ = app.emit(scan::EVENT_CHANGED, ());
    Ok(state_entry)
}

/// Restaura las hojas arrancadas que habían quedado abiertas la última vez que se cerró Folio.
pub(crate) fn restore_torn_off_windows(app: &AppHandle, shared: &Arc<Shared>) {
    let saved = commands::load_torn_off_sheets(&shared.db);
    for item in saved {
        if shared.db.get_sheet(item.id).ok().flatten().is_some() {
            let _ = open_tear_off_window(app, shared, item.id, Some(item.collapsed));
        } else {
            commands::remove_torn_off(&shared.db, item.id);
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Folio")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => open_main_window(app),
            "capture" => open_capture_window(app),
            "rescan" => {
                if let Some(shared) = app.try_state::<Arc<Shared>>() {
                    scan::spawn_scan(app, &shared);
                }
            }
            "quit" => quit_book(app, None),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    refresh_tray_menu(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            open_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::Builder::new().arg(HIDDEN_ARG).build())
        // Los avisos del sistema («Enviado a Book»); se muestran desde Rust, sin permisos para la interfaz.
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                // Las combinaciones las elige el usuario: se comparan contra las vigentes.
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        shortcuts::pressed(app, shortcut);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("folio.db");
            if !db_path.exists() {
                let local_legacy = dir.join("book.db");
                if local_legacy.exists() {
                    let _ = std::fs::copy(&local_legacy, &db_path);
                } else if let Some(parent) = dir.parent() {
                    let appdata_legacy = parent.join("com.joaquinh.book").join("book.db");
                    if appdata_legacy.exists() {
                        let _ = std::fs::copy(&appdata_legacy, &db_path);
                    }
                }
            }
            let db = Db::open(&db_path)?;
            // Si otra aplicación ya usa un atajo, Folio sigue andando sin él.
            let keys = shortcuts::Keys::load(&db);
            let (capture_shown, open_shown, send_shown) = shortcuts::register_all(app.handle(), &keys);
            let shared = Arc::new(Shared {
                db,
                db_path,
                scanning: AtomicBool::new(false),
                rescan: AtomicBool::new(false),
                watcher: Mutex::new(None),
                classify_tx: Mutex::new(None),
                jev_error: Mutex::new(None),
                capture_shortcut: Mutex::new(capture_shown),
                open_shortcut: Mutex::new(open_shown),
                send_shortcut: Mutex::new(send_shown),
                shortcut_keys: Mutex::new(keys),
                capture_seed: Mutex::new(None),
                shortcut_change: Mutex::new(()),
                center_next: AtomicBool::new(true),
                quitting: Quitting::default(),
            });
            app.manage(Arc::clone(&shared));

            // El fantasma que se ve al estirar el cuaderno: se crea acá, en el hilo de las ventanas.
            ghost::create();

            let handle = app.handle().clone();
            build_tray(&handle)?;
            ensure_autostart(&handle, &shared);
            classifier::spawn(&handle, &shared);
            restart_watcher(&handle, &shared);
            scan::spawn_scan(&handle, &shared);
            // Con --hidden (inicio junto al sistema) arranca solo en la bandeja.
            if !std::env::args().any(|arg| arg == HIDDEN_ARG) {
                open_main_window(&handle);
                restore_torn_off_windows(&handle, &shared);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sheets,
            commands::list_days,
            commands::get_sheet,
            commands::get_overview,
            commands::set_sheet_category,
            commands::set_sheet_secret,
            commands::set_sheet_hidden,
            commands::set_sheet_pinned,
            commands::create_note,
            commands::save_sheet,
            commands::open_original,
            commands::open_link,
            commands::list_integrations,
            commands::install_integration,
            commands::remove_integration,
            commands::integration_text,
            commands::create_category,
            commands::update_category,
            commands::delete_category,
            commands::ensure_clippings_category,
            commands::migrate_clippings,
            commands::get_settings,
            commands::update_settings,
            commands::open_settings,
            commands::fit_window,
            commands::place_window,
            commands::set_floating_mode,
            commands::tear_off_sheet,
            commands::return_torn_off_sheet,
            commands::list_torn_off_sheets,
            commands::update_torn_off_state,
            commands::show_ghost,
            commands::hide_ghost,
            commands::quit_app,
            commands::quit_ready,
            commands::pick_folder,
            commands::add_root,
            commands::remove_root,
            commands::add_ban,
            commands::set_ban_enabled,
            commands::remove_ban,
            commands::folder_stats,
            commands::rescan,
            commands::reveal_data,
            commands::list_missing,
            commands::set_jev_key,
            commands::clear_jev_key,
            commands::set_ai_provider,
            commands::set_ai_model,
            commands::set_ollama_url,
            commands::set_provider_key,
            commands::clear_provider_key,
            commands::test_classifier,
            commands::classify_now,
            commands::reclassify_all,
            commands::suggest_categories,
            commands::suggest_categories_ai,
            commands::set_global_shortcut,
            commands::take_capture_seed,
            commands::export_secret_key,
            commands::import_secret_key,
            commands::start_dictation,
            commands::set_locale,
            commands::check_update,
        ])
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar Folio")
        .run(|_app, event| {
            // Cerrar la última ventana no termina la app: sigue en la bandeja.
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod quit_tests {
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::Quitting;

    fn windows(labels: &[&str]) -> HashSet<String> {
        labels.iter().map(|label| label.to_string()).collect()
    }

    #[test]
    fn al_salir_se_espera_a_que_cada_ventana_guarde_lo_suyo() {
        let quitting = Arc::new(Quitting::default());
        assert!(quitting.begin(windows(&["main", "capture"])));
        // Un segundo "Salir" mientras tanto no empieza otra salida.
        assert!(!quitting.begin(windows(&["main"])));

        // Las ventanas guardan y avisan, cada una a su tiempo; una que no se esperaba
        // (los ajustes) no molesta.
        let answering = Arc::clone(&quitting);
        let answers = thread::spawn(move || {
            answering.ready("settings");
            thread::sleep(Duration::from_millis(60));
            answering.ready("main");
            thread::sleep(Duration::from_millis(60));
            answering.ready("capture");
        });
        let started = Instant::now();
        assert!(quitting.wait(Duration::from_secs(20), |_| true));
        // Se esperó a las dos, y ni un momento más que eso.
        assert!((Duration::from_millis(100)..Duration::from_secs(10)).contains(&started.elapsed()));
        answers.join().unwrap();
    }

    #[test]
    fn una_ventana_que_no_responde_no_impide_salir() {
        let quitting = Quitting::default();
        assert!(quitting.begin(windows(&["main", "capture"])));
        quitting.ready("main");
        // La hoja suelta no contesta: pasado el tope, se sale igual.
        let started = Instant::now();
        assert!(!quitting.wait(Duration::from_millis(250), |_| true));
        assert!(started.elapsed() >= Duration::from_millis(250));

        // Si la ventana se cerró sin avisar, ni siquiera se la espera.
        let started = Instant::now();
        assert!(quitting.wait(Duration::from_secs(20), |window| window != "capture"));
        assert!(started.elapsed() < Duration::from_secs(10));

        // Y sin ventanas donde se escribe no hay nada que esperar.
        let quitting = Quitting::default();
        assert!(quitting.begin(HashSet::new()));
        assert!(quitting.wait(Duration::from_secs(20), |_| true));
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::path::Path;

    #[test]
    fn el_inicio_con_el_sistema_anota_la_ruta_entre_comillas() {
        // Sin comillas, los espacios de la ruta la partirían en varios argumentos.
        let exe = Path::new(r"C:\Users\ana\Documents\Backup PC vieja\Book\releases\Book-0.6.0.exe");
        assert_eq!(
            super::autostart_command(exe),
            r#""C:\Users\ana\Documents\Backup PC vieja\Book\releases\Book-0.6.0.exe" --hidden"#
        );
    }
}
