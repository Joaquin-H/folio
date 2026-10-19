//! Sticky Notes de Windows: las notas viven en una base SQLite (`plum.sqlite`).
//! Se abre siempre en modo solo lectura; Book nunca escribe ahí.

use std::path::PathBuf;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::db::{Db, Incoming, Outcome, VersionCfg};
use crate::text;

/// Diferencia entre el año 1 (ticks de .NET) y 1970 (epoch de Unix), en ticks de 100 ns.
const TICKS_AT_UNIX_EPOCH: i64 = 621_355_968_000_000_000;

pub fn db_path() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let path = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join("Packages")
        .join("Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe")
        .join("LocalState")
        .join("plum.sqlite");
    path.is_file().then_some(path)
}

fn ticks_to_ms(ticks: i64) -> i64 {
    (ticks - TICKS_AT_UNIX_EPOCH) / 10_000
}

/// Cada párrafo viene con un prefijo interno `\id=<guid> ` que no es parte de la nota.
fn clean(raw: &str) -> String {
    raw.lines()
        .map(|line| {
            line.strip_prefix("\\id=")
                .and_then(|rest| rest.get(36..))
                .map(|rest| rest.strip_prefix(' ').unwrap_or(rest))
                .unwrap_or(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn read_notes() -> rusqlite::Result<Vec<(String, String, i64, i64)>> {
    let Some(path) = db_path() else {
        return Ok(Vec::new());
    };
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(Duration::from_millis(500))?;
    let mut stmt = conn.prepare(
        "SELECT Id, Text, CreatedAt, UpdatedAt FROM Note \
         WHERE Text IS NOT NULL AND (DeletedAt IS NULL OR DeletedAt = 0)",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            r.get::<_, Option<i64>>(3)?.unwrap_or(0),
        ))
    })?;
    rows.collect()
}

/// Sincroniza las notas adhesivas. Devuelve cuántas hojas cambiaron.
pub fn sync(db: &Db, cfg: &VersionCfg) -> usize {
    let Ok(notes) = read_notes() else {
        return 0;
    };
    let mut changed = 0;
    let mut alive = Vec::with_capacity(notes.len());
    for (id, raw, created, updated) in notes {
        let content = text::normalize_newlines(&clean(&raw));
        if content.trim().is_empty() {
            continue;
        }
        let modified = ticks_to_ms(updated.max(created));
        let incoming = Incoming {
            source: "sticky",
            source_key: id.clone(),
            title: text::title_from_content(&content),
            path: None,
            size: content.len() as i64,
            content,
            source_mtime: modified,
            created_at: ticks_to_ms(created),
            modified_at: modified,
        };
        if matches!(db.upsert_sheet(&incoming, cfg), Ok(Outcome::Created | Outcome::Updated)) {
            changed += 1;
        }
        alive.push(id);
    }
    for key in db.keys_for_source("sticky").unwrap_or_default() {
        if !alive.contains(&key) && db.mark_missing("sticky", &key) {
            changed += 1;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::{clean, ticks_to_ms};

    #[test]
    fn quita_los_prefijos_internos() {
        let raw = "\\id=2a41ab1c-1dc4-4ee5-9603-0e38ff5bf0e3 comprar pan\n\\id=7443cad6-7a81-41e0-ac52-e13622873d62 llamar\nsin prefijo";
        assert_eq!(clean(raw), "comprar pan\nllamar\nsin prefijo");
    }

    #[test]
    fn convierte_ticks_de_dotnet() {
        // 2020-01-01T00:00:00Z
        assert_eq!(ticks_to_ms(637_134_336_000_000_000), 1_577_836_800_000);
    }
}
