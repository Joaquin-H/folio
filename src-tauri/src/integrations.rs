//! Integraciones con asistentes de IA: Book les deja instrucciones para que tomen notas
//! en su carpeta, con el formato de `integrations/formato-de-notas.md`. Las instrucciones
//! son los archivos de `integrations/` (los mismos que se ven en el repositorio), con la
//! carpeta de notas de esta PC en lugar de `{{CARPETA_DE_NOTAS}}`.
//!
//! Para Claude Code es una skill en su propia carpeta: el archivo es todo de Book. Codex y
//! Gemini CLI leen un único archivo global (AGENTS.md, GEMINI.md) que suele tener cosas del
//! usuario: ahí Book solo agrega su bloque, entre dos marcadores, y al quitarlo saca solo eso.

use std::path::{Path, PathBuf};

use serde::Serialize;

const PLACEHOLDER: &str = "{{CARPETA_DE_NOTAS}}";
const SKILL: &str = include_str!("../../integrations/claude/folio-notes/SKILL.md");
const CODEX: &str = include_str!("../../integrations/codex/AGENTS.md");
const GEMINI: &str = include_str!("../../integrations/gemini/GEMINI.md");
/// Comienzo del renglón que abre el bloque de Folio (el resto del renglón es una aclaración).
const START: &str = "<!-- folio:inicio";
const END: &str = "<!-- folio:fin -->";
const LEGACY_START: &str = "<!-- book:inicio";
const LEGACY_END: &str = "<!-- book:fin -->";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Claude,
    Codex,
    Gemini,
}

pub const TOOLS: [Tool; 3] = [Tool::Claude, Tool::Codex, Tool::Gemini];

impl Tool {
    pub fn parse(name: &str) -> Result<Tool, String> {
        match name {
            "claude" => Ok(Tool::Claude),
            "codex" => Ok(Tool::Codex),
            "gemini" => Ok(Tool::Gemini),
            other => Err(format!("No hay una integración llamada «{other}»")),
        }
    }

    fn key(self) -> &'static str {
        match self {
            Tool::Claude => "claude",
            Tool::Codex => "codex",
            Tool::Gemini => "gemini",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Tool::Claude => "Claude Code",
            Tool::Codex => "Codex",
            Tool::Gemini => "Gemini CLI",
        }
    }

    /// Las instrucciones de esta herramienta son un archivo propio de Book (la skill) y
    /// no un bloque dentro de un archivo del usuario.
    fn owns_file(self) -> bool {
        self == Tool::Claude
    }
}

/// Dónde guarda su configuración cada herramienta.
pub struct Homes {
    pub claude: PathBuf,
    pub codex: PathBuf,
    pub gemini: PathBuf,
}

impl Homes {
    /// Las de este usuario: `~/.claude` (o `CLAUDE_CONFIG_DIR`), `~/.codex` (o
    /// `CODEX_HOME`) y `~/.gemini`.
    pub fn of_user() -> Option<Homes> {
        let home = dirs::home_dir()?;
        let from_env = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from);
        Some(Homes {
            claude: from_env("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude")),
            codex: from_env("CODEX_HOME").unwrap_or_else(|| home.join(".codex")),
            gemini: home.join(".gemini"),
        })
    }

    /// Archivo donde van las instrucciones de esa herramienta.
    pub fn file(&self, tool: Tool) -> PathBuf {
        match tool {
            Tool::Claude => self.claude.join("skills").join("folio-notes").join("SKILL.md"),
            Tool::Codex => self.codex.join("AGENTS.md"),
            Tool::Gemini => self.gemini.join("GEMINI.md"),
        }
    }
}

/// Las instrucciones para esa herramienta, con la carpeta de notas de esta PC.
pub fn instructions(tool: Tool, notes_dir: &Path) -> String {
    let template = match tool {
        Tool::Claude => SKILL,
        Tool::Codex => CODEX,
        Tool::Gemini => GEMINI,
    };
    template.replace("\r\n", "\n").replace(PLACEHOLDER, &notes_dir.to_string_lossy())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub tool: &'static str,
    pub name: &'static str,
    pub path: String,
    pub exists: bool,
    pub installed: bool,
    /// Lo instalado es igual a lo que instalaría esta versión de Book.
    pub current: bool,
    pub note: Option<String>,
}

