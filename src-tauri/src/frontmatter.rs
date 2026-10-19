//! Encabezado YAML de las notas: un bloque entre dos `---` al principio, con unas pocas
//! claves que Book entiende (ver `integrations/formato-de-notas.md`). La interfaz usa el
//! título, las etiquetas y la fuente; acá solo hace falta la categoría.

/// Sin tildes, sin mayúsculas y sin espacios de más: así se comparan las categorías
/// («Código», «codigo» y «CÓDIGO » son la misma).
pub fn fold(text: &str) -> String {
    let plain: String = text
        .chars()
        // Tildes sueltas (texto descompuesto): se van.
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => 'a',
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' => 'o',
            'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => 'u',
            'ñ' | 'Ñ' => 'n',
            'ç' | 'Ç' => 'c',
            'ý' | 'ÿ' | 'Ý' => 'y',
            other => other,
        })
        .flat_map(char::to_lowercase)
        .collect();
    plain.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Un valor de YAML simple: sin comillas, y sin el comentario del final si no las tenía.
fn scalar(value: &str) -> String {
    let value = value.trim();
    // Entre comillas: lo de adentro, aunque después venga un comentario.
    if let Some(inner) = value.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => return out,
                '\\' => out.extend(chars.next()),
                other => out.push(other),
            }
        }
    } else if let Some(inner) = value.strip_prefix('\'') {
        let mut out = String::new();
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '\'' {
                out.push(c);
            } else if chars.peek() == Some(&'\'') {
                out.push(chars.next().unwrap_or('\''));
            } else {
                return out;
            }
        }
    }
    match value.find(" #").or_else(|| value.find("\t#")) {
        Some(comment) => value[..comment].trim().to_string(),
        None => value.to_string(),
    }
}

/// La categoría que pide el encabezado de la nota (`categoria:` o `category:`), si tiene
/// encabezado y lo pide. Solo cuenta como encabezado si todo lo que hay entre los dos
/// `---` parece YAML: una nota que empieza con un separador no es un encabezado.
pub fn category(content: &str) -> Option<String> {
    let body = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = body.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut found = None;
    let mut keys = 0;
    for line in lines.take(200) {
        let trimmed = line.trim();
        if trimmed == "---" || trimmed == "..." {
            return found.filter(|_| keys > 0);
        }
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed == "-" || trimmed.starts_with("- ") {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            // Un renglón sangrado sigue a la clave anterior (un valor de varios renglones).
            if line.starts_with([' ', '\t']) && keys > 0 {
                continue;
            }
            return None;
        };
        if line.starts_with([' ', '\t']) {
            continue;
        }
        if !(value.is_empty() || value.starts_with([' ', '\t'])) {
            return None;
        }
        keys += 1;
        if matches!(fold(key).as_str(), "categoria" | "category") {
            found = Some(scalar(value)).filter(|name| !name.is_empty());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_categoria_sale_del_encabezado() {
        let note = "---\ntitulo: Plan\ncategoria: Código\netiquetas: [a, b]\n---\n\n# Plan\n";
        assert_eq!(category(note).as_deref(), Some("Código"));
        assert_eq!(category("---\r\ncategory: \"Trabajo\" \r\n---\r\ntexto").as_deref(), Some("Trabajo"));
        assert_eq!(category("---\ncategoria: 'Casa' # de la mudanza\n---\n").as_deref(), Some("Casa"));
        assert_eq!(category("\u{feff}---\ncategoria: Ideas\n---\n").as_deref(), Some("Ideas"));
        // Listas de varios renglones y comentarios no lo cortan.
        let listed = "---\n# nota de Codex\netiquetas:\n  - uno\n  - dos\ncategoria: Salud\n---\n";
        assert_eq!(category(listed).as_deref(), Some("Salud"));
    }

    #[test]
    fn sin_encabezado_no_hay_categoria() {
        assert_eq!(category("categoria: Trabajo\n"), None);
        // Un separador al principio, con texto común debajo, no es un encabezado.
        assert_eq!(category("---\nHoy hablamos de la categoría Trabajo\ncategoria: Trabajo\n---\n"), None);
        assert_eq!(category("---\ntitulo: Sin cerrar\ncategoria: Trabajo\n"), None);
        assert_eq!(category("---\ntitulo: Sin categoría\n---\n"), None);
        assert_eq!(category("---\ncategoria:\n---\n"), None);
    }

    #[test]
    fn las_categorias_se_comparan_sin_tildes_ni_mayusculas() {
        assert_eq!(fold("  CÓDIGO  "), "codigo");
        assert_eq!(fold("Código"), fold("codigo"));
        assert_eq!(fold("Co\u{301}digo"), "codigo");
        assert_eq!(fold("Año   nuevo"), "ano nuevo");
    }
}
