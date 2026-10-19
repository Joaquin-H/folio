use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine as _,
};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use std::sync::{Arc, Mutex};

pub const PREFIX: &str = "enc1:";
pub const CHECK_SETTING: &str = "secret_key_check";
pub const CHECK_VALUE: &str = "book-secret-v1";
pub const UNREADABLE_TITLE: &str = "Hoja cifrada";
pub const UNREADABLE_CONTENT: &str =
    "[No se puede leer: falta la clave de cifrado del secret-book]";

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
const BACKUP_HEADER: &str = "BOOK-SECRET-KEY-V1:";

pub const KEYRING_SERVICE: &str = "com.j-playground.folio";
const LEGACY_KEYRING_SERVICE: &str = "com.joaquinh.book";
const KEYRING_USER: &str = "secret_book_key";

pub trait KeyStore: Send + Sync {
    fn get_key(&self) -> Result<Option<[u8; KEY_LEN]>, String>;
    fn set_key(&self, key: &[u8; KEY_LEN]) -> Result<(), String>;
}

pub struct SystemKeyStore;

impl KeyStore for SystemKeyStore {
    fn get_key(&self) -> Result<Option<[u8; KEY_LEN]>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| format!("No se pudo abrir el llavero del sistema: {e}"))?;
        match entry.get_password() {
            Ok(raw) => decode_key(&raw).map(Some),
            Err(keyring::Error::NoEntry) => {
                // Si todavía no está en el servicio nuevo, miramos si existía en el anterior.
                if let Ok(legacy) = keyring::Entry::new(LEGACY_KEYRING_SERVICE, KEYRING_USER) {
                    if let Ok(raw) = legacy.get_password() {
                        if let Ok(decoded) = decode_key(&raw) {
                            let _ = entry.set_password(&raw);
                            return Ok(Some(decoded));
                        }
                    }
                }
                Ok(None)
            }
            Err(e) => Err(format!("No se pudo leer la clave del llavero: {e}")),
        }
    }

    fn set_key(&self, key: &[u8; KEY_LEN]) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| format!("No se pudo abrir el llavero del sistema: {e}"))?;
        entry
            .set_password(&encode_key(key))
            .map_err(|e| format!("No se pudo guardar la clave en el llavero: {e}"))
    }
}

#[derive(Clone)]
pub struct MemoryKeyStore {
    inner: Arc<Mutex<Result<Option<[u8; KEY_LEN]>, String>>>,
}

impl MemoryKeyStore {
    pub fn new_empty() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Ok(None))),
        }
    }

    pub fn with_key(key: [u8; KEY_LEN]) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Ok(Some(key)))),
        }
    }

    #[cfg(test)]
    pub fn clear(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Ok(None);
        }
    }

    #[cfg(test)]
    pub fn replace_key(&self, key: [u8; KEY_LEN]) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Ok(Some(key));
        }
    }
}

impl KeyStore for MemoryKeyStore {
    fn get_key(&self) -> Result<Option<[u8; KEY_LEN]>, String> {
        self.inner
            .lock()
            .map_err(|_| "KeyStore lock poisoned".to_string())?
            .clone()
    }

    fn set_key(&self, key: &[u8; KEY_LEN]) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "KeyStore lock poisoned".to_string())?;
        if let Err(reason) = &*guard {
            return Err(reason.clone());
        }
        *guard = Ok(Some(*key));
        Ok(())
    }
}

#[derive(Clone)]
pub struct Vault {
    store: Arc<dyn KeyStore>,
}

impl Vault {
    pub fn new(store: Arc<dyn KeyStore>) -> Self {
        Self { store }
    }

    pub fn system() -> Self {
        Self {
            store: Arc::new(SystemKeyStore),
        }
    }

    pub fn in_memory_with_key(key: [u8; KEY_LEN]) -> Self {
        Self {
            store: Arc::new(MemoryKeyStore::with_key(key)),
        }
    }

    pub fn in_memory_empty() -> Self {
        Self {
            store: Arc::new(MemoryKeyStore::new_empty()),
        }
    }

    pub fn current_key(&self) -> Result<Option<[u8; KEY_LEN]>, String> {
        self.store.get_key()
    }

    pub fn get_or_create_key(&self) -> Result<[u8; KEY_LEN], String> {
        if let Some(key) = self.store.get_key()? {
            return Ok(key);
        }
        let key = generate_key()?;
        self.store.set_key(&key)?;
        Ok(key)
    }

    pub fn set_key(&self, key: &[u8; KEY_LEN]) -> Result<(), String> {
        self.store.set_key(key)
    }
}

#[cfg(windows)]
fn fill_random(buf: &mut [u8]) -> Result<(), String> {
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(
            hAlgorithm: *mut std::ffi::c_void,
            pbBuffer: *mut u8,
            cbBuffer: u32,
            dwFlags: u32,
        ) -> i32;
    }
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("BCryptGenRandom falló con código 0x{status:08x}"))
    }
}

#[cfg(not(windows))]
fn fill_random(buf: &mut [u8]) -> Result<(), String> {
    use std::io::Read;
    let mut f = std::fs::File::open("/dev/urandom").map_err(|e| e.to_string())?;
    f.read_exact(buf).map_err(|e| e.to_string())
}

pub fn generate_key() -> Result<[u8; KEY_LEN], String> {
    let mut key = [0u8; KEY_LEN];
    fill_random(&mut key)?;
    Ok(key)
}

