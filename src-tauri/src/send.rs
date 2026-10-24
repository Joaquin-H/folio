//! «Enviar lo seleccionado al Book»: lo que pasa con el texto que se copió de otro programa.
//!
//! Windows no deja agregar un ítem al clic derecho de todos los programas (cada uno arma el
//! suyo), así que la forma general es un atajo global: se selecciona el texto, se aprieta el
//! atajo y Book lo recibe. `selection.rs` se ocupa de copiar; acá se decide a dónde va.
//!
//! De fábrica se **agrega** a la hoja del día de la carpeta de Book (`recortes-AAAA-MM-DD.txt`),
//! cada recorte separado por una línea en blanco y con un encabezado con la hora y el origen:
//!
//! ```text
//! — 14:32 · Chrome · «Título de la página»
//! el texto que estaba seleccionado
//! ```
//!
//! Un recorte que parece sensible (ver `secrets.rs`) va a una hoja propia, para que la hoja
//! del día no termine entera en el secret-book. Como alternativa, el recorte puede abrir la
//! hoja suelta con el texto adentro, para revisarlo antes de guardarlo.
//!
//! Se escribe por el mismo camino que usa Book al guardar (`commands::index_file`, la
//! codificación y los saltos de línea de lo que ya había) y con el mismo candado, para no
//! cruzarse con un guardado de esa hoja que esté en curso. Todo corre en un hilo propio: el
//! manejador del atajo solo lo despierta.
//!
//! La parte que no depende de Windows (la hora, los nombres, el encabezado, cómo se agrega a
//! un archivo, a dónde va cada recorte) se prueba aparte, con carpetas temporales.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::commands;
use crate::db::Db;
use crate::model::CaptureSeed;
use crate::selection::{self, Clip, Fail, Source, Wall};
use crate::{secrets, text, Shared};

/// Aviso a la hoja suelta (si ya está abierta) de que hay un texto nuevo para ella.
pub const EVENT_SEED: &str = "book:capture-seed";

/// Lo más largo que puede ser un recorte, en caracteres. Una selección más larga casi
/// seguro es «seleccionar todo» por error, y haría crecer la hoja del día más allá de lo que
/// Book lee de un archivo.
pub const MAX_CHARS: usize = 500_000;

// ---- la hora ------------------------------------------------------------------------------

/// La hora local, hasta el segundo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    year: u16,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
}

impl LocalTime {
    /// La hora de ahora en la zona horaria del sistema.
    pub fn now() -> Self {
        local_now()
    }

    /// Una hora en UTC a partir de segundos desde 1970. Es lo que se usa donde Windows no
    /// está para preguntar la hora local; también sirve para probar los cálculos.
    #[cfg_attr(windows, allow(dead_code))]
    fn from_unix_utc(seconds: u64) -> Self {
        let (days, rest) = ((seconds / 86_400) as i64, seconds % 86_400);
        // Días desde 1970 a año, mes y día (calendario gregoriano, el algoritmo de Howard Hinnant).
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let day_of_era = z.rem_euclid(146_097);
        let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let month_from_march = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * month_from_march + 2) / 5 + 1;
        let month = if month_from_march < 10 { month_from_march + 3 } else { month_from_march - 9 };
        let year = year_of_era + era * 400 + i64::from(month <= 2);
        Self {
            year: year as u16,
            month: month as u8,
            day: day as u8,
            hour: (rest / 3600) as u8,
            minute: (rest % 3600 / 60) as u8,
            second: (rest % 60) as u8,
        }
    }

    /// «2026-10-14».
    fn date(&self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }

    /// «2026-10»: el año y el mes, para la hoja de recortes mensual.
    fn year_month(&self) -> String {
        format!("{:04}-{:02}", self.year, self.month)
    }

    /// La fecha del lunes de la semana de esta fecha («2026-10-12»), para la hoja semanal.
    fn week_monday(&self) -> String {
        let y = i64::from(self.year) - i64::from(self.month <= 2);
        let era = y.div_euclid(400);
        let yoe = y.rem_euclid(400);
        let m = i64::from(self.month);
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(self.day) - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        // 1970-01-01 fue jueves: `(days + 3).rem_euclid(7)` da 0 para lunes, 6 para domingo.
        let since_monday = (days + 3).rem_euclid(7);
        let monday = Self::from_unix_utc(((days - since_monday).max(0) as u64) * 86_400);
        monday.date()
    }

    /// «14:32».
    fn clock(&self) -> String {
        format!("{:02}:{:02}", self.hour, self.minute)
    }

    /// «143205»: la hora con segundos, para distinguir las hojas propias de un mismo día.
    fn stamp(&self) -> String {
        format!("{:02}{:02}{:02}", self.hour, self.minute, self.second)
    }
}

#[cfg(windows)]
fn local_now() -> LocalTime {
    /// `SYSTEMTIME`: ocho campos de 16 bits.
    #[repr(C)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLocalTime(time: *mut SystemTime);
    }

    let mut time = SystemTime { year: 0, month: 0, day_of_week: 0, day: 0, hour: 0, minute: 0, second: 0, milliseconds: 0 };
    // SAFETY: `time` es un `SYSTEMTIME` válido, que Windows completa.
    unsafe { GetLocalTime(&mut time) };
    LocalTime {
        year: time.year,
        month: time.month as u8,
        day: time.day as u8,
        hour: time.hour as u8,
        minute: time.minute as u8,
        second: time.second as u8,
    }
}

#[cfg(not(windows))]
fn local_now() -> LocalTime {
    let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_secs());
    LocalTime::from_unix_utc(seconds)
}

// ---- a dónde va ---------------------------------------------------------------------------

