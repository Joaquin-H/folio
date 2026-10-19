//! Vigilancia de cambios: después del primer escaneo, el sistema operativo avisa qué
//! archivos cambiaron y solo se releen esos.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::scan::{self, EVENT_CHANGED};
use crate::scanner::ScanConfig;
use crate::{notepad, sticky, Shared};

/// Un archivo se procesa cuando lleva este tiempo sin recibir más avisos.
const QUIET: Duration = Duration::from_millis(1500);

pub struct Handle {
    stop: Arc<AtomicBool>,
    _watcher: Arc<Mutex<RecommendedWatcher>>,
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Un aviso del sistema: la ruta y si lo que pasó fue que apareció o desapareció con ese
/// nombre (se creó, se borró, se movió o se renombró), y no un cambio de contenido.
type Notice = (PathBuf, bool);

pub fn start(app: &AppHandle, shared: &Arc<Shared>) -> Option<Handle> {
    let cfg = Arc::new(ScanConfig::load(&shared.db));
    let (tx, rx) = mpsc::channel::<Notice>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let appeared_or_gone = matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
            );
            for path in event.paths {
                let _ = tx.send((path, appeared_or_gone));
            }
        }
    })
    .ok()?;

    // Cada raíz se vigila sin recursión y sus subcarpetas permitidas con recursión:
    // así el ruido constante de carpetas como AppData ni siquiera llega a la app.
    let mut watched = HashSet::new();
    for root in cfg.roots.iter().filter(|r| r.is_dir()) {
        let _ = watcher.watch(root, RecursiveMode::NonRecursive);
        for child in std::fs::read_dir(root).into_iter().flatten().flatten() {
            let path = child.path();
            if child.file_type().is_ok_and(|t| t.is_dir()) && cfg.dir_allowed(&path) {
                let _ = watcher.watch(&path, RecursiveMode::Recursive);
                watched.insert(path);
            }
        }
    }
    let tabs_dir = notepad::tabstate_dir();
    if let Some(dir) = &tabs_dir {
        let _ = watcher.watch(dir, RecursiveMode::NonRecursive);
    }
    let sticky_dir = sticky::db_path().and_then(|p| p.parent().map(Path::to_path_buf));
    if let Some(dir) = &sticky_dir {
        let _ = watcher.watch(dir, RecursiveMode::NonRecursive);
    }

    let stop = Arc::new(AtomicBool::new(false));
    let watcher = Arc::new(Mutex::new(watcher));
    let worker = Worker {
        app: app.clone(),
        shared: Arc::clone(shared),
        cfg,
        tabs_dir,
        sticky_dir,
        stop: Arc::clone(&stop),
        watcher: Arc::clone(&watcher),
        watched: Mutex::new(watched),
    };
    thread::spawn(move || worker.run(rx));
    Some(Handle { stop, _watcher: watcher })
}

struct Worker {
    app: AppHandle,
    shared: Arc<Shared>,
    cfg: Arc<ScanConfig>,
    tabs_dir: Option<PathBuf>,
    sticky_dir: Option<PathBuf>,
    stop: Arc<AtomicBool>,
    watcher: Arc<Mutex<RecommendedWatcher>>,
    watched: Mutex<HashSet<PathBuf>>,
}

impl Worker {
    fn run(self, rx: mpsc::Receiver<Notice>) {
        let mut pending: HashMap<PathBuf, (Instant, bool)> = HashMap::new();
        while !self.stop.load(Ordering::SeqCst) {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(first) => {
                    let now = Instant::now();
                    for (path, appeared_or_gone) in std::iter::once(first).chain(rx.try_iter()) {
                        // Varios avisos de la misma ruta cuentan como uno; si alguno fue
                        // que apareció o desapareció, eso no se olvida.
                        let entry = pending.entry(path).or_insert((now, false));
                        *entry = (now, entry.1 || appeared_or_gone);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if pending.is_empty() {
                continue;
            }
            let now = Instant::now();
            let mut ready: Vec<Notice> = pending
                .iter()
                .filter(|(_, (at, _))| now.duration_since(*at) >= QUIET)
                .map(|(path, (_, appeared_or_gone))| (path.clone(), *appeared_or_gone))
                .collect();
            if ready.is_empty() {
                continue;
            }
            for (path, _) in &ready {
                pending.remove(path);
            }
            // Primero lo que desapareció: así un renombrado se reconoce como la misma hoja.
            ready.sort_by_key(|(path, _)| path.exists());
            if self.process(&ready) {
                let _ = self.app.emit(EVENT_CHANGED, ());
                self.shared.ping_classifier();
            }
        }
    }

    fn process(&self, notices: &[Notice]) -> bool {
        let db = &self.shared.db;
        let versions = db.version_cfg();
        let mut changed = false;
        let mut sticky_dirty = false;
        for (path, appeared_or_gone) in notices {
            let parent = path.parent();
            if self.tabs_dir.as_deref().is_some_and(|d| parent == Some(d)) {
                changed |= notepad::sync_file(db, path, &versions);
            } else if self.sticky_dir.as_deref().is_some_and(|d| parent == Some(d)) {
                sticky_dirty = true;
            } else {
                if path.is_dir() {
                    self.watch_new_top_level_dir(path);
                }
                changed |= scan::sync_notice(db, &self.cfg, path, *appeared_or_gone, &versions);
            }
        }
        if sticky_dirty {
            changed |= sticky::sync(db, &versions) > 0;
        }
        changed
    }

    /// Una carpeta nueva creada directamente dentro de una raíz todavía no está vigilada.
    fn watch_new_top_level_dir(&self, path: &Path) {
        let is_top_level = self.cfg.roots.iter().any(|root| path.parent() == Some(root.as_path()));
        if !is_top_level || !self.cfg.dir_allowed(path) {
            return;
        }
        let mut watched = self.watched.lock().unwrap_or_else(|e| e.into_inner());
        if watched.insert(path.to_path_buf()) {
            if let Ok(mut watcher) = self.watcher.lock() {
                let _ = watcher.watch(path, RecursiveMode::Recursive);
            }
        }
    }
}
