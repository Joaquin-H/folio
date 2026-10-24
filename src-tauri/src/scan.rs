//! Orquesta el escaneo completo y la sincronización de un archivo. La clasificación de
//! lo que entra al Book está en `classifier`.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

use tauri::{AppHandle, Emitter};

use crate::db::{hash, now_ms, Db, Incoming, Outcome, VersionCfg};
use crate::scanner::{self, Candidate, ScanConfig, CASE_BLIND};
use crate::{notepad, sticky, text, Shared};

pub const EVENT_CHANGED: &str = "book:changed";

/// Archivos ya indexados: ruta -> (fecha, tamaño, id, sin original).
type FileIndex = HashMap<String, (i64, i64, i64, bool)>;

fn file_name(path: &Path) -> Option<String> {
    path.file_name().map(|n| n.to_string_lossy().to_string())
}

/// Lee el archivo y lo deja en el Book. Con `maybe_moved`, antes se fija si es un archivo
/// ya conocido que cambió de lugar (ver `release_moved`).
fn ingest_file(
    db: &Db,
    cfg: &ScanConfig,
    candidate: &Candidate,
    versions: &VersionCfg,
    maybe_moved: bool,
) -> bool {
    let Some(content) = text::read_text(&candidate.path, cfg.max_bytes) else {
        return false;
    };
    if content.trim().is_empty() {
        return false;
    }
    let path = candidate.path.to_string_lossy().to_string();
    if maybe_moved {
        release_moved(db, &path, &content);
    }
    let title = file_name(&candidate.path).unwrap_or_else(|| text::title_from_content(&content));
    let incoming = Incoming {
        source: "file",
        source_key: path.clone(),
        title,
        path: Some(path),
        content,
        size: candidate.size as i64,
        source_mtime: candidate.mtime,
        created_at: candidate.created,
        modified_at: candidate.mtime,
    };
    matches!(db.upsert_sheet(&incoming, versions), Ok(Outcome::Created | Outcome::Updated))
}

/// Un archivo que Book todavía no conoce puede ser uno conocido que se movió o cambió de
/// nombre, y el aviso de que dejó su lugar anterior puede llegar después (o no llegar).
/// Las hojas con este mismo texto cuyo archivo ya no está quedan "sin original" ahora,
/// para que `upsert_sheet` reconozca al archivo nuevo como esa misma hoja.
fn release_moved(db: &Db, key: &str, content: &str) {
    if db.sheet_id("file", key).is_some() {
        return;
    }
    for twin in db.files_with_hash(&hash(content)).unwrap_or_default() {
        if matches!(Path::new(&twin).try_exists(), Ok(false)) {
            db.mark_missing("file", &twin);
        }
    }
}

/// El nombre del archivo tal como está escrito en el disco.
fn name_on_disk(path: &Path) -> Option<OsString> {
    let wanted = path.file_name()?.to_string_lossy().to_lowercase();
    let mut names = std::fs::read_dir(path.parent()?).ok()?.flatten().map(|entry| entry.file_name());
    names.find(|name| name.to_string_lossy().to_lowercase() == wanted)
}

/// Donde el sistema no distingue mayúsculas, un aviso puede traer la ruta escrita distinto
/// de como está indexada: el archivo cambió solo de mayúsculas, o el aviso llegó con la
/// escritura vieja. Deja `candidate` y su hoja con el nombre tal cual está en el disco,
/// para que no aparezca una hoja repetida. Devuelve si la hoja cambió de nombre.
fn settle_spelling(db: &Db, candidate: &mut Candidate) -> bool {
    let key = candidate.path.to_string_lossy().to_string();
    if db.sheet_id("file", &key).is_some() {
        return false;
    }
    let Some((id, twin)) = db.file_twin(&key) else {
        return false;
    };
    let twin = PathBuf::from(twin);
    let real = name_on_disk(&candidate.path);
    // La hoja ya se llama como el archivo: vale su ruta, no la del aviso.
    let Some(real) = real.filter(|real| twin.file_name() != Some(real.as_os_str())) else {
        candidate.path = twin;
        return false;
    };
    candidate.path.set_file_name(real);
    let title = file_name(&candidate.path).unwrap_or_default();
    db.move_file(id, &candidate.path.to_string_lossy(), &title).is_ok()
}

