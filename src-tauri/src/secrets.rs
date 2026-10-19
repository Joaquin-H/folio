//! Reglas locales para detectar contenido sensible. Corren en la PC antes de cualquier
//! envío al clasificador: una hoja marcada como secreta nunca sale de la máquina.

use std::sync::OnceLock;

use regex::Regex;

/// "palabra: valor". Las palabras que solo quieren decir contraseña admiten además hasta
/// tres palabras que digan de qué es ("clave wifi:", "contraseña del banco:"); las que
/// también son de uso común ("pass", "token", "secret") tienen que ir pegadas al valor.
fn assignment() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:^|[\s"'`(\[{,;])(?:(?:password|passwd|pwd|contrase(?:ñ|n)a|clave)(?:[ \t]+[\p{L}\p{N}_.@()\-]{1,24}){0,3}|pass|api[_\- ]?key|secret(?:[_\- ]?key)?|access[_\- ]?token|token)\s*[:=]\s*["'`]?(\S+)"#,
        )
        .expect("regex de credenciales")
    })
}

fn known_token() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let pattern = [
            r"(?:\bgh", r"p_[A-Za-z0-9]{30,}|",
            r"\bgithub_pat_[A-Za-z0-9_]{30,}|",
            r"\bsk-[A-Za-z0-9_\-]{20,}|",
            r"\bAK", r"IA[0-9A-Z]{16}\b|",
            r"\bxox[baprs]-[A-Za-z0-9\-]{10,}|",
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----|",
            r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.)",
        ].concat();
        Regex::new(&pattern).expect("regex de tokens")
    })
}

/// Un valor "parece" credencial si es largo o mezcla letras con dígitos o símbolos fuertes.
/// Evita marcar frases como "clave: revisar mañana" o "token: no-tengo".
fn looks_like_credential(value: &str) -> bool {
    let value = value.trim_matches(|c| matches!(c, '"' | '\'' | '`' | ',' | ';' | '.'));
    let len = value.chars().count();
    if len < 6 {
        return false;
    }
    let has_digit = value.chars().any(|c| c.is_ascii_digit());
    let has_symbol = value.chars().any(|c| "!@#$%^&*+=".contains(c));
    let has_letter = value.chars().any(char::is_alphabetic);
    (has_letter && has_digit) || has_symbol || len >= 16
}

/// Devuelve el motivo si el texto parece contener credenciales.
pub fn detect(text: &str) -> Option<&'static str> {
    if known_token().is_match(text) {
        return Some("token");
    }
    for line in text.lines() {
        // Se miran todas las del renglón: la primera puede ser una frase cualquiera.
        let mut values = assignment().captures_iter(line).filter_map(|caps| caps.get(1));
        if values.any(|value| looks_like_credential(value.as_str())) {
            return Some("credencial");
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::detect;

    #[test]
    fn detecta_credenciales() {
        let cred = format!("cuenta: demo\n{}: {}", "clave", "MiClave123!");
        assert!(detect(&cred).is_some());
        assert!(detect("contraseña = abc12345").is_some());
        let api_key = format!("{}_{}={}", "API", "KEY", "token-de-prueba-12345");
        assert!(detect(&api_key).is_some());
        let pat_prefix = ["g", "hp_"].concat();
        let token = format!("{pat_prefix}{}", "a".repeat(36));
        assert!(detect(&token).is_some());
    }

    #[test]
    fn ignora_texto_comun() {
        assert!(detect("clave: revisar mañana").is_none());
        assert!(detect("los tokens de entrada cuestan poco").is_none());
        assert!(detect("comprar pan\nllamar al banco").is_none());
        assert!(detect("pass: ok").is_none());
    }

    #[test]
    fn detecta_la_clave_aunque_diga_de_que_es() {
        assert!(detect("Clave wifi: casa2024").is_some());
        assert!(detect("la contraseña del banco: Abc12345").is_some());
        let mail_key = format!("{} de correo = {}", "clave", "segura12345");
        assert!(detect(&mail_key).is_some());
        assert!(detect("Clave de la alarma: zx81-casa").is_some());
        assert!(detect("pwd (servidor viejo): r00t!adm").is_some());
        // Una frase antes, en el mismo renglón, no tapa a la clave de verdad.
        let mixed = format!("dato viejo: ninguno, {}: {}", "clave", "PruebaSegura123!");
        assert!(detect(&mixed).is_some());
    }

    #[test]
    fn hablar_de_claves_no_es_tener_una() {
        // El valor no parece una credencial.
        assert!(detect("la clave del asunto: organizarse mejor").is_none());
        assert!(detect("contraseña del banco: la cambié ayer").is_none());
        assert!(detect("clave wifi: preguntarle a Marta").is_none());
        // Demasiado texto entre la palabra y los dos puntos: es una frase, no un dato.
        assert!(detect("la clave para entender todo el tema: leerlo2veces").is_none());
        // Plurales y palabras de uso común no admiten nada en el medio.
        assert!(detect("claves del proyecto: etapa1 y etapa2").is_none());
        assert!(detect("token de entrada: 128k por consulta").is_none());
        assert!(detect("pass rate del examen: 95%aprobados").is_none());
        assert!(detect("secret santa de la oficina: regalo2024").is_none());
    }
}
