//! Hablar con una IA por HTTP, igual para todas: el pedido ya armado (`Request`, para poder
//! revisarlo sin red), su envío y cómo se traducen las fallas al `AiError` que entiende el
//! clasificador. Cada IA arma su propio pedido y lee su propia respuesta (`jev.rs`, `llm.rs`).

use std::time::Duration;

use serde_json::Value;

use crate::provider::{AiError, Provider};

/// Un pedido listo para enviar.
#[derive(Debug, Clone)]
pub struct Request {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
    pub timeout: Duration,
}

/// Lo que se muestra de la respuesta de un servicio cuando falla: el resto es ruido.
const DETAIL_CHARS: usize = 300;

/// Envía el pedido y devuelve el JSON de la respuesta. Toda falla vuelve como `AiError`.
pub fn send(provider: Provider, request: &Request) -> Result<Value, AiError> {
    let mut call = ureq::post(&request.url).timeout(request.timeout);
    for (name, value) in &request.headers {
        call = call.set(name, value);
    }
    match call.send_json(&request.body) {
        // Una respuesta cortada o ilegible es un problema del momento, no de la hoja.
        Ok(response) => response.into_json().map_err(|e| {
            AiError::Busy(format!("No se pudo leer la respuesta de {}: {e}.", provider.label()), None)
        }),
        Err(ureq::Error::Status(code, response)) => {
            let wait = retry_after_ms(&response);
            let body = response.into_string().unwrap_or_default();
            Err(status_error(provider, code, wait, &body))
        }
        Err(ureq::Error::Transport(e)) => Err(transport_error(provider, &e, &request.url)),
    }
}

/// Cuánto pide esperar el servicio antes de reintentar (`retry-after-ms` o `Retry-After`
/// en segundos).
fn retry_after_ms(response: &ureq::Response) -> Option<i64> {
    let number = |name: &str| response.header(name)?.trim().parse::<f64>().ok().filter(|n| *n >= 0.0);
    number("retry-after-ms")
        .or_else(|| number("retry-after").map(|seconds| seconds * 1000.0))
        .map(|ms| ms as i64)
}

/// Gemini no usa `Retry-After`: cuenta la espera en el cuerpo del error, dentro de
/// `error.details[].retryDelay` («34s», «0.5s»). En milisegundos.
fn retry_delay_in_body(body: &Value) -> Option<i64> {
    let delay = body["error"]["details"]
        .as_array()?
        .iter()
        .find_map(|detail| detail["retryDelay"].as_str())?;
    let seconds: f64 = delay.trim().strip_suffix('s')?.parse().ok()?;
    (seconds >= 0.0).then_some((seconds * 1000.0) as i64)
}

/// Qué dijo el servicio, para mostrarlo: el mensaje del error si viene en el formato de
/// la API (`{"error": {"message": …}}`, o `{"error": "…"}` en Ollama), si no el cuerpo tal
/// cual. Nunca más de `DETAIL_CHARS` caracteres.
fn error_detail(raw: &str, body: &Value) -> String {
    let message = body["error"]["message"].as_str().or_else(|| body["error"].as_str()).unwrap_or(raw);
    message.trim().chars().take(DETAIL_CHARS).collect()
}

/// Traduce una respuesta con error HTTP.
///
/// - La configuración no sirve y no tiene sentido insistir (`Auth`): clave rechazada,
///   crédito agotado, modelo que no existe.
/// - El servicio está ocupado, saturado o tardó demasiado (`Busy`, con la espera que haya
///   pedido): se reintenta más tarde.
/// - Rechazó esta consulta en particular (`Other`): se aparta la hoja.
pub fn status_error(provider: Provider, code: u16, wait: Option<i64>, raw: &str) -> AiError {
    let body: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let message = format!("{} respondió HTTP {code}. {}", provider.label(), error_detail(raw, &body))
        .trim_end()
        .to_string();
    let wait = wait.or_else(|| retry_delay_in_body(&body));
    // Lo que reintentan los clientes oficiales: tiempo agotado, límite de tasa y fallas del servicio.
    let transient = matches!(code, 408 | 429 | 500..=599);
    match (provider, code) {
        (_, 401 | 403) => AiError::Auth(message),
        // Jev no usa nada más: lo demás es transitorio o de esta consulta.
        (Provider::Jev, _) if transient => AiError::Busy(message, wait),
        (Provider::Jev, _) => AiError::Other(message),
        // Sin saldo (402), o un modelo que no existe o no está instalado (404): se arregla
        // en Ajustes, no reintentando.
        (_, 402 | 404) => AiError::Auth(message),
        // Gemini rechaza una clave inválida con un 400.
        (Provider::Gemini, 400) if bad_gemini_key(raw) => AiError::Auth(message),
        // Sin cuota no hay reintento que alcance: OpenAI la distingue del límite de tasa.
        (Provider::OpenAi, 429) if raw.contains("insufficient_quota") => AiError::Auth(message),
        _ if transient => AiError::Busy(message, wait),
        _ => AiError::Other(message),
    }
}