/// Sincroniza un único archivo avisado por el sistema operativo. `true` si el Book cambió.
fn sync_path(db: &Db, cfg: &ScanConfig, path: &Path, versions: &VersionCfg) -> bool {
    if !cfg.file_allowed(path) || !cfg.in_scope(path) {
        return false;
    }
    match std::fs::metadata(path) {
        // Vacío, demasiado grande o "solo en la nube": la hoja, si existe, queda como está.
        Ok(md) => cfg.candidate(path, &md).is_some_and(|mut candidate| {
            let renamed = settle_spelling(db, &mut candidate);
            ingest_file(db, cfg, &candidate, versions, true) || renamed
        }),
        // El archivo ya no está (borrado, movido o renombrado): la hoja queda en el Book.
        Err(_) if matches!(path.try_exists(), Ok(false)) => {
            let key = path.to_string_lossy();
            db.mark_missing("file", &key)
                || db.file_twin(&key).is_some_and(|(_, twin)| db.mark_missing("file", &twin))
        }
        // No se lo pudo mirar (sin permiso, disco que no responde): no se saca conclusiones.
        Err(_) => false,
    }
}

/// Se fue una carpeta (borrada, movida o renombrada): sus archivos se fueron con ella y
/// el sistema no avisa de cada uno. Las hojas quedan en el Book como "sin original";
/// si la carpeta solo cambió de lugar, se las reconoce al encontrarla (`sync_dir`).
fn forget_dir(db: &Db, dir: &Path) -> bool {
    let separator = std::path::MAIN_SEPARATOR;
    let prefix = format!("{}{separator}", dir.to_string_lossy().trim_end_matches(separator));
    let mut changed = false;
    for key in db.file_keys_under(&prefix).unwrap_or_default() {
        if matches!(Path::new(&key).try_exists(), Ok(false)) {
            changed |= db.mark_missing("file", &key);
        }
    }
    changed
}

/// Apareció una carpeta con este nombre (creada, movida o renombrada). El sistema avisa
/// de la carpeta pero no de los archivos que trae adentro: se la recorre como en el
/// escaneo completo. `true` si el Book cambió.
fn sync_dir(db: &Db, cfg: &Arc<ScanConfig>, dir: &Path, versions: &VersionCfg) -> bool {
    // El aviso puede traer el nombre con las mayúsculas de antes.
    let spelled = if CASE_BLIND { name_on_disk(dir) } else { None };
    let dir = spelled.map_or_else(|| dir.to_path_buf(), |name| dir.with_file_name(name));
    if !cfg.dir_in_scope(&dir) {
        return false;
    }
    // Si la carpeta reemplazó a otra con el mismo nombre, lo que ya no está deja su lugar.
    let mut changed = forget_dir(db, &dir);
    let candidates = scanner::walk_dir(cfg, &dir);
    if candidates.is_empty() {
        return changed;
    }
    let mut known = db.file_index().unwrap_or_default();
    let seen: HashSet<String> = candidates.iter().map(|c| c.path.to_string_lossy().to_string()).collect();
    changed |= adopt_spelling(db, &candidates, &mut known, &seen);
    changed | ingest_changed(db, cfg, &candidates, &known, versions, true)
}

/// Donde el sistema no distingue mayúsculas, un archivo (o una carpeta de más arriba) que
/// solo cambió de mayúsculas llega del recorrido con otra escritura, pero es la misma
/// hoja: se le corrige la ruta en vez de darla por desaparecida y crear otra.
fn adopt_spelling(db: &Db, candidates: &[Candidate], known: &mut FileIndex, seen: &HashSet<String>) -> bool {
    if !CASE_BLIND {
        return false;
    }
    let mut unseen: Option<HashMap<String, String>> = None;
    let mut changed = false;
    for candidate in candidates {
        let key = candidate.path.to_string_lossy().to_string();
        if known.contains_key(&key) {
            continue;
        }
        let unseen = unseen.get_or_insert_with(|| {
            known.keys().filter(|k| !seen.contains(*k)).map(|k| (k.to_lowercase(), k.clone())).collect()
        });
        let Some(old) = unseen.remove(&key.to_lowercase()) else {
            continue;
        };
        let Some(entry) = known.get(&old).copied() else {
            continue;
        };
        let title = file_name(&candidate.path).unwrap_or_default();
        if db.move_file(entry.2, &key, &title).is_ok() {
            known.remove(&old);
            known.insert(key, entry);
            changed = true;
        }
    }
    changed
}

