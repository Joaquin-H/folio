use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, ToSql};
use sha2::{Digest, Sha256};

use crate::frontmatter;
use crate::model::*;
use crate::provider::Verdict;
use crate::scanner::CASE_BLIND;
use crate::secrets;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#8E8E93',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sheets (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  source_mtime INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  last_change_at INTEGER NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_source TEXT,
  category_confidence REAL,
  note_score REAL,
  classified_hash TEXT,
  classified_at INTEGER,
  jev_choice INTEGER,
  jev_confidence REAL,
  secret INTEGER NOT NULL DEFAULT 0,
  secret_source TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  missing_at INTEGER,
  UNIQUE(source, source_key)
);
CREATE INDEX IF NOT EXISTS sheets_by_date ON sheets(modified_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sheets_by_hash ON sheets(content_hash);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_by_sheet ON versions(sheet_id, saved_at DESC);
CREATE TABLE IF NOT EXISTS roots (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS bans (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  pattern TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind, pattern)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jev_cache (
  content_hash TEXT NOT NULL,
  categories TEXT NOT NULL,
  choice INTEGER,
  confidence REAL NOT NULL,
  note_score REAL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (content_hash, categories)
);
CREATE VIRTUAL TABLE IF NOT EXISTS sheets_fts USING fts5(
  title, content, tokenize = 'unicode61 remove_diacritics 2'
);
"#;

const SUMMARY_COLS: &str = "s.id, s.source, s.title, s.path, \
  CASE WHEN s.secret = 1 THEN s.content ELSE substr(s.content, 1, 900) END, \
  length(s.content), s.size, s.modified_at, s.category_id, s.category_source, \
  s.category_confidence, s.note_score, s.secret, s.secret_source, s.hidden, s.missing, \
  (SELECT count(*) FROM versions v WHERE v.sheet_id = s.id)";

const DEFAULT_CATEGORIES: &[(&str, &str, &str)] = &[
    ("Trabajo", "Tareas, reuniones, pendientes y temas laborales", "#007AFF"),
    ("Proyectos", "Planes, ideas y avances de proyectos propios o de software", "#5856D6"),
    ("Código", "Fragmentos de código, comandos de terminal y configuraciones técnicas", "#30B0C7"),
    ("Casa", "Hogar, trámites domésticos, arreglos y familia", "#34C759"),
    ("Compras", "Listas de compras, productos y precios", "#FF9500"),
    ("Finanzas", "Gastos, pagos, cuentas y presupuestos", "#FFCC00"),
    ("Salud", "Turnos médicos, medicación y ejercicio", "#FF2D55"),
    ("Ideas", "Ideas sueltas, reflexiones y cosas para investigar", "#AF52DE"),
];

const DEFAULT_CATEGORIES_EN: &[(&str, &str, &str)] = &[
    ("Work", "Tasks, meetings, to-dos and work topics", "#007AFF"),
    ("Projects", "Plans, ideas, personal projects or software development", "#5856D6"),
    ("Code", "Code snippets, terminal commands and technical configurations", "#30B0C7"),
    ("Home", "House, domestic chores, repairs and family", "#34C759"),
    ("Shopping", "Shopping lists, products and prices", "#FF9500"),
    ("Finance", "Expenses, payments, accounts and budgets", "#FFCC00"),
    ("Health", "Medical appointments, medication and fitness", "#FF2D55"),
    ("Ideas", "Random thoughts, reflections and topics to explore", "#AF52DE"),
];

/// Hojas que se le pueden mandar al clasificador: nunca las secretas, las de la papelera ni las que
/// tienen la categoría puesta a mano.
const JEV_ELIGIBLE: &str =
    "secret = 0 AND hidden = 0 AND (category_source IS NULL OR category_source = 'jev')";

/// Con menos de unos 20 caracteres escritos no hay qué clasificar: la hoja espera sin
/// gastar una consulta. Alcanza con mirar el comienzo, que además es barato.
const JEV_ENOUGH_TEXT: &str = "length(replace(replace(replace(replace(substr(content, 1, 2000), \
    ' ', ''), char(10), ''), char(13), ''), char(9), '')) >= 20";

/// Veredictos que se recuerdan para no repetir una consulta idéntica.
const JEV_CACHE_ROWS: i64 = 2000;

/// Carpetas que nunca contienen notas propias (se comparan en minúsculas).
const DEFAULT_BANNED_DIRS: &[&str] = &[
    "node_modules",
    "appdata",
    "target",
    "dist",
    "build",
    "vendor",
    "venv",
    "__pycache__",
    "site-packages",
    "logs",
    "$recycle.bin",
    "system volume information",
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
];

/// Archivos típicos de repositorios y herramientas, no notas.
const DEFAULT_BANNED_FILES: &[&str] = &[
    "README*",
    "LICENSE*",
    "LICENCE*",
    "COPYING*",
    "CHANGELOG*",
    "CONTRIBUTING*",
    "CODE_OF_CONDUCT*",
    "SECURITY.md",
    "AUTHORS*",
    "NOTICE*",
    "requirements*.txt",
    "CMakeLists.txt",
    "robots.txt",
    "SKILL.md",
    "CLAUDE.md",
    "AGENTS.md",
    "GEMINI.md",
];

pub struct Incoming {
    pub source: &'static str,
    pub source_key: String,
    pub title: String,
    pub path: Option<String>,
    pub content: String,
    pub size: i64,
    pub source_mtime: i64,
    pub created_at: i64,
    pub modified_at: i64,
}

pub struct VersionCfg {
    pub keep: i64,
    pub session_gap_ms: i64,
}

/// Cuándo se le consulta al clasificador por una hoja (sale de los ajustes).
#[derive(Debug, Clone, Copy)]
pub struct JevPolicy {
    /// Una hoja se manda recién cuando lleva este tiempo sin cambiar.
    pub calm_ms: i64,
    /// Cada cuánto se vuelve a consultar por una hoja ya evaluada cuyo texto cambió;
    /// 0 = nunca.
    pub recheck_ms: i64,
    /// Confianza mínima para aplicar la categoría que eligió la IA.
    pub threshold: f64,
}

/// Lo que el clasificador lee de una categoría: id, nombre y descripción.
pub type CategoryDef = (i64, String, String);

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Outcome {
    Unchanged,
    Created,
    Updated,
}

/// De dónde sale una hoja: lo necesario para guardar cambios hechos desde Book.
pub struct Origin {
    pub source: String,
    pub key: String,
    pub path: Option<String>,
    pub created_at: i64,
    pub missing: bool,
    pub hidden: bool,
}

pub struct PendingSheet {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub hash: String,
}

pub struct Db {
    conn: Mutex<Connection>,
    vault: crate::crypto::Vault,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn map_summary(r: &Row) -> rusqlite::Result<SheetSummary> {
    Ok(SheetSummary {
        id: r.get(0)?,
        source: r.get(1)?,
        title: r.get(2)?,
        path: r.get(3)?,
        preview: r.get(4)?,
        length: r.get(5)?,
        size: r.get(6)?,
        modified_at: r.get(7)?,
        category_id: r.get(8)?,
        category_source: r.get(9)?,
        category_confidence: r.get(10)?,
        note_score: r.get(11)?,
        secret: r.get(12)?,
        secret_source: r.get(13)?,
        hidden: r.get(14)?,
        missing: r.get(15)?,
        version_count: r.get(16)?,
    })
}

/// La categoría que pide el encabezado de una nota (`categoria: Trabajo`), si existe una
/// que se llame así sin contar tildes ni mayúsculas, pasa a ser la de la hoja como si la
/// hubiera elegido el usuario: así el clasificador no la pisa. Solo en hojas sin
/// categoría o con la que puso el clasificador: una elegida a mano nunca se toca. Si no
/// existe una categoría con ese nombre, no se crea ninguna.
fn header_category(conn: &Connection, id: i64, wanted: &str) -> rusqlite::Result<()> {
    let wanted = frontmatter::fold(wanted);
    let mut stmt = conn.prepare("SELECT id, name FROM categories ORDER BY position, id")?;
    let found = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(Result::ok)
        .find(|(_, name)| frontmatter::fold(name) == wanted);
    if let Some((category, _)) = found {
        conn.execute(
            "UPDATE sheets SET category_id = ?1, category_source = 'manual', category_confidence = NULL              WHERE id = ?2 AND (category_source IS NULL OR category_source = 'jev')",
            params![category, id],
        )?;
    }
    Ok(())
}

fn refresh_fts(
    conn: &Connection,
    id: i64,
    title: &str,
    content: &str,
    searchable: bool,
) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sheets_fts WHERE rowid = ?1", [id])?;
    if searchable {
        conn.execute(
            "INSERT INTO sheets_fts (rowid, title, content) VALUES (?1, ?2, ?3)",
            params![id, title, content],
        )?;
    }
    Ok(())
}

/// Convierte lo que escribe el usuario en una consulta FTS5 de prefijos ("pal"* "otra"*).
fn fts_query(input: &str) -> Option<String> {
    let tokens: Vec<String> = input
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect();
    (!tokens.is_empty()).then(|| tokens.join(" "))
}

fn escape_like(input: &str) -> String {
    input.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

fn view_conditions(filter: &ListFilter, conds: &mut Vec<String>, args: &mut Vec<Box<dyn ToSql>>) {
    match filter.view.as_str() {
        "secret" => conds.push("s.secret = 1 AND s.hidden = 0".into()),
        "hidden" => conds.push("s.hidden = 1".into()),
        "uncategorized" => {
            conds.push("s.secret = 0 AND s.hidden = 0 AND s.category_id IS NULL".into())
        }
        "category" => {
            conds.push("s.secret = 0 AND s.hidden = 0 AND s.category_id = ?".into());
            args.push(Box::new(filter.category_id.unwrap_or(-1)));
        }
        _ => conds.push("s.secret = 0 AND s.hidden = 0".into()),
    }
    let query = filter.query.as_deref().map(str::trim).filter(|q| !q.is_empty());
    if let Some(q) = query {
        if filter.view != "secret" {
            let in_index = filter.view != "hidden";
            if let Some(m) = fts_query(q).filter(|_| in_index) {
                conds.push("s.id IN (SELECT rowid FROM sheets_fts WHERE sheets_fts MATCH ?)".into());
                args.push(Box::new(m));
            } else {
                conds.push(
                    "(s.title LIKE ? ESCAPE '\\' OR s.content LIKE ? ESCAPE '\\')".into(),
                );
                let like = format!("%{}%", escape_like(q));
                args.push(Box::new(like.clone()));
                args.push(Box::new(like));
            }
        }
    }
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if path == Path::new(":memory:") {
            return Self::open_in_memory();
        }
        Self::setup(Connection::open(path)?, crate::crypto::Vault::system())
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let key = [7u8; crate::crypto::KEY_LEN];
        Self::open_in_memory_with_key(key)
    }

    pub fn open_in_memory_with_key(key: [u8; crate::crypto::KEY_LEN]) -> rusqlite::Result<Self> {
        Self::setup(
            Connection::open_in_memory()?,
            crate::crypto::Vault::in_memory_with_key(key),
        )
    }

    /// Deja la base lista para usar: crea lo que falte y pone al día las de versiones
    /// anteriores.
    pub fn setup(mut conn: Connection, vault: crate::crypto::Vault) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        Self::migrate(&mut conn)?;
        let db = Self {
            conn: Mutex::new(conn),
            vault,
        };
        db.seed()?;
        let _ = db.encrypt_plaintext_secrets();
        Ok(db)
    }

    /// Agrega las columnas que las bases creadas por una versión anterior no tienen.
    fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
        let tx = conn.transaction()?;
        let has = |column: &str| {
            tx.prepare("SELECT 1 FROM pragma_table_info('sheets') WHERE name = ?1")?.exists([column])
        };
        if !has("missing_at")? {
            tx.execute("ALTER TABLE sheets ADD COLUMN missing_at INTEGER", [])?;
        }
        // Antes solo se guardaba la categoría ya filtrada por la confianza mínima. Lo que
        // el clasificador eligió en su momento pasa a ser la elección cruda, y lo ya evaluado cuenta
        // como evaluado ahora: no se vuelve a consultar por actualizar Book.
        if !has("jev_choice")? {
            tx.execute_batch(
                "ALTER TABLE sheets ADD COLUMN classified_at INTEGER; \
                 ALTER TABLE sheets ADD COLUMN jev_choice INTEGER; \
                 ALTER TABLE sheets ADD COLUMN jev_confidence REAL;",
            )?;
            tx.execute(
                "UPDATE sheets SET classified_at = ?1 WHERE classified_hash IS NOT NULL",
                [now_ms()],
            )?;
            tx.execute(
                "UPDATE sheets SET jev_confidence = category_confidence, \
                 jev_choice = CASE WHEN category_source = 'jev' THEN category_id END \
                 WHERE category_source IS NULL OR category_source = 'jev'",
                [],
            )?;
        }
        tx.commit()
    }

    pub fn encrypt_plaintext_secrets(&self) -> rusqlite::Result<()> {
        let mut conn = self.lock();
        let has_plain_sheets: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sheets WHERE secret = 1 AND content NOT LIKE 'enc1:%' LIMIT 1)",
            [],
            |r| r.get(0),
        )?;
        let has_plain_versions: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM versions v JOIN sheets s ON s.id = v.sheet_id WHERE s.secret = 1 AND v.content NOT LIKE 'enc1:%' LIMIT 1)",
            [],
            |r| r.get(0),
        )?;
        if !has_plain_sheets && !has_plain_versions {
            return Ok(());
        }

        let has_enc: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sheets WHERE content LIKE 'enc1:%' LIMIT 1)",
            [],
            |r| r.get(0),
        )?;
        if has_enc && self.vault.current_key().map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e))))?.is_none() {
            return Ok(());
        }

        let key = self.vault.get_or_create_key().map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
        })?;

        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare("SELECT id, content FROM sheets WHERE secret = 1 AND content NOT LIKE 'enc1:%'")?;
            let sheets: Vec<(i64, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut upd = tx.prepare("UPDATE sheets SET content = ?1 WHERE id = ?2")?;
            for (id, content) in sheets {
                let enc = crate::crypto::encrypt(&key, &content).map_err(|e| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                })?;
                upd.execute(params![enc, id])?;
            }
        }
        {
            let mut stmt = tx.prepare("SELECT v.id, v.content FROM versions v JOIN sheets s ON s.id = v.sheet_id WHERE s.secret = 1 AND v.content NOT LIKE 'enc1:%'")?;
            let versions: Vec<(i64, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut upd = tx.prepare("UPDATE versions SET content = ?1 WHERE id = ?2")?;
            for (id, content) in versions {
                let enc = crate::crypto::encrypt(&key, &content).map_err(|e| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                })?;
                upd.execute(params![enc, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn secret_locked_count(&self) -> i64 {
        if let Ok(Some(_)) = self.vault.current_key() {
            return 0;
        }
        self.lock()
            .query_row(
                "SELECT count(*) FROM sheets WHERE content LIKE 'enc1:%'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    pub fn secret_state(&self) -> SecretState {
        match self.vault.current_key() {
            Ok(Some(_)) => SecretState::Ready,
            _ => {
                let count: i64 = self
                    .lock()
                    .query_row(
                        "SELECT count(*) FROM sheets WHERE content LIKE 'enc1:%'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                if count > 0 {
                    SecretState::Locked
                } else {
                    SecretState::Empty
                }
            }
        }
    }

    pub fn export_secret_key(&self) -> rusqlite::Result<String> {
        if let Some(key) = self.vault.current_key().map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
        })? {
            return Ok(crate::crypto::encode_key(&key));
        }

        let has_enc: bool = self.lock().query_row(
            "SELECT EXISTS(SELECT 1 FROM sheets WHERE content LIKE 'enc1:%' LIMIT 1)",
            [],
            |r| r.get(0),
        )?;
        if has_enc {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                "El secret-book está bloqueado: falta la clave.",
            ))));
        }

        let key = self.vault.get_or_create_key().map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
        })?;
        self.encrypt_plaintext_secrets()?;
        Ok(crate::crypto::encode_key(&key))
    }

    pub fn import_secret_key(&self, encoded: &str) -> rusqlite::Result<()> {
        let key = crate::crypto::parse_backup(encoded)
            .or_else(|_| crate::crypto::decode_key(encoded))
            .map_err(|e| {
                rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
            })?;

        let conn = self.lock();
        let enc_sample: Option<String> = conn
            .query_row(
                "SELECT content FROM sheets WHERE content LIKE 'enc1:%' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?
            .or_else(|| {
                conn.query_row(
                    "SELECT content FROM versions WHERE content LIKE 'enc1:%' LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .ok()
                .flatten()
            });

        if let Some(sample) = enc_sample {
            if crate::crypto::decrypt(&key, &sample).is_err() {
                return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "Esa clave no abre las hojas secretas de este cuaderno.",
                ))));
            }
        }
        drop(conn);

        self.vault.set_key(&key).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
        })?;
        self.encrypt_plaintext_secrets()?;
        Ok(())
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn seed(&self) -> rusqlite::Result<()> {
        let first_run = self.get_setting("seeded").is_none();
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        // Las exclusiones de fábrica se completan en cada arranque: una versión nueva
        // puede sumar alguna, y las que el usuario desactivó quedan como estaban.
        for dir in DEFAULT_BANNED_DIRS {
            tx.execute(
                "INSERT OR IGNORE INTO bans (kind, pattern, builtin) VALUES ('dir', ?1, 1)",
                [dir],
            )?;
        }
        if cfg!(target_os = "macos") {
            tx.execute(
                "INSERT OR IGNORE INTO bans (kind, pattern, builtin) VALUES ('dir', 'library', 1)",
                [],
            )?;
        }
        for file in DEFAULT_BANNED_FILES {
            tx.execute(
                "INSERT OR IGNORE INTO bans (kind, pattern, builtin) VALUES ('file', ?1, 1)",
                [file],
            )?;
        }
        if first_run {
            let is_en = tx
                .query_row("SELECT value FROM settings WHERE key = 'locale'", [], |r| r.get::<_, String>(0))
                .optional()
                .ok()
                .flatten()
                .as_deref()
                == Some("en");
            let defaults = if is_en { DEFAULT_CATEGORIES_EN } else { DEFAULT_CATEGORIES };
            for (i, (name, description, color)) in defaults.iter().enumerate() {
                tx.execute(
                    "INSERT OR IGNORE INTO categories (name, description, color, position) VALUES (?1, ?2, ?3, ?4)",
                    params![name, description, color, i as i64],
                )?;
            }
            if let Some(home) = dirs::home_dir() {
                tx.execute(
                    "INSERT OR IGNORE INTO roots (path) VALUES (?1)",
                    [home.to_string_lossy().to_string()],
                )?;
            }
            tx.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('seeded', '1')", [])?;
        }
        tx.commit()?;
        drop(conn);
        let _ = self.ensure_clippings_category();
        Ok(())
    }

    // ---- ajustes -------------------------------------------------------

    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.lock()
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_i64(&self, key: &str, default: i64) -> i64 {
        self.get_setting(key).and_then(|v| v.parse().ok()).unwrap_or(default)
    }

    pub fn get_f64(&self, key: &str, default: f64) -> f64 {
        self.get_setting(key).and_then(|v| v.parse().ok()).unwrap_or(default)
    }

    pub fn get_bool(&self, key: &str, default: bool) -> bool {
        self.get_setting(key).map(|v| v == "1").unwrap_or(default)
    }

    pub fn version_cfg(&self) -> VersionCfg {
        VersionCfg {
            keep: self.get_i64("versions_keep", 2).clamp(0, 20),
            session_gap_ms: self.get_i64("session_gap_min", 5).clamp(0, 240) * 60_000,
        }
    }

    pub fn jev_policy(&self) -> JevPolicy {
        JevPolicy {
            // La misma pausa que da por terminada una sesión de edición, con un piso de
            // dos minutos para no consultar a mitad de la escritura.
            calm_ms: self.get_i64("session_gap_min", 5).clamp(2, 240) * 60_000,
            recheck_ms: self.get_i64("jev_recheck_days", 0).clamp(0, 365) * 86_400_000,
            threshold: self.get_f64("jev_threshold", 0.6),
        }
    }

    // ---- hojas ---------------------------------------------------------

    /// Inserta o actualiza una hoja. Si el contenido cambió y ya terminó la sesión de
    /// edición anterior, la versión previa pasa al historial (se conservan `cfg.keep`).
    pub fn upsert_sheet(&self, inc: &Incoming, cfg: &VersionCfg) -> rusqlite::Result<Outcome> {
        self.upsert(inc, cfg, true)
    }

    /// Como `upsert_sheet`, para una hoja que el usuario acaba de escribir en Book: si no
    /// existía, nace limpia. No toma el lugar de una hoja huérfana con el mismo texto,
    /// que le dejaría sus marcas (papelera, secret-book) a una hoja nueva.
    pub fn upsert_written(&self, inc: &Incoming, cfg: &VersionCfg) -> rusqlite::Result<Outcome> {
        self.upsert(inc, cfg, false)
    }

    fn upsert(&self, inc: &Incoming, cfg: &VersionCfg, adopt: bool) -> rusqlite::Result<Outcome> {
        struct Existing {
            id: i64,
            content: String,
            hash: String,
            modified_at: i64,
            last_change_at: i64,
            secret: bool,
            secret_source: Option<String>,
            hidden: bool,
            missing: bool,
        }

        let new_hash = hash(&inc.content);
        let now = now_ms();
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let existing = tx
            .query_row(
                "SELECT id, content, content_hash, modified_at, last_change_at, secret, \
                 secret_source, hidden, missing FROM sheets WHERE source = ?1 AND source_key = ?2",
                params![inc.source, inc.source_key],
                |r| {
                    Ok(Existing {
                        id: r.get(0)?,
                        content: r.get(1)?,
                        hash: r.get(2)?,
                        modified_at: r.get(3)?,
                        last_change_at: r.get(4)?,
                        secret: r.get(5)?,
                        secret_source: r.get(6)?,
                        hidden: r.get(7)?,
                        missing: r.get(8)?,
                    })
                },
            )
            .optional()?;

        let (outcome, id) = match existing {
            None => {
                // Un archivo nuevo con el mismo contenido que una hoja huérfana es esa hoja:
                // o bien el archivo se movió o renombró, o bien es una pestaña del Bloc de
                // notas que se acaba de guardar. Conserva su categoría, sus versiones y sus
                // marcas. Si hay varias huérfanas con el mismo texto, gana la que se llamaba
                // igual (al mover una carpeta los nombres no cambian) y, después, la que
                // desapareció más recientemente: así ninguna se queda con lo de otra.
                let orphan: Option<(i64, bool, bool)> = if adopt && inc.source == "file" {
                    tx.query_row(
                        "SELECT id, secret, hidden FROM sheets \
                         WHERE content_hash = ?1 \
                           AND ((source = 'file' AND missing = 1) OR source = 'notepad') \
                         ORDER BY (source = 'file') DESC, (title = ?2) DESC, \
                           coalesce(missing_at, 0) DESC, modified_at DESC, id DESC LIMIT 1",
                        params![new_hash, inc.title],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()?
                } else {
                    None
                };
                if let Some((id, secret, hidden)) = orphan {
                    let content_to_store = if secret {
                        let key = self.vault.get_or_create_key().map_err(|e| {
                            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                        })?;
                        crate::crypto::encrypt(&key, &inc.content).map_err(|e| {
                            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                        })?
                    } else {
                        inc.content.clone()
                    };
                    tx.execute(
                        "UPDATE sheets SET source = 'file', source_key = ?1, path = ?2, title = ?3, \
                         content = ?4, size = ?5, source_mtime = ?6, modified_at = ?7, missing = 0, \
                         missing_at = NULL WHERE id = ?8",
                        params![
                            inc.source_key,
                            inc.path,
                            inc.title,
                            content_to_store,
                            inc.size,
                            inc.source_mtime,
                            inc.modified_at,
                            id
                        ],
                    )?;
                    refresh_fts(&tx, id, &inc.title, &inc.content, !secret && !hidden)?;
                    (Outcome::Updated, id)
                } else {
                    let sensitive = secrets::detect(&inc.content).is_some();
                    let content_to_store = if sensitive {
                        let key = self.vault.get_or_create_key().map_err(|e| {
                            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                        })?;
                        crate::crypto::encrypt(&key, &inc.content).map_err(|e| {
                            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                        })?
                    } else {
                        inc.content.clone()
                    };
                    tx.execute(
                        "INSERT INTO sheets (source, source_key, title, path, content, content_hash, \
                         size, source_mtime, created_at, modified_at, last_change_at, secret, secret_source) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                        params![
                            inc.source,
                            inc.source_key,
                            inc.title,
                            inc.path,
                            content_to_store,
                            new_hash,
                            inc.size,
                            inc.source_mtime,
                            inc.created_at,
                            inc.modified_at,
                            now,
                            sensitive,
                            sensitive.then_some("auto"),
                        ],
                    )?;
                    let id = tx.last_insert_rowid();
                    refresh_fts(&tx, id, &inc.title, &inc.content, !sensitive)?;
                    (Outcome::Created, id)
                }
            }
            Some(old) if old.hash == new_hash => {
                tx.execute(
                    "UPDATE sheets SET source_mtime = ?1, size = ?2, missing = 0, missing_at = NULL \
                     WHERE id = ?3",
                    params![inc.source_mtime, inc.size, old.id],
                )?;
                if old.missing {
                    (Outcome::Updated, old.id)
                } else {
                    (Outcome::Unchanged, old.id)
                }
            }
            Some(old) => {
                if now - old.last_change_at > cfg.session_gap_ms {
                    tx.execute(
                        "INSERT INTO versions (sheet_id, content, content_hash, saved_at) \
                         VALUES (?1, ?2, ?3, ?4)",
                        params![old.id, old.content, old.hash, old.modified_at],
                    )?;
                    tx.execute(
                        "DELETE FROM versions WHERE sheet_id = ?1 AND id NOT IN (\
                         SELECT id FROM versions WHERE sheet_id = ?1 \
                         ORDER BY saved_at DESC, id DESC LIMIT ?2)",
                        params![old.id, cfg.keep],
                    )?;
                }
                let mut secret = old.secret;
                let mut secret_source = old.secret_source;
                // Solo se marca sola si el usuario nunca decidió sobre esta hoja.
                if !secret && secret_source.is_none() && secrets::detect(&inc.content).is_some() {
                    secret = true;
                    secret_source = Some("auto".into());
                }
                let content_to_store = if secret {
                    let key = self.vault.get_or_create_key().map_err(|e| {
                        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                    })?;
                    if !old.secret {
                        let mut v_stmt = tx.prepare("SELECT id, content FROM versions WHERE sheet_id = ?1")?;
                        let v_rows: Vec<(i64, String)> = v_stmt.query_map([old.id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                        let mut v_upd = tx.prepare("UPDATE versions SET content = ?1 WHERE id = ?2")?;
                        for (vid, v_content) in v_rows {
                            let v_enc = crate::crypto::encrypt_if_plain(&key, &v_content).map_err(|e| {
                                rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                            })?;
                            v_upd.execute(params![v_enc, vid])?;
                        }
                    }
                    crate::crypto::encrypt(&key, &inc.content).map_err(|e| {
                        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                    })?
                } else {
                    inc.content.clone()
                };
                tx.execute(
                    "UPDATE sheets SET title = ?1, path = ?2, content = ?3, content_hash = ?4, \
                     size = ?5, source_mtime = ?6, modified_at = ?7, last_change_at = ?8, \
                     secret = ?9, secret_source = ?10, missing = 0, missing_at = NULL WHERE id = ?11",
                    params![
                        inc.title,
                        inc.path,
                        content_to_store,
                        new_hash,
                        inc.size,
                        inc.source_mtime,
                        inc.modified_at,
                        now,
                        secret,
                        secret_source,
                        old.id
                    ],
                )?;
                refresh_fts(&tx, old.id, &inc.title, &inc.content, !secret && !old.hidden)?;
                (Outcome::Updated, old.id)
            }
        };
        // La categoría que pide el encabezado de la nota. También con el texto sin
        // cambios: la categoría puede haberse creado después de la nota.
        if let Some(wanted) = frontmatter::category(&inc.content) {
            header_category(&tx, id, &wanted)?;
        }
        tx.commit()?;
        Ok(outcome)
    }

    pub fn list_sheets(&self, filter: &ListFilter) -> rusqlite::Result<Vec<SheetSummary>> {
        let mut conds = Vec::new();
        let mut args: Vec<Box<dyn ToSql>> = Vec::new();
        view_conditions(filter, &mut conds, &mut args);
        if let Some(until) = filter.until {
            conds.push("s.modified_at <= ?".into());
            args.push(Box::new(until));
        }
        if let (Some(ts), Some(id)) = (filter.before_ts, filter.before_id) {
            conds.push("(s.modified_at < ? OR (s.modified_at = ? AND s.id < ?))".into());
            args.push(Box::new(ts));
            args.push(Box::new(ts));
            args.push(Box::new(id));
        }
        let limit = filter.limit.unwrap_or(40).clamp(1, 500);

        let sql = if filter.view == "secret" {
            format!(
                "SELECT {SUMMARY_COLS}, s.content FROM sheets s WHERE {} \
                 ORDER BY s.modified_at DESC, s.id DESC",
                conds.join(" AND ")
            )
        } else {
            args.push(Box::new(limit));
            format!(
                "SELECT {SUMMARY_COLS} FROM sheets s WHERE {} \
                 ORDER BY s.modified_at DESC, s.id DESC LIMIT ?",
                conds.join(" AND ")
            )
        };
        let conn = self.lock();
        let mut stmt = conn.prepare(&sql)?;

        if filter.view == "secret" {
            let key = self.vault.current_key().unwrap_or(None);
            let query = filter.query.as_deref().map(str::trim).filter(|q| !q.is_empty()).map(|q| q.to_lowercase());
            let rows = stmt.query_map(params_from_iter(args.iter().map(|a| a.as_ref())), |r| {
                Ok((map_summary(r)?, r.get::<_, String>(17)?))
            })?;
            let mut results = Vec::new();
            for item in rows {
                let (mut summary, full_content) = item?;
                let plain_opt = if crate::crypto::is_encrypted(&full_content) {
                    key.as_ref().and_then(|k| crate::crypto::decrypt(k, &full_content).ok())
                } else {
                    Some(full_content)
                };

                if let Some(plain) = plain_opt.as_ref() {
                    summary.preview = plain.chars().take(900).collect();
                    summary.length = plain.chars().count() as i64;
                } else {
                    summary.preview = String::new();
                }

                if let Some(ref q) = query {
                    let title_match = summary.title.to_lowercase().contains(q);
                    let content_match = plain_opt.as_ref().is_some_and(|p| p.to_lowercase().contains(q));
                    if title_match || content_match {
                        results.push(summary);
                    }
                } else {
                    results.push(summary);
                }
                if results.len() >= limit as usize {
                    break;
                }
            }
            Ok(results)
        } else {
            let key = self.vault.current_key().unwrap_or(None);
            let rows = stmt.query_map(params_from_iter(args.iter().map(|a| a.as_ref())), map_summary)?;
            let mut results = Vec::new();
            for item in rows {
                let mut summary = item?;
                if summary.preview.starts_with("enc1:") || summary.secret {
                    if let Some(k) = key.as_ref() {
                        if let Ok(dec) = crate::crypto::decrypt(k, &summary.preview) {
                            summary.preview = dec.chars().take(900).collect();
                            summary.length = dec.chars().count() as i64;
                        } else {
                            summary.preview = String::new();
                        }
                    } else {
                        summary.preview = String::new();
                    }
                }
                results.push(summary);
            }
            Ok(results)
        }
    }

    pub fn list_days(&self, filter: &ListFilter) -> rusqlite::Result<Vec<DayCount>> {
        let mut conds = Vec::new();
        let mut args: Vec<Box<dyn ToSql>> = Vec::new();
        view_conditions(filter, &mut conds, &mut args);
        let sql = format!(
            "SELECT strftime('%Y-%m-%d', s.modified_at / 1000, 'unixepoch', 'localtime') AS d, count(*) \
             FROM sheets s WHERE {} GROUP BY d ORDER BY d DESC",
            conds.join(" AND ")
        );
        let conn = self.lock();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args.iter().map(|a| a.as_ref())), |r| {
            Ok(DayCount { day: r.get(0)?, count: r.get(1)? })
        })?;
        rows.collect()
    }

    pub fn get_sheet(&self, id: i64) -> rusqlite::Result<Option<SheetDetail>> {
        let conn = self.lock();
        let sql = format!("SELECT {SUMMARY_COLS}, s.content, s.content_hash FROM sheets s WHERE s.id = ?1");
        let found = conn
            .query_row(&sql, [id], |r| {
                Ok((map_summary(r)?, r.get::<_, String>(17)?, r.get::<_, String>(18)?))
            })
            .optional()?;
        let Some((mut summary, mut content, hash)) = found else {
            return Ok(None);
        };
        let mut stmt = conn.prepare(
            "SELECT id, saved_at, content FROM versions WHERE sheet_id = ?1 \
             ORDER BY saved_at DESC, id DESC",
        )?;
        let mut versions = stmt
            .query_map([id], |r| {
                Ok(Version { id: r.get(0)?, saved_at: r.get(1)?, content: r.get(2)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        if summary.secret || crate::crypto::is_encrypted(&content) {
            let key = match self.vault.current_key().map_err(|e| {
                rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
            })? {
                Some(k) => k,
                None => {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "Falta la clave de cifrado para leer las hojas secretas.",
                    ))));
                }
            };
            if crate::crypto::is_encrypted(&content) {
                content = crate::crypto::decrypt(&key, &content).map_err(|e| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                })?;
            }
            summary.preview = content.chars().take(900).collect();
            summary.length = content.chars().count() as i64;

            for v in &mut versions {
                if crate::crypto::is_encrypted(&v.content) {
                    v.content = crate::crypto::decrypt(&key, &v.content).map_err(|e| {
                        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                    })?;
                }
            }
        }
        Ok(Some(SheetDetail { summary, content, hash, versions }))
    }

    pub fn origin(&self, id: i64) -> rusqlite::Result<Option<Origin>> {
        self.lock()
            .query_row(
                "SELECT source, source_key, path, created_at, missing, hidden FROM sheets WHERE id = ?1",
                [id],
                |r| {
                    Ok(Origin {
                        source: r.get(0)?,
                        key: r.get(1)?,
                        path: r.get(2)?,
                        created_at: r.get(3)?,
                        missing: r.get(4)?,
                        hidden: r.get(5)?,
                    })
                },
            )
            .optional()
    }

    /// El archivo de una hoja cambió de nombre desde Book: sigue siendo la misma hoja.
    pub fn move_file(&self, id: i64, path: &str, title: &str) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE sheets SET source_key = ?1, path = ?1, title = ?2 WHERE id = ?3 AND source = 'file'",
            params![path, title, id],
        )?;
        Self::reindex(&conn, id)
    }

    /// Guarda el contenido actual de una hoja como versión anterior, sin esperar al
    /// cambio de sesión. Se usa antes de pisar algo que no se quiere perder.
    pub fn snapshot(&self, id: i64, keep: i64) -> rusqlite::Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO versions (sheet_id, content, content_hash, saved_at) \
             SELECT id, content, content_hash, modified_at FROM sheets WHERE id = ?1",
            [id],
        )?;
        tx.execute(
            "DELETE FROM versions WHERE sheet_id = ?1 AND id NOT IN (\
             SELECT id FROM versions WHERE sheet_id = ?1 \
             ORDER BY saved_at DESC, id DESC LIMIT ?2)",
            params![id, keep.max(1)],
        )?;
        tx.commit()
    }

    /// Archivos ya indexados: ruta -> (mtime, tamaño, id). Evita releer lo que no cambió.
    pub fn file_index(&self) -> rusqlite::Result<HashMap<String, (i64, i64, i64, bool)>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT source_key, source_mtime, size, id, missing FROM sheets WHERE source = 'file'",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        })?;
        rows.collect()
    }

    /// Archivos indexados (con su original en su lugar) que cuelgan de una carpeta.
    /// `prefix` es la ruta de la carpeta terminada en el separador.
    pub fn file_keys_under(&self, prefix: &str) -> rusqlite::Result<Vec<String>> {
        // Todo lo que empieza con `prefix` queda entre `prefix` y el texto que le sigue en
        // orden: así la búsqueda usa el índice en lugar de mirar todas las hojas.
        let mut end: Vec<char> = prefix.chars().collect();
        let Some(next) = end.pop().and_then(|last| char::from_u32(last as u32 + 1)) else {
            return Ok(Vec::new());
        };
        end.push(next);
        let end: String = end.into_iter().collect();
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT source_key FROM sheets \
             WHERE source = 'file' AND source_key >= ?1 AND source_key < ?2 AND missing = 0",
        )?;
        let rows = stmt.query_map(params![prefix, end], |r| r.get(0))?;
        rows.collect()
    }

    /// Archivos indexados (con su original en su lugar) cuyo contenido tiene esa huella.
    /// Alcanza con unos pocos: es para reconocer un archivo movido, no para listar copias.
    pub fn files_with_hash(&self, hash: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT source_key FROM sheets \
             WHERE content_hash = ?1 AND source = 'file' AND missing = 0 \
             ORDER BY modified_at DESC LIMIT 16",
        )?;
        let rows = stmt.query_map([hash], |r| r.get(0))?;
        rows.collect()
    }

    /// La hoja indexada con esta misma ruta escrita con otras mayúsculas, si la hay: donde
    /// el sistema no las distingue, es el mismo archivo.
    pub fn file_twin(&self, key: &str) -> Option<(i64, String)> {
        if !CASE_BLIND {
            return None;
        }
        // LIKE solo ignora las mayúsculas de las letras sin acento: el resto se busca con
        // comodín y la coincidencia se confirma acá, letra por letra.
        let pattern: String = key
            .chars()
            .map(|c| if c.is_ascii() { escape_like(c.encode_utf8(&mut [0; 4])) } else { "_".to_string() })
            .collect();
        let folded = key.to_lowercase();
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, source_key FROM sheets \
                 WHERE source = 'file' AND source_key LIKE ?1 ESCAPE '\\' AND source_key <> ?2",
            )
            .ok()?;
        let rows = stmt.query_map(params![pattern, key], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).ok()?;
        let twin = rows.flatten().find(|(_, other)| other.to_lowercase() == folded);
        twin
    }

    /// La hoja que tiene esa ruta como original, si la hay. Cuenta también la que quedó
    /// "sin original": su lugar no se puede usar para otra hoja sin pisarla.
    pub fn file_key_owner(&self, key: &str) -> Option<i64> {
        self.sheet_id("file", key).or_else(|| self.file_twin(key).map(|(id, _)| id))
    }

    pub fn keys_for_source(&self, source: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.lock();
        let mut stmt =
            conn.prepare("SELECT source_key FROM sheets WHERE source = ?1 AND missing = 0")?;
        let rows = stmt.query_map([source], |r| r.get(0))?;
        rows.collect()
    }

    /// El original ya no está: la hoja se conserva con su último contenido y se anota
    /// cuándo se detectó la desaparición.
    pub fn mark_missing(&self, source: &str, key: &str) -> bool {
        self.lock()
            .execute(
                "UPDATE sheets SET missing = 1, missing_at = ?3 \
                 WHERE source = ?1 AND source_key = ?2 AND missing = 0",
                params![source, key, now_ms()],
            )
            .map(|n| n > 0)
            .unwrap_or(false)
    }

    /// Hojas cuyo original desapareció, de la más reciente a la más antigua. Las del
    /// secret-book y las de la papelera no se listan: esto se muestra en los ajustes, a la
    /// vista de cualquiera, y el título de una pestaña o de una nota adhesiva es su
    /// primera línea (que bien puede ser justo la contraseña).
    pub fn list_missing(&self) -> rusqlite::Result<Vec<MissingSheet>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, title, source, path, modified_at, missing_at FROM sheets \
             WHERE missing = 1 AND secret = 0 AND hidden = 0 \
             ORDER BY coalesce(missing_at, modified_at) DESC LIMIT 500",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(MissingSheet {
                id: r.get(0)?,
                title: r.get(1)?,
                source: r.get(2)?,
                path: r.get(3)?,
                modified_at: r.get(4)?,
                missing_at: r.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn sheet_id(&self, source: &str, key: &str) -> Option<i64> {
        self.lock()
            .query_row(
                "SELECT id FROM sheets WHERE source = ?1 AND source_key = ?2",
                params![source, key],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// Saca del Book la hoja de un archivo que ya no corresponde indexar, con sus
    /// versiones. Solo si sigue siendo la de esa ruta: mientras se decidía pudo cambiar de
    /// nombre desde Book, y entonces ya es otra cosa. Devuelve si la sacó.
    pub fn delete_file_sheet(&self, id: i64, key: &str) -> rusqlite::Result<bool> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let deleted = tx.execute(
            "DELETE FROM sheets WHERE id = ?1 AND source = 'file' AND source_key = ?2",
            params![id, key],
        )? > 0;
        if deleted {
            tx.execute("DELETE FROM sheets_fts WHERE rowid = ?1", [id])?;
        }
        tx.commit()?;
        Ok(deleted)
    }

    pub fn sheet_category(&self, id: i64) -> rusqlite::Result<Option<i64>> {
        self.lock()
            .query_row("SELECT category_id FROM sheets WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .map(|opt| opt.flatten())
    }

    pub fn set_sheet_category(&self, id: i64, category_id: Option<i64>) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE sheets SET category_id = ?1, category_source = 'manual', \
             category_confidence = NULL WHERE id = ?2",
            params![category_id, id],
        )?;
        Ok(())
    }

    pub fn set_sheet_secret(&self, id: i64, secret: bool) -> rusqlite::Result<()> {
        let source = if secret { "manual" } else { "cleared" };
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let (current_content, title): (String, String) = tx.query_row(
            "SELECT content, title FROM sheets WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        if secret {
            let key = self.vault.get_or_create_key().map_err(|e| {
                rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
            })?;
            let enc_content = crate::crypto::encrypt_if_plain(&key, &current_content).map_err(|e| {
                rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
            })?;
            tx.execute(
                "UPDATE sheets SET secret = 1, secret_source = ?1, content = ?2 WHERE id = ?3",
                params![source, enc_content, id],
            )?;
            let mut v_stmt = tx.prepare("SELECT id, content FROM versions WHERE sheet_id = ?1")?;
            let v_rows: Vec<(i64, String)> = v_stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut v_upd = tx.prepare("UPDATE versions SET content = ?1 WHERE id = ?2")?;
            for (vid, v_content) in v_rows {
                let v_enc = crate::crypto::encrypt_if_plain(&key, &v_content).map_err(|e| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                })?;
                v_upd.execute(params![v_enc, vid])?;
            }
            refresh_fts(&tx, id, &title, &current_content, false)?;
        } else {
            let key = match self.vault.current_key().map_err(|e| {
                rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
            })? {
                Some(k) => k,
                None => {
                    return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "Falta la clave de cifrado para sacar esta hoja del cuaderno secreto.",
                    ))));
                }
            };
            let plain_content = if crate::crypto::is_encrypted(&current_content) {
                crate::crypto::decrypt(&key, &current_content).map_err(|e| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                })?
            } else {
                current_content
            };
            tx.execute(
                "UPDATE sheets SET secret = 0, secret_source = ?1, content = ?2 WHERE id = ?3",
                params![source, plain_content, id],
            )?;
            let mut v_stmt = tx.prepare("SELECT id, content FROM versions WHERE sheet_id = ?1")?;
            let v_rows: Vec<(i64, String)> = v_stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut v_upd = tx.prepare("UPDATE versions SET content = ?1 WHERE id = ?2")?;
            for (vid, v_content) in v_rows {
                let v_plain = if crate::crypto::is_encrypted(&v_content) {
                    crate::crypto::decrypt(&key, &v_content).map_err(|e| {
                        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))
                    })?
                } else {
                    v_content
                };
                v_upd.execute(params![v_plain, vid])?;
            }
            refresh_fts(&tx, id, &title, &plain_content, true)?;
        }
        tx.commit()
    }

    pub fn set_sheet_hidden(&self, id: i64, hidden: bool) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute("UPDATE sheets SET hidden = ?1 WHERE id = ?2", params![hidden, id])?;
        Self::reindex(&conn, id)
    }

    fn reindex(conn: &Connection, id: i64) -> rusqlite::Result<()> {
        let row: Option<(String, String, bool, bool)> = conn
            .query_row(
                "SELECT title, content, secret, hidden FROM sheets WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if let Some((title, content, secret, hidden)) = row {
            refresh_fts(conn, id, &title, &content, !secret && !hidden)?;
        }
        Ok(())
    }

    // ---- resumen -------------------------------------------------------

    pub fn counts(&self) -> rusqlite::Result<Counts> {
        self.lock().query_row(
            "SELECT \
               sum(secret = 0 AND hidden = 0), \
               sum(secret = 0 AND hidden = 0 AND category_id IS NULL), \
               sum(secret = 1 AND hidden = 0), \
               sum(hidden = 1) \
             FROM sheets",
            [],
            |r| {
                Ok(Counts {
                    all: r.get::<_, Option<i64>>(0)?.unwrap_or(0),
                    uncategorized: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    secret: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    hidden: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                })
            },
        )
    }

    pub fn categories(&self) -> rusqlite::Result<Vec<Category>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.name, c.description, c.color, \
               (SELECT count(*) FROM sheets s \
                WHERE s.category_id = c.id AND s.secret = 0 AND s.hidden = 0) \
             FROM categories c ORDER BY c.position, c.name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Category {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                color: r.get(3)?,
                count: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// Título y comienzo del contenido (hasta `chars` caracteres) de las hojas visibles,
    /// para proponer categorías: nunca las del secret-book ni las de la papelera.
    pub fn suggestion_corpus(&self, chars: usize) -> rusqlite::Result<Vec<(String, String)>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT title, substr(content, 1, ?1) FROM sheets \
             WHERE secret = 0 AND hidden = 0 ORDER BY id",
        )?;
        let rows = stmt.query_map([chars as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// Con una categoría nueva, las hojas que el clasificador había dejado sin categoría vuelven a
    /// quedar pendientes: quizás ahora tienen dónde ir.
    pub fn create_category(&self, name: &str, description: &str, color: &str) -> rusqlite::Result<i64> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO categories (name, description, color, position) \
             VALUES (?1, ?2, ?3, (SELECT coalesce(max(position), 0) + 1 FROM categories))",
            params![name, description, color],
        )?;
        let id = tx.last_insert_rowid();
        Self::reopen_uncategorized(&tx)?;
        tx.commit()?;
        Ok(id)
    }

    /// Devuelve `true` si cambió lo que el clasificador lee de la categoría (el nombre o la
    /// descripción): en ese caso las hojas sin categoría vuelven a quedar pendientes.
    /// Cambiar solo el color no dispara nada.
    pub fn update_category(&self, id: i64, name: &str, description: &str, color: &str) -> rusqlite::Result<bool> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let before: Option<(String, String)> = tx
            .query_row("SELECT name, description FROM categories WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        tx.execute(
            "UPDATE categories SET name = ?1, description = ?2, color = ?3 WHERE id = ?4",
            params![name, description, color, id],
        )?;
        let redefined =
            before.is_some_and(|(old_name, old_description)| old_name != name || old_description != description);
        if redefined {
            Self::reopen_uncategorized(&tx)?;
        }
        tx.commit()?;
        Ok(redefined)
    }

    /// Las hojas que el clasificador evaluó y dejó sin categoría (eligió "otro" o no llegó a la
    /// confianza mínima) merecen otra consulta. Las que ya tienen categoría no se tocan.
    fn reopen_uncategorized(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute(
            "UPDATE sheets SET classified_hash = NULL \
             WHERE category_source IS NULL AND category_id IS NULL AND classified_hash IS NOT NULL",
            [],
        )?;
        Ok(())
    }

    /// Las hojas de la categoría quedan sin categoría y vuelven a pasar por el clasificador.
    pub fn delete_category(&self, id: i64) -> rusqlite::Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE sheets SET category_id = NULL, category_source = NULL, \
             category_confidence = NULL, classified_hash = NULL, jev_choice = NULL, \
             jev_confidence = NULL WHERE category_id = ?1",
            [id],
        )?;
        // Las que la IA había mandado ahí sin llegar a la confianza mínima pierden esa
        // elección, que ya no existe.
        tx.execute(
            "UPDATE sheets SET jev_choice = NULL, jev_confidence = NULL WHERE jev_choice = ?1",
            [id],
        )?;
        tx.execute("DELETE FROM categories WHERE id = ?1", [id])?;
        tx.commit()
    }

    /// Asegura la categoría dedicada para recortes ("Recortes" o "Clippings").
    /// Si existe una guardada en los ajustes (`clippings_category_id`), se respeta aunque
    /// haya sido renombrada o cambiado de color. Si no, busca una existente llamada
    /// "Recortes" o "Clippings". Si no existe ninguna, la crea automáticamente.
    pub fn ensure_clippings_category(&self) -> rusqlite::Result<i64> {
        let conn = self.lock();
        // 1. Si hay un ID guardado en ajustes, verificar si existe en la base.
        if let Some(id_str) = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'clippings_category_id'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            if let Ok(id) = id_str.parse::<i64>() {
                let exists: bool = conn
                    .query_row("SELECT 1 FROM categories WHERE id = ?1", [id], |_| Ok(true))
                    .optional()?
                    .unwrap_or(false);
                if exists {
                    return Ok(id);
                }
            }
        }

        // 2. Si no hay ID o fue eliminada, buscar por nombre ('Recortes' o 'Clippings').
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM categories WHERE lower(name) IN ('recortes', 'clippings') ORDER BY id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;

        if let Some(id) = existing {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('clippings_category_id', ?1) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [id.to_string()],
            )?;
            return Ok(id);
        }

        // 3. Si no existe, crear la categoría según el idioma del usuario.
        drop(conn);
        let is_en = self.get_setting("locale").as_deref() == Some("en");
        let (name, desc, color) = if is_en {
            ("Clippings", "Clippings and quick captures from other apps", "#FF9500")
        } else {
            ("Recortes", "Recortes y capturas rápidas desde otras aplicaciones", "#FF9500")
        };
        match self.create_category(name, desc, color) {
            Ok(id) => {
                let _ = self.set_setting("clippings_category_id", &id.to_string());
                Ok(id)
            }
            Err(_) => {
                let conn = self.lock();
                if let Some(id) = conn
                    .query_row(
                        "SELECT id FROM categories WHERE lower(name) IN ('recortes', 'clippings') ORDER BY id LIMIT 1",
                        [],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()?
                {
                    conn.execute(
                        "INSERT INTO settings (key, value) VALUES ('clippings_category_id', ?1) \
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        [id.to_string()],
                    )?;
                    Ok(id)
                } else {
                    drop(conn);
                    let alt = format!("{name} 1");
                    let id = self.create_category(&alt, desc, color)?;
                    let _ = self.set_setting("clippings_category_id", &id.to_string());
                    Ok(id)
                }
            }
        }
    }

    pub fn clippings_category_id(&self) -> Option<i64> {
        self.ensure_clippings_category().ok()
    }

    pub fn is_reliable_clipping(
        title: &str,
        path: Option<&str>,
        content: &str,
        source: &str,
        notes_dir: Option<&Path>,
    ) -> bool {
        if source == "capture" {
            return true;
        }

        let file_name = path
            .and_then(|p| Path::new(p).file_name().and_then(|n| n.to_str()))
            .unwrap_or(title)
            .to_lowercase();

        let stem = path
            .and_then(|p| Path::new(p).file_stem().and_then(|s| s.to_str()))
            .unwrap_or(title)
            .to_lowercase();

        let is_clipping_stem = stem == "recortes"
            || stem == "clippings"
            || stem.starts_with("recortes-")
            || stem.starts_with("recortes ")
            || stem.starts_with("recorte-")
            || stem.starts_with("clippings-")
            || stem.starts_with("clipping-");

        let is_clipping_name = file_name.starts_with("recortes.")
            || file_name.starts_with("clippings.")
            || is_clipping_stem;

        if !is_clipping_name {
            return false;
        }

        if let (Some(p), Some(nd)) = (path, notes_dir) {
            if Path::new(p).starts_with(nd) {
                return true;
            }
        }

        content.lines().any(|l| {
            let t = l.trim_start();
            t.starts_with("— ")
                || (t.starts_with("- ")
                    && t.chars().skip(2).take(2).all(|c| c.is_ascii_digit()))
        })
    }

    pub fn untagged_clippings(&self, notes_dir: Option<&Path>) -> rusqlite::Result<Vec<i64>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, title, path, content, source FROM sheets \
             WHERE category_id IS NULL AND secret = 0 AND hidden = 0",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;

        let mut matches = Vec::new();
        for row in rows {
            let (id, title, path_str, content, source) = row?;
            if Self::is_reliable_clipping(&title, path_str.as_deref(), &content, &source, notes_dir) {
                matches.push(id);
            }
        }
        Ok(matches)
    }

    pub fn migrate_clippings(&self, notes_dir: Option<&Path>) -> rusqlite::Result<usize> {
        let ids = self.untagged_clippings(notes_dir)?;
        if ids.is_empty() {
            return Ok(0);
        }
        let category_id = self.ensure_clippings_category()?;
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        for id in &ids {
            tx.execute(
                "UPDATE sheets SET category_id = ?1, category_source = 'manual', \
                 category_confidence = NULL WHERE id = ?2 AND category_id IS NULL",
                params![category_id, id],
            )?;
        }
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('clippings_migrated', '1') \
             ON CONFLICT(key) DO UPDATE SET value = '1'",
            [],
        )?;
        tx.commit()?;
        Ok(ids.len())
    }

    // ---- carpetas y exclusiones -----------------------------------------

    pub fn roots(&self) -> rusqlite::Result<Vec<Root>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT id, path FROM roots ORDER BY path")?;
        let rows = stmt.query_map([], |r| Ok(Root { id: r.get(0)?, path: r.get(1)? }))?;
        rows.collect()
    }

    pub fn add_root(&self, path: &str) -> rusqlite::Result<()> {
        self.lock().execute("INSERT OR IGNORE INTO roots (path) VALUES (?1)", [path])?;
        Ok(())
    }

    pub fn remove_root(&self, id: i64) -> rusqlite::Result<()> {
        self.lock().execute("DELETE FROM roots WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn bans(&self) -> rusqlite::Result<Vec<Ban>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, kind, pattern, enabled, builtin FROM bans ORDER BY kind, builtin DESC, pattern",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Ban {
                id: r.get(0)?,
                kind: r.get(1)?,
                pattern: r.get(2)?,
                enabled: r.get(3)?,
                builtin: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn add_ban(&self, kind: &str, pattern: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO bans (kind, pattern) VALUES (?1, ?2) \
             ON CONFLICT(kind, pattern) DO UPDATE SET enabled = 1",
            params![kind, pattern],
        )?;
        Ok(())
    }

    pub fn set_ban_enabled(&self, id: i64, enabled: bool) -> rusqlite::Result<()> {
        self.lock()
            .execute("UPDATE bans SET enabled = ?1 WHERE id = ?2", params![enabled, id])?;
        Ok(())
    }

    pub fn remove_ban(&self, id: i64) -> rusqlite::Result<()> {
        self.lock().execute("DELETE FROM bans WHERE id = ?1 AND builtin = 0", [id])?;
        Ok(())
    }

    /// Carpetas donde hay hojas indexadas, para decidir cuáles conservar y cuáles excluir.
    pub fn folder_stats(&self) -> rusqlite::Result<Vec<FolderStat>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT source_key FROM sheets WHERE source = 'file' AND missing = 0 AND hidden = 0",
        )?;
        let mut counts: HashMap<String, i64> = HashMap::new();
        for path in stmt.query_map([], |r| r.get::<_, String>(0))? {
            let path = path?;
            if let Some(parent) = Path::new(&path).parent() {
                *counts.entry(parent.to_string_lossy().to_string()).or_default() += 1;
            }
        }
        let mut stats: Vec<FolderStat> = counts
            .into_iter()
            .map(|(folder, count)| FolderStat { folder, count })
            .collect();
        stats.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.folder.cmp(&b.folder)));
        stats.truncate(300);
        Ok(stats)
    }

    // ---- clasificación --------------------------------------------------
    //
    // Una hoja se le consulta al clasificador una sola vez. `classified_hash` es la huella del
    // contenido que evaluó: vacío quiere decir "falta evaluarla". Que el contenido cambie
    // después no la vuelve pendiente, salvo que esté activa la revisión periódica.

    pub fn category_defs(&self) -> rusqlite::Result<Vec<CategoryDef>> {
        let conn = self.lock();
        let mut stmt =
            conn.prepare("SELECT id, name, description FROM categories ORDER BY position, name")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect()
    }

    /// Hojas que toca consultar en `now` (id y huella), de la más reciente a la más
    /// antigua: les falta la evaluación (o les toca la revisión periódica), tienen texto
    /// suficiente y llevan `calm_ms` sin cambiar.
    pub fn jev_due(&self, now: i64, policy: &JevPolicy) -> rusqlite::Result<Vec<(i64, String)>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT id, content_hash FROM sheets WHERE {JEV_ELIGIBLE} \
               AND (classified_hash IS NULL OR (?3 > 0 AND classified_hash <> content_hash \
                    AND coalesce(classified_at, 0) + ?3 <= ?1)) \
               AND min(modified_at, last_change_at) + ?2 <= ?1 \
               AND {JEV_ENOUGH_TEXT} \
             ORDER BY modified_at DESC, id DESC"
        ))?;
        let rows = stmt.query_map(params![now, policy.calm_ms, policy.recheck_ms], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
        rows.collect()
    }

    /// La hoja lista para enviar, o `None` si dejó de corresponder desde que se la
    /// eligió: pasó al secret-book o a la papelera, se le puso categoría a mano, alguien
    /// la está editando...
    pub fn jev_sheet(&self, id: i64, now: i64, policy: &JevPolicy) -> rusqlite::Result<Option<PendingSheet>> {
        self.lock()
            .query_row(
                &format!(
                    "SELECT id, title, content, content_hash FROM sheets WHERE id = ?4 AND {JEV_ELIGIBLE} \
                       AND (classified_hash IS NULL OR (?3 > 0 AND classified_hash <> content_hash \
                            AND coalesce(classified_at, 0) + ?3 <= ?1)) \
                       AND min(modified_at, last_change_at) + ?2 <= ?1 \
                       AND {JEV_ENOUGH_TEXT}"
                ),
                params![now, policy.calm_ms, policy.recheck_ms, id],
                |r| Ok(PendingSheet { id: r.get(0)?, title: r.get(1)?, content: r.get(2)?, hash: r.get(3)? }),
            )
            .optional()
    }

    /// Cuándo queda lista la próxima hoja que hoy está esperando (la calma o el plazo de
    /// revisión); `None` si no hay ninguna esperando.
    pub fn jev_next(&self, now: i64, policy: &JevPolicy) -> Option<i64> {
        self.lock()
            .query_row(
                &format!(
                    "SELECT min(ready_at) FROM (\
                       SELECT max(min(modified_at, last_change_at) + ?2, \
                                  CASE WHEN classified_hash IS NULL THEN 0 \
                                       ELSE coalesce(classified_at, 0) + ?3 END) AS ready_at \
                       FROM sheets WHERE {JEV_ELIGIBLE} \
                         AND (classified_hash IS NULL OR (?3 > 0 AND classified_hash <> content_hash)) \
                         AND {JEV_ENOUGH_TEXT}) \
                     WHERE ready_at > ?1"
                ),
                params![now, policy.calm_ms, policy.recheck_ms],
                |r| r.get(0),
            )
            .unwrap_or(None)
    }

    /// Cuántas hojas faltan clasificar: las listas y las que esperan a quedar quietas.
    pub fn pending_count(&self, now: i64, policy: &JevPolicy) -> i64 {
        self.lock()
            .query_row(
                &format!(
                    "SELECT count(*) FROM sheets WHERE {JEV_ELIGIBLE} \
                       AND (classified_hash IS NULL OR (?2 > 0 AND classified_hash <> content_hash \
                            AND coalesce(classified_at, 0) + ?2 <= ?1)) \
                       AND {JEV_ENOUGH_TEXT}"
                ),
                params![now, policy.recheck_ms],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    /// Un veredicto ya guardado para ese mismo contenido y esas mismas categorías
    /// (`categories` es la firma de la lista): evita repetir la consulta.
    pub fn cached_verdict(&self, hash: &str, categories: &str) -> Option<Verdict> {
        self.lock()
            .query_row(
                "SELECT choice, confidence, note_score FROM jev_cache \
                 WHERE content_hash = ?1 AND categories = ?2",
                params![hash, categories],
                |r| Ok(Verdict { category_id: r.get(0)?, confidence: r.get(1)?, note_score: r.get(2)? }),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// Anota lo que respondió la IA para una hoja. Se guarda su elección tal cual y la
    /// categoría se aplica solo si llega a `threshold`; una hoja con categoría puesta a
    /// mano no se toca. Con `remember` (la firma de las categorías), el veredicto queda
    /// además guardado para reutilizarlo.
    pub fn apply_verdict(
        &self,
        id: i64,
        hash: &str,
        verdict: &Verdict,
        threshold: f64,
        now: i64,
        remember: Option<&str>,
    ) -> rusqlite::Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        // La categoría elegida pudo haberse borrado mientras la IA respondía.
        tx.execute(
            "UPDATE sheets SET \
               jev_choice = (SELECT id FROM categories WHERE id = ?1), jev_confidence = ?2, \
               category_id = CASE WHEN ?2 >= ?3 THEN (SELECT id FROM categories WHERE id = ?1) END, \
               category_source = CASE WHEN ?2 >= ?3 AND ?1 IN (SELECT id FROM categories) THEN 'jev' END, \
               category_confidence = ?2, note_score = ?4, classified_hash = ?5, classified_at = ?6 \
             WHERE id = ?7 AND content_hash = ?5 AND (category_source IS NULL OR category_source = 'jev')",
            params![verdict.category_id, verdict.confidence, threshold, verdict.note_score, hash, now, id],
        )?;
        if let Some(categories) = remember {
            tx.execute(
                "INSERT OR REPLACE INTO jev_cache \
                 (content_hash, categories, choice, confidence, note_score, saved_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![hash, categories, verdict.category_id, verdict.confidence, verdict.note_score, now],
            )?;
            tx.execute(
                "DELETE FROM jev_cache WHERE rowid NOT IN (\
                 SELECT rowid FROM jev_cache ORDER BY saved_at DESC, rowid DESC LIMIT ?1)",
                [JEV_CACHE_ROWS],
            )?;
        }
        tx.commit()
    }

    /// El clasificador no pudo evaluar esta hoja y no tiene sentido insistir: queda como vista, con
    /// la categoría que ya tuviera.
    pub fn mark_jev_seen(&self, id: i64, hash: &str, now: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE sheets SET classified_hash = ?1, classified_at = ?2 \
             WHERE id = ?3 AND (category_source IS NULL OR category_source = 'jev')",
            params![hash, now, id],
        )?;
        Ok(())
    }

    /// Cambió la confianza mínima: se vuelve a decidir, con lo que la IA ya había elegido,
    /// qué hojas llevan su categoría. No hace falta ninguna consulta.
    pub fn apply_threshold(&self, threshold: f64) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE sheets SET \
               category_id = CASE WHEN jev_confidence >= ?1 THEN (SELECT id FROM categories WHERE id = jev_choice) END, \
               category_source = CASE WHEN jev_confidence >= ?1 AND jev_choice IN (SELECT id FROM categories) THEN 'jev' END \
             WHERE (category_source IS NULL OR category_source = 'jev') AND jev_choice IS NOT NULL",
            [threshold],
        )?;
        Ok(())
    }

    /// "Volver a clasificar todo": cada hoja sin categoría puesta a mano se consulta de
    /// nuevo, sin reutilizar veredictos guardados. Mientras tanto conservan la categoría
    /// que tenían.
    pub fn reclassify_all(&self) -> rusqlite::Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM jev_cache", [])?;
        tx.execute(
            "UPDATE sheets SET classified_hash = NULL \
             WHERE category_source IS NULL OR category_source = 'jev'",
            [],
        )?;
        tx.commit()
    }

    /// Anota una consulta hecha al clasificador: suma al total y al contador del día (hora local),
    /// que empieza de cero cuando cambia la fecha.
    pub fn count_jev_call(&self, now: i64) -> rusqlite::Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let day = local_day(&tx, now)?;
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('jev_calls_total', 1) \
             ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
            [],
        )?;
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('jev_calls_today', 1) \
             ON CONFLICT(key) DO UPDATE SET value = CASE \
               WHEN (SELECT value FROM settings WHERE key = 'jev_calls_day') = ?1 \
               THEN CAST(value AS INTEGER) + 1 ELSE 1 END",
            [&day],
        )?;
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('jev_calls_day', ?1) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [&day],
        )?;
        tx.commit()
    }

    /// Consultas hechas al clasificador: (hoy, desde siempre).
    pub fn jev_calls(&self, now: i64) -> (i64, i64) {
        let conn = self.lock();
        let number = |key: &str| -> i64 {
            conn.query_row("SELECT CAST(value AS INTEGER) FROM settings WHERE key = ?1", [key], |r| r.get(0))
                .unwrap_or(0)
        };
        let counted_day: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = 'jev_calls_day'", [], |r| r.get(0))
            .ok();
        let same_day = counted_day.is_some() && counted_day == local_day(&conn, now).ok();
        (if same_day { number("jev_calls_today") } else { 0 }, number("jev_calls_total"))
    }
}

