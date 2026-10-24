//! Comandos que la interfaz invoca. Todos son `async` para no ocupar el hilo de la ventana.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::classifier::Wake;
use crate::db::{hash, now_ms, Db, Incoming};
use crate::integrations::{self, Tool};
use crate::model::*;
use crate::scan::{self, EVENT_CHANGED};
use crate::provider::{self, Engine, Provider};
use crate::send::Target;
use crate::{restart_watcher, scanner, text, Shared};

type Res<T> = Result<T, String>;
type Ctx<'a> = State<'a, Arc<Shared>>;

fn e<E: std::fmt::Display>(err: E) -> String {
    let s = err.to_string();
    if let Some(pos) = s.find("Conversion to SQL type failed: ") {
        return s[pos + "Conversion to SQL type failed: ".len()..].to_string();
    }
    if let Some(pos) = s.find("User-defined function threw error: ") {
        return s[pos + "User-defined function threw error: ".len()..].to_string();
    }
    s
}

fn notify_changed(app: &AppHandle) {
    let _ = app.emit(EVENT_CHANGED, ());
}

/// Cómo está el clasificador: qué IA se usa, la clave y el modelo de cada una, y lo pendiente.
/// (Los ajustes y contadores conservan sus nombres `jev_*`: valen para cualquiera de las IAs.)
fn jev_status(shared: &Shared) -> JevStatus {
    let db = &shared.db;
    let now = now_ms();
    let (calls_today, calls_total) = db.jev_calls(now);
    let engine = Engine::from_db(db);
    let providers: Vec<ProviderStatus> = Provider::ALL
        .iter()
        .map(|&provider| ProviderStatus {
            id: provider.id().to_string(),
            has_key: provider::load_key(provider).is_some(),
            key_from_env: provider::key_from_env(provider).is_some(),
            model: provider::model(db, provider),
        })
        .collect();
    let active = providers.iter().find(|status| status.id == engine.provider.id());
    let has_key = active.is_some_and(|status| status.has_key);
    JevStatus {
        enabled: db.get_bool("jev_enabled", false),
        has_key,
        key_from_env: active.is_some_and(|status| status.key_from_env),
        ready: engine.is_ready(has_key),
        provider: engine.provider.id().to_string(),
        providers,
        ollama_url: engine.url,
        pending: db.pending_count(now, &db.jev_policy()),
        error: shared.jev_error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        calls_today,
        calls_total,
    }
}

/// Cambió qué carpetas se miran: se reinicia la vigilancia y se vuelve a escanear.
fn scope_changed(app: &AppHandle, shared: &Arc<Shared>) {
    restart_watcher(app, shared);
    scan::spawn_scan(app, shared);
}

// ---- hojas ---------------------------------------------------------------

#[tauri::command]
pub async fn list_sheets(state: Ctx<'_>, filter: ListFilter) -> Res<Vec<SheetSummary>> {
    state.db.list_sheets(&filter).map_err(e)
}

#[tauri::command]
pub async fn list_days(state: Ctx<'_>, filter: ListFilter) -> Res<Vec<DayCount>> {
    state.db.list_days(&filter).map_err(e)
}

#[tauri::command]
pub async fn get_sheet(state: Ctx<'_>, id: i64) -> Res<Option<SheetDetail>> {
    state.db.get_sheet(id).map_err(e)
}

#[tauri::command]
pub async fn get_overview(state: Ctx<'_>) -> Res<Overview> {
    let db = &state.db;
    let notes_dir = crate::notes_dir();
    let clippings_category_id = db.clippings_category_id();
    let untagged_clippings_count = db.untagged_clippings(notes_dir.as_deref()).map(|v| v.len()).unwrap_or(0);
    Ok(Overview {
        counts: db.counts().map_err(e)?,
        categories: db.categories().map_err(e)?,
        scan: ScanStatus {
            running: state.scanning.load(Ordering::SeqCst),
            last_scan_at: db.get_setting("last_scan_at").and_then(|v| v.parse().ok()),
            last_scan_ms: db.get_setting("last_scan_ms").and_then(|v| v.parse().ok()),
            last_scan_files: db.get_setting("last_scan_files").and_then(|v| v.parse().ok()),
        },
        jev: jev_status(&state),
        notes_dir: notes_dir.map(|dir| dir.to_string_lossy().to_string()).unwrap_or_default(),
        clippings_category_id,
        untagged_clippings_count,
    })
}

#[tauri::command]
pub async fn ensure_clippings_category(state: Ctx<'_>) -> Res<i64> {
    state.db.ensure_clippings_category().map_err(e)
}

#[tauri::command]
pub async fn migrate_clippings(app: AppHandle, state: Ctx<'_>) -> Res<usize> {
    let notes_dir = crate::notes_dir();
    let count = state.db.migrate_clippings(notes_dir.as_deref()).map_err(e)?;
    notify_changed(&app);
    Ok(count)
}

#[tauri::command]
pub async fn set_sheet_category(
    app: AppHandle,
    state: Ctx<'_>,
    id: i64,
    category_id: Option<i64>,
) -> Res<()> {
    state.db.set_sheet_category(id, category_id).map_err(e)?;
    notify_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn set_sheet_secret(app: AppHandle, state: Ctx<'_>, id: i64, secret: bool) -> Res<()> {
    state.db.set_sheet_secret(id, secret).map_err(e)?;
    notify_changed(&app);
    // Al salir del secret-book puede que le falte pasar por el clasificador.
    state.ping_classifier();
    Ok(())
}

#[tauri::command]
pub async fn set_sheet_hidden(app: AppHandle, state: Ctx<'_>, id: i64, hidden: bool) -> Res<()> {
    state.db.set_sheet_hidden(id, hidden).map_err(e)?;
    notify_changed(&app);
    // Lo mismo al volver de la papelera.
    state.ping_classifier();
    Ok(())
}

#[tauri::command]
pub async fn set_sheet_pinned(app: AppHandle, state: Ctx<'_>, id: i64, pinned: bool) -> Res<()> {
    state.db.set_sheet_pinned(id, pinned).map_err(e)?;
    notify_changed(&app);
    Ok(())
}

// ---- escribir en Book ------------------------------------------------------

/// Lo que devuelve un guardado cuando el original cambió por fuera mientras se lo editaba.
const CONFLICT: &str = "CONFLICT";

/// El turno para escribir un archivo de la carpeta de Book. Guardar una hoja (leer el
/// archivo, comparar, escribir) y agregarle un recorte de «Enviar lo seleccionado al Book»
/// no pueden pasar a la vez: si el recorte entrara entre la lectura y la escritura del
/// guardado, el guardado lo pisaría. No lo toma nada que espere a la interfaz.
static WRITING: Mutex<()> = Mutex::new(());

pub(crate) fn writing() -> MutexGuard<'static, ()> {
    WRITING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Lo que sigue a escribir un archivo en la carpeta de Book sin pasar por la interfaz: si la
/// carpeta es nueva hay que empezar a vigilarla, el cuaderno se entera y el clasificador mira.
pub(crate) fn wrote_note(app: &AppHandle, shared: &Arc<Shared>, first_note: bool) {
    if first_note {
        // La carpeta no existía cuando empezó la vigilancia: hay que sumarla.
        restart_watcher(app, shared);
    }
    notify_changed(app);
    shared.ping_classifier();
}

/// Quita de un título lo que no puede ir en un nombre de archivo.
fn safe_stem(name: &str) -> Option<String> {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .take(80)
        .collect();
    let stem = cleaned.trim().trim_matches('.').trim();
    if stem.is_empty() {
        return None;
    }
    // Windows reserva algunos nombres (CON, NUL, COM1...) aunque lleven extensión.
    let base = stem.split('.').next().unwrap_or("").trim().to_ascii_uppercase();
    let numbered = |prefix: &str| {
        base.strip_prefix(prefix)
            .is_some_and(|rest| rest.len() == 1 && rest.chars().all(|c| c.is_ascii_digit()))
    };
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered("COM") || numbered("LPT");
    Some(if reserved { format!("_{stem}") } else { stem.to_string() })
}

/// Escribe `<dir>\<nombre>.<ext>` (.txt o .md) y devuelve su ruta. No pisa un archivo existente ni usa
/// el nombre que una hoja de Folio tiene como original, aunque ese archivo ya no esté
/// (la hoja "sin original" se conserva tal cual): en esos casos numera el nombre.
pub(crate) fn write_new_file(db: &Db, dir: &Path, name: &str, content: &str) -> Res<PathBuf> {
    let raw_name = name.trim();
    let (stem_candidate, ext) = if let Some(stripped) = raw_name.strip_suffix(".md").or_else(|| raw_name.strip_suffix(".MD")) {
        (stripped, "md")
    } else if let Some(stripped) = raw_name.strip_suffix(".txt").or_else(|| raw_name.strip_suffix(".TXT")) {
        (stripped, "txt")
    } else {
        let fmt = db.get_setting("note_format").unwrap_or_else(|| "txt".to_string());
        let ext = if fmt.eq_ignore_ascii_case("md") { "md" } else { "txt" };
        (raw_name, ext)
    };
    let stem = safe_stem(stem_candidate).ok_or("El nombre de la hoja no sirve como nombre de archivo")?;
    std::fs::create_dir_all(dir).map_err(e)?;
    // Saltos de línea de Windows, que es lo que espera el Bloc de notas.
    let body = text::normalize_newlines(content);
    let body = if cfg!(windows) { body.replace('\n', "\r\n") } else { body };
    let mut path = dir.join(format!("{stem}.{ext}"));
    let mut copy = 2;
    loop {
        if db.file_key_owner(&path.to_string_lossy()).is_none() {
            // `create_new` falla si el archivo ya existe: no hay forma de pisar otro.
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    if let Err(err) = file.write_all(body.as_bytes()) {
                        // No queda un archivo vacío con el nombre de una hoja que no existe.
                        drop(file);
                        let _ = std::fs::remove_file(&path);
                        return Err(e(err));
                    }
                    return Ok(path);
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(err) => return Err(e(err)),
            }
        }
        path = dir.join(format!("{stem} ({copy}).{ext}"));
        copy += 1;
    }
}