/// Relee los archivos nuevos y los que cambiaron de fecha o tamaño. `true` si alguno
/// cambió el Book.
fn ingest_changed(
    db: &Db,
    cfg: &ScanConfig,
    candidates: &[Candidate],
    known: &FileIndex,
    versions: &VersionCfg,
    maybe_moved: bool,
) -> bool {
    let mut changed = false;
    for candidate in candidates {
        let unchanged = known.get(candidate.path.to_string_lossy().as_ref()).is_some_and(|(mtime, size, _, missing)| {
            !*missing && *mtime == candidate.mtime && *size == candidate.size as i64
        });
        if !unchanged {
            changed |= ingest_file(db, cfg, candidate, versions, maybe_moved);
        }
    }
    changed
}

/// Atiende un aviso del sistema sobre una ruta vigilada: un archivo que cambió, apareció o
/// ya no está, o una carpeta que apareció o se fue (`appeared_or_gone`). `true` si el
/// Book cambió.
pub fn sync_notice(
    db: &Db,
    cfg: &Arc<ScanConfig>,
    path: &Path,
    appeared_or_gone: bool,
    versions: &VersionCfg,
) -> bool {
    if path.is_dir() {
        // Los demás avisos de una carpeta son por lo que cambia adentro, y eso ya llega
        // archivo por archivo.
        return appeared_or_gone && sync_dir(db, cfg, path, versions);
    }
    let mut changed = sync_path(db, cfg, path, versions);
    // Si lo que ya no está era una carpeta, sus archivos se fueron con ella.
    if matches!(path.try_exists(), Ok(false)) {
        changed |= forget_dir(db, path);
    }
    changed
}

/// Pone al día el Book con los archivos del disco. Devuelve cuántos encontró.
fn scan_files(db: &Db, cfg: &Arc<ScanConfig>, versions: &VersionCfg) -> usize {
    // Lo indexado se anota antes de recorrer el disco. Una hoja que se crea o cambia de
    // nombre desde Book mientras dura el recorrido no figura acá, y entonces no se toca.
    let known = db.file_index().unwrap_or_default();
    let candidates = scanner::walk(cfg);
    reconcile(db, cfg, versions, known, &candidates);
    candidates.len()
}

/// Compara lo que estaba indexado al empezar (`known`) con lo que se encontró en el disco.
fn reconcile(db: &Db, cfg: &ScanConfig, versions: &VersionCfg, mut known: FileIndex, candidates: &[Candidate]) {
    let seen: HashSet<String> = candidates.iter().map(|c| c.path.to_string_lossy().to_string()).collect();
    adopt_spelling(db, candidates, &mut known, &seen);

    // Primero lo indexado que el recorrido no trajo, y recién después lo nuevo: así un
    // archivo movido o renombrado se reconoce como la misma hoja (ver `upsert_sheet`).
    let mut seen_folded: Option<HashSet<String>> = None;
    for (key, (_, _, id, missing)) in &known {
        if seen.contains(key) {
            continue;
        }
        let path = Path::new(key);
        match path.try_exists() {
            // Desapareció: la hoja se conserva marcada como "sin original".
            Ok(false) => {
                if !*missing {
                    db.mark_missing("file", key);
                }
            }
            // Sigue ahí pero el usuario lo dejó afuera (sacó la carpeta o la excluyó):
            // es lo único que saca una hoja del Book.
            Ok(true) if !cfg.file_allowed(path) || !cfg.in_scope(path) => {
                if cfg.complete {
                    let _ = db.delete_file_sheet(*id, key);
                }
            }
            // Sigue ahí y corresponde indexarlo, pero el recorrido no lo trajo: quedó
            // vacío, pasó el tamaño máximo, está solo en la nube o no se pudo leer. La
            // hoja se conserva con lo último que se supo de ella. La excepción es una
            // hoja repetida: el mismo archivo ya indexado con otras mayúsculas.
            Ok(true) if CASE_BLIND && !*missing => {
                let folded = seen_folded.get_or_insert_with(|| seen.iter().map(|k| k.to_lowercase()).collect());
                if folded.contains(&key.to_lowercase()) {
                    db.mark_missing("file", key);
                }
            }
            // Tampoco se saca conclusiones si no se pudo averiguar si está.
            _ => {}
        }
    }
    ingest_changed(db, cfg, candidates, &known, versions, false);
}

