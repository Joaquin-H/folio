//! Recorrido del disco: qué carpetas se visitan y qué archivos cuentan como hoja.

use std::collections::HashSet;
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::time::UNIX_EPOCH;

use ignore::{WalkBuilder, WalkState};
use regex::Regex;

use crate::db::Db;

const EXTENSIONS: [&str; 3] = ["txt", "md", "markdown"];

/// Windows y macOS no distinguen mayúsculas de minúsculas en las rutas: `Notas.txt` y
/// `notas.txt` son el mismo archivo.
pub const CASE_BLIND: bool = cfg!(any(windows, target_os = "macos"));

pub struct ScanConfig {
    pub roots: Vec<PathBuf>,
    /// `false` si no se pudo leer de la base qué carpetas mirar. Con la lista incompleta
    /// no se saca nada del Book: parecería que el usuario dejó afuera lo que no dejó.
    pub complete: bool,
    banned_dirs: HashSet<String>,
    /// Carpetas concretas excluidas: (ruta normalizada, ruta normalizada + separador).
    banned_paths: Vec<(String, String)>,
    banned_files: Vec<Regex>,
    ignore_dot_dirs: bool,
    ignore_git_repos: bool,
    pub max_bytes: u64,
}

pub struct Candidate {
    pub path: PathBuf,
    pub mtime: i64,
    pub created: i64,
    pub size: u64,
}

fn normalize(path: &Path) -> String {
    path.to_string_lossy()
        .to_lowercase()
        .trim_end_matches(['\\', '/'])
        .to_string()
}

/// Patrón con comodín `*` -> regex anclada e insensible a mayúsculas.
fn glob_to_regex(pattern: &str) -> Option<Regex> {
    let body = regex::escape(pattern.trim()).replace(r"\*", ".*");
    Regex::new(&format!("(?i)^{body}$")).ok()
}

pub(crate) fn millis(time: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    time.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

/// Los archivos "solo en la nube" (OneDrive) se descargarían al leerlos: se saltean.
#[cfg(windows)]
fn is_cloud_placeholder(md: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const OFFLINE: u32 = 0x0000_1000;
    const RECALL_ON_OPEN: u32 = 0x0004_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    md.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
}

#[cfg(not(windows))]
fn is_cloud_placeholder(_md: &Metadata) -> bool {
    false
}

impl ScanConfig {
    pub fn load(db: &Db) -> Self {
        let listed = db.roots();
        let complete = listed.is_ok();
        let mut roots: Vec<PathBuf> =
            listed.unwrap_or_default().into_iter().map(|r| PathBuf::from(r.path)).collect();
        // Las hojas escritas en Book siempre cuentan, aunque su carpeta no cuelgue de
        // ninguna de las elegidas por el usuario.
        if let Some(notes) = crate::notes_dir() {
            if notes.is_dir() && !roots.iter().any(|root| notes.starts_with(root)) {
                roots.push(notes);
            }
        }
        Self { complete, ..Self::with_roots(db, roots) }
    }

    /// Las exclusiones y los límites salen de los ajustes; las carpetas a mirar son `roots`.
    pub(crate) fn with_roots(db: &Db, roots: Vec<PathBuf>) -> Self {
        let mut banned_dirs = HashSet::new();
        let mut banned_paths = Vec::new();
        let mut banned_files = Vec::new();
        for ban in db.bans().unwrap_or_default().into_iter().filter(|b| b.enabled) {
            match ban.kind.as_str() {
                "dir" => {
                    banned_dirs.insert(ban.pattern.trim().to_lowercase());
                }
                "path" => {
                    let exact = normalize(Path::new(ban.pattern.trim()));
                    let prefix = format!("{exact}{}", std::path::MAIN_SEPARATOR);
                    banned_paths.push((exact, prefix));
                }
                "file" => banned_files.extend(glob_to_regex(&ban.pattern)),
                _ => {}
            }
        }
        Self {
            roots,
            complete: true,
            banned_dirs,
            banned_paths,
            banned_files,
            ignore_dot_dirs: db.get_bool("ignore_dot_dirs", true),
            ignore_git_repos: db.get_bool("ignore_git_repos", true),
            max_bytes: db.get_i64("max_file_kb", 1024).clamp(1, 65_536) as u64 * 1024,
        }
    }

    /// ¿Se entra en esta carpeta? No se aplica a las raíces elegidas por el usuario.
    pub fn dir_allowed(&self, path: &Path) -> bool {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            return false;
        };
        let lower = name.to_lowercase();
        if self.banned_dirs.contains(&lower) {
            return false;
        }
        if self.ignore_dot_dirs && lower.starts_with('.') {
            return false;
        }
        if !self.banned_paths.is_empty() {
            let full = normalize(path);
            if self
                .banned_paths
                .iter()
                .any(|(exact, prefix)| full == *exact || full.starts_with(prefix))
            {
                return false;
            }
        }
        if self.ignore_git_repos && path.join(".git").exists() {
            return false;
        }
        true
    }

    pub fn file_allowed(&self, path: &Path) -> bool {
        let ext_ok = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)));
        if !ext_ok {
            return false;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            return false;
        };
        !self.banned_files.iter().any(|re| re.is_match(name))
    }

    /// ¿El archivo cae dentro de alguna raíz sin atravesar carpetas excluidas?
    pub fn in_scope(&self, path: &Path) -> bool {
        self.roots.iter().any(|root| {
            let Ok(rel) = path.strip_prefix(root) else {
                return false;
            };
            let parts: Vec<_> = rel.components().collect();
            let mut current = root.clone();
            for part in &parts[..parts.len().saturating_sub(1)] {
                current.push(part);
                if !self.dir_allowed(&current) {
                    return false;
                }
            }
            true
        })
    }

    /// Lo mismo para una carpeta: ¿el recorrido entraría en ella?
    pub fn dir_in_scope(&self, dir: &Path) -> bool {
        self.in_scope(&dir.join("_"))
    }

    pub fn candidate(&self, path: &Path, md: &Metadata) -> Option<Candidate> {
        if !md.is_file() || md.len() == 0 || md.len() > self.max_bytes || is_cloud_placeholder(md) {
            return None;
        }
        let mtime = millis(md.modified())?;
        Some(Candidate {
            path: path.to_path_buf(),
            mtime,
            created: millis(md.created()).unwrap_or(mtime),
            size: md.len(),
        })
    }
}