pub fn status(homes: &Homes, tool: Tool, notes_dir: &Path) -> Status {
    let path = homes.file(tool);
    let exists = path.is_file();
    let wanted = instructions(tool, notes_dir);
    let on_disk = read(&path).ok().flatten();
    let (installed, current) = match (&on_disk, tool.owns_file()) {
        (Some(text), true) => (true, text.replace("\r\n", "\n").trim_end() == wanted.trim_end()),
        (Some(text), false) => match find_block(text) {
            Ok(Some((start, end))) => (true, text[start..end].replace("\r\n", "\n").trim_end() == wanted.trim_end()),
            _ => (false, false),
        },
        (None, _) => (false, false),
    };
    let damaged = !tool.owns_file() && on_disk.as_deref().is_some_and(|text| find_block(text).is_err());
    let note = if damaged {
        Some("El bloque de Book en ese archivo quedó incompleto (falta uno de sus marcadores): arreglalo a mano antes de instalar.".into())
    } else if tool == Tool::Codex && homes.codex.join("AGENTS.override.md").is_file() {
        Some("En la misma carpeta hay un AGENTS.override.md: mientras exista, Codex lee ese archivo y no este.".into())
    } else {
        None
    };
    Status {
        tool: tool.key(),
        name: tool.name(),
        path: path.to_string_lossy().to_string(),
        exists,
        installed,
        current,
        note,
    }
}

/// Deja las instrucciones de Book donde las lee esa herramienta.
pub fn install(homes: &Homes, tool: Tool, notes_dir: &Path) -> Result<(), String> {
    let path = homes.file(tool);
    let text = instructions(tool, notes_dir);
    if tool.owns_file() {
        return write(&path, &text, None);
    }
    let (existing, bom) = match read_raw(&path)? {
        Some((text, bom)) => (text, bom),
        None => (String::new(), false),
    };
    write(&path, &with_block(&existing, &text)?, Some(bom))
}

/// Saca lo de Book de esa herramienta, y nada más.
pub fn remove(homes: &Homes, tool: Tool) -> Result<(), String> {
    let path = homes.file(tool);
    if tool.owns_file() {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err.to_string()),
        }
        // La carpeta de la skill se va solo si quedó vacía.
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir(dir);
        }
        return Ok(());
    }
    let Some((existing, bom)) = read_raw(&path)? else {
        return Ok(());
    };
    let Some(rest) = without_block(&existing)? else {
        return Ok(());
    };
    if rest.trim().is_empty() {
        // Sin el bloque no queda nada: el archivo lo había creado Book.
        return std::fs::remove_file(&path).map_err(|err| err.to_string());
    }
    write(&path, &rest, Some(bom))
}

// ---- el bloque entre marcadores ---------------------------------------------------

/// Dónde está el bloque de Book en el texto: desde el principio del renglón que lo abre
/// hasta el final del que lo cierra (con su salto de línea). `Err` si está a medias: un
/// marcador sin el otro, o abierto dos veces. Ahí no se toca nada, para no llevarse por
/// delante lo que escribió el usuario.
fn find_block(text: &str) -> Result<Option<(usize, usize)>, ()> {
    if let Some(range) = find_tagged(text, START, END)? {
        return Ok(Some(range));
    }
    find_tagged(text, LEGACY_START, LEGACY_END)
}

fn find_tagged(text: &str, start_tag: &str, end_tag: &str) -> Result<Option<(usize, usize)>, ()> {
    let opens: Vec<usize> = text.match_indices(start_tag).map(|(at, _)| at).collect();
    let closes: Vec<usize> = text.match_indices(end_tag).map(|(at, _)| at).collect();
    match (opens.as_slice(), closes.as_slice()) {
        ([], []) => Ok(None),
        ([open], [close]) if open < close => {
            let start = text[..*open].rfind('\n').map_or(0, |nl| nl + 1);
            let after = close + end_tag.len();
            let end = text[after..].find('\n').map_or(text.len(), |nl| after + nl + 1);
            Ok(Some((start, end)))
        }
        _ => Err(()),
    }
}

const DAMAGED: &str = "El bloque de Book en ese archivo quedó incompleto (falta uno de sus marcadores). Arreglalo a mano: Book no lo toca para no borrar nada tuyo.";

/// El texto con el bloque de Book: reemplaza el que ya estaba, en su lugar, o lo agrega
/// al final, separado por un renglón en blanco. Respeta los saltos de línea del archivo.
fn with_block(existing: &str, block: &str) -> Result<String, String> {
    let nl = if existing.contains("\r\n") { "\r\n" } else { "\n" };
    let block = format!("{}{nl}", block.trim_end().replace('\n', nl));
    Ok(match find_block(existing).map_err(|_| DAMAGED.to_string())? {
        Some((start, end)) => format!("{}{block}{}", &existing[..start], &existing[end..]),
        None if existing.is_empty() => block,
        None => {
            let mut out = existing.to_string();
            if !out.ends_with('\n') {
                out.push_str(nl);
            }
            if !out.ends_with(&format!("{nl}{nl}")) && out != nl {
                out.push_str(nl);
            }
            out + &block
        }
    })
}

