//! Qué IA clasifica las hojas. Jev elige entre las categorías que le pasamos; Claude,
//! OpenAI, Gemini y Ollama son modelos de lenguaje a los que se les pide la categoría como
//! JSON (`llm.rs`). Este módulo es lo único que sabe a cuál se consulta: la clave de cada
//! una en el llavero del sistema, el modelo y la dirección que eligió el usuario, y el
//! reparto de la consulta. *Cuándo* consultar sigue siendo cosa de `classifier.rs`, que
//! trata igual a todas.

use std::time::Instant;

use serde_json::Value;

use crate::crypto::KEYRING_SERVICE;
use crate::db::{now_ms, CategoryDef, Db};
use crate::model::ClassifierTest;
use crate::{jev, llm, wire};

/// Ajustes (en la tabla `settings`): la IA activa, el modelo de cada una y la dirección de
/// Ollama. Las demás cosas del clasificador conservan sus nombres `jev_*`.
const SETTING_PROVIDER: &str = "ai_provider";
const SETTING_OLLAMA_URL: &str = "ai_ollama_url";
pub const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
/// El nombre de un modelo, como mucho.
const MAX_MODEL_CHARS: usize = 120;

/// Una hoja de ejemplo para «Probar»: no es de nadie, así que nada propio sale de la PC.
const SAMPLE_TITLE: &str = "Lista del súper";
const SAMPLE_TEXT: &str = "yerba, café, tomates, queso rallado, papel de cocina y detergente. Pasar por la farmacia.";

/// Lo que eligió la IA, tal cual: si alcanza o no la confianza mínima se decide después,
/// para poder cambiar ese umbral sin volver a consultar.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    /// `None` cuando eligió «otro».
    pub category_id: Option<i64>,
    pub confidence: f64,
    /// Probabilidad de que el texto sea una nota escrita por una persona.
    pub note_score: Option<f64>,
}

#[derive(Debug)]
pub enum AiError {
    /// La configuración no sirve (clave rechazada, sin crédito, un modelo que no existe, una
    /// dirección inválida): no tiene sentido seguir intentando.
    Auth(String),
    /// Límite de tasa, servicio saturado o respuesta cortada: se reintenta más tarde.
    /// Si la IA indicó cuánto esperar, va en milisegundos.
    Busy(String, Option<i64>),
    /// No se llegó a enviar nada (sin red): también se reintenta más tarde, y no cuenta
    /// como consulta hecha.
    Offline(String),
    /// La IA rechazó esta consulta en particular o respondió algo que no se entiende.
    Other(String),
}

impl AiError {
    pub fn message(&self) -> &str {
        match self {
            AiError::Auth(message) | AiError::Busy(message, _) | AiError::Offline(message) | AiError::Other(message) => message,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Jev,
    Claude,
    OpenAi,
    Gemini,
    Ollama,
}

impl Provider {
    pub const ALL: [Provider; 5] = [Provider::Jev, Provider::Claude, Provider::OpenAi, Provider::Gemini, Provider::Ollama];

    /// Como se llama en la interfaz y en los ajustes guardados.
    pub fn id(self) -> &'static str {
        match self {
            Provider::Jev => "jev",
            Provider::Claude => "claude",
            Provider::OpenAi => "openai",
            Provider::Gemini => "gemini",
            Provider::Ollama => "ollama",
        }
    }

    pub fn from_id(id: &str) -> Option<Provider> {
        Provider::ALL.into_iter().find(|provider| provider.id() == id)
    }

    pub fn label(self) -> &'static str {
        match self {
            Provider::Jev => "Jev",
            Provider::Claude => "Claude",
            Provider::OpenAi => "OpenAI",
            Provider::Gemini => "Gemini",
            Provider::Ollama => "Ollama",
        }
    }

    /// Ollama corre en la PC: no pide clave.
    pub fn needs_key(self) -> bool {
        self != Provider::Ollama
    }