/// ¿Le toca a este hilo escanear? Sí, si hay un pedido sin atender y nadie escanea.
fn claim(scanning: &AtomicBool, wanted: &AtomicBool) -> bool {
    loop {
        if !wanted.load(Ordering::SeqCst) || scanning.swap(true, Ordering::SeqCst) {
            // No hay nada pedido, o hay otro escaneo en marcha: ese hilo verá el pedido.
            return false;
        }
        if wanted.swap(false, Ordering::SeqCst) {
            return true;
        }
        // Otro hilo atendió el pedido justo antes: se suelta el turno y se vuelve a mirar.
        scanning.store(false, Ordering::SeqCst);
    }
}

/// Pide un escaneo y lo hace (`pass`) salvo que ya haya otro en marcha. En ese caso el
/// pedido queda anotado y el que está corriendo, que empezó con los ajustes de antes,
/// hace otra pasada al terminar: así un cambio de carpetas o de exclusiones hecho en medio
/// de un escaneo no se pierde. `done` corre después de cada pasada, ya sin el turno.
fn run_requested(scanning: &AtomicBool, wanted: &AtomicBool, mut pass: impl FnMut(), mut done: impl FnMut()) {
    // El pedido se anota antes de mirar si hay otro escaneo: si se hiciera al revés, el
    // otro podría terminar justo en el medio y el pedido quedaría sin atender.
    wanted.store(true, Ordering::SeqCst);
    while claim(scanning, wanted) {
        pass();
        scanning.store(false, Ordering::SeqCst);
        done();
    }
}

/// Escaneo completo. Solo relee los archivos cuya fecha o tamaño cambiaron.
pub fn run_scan(app: &AppHandle, shared: &Arc<Shared>) {
    let db = &shared.db;
    let pass = || {
        let _ = app.emit(EVENT_CHANGED, ());
        let started = Instant::now();
        // Los ajustes se leen en cada pasada: la segunda existe justamente porque cambiaron.
        let cfg = Arc::new(ScanConfig::load(db));
        let versions = db.version_cfg();
        let files = scan_files(db, &cfg, &versions);
        notepad::sync_all(db, &versions);
        sticky::sync(db, &versions);

        let _ = db.set_setting("last_scan_at", &now_ms().to_string());
        let _ = db.set_setting("last_scan_ms", &started.elapsed().as_millis().to_string());
        let _ = db.set_setting("last_scan_files", &files.to_string());
        db.checkpoint();
        db.compact();
    };
    let done = || {
        let _ = app.emit(EVENT_CHANGED, ());
        shared.ping_classifier();
    };
    run_requested(&shared.scanning, &shared.rescan, pass, done);
}