/// La fecha local (AAAA-MM-DD) de un instante en milisegundos.
fn local_day(conn: &Connection, now: i64) -> rusqlite::Result<String> {
    conn.query_row("SELECT strftime('%Y-%m-%d', ?1 / 1000, 'unixepoch', 'localtime')", [now], |r| r.get(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open(Path::new(":memory:")).expect("base en memoria")
    }

    fn session() -> VersionCfg {
        VersionCfg { keep: 2, session_gap_ms: 5 * 60_000 }
    }

    fn incoming(source: &'static str, key: &str, content: &str) -> Incoming {
        Incoming {
            source,
            source_key: key.into(),
            title: key.rsplit('/').next().unwrap_or(key).into(),
            path: (source == "file").then(|| key.into()),
            content: content.into(),
            size: content.len() as i64,
            source_mtime: 1,
            created_at: 1,
            modified_at: 1,
        }
    }

    fn everything(db: &Db) -> Vec<SheetSummary> {
        db.list_sheets(&ListFilter {
            view: "all".into(),
            category_id: None,
            query: None,
            before_ts: None,
            before_id: None,
            until: None,
            limit: Some(100),
        })
        .expect("listado")
    }

    #[test]
    fn un_archivo_movido_sigue_siendo_la_misma_hoja() {
        let db = db();
        db.upsert_sheet(&incoming("file", "/notas/a.txt", "comprar pan"), &session()).unwrap();
        let id = db.sheet_id("file", "/notas/a.txt").unwrap();
        db.set_sheet_category(id, Some(1)).unwrap();

        // El sistema avisa primero que el archivo viejo ya no está...
        assert!(db.mark_missing("file", "/notas/a.txt"));
        let missing = db.list_missing().unwrap();
        assert_eq!(missing.len(), 1);
        assert!(missing[0].missing_at.is_some());

        // ...y después que apareció uno nuevo con el mismo contenido.
        let outcome = db.upsert_sheet(&incoming("file", "/otra/b.txt", "comprar pan"), &session()).unwrap();
        assert_eq!(outcome, Outcome::Updated);
        let sheets = everything(&db);
        assert_eq!(sheets.len(), 1);
        assert_eq!(sheets[0].id, id);
        assert_eq!(sheets[0].path.as_deref(), Some("/otra/b.txt"));
        assert_eq!(sheets[0].category_id, Some(1));
        assert!(!sheets[0].missing);
        assert!(db.list_missing().unwrap().is_empty());
    }

    #[test]
    fn una_pestana_guardada_pasa_a_ser_el_archivo() {
        let db = db();
        db.upsert_sheet(&incoming("notepad", "guid-1", "ideas sueltas"), &session()).unwrap();
        let id = db.sheet_id("notepad", "guid-1").unwrap();

        db.upsert_sheet(&incoming("file", "/notas/ideas.txt", "ideas sueltas"), &session()).unwrap();
        let sheets = everything(&db);
        assert_eq!(sheets.len(), 1);
        assert_eq!(sheets[0].id, id);
        assert_eq!(sheets[0].source, "file");
        assert_eq!(sheets[0].title, "ideas.txt");
    }

    #[test]
    fn un_archivo_borrado_queda_en_el_cuaderno_con_su_ultimo_contenido() {
        let db = db();
        db.upsert_sheet(&incoming("file", "/notas/a.txt", "no perder esto"), &session()).unwrap();
        assert!(db.mark_missing("file", "/notas/a.txt"));
        let sheets = everything(&db);
        assert_eq!(sheets.len(), 1);
        assert!(sheets[0].missing);
        assert_eq!(db.get_sheet(sheets[0].id).unwrap().unwrap().content, "no perder esto");
    }

    #[test]
    fn las_secretas_y_las_de_la_papelera_no_se_listan_entre_los_originales_que_desaparecieron() {
        let db = db();
        // Una pestaña sin guardar cuya primera línea (que es su título) es una credencial:
        // se marca sola como secreta.
        let secret = format!("{}: {}", "clave", "PruebaSegura123!");
        let tab = Incoming { title: secret.clone(), ..incoming("notepad", "guid-1", &format!("{secret}\nla del banco")) };
        db.upsert_sheet(&tab, &session()).unwrap();
        db.upsert_sheet(&incoming("file", "/notas/tirada.txt", "algo que se tiró"), &session()).unwrap();
        db.upsert_sheet(&incoming("file", "/notas/comun.txt", "una nota cualquiera"), &session()).unwrap();
        db.set_sheet_hidden(db.sheet_id("file", "/notas/tirada.txt").unwrap(), true).unwrap();

        // Se cierra la pestaña y se borran los archivos.
        assert!(db.mark_missing("notepad", "guid-1"));
        assert!(db.mark_missing("file", "/notas/tirada.txt"));
        assert!(db.mark_missing("file", "/notas/comun.txt"));

        // En los ajustes solo aparece la que está a la vista en el cuaderno.
        let listed: Vec<String> = db.list_missing().unwrap().into_iter().map(|sheet| sheet.title).collect();
        assert_eq!(listed, ["comun.txt"]);
        // Las otras dos siguen en el Book, cada una en su lugar.
        let counts = db.counts().unwrap();
        assert_eq!((counts.all, counts.secret, counts.hidden), (1, 1, 1));
    }

    #[test]
    fn un_archivo_nuevo_toma_la_huerfana_que_le_corresponde() {
        let db = db();
        // Tres archivos con el mismo texto; dos se llaman igual, en carpetas distintas.
        for key in ["/a/lista.txt", "/a/copia.txt", "/b/lista.txt"] {
            db.upsert_sheet(&incoming("file", key, "el mismo texto"), &session()).unwrap();
        }
        let id = |key: &str| db.sheet_id("file", key).unwrap();
        let (list, copy, other) = (id("/a/lista.txt"), id("/a/copia.txt"), id("/b/lista.txt"));
        // El de /b se borró hace tiempo; ahora se mueve la carpeta /a.
        db.lock()
            .execute("UPDATE sheets SET missing = 1, missing_at = 1000 WHERE id = ?1", [other])
            .unwrap();
        db.mark_missing("file", "/a/lista.txt");
        db.mark_missing("file", "/a/copia.txt");

        // Cada archivo sigue siendo su hoja: gana el nombre y, entre las que se llaman
        // igual, la que desapareció recién.
        db.upsert_sheet(&incoming("file", "/c/lista.txt", "el mismo texto"), &session()).unwrap();
        db.upsert_sheet(&incoming("file", "/c/copia.txt", "el mismo texto"), &session()).unwrap();
        assert_eq!((id("/c/lista.txt"), id("/c/copia.txt")), (list, copy));
        assert_eq!(db.sheet_id("file", "/b/lista.txt"), Some(other));

        // Una hoja escrita en Book no toma el lugar de ninguna, aunque diga lo mismo.
        db.upsert_written(&incoming("file", "/c/nueva.txt", "el mismo texto"), &session()).unwrap();
        assert!(![list, copy, other].contains(&id("/c/nueva.txt")));
        assert_eq!(db.list_missing().unwrap().len(), 1);
    }

    #[test]
    fn busca_los_archivos_indexados_por_carpeta_y_por_ruta_con_otras_mayusculas() {
        let db = db();
        for key in [r"C:\notas\Ñandú 100%_listo.txt", r"C:\notas\sub\b.txt", r"C:\notas viejas\c.txt", r"C:\notas\ido.txt"] {
            db.upsert_sheet(&incoming("file", key, key), &session()).unwrap();
        }
        db.mark_missing("file", r"C:\notas\ido.txt");

        // Lo que cuelga de la carpeta (no lo de otra que empieza igual) y sigue en su lugar.
        let mut under = db.file_keys_under(r"C:\notas\").unwrap();
        under.sort();
        assert_eq!(under, [r"C:\notas\sub\b.txt", r"C:\notas\Ñandú 100%_listo.txt"]);

        // La misma ruta escrita con otras mayúsculas es el mismo archivo donde el sistema
        // no las distingue; los comodines de LIKE en el nombre no confunden.
        let id = db.sheet_id("file", r"C:\notas\Ñandú 100%_listo.txt").unwrap();
        let twin = db.file_twin(r"c:\NOTAS\ñandú 100%_LISTO.txt");
        assert_eq!(twin.map(|(id, _)| id), CASE_BLIND.then_some(id));
        assert_eq!(db.file_twin(r"C:\notas\Ñandú 100%_listo.txt"), None);
        assert_eq!(db.file_twin(r"C:\notas\Ñandú 100%xlisto.txt"), None);
        assert_eq!(db.file_key_owner(r"C:\notas\Ñandú 100%_listo.txt"), Some(id));
        assert_eq!(db.file_key_owner(r"C:\notas\otra.txt"), None);
    }

    #[test]
    fn las_versiones_rotan_por_sesion_y_se_conservan_dos() {
        let db = db();
        // Cambios seguidos dentro de la misma sesión de edición: no generan versiones.
        for text in ["uno", "dos", "tres"] {
            db.upsert_sheet(&incoming("file", "/notas/a.txt", text), &session()).unwrap();
        }
        let id = db.sheet_id("file", "/notas/a.txt").unwrap();
        assert!(db.get_sheet(id).unwrap().unwrap().versions.is_empty());

        // Con cada cambio en una sesión distinta, la anterior pasa al historial (máximo 2).
        let every_change = VersionCfg { keep: 2, session_gap_ms: -1 };
        for text in ["cuatro", "cinco", "seis"] {
            db.upsert_sheet(&incoming("file", "/notas/a.txt", text), &every_change).unwrap();
        }
        let detail = db.get_sheet(id).unwrap().unwrap();
        assert_eq!(detail.content, "seis");
        let kept: Vec<&str> = detail.versions.iter().map(|v| v.content.as_str()).collect();
        assert_eq!(kept.len(), 2);
        assert!(kept.contains(&"cinco") && kept.contains(&"cuatro"));
    }

    #[test]
    fn lo_secreto_y_lo_descartado_no_aparece_en_la_busqueda() {
        let db = db();
        db.upsert_sheet(&incoming("file", "/notas/a.txt", "reunion con el banco"), &session()).unwrap();
        let cred_note = format!("reunion de equipo\n{}: {}", "clave", "PruebaSegura123!");
        db.upsert_sheet(&incoming("file", "/notas/b.txt", &cred_note), &session()).unwrap();
        let search = |db: &Db| {
            db.list_sheets(&ListFilter {
                view: "all".into(),
                category_id: None,
                query: Some("reunion".into()),
                before_ts: None,
                before_id: None,
                until: None,
                limit: None,
            })
            .unwrap()
        };
        // La hoja con contraseña se marcó sola como secreta y quedó fuera.
        assert_eq!(search(&db).len(), 1);
        let id = db.sheet_id("file", "/notas/a.txt").unwrap();
        db.set_sheet_hidden(id, true).unwrap();
        assert!(search(&db).is_empty());
    }

    #[test]
    fn buscar_solo_signos_no_devuelve_todo_el_cuaderno() {
        let db = db();
        db.upsert_sheet(&incoming("file", "/notas/a.txt", "¿y esto dónde iba??? revisar"), &session()).unwrap();
        db.upsert_sheet(&incoming("file", "/notas/b.txt", "una nota cualquiera, 100% lista"), &session()).unwrap();
        db.upsert_sheet(&incoming("file", "/notas/c.txt", "otra nota sin nada raro"), &session()).unwrap();
        let cred_signos = format!("{}: {} ???", "clave", "PruebaSegura123!");
        db.upsert_sheet(&incoming("file", "/notas/d.txt", &cred_signos), &session()).unwrap();
        let search = |query: &str| -> Vec<String> {
            let filter = ListFilter {
                view: "all".into(),
                category_id: None,
                query: Some(query.into()),
                before_ts: None,
                before_id: None,
                until: None,
                limit: None,
            };
            let mut titles: Vec<String> = db.list_sheets(&filter).unwrap().into_iter().map(|s| s.title).collect();
            titles.sort();
            titles
        };
        // Sin letras ni números no hay palabras que buscar en el índice: se busca el
        // texto tal cual, y la hoja secreta que también lo tiene sigue sin aparecer.
        assert_eq!(search("???"), ["a.txt"]);
        assert_eq!(search("%"), ["b.txt"]);
        assert!(search("->").is_empty());
        // Las búsquedas con palabras siguen yendo por el índice (prefijos, sin acentos).
        assert_eq!(search("donde"), ["a.txt"]);
        assert_eq!(search("not"), ["b.txt", "c.txt"]);
    }

    #[test]
    fn una_base_anterior_se_pone_al_dia_sin_perder_lo_clasificado() {
        // La tabla de hojas tal como la creaba la versión 0.6.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, \
               description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#8E8E93', \
               position INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE sheets (id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_key TEXT NOT NULL, \
               title TEXT NOT NULL, path TEXT, content TEXT NOT NULL, content_hash TEXT NOT NULL, \
               size INTEGER NOT NULL, source_mtime INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, \
               modified_at INTEGER NOT NULL, last_change_at INTEGER NOT NULL, \
               category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, category_source TEXT, \
               category_confidence REAL, note_score REAL, classified_hash TEXT, \
               secret INTEGER NOT NULL DEFAULT 0, secret_source TEXT, hidden INTEGER NOT NULL DEFAULT 0, \
               missing INTEGER NOT NULL DEFAULT 0, missing_at INTEGER, UNIQUE(source, source_key));
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO settings VALUES ('seeded', '1'), ('jev_threshold', '0.6');
             INSERT INTO categories (id, name) VALUES (1, 'Trabajo');",
        )
        .unwrap();
        let old_sheet = "INSERT INTO sheets (id, source, source_key, title, content, content_hash, size, \
             created_at, modified_at, last_change_at, category_id, category_source, category_confidence, \
             classified_hash) VALUES (?1, 'file', ?2, ?2, ?3, ?4, 1, 1, 1, 1, ?5, ?6, ?7, ?8)";
        let long = "una hoja con texto de sobra para clasificar";
        let rows: [(i64, &str, &str, Option<i64>, Option<&str>, Option<f64>, Option<&str>); 5] = [
            // Jev la puso en Trabajo.
            (1, "jev.txt", long, Some(1), Some("jev"), Some(0.9), Some("igual")),
            // Jev la evaluó y quedó sin categoría; después cambió el texto.
            (2, "otro.txt", long, None, None, Some(0.3), Some("viejo")),
            // Categoría puesta a mano.
            (3, "manual.txt", long, Some(1), Some("manual"), None, None),
            // Nunca pasó por Jev.
            (4, "nueva.txt", long, None, None, None, None),
            (5, "nueva-corta.txt", "pan", None, None, None, None),
        ];
        for (id, key, content, category, source, confidence, classified) in rows {
            conn.execute(old_sheet, params![id, key, content, "igual", category, source, confidence, classified])
                .unwrap();
        }

        let before = now_ms();
        let db = Db::setup(conn, crate::crypto::Vault::in_memory_with_key([7u8; 32])).unwrap();
        let policy = JevPolicy { calm_ms: 0, recheck_ms: 0, threshold: 0.6 };
        // Lo ya evaluado sigue evaluado: solo queda pendiente la que nunca pasó por Jev.
        let due = db.jev_due(now_ms(), &policy).unwrap();
        assert_eq!(due.iter().map(|(id, _)| *id).collect::<Vec<_>>(), [4]);
        assert_eq!(db.pending_count(now_ms(), &policy), 1);

        let raw = |id: i64| -> (Option<i64>, Option<f64>, Option<i64>) {
            db.lock()
                .query_row(
                    "SELECT jev_choice, jev_confidence, classified_at FROM sheets WHERE id = ?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap()
        };
        // La categoría que había puesto Jev pasa a ser su elección guardada...
        let (choice, confidence, at) = raw(1);
        assert_eq!((choice, confidence), (Some(1), Some(0.9)));
        assert!(at.is_some_and(|at| at >= before));
        assert_eq!(raw(2).0, None);
        assert!(raw(2).2.is_some());
        assert_eq!(raw(3), (None, None, None));
        assert_eq!(raw(4), (None, None, None));
        // ...y el umbral ya se puede mover sin consultar.
        db.apply_threshold(0.95).unwrap();
        assert_eq!(db.get_sheet(1).unwrap().unwrap().summary.category_id, None);
        db.apply_threshold(0.6).unwrap();
        assert_eq!(db.get_sheet(1).unwrap().unwrap().summary.category_id, Some(1));
        assert_eq!(db.get_sheet(3).unwrap().unwrap().summary.category_source.as_deref(), Some("manual"));

        // Abrirla otra vez no repite la migración.
        let conn = db.conn.into_inner().unwrap();
        let db = Db::setup(conn, crate::crypto::Vault::in_memory_with_key([7u8; 32])).unwrap();
        assert_eq!(db.pending_count(now_ms(), &policy), 1);
    }

    #[test]
    fn las_consultas_a_jev_se_cuentan_por_dia_y_en_total() {
        let db = db();
        let today = now_ms();
        assert_eq!(db.jev_calls(today), (0, 0));
        for _ in 0..3 {
            db.count_jev_call(today).unwrap();
        }
        assert_eq!(db.jev_calls(today), (3, 3));
        // Al cambiar la fecha el contador del día empieza de nuevo; el total sigue.
        let later = today + 2 * 86_400_000;
        assert_eq!(db.jev_calls(later), (0, 3));
        db.count_jev_call(later).unwrap();
        assert_eq!(db.jev_calls(later), (1, 4));
    }

    #[test]
    fn el_veredicto_de_una_categoria_borrada_no_rompe_nada() {
        let db = db();
        db.upsert_sheet(&incoming("file", "/notas/a.txt", "una hoja con texto de sobra para clasificar"), &session())
            .unwrap();
        let id = db.sheet_id("file", "/notas/a.txt").unwrap();
        let hash = db.get_sheet(id).unwrap().unwrap().hash;
        // Jev eligió una categoría que el usuario borró mientras respondía.
        let gone = Verdict { category_id: Some(999), confidence: 0.9, note_score: None };
        db.apply_verdict(id, &hash, &gone, 0.6, now_ms(), Some("firma")).unwrap();
        let sheet = db.get_sheet(id).unwrap().unwrap().summary;
        assert_eq!((sheet.category_id, sheet.category_source), (None, None));
        db.apply_threshold(0.1).unwrap();
        assert_eq!(db.get_sheet(id).unwrap().unwrap().summary.category_id, None);

        // La memoria de veredictos tiene tope: no crece sin límite.
        let verdict = Verdict { category_id: Some(1), confidence: 0.9, note_score: None };
        for n in 0..JEV_CACHE_ROWS + 50 {
            db.apply_verdict(id, &format!("huella-{n}"), &verdict, 0.6, n, Some("firma")).unwrap();
        }
        let kept: i64 = db.lock().query_row("SELECT count(*) FROM jev_cache", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, JEV_CACHE_ROWS);
        assert!(db.cached_verdict("huella-0", "firma").is_none());
        assert_eq!(db.cached_verdict(&format!("huella-{}", JEV_CACHE_ROWS + 49), "firma"), Some(verdict));
    }

    fn category_of(db: &Db, id: i64) -> (Option<i64>, Option<String>) {
        let sheet = db.get_sheet(id).unwrap().unwrap().summary;
        (sheet.category_id, sheet.category_source)
    }

    fn category_named(db: &Db, name: &str) -> i64 {
        db.categories().unwrap().into_iter().find(|c| c.name == name).expect("categoría de fábrica").id
    }

    #[test]
    fn el_encabezado_de_una_nota_le_pone_su_categoria() {
        let db = db();
        let code = category_named(&db, "Código");
        let note = "---\ntitulo: Comandos\ncategoria: CODIGO\nfuente: Claude Code\n---\n\n# Comandos\n";
        db.upsert_sheet(&incoming("file", "/Book/2026-10-14-comandos.md", note), &session()).unwrap();
        let id = db.sheet_id("file", "/Book/2026-10-14-comandos.md").unwrap();
        // Como si la hubiera elegido el usuario: el clasificador ya no la consulta.
        assert_eq!(category_of(&db, id), (Some(code), Some("manual".into())));
        assert_eq!(db.pending_count(now_ms() + 3_600_000, &db.jev_policy()), 0);
    }

    #[test]
    fn el_encabezado_no_crea_categorias_y_espera_a_que_existan() {
        let db = db();
        let before = db.categories().unwrap().len();
        let note = "---\ncategoria: Recetas\n---\nTarta de manzana";
        db.upsert_sheet(&incoming("file", "/Book/tarta.md", note), &session()).unwrap();
        let id = db.sheet_id("file", "/Book/tarta.md").unwrap();
        assert_eq!(category_of(&db, id), (None, None));
        assert_eq!(db.categories().unwrap().len(), before, "no se crea ninguna categoría");
        // Cuando el usuario crea la categoría, la próxima pasada del escáner la encuentra.
        let recipes = db.create_category("Recetas", "", "#FF9500").unwrap();
        db.upsert_sheet(&incoming("file", "/Book/tarta.md", note), &session()).unwrap();
        assert_eq!(category_of(&db, id), (Some(recipes), Some("manual".into())));
    }

    #[test]
    fn el_encabezado_pisa_al_clasificador_pero_nunca_al_usuario() {
        let db = db();
        let (work, ideas, home) = (category_named(&db, "Trabajo"), category_named(&db, "Ideas"), category_named(&db, "Casa"));
        db.upsert_sheet(&incoming("file", "/notas/a.md", "una nota con texto de sobra para clasificar"), &session()).unwrap();
        let id = db.sheet_id("file", "/notas/a.md").unwrap();
        let hash = db.get_sheet(id).unwrap().unwrap().hash;
        let verdict = Verdict { category_id: Some(work), confidence: 0.9, note_score: None };
        db.apply_verdict(id, &hash, &verdict, 0.6, now_ms(), Some("firma")).unwrap();
        assert_eq!(category_of(&db, id), (Some(work), Some("jev".into())));

        // La categoría que eligió Jev cede ante la del encabezado.
        db.upsert_sheet(&incoming("file", "/notas/a.md", "---\ncategoria: ideas\n---\nuna nota"), &session()).unwrap();
        assert_eq!(category_of(&db, id), (Some(ideas), Some("manual".into())));

        // La que elige el usuario no la cambia ningún encabezado, ni siquiera «Sin categoría».
        for chosen in [Some(home), None] {
            db.set_sheet_category(id, chosen).unwrap();
            db.upsert_sheet(&incoming("file", "/notas/a.md", "---\ncategoria: Trabajo\n---\notra versión"), &session()).unwrap();
            db.upsert_sheet(&incoming("file", "/notas/a.md", "---\ncategoria: Salud\n---\ny otra"), &session()).unwrap();
            assert_eq!(category_of(&db, id), (chosen, Some("manual".into())));
        }
    }

    #[test]
    fn marcar_secret_cifra_en_sqlite_y_quitar_descifra() {
        let db = db();
        let text = "mi texto super secreto y confidencial";
        db.upsert_sheet(&incoming("file", "/notas/secreto.txt", text), &session()).unwrap();
        let id = db.sheet_id("file", "/notas/secreto.txt").unwrap();

        // (a) Al marcar secret = true, en SQLite crudo empieza con enc1: y no contiene el texto plano
        db.set_sheet_secret(id, true).unwrap();
        let raw: String = db.lock().query_row("SELECT content FROM sheets WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        assert!(raw.starts_with("enc1:"));
        assert!(!raw.contains(text));

        // (b) get_sheet devuelve el texto plano
        let detail = db.get_sheet(id).unwrap().unwrap();
        assert_eq!(detail.content, text);

        // (c) al quitar secret = false, vuelve a texto plano en SQLite
        db.set_sheet_secret(id, false).unwrap();
        let raw_after: String = db.lock().query_row("SELECT content FROM sheets WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(raw_after, text);
        assert!(!raw_after.starts_with("enc1:"));
    }

    #[test]
    fn migracion_de_hoja_secreta_en_texto_plano_a_cifrada() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let plain = "secreto viejo sin cifrar";
        conn.execute(
            "INSERT INTO sheets (source, source_key, title, content, content_hash, size, created_at, modified_at, last_change_at, secret) \
             VALUES ('file', 'k1', 't1', ?1, 'h1', 10, 1, 1, 1, 1)",
            [plain],
        ).unwrap();

        let vault = crate::crypto::Vault::in_memory_with_key([5u8; 32]);
        let db = Db::setup(conn, vault).unwrap();

        let raw: String = db.lock().query_row("SELECT content FROM sheets WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert!(raw.starts_with("enc1:"));
        assert!(!raw.contains(plain));

        let detail = db.get_sheet(1).unwrap().unwrap();
        assert_eq!(detail.content, plain);
    }

    #[test]
    fn secret_book_bloqueado_sin_clave_y_recuperacion_con_import_secret_key() {
        let key = [42u8; 32];
        let plain = "nota secreta protegida";
        let enc = crate::crypto::encrypt(&key, plain).unwrap();

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO sheets (source, source_key, title, content, content_hash, size, created_at, modified_at, last_change_at, secret) \
             VALUES ('file', 'k1', 't1', ?1, 'h1', 10, 1, 1, 1, 1)",
            [&enc],
        ).unwrap();

        // Abrimos con Vault bloqueado (sin clave)
        let vault = crate::crypto::Vault::in_memory_empty();
        let db = Db::setup(conn, vault).unwrap();

        assert_eq!(db.secret_state(), SecretState::Locked);
        assert_eq!(db.secret_locked_count(), 1);

        // get_sheet falla sin la clave
        assert!(db.get_sheet(1).is_err());

        // Importar una clave incorrecta falla con error específico
        let wrong_key = crate::crypto::encode_key(&[99u8; 32]);
        let err = db.import_secret_key(&wrong_key).unwrap_err();
        assert!(err.to_string().contains("Esa clave no abre las hojas secretas"));

        // Importar la clave correcta desbloquea
        let correct_key = crate::crypto::encode_key(&key);
        db.import_secret_key(&correct_key).unwrap();

        assert_eq!(db.secret_state(), SecretState::Ready);
        assert_eq!(db.secret_locked_count(), 0);

        let detail = db.get_sheet(1).unwrap().unwrap();
        assert_eq!(detail.content, plain);
    }

    #[test]
    fn hoja_secreta_larga_en_papelera_muestra_preview_descifrado() {
        let db = db();
        let long_text = "Secreto muy largo que supera los mil caracteres para probar el truncado de SQLite. ".repeat(20);
        assert!(long_text.chars().count() > 1000);

        let inc = incoming("file", "/notas/secreta.txt", &long_text);
        db.upsert_sheet(&inc, &session()).unwrap();
        let id = db.sheet_id("file", "/notas/secreta.txt").unwrap();

        db.set_sheet_secret(id, true).unwrap();
        db.set_sheet_hidden(id, true).unwrap();

        let raw: String = db.lock().query_row("SELECT content FROM sheets WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        assert!(raw.starts_with("enc1:"));
        assert!(raw.len() > 1000);

        let sheets = db.list_sheets(&ListFilter {
            view: "hidden".into(),
            category_id: None,
            query: None,
            before_ts: None,
            before_id: None,
            until: None,
            limit: Some(10),
        }).unwrap();

        assert_eq!(sheets.len(), 1);
        let summary = &sheets[0];
        assert_eq!(summary.id, id);
        assert!(summary.secret);
        assert!(summary.hidden);
        assert_eq!(summary.preview, long_text.chars().take(900).collect::<String>());
        assert_eq!(summary.length, long_text.chars().count() as i64);
    }

    #[test]
    fn veredicto_viejo_no_pisa_hoja_editada_mientras_ia_respondia() {
        let db = db();
        let work = category_named(&db, "Trabajo");
        let ideas = category_named(&db, "Ideas");

        db.upsert_sheet(&incoming("file", "/notas/test.txt", "texto original suficiente para clasificar"), &session()).unwrap();
        let id = db.sheet_id("file", "/notas/test.txt").unwrap();
        let old_hash = db.get_sheet(id).unwrap().unwrap().hash;

        // El usuario edita la hoja mientras la IA respondía, cambiando el hash
        db.upsert_sheet(&incoming("file", "/notas/test.txt", "texto modificado con otro contenido totalmente nuevo"), &session()).unwrap();
        let new_hash = db.get_sheet(id).unwrap().unwrap().hash;
        assert_ne!(old_hash, new_hash);

        // Llega el veredicto viejo con el old_hash
        let verdict = Verdict { category_id: Some(work), confidence: 0.95, note_score: None };
        db.apply_verdict(id, &old_hash, &verdict, 0.6, now_ms(), Some("firma")).unwrap();

        // Como el content_hash cambió, el veredicto viejo no se aplicó
        let detail = db.get_sheet(id).unwrap().unwrap();
        assert_eq!(detail.summary.category_id, None);
        assert_eq!(detail.summary.category_source, None);

        // Pero con new_hash sí se aplica
        let new_verdict = Verdict { category_id: Some(ideas), confidence: 0.95, note_score: None };
        db.apply_verdict(id, &new_hash, &new_verdict, 0.6, now_ms(), Some("firma")).unwrap();
        let detail = db.get_sheet(id).unwrap().unwrap();
        assert_eq!(detail.summary.category_id, Some(ideas));
        assert_eq!(detail.summary.category_source, Some("jev".into()));
    }

    #[test]
    fn asegurar_categoria_recortes_crea_o_reutiliza() {
        let db = db();
        let cat_id = db.ensure_clippings_category().unwrap();
        let cat_id2 = db.ensure_clippings_category().unwrap();
        assert_eq!(cat_id, cat_id2);
        let categories = db.categories().unwrap();
        let cat = categories.into_iter().find(|c| c.id == cat_id).expect("la categoría de recortes existe");
        assert!(cat.name == "Recortes" || cat.name == "Clippings");
    }

    #[test]
    fn migrar_recortes_asigna_categoria_a_recortes_sin_clasificar() {
        let db = db();
        let cat_id = db.ensure_clippings_category().unwrap();

        // 1. Hoja con source = "capture" sin categoría
        db.upsert_sheet(&incoming("capture", "cap-1", "texto capturado rápido"), &session()).unwrap();
        let id1 = db.sheet_id("capture", "cap-1").unwrap();

        // 2. Archivo recortes-2026-10-14.txt con encabezado de recorte
        db.upsert_sheet(&incoming("file", "/notas/recortes-2026-10-14.txt", "— 10:00 · Web\ncontenido del recorte"), &session()).unwrap();
        let id2 = db.sheet_id("file", "/notas/recortes-2026-10-14.txt").unwrap();

        // 3. Hoja normal cualquiera
        db.upsert_sheet(&incoming("file", "/notas/apuntes.txt", "mis apuntes de la clase"), &session()).unwrap();
        let id3 = db.sheet_id("file", "/notas/apuntes.txt").unwrap();

        assert_eq!(db.sheet_category(id1).unwrap(), None);
        assert_eq!(db.sheet_category(id2).unwrap(), None);
        assert_eq!(db.sheet_category(id3).unwrap(), None);

        let untagged = db.untagged_clippings(None).unwrap();
        assert_eq!(untagged.len(), 2);
        assert!(untagged.contains(&id1));
        assert!(untagged.contains(&id2));
        assert!(!untagged.contains(&id3));

        let migrated = db.migrate_clippings(None).unwrap();
        assert_eq!(migrated, 2);

        assert_eq!(db.sheet_category(id1).unwrap(), Some(cat_id));
        assert_eq!(db.sheet_category(id2).unwrap(), Some(cat_id));
        assert_eq!(db.sheet_category(id3).unwrap(), None);

        // Si se vuelve a correr, ya no hay nada que migrar
        let migrated_again = db.migrate_clippings(None).unwrap();
        assert_eq!(migrated_again, 0);
    }
}
