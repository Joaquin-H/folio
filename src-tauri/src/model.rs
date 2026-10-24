use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetSummary {
    pub id: i64,
    pub source: String,
    pub title: String,
    pub path: Option<String>,
    pub preview: String,
    pub length: i64,
    pub size: i64,
    pub modified_at: i64,
    pub category_id: Option<i64>,
    pub category_source: Option<String>,
    pub category_confidence: Option<f64>,
    pub note_score: Option<f64>,
    pub secret: bool,
    pub secret_source: Option<String>,
    pub hidden: bool,
    pub missing: bool,
    pub version_count: i64,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: i64,
    pub saved_at: i64,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetDetail {
    #[serde(flatten)]
    pub summary: SheetSummary,
    pub content: String,
    /// Huella del contenido: quien edita la hoja la devuelve al guardar, para detectar
    /// si el original cambió mientras tanto.
    pub hash: String,
    pub versions: Vec<Version>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilter {
    /// "all" | "today" | "uncategorized" | "secret" | "hidden" | "category"
    pub view: String,
    pub category_id: Option<i64>,
    pub query: Option<String>,
    /// Cursor de paginación: la última hoja ya cargada.
    pub before_ts: Option<i64>,
    pub before_id: Option<i64>,
    pub before_pinned: Option<bool>,
    /// "Ir a fecha": solo hojas modificadas hasta este instante (ms).
    pub until: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub color: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub all: i64,
    pub today: i64,
    pub uncategorized: i64,
    pub secret: i64,
    pub hidden: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub running: bool,
    pub last_scan_at: Option<i64>,
    pub last_scan_ms: Option<i64>,
    pub last_scan_files: Option<i64>,
}

/// Cómo está una IA: si tiene clave y qué modelo se usa con ella.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    /// «jev», «claude», «openai», «gemini» u «ollama».
    pub id: String,
    pub has_key: bool,
    pub key_from_env: bool,
    /// El que usa con esa IA: el que eligió el usuario o, si no, el de fábrica. Vacío en Jev
    /// (tiene uno solo) y en Ollama mientras no se elija.
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevStatus {
    pub enabled: bool,
    /// Si la IA activa tiene clave. En Ollama, que no usa, es siempre `false`: ahí vale `ready`.
    pub has_key: bool,
    pub key_from_env: bool,
    /// Si con lo que hay se puede consultar a la IA activa: tiene clave o, en Ollama, modelo.
    pub ready: bool,
    /// La IA activa: «jev», «claude», «openai», «gemini» u «ollama».
    pub provider: String,
    /// Todas las IAs, cada una con su clave y su modelo.
    pub providers: Vec<ProviderStatus>,
    /// Dónde escucha Ollama.
    pub ollama_url: String,
    /// Hojas que faltan clasificar: las listas y las que esperan a quedar quietas.
    pub pending: i64,
    pub error: Option<String>,
    /// Consultas hechas a la IA hoy (fecha local) y desde siempre.
    pub calls_today: i64,
    pub calls_total: i64,
}

/// Qué eligió la IA al «Probar» con una hoja de ejemplo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifierTest {
    /// La categoría elegida; `None` si eligió «otro».
    pub category: Option<String>,
    pub confidence: f64,
    pub note_score: Option<f64>,
    /// Cuánto tardó la consulta, en milisegundos.
    pub took_ms: i64,
    /// La hoja de ejemplo que se envió.
    pub sample: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub counts: Counts,
    pub categories: Vec<Category>,
    pub scan: ScanStatus,
    pub jev: JevStatus,
    /// Carpeta donde Book guarda, como archivos de texto, las hojas que se escriben en él.
    pub notes_dir: String,
    pub clippings_category_id: Option<i64>,
    pub untagged_clippings_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub id: i64,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ban {
    pub id: i64,
    /// "dir" (nombre de carpeta), "file" (patrón de nombre de archivo) o "path" (carpeta concreta).
    pub kind: String,
    pub pattern: String,
    pub enabled: bool,
    pub builtin: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretState {
    Ready,
    Locked,
    Empty,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub roots: Vec<Root>,
    pub bans: Vec<Ban>,
    pub versions_keep: i64,
    pub session_gap_min: i64,
    pub ignore_git_repos: bool,
    pub ignore_dot_dirs: bool,
    pub max_file_kb: i64,
    pub jev_threshold: f64,
    /// Cada cuántos días se vuelve a consultar por una hoja ya clasificada cuyo texto
    /// cambió; 0 = nunca.
    pub jev_recheck_days: i64,
    pub jev: JevStatus,
    /// Book se inicia junto con el sistema, directo en la bandeja.
    pub autostart: bool,
    /// Dónde vive la base de datos de Book.
    pub data_path: String,
    /// Estado del cifrado del secret-book en esta PC.
    pub secret_state: SecretState,
    pub secret_locked_count: i64,
    /// Atajo global para anotar desde cualquier programa, como se muestra («Ctrl + Alt + N»);
    /// `None` si no se pudo registrar (por ejemplo, porque otra aplicación ya lo usa).
    pub capture_shortcut: Option<String>,
    /// Atajo global para traer el cuaderno al frente; `None` si no se pudo registrar.
    pub open_shortcut: Option<String>,
    /// Atajo global para enviar al Book lo seleccionado en cualquier programa; `None` si no
    /// se pudo registrar.
    pub send_shortcut: Option<String>,
    /// Las combinaciones elegidas para esos tres atajos («Ctrl+Alt+N»), se hayan podido
    /// registrar o no.
    pub capture_keys: String,
    pub open_keys: String,
    pub send_keys: String,
    /// A dónde va lo que se envía con ese atajo: «day», «week», «month», «all» o «sheet».
    pub send_to: String,
    /// Guarda el encabezado con la hora y el programa de origen en los recortes.
    pub send_origin: bool,
    /// Formato de notas nuevas («txt» o «md»).
    pub note_format: String,
    /// Versión de Folio.
    pub version: String,
}

/// El texto con el que nace la hoja suelta cuando se la abre desde «Enviar lo seleccionado
/// al Book»: lo seleccionado y su origen (el encabezado «— 14:32 · Chrome · «Título»»).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSeed {
    pub text: String,
    pub origin: String,
}

/// Una categoría que Book propone a partir de lo que dicen las notas. No se guarda: el
/// usuario elige cuáles aceptar.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySuggestion {
    /// Nombre propuesto (la palabra que mejor representa al grupo).
    pub name: String,
    /// Las palabras que más lo caracterizan: sirven de descripción para el clasificador.
    pub keywords: Vec<String>,
    /// Cuántas hojas caen en el grupo.
    pub count: usize,
    /// Títulos de algunas hojas del grupo, de ejemplo.
    pub samples: Vec<String>,
}

/// Hoja cuyo original (archivo o pestaña) ya no existe.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingSheet {
    pub id: i64,
    pub title: String,
    pub source: String,
    pub path: Option<String>,
    /// Última vez que el original se guardó.
    pub modified_at: i64,
    /// Cuándo Book notó que ya no estaba; `None` si fue antes de registrar este dato.
    pub missing_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStat {
    pub folder: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    pub day: String,
    pub count: i64,
}

/// Estado persistido de una hoja arrancada del cuaderno para restaurarla al reabrir Folio.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TornOffSheetState {
    pub id: i64,
    pub collapsed: bool,
    pub pinned: bool,
    pub expanded_x: Option<f64>,
    pub expanded_y: Option<f64>,
    pub collapsed_x: Option<f64>,
    pub collapsed_y: Option<f64>,
}