/// Qué se hace con lo que se envía, a elección del usuario en Ajustes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Target {
    /// Se agrega a una única hoja de recortes universal (`recortes.txt`).
    All,
    /// Se agrega a la hoja del día (`recortes-AAAA-MM-DD.txt`).
    #[default]
    Day,
    /// Se agrega a la hoja de la semana (`recortes-semana-AAAA-MM-DD.txt`).
    Week,
    /// Se agrega a la hoja del mes (`recortes-AAAA-MM.txt`).
    Month,
    /// Se abre la hoja suelta con el texto, para revisarlo antes de guardar.
    Sheet,
}

impl Target {
    /// Como lo nombra la interfaz: `"all"`, `"day"`, `"week"`, `"month"` o `"sheet"`.
    pub fn parse(text: &str) -> Result<Self, String> {
        match text {
            "all" => Ok(Self::All),
            "day" => Ok(Self::Day),
            "week" => Ok(Self::Week),
            "month" => Ok(Self::Month),
            "sheet" => Ok(Self::Sheet),
            other => Err(format!("«{other}» no es un destino para lo que se envía al Book.")),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
            Self::Sheet => "sheet",
        }
    }

    /// El elegido; la hoja del día si no hay ninguno (o no sirve).
    pub fn load(db: &Db) -> Self {
        db.get_setting("send_to").and_then(|saved| Self::parse(&saved).ok()).unwrap_or_default()
    }
}

/// El nombre (sin extensión) de la hoja según el destino elegido.
fn target_stem(target: Target, time: &LocalTime) -> String {
    match target {
        Target::All => "recortes".to_string(),
        Target::Day | Target::Sheet => day_stem(time),
        Target::Week => week_stem(time),
        Target::Month => month_stem(time),
    }
}

/// El nombre (sin extensión) de la hoja del día: «recortes-2026-10-14».
fn day_stem(time: &LocalTime) -> String {
    format!("recortes-{}", time.date())
}

/// El de la hoja de la semana (lunes de esa semana): «recortes-semana-2026-10-12».
fn week_stem(time: &LocalTime) -> String {
    format!("recortes-semana-{}", time.week_monday())
}

/// El de la hoja del mes: «recortes-2026-10».
fn month_stem(time: &LocalTime) -> String {
    format!("recortes-{}", time.year_month())
}

/// El de una hoja propia: «recorte-2026-10-14-143205».
fn own_stem(time: &LocalTime) -> String {
    format!("recorte-{}-{}", time.date(), time.stamp())
}

/// El encabezado de un recorte: «— 14:32 · Chrome · «Título de la página»». Lo que no se sabe
/// (el programa, el título) se omite.
pub fn header(time: &LocalTime, source: &Source) -> String {
    let mut parts = vec![format!("— {}", time.clock())];
    if !source.program.is_empty() {
        parts.push(source.program.clone());
    }
    if !source.title.is_empty() {
        parts.push(format!("«{}»", source.title));
    }
    parts.join(" · ")
}

/// El texto copiado, listo para guardar: con saltos de línea de `\n`, sin los renglones en
/// blanco del principio ni los espacios del final (la sangría del primer renglón se conserva).
fn tidy(copied: &str) -> String {
    let normalized = text::normalize_newlines(copied).replace('\0', "");
    let mut rest = normalized.as_str();
    while let Some((line, tail)) = rest.split_once('\n') {
        if !line.trim().is_empty() {
            break;
        }
        rest = tail;
    }
    rest.trim_end().to_string()
}

/// El recorte entero: el encabezado y debajo el texto.
fn entry(header: &str, selected: &str) -> String {
    format!("{header}\n{selected}")
}

/// `existing` (con saltos de `\n`) con el recorte agregado al final, separado por una línea en
/// blanco. Lo que ya había no se toca; solo se acomodan los saltos de línea del final.
fn appended(existing: &str, entry: &str) -> String {
    let kept = existing.trim_end_matches('\n');
    if kept.trim().is_empty() {
        entry.to_string()
    } else {
        format!("{kept}\n\n{entry}")
    }
}

/// Un recorte listo para guardar.
#[derive(Debug, PartialEq, Eq)]
struct Prepared {
    /// El texto seleccionado, limpio.
    selected: String,
    /// Su encabezado.
    header: String,
    /// Incluye el encabezado con la hora y el programa en el archivo de texto.
    include_origin: bool,
    /// Parece contener una clave: tiene que ir a una hoja propia.
    sensitive: bool,
}

impl Prepared {
    fn entry(&self) -> String {
        if self.include_origin && !self.header.is_empty() {
            entry(&self.header, &self.selected)
        } else {
            self.selected.clone()
        }
    }
}

/// Limpia lo copiado y arma su encabezado. Falla con el motivo, listo para mostrar.
fn prepare(clip: &Clip, time: &LocalTime, include_origin: bool) -> Result<Prepared, String> {
    let selected = tidy(&clip.text);
    if selected.is_empty() {
        return Err(Fail::NoSelection.message().to_string());
    }
    let length = selected.chars().count();
    if length > MAX_CHARS {
        return Err(format!(
            "Lo seleccionado es demasiado largo para un recorte ({length} caracteres; el máximo es {MAX_CHARS}). Seleccioná menos texto."
        ));
    }
    Ok(Prepared {
        header: header(time, &clip.source),
        include_origin,
        sensitive: secrets::detect(&selected).is_some(),
        selected,
    })
}

/// Dónde quedó un recorte.
#[derive(Debug)]
pub struct Stored {
    /// El archivo (lo usan las pruebas; el aviso solo necesita el nombre).
    #[cfg_attr(not(test), allow(dead_code))]
    pub path: PathBuf,
    /// El nombre de la hoja, sin extensión.
    pub name: String,
    /// Está en una hoja propia y no en la del día.
    pub alone: bool,
    /// Parece sensible: la hoja pasa al secret-book.
    pub sensitive: bool,
    /// La carpeta de Book no existía: hay que empezar a vigilarla.
    pub first_note: bool,
}

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

fn stem_of(path: &Path) -> String {
    path.file_stem().map(|stem| stem.to_string_lossy().to_string()).unwrap_or_default()
}

