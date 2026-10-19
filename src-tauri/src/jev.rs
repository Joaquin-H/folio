//! Clasificador Jev (TypeSafe). Jev no genera texto: elige una opción de la lista de
//! categorías que le pasamos y devuelve su confianza. Docs: https://docs.typesafe.ai
//! El pedido se arma y la respuesta se lee acá; enviarlo es cosa de `wire.rs` y la clave
//! vive en `provider.rs`, como la de las demás IAs.

use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::db::CategoryDef;
use crate::provider::{AiError, Verdict};
use crate::wire::Request;

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const OTHER: &str = "otro";
/// Jev admite ~32k tokens de estado; se recorta con margen.
const MAX_STATE_CHARS: usize = 48_000;
/// Versión de lo que se le pregunta a Jev. Hay que subirla si cambian las preguntas o el
/// modelo: los veredictos guardados con la anterior dejan de reutilizarse.
pub const REQUEST_VERSION: &str = "1";

/// El pedido a Jev para clasificar una hoja.
pub fn build_request(key: &str, title: &str, content: &str, categories: &[CategoryDef]) -> Request {
    let mut criteria = Map::new();
    for (_, name, description) in categories {
        criteria.insert(name.clone(), Value::String(description.clone()));
    }
    criteria.insert(
        OTHER.to_string(),
        Value::String("Ninguna de las otras categorías describe esta nota".to_string()),
    );
    let state: String = format!("{title}\n\n{content}").chars().take(MAX_STATE_CHARS).collect();
    let body = json!({
        "state": state,
        "model": "jev-latest",
        "questions": {
            "categoria": {
                "type": "choice",
                "instructions": "Which category best describes the main topic of this personal note?",
                "criteria": criteria,
            },
            "es_nota": {
                "type": "noul",
                "instructions": "This text is a personal note, to-do list or reminder written by a person, not software documentation, a license, a log, configuration or generated output.",
            },
        },
    });
    Request {
        url: ENDPOINT.to_string(),
        headers: vec![("Authorization", format!("Bearer {key}"))],
        body,
        timeout: Duration::from_secs(30),
    }
}

/// Lo que eligió Jev, de su respuesta.
pub fn parse_answer(answer: &Value, categories: &[CategoryDef]) -> Result<Verdict, AiError> {
    let choice = &answer["answers"]["categoria"];
    let name = choice["choice"]
        .as_str()
        .ok_or_else(|| AiError::Other("La respuesta de Jev no trae una categoría.".to_string()))?;
    Ok(Verdict {
        category_id: categories.iter().find(|(_, n, _)| n == name).map(|(id, _, _)| *id),
        confidence: choice["confidence"].as_f64().unwrap_or(0.0),
        note_score: answer["answers"]["es_nota"]["noul"].as_f64(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn categories() -> Vec<CategoryDef> {
        vec![
            (1, "Trabajo".into(), "Tareas y reuniones".into()),
            (4, "Casa".into(), "Hogar y familia".into()),
        ]
    }

    #[test]
    fn el_pedido_a_jev_sigue_siendo_el_de_siempre() {
        let request = build_request("tsk-clave", "Súper", "yerba y café", &categories());
        assert_eq!(request.url, "https://api.typesafe.ai/v1/systemone");
        assert_eq!(request.headers, vec![("Authorization", "Bearer tsk-clave".to_string())]);
        assert_eq!(request.timeout, Duration::from_secs(30));
        assert_eq!(
            request.body,
            json!({
                "state": "Súper\n\nyerba y café",
                "model": "jev-latest",
                "questions": {
                    "categoria": {
                        "type": "choice",
                        "instructions": "Which category best describes the main topic of this personal note?",
                        "criteria": {
                            "Trabajo": "Tareas y reuniones",
                            "Casa": "Hogar y familia",
                            "otro": "Ninguna de las otras categorías describe esta nota",
                        },
                    },
                    "es_nota": {
                        "type": "noul",
                        "instructions": "This text is a personal note, to-do list or reminder written by a person, not software documentation, a license, a log, configuration or generated output.",
                    },
                },
            })
        );
    }

    #[test]
    fn el_estado_que_se_envia_se_recorta() {
        let long = "a".repeat(MAX_STATE_CHARS + 500);
        let request = build_request("k", "t", &long, &categories());
        assert_eq!(request.body["state"].as_str().unwrap().chars().count(), MAX_STATE_CHARS);
    }

    #[test]
    fn la_respuesta_de_jev_se_lee_como_siempre() {
        let answer = json!({"answers": {
            "categoria": {"choice": "Casa", "confidence": 0.82},
            "es_nota": {"noul": 0.97},
        }});
        assert_eq!(
            parse_answer(&answer, &categories()).unwrap(),
            Verdict { category_id: Some(4), confidence: 0.82, note_score: Some(0.97) }
        );
        // «otro», o una categoría que ya no existe, no es ninguna.
        let other = json!({"answers": {"categoria": {"choice": "otro", "confidence": 0.7}}});
        assert_eq!(
            parse_answer(&other, &categories()).unwrap(),
            Verdict { category_id: None, confidence: 0.7, note_score: None }
        );
        assert!(matches!(parse_answer(&json!({"answers": {}}), &categories()), Err(AiError::Other(_))));
    }
}