/// Posición y tamaño lógicos de una ventana flotante (hoja suelta o arrancada).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub collapsed: bool,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Lo que la interfaz lee del clasificador (`JevStatus` y `ClassifierTest` en `src/types.ts`):
    /// los nombres de los campos son el contrato, y `src/mock.ts` los repite.
    #[test]
    fn el_estado_del_clasificador_llega_a_la_interfaz_con_los_nombres_del_contrato() {
        let status = JevStatus {
            enabled: true,
            has_key: true,
            key_from_env: false,
            ready: true,
            provider: "claude".into(),
            providers: vec![
                ProviderStatus { id: "claude".into(), has_key: true, key_from_env: false, model: "claude-haiku-5-5".into() },
                ProviderStatus { id: "ollama".into(), has_key: false, key_from_env: false, model: String::new() },
            ],
            ollama_url: "http://localhost:11434".into(),
            pending: 3,
            error: None,
            calls_today: 2,
            calls_total: 9,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({
                "enabled": true,
                "hasKey": true,
                "keyFromEnv": false,
                "ready": true,
                "provider": "claude",
                "providers": [
                    {"id": "claude", "hasKey": true, "keyFromEnv": false, "model": "claude-haiku-5-5"},
                    {"id": "ollama", "hasKey": false, "keyFromEnv": false, "model": ""},
                ],
                "ollamaUrl": "http://localhost:11434",
                "pending": 3,
                "error": null,
                "callsToday": 2,
                "callsTotal": 9,
            })
        );
        let test = ClassifierTest { category: None, confidence: 0.42, note_score: Some(0.9), took_ms: 640, sample: "Lista".into() };
        assert_eq!(
            serde_json::to_value(&test).unwrap(),
            json!({"category": null, "confidence": 0.42, "noteScore": 0.9, "tookMs": 640, "sample": "Lista"})
        );
    }

    #[test]
    fn el_estado_del_secret_book_llega_a_la_interfaz_con_los_nombres_del_contrato() {
        assert_eq!(serde_json::to_value(SecretState::Ready).unwrap(), json!("ready"));
        assert_eq!(serde_json::to_value(SecretState::Locked).unwrap(), json!("locked"));
        assert_eq!(serde_json::to_value(SecretState::Empty).unwrap(), json!("empty"));
    }
}