/// Recorre las raíces en paralelo y devuelve los archivos que pueden ser hojas.
/// Usa pocos hilos a propósito: es una tarea de fondo, no debe frenar la PC.
pub fn walk(cfg: &Arc<ScanConfig>) -> Vec<Candidate> {
    walk_from(cfg, cfg.roots.iter().map(PathBuf::as_path))
}

/// Recorre una sola carpeta (y lo que cuelga de ella) con las mismas reglas que el
/// escaneo completo. Vacío si el escaneo no entraría en esa carpeta.
pub fn walk_dir(cfg: &Arc<ScanConfig>, dir: &Path) -> Vec<Candidate> {
    if !cfg.dir_in_scope(dir) {
        return Vec::new();
    }
    walk_from(cfg, std::iter::once(dir))
}

fn walk_from<'a>(cfg: &Arc<ScanConfig>, dirs: impl Iterator<Item = &'a Path>) -> Vec<Candidate> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).min(4);
    let (tx, rx) = mpsc::channel();
    for root in dirs.filter(|r| r.is_dir()) {
        let filter_cfg = Arc::clone(cfg);
        let walker = WalkBuilder::new(root)
            .standard_filters(false)
            .follow_links(false)
            .threads(threads)
            .filter_entry(move |entry| {
                if entry.depth() == 0 {
                    return true;
                }
                match entry.file_type() {
                    Some(ft) if ft.is_dir() => filter_cfg.dir_allowed(entry.path()),
                    _ => true,
                }
            })
            .build_parallel();
        walker.run(|| {
            let tx = tx.clone();
            let cfg = Arc::clone(cfg);
            Box::new(move |entry| {
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry.file_type().is_some_and(|ft| ft.is_file()) || !cfg.file_allowed(entry.path()) {
                    return WalkState::Continue;
                }
                if let Ok(md) = entry.metadata() {
                    if let Some(candidate) = cfg.candidate(entry.path(), &md) {
                        let _ = tx.send(candidate);
                    }
                }
                WalkState::Continue
            })
        });
    }
    drop(tx);
    rx.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::glob_to_regex;

    #[test]
    fn comodines_de_nombre_de_archivo() {
        let re = glob_to_regex("README*").unwrap();
        assert!(re.is_match("readme.md"));
        assert!(re.is_match("README-es.txt"));
        assert!(!re.is_match("mi readme.md"));
        let re = glob_to_regex("requirements*.txt").unwrap();
        assert!(re.is_match("requirements-dev.txt"));
        assert!(!re.is_match("requirements.md"));
    }
}