    /// El modelo que se usa si el usuario no eligió otro: el más barato y rápido de cada
    /// uno, que alcanza de sobra para elegir una categoría. Jev tiene uno solo, y de Ollama
    /// no se sabe cuál tiene instalado cada quien.
    pub fn default_model(self) -> &'static str {
        match self {
            Provider::Claude => "claude-haiku-5-5",
            Provider::OpenAi => "gpt-6-luna",
            Provider::Gemini => "gemini-3.5-flash-lite",
            Provider::Jev | Provider::Ollama => "",
        }
    }

    /// Con qué nombre se guarda su clave en el llavero. La de Jev conserva el de siempre.
    fn keyring_user(self) -> &'static str {
        match self {
            Provider::Jev => "typesafe_api_key",
            Provider::Claude => "anthropic_api_key",
            Provider::OpenAi => "openai_api_key",
            Provider::Gemini => "gemini_api_key",
            Provider::Ollama => "",
        }
    }

    fn env_var(self) -> Option<&'static str> {
        match self {
            Provider::Jev => Some("TYPESAFE_API_KEY"),
            Provider::Claude => Some("ANTHROPIC_API_KEY"),
            Provider::OpenAi => Some("OPENAI_API_KEY"),
            Provider::Gemini => Some("GEMINI_API_KEY"),
            Provider::Ollama => None,
        }
    }
}

// ---- claves --------------------------------------------------------------------------------

fn entry(provider: Provider) -> Option<keyring::Entry> {
    provider.needs_key().then(|| keyring::Entry::new(KEYRING_SERVICE, provider.keyring_user()).ok()).flatten()
}

pub fn key_from_env(provider: Provider) -> Option<String> {
    std::env::var(provider.env_var()?).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

/// La variable de entorno tiene prioridad; si no, el llavero del sistema operativo.
pub fn load_key(provider: Provider) -> Option<String> {
    key_from_env(provider).or_else(|| entry(provider)?.get_password().ok().filter(|k| !k.is_empty()))
}

pub fn save_key(provider: Provider, key: &str) -> Result<(), String> {
    entry(provider)
        .ok_or_else(|| format!("{} no usa clave", provider.label()))?
        .set_password(key.trim())
        .map_err(|e| e.to_string())
}

pub fn clear_key(provider: Provider) -> Result<(), String> {
    let entry = entry(provider).ok_or_else(|| format!("{} no usa clave", provider.label()))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- ajustes -------------------------------------------------------------------------------

/// La IA elegida. Jev, mientras no se elija otra.
pub fn active(db: &Db) -> Provider {
    db.get_setting(SETTING_PROVIDER).and_then(|id| Provider::from_id(&id)).unwrap_or(Provider::Jev)
}

pub fn set_active(db: &Db, provider: Provider) -> Result<(), String> {
    db.set_setting(SETTING_PROVIDER, provider.id()).map_err(|e| e.to_string())
}

fn model_setting(provider: Provider) -> String {
    format!("ai_model_{}", provider.id())
}

/// El modelo que se usa con esa IA: el que eligió el usuario o, si no eligió, el de fábrica.
pub fn model(db: &Db, provider: Provider) -> String {
    db.get_setting(&model_setting(provider))
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| provider.default_model().to_string())
}

/// Guarda el modelo de esa IA; vacío vuelve al de fábrica. Devuelve el que queda.
pub fn set_model(db: &Db, provider: Provider, model: &str) -> Result<String, String> {
    if provider == Provider::Jev {
        return Err("Jev tiene un solo modelo: no hay nada que elegir".to_string());
    }
    let model = model.trim();
    if model.chars().count() > MAX_MODEL_CHARS || model.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("El nombre del modelo no puede tener espacios".to_string());
    }
    db.set_setting(&model_setting(provider), model).map_err(|e| e.to_string())?;
    Ok(self::model(db, provider))
}

pub fn ollama_url(db: &Db) -> String {
    db.get_setting(SETTING_OLLAMA_URL)
        .and_then(|url| normalize_ollama_url(&url).ok())
        .unwrap_or_else(|| DEFAULT_OLLAMA_URL.to_string())
}

/// Guarda la dirección de Ollama; vacía vuelve a la de siempre. Devuelve la que queda.
pub fn set_ollama_url(db: &Db, input: &str) -> Result<String, String> {
    let url = normalize_ollama_url(input)?;
    db.set_setting(SETTING_OLLAMA_URL, &url).map_err(|e| e.to_string())?;
    Ok(url)
}