fn generate_nonce() -> Result<[u8; NONCE_LEN], String> {
    let mut nonce = [0u8; NONCE_LEN];
    fill_random(&mut nonce)?;
    Ok(nonce)
}

pub fn is_encrypted(s: &str) -> bool {
    s.starts_with(PREFIX)
}

pub fn encrypt(key: &[u8; KEY_LEN], plaintext: &str) -> Result<String, String> {
    let nonce_bytes = generate_nonce()?;
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| "No se pudo cifrar el contenido".to_string())?;

    let mut combined = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);

    Ok(format!("{PREFIX}{}", STANDARD_NO_PAD.encode(&combined)))
}

pub fn encrypt_if_plain(key: &[u8; KEY_LEN], value: &str) -> Result<String, String> {
    if is_encrypted(value) {
        Ok(value.to_string())
    } else {
        encrypt(key, value)
    }
}

pub fn decrypt(key: &[u8; KEY_LEN], encoded: &str) -> Result<String, String> {
    let b64 = encoded
        .strip_prefix(PREFIX)
        .ok_or_else(|| "El valor no tiene el prefijo enc1:".to_string())?;
    let trimmed = b64.trim().trim_end_matches('=');
    let raw = STANDARD_NO_PAD
        .decode(trimmed)
        .or_else(|_| STANDARD.decode(b64.trim()))
        .map_err(|_| "Formato base64 inválido en valor cifrado".to_string())?;

    if raw.len() < NONCE_LEN + TAG_LEN {
        return Err("Valor cifrado truncado o inválido".to_string());
    }

    let (nonce_bytes, ciphertext) = raw.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XNonce::from_slice(nonce_bytes);
    let plain_bytes = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Fallo de autenticación al descifrar".to_string())?;

    String::from_utf8(plain_bytes).map_err(|_| "El texto descifrado no es UTF-8 válido".to_string())
}

pub fn encode_key(key: &[u8; KEY_LEN]) -> String {
    STANDARD_NO_PAD.encode(key)
}

pub fn decode_key(raw: &str) -> Result<[u8; KEY_LEN], String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("La clave está vacía".to_string());
    }

    let bytes = if trimmed.len() == KEY_LEN * 2 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        (0..KEY_LEN)
            .map(|i| u8::from_str_radix(&trimmed[i * 2..i * 2 + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
            .map_err(|_| "Clave hexadecimal inválida".to_string())?
    } else {
        let no_pad = trimmed.trim_end_matches('=');
        STANDARD_NO_PAD
            .decode(no_pad)
            .or_else(|_| STANDARD.decode(trimmed))
            .map_err(|_| "Formato de clave inválido".to_string())?
    };

    if bytes.len() != KEY_LEN {
        return Err(format!(
            "La clave debe tener {KEY_LEN} bytes (recibidos {})",
            bytes.len()
        ));
    }

    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(&bytes);
    Ok(out)
}

pub fn format_backup(key: &[u8; KEY_LEN]) -> String {
    format!(
        "# Clave de respaldo del secret-book de Book\n\
         # Guardá este archivo en un lugar seguro. Permite recuperar tus hojas secretas\n\
         # si cambiás de PC o si se borra el llavero de Windows.\n\
         {BACKUP_HEADER}{}\n",
        encode_key(key)
    )
}

pub fn parse_backup(content: &str) -> Result<[u8; KEY_LEN], String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let candidate = trimmed
            .strip_prefix(BACKUP_HEADER)
            .or_else(|| trimmed.strip_prefix("book-secret-key-v1:"))
            .unwrap_or(trimmed)
            .trim();
        return decode_key(candidate);
    }
    Err("El archivo no contiene una clave de respaldo válida".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_random_nonce() {
        let key = generate_key().expect("generate key");
        let plain = "Secreto con ñ, tildes (áéíóú) y símbolos 🔒";
        let c1 = encrypt(&key, plain).expect("encrypt 1");
        let c2 = encrypt(&key, plain).expect("encrypt 2");

        assert!(is_encrypted(&c1));
        assert!(is_encrypted(&c2));
        assert_ne!(c1, c2, "two encryptions of same plaintext must use distinct nonces");
        assert!(!c1.contains("Secreto"));

        let d1 = decrypt(&key, &c1).expect("decrypt 1");
        let d2 = decrypt(&key, &c2).expect("decrypt 2");
        assert_eq!(d1, plain);
        assert_eq!(d2, plain);
    }

    #[test]
    fn tampered_ciphertext_fails_authentication() {
        let key = generate_key().expect("generate key");
        let ct = encrypt(&key, "texto ultra secreto").expect("encrypt");
        let b64 = ct.strip_prefix(PREFIX).unwrap();
        let mut raw = STANDARD_NO_PAD.decode(b64).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        let tampered = format!("{PREFIX}{}", STANDARD_NO_PAD.encode(&raw));

        assert!(decrypt(&key, &tampered).is_err());

        let other_key = generate_key().expect("other key");
        assert!(decrypt(&other_key, &ct).is_err());
    }

    #[test]
    fn backup_format_and_parse_roundtrip() {
        let key = generate_key().expect("generate key");
        let backup = format_backup(&key);
        let parsed = parse_backup(&backup).expect("parse backup");
        assert_eq!(parsed, key);

        // Also supports raw base64 and hex
        let raw_b64 = encode_key(&key);
        assert_eq!(parse_backup(&raw_b64).unwrap(), key);

        let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(parse_backup(&hex).unwrap(), key);
    }
}