/// Guarda el recorte en la carpeta de Book y lo anota en el cuaderno. Toma el candado de las
/// escrituras de archivos: mientras se guarda otra hoja, espera.
fn store(db: &Db, dir: &Path, time: &LocalTime, prepared: &Prepared) -> Result<Stored, String> {
    let _turn = commands::writing();
    let first_note = !dir.is_dir();
    std::fs::create_dir_all(dir).map_err(e)?;
    let entry = prepared.entry();
    let target = Target::load(db);
    let clippings_cat_id = db.ensure_clippings_category().map_err(e)?;
    if !prepared.sensitive {
        if let Some(path) = append_to_target(db, dir, target, time, &entry)? {
            let key = path.to_string_lossy().to_string();
            if let Some(sheet_id) = db.sheet_id("file", &key) {
                let current_cat = db.sheet_category(sheet_id).ok().flatten();
                if current_cat.is_none() {
                    let _ = db.set_sheet_category(sheet_id, Some(clippings_cat_id));
                }
            }
            return Ok(Stored { name: stem_of(&path), path, alone: false, sensitive: false, first_note });
        }
    }
    let path = commands::write_new_file(db, dir, &own_stem(time), &entry)?;
    let sheet_id = commands::index_file(db, &path, entry)?;
    let _ = db.set_sheet_category(sheet_id, Some(clippings_cat_id));
    Ok(Stored { name: stem_of(&path), path, alone: true, sensitive: prepared.sensitive, first_note })
}

/// Agrega el recorte al final de la hoja de recortes (universal, diaria, semanal o mensual),
/// o la crea con él. `None` si esa hoja no se puede usar y el recorte tiene que ir a una
/// propia: está en la papelera (agregarle algo la dejaría fuera de la vista) o su archivo ya
/// no es de texto.
///
/// Si el archivo de recortes se borró por fuera pero su hoja sigue en Book (quedó «sin original»),
/// no se la revive: como al crear cualquier hoja, la nueva toma otro nombre y no hereda las
/// marcas de la vieja.
fn append_to_target(db: &Db, dir: &Path, target: Target, time: &LocalTime, entry: &str) -> Result<Option<PathBuf>, String> {
    let stem = target_stem(target, time);
    let path = dir.join(format!("{stem}.txt"));
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let created = commands::write_new_file(db, dir, &stem, entry)?;
            commands::index_file(db, &created, entry.to_string())?;
            return Ok(Some(created));
        }
        Err(err) => return Err(e(err)),
    };
    let key = path.to_string_lossy().to_string();
    let trashed = db.sheet_id("file", &key).is_some_and(|id| db.origin(id).ok().flatten().is_some_and(|origin| origin.hidden));
    let Some(on_disk) = text::decode(&bytes).filter(|_| !trashed) else {
        return Ok(None);
    };
    let content = appended(&on_disk, entry);
    let Some(encoded) = text::encode_like(&content, &bytes) else {
        return Ok(None);
    };
    std::fs::write(&path, encoded).map_err(e)?;
    commands::index_file(db, &path, content)?;
    Ok(Some(path))
}

// ---- el hilo y los avisos ---------------------------------------------------------------------

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Hay un envío en marcha: apretar el atajo otra vez mientras tanto no empieza otro.
static BUSY: AtomicBool = AtomicBool::new(false);

/// Deja libre el envío al terminar, también si el hilo se corta.
struct Free;

impl Drop for Free {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// Se apretó el atajo: lo que sigue corre en un hilo propio y esto vuelve enseguida.
pub fn trigger(app: &AppHandle) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let started = thread::Builder::new().name("book-send".into()).spawn(move || {
        let _free = Free;
        run(&app);
    });
    if let Err(err) = started {
        BUSY.store(false, Ordering::SeqCst);
        eprintln!("No se pudo enviar lo seleccionado al Book: {err}");
    }
}

/// Un aviso del sistema, sin robar el foco. Si no se puede mostrar, queda en la consola.
fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        eprintln!("No se pudo mostrar el aviso «{title}»: {err}");
    }
    let _ = app.emit("book:changed", ());
}

fn run(app: &AppHandle) {
    let Some(shared) = app.try_state::<Arc<Shared>>().map(|shared| Arc::clone(&shared)) else {
        return;
    };
    let en = crate::is_english(app);
    let main_key = lock(&shared.shortcut_keys).send.virtual_key();
    match selection::copy_selection(main_key, &Wall::start()) {
        Ok(clip) => deliver(app, &shared, &clip),
        Err(Fail::NoSelection) => notify(app, "Folio", Fail::NoSelection.message_for(en)),
        Err(fail) => notify(
            app,
            if en { "Couldn’t send to Folio" } else { "No se pudo enviar a Folio" },
            fail.message_for(en),
        ),
    }
}

/// Lo copiado ya está acá: se guarda o se abre en la hoja suelta, según lo elegido.
fn deliver(app: &AppHandle, shared: &Arc<Shared>, clip: &Clip) {
    let en = crate::is_english(app);
    let time = LocalTime::now();
    let err_title = if en { "Couldn’t send to Folio" } else { "No se pudo enviar a Folio" };
    let include_origin = shared.db.get_bool("send_origin", true);
    let prepared = match prepare(clip, &time, include_origin) {
        Ok(prepared) => prepared,
        Err(reason) => return notify(app, err_title, &reason),
    };
    if Target::load(&shared.db) == Target::Sheet {
        return open_sheet(
            app,
            shared,
            CaptureSeed {
                text: prepared.selected,
                origin: if include_origin { prepared.header } else { String::new() },
            },
        );
    }
    let Some(dir) = crate::notes_dir() else {
        return notify(
            app,
            err_title,
            if en { "Documents folder not found." } else { "No se encontró la carpeta de documentos." },
        );
    };
    match store(&shared.db, &dir, &time, &prepared) {
        Ok(stored) => {
            // El cuaderno lo muestra enseguida; la carpeta nueva empieza a vigilarse.
            commands::wrote_note(app, shared, stored.first_note);
            let (title, body) = confirmation_for(&stored, en);
            notify(app, title, &body);
        }
        Err(reason) => notify(app, err_title, &reason),
    }
}