/// La dirección de Ollama como se usa: con `http://` si falta, sin barra al final y sin
/// el camino de la API si se pegó entero. Vacía es la de siempre (esta PC).
pub fn normalize_ollama_url(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(DEFAULT_OLLAMA_URL.to_string());
    }
    if input.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("La dirección no puede tener espacios".to_string());
    }
    let full = if input.contains("://") { input.to_string() } else { format!("http://{input}") };
    let rest = full
        .strip_prefix("http://")
        .or_else(|| full.strip_prefix("https://"))
        .ok_or_else(|| "La dirección tiene que empezar con http:// o https://".to_string())?;
    let host = rest.split('/').next().unwrap_or_default();
    if host.is_empty() || host.starts_with(':') {
        return Err("Falta el nombre de la máquina en la dirección".to_string());
    }
    let mut url = full.trim_end_matches('/');
    for api in ["/api/chat", "/api"] {
        url = url.strip_suffix(api).unwrap_or(url);
    }
    Ok(url.trim_end_matches('/').to_string())
}

// ---- la IA con todo lo que hace falta para consultarla -----------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Engine {
    pub provider: Provider,
    /// Vacío en Jev y en Ollama sin elegir.
    pub model: String,
    /// Solo la usa Ollama.
    pub url: String,
}

impl Engine {
    pub fn from_db(db: &Db) -> Engine {
        let provider = active(db);
        Engine { provider, model: model(db, provider), url: ollama_url(db) }
    }

    /// Qué IA y qué modelo contestan, para la firma del caché de veredictos: lo que contestó
    /// una no se reutiliza con otra. Vacío en Jev, así su firma sigue siendo la de siempre.
    pub fn tag(&self) -> String {
        match self.provider {
            Provider::Jev => String::new(),
            provider => format!("{}\u{1f}{}\u{1f}{}", provider.id(), self.model, llm::PROMPT_VERSION),
        }
    }

    /// Si con lo que hay se puede consultar: la clave, o el modelo en el caso de Ollama.
    pub fn is_ready(&self, has_key: bool) -> bool {
        if self.provider.needs_key() {
            has_key
        } else {
            !self.model.is_empty()
        }
    }
}

/// Con qué se consulta, buscado recién cuando hay algo para consultar: la clave (de la
/// variable de entorno o del llavero), o nada en Ollama. `None` si todavía falta algo.
pub fn credential(engine: &Engine) -> Option<String> {
    match engine.provider {
        Provider::Ollama => engine.is_ready(false).then(String::new),
        provider => load_key(provider),
    }
}

/// El pedido para clasificar una hoja con esa IA. Sin red: se puede revisar tal cual.
pub fn build_request(
    engine: &Engine,
    key: &str,
    title: &str,
    content: &str,
    categories: &[CategoryDef],
) -> Result<wire::Request, AiError> {
    let prompt = |max_chars| llm::prompt(title, content, categories, max_chars);
    match engine.provider {
        Provider::Jev => Ok(jev::build_request(key, title, content, categories)),
        Provider::Claude => Ok(llm::claude_request(key, &engine.model, &prompt(llm::MAX_TEXT_CHARS))),
        Provider::OpenAi => Ok(llm::openai_request(key, &engine.model, &prompt(llm::MAX_TEXT_CHARS))),
        Provider::Gemini => llm::gemini_request(key, &engine.model, &prompt(llm::MAX_TEXT_CHARS)),
        Provider::Ollama => llm::ollama_request(&engine.url, &engine.model, &prompt(llm::MAX_TEXT_CHARS_LOCAL)),
    }
}

/// Lo que eligió la IA, de lo que contestó su API. Sin red.
pub fn read_answer(provider: Provider, answer: &Value, categories: &[CategoryDef]) -> Result<Verdict, AiError> {
    match provider {
        Provider::Jev => jev::parse_answer(answer, categories),
        provider => llm::parse_verdict(provider, &llm::answer_text(provider, answer)?, categories),
    }
}

/// Le pregunta a la IA elegida por una hoja.
pub fn classify(
    engine: &Engine,
    key: &str,
    title: &str,
    content: &str,
    categories: &[CategoryDef],
) -> Result<Verdict, AiError> {
    let request = build_request(engine, key, title, content, categories)?;
    let answer = wire::send(engine.provider, &request)?;
    read_answer(engine.provider, &answer, categories)
}