/// El texto sin el bloque de Book; `None` si no lo tenía. Si el bloque iba al final, se
/// va también el renglón en blanco que lo separaba de lo anterior.
fn without_block(existing: &str) -> Result<Option<String>, String> {
    let Some((start, end)) = find_block(existing).map_err(|_| DAMAGED.to_string())? else {
        return Ok(None);
    };
    let before = &existing[..start];
    let after = &existing[end..];
    if !after.trim().is_empty() {
        return Ok(Some(format!("{before}{after}")));
    }
    let trimmed = before
        .strip_suffix("\r\n\r\n")
        .map(|rest| format!("{rest}\r\n"))
        .or_else(|| before.strip_suffix("\n\n").map(|rest| format!("{rest}\n")))
        .unwrap_or_else(|| before.to_string());
    Ok(Some(trimmed))
}

// ---- archivos ----------------------------------------------------------------------

/// Texto de un archivo y si empezaba con la marca de UTF-8; `None` si no existe. Un
/// archivo que no es UTF-8 no se toca.
fn read_raw(path: &Path) -> Result<Option<(String, bool)>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("No se pudo leer {}: {err}", path.display())),
    };
    let (body, bom) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => (rest.to_vec(), true),
        None => (bytes, false),
    };
    String::from_utf8(body)
        .map(|text| Some((text, bom)))
        .map_err(|_| format!("{} no está en UTF-8: Book no lo modifica.", path.display()))
}

fn read(path: &Path) -> Result<Option<String>, String> {
    Ok(read_raw(path)?.map(|(text, _)| text))
}