/// Lo que dice el aviso cuando el recorte quedó guardado.
#[cfg_attr(not(test), allow(dead_code))]
fn confirmation(stored: &Stored) -> (&'static str, String) {
    confirmation_for(stored, false)
}

fn confirmation_for(stored: &Stored, en: bool) -> (&'static str, String) {
    if en {
        if stored.sensitive {
            ("Sent to the secret-book", format!("{} (looks like a password)", stored.name))
        } else if stored.alone {
            ("Sent to Folio", format!("{} (separate sheet)", stored.name))
        } else {
            ("Sent to Folio", stored.name.clone())
        }
    } else {
        if stored.sensitive {
            // La hoja propia de un recorte con una clave pasa sola al secret-book.
            ("Enviado al secret-book", format!("{} (parece tener una clave)", stored.name))
        } else if stored.alone {
            // La hoja del día no se pudo usar (está en la papelera o ya no es de texto).
            ("Enviado a Folio", format!("{} (hoja aparte)", stored.name))
        } else {
            ("Enviado a Folio", stored.name.clone())
        }
    }
}

/// Abre la hoja suelta con el texto adentro. Si ya estaba abierta, le avisa para que lo sume
/// a lo que tiene escrito.
fn open_sheet(app: &AppHandle, shared: &Arc<Shared>, seed: CaptureSeed) {
    *lock(&shared.capture_seed) = Some(seed);
    let open = app.get_webview_window("capture").is_some();
    crate::open_capture_window(app);
    if open {
        let _ = app.emit(EVENT_SEED, ());
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use super::*;
    use crate::model::SheetDetail;

    fn at(hour: u8, minute: u8, second: u8) -> LocalTime {
        LocalTime { year: 2026, month: 10, day: 14, hour, minute, second }
    }

    fn source(program: &str, title: &str) -> Source {
        Source { program: program.into(), title: title.into() }
    }

    fn clip(text: &str, program: &str, title: &str) -> Clip {
        Clip { text: text.into(), source: source(program, title) }
    }

    /// Una carpeta de Book de prueba (vacía, propia de cada test) con su base en memoria.
    struct Folder {
        dir: PathBuf,
        db: Db,
    }

    impl Folder {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("book-test-recortes-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            Self { dir, db: Db::open(Path::new(":memory:")).expect("base en memoria") }
        }

        /// Manda un recorte como si se hubiera copiado de ese programa a esa hora.
        fn send(&self, time: &LocalTime, text: &str, program: &str, title: &str) -> Stored {
            let prepared = prepare(&clip(text, program, title), time, true).expect("recorte válido");
            store(&self.db, &self.dir, time, &prepared).expect("se guarda")
        }

        fn sheet(&self, path: &Path) -> SheetDetail {
            let id = self.db.sheet_id("file", &path.to_string_lossy()).expect("la hoja está en el Book");
            self.db.get_sheet(id).unwrap().expect("la hoja existe")
        }

        fn day(&self) -> PathBuf {
            self.dir.join("recortes-2026-10-14.txt")
        }

        /// Lo que dice el archivo, sin importar su codificación ni sus saltos de línea.
        fn text_of(&self, path: &Path) -> String {
            text::decode(&fs::read(path).unwrap()).expect("es de texto")
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// Los saltos de línea con los que Book crea un archivo nuevo.
    fn newline() -> &'static str {
        if cfg!(windows) {
            "\r\n"
        } else {
            "\n"
        }
    }

    #[test]
    fn la_hora_local_se_arma_desde_los_segundos_de_unix() {
        let utc = |seconds| {
            let time = LocalTime::from_unix_utc(seconds);
            (time.date(), time.clock(), time.stamp())
        };
        assert_eq!(utc(0), ("1970-01-01".into(), "00:00".into(), "000000".into()));
        assert_eq!(utc(946_684_800), ("2000-01-01".into(), "00:00".into(), "000000".into()));
        assert_eq!(utc(1_791_988_325), ("2026-10-14".into(), "14:32".into(), "143205".into()));
        // El 29 de febrero de un año bisiesto y el último segundo del año.
        assert_eq!(utc(1_709_251_199), ("2024-02-29".into(), "23:59".into(), "235959".into()));
        assert_eq!(utc(1_798_761_599), ("2026-12-31".into(), "23:59".into(), "235959".into()));
        // La de verdad devuelve algo con forma de fecha.
        let now = LocalTime::now();
        assert!((2024..2200).contains(&now.year) && (1..=12).contains(&now.month) && (1..=31).contains(&now.day));
        assert!(now.hour < 24 && now.minute < 60 && now.second < 61);
    }

    #[test]
    fn el_encabezado_lleva_la_hora_el_programa_y_el_titulo() {
        let time = at(14, 32, 5);
        assert_eq!(header(&time, &source("Chrome", "Título de la página")), "— 14:32 · Chrome · «Título de la página»");
        // Lo que no se sabe se omite, sin dejar separadores sueltos.
        assert_eq!(header(&time, &source("Chrome", "")), "— 14:32 · Chrome");
        assert_eq!(header(&time, &source("", "Un título")), "— 14:32 · «Un título»");
        assert_eq!(header(&time, &source("", "")), "— 14:32");
        // Dos dígitos siempre, y sin segundos.
        assert_eq!(header(&at(9, 5, 59), &source("Word", "")), "— 09:05 · Word");
    }

    #[test]
    fn el_recorte_puede_guardarse_sin_encabezado_de_origen() {
        let time = at(14, 32, 5);
        let clip_item = clip("Texto copiado", "Chrome", "Una web");
        let with_origin = prepare(&clip_item, &time, true).unwrap();
        assert_eq!(with_origin.entry(), "— 14:32 · Chrome · «Una web»\nTexto copiado");
        let without_origin = prepare(&clip_item, &time, false).unwrap();
        assert_eq!(without_origin.entry(), "Texto copiado");
    }

    #[test]
    fn los_nombres_llevan_la_fecha_y_la_hora() {
        assert_eq!(day_stem(&at(14, 32, 5)), "recortes-2026-10-14");
        assert_eq!(own_stem(&at(14, 32, 5)), "recorte-2026-10-14-143205");
        let january = LocalTime { year: 2027, month: 1, day: 3, hour: 7, minute: 8, second: 9 };
        assert_eq!(day_stem(&january), "recortes-2027-01-03");
        assert_eq!(own_stem(&january), "recorte-2027-01-03-070809");
    }

    #[test]
    fn lo_copiado_se_limpia_antes_de_guardarlo() {
        assert_eq!(tidy("hola"), "hola");
        // Saltos de Windows y de Mac a uno solo, sin renglones en blanco al principio ni espacios al final.
        assert_eq!(tidy("\r\n\r\n   uno\r\n  dos  \r\n\r\n"), "   uno\n  dos");
        assert_eq!(tidy("a\rb"), "a\nb");
        // Un renglón con solo espacios al principio también es un renglón en blanco.
        assert_eq!(tidy("  \n\t\nTexto"), "Texto");
        // Lo del medio no se toca.
        assert_eq!(tidy("uno\n\n\ndos"), "uno\n\n\ndos");
        // Un NUL (el final de un texto Unicode mal cortado) no llega al archivo.
        assert_eq!(tidy("abc\0def"), "abcdef");
        assert_eq!(tidy(" \n \t "), "");
        assert_eq!(tidy(""), "");
    }

    #[test]
    fn un_recorte_se_agrega_al_final_separado_por_una_linea_en_blanco() {
        let entry = "— 14:32 · Chrome\ntexto";
        assert_eq!(appended("", entry), entry);
        assert_eq!(appended("   \n\n", entry), entry);
        assert_eq!(appended("mis notas", entry), "mis notas\n\n— 14:32 · Chrome\ntexto");
        // Con uno, dos o varios saltos al final, siempre queda una sola línea en blanco.
        assert_eq!(appended("mis notas\n", entry), "mis notas\n\n— 14:32 · Chrome\ntexto");
        assert_eq!(appended("mis notas\n\n\n\n", entry), "mis notas\n\n— 14:32 · Chrome\ntexto");
        // Lo que ya estaba no se toca: ni los espacios del final del último renglón ni lo del medio.
        assert_eq!(appended("a  \n\n\n  b  ", entry), "a  \n\n\n  b  \n\n— 14:32 · Chrome\ntexto");
    }

    #[test]
    fn un_recorte_vacio_o_enorme_no_se_guarda() {
        let time = at(10, 0, 0);
        assert_eq!(prepare(&clip("  \r\n ", "Chrome", ""), &time, true).unwrap_err(), "No había texto seleccionado.");
        let big = "a".repeat(MAX_CHARS + 1);
        let reason = prepare(&clip(&big, "Chrome", ""), &time, true).unwrap_err();
        assert!(reason.contains("demasiado largo") && reason.contains("500000"), "{reason}");
        // El máximo justo sí entra.
        assert!(prepare(&clip(&"a".repeat(MAX_CHARS), "Chrome", ""), &time, true).is_ok());
        // El recorte listo trae el encabezado y el texto limpio.
        let ready = prepare(&clip("\r\nuno\r\ndos\r\n", "Chrome", "Una página"), &time, true).unwrap();
        assert_eq!(ready.entry(), "— 10:00 · Chrome · «Una página»\nuno\ndos");
        assert!(!ready.sensitive);
    }

    #[test]
    fn el_primer_recorte_crea_la_hoja_del_dia_y_el_cuaderno_la_ve() {
        let folder = Folder::new("primero");
        let stored = folder.send(&at(14, 32, 5), "Hola\nmundo", "Chrome", "Título de la página");
        assert_eq!(stored.path, folder.day());
        assert_eq!((stored.name.as_str(), stored.alone, stored.sensitive, stored.first_note), ("recortes-2026-10-14", false, false, true));
        // El archivo tiene el encabezado y el texto, sin saltos de línea de más ni al final.
        let raw = fs::read_to_string(&stored.path).unwrap();
        assert_eq!(raw, format!("— 14:32 · Chrome · «Título de la página»{0}Hola{0}mundo", newline()));
        // Y la hoja ya está en el Book, con ese texto, sin esperar a la vigilancia.
        let sheet = folder.sheet(&stored.path);
        assert_eq!(sheet.content, "— 14:32 · Chrome · «Título de la página»\nHola\nmundo");
        assert_eq!(sheet.summary.title, "recortes-2026-10-14.txt");
        assert!(!sheet.summary.secret && !sheet.summary.hidden);
        assert_eq!(sheet.summary.category_id, Some(folder.db.ensure_clippings_category().unwrap()));
        // El segundo ya no encuentra una carpeta nueva.
        assert!(!folder.send(&at(15, 0, 0), "otro", "Word", "").first_note);
    }

    #[test]
    fn los_recortes_siguientes_se_agregan_al_final_sin_perder_lo_anterior() {
        let folder = Folder::new("agregar");
        folder.send(&at(14, 32, 5), "Primero", "Chrome", "Página uno");
        folder.send(&at(14, 40, 1), "Segundo\ncon dos renglones", "Word", "Informe.docx");
        let last = folder.send(&at(18, 5, 59), "Tercero", "", "");
        assert_eq!(last.path, folder.day());
        // Lo que dice el archivo: tres recortes, uno debajo del otro, separados por una línea en blanco.
        let expected = "\
— 14:32 · Chrome · «Página uno»
Primero

— 14:40 · Word · «Informe.docx»
Segundo
con dos renglones

— 18:05";
        // (el tercero no tiene origen: solo la hora)
        let expected = format!("{expected}\nTercero");
        assert_eq!(folder.text_of(&last.path), expected);
        // Hay un solo archivo en la carpeta, y el cuaderno tiene su contenido entero.
        assert_eq!(fs::read_dir(&folder.dir).unwrap().count(), 1);
        assert_eq!(folder.sheet(&last.path).content, expected);
    }

    #[test]
    fn se_agrega_a_lo_que_el_usuario_escribio_en_la_hoja_del_dia_con_su_formato() {
        let folder = Folder::new("formato");
        fs::create_dir_all(&folder.dir).unwrap();
        let time = at(9, 15, 0);

        // UTF-8 con saltos de Windows: el recorte entra con \r\n, y lo anterior queda igual.
        fs::write(folder.day(), "mi nota\r\nsegundo renglón\r\n\r\n").unwrap();
        folder.send(&time, "uno\ndos", "Chrome", "");
        assert_eq!(fs::read(folder.day()).unwrap(), "mi nota\r\nsegundo renglón\r\n\r\n— 09:15 · Chrome\r\nuno\r\ndos".as_bytes());

        // UTF-8 con saltos de Unix: se queda con \n.
        fs::write(folder.day(), "mi nota\nsegundo").unwrap();
        folder.send(&time, "uno\ndos", "Chrome", "");
        assert_eq!(fs::read(folder.day()).unwrap(), "mi nota\nsegundo\n\n— 09:15 · Chrome\nuno\ndos".as_bytes());

        // UTF-8 con marca de orden de bytes: la marca sigue. (Un archivo sin ningún salto de línea
        // todavía no eligió cuáles usa: toma los del sistema, como al guardar desde el cuaderno.)
        fs::write(folder.day(), [&[0xEF, 0xBB, 0xBF][..], "año".as_bytes()].concat()).unwrap();
        folder.send(&time, "ñandú", "", "");
        let nl = newline();
        assert_eq!(
            fs::read(folder.day()).unwrap(),
            [&[0xEF, 0xBB, 0xBF][..], format!("año{nl}{nl}— 09:15{nl}ñandú").as_bytes()].concat()
        );

        // UTF-16 con saltos de Windows: ida y vuelta, sin perder nada.
        let utf16 = |text: &str| -> Vec<u8> { [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect() };
        fs::write(folder.day(), utf16("año\r\nviejo")).unwrap();
        folder.send(&time, "nuevo", "Edge", "");
        assert_eq!(fs::read(folder.day()).unwrap(), utf16("año\r\nviejo\r\n\r\n— 09:15 · Edge\r\nnuevo"));

        // ANSI (Windows-1252): sigue en ANSI mientras entre...
        fs::write(folder.day(), [b'a', 0xF1, b'o', b'\n']).unwrap();
        folder.send(&time, "ñandú", "Bloc de notas", "");
        let ansi = fs::read(folder.day()).unwrap();
        assert!(!ansi.starts_with(&[0xEF, 0xBB, 0xBF]), "pasó a UTF-8 sin necesidad");
        assert_eq!(&ansi[..4], &[b'a', 0xF1, b'o', b'\n']);
        assert_eq!(folder.text_of(&folder.day()), "año\n\n— 09:15 · Bloc de notas\nñandú");
        // ...y si no entra (un emoji), pasa a UTF-8 con marca, que cualquier editor reconoce.
        folder.send(&time, "listo ✓", "Bloc de notas", "");
        assert!(fs::read(folder.day()).unwrap().starts_with(&[0xEF, 0xBB, 0xBF]));
        assert_eq!(folder.text_of(&folder.day()), "año\n\n— 09:15 · Bloc de notas\nñandú\n\n— 09:15 · Bloc de notas\nlisto ✓");

        // En todos los casos la hoja del Book dice lo mismo que el archivo.
        assert_eq!(folder.sheet(&folder.day()).content, folder.text_of(&folder.day()));
    }

    #[test]
    fn un_recorte_sensible_va_a_una_hoja_propia_y_el_dia_no_se_mancha() {
        let folder = Folder::new("sensible");
        let day = folder.send(&at(10, 0, 0), "una receta de tarta", "Chrome", "Recetas");
        assert_eq!(day.path, folder.day());

        let cred_body = format!("cuenta: ana\n{}: {}", "clave", "MiClave123!");
        let key = folder.send(&at(11, 12, 13), &cred_body, "Chrome", "Mi banco");
        assert_eq!(key.path, folder.dir.join("recorte-2026-10-14-111213.txt"));
        assert_eq!((key.alone, key.sensitive), (true, true));
        // Lleva el mismo encabezado y pasa sola al secret-book.
        let own = folder.sheet(&key.path);
        assert_eq!(own.content, format!("— 11:12 · Chrome · «Mi banco»\n{cred_body}"));
        assert!(own.summary.secret, "la hoja con una clave tenía que ir al secret-book");

        // La hoja del día no la tiene, ni quedó marcada como secreta.
        assert_eq!(folder.text_of(&folder.day()), "— 10:00 · Chrome · «Recetas»\nuna receta de tarta");
        assert!(!folder.sheet(&folder.day()).summary.secret);
        // Y los recortes comunes que siguen vuelven a la del día.
        let later = folder.send(&at(12, 0, 0), "otra cosa", "Word", "");
        assert_eq!((later.path, later.alone), (folder.day(), false));
        assert!(!folder.sheet(&folder.day()).summary.secret);

        // También con un token conocido, sin la palabra «clave» en el texto.
        let pat_prefix = ["g", "hp_"].concat();
        let token_sample = format!("{pat_prefix}{}", "a".repeat(36));
        let token = folder.send(&at(12, 30, 0), &token_sample, "Firefox", "GitHub");
        assert!(token.alone && token.sensitive);
        // Cada hoja propia tiene su hora: dos seguidas no se pisan.
        let again = folder.send(&at(12, 30, 1), &token_sample, "Firefox", "GitHub");
        assert_ne!(token.path, again.path);
        assert_eq!(fs::read_dir(&folder.dir).unwrap().count(), 4);
    }

    #[test]
    fn dos_recortes_sensibles_del_mismo_segundo_no_se_pisan() {
        let folder = Folder::new("mismo-segundo");
        let secret_a = format!("{}: {}", "clave", "MiClave123!");
        let secret_b = format!("{}: {}", "clave", "OtraClave123!");
        let first = folder.send(&at(12, 30, 0), &secret_a, "", "");
        let second = folder.send(&at(12, 30, 0), &secret_b, "", "");
        assert_eq!(first.path, folder.dir.join("recorte-2026-10-14-123000.txt"));
        assert_eq!(second.path, folder.dir.join("recorte-2026-10-14-123000 (2).txt"));
        assert_eq!(folder.text_of(&first.path), format!("— 12:30\n{secret_a}"));
        assert_eq!(folder.text_of(&second.path), format!("— 12:30\n{secret_b}"));
    }

    #[test]
    fn si_la_hoja_del_dia_esta_en_la_papelera_el_recorte_va_a_una_propia() {
        let folder = Folder::new("papelera");
        let first = folder.send(&at(10, 0, 0), "uno", "Chrome", "");
        let id = folder.db.sheet_id("file", &first.path.to_string_lossy()).unwrap();
        folder.db.set_sheet_hidden(id, true).unwrap();

        // Agregarle algo la dejaría fuera de la vista: el recorte va aparte y a la vista.
        let second = folder.send(&at(11, 0, 0), "dos", "Chrome", "");
        assert_eq!((second.alone, second.sensitive), (true, false));
        assert_eq!(second.path, folder.dir.join("recorte-2026-10-14-110000.txt"));
        assert_eq!(folder.text_of(&first.path), "— 10:00 · Chrome\nuno", "la hoja de la papelera no se tocó");
        assert!(!folder.sheet(&second.path).summary.hidden);

        // Recuperada la hoja del día, vuelve a usarse.
        folder.db.set_sheet_hidden(id, false).unwrap();
        let third = folder.send(&at(12, 0, 0), "tres", "Chrome", "");
        assert!(!third.alone);
        assert_eq!(folder.text_of(&first.path), "— 10:00 · Chrome\nuno\n\n— 12:00 · Chrome\ntres");
    }

    #[test]
    fn si_el_archivo_del_dia_ya_no_es_de_texto_el_recorte_va_a_una_hoja_propia() {
        let folder = Folder::new("binario");
        fs::create_dir_all(&folder.dir).unwrap();
        let binary = [0u8, 1, 2, 0xFF, 0, 7];
        fs::write(folder.day(), binary).unwrap();
        let stored = folder.send(&at(10, 0, 0), "texto", "Chrome", "");
        assert!(stored.alone && !stored.sensitive);
        assert_eq!(fs::read(folder.day()).unwrap(), binary, "el archivo que no es de texto no se toca");
        assert_eq!(folder.text_of(&stored.path), "— 10:00 · Chrome\ntexto");
    }

    #[test]
    fn si_el_archivo_del_dia_se_borro_por_fuera_no_se_revive_la_hoja_vieja() {
        let folder = Folder::new("borrado");
        let first = folder.send(&at(10, 0, 0), "viejo", "Chrome", "");
        let old = folder.db.sheet_id("file", &first.path.to_string_lossy()).unwrap();
        fs::remove_file(&first.path).unwrap();
        assert!(folder.db.mark_missing("file", &first.path.to_string_lossy()));

        // La hoja nueva toma otro nombre, como al crear cualquier hoja, y la vieja sigue «sin original».
        let second = folder.send(&at(11, 0, 0), "nuevo", "Chrome", "");
        assert_eq!(second.path, folder.dir.join("recortes-2026-10-14 (2).txt"));
        assert!(!second.alone);
        let kept = folder.db.get_sheet(old).unwrap().unwrap();
        assert_eq!((kept.content.as_str(), kept.summary.missing), ("— 10:00 · Chrome\nviejo", true));
        assert_eq!(folder.text_of(&second.path), "— 11:00 · Chrome\nnuevo");
    }

    #[test]
    fn un_guardado_en_curso_de_la_hoja_del_dia_no_se_lleva_los_recortes() {
        let folder = Arc::new(Folder::new("carrera"));
        let first = folder.send(&at(8, 0, 0), "primero", "Chrome", "");
        let id = folder.db.sheet_id("file", &first.path.to_string_lossy()).unwrap();

        // Un hilo manda recortes sin parar...
        let sender = {
            let folder = Arc::clone(&folder);
            thread::spawn(move || {
                for n in 1..=40 {
                    folder.send(&at(9, 0, n), &format!("recorte {n}"), "Chrome", "");
                }
            })
        };
        // ...mientras otro edita y guarda la misma hoja desde el cuaderno, como lo hace `save_sheet`.
        let editor = {
            let folder = Arc::clone(&folder);
            thread::spawn(move || {
                let mut saved = 0;
                for n in 0..60 {
                    let sheet = folder.db.get_sheet(id).unwrap().unwrap();
                    let content = format!("{}\nmío {n}", sheet.content);
                    // Si llegó un recorte después de leer la hoja, el guardado avisa del conflicto en
                    // vez de pisarlo (y el cuaderno no pierde lo escrito).
                    if commands::save(&folder.db, Some(&folder.dir), id, &content, None, Some(&sheet.hash), false).is_ok() {
                        saved += 1;
                    }
                }
                saved
            })
        };
        sender.join().unwrap();
        let saved = editor.join().unwrap();

        let all = folder.text_of(&first.path);
        for n in 1..=40 {
            let line = format!("recorte {n}");
            assert_eq!(all.lines().filter(|found| *found == line).count(), 1, "el recorte {n} se perdió o se repitió");
        }
        assert!(all.starts_with("— 08:00 · Chrome\nprimero"));
        // Cada guardado que entró dejó su renglón, y los demás no escribieron nada.
        assert_eq!(all.matches("\nmío ").count(), saved);
        assert_eq!(folder.sheet(&first.path).content, all, "el cuaderno quedó con otra cosa que el archivo");
    }

    #[test]
    fn enviar_espera_a_que_termine_un_guardado_que_esta_en_curso() {
        let folder = Arc::new(Folder::new("candado"));
        let finished = Arc::new(AtomicUsize::new(0));
        let turn = commands::writing();
        let waiting = {
            let (folder, finished) = (Arc::clone(&folder), Arc::clone(&finished));
            thread::spawn(move || {
                folder.send(&at(10, 0, 0), "texto", "Chrome", "");
                finished.fetch_add(1, Ordering::SeqCst);
            })
        };
        thread::sleep(Duration::from_millis(200));
        assert_eq!(finished.load(Ordering::SeqCst), 0, "escribió mientras otro guardado tenía el candado");
        assert!(!folder.day().exists());
        drop(turn);
        waiting.join().unwrap();
        assert_eq!(finished.load(Ordering::SeqCst), 1);
        assert_eq!(folder.text_of(&folder.day()), "— 10:00 · Chrome\ntexto");
    }

    #[test]
    fn el_aviso_dice_donde_quedo_el_recorte() {
        let stored = |name: &str, sensitive: bool| Stored {
            path: PathBuf::from(format!("{name}.txt")),
            name: name.into(),
            alone: sensitive,
            sensitive,
            first_note: false,
        };
        assert_eq!(confirmation(&stored("recortes-2026-10-14", false)), ("Enviado a Folio", "recortes-2026-10-14".to_string()));
        let (title, body) = confirmation(&stored("recorte-2026-10-14-143205", true));
        assert_eq!(title, "Enviado al secret-book");
        assert!(body.starts_with("recorte-2026-10-14-143205"), "{body}");
        assert_eq!(confirmation_for(&stored("recortes-2026-10-14", false), true), ("Sent to Folio", "recortes-2026-10-14".to_string()));
        let (title, body) = confirmation_for(&stored("recorte-2026-10-14-143205", true), true);
        assert_eq!(title, "Sent to the secret-book");
        assert!(body.starts_with("recorte-2026-10-14-143205"), "{body}");
    }

    #[test]
    fn el_destino_se_lee_de_los_ajustes_y_si_no_sirve_es_la_hoja_del_dia() {
        assert_eq!(Target::parse("all"), Ok(Target::All));
        assert_eq!(Target::parse("day"), Ok(Target::Day));
        assert_eq!(Target::parse("week"), Ok(Target::Week));
        assert_eq!(Target::parse("month"), Ok(Target::Month));
        assert_eq!(Target::parse("sheet"), Ok(Target::Sheet));
        assert!(Target::parse("Day").unwrap_err().contains("no es un destino"));
        assert!(Target::parse("").is_err());
        assert_eq!(
            (Target::All.id(), Target::Day.id(), Target::Week.id(), Target::Month.id(), Target::Sheet.id()),
            ("all", "day", "week", "month", "sheet")
        );

        let db = Db::open(Path::new(":memory:")).unwrap();
        assert_eq!(Target::load(&db), Target::Day);
        db.set_setting("send_to", "all").unwrap();
        assert_eq!(Target::load(&db), Target::All);
        db.set_setting("send_to", "week").unwrap();
        assert_eq!(Target::load(&db), Target::Week);
        db.set_setting("send_to", "month").unwrap();
        assert_eq!(Target::load(&db), Target::Month);
        db.set_setting("send_to", "sheet").unwrap();
        assert_eq!(Target::load(&db), Target::Sheet);
        db.set_setting("send_to", "otra cosa").unwrap();
        assert_eq!(Target::load(&db), Target::Day);
    }

    #[test]
    fn los_destinos_universal_semanal_y_mensual_usan_su_propia_hoja() {
        let folder = Folder::new("destinos");
        // Miércoles 14/10/2026: el lunes de esa semana es 2026-10-12.
        let wed = at(14, 0, 0);
        let fri = LocalTime { year: 2026, month: 10, day: 16, hour: 10, minute: 0, second: 0 };

        folder.db.set_setting("send_to", "all").unwrap();
        let all1 = folder.send(&wed, "recorte uno", "Chrome", "");
        let all2 = folder.send(&fri, "recorte dos", "Chrome", "");
        assert_eq!(all1.path, folder.dir.join("recortes.txt"));
        assert_eq!(all2.path, folder.dir.join("recortes.txt"));
        assert_eq!(folder.text_of(&all1.path), "— 14:00 · Chrome\nrecorte uno\n\n— 10:00 · Chrome\nrecorte dos");

        folder.db.set_setting("send_to", "week").unwrap();
        let week1 = folder.send(&wed, "semana uno", "Chrome", "");
        let week2 = folder.send(&fri, "semana dos", "Chrome", "");
        assert_eq!(week1.path, folder.dir.join("recortes-semana-2026-10-12.txt"));
        assert_eq!(week2.path, folder.dir.join("recortes-semana-2026-10-12.txt"));
        assert_eq!(folder.text_of(&week1.path), "— 14:00 · Chrome\nsemana uno\n\n— 10:00 · Chrome\nsemana dos");

        folder.db.set_setting("send_to", "month").unwrap();
        let month1 = folder.send(&wed, "mes uno", "Chrome", "");
        let month2 = folder.send(&fri, "mes dos", "Chrome", "");
        assert_eq!(month1.path, folder.dir.join("recortes-2026-10.txt"));
        assert_eq!(month2.path, folder.dir.join("recortes-2026-10.txt"));
        assert_eq!(folder.text_of(&month1.path), "— 14:00 · Chrome\nmes uno\n\n— 10:00 · Chrome\nmes dos");
    }
}
