//! Pestañas sin guardar del Bloc de notas de Windows 11.
//!
//! El Bloc de notas persiste cada pestaña en `TabState\<guid>.bin`. El formato no está
//! documentado; lo de abajo se verificó contra archivos reales usando los CRC32 que el
//! propio archivo incluye:
//!
//! ```text
//! "NP" | secuencia (uleb) | tipo (uleb: 0 = sin guardar, 1 = archivo guardado)
//! [tipo 0] delimitador 0x01
//! inicio y fin de selección (uleb, uleb)
//! ajuste de línea, RTL, mostrar unicode (3 bytes) | opciones extra (uleb n + n bytes)
//! longitud (uleb, en unidades UTF-16) | texto UTF-16LE | flag | CRC32-BE de bytes[3..]
//! luego, ediciones aún no consolidadas, cada una:
//!   posición (uleb) | borrados (uleb) | agregados (uleb) | texto UTF-16LE | CRC32-BE
//! ```
//!
//! Mientras el Bloc de notas está abierto, lo tipeado vive en esas ediciones y el texto
//! base puede estar vacío: hay que aplicarlas para obtener la pestaña real.

use std::path::{Path, PathBuf};

use crate::db::{Db, Incoming, Outcome, VersionCfg};
use crate::text;

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Option<u8> {
        let b = *self.buf.get(self.pos)?;
        self.pos += 1;
        Some(b)
    }

    fn uleb(&mut self) -> Option<usize> {
        let mut value: u64 = 0;
        for shift in (0..64).step_by(7) {
            let b = self.u8()?;
            value |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return usize::try_from(value).ok();
            }
        }
        None
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        let end = self.pos.checked_add(n)?;
        (end <= self.buf.len()).then(|| self.pos = end)
    }

    fn utf16(&mut self, units: usize) -> Option<Vec<u16>> {
        let end = self.pos.checked_add(units.checked_mul(2)?)?;
        let bytes = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect())
    }

    fn u32_be(&mut self) -> Option<u32> {
        let bytes = self.buf.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}

/// Lee el texto base siguiendo la estructura conocida. Deja el lector justo después del CRC.
fn read_base(r: &mut Reader) -> Option<Vec<u16>> {
    r.pos = 2;
    r.uleb()?; // número de secuencia
    if r.uleb()? != 0 {
        return None; // pestaña de un archivo guardado: el archivo ya se indexa por su ruta
    }
    r.u8()?; // delimitador
    r.uleb()?; // inicio de selección
    r.uleb()?; // fin de selección
    r.skip(3)?;
    let extra = r.uleb()?;
    r.skip(extra)?;
    let len = r.uleb()?;
    let units = r.utf16(len)?;
    r.u8()?; // flag "sin guardar"
    let crc_end = r.pos;
    (crc32fast::hash(&r.buf[3..crc_end]) == r.u32_be()?).then_some(units)
}

/// Si una actualización del Bloc de notas cambia la cabecera, el CRC permite ubicar
/// igualmente el texto: se prueba cada offset hasta que la suma coincide.
fn locate_base(r: &mut Reader) -> Option<Vec<u16>> {
    let buf = r.buf;
    if buf.get(3) != Some(&0) {
        return None;
    }
    let mut best: Option<(usize, Vec<u16>)> = None;
    for start in 4..buf.len().min(96) {
        let mut probe = Reader { buf, pos: start };
        let Some(len) = probe.uleb() else { continue };
        let Some(units) = probe.utf16(len) else { continue };
        if probe.u8().is_none() {
            continue;
        }
        let crc_end = probe.pos;
        if probe.u32_be() != Some(crc32fast::hash(&buf[3..crc_end])) {
            continue;
        }
        // Varias posiciones pueden validar con el mismo CRC (por ejemplo, una longitud 0
        // justo antes del flag). Se descartan las que leen bytes de cabecera como
        // caracteres de control y, entre las restantes, gana el texto más largo.
        let clean = units.iter().all(|&u| u >= 0x20 || matches!(u, 0x09 | 0x0A | 0x0D));
        if clean && best.as_ref().map_or(true, |(_, b)| units.len() > b.len()) {
            best = Some((probe.pos, units));
        }
    }
    let (pos, units) = best?;
    r.pos = pos;
    Some(units)
}

/// Devuelve el texto actual de una pestaña sin guardar, o `None` si el archivo no es una.
pub fn parse(buf: &[u8]) -> Option<String> {
    if buf.len() < 9 || &buf[..2] != b"NP" {
        return None;
    }
    let mut r = Reader { buf, pos: 2 };
    let mut units = match read_base(&mut r) {
        Some(units) => units,
        None => locate_base(&mut r)?,
    };
    while r.pos < buf.len() {
        let start = r.pos;
        let (Some(at), Some(deleted), Some(added)) = (r.uleb(), r.uleb(), r.uleb()) else {
            break;
        };
        let Some(inserted) = r.utf16(added) else { break };
        let end = r.pos;
        if r.u32_be() != Some(crc32fast::hash(&buf[start..end])) || at > units.len() {
            break;
        }
        let delete_end = at.saturating_add(deleted).min(units.len());
        units.splice(at..delete_end, inserted);
    }
    Some(text::normalize_newlines(&String::from_utf16_lossy(&units)))
}