fn bad_gemini_key(raw: &str) -> bool {
    let lower = raw.to_lowercase();
    raw.contains("API_KEY_INVALID") || lower.contains("api key not valid") || lower.contains("api key expired")
}

fn transport_error(provider: Provider, e: &ureq::Transport, url: &str) -> AiError {
    let refused = matches!(e.kind(), ureq::ErrorKind::Dns | ureq::ErrorKind::ConnectionFailed);
    let message = match provider {
        // Si no responde, lo más probable es que Ollama no esté abierto.
        Provider::Ollama if refused => {
            format!("No se pudo conectar con Ollama en {}: {e}. ¿Está abierto?", origin(url))
        }
        _ => format!("No se pudo conectar con {}: {e}.", provider.label()),
    };
    if refused {
        // No se llegó a enviar nada: no cuenta como consulta.
        AiError::Offline(message)
    } else {
        // La consulta salió pero la respuesta no llegó entera (o tardó demasiado).
        AiError::Busy(message, None)
    }
}

/// `http://localhost:11434` de `http://localhost:11434/api/chat`.
fn origin(url: &str) -> &str {
    let after = url.find("://").map_or(0, |at| at + 3);
    url[after..].find('/').map_or(url, |slash| &url[..after + slash])
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    use serde_json::json;

    use super::*;

    fn response(headers: &str) -> ureq::Response {
        format!("HTTP/1.1 429 Too Many Requests\r\n{headers}\r\n").parse().expect("respuesta de prueba")
    }

    #[test]
    fn respeta_la_espera_que_pide_el_servicio() {
        assert_eq!(retry_after_ms(&response("Retry-After: 30\r\n")), Some(30_000));
        assert_eq!(retry_after_ms(&response("retry-after-ms: 1500\r\nRetry-After: 30\r\n")), Some(1500));
        // Con una fecha en vez de segundos, o sin nada, vale la espera propia de Book.
        assert_eq!(retry_after_ms(&response("Retry-After: Wed, 21 Oct 2026 07:28:00 GMT\r\n")), None);
        assert_eq!(retry_after_ms(&response("")), None);
    }

    #[test]
    fn gemini_cuenta_la_espera_en_el_cuerpo() {
        let body = json!({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [
            {"@type": "type.googleapis.com/google.rpc.QuotaFailure"},
            {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "34.5s"},
        ]}});
        assert_eq!(retry_delay_in_body(&body), Some(34_500));
        assert_eq!(retry_delay_in_body(&json!({"error": {"details": [{"retryDelay": "10 minutos"}]}})), None);
        assert_eq!(retry_delay_in_body(&json!({"error": {"message": "x"}})), None);
        assert_eq!(retry_delay_in_body(&Value::Null), None);
    }

    fn busy(error: AiError) -> (String, Option<i64>) {
        match error {
            AiError::Busy(message, wait) => (message, wait),
            other => panic!("se esperaba Busy y fue {other:?}"),
        }
    }

    #[test]
    fn jev_traduce_los_errores_como_siempre() {
        let error = |code| status_error(Provider::Jev, code, None, "detalle");
        assert!(matches!(error(401), AiError::Auth(m) if m == "Jev respondió HTTP 401. detalle"));
        assert!(matches!(error(403), AiError::Auth(_)));
        for code in [408, 429, 500, 503] {
            assert!(matches!(error(code), AiError::Busy(_, None)), "{code}");
        }
        // Lo demás es de esta consulta, también un 404 o un 402.
        for code in [400, 402, 404, 413, 422] {
            assert!(matches!(error(code), AiError::Other(_)), "{code}");
        }
        assert!(matches!(status_error(Provider::Jev, 429, Some(5000), ""), AiError::Busy(_, Some(5000))));
        // Sin detalle no queda un espacio de más.
        assert!(matches!(status_error(Provider::Jev, 503, None, ""), AiError::Busy(m, _) if m == "Jev respondió HTTP 503."));
    }

    #[test]
    fn claude_traduce_los_errores_de_su_api() {
        let invalid_key = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_1"}"#;
        match status_error(Provider::Claude, 401, None, invalid_key) {
            AiError::Auth(message) => assert_eq!(message, "Claude respondió HTTP 401. invalid x-api-key"),
            other => panic!("{other:?}"),
        }
        for code in [402, 403, 404] {
            assert!(matches!(status_error(Provider::Claude, code, None, "{}"), AiError::Auth(_)), "{code}");
        }
        let rate = r#"{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}"#;
        let (message, wait) = busy(status_error(Provider::Claude, 429, Some(30_000), rate));
        assert_eq!(message, "Claude respondió HTTP 429. Number of requests has exceeded your rate limit");
        assert_eq!(wait, Some(30_000));
        // 529 es «sobrecargada», 500 una falla suya, 504 se agotó el tiempo: se reintentan.
        for code in [500, 504, 529] {
            assert!(matches!(status_error(Provider::Claude, code, None, ""), AiError::Busy(_, None)), "{code}");
        }
        // Un pedido que no entiende, o demasiado grande, es de esta hoja.
        for code in [400, 413] {
            assert!(matches!(status_error(Provider::Claude, code, None, ""), AiError::Other(_)), "{code}");
        }
    }

    #[test]
    fn openai_traduce_los_errores_de_su_api() {
        let bad_key = r#"{"error":{"message":"Incorrect API key provided: sk-…","type":"invalid_request_error","code":"invalid_api_key"}}"#;
        assert!(matches!(status_error(Provider::OpenAi, 401, None, bad_key), AiError::Auth(_)));
        assert!(matches!(status_error(Provider::OpenAi, 404, None, "{}"), AiError::Auth(_)));
        let slow = r#"{"error":{"message":"Rate limit reached","type":"requests","code":"rate_limit_exceeded"}}"#;
        assert!(matches!(status_error(Provider::OpenAi, 429, Some(2000), slow), AiError::Busy(_, Some(2000))));
        // Sin cuota no sirve esperar: hay que cargar crédito.
        let quota = r#"{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}"#;
        assert!(matches!(status_error(Provider::OpenAi, 429, None, quota), AiError::Auth(m) if m.contains("exceeded your current quota")));
        assert!(matches!(status_error(Provider::OpenAi, 503, Some(1000), ""), AiError::Busy(_, Some(1000))));
        assert!(matches!(status_error(Provider::OpenAi, 400, None, ""), AiError::Other(_)));
    }

    #[test]
    fn gemini_traduce_los_errores_de_su_api() {
        let bad_key = r#"{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}"#;
        assert!(matches!(status_error(Provider::Gemini, 400, None, bad_key), AiError::Auth(_)));
        // Cualquier otro 400 es del pedido.
        assert!(matches!(status_error(Provider::Gemini, 400, None, r#"{"error":{"message":"Invalid JSON payload"}}"#), AiError::Other(_)));
        assert!(matches!(status_error(Provider::Gemini, 403, None, ""), AiError::Auth(_)));
        assert!(matches!(status_error(Provider::Gemini, 404, None, ""), AiError::Auth(_)));
        let busy_body = r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"20s"}]}}"#;
        assert!(matches!(status_error(Provider::Gemini, 429, None, busy_body), AiError::Busy(_, Some(20_000))));
        // Si hay encabezado, manda el encabezado.
        assert!(matches!(status_error(Provider::Gemini, 429, Some(7000), busy_body), AiError::Busy(_, Some(7000))));
        assert!(matches!(status_error(Provider::Gemini, 503, None, ""), AiError::Busy(_, None)));
    }

    #[test]
    fn ollama_traduce_los_errores_de_su_servidor() {
        let missing = r#"{"error":"model \"llama9\" not found, try pulling it first"}"#;
        match status_error(Provider::Ollama, 404, None, missing) {
            AiError::Auth(message) => assert_eq!(message, "Ollama respondió HTTP 404. model \"llama9\" not found, try pulling it first"),
            other => panic!("{other:?}"),
        }
        assert!(matches!(status_error(Provider::Ollama, 500, None, r#"{"error":"llama runner process has terminated"}"#), AiError::Busy(_, None)));
        assert!(matches!(status_error(Provider::Ollama, 400, None, ""), AiError::Other(_)));
    }

    #[test]
    fn el_detalle_del_error_se_acota() {
        let long = "x".repeat(1000);
        let AiError::Other(message) = status_error(Provider::Claude, 400, None, &long) else { panic!() };
        assert_eq!(message.chars().count(), "Claude respondió HTTP 400. ".chars().count() + DETAIL_CHARS);
    }

    #[test]
    fn el_origen_es_lo_que_hay_hasta_la_primera_barra() {
        assert_eq!(origin("http://localhost:11434/api/chat"), "http://localhost:11434");
        assert_eq!(origin("http://localhost:11434"), "http://localhost:11434");
        assert_eq!(origin("https://pc-de-casa.local:8443/x/y"), "https://pc-de-casa.local:8443");
    }

    // ---- contra un servidor de mentira en esta misma PC ---------------------------------
    //
    // Nada sale a la red: se prueba que el pedido llegue como se armó y que la respuesta
    // (con sus encabezados) se traduzca bien de punta a punta.

    /// Atiende una sola conexión con `reply` y devuelve la dirección y lo que recibió.
    fn serve_once(reply: &'static str) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("puerto libre");
        let address = format!("http://{}", listener.local_addr().unwrap());
        let (sent, received) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("una conexión");
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = stream.read(&mut chunk).unwrap_or(0);
                raw.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&raw).to_string();
                let Some(split) = text.find("\r\n\r\n") else { if n == 0 { break } else { continue } };
                let length = text[..split]
                    .lines()
                    .find_map(|line| line.to_lowercase().strip_prefix("content-length:").and_then(|n| n.trim().parse::<usize>().ok()))
                    .unwrap_or(0);
                if raw.len() >= split + 4 + length || n == 0 {
                    break;
                }
            }
            let _ = sent.send(String::from_utf8_lossy(&raw).to_string());
            let _ = stream.write_all(reply.as_bytes());
        });
        (address, received)
    }

    fn request(url: String) -> Request {
        Request {
            url,
            headers: vec![("x-api-key", "clave-de-prueba".into()), ("anthropic-version", "2023-06-01".into())],
            body: json!({"hola": "mundo"}),
            timeout: Duration::from_secs(10),
        }
    }

    #[test]
    fn el_pedido_llega_con_sus_encabezados_y_su_cuerpo() {
        let (address, received) = serve_once("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}");
        let answer = send(Provider::Claude, &request(format!("{address}/v1/messages"))).expect("respuesta");
        assert_eq!(answer, json!({"ok": true}));
        let raw = received.recv_timeout(Duration::from_secs(5)).expect("el servidor recibió el pedido");
        let lower = raw.to_lowercase();
        assert!(raw.starts_with("POST /v1/messages HTTP/1.1"), "{raw}");
        assert!(lower.contains("x-api-key: clave-de-prueba"), "{raw}");
        assert!(lower.contains("anthropic-version: 2023-06-01"), "{raw}");
        assert!(lower.contains("content-type: application/json"), "{raw}");
        assert!(raw.ends_with(r#"{"hola":"mundo"}"#), "{raw}");
    }

    #[test]
    fn un_429_con_retry_after_vuelve_como_ocupado_con_su_espera() {
        let (address, _) = serve_once("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 42\r\nContent-Type: application/json\r\nContent-Length: 79\r\nConnection: close\r\n\r\n{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Muchos pedidos\"}}");
        let (message, wait) = busy(send(Provider::Claude, &request(address)).unwrap_err());
        assert_eq!(message, "Claude respondió HTTP 429. Muchos pedidos");
        assert_eq!(wait, Some(42_000));
    }

    #[test]
    fn un_401_y_un_500_se_traducen_de_punta_a_punta() {
        let (address, _) = serve_once("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert!(matches!(send(Provider::OpenAi, &request(address)).unwrap_err(), AiError::Auth(_)));
        let (address, _) = serve_once("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert!(matches!(send(Provider::OpenAi, &request(address)).unwrap_err(), AiError::Busy(_, None)));
        let (address, _) = serve_once("HTTP/1.1 529 \r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert!(matches!(send(Provider::Claude, &request(address)).unwrap_err(), AiError::Busy(_, None)));
    }

    #[test]
    fn una_respuesta_que_no_es_json_es_un_problema_del_momento() {
        let (address, _) = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n<html>ok");
        assert!(matches!(send(Provider::Gemini, &request(address)).unwrap_err(), AiError::Busy(m, None) if m.starts_with("No se pudo leer la respuesta de Gemini")));
    }

    #[test]
    fn ollama_apagado_es_estar_sin_red_y_avisa_que_se_abra() {
        // Un puerto en el que no escucha nadie: se reserva y se suelta.
        let address = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        match send(Provider::Ollama, &request(format!("{address}/api/chat"))).unwrap_err() {
            AiError::Offline(message) => {
                assert!(message.starts_with(&format!("No se pudo conectar con Ollama en {address}:")), "{message}");
                assert!(message.ends_with("¿Está abierto?"), "{message}");
            }
            other => panic!("se esperaba Offline y fue {other:?}"),
        }
    }
}