/// «Probar»: clasifica una hoja de ejemplo con las categorías de ahora y dice qué eligió la IA.
/// Cuenta como una consulta, como cualquier otra que salga.
pub fn probe(db: &Db) -> Result<ClassifierTest, String> {
    let engine = Engine::from_db(db);
    let categories = db.category_defs().map_err(|e| e.to_string())?;
    if categories.is_empty() {
        return Err("Creá al menos una categoría para poder probar.".to_string());
    }
    let key = credential(&engine).ok_or_else(|| match engine.provider {
        Provider::Ollama => "Falta elegir el modelo de Ollama.".to_string(),
        provider => format!("Falta la clave de {}.", provider.label()),
    })?;
    let started = Instant::now();
    let result = classify(&engine, &key, SAMPLE_TITLE, SAMPLE_TEXT, &categories);
    if !matches!(result, Err(AiError::Offline(_))) {
        let _ = db.count_jev_call(now_ms());
    }
    let verdict = result.map_err(|error| error.message().to_string())?;
    Ok(ClassifierTest {
        category: verdict
            .category_id
            .and_then(|id| categories.iter().find(|(candidate, _, _)| *candidate == id))
            .map(|(_, name, _)| name.clone()),
        confidence: verdict.confidence,
        note_score: verdict.note_score,
        took_ms: started.elapsed().as_millis() as i64,
        sample: format!("{SAMPLE_TITLE}\n\n{SAMPLE_TEXT}"),
    })
}

/// Sugiere categorías iniciales para el cuaderno usando una IA generativa (Claude, OpenAI, Gemini u Ollama).
pub fn suggest_categories_ai(db: &Db) -> Result<Vec<crate::model::CategorySuggestion>, String> {
    let engine = Engine::from_db(db);
    if engine.provider == Provider::Jev {
        return Err("Elegí Claude, OpenAI, Gemini u Ollama para sugerir categorías con una IA.".to_string());
    }
    let key = credential(&engine).ok_or_else(|| match engine.provider {
        Provider::Ollama => "Falta elegir el modelo de Ollama.".to_string(),
        provider => format!("Falta la clave de {}.", provider.label()),
    })?;
    let clusters = crate::suggest::from_db(db)?;
    let corpus = db.suggestion_corpus(400).map_err(|e| e.to_string())?;
    if corpus.len() < 3 {
        return Err("Todavía no hay suficientes notas para proponer categorías.".to_string());
    }
    let titles: Vec<String> = corpus
        .into_iter()
        .map(|(title, _)| title)
        .filter(|t| !t.trim().is_empty())
        .take(40)
        .collect();
    let existing: Vec<String> = db
        .categories()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|c| c.name)
        .collect();
    let is_en = db.get_setting("locale").as_deref() == Some("en");
    let prompt = llm::suggest_categories_prompt(&clusters, &titles, &existing, is_en);
    let request = match engine.provider {
        Provider::Claude => llm::claude_request(&key, &engine.model, &prompt),
        Provider::OpenAi => llm::openai_request(&key, &engine.model, &prompt),
        Provider::Gemini => llm::gemini_request(&key, &engine.model, &prompt).map_err(|e| e.message().to_string())?,
        Provider::Ollama => llm::ollama_request(&engine.url, &engine.model, &prompt).map_err(|e| e.message().to_string())?,
        Provider::Jev => return Err("Elegí Claude, OpenAI, Gemini u Ollama para sugerir categorías con una IA.".to_string()),
    };
    let response = wire::send(engine.provider, &request);
    if !matches!(response, Err(AiError::Offline(_))) {
        let _ = db.count_jev_call(now_ms());
    }
    let answer = response.map_err(|e| e.message().to_string())?;
    let text = llm::answer_text(engine.provider, &answer).map_err(|e| e.message().to_string())?;
    llm::parse_suggested_categories(engine.provider, &text, &existing).map_err(|e| e.message().to_string())
}