/// Registra en el Book el archivo tal como quedó en el disco y devuelve el id de su hoja.
pub(crate) fn index_file(db: &Db, path: &Path, content: String) -> Res<i64> {
    let md = std::fs::metadata(path).map_err(e)?;
    let key = path.to_string_lossy().to_string();
    let mtime = scanner::millis(md.modified()).unwrap_or_else(now_ms);
    let incoming = Incoming {
        source: "file",
        source_key: key.clone(),
        title: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| text::title_from_content(&content)),
        path: Some(key.clone()),
        content,
        size: md.len() as i64,
        source_mtime: mtime,
        created_at: scanner::millis(md.created()).unwrap_or(mtime),
        modified_at: mtime,
    };
    // Lo escrito desde Book no toma el lugar de una hoja huérfana (ver `upsert_written`).
    db.upsert_written(&incoming, &db.version_cfg()).map_err(e)?;
    db.sheet_id("file", &key).ok_or_else(|| "No se pudo registrar la hoja".to_string())
}

/// Crea el archivo de una hoja nueva en `dir` y la registra. Devuelve su id y su ruta.
fn new_note(db: &Db, dir: &Path, title: &str, content: &str) -> Res<(i64, PathBuf)> {
    let _turn = writing();
    let trimmed = title.trim();
    let is_en = db.get_setting("locale").as_deref() == Some("en");
    let name = if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("notas") || trimmed.eq_ignore_ascii_case("notes") {
        text::title_from_content_localized(content, is_en)
    } else {
        trimmed.to_string()
    };
    let path = write_new_file(db, dir, &name, content)?;
    let id = index_file(db, &path, content.to_string())?;
    Ok((id, path))
}

fn detail(shared: &Shared, id: i64) -> Res<SheetDetail> {
    shared.db.get_sheet(id).map_err(e)?.ok_or_else(|| "La hoja ya no existe".to_string())
}

/// Hoja escrita en Book. Por detrás es un archivo de texto en `Documentos\Book`, con el
/// título como nombre: se puede abrir con cualquier editor y no depende de Book. Si se
/// la crea mirando una categoría, nace en ella. Con `open`, además se abre en el editor
/// del sistema (el Bloc de notas, salvo que el usuario haya elegido otro).
#[tauri::command]
pub async fn create_note(
    app: AppHandle,
    state: Ctx<'_>,
    title: String,
    content: String,
    category_id: Option<i64>,
    open: bool,
) -> Res<SheetDetail> {
    let content = text::normalize_newlines(content.trim_end());
    if content.trim().is_empty() {
        return Err("La hoja está vacía".into());
    }
    let dir = crate::notes_dir().ok_or("No se encontró la carpeta de documentos")?;
    let first_note = !dir.is_dir();
    let (id, path) = new_note(&state.db, &dir, &title, &content)?;
    if let Some(category) = category_id {
        state.db.set_sheet_category(id, Some(category)).map_err(e)?;
    }
    wrote_note(&app, &state, first_note);
    if open {
        app.opener().open_path(path.to_string_lossy().to_string(), None::<&str>).map_err(e)?;
    }
    detail(&state, id)
}

/// Guarda lo que se editó de una hoja desde Book. Si es un archivo, se escribe en el
/// original respetando su codificación y sus saltos de línea. `base_hash` es la huella
/// del contenido que se empezó a editar: si el archivo cambió por fuera mientras tanto,
/// no se pisa (salvo con `force`, y entonces lo de afuera queda como versión anterior).
/// Con `title`, las hojas que viven en la carpeta de Book además cambian de nombre.
#[tauri::command]
pub async fn save_sheet(
    app: AppHandle,
    state: Ctx<'_>,
    id: i64,
    content: String,
    title: Option<String>,
    base_hash: Option<String>,
    force: bool,
) -> Res<SheetDetail> {
    let notes_dir = crate::notes_dir();
    let saved = save(&state.db, notes_dir.as_deref(), id, &content, title.as_deref(), base_hash.as_deref(), force);
    // También si el original había cambiado por fuera: eso ya entró al Book.
    if saved.is_ok() || saved.as_ref().is_err_and(|reason| reason == CONFLICT) {
        notify_changed(&app);
    }
    saved?;
    state.ping_classifier();
    detail(&state, id)
}

/// El guardado en sí, sin la ventana. `notes_dir` es la carpeta de Book: solo ahí el
/// título le cambia el nombre al archivo. Toma el turno de las escrituras de archivos
/// (`writing`) de punta a punta: lo que se lee del archivo es lo que se pisa.
pub(crate) fn save(
    db: &Db,
    notes_dir: Option<&Path>,
    id: i64,
    content: &str,
    title: Option<&str>,
    base_hash: Option<&str>,
    force: bool,
) -> Res<()> {
    let _turn = writing();
    let origin = db.origin(id).map_err(e)?.ok_or("La hoja ya no existe")?;
    if origin.hidden {
        return Err("La hoja está en la papelera: recuperala para poder editarla".into());
    }
    let content = text::normalize_newlines(content);
    match origin.source.as_str() {
        "file" => {
            let mut path = PathBuf::from(origin.path.as_deref().unwrap_or(&origin.key));
            if origin.missing || !path.is_file() {
                return Err("El archivo original ya no está en su lugar".into());
            }
            let bytes = std::fs::read(&path).map_err(e)?;
            let on_disk = text::decode(&bytes).ok_or("El archivo original ya no es de texto")?;
            // El nombre nuevo se resuelve antes de tocar nada. Si el título no sirve, el
            // guardado falla entero y el original queda como estaba: con el texto ya
            // escrito, el guardado siguiente creería que el archivo cambió por fuera.
            let renamed = match title {
                Some(title) => rename_target(db, notes_dir, id, &path, title)?,
                None => None,
            };
            let changed_outside = base_hash.is_some_and(|base| base != hash(&on_disk));
            if changed_outside {
                // Lo que hay en el disco entra al Book para que no se pierda de vista.
                index_file(db, &path, on_disk.clone())?;
                if !force {
                    return Err(CONFLICT.into());
                }
                db.snapshot(id, db.version_cfg().keep).map_err(e)?;
            }
            // Primero el nombre y después el texto: si algo falla en el medio, el archivo
            // todavía dice lo mismo que cuando se lo empezó a editar.
            if let Some(renamed) = renamed {
                std::fs::rename(&path, &renamed).map_err(e)?;
                let name = renamed.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if let Err(err) = db.move_file(id, &renamed.to_string_lossy(), &name) {
                    // La hoja no pudo tomar el nombre: el archivo vuelve al que tenía.
                    let _ = std::fs::rename(&renamed, &path);
                    return Err(format!("No se pudo cambiar el nombre de la hoja: {err}"));
                }
                path = renamed;
            }
            if content != on_disk {
                let encoded = text::encode_like(&content, &bytes).ok_or("El archivo original ya no es de texto")?;
                std::fs::write(&path, encoded).map_err(e)?;
            }
            index_file(db, &path, content)?;
        }
        "capture" => {
            let now = now_ms();
            let incoming = Incoming {
                source: "capture",
                source_key: origin.key,
                title: text::title_from_content(&content),
                path: None,
                size: content.len() as i64,
                content,
                source_mtime: now,
                created_at: origin.created_at,
                modified_at: now,
            };
            db.upsert_sheet(&incoming, &db.version_cfg()).map_err(e)?;
        }
        "notepad" => {
            return Err("Esta hoja es una pestaña sin guardar del Bloc de notas: guardala como archivo para editarla desde Folio".into())
        }
        _ => return Err("Esta hoja no se puede editar desde Folio".into()),
    }
    Ok(())
}