pub fn tabstate_dir() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join("Packages")
        .join("Microsoft.WindowsNotepad_8wekyb3d8bbwe")
        .join("LocalState")
        .join("TabState");
    dir.is_dir().then_some(dir)
}

/// `<guid>.bin` es una pestaña; `<guid>.0.bin` y `<guid>.1.bin` son estado de ventana.
fn tab_id(path: &Path) -> Option<String> {
    let stem = path.file_name()?.to_str()?.strip_suffix(".bin")?;
    (!stem.ends_with(".0") && !stem.ends_with(".1")).then(|| stem.to_string())
}

fn mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(crate::db::now_ms)
}

/// Sincroniza una pestaña. Devuelve `true` si el Book cambió.
pub fn sync_file(db: &Db, path: &Path, cfg: &VersionCfg) -> bool {
    let Some(id) = tab_id(path) else {
        return false;
    };
    let Ok(bytes) = std::fs::read(path) else {
        // Si el archivo ya no existe, la pestaña se cerró: la hoja queda en el Book.
        return !path.exists() && db.mark_missing("notepad", &id);
    };
    let Some(content) = parse(&bytes) else {
        return false;
    };
    if content.trim().is_empty() {
        return false;
    }
    let modified = mtime_ms(path);
    let incoming = Incoming {
        source: "notepad",
        source_key: id,
        title: text::title_from_content(&content),
        path: None,
        size: content.len() as i64,
        content,
        source_mtime: modified,
        created_at: modified,
        modified_at: modified,
    };
    matches!(db.upsert_sheet(&incoming, cfg), Ok(Outcome::Created | Outcome::Updated))
}

/// Sincroniza todas las pestañas abiertas y marca como cerradas las que ya no están.
pub fn sync_all(db: &Db, cfg: &VersionCfg) -> usize {
    let Some(dir) = tabstate_dir() else {
        return 0;
    };
    let mut changed = 0;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if sync_file(db, &entry.path(), cfg) {
                changed += 1;
            }
        }
    }
    for key in db.keys_for_source("notepad").unwrap_or_default() {
        if !dir.join(format!("{key}.bin")).exists() && db.mark_missing("notepad", &key) {
            changed += 1;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::parse;

    fn uleb(mut v: usize) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return out;
            }
            out.push(b | 0x80);
        }
    }

    fn utf16(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    fn tab(base: &str, edits: &[(usize, usize, &str)]) -> Vec<u8> {
        let mut buf = vec![b'N', b'P', 0, 0, 1, 0, 0, 1, 0, 0, 3, 1, 1, 1];
        buf.extend(uleb(base.encode_utf16().count()));
        buf.extend(utf16(base));
        buf.push(1);
        let crc = crc32fast::hash(&buf[3..]);
        buf.extend(crc.to_be_bytes());
        for (at, deleted, added) in edits {
            let mut chunk = uleb(*at);
            chunk.extend(uleb(*deleted));
            chunk.extend(uleb(added.encode_utf16().count()));
            chunk.extend(utf16(added));
            let crc = crc32fast::hash(&chunk);
            buf.extend(chunk);
            buf.extend(crc.to_be_bytes());
        }
        buf
    }

    #[test]
    fn lee_el_texto_base() {
        assert_eq!(parse(&tab("hola\rmundo", &[])).as_deref(), Some("hola\nmundo"));
    }

    #[test]
    fn aplica_las_ediciones_pendientes() {
        let buf = tab("", &[(0, 0, "hola"), (4, 0, " mundo"), (0, 1, "H")]);
        assert_eq!(parse(&buf).as_deref(), Some("Hola mundo"));
    }

    #[test]
    fn ubica_el_texto_si_cambia_la_cabecera() {
        // Cabecera con un campo extra desconocido antes de la longitud.
        let mut buf = vec![b'N', b'P', 0, 0, 1, 0, 0, 1, 0, 0, 0x7f, 0x7f];
        let text = "nota con cabecera nueva";
        buf.push(text.len() as u8);
        buf.extend(utf16(text));
        buf.push(1);
        let crc = crc32fast::hash(&buf[3..]);
        buf.extend(crc.to_be_bytes());
        assert_eq!(parse(&buf).as_deref(), Some(text));
    }

    #[test]
    fn descarta_lo_que_no_es_una_pestana() {
        assert_eq!(parse(b"NP\x02\x0e\x00\x00\x00\x00\x00\x00\x00\x00"), None);
        assert_eq!(parse(b"otra cosa distinta"), None);
    }
}