pub fn spawn_scan(app: &AppHandle, shared: &Arc<Shared>) {
    let app = app.clone();
    let shared = Arc::clone(shared);
    thread::spawn(move || run_scan(&app, &shared));
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::model::SheetDetail;

    /// Carpeta de prueba, vacía y propia de cada test; se borra al terminar.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("book-test-scan-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        /// Ruta de `rel` ("carpeta/archivo.txt") dentro de la carpeta de prueba.
        fn path(&self, rel: &str) -> PathBuf {
            rel.split('/').fold(self.0.clone(), |path, part| path.join(part))
        }

        fn write(&self, rel: &str, text: &str) -> PathBuf {
            let path = self.path(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn db() -> Db {
        Db::open(Path::new(":memory:")).expect("base en memoria")
    }

    fn session() -> VersionCfg {
        VersionCfg { keep: 2, session_gap_ms: 5 * 60_000 }
    }

    /// Los ajustes de la base, mirando solo la carpeta de prueba.
    fn config(db: &Db, dir: &TempDir) -> Arc<ScanConfig> {
        Arc::new(ScanConfig::with_roots(db, vec![dir.0.clone()]))
    }

    fn key(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    fn id_of(db: &Db, path: &Path) -> i64 {
        db.sheet_id("file", &key(path)).unwrap_or_else(|| panic!("no hay hoja para {}", path.display()))
    }

    fn sheet(db: &Db, id: i64) -> SheetDetail {
        db.get_sheet(id).unwrap().unwrap_or_else(|| panic!("la hoja {id} ya no está"))
    }

    /// Cuántas hojas hay en total, estén donde estén.
    fn total(db: &Db) -> i64 {
        let counts = db.counts().unwrap();
        counts.all + counts.secret + counts.hidden
    }

    /// Lo que hace Book al escribir una hoja: el archivo y, enseguida, su hoja.
    fn written_in_book(db: &Db, path: &Path, text: &str) -> i64 {
        fs::write(path, text).unwrap();
        let md = fs::metadata(path).unwrap();
        let mtime = scanner::millis(md.modified()).unwrap();
        let incoming = Incoming {
            source: "file",
            source_key: key(path),
            title: file_name(path).unwrap(),
            path: Some(key(path)),
            content: text.into(),
            size: md.len() as i64,
            source_mtime: mtime,
            created_at: mtime,
            modified_at: mtime,
        };
        db.upsert_written(&incoming, &session()).unwrap();
        id_of(db, path)
    }

    /// Deja el archivo como los "solo en la nube" de OneDrive: está, pero no se lo lee.
    #[cfg(windows)]
    fn leave_in_the_cloud(path: &Path) {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn SetFileAttributesW(name: *const u16, attributes: u32) -> i32;
        }
        const OFFLINE: u32 = 0x0000_1000;
        let name: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        // SAFETY: `name` es una cadena UTF-16 terminada en cero que vive durante la llamada.
        assert_ne!(unsafe { SetFileAttributesW(name.as_ptr(), OFFLINE) }, 0, "no se pudo marcar el archivo");
    }

    #[test]
    fn el_escaneo_no_borra_una_hoja_cuyo_archivo_sigue_en_el_disco() {
        let dir = TempDir::new("sigue");
        let db = db();
        let emptied = dir.write("vaciada.txt", "lo que decía antes de quedar vacía");
        let grown = dir.write("crecida.txt", "una nota corta");
        let cloud = dir.write("nube.txt", "esta va a quedar solo en la nube");
        scan_files(&db, &config(&db, &dir), &session());
        let (emptied_id, grown_id, cloud_id) = (id_of(&db, &emptied), id_of(&db, &grown), id_of(&db, &cloud));
        db.set_sheet_category(emptied_id, Some(1)).unwrap();
        db.snapshot(emptied_id, 2).unwrap();
        db.set_sheet_secret(grown_id, true).unwrap();
        db.set_sheet_hidden(cloud_id, true).unwrap();

        // Una queda en 0 bytes (se le borró todo el texto, o se cortó la luz mientras se
        // guardaba), otra pasa el tamaño máximo y la tercera queda solo en la nube.
        fs::write(&emptied, "").unwrap();
        db.set_setting("max_file_kb", "1").unwrap();
        fs::write(&grown, "x".repeat(4096)).unwrap();
        #[cfg(windows)]
        leave_in_the_cloud(&cloud);
        let cfg = config(&db, &dir);
        // Ni el aviso del sistema ni el escaneo completo las sacan del Book.
        assert!(!sync_notice(&db, &cfg, &emptied, false, &session()));
        assert_eq!(scan_files(&db, &cfg, &session()), if cfg!(windows) { 0 } else { 1 });

        // Siguen con lo último que se supo de ellas, sus marcas y sus versiones.
        let kept = sheet(&db, emptied_id);
        assert_eq!(kept.content, "lo que decía antes de quedar vacía");
        assert_eq!((kept.summary.category_id, kept.versions.len(), kept.summary.missing), (Some(1), 1, false));
        let kept = sheet(&db, grown_id);
        assert_eq!((kept.content.as_str(), kept.summary.secret, kept.summary.missing), ("una nota corta", true, false));
        let kept = sheet(&db, cloud_id);
        assert_eq!((kept.summary.hidden, kept.summary.missing), (true, false));
        assert_eq!(total(&db), 3);

        // Cuando el archivo vuelve a tener texto, es la misma hoja la que se pone al día.
        fs::write(&emptied, "texto nuevo").unwrap();
        scan_files(&db, &cfg, &session());
        assert_eq!(sheet(&db, emptied_id).content, "texto nuevo");
        assert_eq!(total(&db), 3);
    }

    #[test]
    fn lo_que_se_escribe_en_book_durante_el_escaneo_no_se_pierde() {
        // Lo mismo en los tres momentos en que el escaneo puede cruzarse con Book.
        for moment in ["después de recorrer", "antes de recorrer", "a medio renombrar"] {
            let dir = TempDir::new("mientras");
            let db = db();
            let cfg = config(&db, &dir);
            let old = dir.write("vieja.txt", "una hoja que ya estaba");
            scan_files(&db, &cfg, &session());
            let old_id = id_of(&db, &old);
            db.set_sheet_category(old_id, Some(1)).unwrap();
            let (new, renamed) = (dir.path("nueva.txt"), dir.path("renombrada.txt"));

            // El escaneo anota lo indexado y recorre el disco. Mientras tanto, desde Book
            // se crea una hoja y a otra se le cambia el título (archivo y hoja).
            let known = db.file_index().unwrap();
            let walk_then_write = moment == "después de recorrer";
            let mut candidates = if walk_then_write { scanner::walk(&cfg) } else { Vec::new() };
            let new_id = written_in_book(&db, &new, "recién escrita en Book");
            fs::rename(&old, &renamed).unwrap();
            if moment != "a medio renombrar" {
                db.move_file(old_id, &key(&renamed), "renombrada.txt").unwrap();
            }
            if !walk_then_write {
                candidates = scanner::walk(&cfg);
            }
            reconcile(&db, &cfg, &session(), known, &candidates);
            db.move_file(old_id, &key(&renamed), "renombrada.txt").unwrap();

            // Ninguna de las dos se borra, se duplica ni queda como "sin original".
            assert_eq!(total(&db), 2, "{moment}");
            assert_eq!(id_of(&db, &new), new_id, "{moment}");
            assert!(!sheet(&db, new_id).summary.missing, "{moment}");
            let moved = sheet(&db, old_id).summary;
            assert_eq!(moved.path, Some(key(&renamed)), "{moment}");
            assert_eq!((moved.category_id, moved.missing), (Some(1), false), "{moment}");
        }
    }

    #[test]
    fn solo_lo_que_el_usuario_deja_afuera_sale_del_book() {
        let dir = TempDir::new("afuera");
        let db = db();
        let kept = dir.write("notas/a.txt", "esta queda en el cuaderno");
        let excluded = dir.write("privado/b.txt", "la carpeta de esta se va a excluir");
        scan_files(&db, &config(&db, &dir), &session());
        assert_eq!(total(&db), 2);
        db.add_ban("path", &key(&dir.path("privado"))).unwrap();

        // Si no se pudo leer qué carpetas mirar, no se saca nada...
        let mut partial = ScanConfig::with_roots(&db, vec![dir.0.clone()]);
        partial.complete = false;
        scan_files(&db, &Arc::new(partial), &session());
        assert!(db.sheet_id("file", &key(&excluded)).is_some());
        // ...y con la lista completa sale lo excluido, y nada más.
        scan_files(&db, &config(&db, &dir), &session());
        assert!(db.sheet_id("file", &key(&excluded)).is_none());
        assert!(db.sheet_id("file", &key(&kept)).is_some());
    }

    /// Una carpeta con hojas de todo tipo: con categoría y versiones, secreta, en la
    /// papelera y dos con el mismo texto. Devuelve los nombres con el id de cada hoja.
    fn folder_of_notes(db: &Db, dir: &TempDir, cfg: &Arc<ScanConfig>) -> Vec<(&'static str, i64)> {
        let notes = [
            ("lista.txt", "comprar pan y yerba"),
            ("banco.txt", "datos de la cuenta que nadie tiene que ver"),
            ("borrador.txt", "un borrador que ya no sirve"),
            ("uno.txt", "el mismo texto en dos archivos"),
            ("dos.txt", "el mismo texto en dos archivos"),
        ];
        for (name, text) in notes {
            dir.write(&format!("apuntes/{name}"), text);
        }
        scan_files(db, cfg, &session());
        let ids: Vec<(&str, i64)> =
            notes.iter().map(|(name, _)| (*name, id_of(db, &dir.path(&format!("apuntes/{name}"))))).collect();
        db.set_sheet_category(ids[0].1, Some(1)).unwrap();
        db.snapshot(ids[0].1, 2).unwrap();
        db.set_sheet_secret(ids[1].1, true).unwrap();
        db.set_sheet_hidden(ids[2].1, true).unwrap();
        db.set_sheet_category(ids[3].1, Some(2)).unwrap();
        db.set_sheet_category(ids[4].1, Some(3)).unwrap();
        ids
    }

    /// Cada archivo sigue siendo la misma hoja, ahora en `folder`, con todo lo que tenía.
    fn assert_followed(db: &Db, dir: &TempDir, folder: &str, ids: &[(&str, i64)], case: &str) {
        for (name, id) in ids {
            assert_eq!(id_of(db, &dir.path(&format!("{folder}/{name}"))), *id, "{case}: {name}");
            assert!(!sheet(db, *id).summary.missing, "{case}: {name}");
        }
        assert_eq!(total(db), ids.len() as i64, "{case}");
        let listed = sheet(db, ids[0].1);
        assert_eq!((listed.summary.category_id, listed.versions.len()), (Some(1), 1), "{case}");
        assert!(sheet(db, ids[1].1).summary.secret, "{case}");
        assert!(sheet(db, ids[2].1).summary.hidden, "{case}");
        // Las dos del mismo texto no se intercambian lo suyo.
        assert_eq!(sheet(db, ids[3].1).summary.category_id, Some(2), "{case}");
        assert_eq!(sheet(db, ids[4].1).summary.category_id, Some(3), "{case}");
    }

    #[test]
    fn una_carpeta_renombrada_con_book_cerrado_conserva_sus_hojas() {
        let dir = TempDir::new("cerrado");
        let db = db();
        let cfg = config(&db, &dir);
        let ids = folder_of_notes(&db, &dir, &cfg);

        fs::rename(dir.path("apuntes"), dir.path("cuadernos")).unwrap();
        scan_files(&db, &cfg, &session());
        assert_followed(&db, &dir, "cuadernos", &ids, "renombrada");

        // Lo mismo si se la mueve adentro de otra.
        fs::create_dir_all(dir.path("archivo")).unwrap();
        fs::rename(dir.path("cuadernos"), dir.path("archivo/cuadernos")).unwrap();
        scan_files(&db, &cfg, &session());
        assert_followed(&db, &dir, "archivo/cuadernos", &ids, "movida");
    }

    #[test]
    fn el_aviso_de_una_carpeta_renombrada_alcanza_para_seguir_sus_hojas() {
        // Con Book abierto el sistema avisa de la carpeta, no de cada archivo. Los dos
        // avisos (se fue con un nombre, apareció con otro) pueden llegar en cualquier orden.
        for gone_first in [true, false] {
            let case = if gone_first { "primero se fue" } else { "primero apareció" };
            let dir = TempDir::new("abierto");
            let db = db();
            let cfg = config(&db, &dir);
            let ids = folder_of_notes(&db, &dir, &cfg);
            let (old, new) = (dir.path("apuntes"), dir.path("cuadernos"));
            fs::rename(&old, &new).unwrap();

            // Un aviso por algo que cambió adentro de la carpeta no hace nada.
            assert!(!sync_notice(&db, &cfg, &new, false, &session()));
            let order = if gone_first { [&old, &new] } else { [&new, &old] };
            assert!(sync_notice(&db, &cfg, order[0], true, &session()), "{case}");
            sync_notice(&db, &cfg, order[1], true, &session());
            assert_followed(&db, &dir, "cuadernos", &ids, case);

            // Si después la carpeta se borra, las hojas quedan en el Book "sin original".
            fs::remove_dir_all(&new).unwrap();
            assert!(sync_notice(&db, &cfg, &new, true, &session()), "{case}");
            assert_eq!(total(&db), ids.len() as i64, "{case}");
            for (name, id) in &ids {
                assert!(sheet(&db, *id).summary.missing, "{case}: {name}");
            }
            assert_eq!(sheet(&db, ids[0].1).content, "comprar pan y yerba");
        }
    }

    #[test]
    fn un_archivo_movido_se_reconoce_aunque_el_aviso_del_nuevo_llegue_primero() {
        let dir = TempDir::new("movido");
        let db = db();
        let cfg = config(&db, &dir);
        let old = dir.write("idea.txt", "una idea para no perder");
        scan_files(&db, &cfg, &session());
        let id = id_of(&db, &old);
        db.set_sheet_secret(id, true).unwrap();

        let new = dir.path("guardadas/idea.txt");
        fs::create_dir_all(new.parent().unwrap()).unwrap();
        fs::rename(&old, &new).unwrap();
        assert!(sync_notice(&db, &cfg, &new, true, &session()));
        sync_notice(&db, &cfg, &old, true, &session());
        assert_eq!((total(&db), id_of(&db, &new)), (1, id));
        let moved = sheet(&db, id).summary;
        assert_eq!((moved.secret, moved.missing), (true, false));

        // Una copia, en cambio, es otra hoja: no le saca nada a la original.
        let copy = dir.path("copia.txt");
        fs::copy(&new, &copy).unwrap();
        assert!(sync_notice(&db, &cfg, &copy, true, &session()));
        assert_eq!((total(&db), id_of(&db, &new)), (2, id));
        assert!(!sheet(&db, id_of(&db, &copy)).summary.secret);
        assert!(!sheet(&db, id).summary.missing);
    }

    #[cfg(windows)]
    #[test]
    fn cambiar_solo_las_mayusculas_no_duplica_la_hoja() {
        let dir = TempDir::new("mayusculas");
        let db = db();
        let cfg = config(&db, &dir);
        dir.write("notas/idea.txt", "una idea para no perder");
        scan_files(&db, &cfg, &session());
        let id = id_of(&db, &dir.path("notas/idea.txt"));
        db.set_sheet_category(id, Some(1)).unwrap();
        let same_sheet = |path: &str, case: &str| {
            assert_eq!((total(&db), id_of(&db, &dir.path(path))), (1, id), "{case}");
            let summary = sheet(&db, id).summary;
            assert_eq!((summary.category_id, summary.missing), (Some(1), false), "{case}");
        };

        // La carpeta, con Book cerrado: el escaneo trae la ruta escrita de otra forma.
        fs::rename(dir.path("notas"), dir.path("Notas")).unwrap();
        scan_files(&db, &cfg, &session());
        same_sheet("Notas/idea.txt", "carpeta");

        // El archivo, con Book abierto: llegan avisos con los dos nombres, en cualquier orden.
        fs::rename(dir.path("Notas/idea.txt"), dir.path("Notas/Idea.txt")).unwrap();
        sync_notice(&db, &cfg, &dir.path("Notas/idea.txt"), true, &session());
        sync_notice(&db, &cfg, &dir.path("Notas/Idea.txt"), true, &session());
        same_sheet("Notas/Idea.txt", "archivo");
        fs::rename(dir.path("Notas/Idea.txt"), dir.path("Notas/IDEA.txt")).unwrap();
        sync_notice(&db, &cfg, &dir.path("Notas/IDEA.txt"), true, &session());
        sync_notice(&db, &cfg, &dir.path("Notas/Idea.txt"), true, &session());
        same_sheet("Notas/IDEA.txt", "archivo, al revés");

        // Y la carpeta con Book abierto, también con los dos nombres.
        fs::rename(dir.path("Notas"), dir.path("NOTAS")).unwrap();
        sync_notice(&db, &cfg, &dir.path("NOTAS"), true, &session());
        sync_notice(&db, &cfg, &dir.path("Notas"), true, &session());
        same_sheet("NOTAS/IDEA.txt", "carpeta, con aviso");
        scan_files(&db, &cfg, &session());
        same_sheet("NOTAS/IDEA.txt", "escaneo posterior");

        // Una hoja repetida que hubiera dejado una versión anterior (el mismo archivo
        // indexado con otras mayúsculas) no se borra: queda aparte, como "sin original".
        let stale = written_in_book(&db, &dir.path("NOTAS/idea.txt"), "una idea para no perder");
        scan_files(&db, &cfg, &session());
        assert_eq!(total(&db), 2);
        assert!(sheet(&db, stale).summary.missing);
        assert!(!sheet(&db, id).summary.missing);
    }

    #[test]
    fn un_pedido_de_escaneo_durante_otro_no_se_pierde() {
        let (scanning, wanted) = (AtomicBool::new(false), AtomicBool::new(false));
        let (mut passes, mut finished) = (0, 0);
        let pass = || {
            passes += 1;
            if passes == 1 {
                // Mientras corre el primero se cambian las carpetas y se pide otro: no
                // arranca en paralelo, queda anotado.
                run_requested(&scanning, &wanted, || panic!("dos escaneos a la vez"), || {});
                assert!(scanning.load(Ordering::SeqCst));
            }
        };
        run_requested(&scanning, &wanted, pass, || finished += 1);
        // El que estaba corriendo hizo una pasada más, con los ajustes nuevos.
        assert_eq!((passes, finished), (2, 2));
        assert!(!scanning.load(Ordering::SeqCst) && !wanted.load(Ordering::SeqCst));

        // Sin pedidos en el medio, un escaneo es una sola pasada.
        let mut passes = 0;
        run_requested(&scanning, &wanted, || passes += 1, || {});
        assert_eq!(passes, 1);
    }
}