#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn db() -> Db {
        Db::open(Path::new(":memory:")).expect("base en memoria")
    }

    fn categories() -> Vec<CategoryDef> {
        vec![(1, "Trabajo".into(), "Reuniones".into()), (4, "Casa".into(), "Hogar".into())]
    }

    #[test]
    fn cada_ia_tiene_su_nombre_y_se_reconoce_por_el() {
        for provider in Provider::ALL {
            assert_eq!(Provider::from_id(provider.id()), Some(provider));
        }
        assert_eq!(Provider::from_id("chatgpt"), None);
        assert_eq!(Provider::from_id(""), None);
        let labels: Vec<_> = Provider::ALL.iter().map(|p| p.label()).collect();
        assert_eq!(labels, ["Jev", "Claude", "OpenAI", "Gemini", "Ollama"]);
        assert!(Provider::ALL.iter().filter(|p| !p.needs_key()).eq([&Provider::Ollama]));
    }

    #[test]
    fn los_modelos_de_fabrica() {
        assert_eq!(Provider::Claude.default_model(), "claude-haiku-5-5");
        assert_eq!(Provider::OpenAi.default_model(), "gpt-6-luna");
        assert_eq!(Provider::Gemini.default_model(), "gemini-3.5-flash-lite");
        assert_eq!(Provider::Jev.default_model(), "");
        assert_eq!(Provider::Ollama.default_model(), "");
    }

    #[test]
    fn las_claves_tienen_su_variable_y_la_de_jev_sigue_igual() {
        assert_eq!(Provider::Jev.env_var(), Some("TYPESAFE_API_KEY"));
        assert_eq!(Provider::Claude.env_var(), Some("ANTHROPIC_API_KEY"));
        assert_eq!(Provider::OpenAi.env_var(), Some("OPENAI_API_KEY"));
        assert_eq!(Provider::Gemini.env_var(), Some("GEMINI_API_KEY"));
        assert_eq!(Provider::Ollama.env_var(), None);
        // La clave que el usuario ya guardó para Jev se sigue encontrando donde estaba.
        assert_eq!((KEYRING_SERVICE, Provider::Jev.keyring_user()), ("com.j-playground.folio", "typesafe_api_key"));
        let mut users: Vec<_> = [Provider::Jev, Provider::Claude, Provider::OpenAi, Provider::Gemini].iter().map(|p| p.keyring_user()).collect();
        users.sort_unstable();
        users.dedup();
        assert_eq!(users.len(), 4);
    }

    #[test]
    fn de_fabrica_se_consulta_a_jev_y_la_eleccion_se_recuerda() {
        let db = db();
        assert_eq!(active(&db), Provider::Jev);
        set_active(&db, Provider::Claude).unwrap();
        assert_eq!(active(&db), Provider::Claude);
        // Un valor guardado que no es ninguna IA (editado a mano, de otra versión) vuelve a Jev.
        db.set_setting("ai_provider", "gpt").unwrap();
        assert_eq!(active(&db), Provider::Jev);
    }

    #[test]
    fn cada_ia_recuerda_su_modelo() {
        let db = db();
        assert_eq!(model(&db, Provider::Claude), "claude-haiku-5-5");
        assert_eq!(set_model(&db, Provider::Claude, "  claude-sonnet-5-5 ").unwrap(), "claude-sonnet-5-5");
        assert_eq!(set_model(&db, Provider::Ollama, "llama3.2:3b").unwrap(), "llama3.2:3b");
        assert_eq!(model(&db, Provider::Claude), "claude-sonnet-5-5");
        assert_eq!(model(&db, Provider::Ollama), "llama3.2:3b");
        // Las demás no se enteran.
        assert_eq!(model(&db, Provider::OpenAi), "gpt-6-luna");
        assert_eq!(model(&db, Provider::Gemini), "gemini-3.5-flash-lite");
        // Vacío vuelve al de fábrica.
        assert_eq!(set_model(&db, Provider::Claude, "").unwrap(), "claude-haiku-5-5");
        assert_eq!(set_model(&db, Provider::Ollama, "  ").unwrap(), "");
        // Lo que no es un nombre de modelo, no se guarda.
        assert!(set_model(&db, Provider::OpenAi, "gpt 6").is_err());
        assert!(set_model(&db, Provider::OpenAi, &"x".repeat(200)).is_err());
        assert!(set_model(&db, Provider::Jev, "otro").is_err());
        assert_eq!(model(&db, Provider::OpenAi), "gpt-6-luna");
    }

    #[test]
    fn la_direccion_de_ollama_se_acomoda() {
        let url = |input: &str| normalize_ollama_url(input);
        assert_eq!(url("").unwrap(), "http://localhost:11434");
        assert_eq!(url("  http://localhost:11434/ ").unwrap(), "http://localhost:11434");
        assert_eq!(url("localhost:11434").unwrap(), "http://localhost:11434");
        assert_eq!(url("192.168.1.20:11434").unwrap(), "http://192.168.1.20:11434");
        assert_eq!(url("https://ollama.mi-red.local").unwrap(), "https://ollama.mi-red.local");
        // Si se pegó el camino de la API entero, se deja la base.
        assert_eq!(url("http://localhost:11434/api/chat").unwrap(), "http://localhost:11434");
        assert_eq!(url("http://localhost:11434/api/").unwrap(), "http://localhost:11434");
        assert_eq!(url("http://localhost:8080/ollama").unwrap(), "http://localhost:8080/ollama");
        for bad in ["ftp://localhost", "http://", "http:///api", "http://:11434", "http://local host", "file:///c:/x"] {
            assert!(url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn la_direccion_de_ollama_se_guarda() {
        let db = db();
        assert_eq!(ollama_url(&db), "http://localhost:11434");
        assert_eq!(set_ollama_url(&db, "mi-pc:11434/").unwrap(), "http://mi-pc:11434");
        assert_eq!(ollama_url(&db), "http://mi-pc:11434");
        assert!(set_ollama_url(&db, "ftp://x").is_err());
        assert_eq!(ollama_url(&db), "http://mi-pc:11434");
        assert_eq!(set_ollama_url(&db, "").unwrap(), "http://localhost:11434");
        assert_eq!(ollama_url(&db), "http://localhost:11434");
    }

    fn engine(provider: Provider, model: &str) -> Engine {
        Engine { provider, model: model.to_string(), url: DEFAULT_OLLAMA_URL.to_string() }
    }

    #[test]
    fn el_motor_sale_de_los_ajustes() {
        let db = db();
        assert_eq!(Engine::from_db(&db), engine(Provider::Jev, ""));
        set_active(&db, Provider::Gemini).unwrap();
        set_model(&db, Provider::Gemini, "gemini-3.1-flash-lite").unwrap();
        assert_eq!(Engine::from_db(&db), engine(Provider::Gemini, "gemini-3.1-flash-lite"));
    }

    #[test]
    fn la_etiqueta_del_cache_cambia_con_la_ia_y_el_modelo() {
        // Jev: vacía, para que su firma siga siendo la de siempre.
        assert_eq!(engine(Provider::Jev, "").tag(), "");
        let claude = engine(Provider::Claude, "claude-haiku-5-5").tag();
        assert_ne!(claude, "");
        assert_ne!(claude, engine(Provider::Claude, "claude-sonnet-5-5").tag());
        assert_ne!(claude, engine(Provider::OpenAi, "claude-haiku-5-5").tag());
        assert_ne!(engine(Provider::Ollama, "llama3.2").tag(), engine(Provider::Ollama, "llama3.2:3b").tag());
        // Lo mismo, lo mismo (la dirección de Ollama no cambia lo que contesta el modelo).
        let elsewhere = Engine { url: "http://otra-pc:11434".into(), ..engine(Provider::Ollama, "llama3.2") };
        assert_eq!(elsewhere.tag(), engine(Provider::Ollama, "llama3.2").tag());
    }

    #[test]
    fn se_puede_consultar_cuando_hay_clave_o_modelo_de_ollama() {
        assert!(!engine(Provider::Jev, "").is_ready(false));
        assert!(engine(Provider::Jev, "").is_ready(true));
        assert!(engine(Provider::Claude, "claude-haiku-5-5").is_ready(true));
        assert!(!engine(Provider::Ollama, "").is_ready(true));
        assert!(engine(Provider::Ollama, "llama3.2").is_ready(false));
        // Ollama no toca el llavero: sin modelo no hay con qué consultar, con modelo sí.
        assert_eq!(credential(&engine(Provider::Ollama, "")), None);
        assert_eq!(credential(&engine(Provider::Ollama, "llama3.2")), Some(String::new()));
    }

    #[test]
    fn cada_ia_manda_el_pedido_a_su_lugar() {
        let url = |provider: Provider, model: &str| {
            build_request(&engine(provider, model), "clave", "Súper", "yerba", &categories()).map(|request| request.url)
        };
        assert_eq!(url(Provider::Jev, "").unwrap(), "https://api.typesafe.ai/v1/systemone");
        assert_eq!(url(Provider::Claude, "claude-haiku-5-5").unwrap(), "https://api.anthropic.com/v1/messages");
        assert_eq!(url(Provider::OpenAi, "gpt-6-luna").unwrap(), "https://api.openai.com/v1/responses");
        assert_eq!(
            url(Provider::Gemini, "gemini-3.5-flash-lite").unwrap(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"
        );
        assert_eq!(url(Provider::Ollama, "llama3.2").unwrap(), "http://localhost:11434/api/chat");
        // Ollama sin modelo, o con una dirección rota, no manda nada: avisa que falta configurar.
        assert!(matches!(url(Provider::Ollama, ""), Err(AiError::Auth(_))));
        let broken = Engine { url: "ftp://x".into(), ..engine(Provider::Ollama, "llama3.2") };
        assert!(matches!(build_request(&broken, "", "t", "c", &categories()), Err(AiError::Auth(_))));
    }

    #[test]
    fn el_texto_de_la_hoja_solo_va_a_donde_corresponde() {
        // Lo que se manda a las IAs de la nube es la hoja, y a Ollama, a la dirección elegida.
        for provider in [Provider::Claude, Provider::OpenAi, Provider::Gemini] {
            let request = build_request(&engine(provider, provider.default_model()), "k", "Título", "texto único de la hoja", &categories()).unwrap();
            assert!(request.body.to_string().contains("texto único de la hoja"), "{provider:?}");
            assert!(!request.url.starts_with("http://"), "{provider:?} tiene que ir cifrado");
        }
        let local = Engine { url: "http://192.168.1.20:11434".into(), ..engine(Provider::Ollama, "llama3.2") };
        assert_eq!(build_request(&local, "", "t", "c", &categories()).unwrap().url, "http://192.168.1.20:11434/api/chat");
    }

    #[test]
    fn probar_cuenta_como_una_consulta_y_avisa_lo_que_falta() {
        let db = db();
        db.set_setting("ai_provider", "ollama").unwrap();
        // Sin modelo, ni siquiera sale: no cuenta.
        assert_eq!(probe(&db).unwrap_err(), "Falta elegir el modelo de Ollama.");
        assert_eq!(db.jev_calls(now_ms()), (0, 0));
        // Con el modelo pero sin nadie escuchando en esa dirección: tampoco, no se envió nada.
        set_model(&db, Provider::Ollama, "llama3.2").unwrap();
        let free_port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        set_ollama_url(&db, &format!("127.0.0.1:{free_port}")).unwrap();
        let error = probe(&db).unwrap_err();
        assert!(error.starts_with("No se pudo conectar con Ollama"), "{error}");
        assert_eq!(db.jev_calls(now_ms()), (0, 0));
    }

    #[test]
    fn sugerir_con_ia_avisa_si_falta_configurar_o_si_no_hay_notas() {
        let db = db();
        // Por defecto está Jev: no es generativa.
        assert_eq!(
            suggest_categories_ai(&db).unwrap_err(),
            "Elegí Claude, OpenAI, Gemini u Ollama para sugerir categorías con una IA."
        );

        // Con Ollama sin modelo:
        db.set_setting("ai_provider", "ollama").unwrap();
        assert_eq!(suggest_categories_ai(&db).unwrap_err(), "Falta elegir el modelo de Ollama.");

        // Con Ollama configurado pero menos de 3 notas:
        set_model(&db, Provider::Ollama, "llama3.2").unwrap();
        assert_eq!(
            suggest_categories_ai(&db).unwrap_err(),
            "Todavía no hay suficientes notas para proponer categorías."
        );
    }
}