/// A dónde hay que mover el archivo de la hoja `id` para que se llame como el título
/// nuevo. `None` si no corresponde renombrar: solo cambian de nombre las hojas de la
/// carpeta de Book (`notes_dir`), y solo si el título de verdad es otro. No escribe nada:
/// se lo llama antes de guardar, para que un título que no sirve no deje nada a medias.
fn rename_target(db: &Db, notes_dir: Option<&Path>, id: i64, path: &Path, title: &str) -> Res<Option<PathBuf>> {
    let Some(dir) = path.parent().filter(|dir| notes_dir == Some(*dir)) else {
        return Ok(None);
    };
    let stem = safe_stem(title).ok_or("El nombre de la hoja no sirve como nombre de archivo")?;
    if path.file_stem().is_some_and(|current| current.to_string_lossy() == stem) {
        return Ok(None);
    }
    let extension = path.extension().map(|ext| ext.to_string_lossy().to_string()).unwrap_or_else(|| "txt".into());
    // Cambiar solo mayúsculas es el mismo archivo para Windows: eso sí se permite.
    let same_file = |target: &Path| target.to_string_lossy().to_lowercase() == path.to_string_lossy().to_lowercase();
    let wanted = dir.join(format!("{stem}.{extension}"));
    if wanted.exists() && !same_file(&wanted) {
        return Err("Ya hay un archivo con ese nombre".into());
    }
    // Sin archivo, el nombre igual puede ser el original de otra hoja del Book (uno que
    // se borró por fuera: la hoja quedó "sin original"). Esa hoja no se pisa ni se
    // mezcla con esta: el nombre se numera, igual que al crear una hoja.
    let taken = |target: &Path| db.file_key_owner(&target.to_string_lossy()).is_some_and(|owner| owner != id);
    if !taken(&wanted) {
        return Ok(Some(wanted));
    }
    let mut copy = 2;
    loop {
        let numbered = dir.join(format!("{stem} ({copy}).{extension}"));
        if same_file(&numbered) {
            // Ya se llama así por un guardado anterior.
            return Ok(None);
        }
        if !numbered.exists() && !taken(&numbered) {
            return Ok(Some(numbered));
        }
        copy += 1;
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// Una carpeta de Book de prueba (vacía, propia de cada test) con su base en memoria.
    struct Notes {
        dir: PathBuf,
        db: Db,
    }

    impl Notes {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("book-test-notas-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            Self { dir, db: Db::open(Path::new(":memory:")).expect("base en memoria") }
        }

        fn create(&self, title: &str, text: &str) -> (i64, PathBuf) {
            new_note(&self.db, &self.dir, title, text).expect("hoja nueva")
        }

        /// Guarda como lo hace el cuaderno: con la huella del texto del que se partió.
        fn save(&self, id: i64, text: &str, title: Option<&str>, base: &str) -> Res<()> {
            save(&self.db, Some(&self.dir), id, text, title, Some(base), false)
        }

        fn sheet(&self, id: i64) -> SheetDetail {
            self.db.get_sheet(id).unwrap().expect("la hoja sigue en el Book")
        }

        /// El archivo se borra por fuera de Book, y la vigilancia lo anota.
        fn delete_outside(&self, path: &Path) {
            fs::remove_file(path).unwrap();
            assert!(self.db.mark_missing("file", &key(path)));
        }
    }

    impl Drop for Notes {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn key(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn crea_el_archivo_sin_pisar_otro_y_con_nombre_seguro() {
        let Notes { dir, db } = &Notes::new("crear");
        let newline = if cfg!(windows) { "\r\n" } else { "\n" };

        let first = write_new_file(db, dir, "notas-2026-10-10", "uno\ndos").unwrap();
        assert_eq!(first.file_name().unwrap(), "notas-2026-10-10.txt");
        assert_eq!(fs::read_to_string(&first).unwrap(), format!("uno{newline}dos"));

        // Mismo nombre: no pisa, numera.
        let second = write_new_file(db, dir, "notas-2026-10-10", "otra").unwrap();
        assert_eq!(second.file_name().unwrap(), "notas-2026-10-10 (2).txt");

        // Los separadores de ruta se descartan: no se puede escribir fuera de la carpeta.
        let escaped = write_new_file(db, dir, "..\\..\\fuera/de:la*carpeta", "x").unwrap();
        assert_eq!(escaped.parent().unwrap(), dir);
        assert_eq!(escaped.file_name().unwrap(), "fueradelacarpeta.txt");
        assert!(write_new_file(db, dir, "///", "x").is_err());
    }

    #[test]
    fn renombrar_al_nombre_de_una_hoja_sin_original_no_rompe_ninguna_de_las_dos() {
        let notes = Notes::new("renombrar");
        let (gone, gone_path) = notes.create("ideas", "la idea de antes");
        notes.delete_outside(&gone_path);
        let (id, old_path) = notes.create("otra", "otra nota");
        let base = notes.sheet(id).hash;

        // «ideas.txt» no está en el disco, pero sigue siendo el original de la otra hoja:
        // esta toma el nombre numerado y el guardado no falla.
        notes.save(id, "otra nota, con algo más", Some("ideas"), &base).unwrap();
        let new_path = notes.dir.join("ideas (2).txt");
        let saved = notes.sheet(id);
        assert_eq!(saved.summary.path, Some(key(&new_path)));
        assert_eq!((saved.summary.title.as_str(), saved.summary.missing), ("ideas (2).txt", false));
        assert_eq!(saved.content, "otra nota, con algo más");
        assert_eq!(fs::read_to_string(&new_path).unwrap(), "otra nota, con algo más");
        assert!(!old_path.exists() && !gone_path.exists());
        // La que quedó sin original sigue como estaba.
        let orphan = notes.sheet(gone);
        assert_eq!((orphan.content.as_str(), orphan.summary.missing), ("la idea de antes", true));
        assert_eq!(orphan.summary.path, Some(key(&gone_path)));

        // Los guardados siguientes, con el mismo título, no la vuelven a mover.
        notes.save(id, "otra nota, con algo más y más", Some("ideas"), &saved.hash).unwrap();
        assert_eq!(notes.sheet(id).summary.path, Some(key(&new_path)));
        assert_eq!(fs::read_to_string(&new_path).unwrap(), "otra nota, con algo más y más");
    }

    #[test]
    fn un_titulo_que_no_se_puede_usar_no_deja_el_texto_a_medio_guardar() {
        let notes = Notes::new("titulo");
        let (id, path) = notes.create("uno", "texto de uno");
        notes.create("dos", "texto de dos");
        let base = notes.sheet(id).hash;

        // Ya hay un archivo con ese nombre, o el título no sirve como nombre: no se
        // escribe nada, ni en el archivo ni en el Book.
        for title in ["dos", "///"] {
            assert!(notes.save(id, "texto de uno, editado", Some(title), &base).is_err(), "{title}");
            assert_eq!(fs::read_to_string(&path).unwrap(), "texto de uno", "{title}");
            assert_eq!(notes.sheet(id).hash, base, "{title}");
        }
        // Con un título que sí sirve, ese mismo guardado entra: no hay un falso "el
        // archivo cambió fuera de Book".
        notes.save(id, "texto de uno, editado", Some("tres"), &base).unwrap();
        let renamed = notes.dir.join("tres.txt");
        assert_eq!(fs::read_to_string(&renamed).unwrap(), "texto de uno, editado");
        assert_eq!(notes.sheet(id).summary.path, Some(key(&renamed)));
        assert!(!path.exists());
    }

    #[test]
    fn una_hoja_nueva_no_hereda_la_papelera_ni_el_secret_book() {
        let notes = Notes::new("nueva");
        // Una hoja que se tiró a la papelera y cuyo archivo después se borró por fuera.
        let (trashed, trashed_path) = notes.create("ideas", "algo que se tiró");
        notes.db.set_sheet_hidden(trashed, true).unwrap();
        notes.delete_outside(&trashed_path);

        // Otra con el mismo título es una hoja nueva: a la vista y con su propio archivo...
        let (id, path) = notes.create("ideas", "una idea nueva");
        assert_ne!(id, trashed);
        assert_eq!(path.file_name().unwrap(), "ideas (2).txt");
        assert!(!notes.sheet(id).summary.hidden);
        // ...que se puede seguir escribiendo.
        notes.save(id, "una idea nueva, con otro renglón", None, &notes.sheet(id).hash).unwrap();
        // La de la papelera sigue ahí, sin tocar.
        let kept = notes.sheet(trashed);
        assert_eq!((kept.content.as_str(), kept.summary.hidden, kept.summary.missing), ("algo que se tiró", true, true));

        // Tampoco hereda nada por tener el mismo texto que una hoja huérfana: ni de un
        // archivo secreto que ya no está, ni de una pestaña del Bloc de notas descartada.
        let (secret, secret_path) = notes.create("privada", "el mismo texto");
        notes.db.set_sheet_secret(secret, true).unwrap();
        notes.delete_outside(&secret_path);
        let tab = Incoming {
            source: "notepad",
            source_key: "guid-1".into(),
            title: "otro texto repetido".into(),
            path: None,
            content: "otro texto repetido".into(),
            size: 19,
            source_mtime: 1,
            created_at: 1,
            modified_at: 1,
        };
        notes.db.upsert_sheet(&tab, &notes.db.version_cfg()).unwrap();
        let tab_id = notes.db.sheet_id("notepad", "guid-1").unwrap();
        notes.db.set_sheet_hidden(tab_id, true).unwrap();
        for text in ["el mismo texto", "otro texto repetido"] {
            let (copy, _) = notes.create("repetida", text);
            let summary = notes.sheet(copy).summary;
            assert!(copy != secret && copy != tab_id, "{text}");
            assert_eq!((summary.secret, summary.hidden), (false, false), "{text}");
        }
        assert!(notes.sheet(secret).summary.secret);
    }

    #[cfg(windows)]
    #[test]
    fn cambiar_solo_las_mayusculas_del_titulo_renombra_la_misma_hoja() {
        let notes = Notes::new("mayusculas");
        let (id, _) = notes.create("pendientes", "comprar pan");
        notes.save(id, "comprar pan", Some("Pendientes"), &notes.sheet(id).hash).unwrap();
        let names: Vec<String> =
            fs::read_dir(&notes.dir).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, ["Pendientes.txt"]);
        let renamed = notes.sheet(id).summary;
        assert_eq!((renamed.title.as_str(), renamed.missing), ("Pendientes.txt", false));
    }

    #[test]
    fn los_titulos_se_vuelven_nombres_de_archivo_validos() {
        assert_eq!(safe_stem("  Reunión del lunes (2)  ").as_deref(), Some("Reunión del lunes (2)"));
        assert_eq!(safe_stem("¿qué falta? 50% listo").as_deref(), Some("¿qué falta 50% listo"));
        assert_eq!(safe_stem("con").as_deref(), Some("_con"));
        assert_eq!(safe_stem("COM1.viejo").as_deref(), Some("_COM1.viejo"));
        assert_eq!(safe_stem("comida").as_deref(), Some("comida"));
        assert_eq!(safe_stem(" .. "), None);
    }

    #[test]
    fn desde_una_hoja_solo_se_abren_paginas_web_y_correo() {
        for url in ["https://example.com/a?b=1", "http://localhost:8080", "HTTPS://EJEMPLO.COM", "mailto:alguien@example.com"] {
            assert!(openable(url), "{url}");
        }
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "C:\\Windows\\notepad.exe",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "https://",
            "https://ejemplo.com/con espacio",
            "https://ejemplo.com/\u{0}",
            "notas.md",
        ] {
            assert!(!openable(url), "{url}");
        }
    }

    #[test]
    fn expandir_y_colapsar_hoja_flotante_respeta_bordes_y_apila_iconos() {
        // Icono colapsado cerca del borde izquierdo (x = 12): debe expandir hacia la derecha, nunca quedar negativo.
        let r_left = compute_floating_rect(0.0, 0.0, 1920.0, 1040.0, 12.0, 100.0, 52.0, false, None, None, &[]);
        assert_eq!(r_left.x, 12.0);
        assert_eq!(r_left.y, 100.0);
        assert_eq!(r_left.width, FLOATING_EXPANDED_W);
        assert_eq!(r_left.height, FLOATING_EXPANDED_H);

        // Icono colapsado cerca del borde derecho (x = 1860): debe expandir hacia la izquierda, dentro de work_area.
        let r_right = compute_floating_rect(0.0, 0.0, 1920.0, 1040.0, 1860.0, 100.0, 52.0, false, None, None, &[]);
        assert!(r_right.x + r_right.width <= 1920.0 - 8.0);
        assert_eq!(r_right.x, 1860.0 + 52.0 - FLOATING_EXPANDED_W);

        // Icono colapsado cerca del borde inferior (y = 980): debe expandir hacia arriba y quedar dentro de work_area.
        let r_bottom = compute_floating_rect(0.0, 0.0, 1920.0, 1040.0, 100.0, 980.0, 52.0, false, None, None, &[]);
        assert!(r_bottom.y >= 8.0);
        assert!(r_bottom.y + r_bottom.height <= 1040.0 - 8.0);

        // Al colapsar varias hojas en la misma posición, se apilan sin superponerse.
        let c1 = compute_floating_rect(0.0, 0.0, 1920.0, 1040.0, 1400.0, 120.0, FLOATING_EXPANDED_W, true, None, None, &[]);
        let c2 = compute_floating_rect(
            0.0,
            0.0,
            1920.0,
            1040.0,
            1400.0,
            120.0,
            FLOATING_EXPANDED_W,
            true,
            None,
            None,
            &[(c1.x, c1.y)],
        );
        let c3 = compute_floating_rect(
            0.0,
            0.0,
            1920.0,
            1040.0,
            1400.0,
            120.0,
            FLOATING_EXPANDED_W,
            true,
            None,
            None,
            &[(c1.x, c1.y), (c2.x, c2.y)],
        );
        assert_eq!(c1.x, c2.x);
        assert!((c2.y - c1.y).abs() >= FLOATING_COLLAPSED_SIZE);
        assert!((c3.y - c2.y).abs() >= FLOATING_COLLAPSED_SIZE);
    }
}

/// Fija de una sola vez la posición y el tamaño de la ventana (borde exterior, en
/// píxeles físicos). Hacerlo en un único paso evita que se la vea moverse y recién
/// después cambiar de tamaño.
#[cfg(windows)]
fn set_window_rect(window: &tauri::WebviewWindow, x: i32, y: i32, width: i32, height: i32) -> Res<()> {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    }
    const NO_Z_ORDER: u32 = 0x0004;
    const NO_ACTIVATE: u32 = 0x0010;
    let hwnd = window.hwnd().map_err(e)?.0 as isize;
    // SAFETY: `hwnd` es el identificador de una ventana viva de esta misma aplicación.
    let done = unsafe { SetWindowPos(hwnd, 0, x, y, width, height, NO_Z_ORDER | NO_ACTIVATE) };
    if done == 0 {
        return Err("No se pudo cambiar el tamaño de la ventana".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_window_rect(window: &tauri::WebviewWindow, x: i32, y: i32, width: i32, height: i32) -> Res<()> {
    window.set_size(tauri::PhysicalSize::new(width.max(1) as u32, height.max(1) as u32)).map_err(e)?;
    window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(e)
}

pub(crate) const FLOATING_EXPANDED_W: f64 = 440.0;
pub(crate) const FLOATING_EXPANDED_H: f64 = 572.0;
pub(crate) const FLOATING_COLLAPSED_SIZE: f64 = 52.0;
const FLOATING_STACK_GAP: f64 = 8.0;
const FLOATING_EDGE_PAD: f64 = 8.0;

/// Calcula hacia dónde expandir o colapsar una ventana flotante (hoja suelta o arrancada)
/// dentro del área útil del monitor (`work_area`) y la acomoda sin superponer íconos colapsados.
pub(crate) fn compute_floating_rect(
    work_left: f64,
    work_top: f64,
    work_width: f64,
    work_height: f64,
    current_x: f64,
    current_y: f64,
    current_w: f64,
    target_collapsed: bool,
    saved_x: Option<f64>,
    saved_y: Option<f64>,
    occupied_collapsed: &[(f64, f64)],
) -> FloatingRect {
    let min_x = work_left + FLOATING_EDGE_PAD;
    let min_y = work_top + FLOATING_EDGE_PAD;
    let right = work_left + work_width - FLOATING_EDGE_PAD;
    let bottom = work_top + work_height - FLOATING_EDGE_PAD;
    let mid_x = work_left + work_width / 2.0;

    if !target_collapsed {
        let w = FLOATING_EXPANDED_W;
        let h = FLOATING_EXPANDED_H;
        let max_x = (right - w).max(min_x);
        let max_y = (bottom - h).max(min_y);

        let was_collapsed = current_w <= FLOATING_COLLAPSED_SIZE + 20.0;
        let (raw_x, raw_y) = if was_collapsed {
            // Al expandir desde el ícono colapsado, abrimos hacia el lado donde hay espacio
            // en el monitor actual, manteniendo anclado el borde más cercano al borde de la pantalla.
            let space_right = right - current_x;
            let space_left = (current_x + FLOATING_COLLAPSED_SIZE) - min_x;
            let expand_left = (current_x + FLOATING_COLLAPSED_SIZE / 2.0 > mid_x && space_left >= w)
                || (space_right < w && space_left > space_right);
            let tx = if expand_left {
                current_x + FLOATING_COLLAPSED_SIZE - w
            } else {
                current_x
            };
            let space_down = bottom - current_y;
            let space_up = (current_y + FLOATING_COLLAPSED_SIZE) - min_y;
            let expand_up = space_down < h && space_up > space_down;
            let ty = if expand_up {
                current_y + FLOATING_COLLAPSED_SIZE - h
            } else {
                current_y
            };
            (tx, ty)
        } else {
            (saved_x.unwrap_or(current_x), saved_y.unwrap_or(current_y))
        };

        FloatingRect {
            x: raw_x.clamp(min_x, max_x).round(),
            y: raw_y.clamp(min_y, max_y).round(),
            width: w,
            height: h,
            collapsed: false,
        }
    } else {
        let s = FLOATING_COLLAPSED_SIZE;
        let max_x = (right - s).max(min_x);
        let max_y = (bottom - s).max(min_y);

        let was_expanded = current_w > FLOATING_COLLAPSED_SIZE + 20.0;
        let (raw_x, raw_y) = if let (Some(sx), Some(sy)) = (saved_x, saved_y) {
            (sx, sy)
        } else if was_expanded {
            // Si la hoja expandida está en la mitad derecha de la pantalla, colapsa hacia su borde derecho;
            // si está en la mitad izquierda, colapsa hacia su borde izquierdo.
            let center_x = current_x + current_w / 2.0;
            let tx = if center_x > mid_x {
                current_x + current_w - s
            } else {
                current_x
            };
            (tx, current_y)
        } else {
            (current_x, current_y)
        };

        let mut x = raw_x.clamp(min_x, max_x).round();
        let mut y = raw_y.clamp(min_y, max_y).round();

        // Apilar íconos colapsados sin superponerse.
        let step = s + FLOATING_STACK_GAP;
        let overlaps = |cx: f64, cy: f64| {
            occupied_collapsed
                .iter()
                .any(|&(ox, oy)| (cx - ox).abs() < s - 2.0 && (cy - oy).abs() < s - 2.0)
        };
        if overlaps(x, y) {
            let mut placed = false;
            // Primero probamos hacia abajo en la misma columna, luego hacia arriba, y si no, desplazando X.
            for col in 0..6 {
                let try_x = if col == 0 {
                    x
                } else if x + (col as f64) * step <= max_x {
                    x + (col as f64) * step
                } else {
                    (x - (col as f64) * step).max(min_x)
                };
                let mut try_y = y;
                while try_y <= max_y {
                    if !overlaps(try_x, try_y) {
                        x = try_x.round();
                        y = try_y.round();
                        placed = true;
                        break;
                    }
                    try_y += step;
                }
                if placed {
                    break;
                }
                let mut try_y = y - step;
                while try_y >= min_y {
                    if !overlaps(try_x, try_y) {
                        x = try_x.round();
                        y = try_y.round();
                        placed = true;
                        break;
                    }
                    try_y -= step;
                }
                if placed {
                    break;
                }
            }
        }

        FloatingRect {
            x,
            y,
            width: s,
            height: s,
            collapsed: true,
        }
    }
}

/// Posiciones lógicas de todas las demás ventanas flotantes que están colapsadas en este momento.
pub(crate) fn other_collapsed_positions(app: &AppHandle, exclude_label: &str) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    for (label, win) in app.webview_windows() {
        if label == exclude_label {
            continue;
        }
        if label != "capture" && !label.starts_with("tearoff-") {
            continue;
        }
        let Ok(scale) = win.scale_factor() else { continue };
        let scale = if scale > 0.0 { scale } else { 1.0 };
        let Ok(size) = win.inner_size() else { continue };
        let lw = f64::from(size.width) / scale;
        if lw <= FLOATING_COLLAPSED_SIZE + 20.0 {
            if let Ok(pos) = win.outer_position() {
                out.push((f64::from(pos.x) / scale, f64::from(pos.y) / scale));
            }
        }
    }
    out
}

/// Aplica el modo expandido o colapsado a una ventana flotante respetando el `work_area` del
/// monitor actual y apilando los íconos colapsados sin superponerlos.
pub(crate) fn apply_floating_mode(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    collapsed: bool,
    preferred_x: Option<f64>,
    preferred_y: Option<f64>,
) -> Res<FloatingRect> {
    let scale = window.scale_factor().map_err(e)?;
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let outer = window.outer_position().map_err(e)?;
    let inner_size = window.inner_size().map_err(e)?;
    let current_x = f64::from(outer.x) / scale;
    let current_y = f64::from(outer.y) / scale;
    let current_w = f64::from(inner_size.width) / scale;

    let (work_left, work_top, work_w, work_h) = if let Some(monitor) = window.current_monitor().map_err(e)? {
        let area = monitor.work_area();
        (
            f64::from(area.position.x) / scale,
            f64::from(area.position.y) / scale,
            f64::from(area.size.width) / scale,
            f64::from(area.size.height) / scale,
        )
    } else {
        (0.0, 0.0, 1920.0, 1040.0)
    };

    let occupied = if collapsed {
        other_collapsed_positions(app, window.label())
    } else {
        Vec::new()
    };

    let rect = compute_floating_rect(
        work_left,
        work_top,
        work_w,
        work_h,
        current_x,
        current_y,
        current_w,
        collapsed,
        preferred_x,
        preferred_y,
        &occupied,
    );

    let phys_x = (rect.x * scale).round() as i32;
    let phys_y = (rect.y * scale).round() as i32;
    let phys_w = (rect.width * scale).round() as i32;
    let phys_h = (rect.height * scale).round() as i32;
    set_window_rect(window, phys_x, phys_y, phys_w, phys_h)?;
    if !collapsed {
        let _ = window.set_focus();
    }
    Ok(rect)
}

#[tauri::command]
pub async fn set_floating_mode(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: Ctx<'_>,
    collapsed: bool,
    preferred_x: Option<f64>,
    preferred_y: Option<f64>,
) -> Res<FloatingRect> {
    let rect = apply_floating_mode(&app, &window, collapsed, preferred_x, preferred_y)?;
    if let Some(id_str) = window.label().strip_prefix("tearoff-") {
        if let Ok(id) = id_str.parse::<i64>() {
            update_saved_torn_off(&state.db, id, Some(collapsed), None, Some(rect.x), Some(rect.y));
        }
    }
    Ok(rect)
}

const TORN_OFF_KEY: &str = "torn_off_sheets";

pub(crate) fn load_torn_off_sheets(db: &Db) -> Vec<TornOffSheetState> {
    db.get_setting(TORN_OFF_KEY)
        .and_then(|raw| serde_json::from_str::<Vec<TornOffSheetState>>(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn save_torn_off_sheets(db: &Db, list: &[TornOffSheetState]) {
    if let Ok(json) = serde_json::to_string(list) {
        let _ = db.set_setting(TORN_OFF_KEY, &json);
    }
}

pub(crate) fn upsert_torn_off(db: &Db, entry: TornOffSheetState) {
    let mut list = load_torn_off_sheets(db);
    if let Some(existing) = list.iter_mut().find(|item| item.id == entry.id) {
        *existing = entry;
    } else {
        list.push(entry);
    }
    save_torn_off_sheets(db, &list);
}

pub(crate) fn update_saved_torn_off(
    db: &Db,
    id: i64,
    collapsed: Option<bool>,
    pinned: Option<bool>,
    x: Option<f64>,
    y: Option<f64>,
) {
    let mut list = load_torn_off_sheets(db);
    if let Some(item) = list.iter_mut().find(|item| item.id == id) {
        if let Some(c) = collapsed {
            item.collapsed = c;
        }
        if let Some(p) = pinned {
            item.pinned = p;
        }
        if let (Some(px), Some(py)) = (x, y) {
            if item.collapsed {
                item.collapsed_x = Some(px);
                item.collapsed_y = Some(py);
            } else {
                item.expanded_x = Some(px);
                item.expanded_y = Some(py);
            }
        }
        save_torn_off_sheets(db, &list);
    }
}

pub(crate) fn remove_torn_off(db: &Db, id: i64) {
    let mut list = load_torn_off_sheets(db);
    let before = list.len();
    list.retain(|item| item.id != id);
    if list.len() != before {
        save_torn_off_sheets(db, &list);
    }
}

#[tauri::command]
pub async fn tear_off_sheet(
    app: AppHandle,
    state: Ctx<'_>,
    id: i64,
    collapsed: Option<bool>,
) -> Res<TornOffSheetState> {
    crate::open_tear_off_window(&app, &state, id, collapsed)
}

#[tauri::command]
pub async fn return_torn_off_sheet(app: AppHandle, state: Ctx<'_>, id: i64) -> Res<()> {
    remove_torn_off(&state.db, id);
    let label = format!("tearoff-{id}");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.destroy();
    }
    notify_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn list_torn_off_sheets(state: Ctx<'_>) -> Res<Vec<TornOffSheetState>> {
    Ok(load_torn_off_sheets(&state.db))
}

#[tauri::command]
pub async fn update_torn_off_state(
    state: Ctx<'_>,
    id: i64,
    collapsed: Option<bool>,
    pinned: Option<bool>,
    x: Option<f64>,
    y: Option<f64>,
) -> Res<()> {
    update_saved_torn_off(&state.db, id, collapsed, pinned, x, y);
    Ok(())
}

/// Dónde quedaría el interior de la ventana (píxeles físicos: x, y, ancho, alto) si se
/// la corriera `dx, dy` desde donde está y se le diera ese tamaño. Igual que
/// `fit_window`, no deja que el cuaderno se salga del área útil de la pantalla.
fn target_rect(window: &tauri::WebviewWindow, dx: f64, dy: f64, width: f64, height: f64) -> Res<(i32, i32, i32, i32)> {
    let scale = window.scale_factor().map_err(e)?;
    let inner = window.inner_position().map_err(e)?;
    let (w, h) = ((width * scale).round() as i32, (height * scale).round() as i32);
    let mut x = inner.x + (dx * scale).round() as i32;
    let mut y = inner.y + (dy * scale).round() as i32;
    if let Some(monitor) = window.current_monitor().map_err(e)? {
        let area = monitor.work_area();
        let (left, top) = (area.position.x, area.position.y);
        x = x.min(left + area.size.width as i32 - w).max(left);
        y = y.min(top + area.size.height as i32 - h).max(top);
    }
    Ok((x, y, w, h))
}

/// Lleva la ventana, en un solo paso, al tamaño y al lugar elegidos al estirarla a mano:
/// `dx, dy` es cuánto se corre su esquina de arriba a la izquierda (píxeles lógicos).
#[tauri::command]
pub async fn place_window(window: tauri::WebviewWindow, dx: f64, dy: f64, width: f64, height: f64) -> Res<()> {
    let (x, y, w, h) = target_rect(&window, dx, dy, width, height)?;
    let outer = window.outer_position().map_err(e)?;
    let inner = window.inner_position().map_err(e)?;
    let outer_size = window.outer_size().map_err(e)?;
    let inner_size = window.inner_size().map_err(e)?;
    // El borde invisible que Windows le agrega a la ventana no cuenta para el cuaderno.
    set_window_rect(
        &window,
        x - (inner.x - outer.x),
        y - (inner.y - outer.y),
        w + outer_size.width as i32 - inner_size.width as i32,
        h + outer_size.height as i32 - inner_size.height as i32,
    )
}

/// Muestra el fantasma del cuaderno donde quedaría con ese cambio: los mismos datos que
/// `place_window`, más la franja de mesa que rodea al cuaderno dentro de la ventana
/// (`inset`: izquierda, arriba, derecha, abajo) para dibujar solo el cuaderno.
#[tauri::command]
pub async fn show_ghost(
    window: tauri::WebviewWindow,
    dx: f64,
    dy: f64,
    width: f64,
    height: f64,
    inset: [f64; 4],
) -> Res<()> {
    let (x, y, w, h) = target_rect(&window, dx, dy, width, height)?;
    let scale = window.scale_factor().map_err(e)?;
    let [left, top, right, bottom] = inset.map(|side| (side * scale).round() as i32);
    crate::ghost::show(x + left, y + top, w - left - right, h - top - bottom, (32.0 * scale).round() as i32);
    Ok(())
}

#[tauri::command]
pub async fn hide_ghost() -> Res<()> {
    crate::ghost::hide();
    Ok(())
}

/// Lleva la ventana del cuaderno al tamaño pedido y la deja entera dentro de la pantalla:
/// si al agrandarse se pasaría de un borde (o quedaría debajo de la barra de tareas),
/// se corre lo necesario. Con `center`, además la centra.
#[tauri::command]
pub async fn fit_window(
    window: tauri::WebviewWindow,
    state: Ctx<'_>,
    width: f64,
    height: f64,
    center: bool,
) -> Res<()> {
    window.set_size(tauri::LogicalSize::new(width, height)).map_err(e)?;
    let center = state.center_next.swap(false, Ordering::SeqCst) || center;
    let Some(monitor) = window.current_monitor().map_err(e)? else {
        return Ok(());
    };
    let scale = window.scale_factor().map_err(e)?;
    let area = monitor.work_area();
    let (left, top) = (f64::from(area.position.x), f64::from(area.position.y));
    let (right, bottom) = (left + f64::from(area.size.width), top + f64::from(area.size.height));
    let (w, h) = (width * scale, height * scale);
    // Windows rodea la ventana con un borde invisible: lo que tiene que quedar dentro de la
    // pantalla es el cuaderno, así que las cuentas se hacen sobre el área interior.
    let current = window.outer_position().map_err(e)?;
    let inner = window.inner_position().map_err(e)?;
    let (border_x, border_y) = (f64::from(inner.x - current.x), f64::from(inner.y - current.y));
    let (mut x, mut y) = (f64::from(inner.x), f64::from(inner.y));
    if center {
        x = left + (right - left - w) / 2.0;
        y = top + (bottom - top - h) / 2.0;
    }
    // Primero contra el borde derecho e inferior y después contra el izquierdo y superior:
    // si la ventana no entra, lo que queda a la vista es su esquina de arriba a la izquierda.
    x = x.min(right - w).max(left);
    y = y.min(bottom - h).max(top);
    let target = tauri::PhysicalPosition::new((x - border_x).round() as i32, (y - border_y).round() as i32);
    if target != current {
        window.set_position(target).map_err(e)?;
    }
    Ok(())
}

/// Cierra Book del todo: deja de vigilar las carpetas hasta la próxima vez que se abra.
/// La ventana que lo pide ya guardó lo suyo; a las demás se les da tiempo para hacerlo.
#[tauri::command]
pub async fn quit_app(app: AppHandle, window: tauri::WebviewWindow) -> Res<()> {
    crate::quit_book(&app, Some(window.label()));
    Ok(())
}

/// Una ventana responde al aviso de salida (`book:quit`): ya guardó lo pendiente.
#[tauri::command]
pub async fn quit_ready(window: tauri::WebviewWindow, state: Ctx<'_>) -> Res<()> {
    state.quitting.ready(window.label());
    Ok(())
}

/// Abre los ajustes en su propia ventana.
#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Res<()> {
    crate::open_settings_window(&app).map_err(e)
}

/// Hojas cuyo original (archivo o pestaña) ya no existe.
#[tauri::command]
pub async fn list_missing(state: Ctx<'_>) -> Res<Vec<MissingSheet>> {
    state.db.list_missing().map_err(e)
}

#[tauri::command]
pub async fn open_original(app: AppHandle, state: Ctx<'_>, id: i64, reveal: bool) -> Res<()> {
    let sheet = state.db.get_sheet(id).map_err(e)?.ok_or("La hoja ya no existe")?;
    let path = sheet.summary.path.ok_or("Esta hoja no tiene un archivo original")?;
    if !Path::new(&path).exists() {
        return Err("El archivo original ya no está en esa ubicación".into());
    }
    if reveal {
        app.opener().reveal_item_in_dir(&path).map_err(e)
    } else {
        app.opener().open_path(path, None::<&str>).map_err(e)
    }
}

/// Direcciones que se pueden abrir desde una hoja: páginas web y correo. Nada de
/// archivos, carpetas ni programas, aunque el texto de la hoja los nombre.
fn openable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = ["http://", "https://", "mailto:"].iter().find_map(|scheme| lower.strip_prefix(scheme));
    rest.is_some_and(|rest| !rest.is_empty()) && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Abre afuera, en el navegador o en el programa de correo, un enlace de una hoja. La
/// vista del cuaderno nunca navega.
#[tauri::command]
pub async fn open_link(app: AppHandle, url: String) -> Res<()> {
    let url = url.trim();
    if !openable(url) {
        return Err("Ese enlace no se abre desde Folio: solo direcciones web (http, https) y de correo (mailto).".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(e)
}

// ---- integraciones con asistentes de IA -------------------------------------------

fn homes() -> Res<integrations::Homes> {
    integrations::Homes::of_user().ok_or_else(|| "No se encontró la carpeta del usuario".to_string())
}

fn notes_folder() -> Res<PathBuf> {
    crate::notes_dir().ok_or_else(|| "No se encontró la carpeta de documentos".to_string())
}

#[tauri::command]
pub async fn list_integrations() -> Res<Vec<integrations::Status>> {
    let (homes, notes) = (homes()?, notes_folder()?);
    Ok(integrations::TOOLS.iter().map(|tool| integrations::status(&homes, *tool, &notes)).collect())
}

#[tauri::command]
pub async fn install_integration(tool: String) -> Res<()> {
    integrations::install(&homes()?, Tool::parse(&tool)?, &notes_folder()?)
}

#[tauri::command]
pub async fn remove_integration(tool: String) -> Res<()> {
    integrations::remove(&homes()?, Tool::parse(&tool)?)
}

/// Las instrucciones para esa herramienta, listas para pegar a mano donde haga falta.
#[tauri::command]
pub async fn integration_text(tool: String) -> Res<String> {
    Ok(integrations::instructions(Tool::parse(&tool)?, &notes_folder()?))
}

// ---- categorías ------------------------------------------------------------

#[tauri::command]
pub async fn create_category(
    app: AppHandle,
    state: Ctx<'_>,
    name: String,
    description: String,
    color: String,
) -> Res<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err("La categoría necesita un nombre".into());
    }
    // Las hojas que el clasificador había dejado sin categoría quedan pendientes otra vez.
    let id = state.db.create_category(name, description.trim(), &color).map_err(e)?;
    notify_changed(&app);
    state.ping_classifier();
    Ok(id)
}

#[tauri::command]
pub async fn update_category(
    app: AppHandle,
    state: Ctx<'_>,
    id: i64,
    name: String,
    description: String,
    color: String,
) -> Res<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err("La categoría necesita un nombre".into());
    }
    // Solo si cambió el nombre o la descripción hay algo nuevo para preguntarle al clasificador.
    let redefined = state.db.update_category(id, name, description.trim(), &color).map_err(e)?;
    notify_changed(&app);
    if redefined {
        state.ping_classifier();
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_category(app: AppHandle, state: Ctx<'_>, id: i64) -> Res<()> {
    state.db.delete_category(id).map_err(e)?;
    notify_changed(&app);
    state.ping_classifier();
    Ok(())
}

/// Propone categorías de base a partir de lo que dicen las notas visibles. Todo se calcula
/// en esta PC, sin red, y no se crea ni se cambia nada: el usuario elige cuáles aceptar.
#[tauri::command]
pub async fn suggest_categories(state: Ctx<'_>) -> Res<Vec<CategorySuggestion>> {
    let shared = Arc::clone(&state);
    // Leer y contar palabras de todo el cuaderno no tiene que trabar a los demás comandos.
    tauri::async_runtime::spawn_blocking(move || crate::suggest::from_db(&shared.db)).await.map_err(e)?
}

/// Propone categorías a partir de las notas usando la IA activa (Claude, OpenAI, Gemini u Ollama).
#[tauri::command]
pub async fn suggest_categories_ai(app: AppHandle, state: Ctx<'_>) -> Res<Vec<CategorySuggestion>> {
    let shared = Arc::clone(&state);
    let result = tauri::async_runtime::spawn_blocking(move || provider::suggest_categories_ai(&shared.db)).await.map_err(e)?;
    notify_changed(&app);
    result
}


// ---- ajustes ---------------------------------------------------------------

#[tauri::command]
pub async fn get_settings(app: AppHandle, state: Ctx<'_>) -> Res<Settings> {
    let db = &state.db;
    let keys = state.shortcut_keys.lock().unwrap_or_else(|e| e.into_inner()).clone();
    Ok(Settings {
        roots: db.roots().map_err(e)?,
        bans: db.bans().map_err(e)?,
        versions_keep: db.get_i64("versions_keep", 2),
        session_gap_min: db.get_i64("session_gap_min", 5),
        ignore_git_repos: db.get_bool("ignore_git_repos", true),
        ignore_dot_dirs: db.get_bool("ignore_dot_dirs", true),
        max_file_kb: db.get_i64("max_file_kb", 1024),
        jev_threshold: db.get_f64("jev_threshold", 0.6),
        jev_recheck_days: db.get_i64("jev_recheck_days", 0),
        jev: jev_status(&state),
        // No es un ajuste guardado: se le pregunta al sistema cómo está de verdad.
        autostart: crate::autostart_enabled(&app),
        data_path: state.db_path.to_string_lossy().to_string(),
        secret_state: db.secret_state(),
        secret_locked_count: db.secret_locked_count(),
        capture_shortcut: state.capture_shortcut.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        open_shortcut: state.open_shortcut.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        send_shortcut: state.send_shortcut.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        capture_keys: keys.capture.keys(),
        open_keys: keys.open.keys(),
        send_keys: keys.send.keys(),
        send_to: Target::load(db).id().to_string(),
        send_origin: db.get_bool("send_origin", true),
        note_format: db.get_setting("note_format").unwrap_or_else(|| "txt".to_string()),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[tauri::command]
pub async fn export_secret_key(app: AppHandle, state: Ctx<'_>) -> Res<String> {
    let key = state.db.export_secret_key().map_err(e)?;
    notify_changed(&app);
    Ok(key)
}

#[tauri::command]
pub async fn import_secret_key(app: AppHandle, state: Ctx<'_>, key: String) -> Res<()> {
    state.db.import_secret_key(&key).map_err(e)?;
    notify_changed(&app);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    versions_keep: Option<i64>,
    session_gap_min: Option<i64>,
    ignore_git_repos: Option<bool>,
    ignore_dot_dirs: Option<bool>,
    max_file_kb: Option<i64>,
    jev_enabled: Option<bool>,
    jev_threshold: Option<f64>,
    jev_recheck_days: Option<i64>,
    autostart: Option<bool>,
    /// A dónde va lo que se envía con el atajo: «day» o «sheet».
    send_to: Option<String>,
    send_origin: Option<bool>,
    note_format: Option<String>,
}

#[tauri::command]
pub async fn update_settings(app: AppHandle, state: Ctx<'_>, patch: SettingsPatch) -> Res<()> {
    let db = &state.db;
    let flag = |v: bool| if v { "1" } else { "0" };
    let mut rescan = false;
    // Lo único que puede fallar por fuera de Book va primero: si falla, no cambia nada.
    if let Some(v) = patch.autostart {
        db.set_setting("autostart_configured", if v { "true" } else { "false" }).map_err(e)?;
        crate::set_autostart(&app, v)?;
    }
    if let Some(v) = patch.send_to {
        db.set_setting("send_to", Target::parse(&v)?.id()).map_err(e)?;
    }
    if let Some(v) = patch.send_origin {
        db.set_setting("send_origin", flag(v)).map_err(e)?;
    }
    if let Some(v) = patch.note_format {
        let fmt = if v.eq_ignore_ascii_case("md") { "md" } else { "txt" };
        db.set_setting("note_format", fmt).map_err(e)?;
    }
    if let Some(v) = patch.versions_keep {
        db.set_setting("versions_keep", &v.clamp(0, 20).to_string()).map_err(e)?;
    }
    if let Some(v) = patch.session_gap_min {
        db.set_setting("session_gap_min", &v.clamp(0, 240).to_string()).map_err(e)?;
        // De esta pausa depende cuándo una hoja está quieta para consultarle al clasificador.
        state.ping_classifier();
    }
    if let Some(v) = patch.ignore_git_repos {
        db.set_setting("ignore_git_repos", flag(v)).map_err(e)?;
        rescan = true;
    }
    if let Some(v) = patch.ignore_dot_dirs {
        db.set_setting("ignore_dot_dirs", flag(v)).map_err(e)?;
        rescan = true;
    }
    if let Some(v) = patch.max_file_kb {
        db.set_setting("max_file_kb", &v.clamp(1, 65_536).to_string()).map_err(e)?;
        rescan = true;
    }
    if let Some(v) = patch.jev_threshold {
        // Se aplica sobre lo que la IA ya eligió para cada hoja: no hace falta volver a consultar.
        let threshold = v.clamp(0.0, 1.0);
        db.set_setting("jev_threshold", &threshold.to_string()).map_err(e)?;
        db.apply_threshold(threshold).map_err(e)?;
    }
    if let Some(v) = patch.jev_recheck_days {
        db.set_setting("jev_recheck_days", &v.clamp(0, 365).to_string()).map_err(e)?;
        state.ping_classifier();
    }
    if let Some(v) = patch.jev_enabled {
        db.set_setting("jev_enabled", flag(v)).map_err(e)?;
        state.wake_classifier(Wake::Retry);
    }
    if rescan {
        scope_changed(&app, &state);
    }
    notify_changed(&app);
    Ok(())
}

/// Cambia la combinación de un atajo global (`which`: «capture», «open» o «send»; `keys`: por
/// ejemplo «Ctrl+Alt+N»). Falla con un mensaje claro si la combinación no sirve, si es la
/// de otro de los atajos o si otro programa ya la usa; en ese caso el atajo anterior sigue
/// como estaba.
#[tauri::command]
pub async fn set_global_shortcut(app: AppHandle, state: Ctx<'_>, which: String, keys: String) -> Res<()> {
    crate::shortcuts::change(&app, &state, &which, &keys)?;
    notify_changed(&app);
    Ok(())
}

/// El texto con el que tiene que nacer la hoja suelta: lo que se envió con «Enviar lo
/// seleccionado al Book» cuando el destino elegido es abrir la hoja suelta. Se entrega una
/// sola vez; `None` si no hay nada esperando.
#[tauri::command]
pub async fn take_capture_seed(state: Ctx<'_>) -> Res<Option<CaptureSeed>> {
    Ok(state.capture_seed.lock().unwrap_or_else(|e| e.into_inner()).take())
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Res<Option<String>> {
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn add_root(app: AppHandle, state: Ctx<'_>, path: String) -> Res<()> {
    if !Path::new(&path).is_dir() {
        return Err("Esa carpeta no existe".into());
    }
    state.db.add_root(&path).map_err(e)?;
    scope_changed(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn remove_root(app: AppHandle, state: Ctx<'_>, id: i64) -> Res<()> {
    state.db.remove_root(id).map_err(e)?;
    scope_changed(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn add_ban(app: AppHandle, state: Ctx<'_>, kind: String, pattern: String) -> Res<()> {
    let pattern = pattern.trim();
    if pattern.is_empty() || !matches!(kind.as_str(), "dir" | "file" | "path") {
        return Err("Exclusión inválida".into());
    }
    state.db.add_ban(&kind, pattern).map_err(e)?;
    scope_changed(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn set_ban_enabled(app: AppHandle, state: Ctx<'_>, id: i64, enabled: bool) -> Res<()> {
    state.db.set_ban_enabled(id, enabled).map_err(e)?;
    scope_changed(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn remove_ban(app: AppHandle, state: Ctx<'_>, id: i64) -> Res<()> {
    state.db.remove_ban(id).map_err(e)?;
    scope_changed(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn folder_stats(state: Ctx<'_>) -> Res<Vec<FolderStat>> {
    state.db.folder_stats().map_err(e)
}

#[tauri::command]
pub async fn rescan(app: AppHandle, state: Ctx<'_>) -> Res<()> {
    scan::spawn_scan(&app, &state);
    Ok(())
}

/// Abre el explorador de archivos en la base de datos de Book.
#[tauri::command]
pub async fn reveal_data(app: AppHandle, state: Ctx<'_>) -> Res<()> {
    app.opener().reveal_item_in_dir(&state.db_path).map_err(e)
}

// ---- el clasificador (Jev, Claude, OpenAI, Gemini, Ollama) --------------------------

fn provider_of(id: &str) -> Res<Provider> {
    Provider::from_id(id).ok_or_else(|| format!("No conozco la IA «{id}»"))
}

/// Algo de la IA cambió (cuál es, su clave, su modelo, su dirección): el aviso de error que
/// hubiera era de la anterior, y las esperas y rechazos de la anterior ya no valen.
fn classifier_changed(app: &AppHandle, state: &Shared) {
    *state.jev_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
    notify_changed(app);
    state.wake_classifier(Wake::Retry);
}

/// Elige con qué IA se clasifica. Lo ya clasificado no se toca ni se vuelve a consultar:
/// solo las hojas que falten pasan por la nueva.
#[tauri::command]
pub async fn set_ai_provider(app: AppHandle, state: Ctx<'_>, provider: String) -> Res<()> {
    let next = provider_of(&provider)?;
    // Elegir otra IA no es todavía permiso para mandarle las hojas (su clave puede venir
    // del entorno, sin que el usuario la haya puesto en Book): la clasificación automática
    // se apaga y el usuario la vuelve a prender cuando quiera.
    if next != provider::active(&state.db) {
        state.db.set_setting("jev_enabled", "0").map_err(e)?;
    }
    provider::set_active(&state.db, next)?;
    classifier_changed(&app, &state);
    Ok(())
}

/// Elige el modelo de una IA; vacío vuelve al de fábrica.
#[tauri::command]
pub async fn set_ai_model(app: AppHandle, state: Ctx<'_>, provider: String, model: String) -> Res<()> {
    provider::set_model(&state.db, provider_of(&provider)?, &model)?;
    classifier_changed(&app, &state);
    Ok(())
}

/// Dónde escucha Ollama (por ejemplo «http://localhost:11434»); vacío vuelve a esta PC.
#[tauri::command]
pub async fn set_ollama_url(app: AppHandle, state: Ctx<'_>, url: String) -> Res<()> {
    provider::set_ollama_url(&state.db, &url)?;
    classifier_changed(&app, &state);
    Ok(())
}

/// Guardar la clave de una IA es el consentimiento explícito para enviarle hojas.
#[tauri::command]
pub async fn set_provider_key(app: AppHandle, state: Ctx<'_>, provider: String, key: String) -> Res<()> {
    let provider = provider_of(&provider)?;
    if key.trim().is_empty() {
        return Err("La clave está vacía".into());
    }
    provider::save_key(provider, &key)?;
    state.db.set_setting("jev_enabled", "1").map_err(e)?;
    // Con una clave nueva se deja atrás el rechazo de la anterior.
    classifier_changed(&app, &state);
    Ok(())
}

/// Quita la clave de una IA. Si era la que se usa, se apaga la clasificación automática: sin
/// clave no hay a quién consultar, y con otra clave se vuelve a prender sola.
#[tauri::command]
pub async fn clear_provider_key(app: AppHandle, state: Ctx<'_>, provider: String) -> Res<()> {
    let provider = provider_of(&provider)?;
    provider::clear_key(provider)?;
    if provider == provider::active(&state.db) {
        state.db.set_setting("jev_enabled", "0").map_err(e)?;
    }
    *state.jev_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
    notify_changed(&app);
    Ok(())
}

/// Lo de siempre para Jev: ahora es el caso particular de las claves por IA.
#[tauri::command]
pub async fn set_jev_key(app: AppHandle, state: Ctx<'_>, key: String) -> Res<()> {
    set_provider_key(app, state, Provider::Jev.id().to_string(), key).await
}

#[tauri::command]
pub async fn clear_jev_key(app: AppHandle, state: Ctx<'_>) -> Res<()> {
    clear_provider_key(app, state, Provider::Jev.id().to_string()).await
}

/// «Probar»: le pide a la IA elegida que clasifique una hoja de ejemplo con las categorías de
/// ahora y devuelve qué eligió. Cuenta como una consulta.
#[tauri::command]
pub async fn test_classifier(app: AppHandle, state: Ctx<'_>) -> Res<ClassifierTest> {
    let shared = Arc::clone(&state);
    // La consulta puede tardar (sobre todo en Ollama): no tiene que trabar a los demás comandos.
    let result = tauri::async_runtime::spawn_blocking(move || provider::probe(&shared.db)).await.map_err(e)?;
    // Haya salido bien o mal, el contador de consultas cambió.
    notify_changed(&app);
    result
}

/// Consulta ya por todo lo pendiente: no espera a que las hojas estén quietas ni a que
/// pase la pausa por un error anterior.
#[tauri::command]
pub async fn classify_now(state: Ctx<'_>) -> Res<()> {
    state.wake_classifier(Wake::Now);
    Ok(())
}

/// Vuelve a consultar al clasificador por todas las hojas que no tienen categoría puesta a mano,
/// sin reutilizar respuestas guardadas. Es lo único que repite consultas ya hechas.
#[tauri::command]
pub async fn reclassify_all(app: AppHandle, state: Ctx<'_>) -> Res<()> {
    state.db.reclassify_all().map_err(e)?;
    notify_changed(&app);
    state.wake_classifier(Wake::Retry);
    Ok(())
}

/// Inicia el dictado por voz de Windows (Win + H).
#[tauri::command]
pub fn start_dictation() -> Result<(), String> {
    crate::selection::start_windows_dictation()
}

#[tauri::command]
pub fn set_locale(app: AppHandle, shared: State<'_, Arc<Shared>>, locale: String) -> Result<(), String> {
    let normalized = if locale == "en" { "en" } else { "es" };
    shared.db.set_setting("locale", normalized).map_err(e)?;
    let _ = crate::refresh_tray_menu(&app);
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.set_title(if normalized == "en" { "Folio Settings" } else { "Ajustes de Folio" });
    }
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.set_title(if normalized == "en" { "New sheet" } else { "Nueva hoja" });
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct RemoteRelease {
    pub tag_name: String,
    pub html_url: String,
    pub name: Option<String>,
}

#[tauri::command]
pub fn check_update(repo: Option<String>) -> Result<Option<RemoteRelease>, String> {
    let repo = repo.unwrap_or_else(|| "Joaquin-H/folio".to_string());
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let resp = ureq::get(&url)
        .set("User-Agent", "Folio-App")
        .set("Accept", "application/vnd.github.v3+json")
        .timeout(std::time::Duration::from_secs(7))
        .call();

    match resp {
        Ok(response) => {
            let data: serde_json::Value = response.into_json().map_err(|err| err.to_string())?;
            let tag_name = data.get("tag_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let html_url = data.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let name = data.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
            Ok(Some(RemoteRelease { tag_name, html_url, name }))
        }
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(ureq::Error::Status(403, _)) => Err("rate_limited".to_string()),
        Err(ureq::Error::Status(code, _)) => Err(format!("status_{code}")),
        Err(ureq::Error::Transport(_)) => Err("offline".to_string()),
    }
}