/// Escribe el archivo entero de una vez: primero al lado y después en su lugar, así un
/// corte a mitad de camino no deja un archivo del usuario por la mitad.
fn write(path: &Path, text: &str, bom: Option<bool>) -> Result<(), String> {
    let dir = path.parent().ok_or("Ruta inválida")?;
    std::fs::create_dir_all(dir).map_err(|err| format!("No se pudo crear {}: {err}", dir.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let temp = dir.join(format!(".{name}.book-tmp"));
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if bom == Some(true) {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(text.as_bytes());
    std::fs::write(&temp, bytes).map_err(|err| format!("No se pudo escribir en {}: {err}", dir.display()))?;
    std::fs::rename(&temp, path).map_err(|err| {
        let _ = std::fs::remove_file(&temp);
        format!("No se pudo escribir {}: {err}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Carpeta temporal propia de cada prueba; se borra al terminar.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("book-integraciones-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }

        fn homes(&self) -> Homes {
            Homes { claude: self.0.join(".claude"), codex: self.0.join(".codex"), gemini: self.0.join(".gemini") }
        }

        fn notes(&self) -> PathBuf {
            self.0.join("Documentos").join("Book")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const MINE: &str = "# Mis reglas\n\n- Respondé en español.\n- Nada de emojis.\n";

    #[test]
    fn agrega_el_bloque_al_final_sin_tocar_lo_que_habia() {
        let scratch = Scratch::new("agrega");
        let homes = scratch.homes();
        let file = homes.file(Tool::Codex);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, MINE).unwrap();

        install(&homes, Tool::Codex, &scratch.notes()).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.starts_with(MINE), "lo del usuario tiene que seguir igual al principio");
        assert!(text.contains(START) && text.contains(END));
        // La ruta de verdad, no el marcador de la plantilla.
        assert!(text.contains(&scratch.notes().to_string_lossy().to_string()));
        assert!(!text.contains(PLACEHOLDER));
        let status = status(&homes, Tool::Codex, &scratch.notes());
        assert!(status.installed && status.current && status.exists);

        remove(&homes, Tool::Codex).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), MINE);
        assert!(!status_of(&homes, Tool::Codex, &scratch).installed);
    }

    fn status_of(homes: &Homes, tool: Tool, scratch: &Scratch) -> Status {
        status(homes, tool, &scratch.notes())
    }

    #[test]
    fn reinstalar_reemplaza_el_bloque_en_su_lugar() {
        let scratch = Scratch::new("reemplaza");
        let homes = scratch.homes();
        let file = homes.file(Tool::Gemini);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        // El usuario tiene cosas antes y después de un bloque viejo de Book.
        let old = format!("{MINE}\n{START} vieja -->\nInstrucciones viejas\n{END}\n\n## Después\nAlgo mío.\n");
        std::fs::write(&file, &old).unwrap();
        assert!(!status_of(&homes, Tool::Gemini, &scratch).current, "un bloque viejo no está al día");

        install(&homes, Tool::Gemini, &scratch.notes()).unwrap();
        install(&homes, Tool::Gemini, &scratch.notes()).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text.matches(START).count(), 1, "el bloque no se duplica");
        assert!(!text.contains("Instrucciones viejas"));
        assert!(text.starts_with(MINE) && text.ends_with("\n## Después\nAlgo mío.\n"));
        assert!(status_of(&homes, Tool::Gemini, &scratch).current);

        remove(&homes, Tool::Gemini).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("{MINE}\n\n## Después\nAlgo mío.\n"));
    }

    #[test]
    fn crea_el_archivo_si_no_existe_y_lo_borra_al_quitar() {
        let scratch = Scratch::new("crea");
        let homes = scratch.homes();
        let file = homes.file(Tool::Codex);
        assert!(!status_of(&homes, Tool::Codex, &scratch).exists);
        install(&homes, Tool::Codex, &scratch.notes()).unwrap();
        assert!(std::fs::read_to_string(&file).unwrap().starts_with(START));
        remove(&homes, Tool::Codex).unwrap();
        assert!(!file.exists(), "el archivo era solo de Book");
        // Quitar lo que no está no es un error.
        remove(&homes, Tool::Codex).unwrap();
    }

    #[test]
    fn respeta_los_saltos_de_windows_y_la_marca_de_utf8() {
        let scratch = Scratch::new("crlf");
        let homes = scratch.homes();
        let file = homes.file(Tool::Gemini);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let mine = MINE.replace('\n', "\r\n");
        std::fs::write(&file, [&[0xEF, 0xBB, 0xBF][..], mine.as_bytes()].concat()).unwrap();
        install(&homes, Tool::Gemini, &scratch.notes()).unwrap();
        let bytes = std::fs::read(&file).unwrap();
        assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
        assert!(!text.replace("\r\n", "").contains('\n'), "todos los saltos tienen que ser de Windows");
        remove(&homes, Tool::Gemini).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), [&[0xEF, 0xBB, 0xBF][..], mine.as_bytes()].concat());
    }

    #[test]
    fn un_bloque_a_medias_no_se_toca() {
        let scratch = Scratch::new("medias");
        let homes = scratch.homes();
        let file = homes.file(Tool::Codex);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let broken = format!("{MINE}{START} -->\nalgo que el usuario dejó\n");
        std::fs::write(&file, &broken).unwrap();
        assert!(install(&homes, Tool::Codex, &scratch.notes()).is_err());
        assert!(remove(&homes, Tool::Codex).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), broken);
        assert!(status_of(&homes, Tool::Codex, &scratch).note.is_some());
    }

    #[test]
    fn un_archivo_que_no_es_utf8_no_se_toca() {
        let scratch = Scratch::new("ansi");
        let homes = scratch.homes();
        let file = homes.file(Tool::Codex);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let ansi = b"Reglas con e\xf1e en ANSI\n".to_vec();
        std::fs::write(&file, &ansi).unwrap();
        assert!(install(&homes, Tool::Codex, &scratch.notes()).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), ansi);
    }

    #[test]
    fn la_skill_de_claude_va_en_su_carpeta_y_se_va_entera() {
        let scratch = Scratch::new("skill");
        let homes = scratch.homes();
        install(&homes, Tool::Claude, &scratch.notes()).unwrap();
        let file = homes.file(Tool::Claude);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.starts_with("---\nname: folio-notes\ndescription: "), "la skill necesita su encabezado");
        assert!(text.contains(&scratch.notes().to_string_lossy().to_string()) && !text.contains(PLACEHOLDER));
        assert!(status_of(&homes, Tool::Claude, &scratch).current);
        // Otra skill del usuario, al lado, no se toca.
        let other = homes.claude.join("skills").join("otra").join("SKILL.md");
        std::fs::create_dir_all(other.parent().unwrap()).unwrap();
        std::fs::write(&other, "---\nname: otra\n---\n").unwrap();
        remove(&homes, Tool::Claude).unwrap();
        assert!(!file.exists() && !file.parent().unwrap().exists());
        assert!(other.exists());
    }

    #[test]
    fn el_bloque_se_agrega_y_se_quita_tal_cual() {
        for existing in ["", "una línea", "una línea\n", "# Título\n\ntexto\n\n", "\n"] {
            let block = format!("{START} -->\nhola\n{END}");
            let added = with_block(existing, &block).unwrap();
            assert!(added.starts_with(existing.trim_end()), "{existing:?}");
            assert_eq!(find_block(&added).unwrap().map(|(a, b)| added[a..b].trim_end().to_string()), Some(block.clone()));
            let back = without_block(&added).unwrap().unwrap();
            assert_eq!(back.trim_end(), existing.trim_end(), "{existing:?}");
        }
    }
}
