use std::path::Path;

/// Cómo está guardado un archivo de texto en el disco.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Windows1252,
}

/// Lee un archivo de texto. Devuelve `None` si es binario o supera el tamaño máximo.
pub fn read_text(path: &Path, max_bytes: u64) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() as u64 > max_bytes {
        return None;
    }
    decode(&bytes)
}

/// Texto tal cual está en el archivo (con sus saltos de línea) y su codificación:
/// UTF-8 (con o sin BOM), UTF-16 con BOM y, como último recurso, Windows-1252, que es
/// lo que escribe el Bloc de notas clásico en modo ANSI.
fn decode_raw(bytes: &[u8]) -> Option<(String, Encoding)> {
    let (text, encoding) = if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        (String::from_utf8_lossy(rest).into_owned(), Encoding::Utf8Bom)
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        (encoding_rs::UTF_16LE.decode(bytes).0.into_owned(), Encoding::Utf16Le)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        (encoding_rs::UTF_16BE.decode(bytes).0.into_owned(), Encoding::Utf16Be)
    } else {
        match std::str::from_utf8(bytes) {
            Ok(s) => (s.to_owned(), Encoding::Utf8),
            Err(_) if bytes.contains(&0) => return None,
            Err(_) => (encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(), Encoding::Windows1252),
        }
    };
    if text.contains('\0') {
        return None;
    }
    Some((text, encoding))
}

/// Decodifica un archivo de texto y unifica sus saltos de línea. `None` si es binario.
pub fn decode(bytes: &[u8]) -> Option<String> {
    decode_raw(bytes).map(|(text, _)| normalize_newlines(&text))
}

/// Codifica `text` igual que estaba el archivo original: misma codificación, misma marca
/// de orden de bytes y mismos saltos de línea. Así, editar una hoja desde Book no le
/// cambia el formato al archivo. `None` si el original no es de texto.
pub fn encode_like(text: &str, original: &[u8]) -> Option<Vec<u8>> {
    let (raw, encoding) = decode_raw(original)?;
    // Un archivo sin saltos de línea todavía no eligió: se usa el del sistema.
    let crlf = if raw.contains('\n') { raw.contains("\r\n") } else { cfg!(windows) };
    let body = if crlf { text.replace('\n', "\r\n") } else { text.to_owned() };
    Some(match encoding {
        Encoding::Utf8 => body.into_bytes(),
        Encoding::Utf8Bom => [&[0xEF, 0xBB, 0xBF][..], body.as_bytes()].concat(),
        Encoding::Utf16Le => [0xFF, 0xFE]
            .into_iter()
            .chain(body.encode_utf16().flat_map(u16::to_le_bytes))
            .collect(),
        Encoding::Utf16Be => [0xFE, 0xFF]
            .into_iter()
            .chain(body.encode_utf16().flat_map(u16::to_be_bytes))
            .collect(),
        Encoding::Windows1252 => {
            let (bytes, _, lossy) = encoding_rs::WINDOWS_1252.encode(&body);
            if lossy {
                // Se escribió algo que ANSI no puede representar (un emoji, por ejemplo):
                // el archivo pasa a UTF-8 con marca, que cualquier editor reconoce.
                [&[0xEF, 0xBB, 0xBF][..], body.as_bytes()].concat()
            } else {
                bytes.into_owned()
            }
        }
    })
}

pub fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Título para hojas sin nombre de archivo: la primera línea con contenido.
pub fn title_from_content(content: &str) -> String {
    title_from_content_localized(content, false)
}

pub fn title_from_content_localized(content: &str, is_en: bool) -> String {
    let line = content
        .lines()
        .map(|l| l.trim().trim_start_matches(['#', '-', '*', '>', ' ']).trim())
        .find(|l| !l.is_empty())
        .unwrap_or(if is_en { "Untitled" } else { "Sin título" });
    let mut title: String = line.chars().take(80).collect();
    if line.chars().count() > 80 {
        title.push('…');
    }
    title
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodifica_utf16_y_ansi() {
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("año".encode_utf16().flat_map(|u| u.to_le_bytes()))
            .collect();
        assert_eq!(decode(&utf16).as_deref(), Some("año"));
        assert_eq!(decode(&[b'a', 0xF1, b'o']).as_deref(), Some("año"));
        assert_eq!(decode(&[0, 1, 2, 0xFF]), None);
    }

    #[test]
    fn titulo_desde_la_primera_linea() {
        assert_eq!(title_from_content("\n\n# Pendientes\n- uno"), "Pendientes");
        assert_eq!(title_from_content("   "), "Sin título");
    }

    #[test]
    fn al_guardar_conserva_la_codificacion_y_los_saltos_del_original() {
        // UTF-8 con saltos de Windows: lo editado vuelve a salir con \r\n.
        assert_eq!(encode_like("uno\ndos\ntres", b"uno\r\ndos").unwrap(), b"uno\r\ndos\r\ntres");
        // Saltos de Unix: se respetan.
        assert_eq!(encode_like("uno\ndos\ntres", b"uno\ndos").unwrap(), b"uno\ndos\ntres");
        // Con marca de UTF-8, la marca sigue.
        assert_eq!(encode_like("año", &[0xEF, 0xBB, 0xBF, b'a']).unwrap(), [&[0xEF, 0xBB, 0xBF][..], "año".as_bytes()].concat());

        // UTF-16: ida y vuelta sin perder nada.
        let utf16 = |text: &str| -> Vec<u8> {
            [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect()
        };
        let saved = encode_like("año\nnuevo", &utf16("año\r\nviejo")).unwrap();
        assert_eq!(saved, utf16("año\r\nnuevo"));
        assert_eq!(decode(&saved).as_deref(), Some("año\nnuevo"));

        // ANSI: sigue en ANSI mientras se pueda; si no alcanza, pasa a UTF-8 con marca.
        let ansi = [b'a', 0xF1, b'o', b'\n'];
        assert_eq!(encode_like("año\nñandú", &ansi).unwrap(), [b'a', 0xF1, b'o', b'\n', 0xF1, b'a', b'n', b'd', 0xFA]);
        let widened = encode_like("año ✓", &ansi).unwrap();
        assert!(widened.starts_with(&[0xEF, 0xBB, 0xBF]));
        assert_eq!(decode(&widened).as_deref(), Some("año ✓"));

        // Un binario no se toca.
        assert!(encode_like("x", &[0, 1, 2, 0xFF]).is_none());
    }
}
