//! Atajos globales: los que valen desde cualquier programa, aunque Book esté en la bandeja.
//! Hay tres, «Nueva hoja suelta» (`Ctrl + Alt + N`), «Abrir el cuaderno» (`Ctrl + Alt + B`) y
//! «Enviar lo seleccionado al Book» (`Ctrl + Alt + X`), y el usuario elige las combinaciones.
//!
//! Se guardan como ajustes (`capture_keys`, `open_keys` y `send_keys`) en el formato que usa
//! la interfaz: modificadores (`Ctrl`, `Alt`, `Shift`, `Super`) y una tecla, unidos con `+`
//! («Ctrl+Alt+N»). Acá se validan, se normalizan a una única forma de escribirlos y se
//! traducen a lo que entiende el plugin de atajos globales; todo eso es puro y se prueba
//! sin registrar nada de verdad.

use std::sync::{Arc, Mutex, MutexGuard};

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::db::Db;
use crate::Shared;

/// Los tres atajos globales de Book.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Which {
    /// Abre una hoja suelta para anotar.
    Capture,
    /// Trae el cuaderno al frente.
    Open,
    /// Copia lo seleccionado en el programa que está al frente y lo manda al Book.
    Send,
}

impl Which {
    /// Como lo nombra la interfaz: `"capture"`, `"open"` o `"send"`.
    pub fn parse(text: &str) -> Result<Self, String> {
        match text {
            "capture" => Ok(Self::Capture),
            "open" => Ok(Self::Open),
            "send" => Ok(Self::Send),
            other => Err(format!("«{other}» no es un atajo de Folio.")),
        }
    }

    /// Los otros dos: con ninguno puede compartir combinación.
    pub fn others(self) -> [Self; 2] {
        match self {
            Self::Capture => [Self::Open, Self::Send],
            Self::Open => [Self::Capture, Self::Send],
            Self::Send => [Self::Capture, Self::Open],
        }
    }

    /// Cómo se llama en la pantalla de atajos.
    fn label(self) -> &'static str {
        match self {
            Self::Capture => "Nueva hoja suelta",
            Self::Open => "Abrir el cuaderno",
            Self::Send => "Enviar lo seleccionado a Folio",
        }
    }

    /// Dónde se guarda la combinación elegida.
    fn setting(self) -> &'static str {
        match self {
            Self::Capture => "capture_keys",
            Self::Open => "open_keys",
            Self::Send => "send_keys",
        }
    }

    /// La de fábrica. Para «Enviar» es Ctrl+Alt+X: Ctrl+Alt es AltGr en el teclado español, y
    /// la X no escribe nada con AltGr ni en la distribución de España ni en la de
    /// Latinoamérica (donde AltGr+E es «€» y AltGr+Q es «@», así que esas dos no); tampoco
    /// pisa ninguna de las combinaciones de Word y Excel con Ctrl+Alt (©, ®, ™, pegado
    /// especial, comentario, vistas…), que sí ocupan C, R, T, V, M, N, O y P. Es mnemotécnica
    /// («X» de recortar) y queda lejos de la B y la N de los otros dos.
    fn factory(self) -> Combo {
        let keys = match self {
            Self::Capture => "Ctrl+Alt+N",
            Self::Open => "Ctrl+Alt+B",
            Self::Send => "Ctrl+Alt+X",
        };
        Combo::parse(keys).expect("la combinación de fábrica es válida")
    }
}

/// Teclas con nombre: cómo las escribe la interfaz, a qué tecla del plugin corresponden y
/// cómo se muestran. «Plus» es la tecla del «+» (la del «=» en un teclado en inglés): el
/// plugin la conoce como `Equal`.
const NAMED: &[(&str, Code, &str)] = &[
    ("Enter", Code::Enter, "Enter"),
    ("Escape", Code::Escape, "Esc"),
    ("Tab", Code::Tab, "Tab"),
    ("Space", Code::Space, "Espacio"),
    ("Backspace", Code::Backspace, "Retroceso"),
    ("Delete", Code::Delete, "Supr"),
    ("Insert", Code::Insert, "Ins"),
    ("Home", Code::Home, "Inicio"),
    ("End", Code::End, "Fin"),
    ("PageUp", Code::PageUp, "Re Pág"),
    ("PageDown", Code::PageDown, "Av Pág"),
    ("ArrowLeft", Code::ArrowLeft, "←"),
    ("ArrowRight", Code::ArrowRight, "→"),
    ("ArrowUp", Code::ArrowUp, "↑"),
    ("ArrowDown", Code::ArrowDown, "↓"),
    ("Plus", Code::Equal, "+"),
    ("Minus", Code::Minus, "−"),
    ("Comma", Code::Comma, ","),
    ("Period", Code::Period, "."),
];

/// Otras formas de escribir las mismas teclas.
const ALIASES: &[(&str, &str)] = &[
    ("esc", "Escape"),
    ("return", "Enter"),
    ("del", "Delete"),
    ("supr", "Delete"),
    ("ins", "Insert"),
    ("pgup", "PageUp"),
    ("pgdn", "PageDown"),
    ("left", "ArrowLeft"),
    ("right", "ArrowRight"),
    ("up", "ArrowUp"),
    ("down", "ArrowDown"),
    ("equal", "Plus"),
    ("espacio", "Space"),
];

/// Signos que se escriben tal cual (los que están en el mismo lugar en casi todos los teclados).
const SIGNS: &[(char, Code)] = &[
    (';', Code::Semicolon),
    ('/', Code::Slash),
    ('`', Code::Backquote),
    ('[', Code::BracketLeft),
    (']', Code::BracketRight),
    ('\\', Code::Backslash),
    ('\'', Code::Quote),
];

const LETTERS: [Code; 26] = [
    Code::KeyA,
    Code::KeyB,
    Code::KeyC,
    Code::KeyD,
    Code::KeyE,
    Code::KeyF,
    Code::KeyG,
    Code::KeyH,
    Code::KeyI,
    Code::KeyJ,
    Code::KeyK,
    Code::KeyL,
    Code::KeyM,
    Code::KeyN,
    Code::KeyO,
    Code::KeyP,
    Code::KeyQ,
    Code::KeyR,
    Code::KeyS,
    Code::KeyT,
    Code::KeyU,
    Code::KeyV,
    Code::KeyW,
    Code::KeyX,
    Code::KeyY,
    Code::KeyZ,
];

const DIGITS: [Code; 10] = [
    Code::Digit0,
    Code::Digit1,
    Code::Digit2,
    Code::Digit3,
    Code::Digit4,
    Code::Digit5,
    Code::Digit6,
    Code::Digit7,
    Code::Digit8,
    Code::Digit9,
];

const FUNCTION: [Code; 24] = [
    Code::F1,
    Code::F2,
    Code::F3,
    Code::F4,
    Code::F5,
    Code::F6,
    Code::F7,
    Code::F8,
    Code::F9,
    Code::F10,
    Code::F11,
    Code::F12,
    Code::F13,
    Code::F14,
    Code::F15,
    Code::F16,
    Code::F17,
    Code::F18,
    Code::F19,
    Code::F20,
    Code::F21,
    Code::F22,
    Code::F23,
    Code::F24,
];

/// La tecla principal de una combinación.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Key {
    /// Su única forma de escribirla: «N», «5», «F5», «ArrowUp», «Plus», «;».
    name: String,
    code: Code,
    /// Cómo se muestra: «N», «Re Pág», «←».
    label: String,
}

impl Key {
    fn plain(name: String, code: Code) -> Self {
        Self { label: name.clone(), name, code }
    }

    fn parse(token: &str) -> Option<Self> {
        let mut chars = token.chars();
        let first = chars.next()?;
        if chars.next().is_none() {
            return Self::single(first);
        }
        // F1 a F24, sin ceros a la izquierda.
        if let Some(number) = token.strip_prefix(['F', 'f']).and_then(|n| n.parse::<usize>().ok()) {
            if (1..=24).contains(&number) && token[1..] == number.to_string() {
                return Some(Self::plain(format!("F{number}"), FUNCTION[number - 1]));
            }
        }
        let lowered = token.to_lowercase();
        let wanted = ALIASES.iter().find(|(alias, _)| *alias == lowered).map_or(token, |(_, name)| *name);
        NAMED
            .iter()
            .find(|(name, _, _)| name.eq_ignore_ascii_case(wanted))
            .map(|(name, code, label)| Self { name: name.to_string(), code: *code, label: label.to_string() })
    }

    /// Una tecla escrita con un solo carácter: letra, número o signo.
    fn single(c: char) -> Option<Self> {
        let upper = c.to_ascii_uppercase();
        match upper {
            'A'..='Z' => Some(Self::plain(upper.to_string(), LETTERS[upper as usize - 'A' as usize])),
            '0'..='9' => Some(Self::plain(upper.to_string(), DIGITS[upper as usize - '0' as usize])),
            '+' | '=' => Self::parse("Plus"),
            '-' => Self::parse("Minus"),
            ',' => Self::parse("Comma"),
            '.' => Self::parse("Period"),
            sign => SIGNS.iter().find(|(c, _)| *c == sign).map(|(c, code)| Self::plain(c.to_string(), *code)),
        }
    }
}

/// Una combinación de teclas: modificadores y una tecla.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// La tecla de Windows.
    pub win: bool,
    pub key: Key,
}

impl Combo {
    /// Lee una combinación («Ctrl+Alt+N») en cualquiera de sus formas y la valida. Acepta
    /// los modificadores en cualquier orden, con o sin espacios y en mayúsculas o minúsculas;
    /// después, `keys` la escribe siempre igual. Los errores están pensados para mostrarse.
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("Falta la combinación de teclas.".into());
        }
        // El «+» como tecla: «Ctrl+Alt++» (la interfaz lo escribe «Plus»).
        let (modifiers, key) = if text == "+" {
            ("", "+")
        } else if let Some(head) = text.strip_suffix("++") {
            (head, "+")
        } else {
            text.rsplit_once('+').unwrap_or(("", text))
        };
        let key = key.trim();
        if key.is_empty() {
            return Err("Falta la tecla: la combinación termina en «+».".into());
        }

        // Ctrl, Alt, Mayús y Windows, en ese orden.
        let mut on = [false; 4];
        if !modifiers.trim().is_empty() {
            for token in modifiers.split('+').map(str::trim) {
                if token.is_empty() {
                    return Err("Sobra un «+» en la combinación.".into());
                }
                let at = modifier_index(token)
                    .ok_or_else(|| format!("«{token}» no es un modificador: usá Ctrl, Alt, Mayús o Win."))?;
                if std::mem::replace(&mut on[at], true) {
                    return Err(format!("«{token}» está repetido en la combinación."));
                }
            }
        }
        let key = match Key::parse(key) {
            Some(parsed) => parsed,
            None if modifier_index(key).is_some() => {
                return Err("Falta la tecla: la combinación tiene solo modificadores.".into())
            }
            None => {
                return Err(format!(
                    "La tecla «{key}» no se puede usar en un atajo desde cualquier programa: usá una letra, un número, una F, una flecha o un signo común."
                ))
            }
        };
        let [ctrl, alt, shift, win] = on;
        // Mayús sola (o ningún modificador) haría saltar el atajo al escribir.
        if !(ctrl || alt || win) {
            return Err(
                "Sumale Ctrl, Alt o la tecla de Windows: con Mayús sola, o sin ningún modificador, el atajo se activaría al escribir."
                    .into(),
            );
        }
        Ok(Self { ctrl, alt, shift, win, key })
    }

    /// La combinación como se guarda y como la usa la interfaz: «Ctrl+Alt+N».
    pub fn keys(&self) -> String {
        self.joined("Ctrl", "Alt", "Shift", "Super", &self.key.name, "+")
    }

    /// La combinación como se muestra: «Ctrl + Alt + N».
    pub fn display(&self) -> String {
        self.joined("Ctrl", "Alt", "Mayús", "Win", &self.key.label, " + ")
    }

    fn joined(&self, ctrl: &str, alt: &str, shift: &str, win: &str, key: &str, glue: &str) -> String {
        [(self.ctrl, ctrl), (self.alt, alt), (self.shift, shift), (self.win, win)]
            .into_iter()
            .filter(|(on, _)| *on)
            .map(|(_, name)| name)
            .chain([key])
            .collect::<Vec<_>>()
            .join(glue)
    }

    /// Lo que se le pasa al plugin para registrarla.
    pub fn shortcut(&self) -> Shortcut {
        let mut modifiers = Modifiers::empty();
        for (on, modifier) in [
            (self.ctrl, Modifiers::CONTROL),
            (self.alt, Modifiers::ALT),
            (self.shift, Modifiers::SHIFT),
            (self.win, Modifiers::SUPER),
        ] {
            if on {
                modifiers |= modifier;
            }
        }
        Shortcut::new(Some(modifiers), self.key.code)
    }

    /// El código de Windows (virtual-key) de la tecla principal, para saber con
    /// `GetAsyncKeyState` si sigue apretada. Es el mismo con el que el plugin la registra.
    pub fn virtual_key(&self) -> i32 {
        virtual_key_of(self.key.code)
    }
}

/// El virtual-key de Windows de cada tecla que Book acepta en un atajo (las de `Key::parse`).
fn virtual_key_of(code: Code) -> i32 {
    if let Some(at) = LETTERS.iter().position(|&letter| letter == code) {
        return 0x41 + at as i32; // 'A'..'Z'
    }
    if let Some(at) = DIGITS.iter().position(|&digit| digit == code) {
        return 0x30 + at as i32; // '0'..'9'
    }
    if let Some(at) = FUNCTION.iter().position(|&function| function == code) {
        return 0x70 + at as i32; // VK_F1..VK_F24
    }
    match code {
        Code::Enter => 0x0D,
        Code::Escape => 0x1B,
        Code::Tab => 0x09,
        Code::Space => 0x20,
        Code::Backspace => 0x08,
        Code::Delete => 0x2E,
        Code::Insert => 0x2D,
        Code::Home => 0x24,
        Code::End => 0x23,
        Code::PageUp => 0x21,
        Code::PageDown => 0x22,
        Code::ArrowLeft => 0x25,
        Code::ArrowUp => 0x26,
        Code::ArrowRight => 0x27,
        Code::ArrowDown => 0x28,
        Code::Equal => 0xBB,        // VK_OEM_PLUS
        Code::Comma => 0xBC,        // VK_OEM_COMMA
        Code::Minus => 0xBD,        // VK_OEM_MINUS
        Code::Period => 0xBE,       // VK_OEM_PERIOD
        Code::Semicolon => 0xBA,    // VK_OEM_1
        Code::Slash => 0xBF,        // VK_OEM_2
        Code::Backquote => 0xC0,    // VK_OEM_3
        Code::BracketLeft => 0xDB,  // VK_OEM_4
        Code::Backslash => 0xDC,    // VK_OEM_5
        Code::BracketRight => 0xDD, // VK_OEM_6
        Code::Quote => 0xDE,        // VK_OEM_7
        // Book no deja elegir otras; 0 es «ninguna tecla» para GetAsyncKeyState.
        _ => 0,
    }
}

/// Qué modificador es (0 Ctrl, 1 Alt, 2 Mayús, 3 Windows), con los nombres que se les dan.
fn modifier_index(token: &str) -> Option<usize> {
    match token.to_lowercase().as_str() {
        "ctrl" | "control" | "ctl" => Some(0),
        "alt" | "option" => Some(1),
        "shift" | "mayus" | "mayús" => Some(2),
        "super" | "win" | "windows" | "meta" => Some(3),
        _ => None,
    }
}

/// Las combinaciones vigentes de los tres atajos.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keys {
    pub capture: Combo,
    pub open: Combo,
    pub send: Combo,
}

impl Keys {
    /// Las guardadas; la de fábrica donde no hay ninguna (o no sirve).
    pub fn load(db: &Db) -> Self {
        let read = |which: Which| {
            db.get_setting(which.setting()).and_then(|saved| Combo::parse(&saved).ok()).unwrap_or_else(|| which.factory())
        };
        let mut keys = Self { capture: read(Which::Capture), open: read(Which::Open), send: read(Which::Send) };
        // Dos atajos no pueden ser lo mismo (alguien tocó la base a mano): vuelven a su lugar.
        if keys.capture == keys.open || keys.capture == keys.send || keys.open == keys.send {
            keys.capture = Which::Capture.factory();
            keys.open = Which::Open.factory();
            keys.send = Which::Send.factory();
        }
        keys
    }

    pub fn get(&self, which: Which) -> &Combo {
        match which {
            Which::Capture => &self.capture,
            Which::Open => &self.open,
            Which::Send => &self.send,
        }
    }

    fn set(&mut self, which: Which, combo: Combo) {
        match which {
            Which::Capture => self.capture = combo,
            Which::Open => self.open = combo,
            Which::Send => self.send = combo,
        }
    }

    /// Cuál de los atajos es esta combinación, si es alguno.
    pub fn which_is(&self, shortcut: &Shortcut) -> Option<Which> {
        [Which::Capture, Which::Open, Which::Send].into_iter().find(|&which| self.get(which).shortcut() == *shortcut)
    }

    /// Cuál de los otros dos atajos ya usa `wanted`, si lo usa alguno: `which` no puede
    /// quedarse con la combinación de otro.
    fn clash(&self, which: Which, wanted: &Combo) -> Option<Which> {
        which.others().into_iter().find(|&other| self.get(other) == wanted)
    }
}

/// Lo que se necesita del registro del sistema, para poder probar el cambio de un atajo sin
/// registrar nada de verdad.
trait Registry {
    fn try_register(&self, shortcut: Shortcut) -> Result<(), String>;
    fn release(&self, shortcut: Shortcut);
    fn holds(&self, shortcut: Shortcut) -> bool;
}

impl<R: tauri::Runtime> Registry for tauri_plugin_global_shortcut::GlobalShortcut<R> {
    fn try_register(&self, shortcut: Shortcut) -> Result<(), String> {
        self.register(shortcut).map_err(|err| err.to_string())
    }

    fn release(&self, shortcut: Shortcut) {
        let _ = self.unregister(shortcut);
    }

    fn holds(&self, shortcut: Shortcut) -> bool {
        self.is_registered(shortcut)
    }
}

/// Cómo terminó un cambio en el registro.
#[derive(Debug, PartialEq, Eq)]
enum Swap {
    /// Quedó registrada la combinación nueva.
    Changed,
    /// No se pudo registrar (el motivo va aparte); `restored` dice si el atajo anterior
    /// volvió a quedar activo, o si ni siquiera estaba.
    Failed { reason: String, restored: bool },
}

/// Cambia `old` por `wanted` en el registro. `was_active` dice si `old` estaba registrado
/// (puede no estarlo: por ejemplo, si otra aplicación lo tenía). Si la nueva no se deja
/// registrar, se intenta que `old` siga como estaba.
fn swap(registry: &impl Registry, old: &Combo, was_active: bool, wanted: &Combo) -> Swap {
    if was_active {
        // Primero se suelta la anterior: si no, Windows podría rechazar una combinación
        // que difiere en poco, y de todos modos hay que dejar de escucharla.
        registry.release(old.shortcut());
    }
    match registry.try_register(wanted.shortcut()) {
        Ok(()) => Swap::Changed,
        Err(reason) => {
            let restored = was_active && (registry.holds(old.shortcut()) || registry.try_register(old.shortcut()).is_ok());
            Swap::Failed { reason, restored }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn shown_slot(shared: &Shared, which: Which) -> &Mutex<Option<String>> {
    match which {
        Which::Capture => &shared.capture_shortcut,
        Which::Open => &shared.open_shortcut,
        Which::Send => &shared.send_shortcut,
    }
}

/// Registra los tres atajos al iniciar. Si otra aplicación ya usa uno, Book sigue andando
/// sin él. Devuelve cómo mostrar cada uno (`None` si no se pudo registrar), en el orden
/// hoja suelta, cuaderno, enviar.
pub fn register_all(app: &AppHandle, keys: &Keys) -> (Option<String>, Option<String>, Option<String>) {
    let shortcuts = app.global_shortcut();
    let register = |combo: &Combo| shortcuts.register(combo.shortcut()).is_ok().then(|| combo.display());
    (register(&keys.capture), register(&keys.open), register(&keys.send))
}

/// Se apretó un atajo global: hace lo que le toca, según las combinaciones vigentes.
pub fn pressed(app: &AppHandle, shortcut: &Shortcut) {
    let Some(shared) = app.try_state::<Arc<Shared>>() else {
        return;
    };
    let which = lock(&shared.shortcut_keys).which_is(shortcut);
    match which {
        Some(Which::Capture) => crate::open_capture_window(app),
        Some(Which::Open) => crate::toggle_main_window(app),
        // Lo de copiar y escribir no va en este hilo (el de las ventanas): `trigger` lo
        // pasa a uno propio y vuelve enseguida.
        Some(Which::Send) => crate::send::trigger(app),
        None => {}
    }
}

/// Cambia la combinación de un atajo global. Valida y normaliza lo que llega de la
/// interfaz, no deja que los dos atajos sean iguales, suelta el registro anterior y registra
/// el nuevo; si el sistema no lo acepta, el anterior vuelve a quedar como estaba.
pub fn change(app: &AppHandle, shared: &Shared, which: &str, keys: &str) -> Result<(), String> {
    let which = Which::parse(which)?;
    let wanted = Combo::parse(keys)?;
    // De a un cambio por vez. Este candado no lo toma el manejador de las teclas, que corre
    // en el hilo principal mientras el registro lo espera.
    let _turn = lock(&shared.shortcut_change);
    let (old, clash) = {
        let current = lock(&shared.shortcut_keys);
        (current.get(which).clone(), current.clash(which, &wanted))
    };
    if let Some(other) = clash {
        return Err(format!("Esa combinación ya es la de «{}»: elegí otra distinta.", other.label()));
    }
    let slot = shown_slot(shared, which);
    let was_active = lock(slot).is_some();
    if wanted == old && was_active {
        return Ok(());
    }

    let registry = app.global_shortcut();
    match swap(registry, &old, was_active, &wanted) {
        Swap::Changed => {
            if let Err(err) = shared.db.set_setting(which.setting(), &wanted.keys()) {
                // Sin poder guardarlo no vale: todo vuelve a como estaba.
                registry.release(wanted.shortcut());
                let back = was_active && registry.try_register(old.shortcut()).is_ok();
                *lock(slot) = back.then(|| old.display());
                return Err(format!("No se pudo guardar el atajo: {err}."));
            }
            lock(&shared.shortcut_keys).set(which, wanted.clone());
            *lock(slot) = Some(wanted.display());
            Ok(())
        }
        Swap::Failed { reason, restored } => {
            eprintln!("No se pudo registrar el atajo {}: {reason}", wanted.display());
            *lock(slot) = restored.then(|| old.display());
            let message =
                format!("No se pudo activar {}: probablemente otra aplicación ya la usa. Elegí otra combinación.", wanted.display());
            Err(if was_active && !restored {
                format!("{message} Tampoco se pudo volver a activar {}.", old.display())
            } else {
                message
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashSet;
    use std::path::Path;
    use std::str::FromStr;

    use super::*;

    fn combo(text: &str) -> Combo {
        Combo::parse(text).unwrap_or_else(|err| panic!("«{text}» debería servir: {err}"))
    }

    fn rejected(text: &str) -> String {
        Combo::parse(text).err().unwrap_or_else(|| panic!("«{text}» no debería servir"))
    }

    #[test]
    fn las_combinaciones_de_fabrica_son_las_de_siempre() {
        let capture = Which::Capture.factory();
        assert_eq!(capture.keys(), "Ctrl+Alt+N");
        assert_eq!(capture.display(), "Ctrl + Alt + N");
        assert_eq!(capture.shortcut(), Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN));
        let open = Which::Open.factory();
        assert_eq!((open.keys().as_str(), open.display().as_str()), ("Ctrl+Alt+B", "Ctrl + Alt + B"));
        assert_eq!(open.shortcut(), Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyB));
        let send = Which::Send.factory();
        assert_eq!((send.keys().as_str(), send.display().as_str()), ("Ctrl+Alt+X", "Ctrl + Alt + X"));
        assert_eq!(send.shortcut(), Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyX));
    }

    #[test]
    fn las_de_fabrica_no_se_repiten_y_la_de_enviar_no_es_una_letra_de_altgr() {
        let all = [Which::Capture, Which::Open, Which::Send];
        for (at, one) in all.into_iter().enumerate() {
            for other in all.into_iter().skip(at + 1) {
                assert_ne!(one.factory(), other.factory(), "{one:?} y {other:?} tienen la misma de fábrica");
            }
            // Todas pasan por el mismo validador que las que elige el usuario.
            assert_eq!(Combo::parse(&one.factory().keys()).as_ref(), Ok(&one.factory()));
        }
        // Ctrl + Alt es AltGr en los teclados en español. Medido con ToUnicodeEx sobre las
        // distribuciones de Windows: en la de España (KBDSP) escriben algo con AltGr la E
        // («€») y los números del 1 al 6; en la de Latinoamérica (KBDLA), la Q («@»). La tecla
        // de enviar no puede ser ninguna de esas.
        let altgr_letters = ["E", "Q"];
        let altgr_digits = ["1", "2", "3", "4", "5", "6"];
        let send_key = Which::Send.factory().key.name;
        assert!(!altgr_letters.contains(&send_key.as_str()) && !altgr_digits.contains(&send_key.as_str()), "{send_key}");
        // Ni una de las combinaciones de Word y Excel con Ctrl + Alt + letra.
        let office = ["C", "R", "T", "V", "M", "N", "O", "P", "S", "D", "F", "K", "I", "Y", "L"];
        assert!(!office.contains(&send_key.as_str()), "{send_key}");
    }

    #[test]
    fn cada_tecla_que_acepta_book_tiene_su_virtual_key() {
        // Las letras y los números son su código ASCII; las F, VK_F1 (0x70) en adelante.
        assert_eq!(combo("Ctrl+Alt+X").virtual_key(), i32::from(b'X'));
        assert_eq!(combo("Ctrl+Alt+A").virtual_key(), i32::from(b'A'));
        assert_eq!(combo("Ctrl+Alt+Z").virtual_key(), i32::from(b'Z'));
        assert_eq!(combo("Alt+0").virtual_key(), i32::from(b'0'));
        assert_eq!(combo("Alt+9").virtual_key(), i32::from(b'9'));
        assert_eq!(combo("Alt+F1").virtual_key(), 0x70);
        assert_eq!(combo("Alt+F12").virtual_key(), 0x7B);
        assert_eq!(combo("Alt+F24").virtual_key(), 0x87);
        let named = [
            ("Enter", 0x0D),
            ("Escape", 0x1B),
            ("Tab", 0x09),
            ("Space", 0x20),
            ("Backspace", 0x08),
            ("Delete", 0x2E),
            ("Insert", 0x2D),
            ("Home", 0x24),
            ("End", 0x23),
            ("PageUp", 0x21),
            ("PageDown", 0x22),
            ("ArrowLeft", 0x25),
            ("ArrowUp", 0x26),
            ("ArrowRight", 0x27),
            ("ArrowDown", 0x28),
            ("Plus", 0xBB),
            ("Comma", 0xBC),
            ("Minus", 0xBD),
            ("Period", 0xBE),
            (";", 0xBA),
            ("/", 0xBF),
            ("`", 0xC0),
            ("[", 0xDB),
            ("\\", 0xDC),
            ("]", 0xDD),
            ("'", 0xDE),
        ];
        for (name, vk) in named {
            assert_eq!(combo(&format!("Ctrl+Alt+{name}")).virtual_key(), vk, "{name}");
        }
        // Ninguna de las que se pueden elegir queda sin código (0 sería «ninguna tecla»).
        for code in LETTERS.iter().chain(&DIGITS).chain(&FUNCTION).chain(NAMED.iter().map(|(_, code, _)| code)).chain(SIGNS.iter().map(|(_, code)| code)) {
            assert_ne!(virtual_key_of(*code), 0, "{code:?}");
        }
    }

    #[test]
    fn se_normaliza_a_una_sola_forma_de_escribirlas() {
        for same in ["Ctrl+Alt+N", "ctrl+alt+n", "Alt+Ctrl+N", "  Control + Alt + n ", "CTRL+ALT+N", "Ctrl + Alt + N"] {
            assert_eq!(combo(same), combo("Ctrl+Alt+N"), "{same}");
            assert_eq!(combo(same).keys(), "Ctrl+Alt+N");
        }
        // La de la pantalla, con todos los modificadores y en el orden del contrato.
        let all = combo("super+shift+alt+ctrl+f12");
        assert_eq!(all.keys(), "Ctrl+Alt+Shift+Super+F12");
        assert_eq!(all.display(), "Ctrl + Alt + Mayús + Win + F12");
        assert_eq!(combo("Win+Alt+Up").keys(), "Alt+Super+ArrowUp");
        assert_eq!(combo("Mayús+Ctrl+Esc").keys(), "Ctrl+Shift+Escape");
        // Lo que se guarda se vuelve a leer igual.
        assert_eq!(combo(&all.keys()), all);
    }

    #[test]
    fn acepta_letras_numeros_funciones_flechas_y_signos() {
        assert_eq!(combo("Ctrl+Shift+7").shortcut(), Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Digit7));
        assert_eq!(combo("Alt+F1").keys(), "Alt+F1");
        assert_eq!(combo("Alt+F24").keys(), "Alt+F24");
        assert_eq!(combo("Alt+ArrowLeft").display(), "Alt + ←");
        assert_eq!(combo("Ctrl+Alt+PageDown").display(), "Ctrl + Alt + Av Pág");
        assert_eq!(combo("Ctrl+Alt+Space").display(), "Ctrl + Alt + Espacio");
        // El «+», el «-», la coma y el punto, con su nombre o tal cual.
        assert_eq!(combo("Ctrl+Alt+Plus").keys(), "Ctrl+Alt+Plus");
        assert_eq!(combo("Ctrl+Alt++").keys(), "Ctrl+Alt+Plus");
        assert_eq!(combo("Ctrl+Alt+=").keys(), "Ctrl+Alt+Plus");
        assert_eq!(combo("Ctrl+Alt+-").keys(), "Ctrl+Alt+Minus");
        assert_eq!(combo("Ctrl+Alt+,").keys(), "Ctrl+Alt+Comma");
        assert_eq!(combo("Ctrl+Alt+.").keys(), "Ctrl+Alt+Period");
        assert_eq!(combo("Ctrl+Alt+;").keys(), "Ctrl+Alt+;");
        assert_eq!(combo("Ctrl+Alt+\\").shortcut(), Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Backslash));
        // Sola con la tecla de Windows o con Alt también sirve: es un modificador que no es Mayús.
        assert_eq!(combo("Win+Z").keys(), "Super+Z");
        assert_eq!(combo("Alt+Enter").keys(), "Alt+Enter");
    }

    #[test]
    fn cada_tecla_se_traduce_a_la_que_entiende_el_plugin() {
        // Todas las teclas que acepta Book, escritas como las escribe la interfaz, tienen que
        // dar exactamente la misma tecla que el lector de combinaciones del plugin.
        let mut keys: Vec<(String, Code)> = Vec::new();
        keys.extend(LETTERS.iter().enumerate().map(|(n, code)| (((b'A' + n as u8) as char).to_string(), *code)));
        keys.extend(DIGITS.iter().enumerate().map(|(n, code)| (n.to_string(), *code)));
        keys.extend(FUNCTION.iter().enumerate().map(|(n, code)| (format!("F{}", n + 1), *code)));
        keys.extend(NAMED.iter().map(|(name, code, _)| (name.to_string(), *code)));
        keys.extend(SIGNS.iter().map(|(sign, code)| (sign.to_string(), *code)));
        // 26 letras, 10 números, 24 teclas F, 19 con nombre y 7 signos.
        assert_eq!(keys.len(), 86);
        for (name, code) in keys {
            let ours = combo(&format!("Ctrl+Alt+{name}"));
            assert_eq!(ours.key.name, name);
            let theirs = Shortcut::from_str(&format!("Control+Alt+{code}")).unwrap_or_else(|err| panic!("{code}: {err}"));
            assert_eq!(ours.shortcut(), theirs, "{name}");
            assert_eq!(combo(&ours.keys()), ours, "{name}");
        }
    }

    #[test]
    fn exige_un_modificador_que_no_sea_solo_mayus() {
        for bare in ["N", "F5", "Shift+N", "Mayús+F5", "ArrowUp"] {
            assert!(rejected(bare).contains("Sumale Ctrl, Alt o la tecla de Windows"), "{bare}");
        }
    }

    #[test]
    fn rechaza_lo_que_no_es_una_combinacion_con_un_motivo_claro() {
        assert_eq!(rejected(""), "Falta la combinación de teclas.");
        assert_eq!(rejected("   "), "Falta la combinación de teclas.");
        assert!(rejected("Ctrl+Alt+").contains("termina en «+»"));
        assert!(rejected("Ctrl+").contains("Falta la tecla"));
        assert!(rejected("Ctrl+Alt").contains("solo modificadores"));
        assert!(rejected("Ctrl+Alt+Shift").contains("solo modificadores"));
        assert!(rejected("Ctrl+Ctrl+N").contains("«Ctrl» está repetido"));
        assert!(rejected("Ctrl+Alt+Win+Windows+N").contains("repetido"));
        assert!(rejected("Hyper+N").contains("«Hyper» no es un modificador"));
        assert!(rejected("Ctrl++Alt+N").contains("Sobra un «+»"));
        assert!(rejected("+").contains("Sumale Ctrl"));
        assert!(rejected("Ctrl+Alt+F25").contains("«F25»"));
        assert!(rejected("Ctrl+Alt+F0").contains("«F0»"));
        assert!(rejected("Ctrl+Alt+F01").contains("«F01»"));
        assert!(rejected("Ctrl+Alt+NN").contains("«NN»"));
        assert!(rejected("Ctrl+Alt+ñ").contains("«ñ»"));
        assert!(rejected("Ctrl+Alt+Numpad5").contains("«Numpad5»"));
        // Todo en castellano y sin restos de la maquinaria.
        for bad in ["", "N", "Ctrl+Alt", "Hyper+N", "Ctrl+Alt+F25"] {
            let reason = rejected(bad);
            assert!(reason.ends_with('.'), "{reason}");
            assert!(!reason.to_lowercase().contains("hotkey"), "{reason}");
        }
    }

    #[test]
    fn el_nombre_del_atajo_de_la_interfaz_se_lee_o_se_rechaza() {
        assert_eq!(Which::parse("capture"), Ok(Which::Capture));
        assert_eq!(Which::parse("open"), Ok(Which::Open));
        assert_eq!(Which::parse("send"), Ok(Which::Send));
        assert_eq!(Which::Capture.others(), [Which::Open, Which::Send]);
        assert_eq!(Which::Open.others(), [Which::Capture, Which::Send]);
        assert_eq!(Which::Send.others(), [Which::Capture, Which::Open]);
        assert!(Which::parse("Capture").is_err());
        assert!(Which::parse("Send").is_err());
        assert!(Which::parse("").unwrap_err().contains("no es un atajo de Folio"));
    }

    /// Las tres combinaciones vigentes, como las guarda la base.
    fn trio(keys: &Keys) -> (String, String, String) {
        (keys.capture.keys(), keys.open.keys(), keys.send.keys())
    }

    #[test]
    fn las_combinaciones_guardadas_se_leen_y_las_rotas_vuelven_a_la_de_fabrica() {
        let db = Db::open(Path::new(":memory:")).unwrap();
        let (capture, open, send) = ("Ctrl+Alt+N", "Ctrl+Alt+B", "Ctrl+Alt+X");
        let same = |keys: &Keys, expected: (&str, &str, &str)| {
            assert_eq!(trio(keys), (expected.0.to_string(), expected.1.to_string(), expected.2.to_string()));
        };
        // Sin nada guardado: las de siempre.
        same(&Keys::load(&db), (capture, open, send));

        db.set_setting("capture_keys", "Ctrl+Shift+J").unwrap();
        db.set_setting("open_keys", "alt+win+k").unwrap();
        db.set_setting("send_keys", "Ctrl+Shift+Y").unwrap();
        same(&Keys::load(&db), ("Ctrl+Shift+J", "Alt+Super+K", "Ctrl+Shift+Y"));

        // Una combinación rota no se carga; las otras se respetan.
        db.set_setting("capture_keys", "esto no es un atajo").unwrap();
        db.set_setting("send_keys", "Ctrl+Alt+").unwrap();
        same(&Keys::load(&db), (capture, "Alt+Super+K", send));

        // Dos iguales (alguien tocó la base a mano), sean cuales sean: vuelven todas a las de fábrica.
        db.set_setting("capture_keys", "Alt+Super+K").unwrap();
        same(&Keys::load(&db), (capture, open, send));
        db.set_setting("capture_keys", "Ctrl+Shift+J").unwrap();
        db.set_setting("send_keys", "ctrl+shift+j").unwrap();
        same(&Keys::load(&db), (capture, open, send));
        db.set_setting("send_keys", "Alt+Super+K").unwrap();
        same(&Keys::load(&db), (capture, open, send));
    }

    #[test]
    fn el_atajo_de_enviar_no_puede_repetir_a_los_otros_dos_ni_ellos_a_el() {
        let keys = Keys {
            capture: combo("Ctrl+Alt+N"),
            open: combo("Ctrl+Alt+B"),
            send: combo("Ctrl+Alt+X"),
        };
        // Enviar no puede quedarse con la de la hoja suelta ni con la del cuaderno...
        assert_eq!(keys.clash(Which::Send, &combo("alt+ctrl+n")), Some(Which::Capture));
        assert_eq!(keys.clash(Which::Send, &combo("Ctrl+Alt+B")), Some(Which::Open));
        // ...y ninguno de esos dos puede quedarse con la de enviar.
        assert_eq!(keys.clash(Which::Capture, &combo("Ctrl+Alt+X")), Some(Which::Send));
        assert_eq!(keys.clash(Which::Open, &combo("Ctrl + Alt + X")), Some(Which::Send));
        // Quedarse con la que ya tiene no es un choque, ni lo es una libre.
        assert_eq!(keys.clash(Which::Send, &combo("Ctrl+Alt+X")), None);
        assert_eq!(keys.clash(Which::Send, &combo("Ctrl+Shift+X")), None);
        // Y se reconoce cuál se apretó.
        assert_eq!(keys.which_is(&combo("Ctrl+Alt+X").shortcut()), Some(Which::Send));
        assert_eq!(keys.which_is(&combo("Ctrl+Alt+N").shortcut()), Some(Which::Capture));
        assert_eq!(keys.which_is(&combo("Ctrl+Alt+B").shortcut()), Some(Which::Open));
        assert_eq!(keys.which_is(&combo("Ctrl+Alt+Z").shortcut()), None);
    }

    #[test]
    fn la_combinacion_de_enviar_pasa_por_el_mismo_validador() {
        // Una letra sola o con Mayús sola activaría el atajo al escribir; lo que no es una tecla, tampoco.
        assert!(rejected("X").contains("Sumale Ctrl, Alt"));
        assert!(rejected("Shift+X").contains("Sumale Ctrl, Alt"));
        assert!(rejected("Ctrl+Alt+ñ").contains("«ñ»"));
        // Se guarda en la forma de siempre aunque se escriba de otra.
        assert_eq!(combo("alt + control + x").keys(), "Ctrl+Alt+X");
        assert_eq!(combo("Win+X").keys(), "Super+X");
    }

    /// Un registro de mentira: lo que Book tiene registrado y lo que tienen otros programas.
    #[derive(Default)]
    struct Fake {
        mine: RefCell<HashSet<u32>>,
        others: HashSet<u32>,
    }

    impl Fake {
        fn taken_by_others(keys: &[&str]) -> Self {
            Self { mine: RefCell::default(), others: keys.iter().map(|text| combo(text).shortcut().id()).collect() }
        }

        fn has(&self, text: &str) -> bool {
            self.mine.borrow().contains(&combo(text).shortcut().id())
        }
    }

    impl Registry for Fake {
        fn try_register(&self, shortcut: Shortcut) -> Result<(), String> {
            if self.others.contains(&shortcut.id()) || !self.mine.borrow_mut().insert(shortcut.id()) {
                return Err("ya está registrada".into());
            }
            Ok(())
        }

        fn release(&self, shortcut: Shortcut) {
            self.mine.borrow_mut().remove(&shortcut.id());
        }

        fn holds(&self, shortcut: Shortcut) -> bool {
            self.mine.borrow().contains(&shortcut.id())
        }
    }

    #[test]
    fn cambiar_un_atajo_suelta_el_anterior_y_registra_el_nuevo() {
        let registry = Fake::default();
        let (old, new) = (combo("Ctrl+Alt+N"), combo("Ctrl+Shift+J"));
        registry.try_register(old.shortcut()).unwrap();
        assert_eq!(swap(&registry, &old, true, &new), Swap::Changed);
        assert!(registry.has("Ctrl+Shift+J"));
        assert!(!registry.has("Ctrl+Alt+N"), "el anterior ya no escucha");
    }

    #[test]
    fn si_otro_programa_ya_usa_la_combinacion_el_anterior_sigue_andando() {
        let registry = Fake::taken_by_others(&["Ctrl+Shift+J"]);
        let (old, taken) = (combo("Ctrl+Alt+N"), combo("Ctrl+Shift+J"));
        registry.try_register(old.shortcut()).unwrap();
        match swap(&registry, &old, true, &taken) {
            Swap::Failed { restored, .. } => assert!(restored),
            other => panic!("debería haber fallado: {other:?}"),
        }
        assert!(registry.has("Ctrl+Alt+N"), "la de antes quedó registrada otra vez");
        assert!(!registry.has("Ctrl+Shift+J"));
    }

    #[test]
    fn si_el_anterior_no_estaba_registrado_no_se_inventa_uno() {
        // El atajo estaba tomado por otro programa desde el inicio (no estaba registrado) y se
        // prueba con una combinación que tampoco se deja: sigue sin haber ninguno.
        let registry = Fake::taken_by_others(&["Ctrl+Alt+N", "Ctrl+Shift+J"]);
        let (old, taken) = (combo("Ctrl+Alt+N"), combo("Ctrl+Shift+J"));
        match swap(&registry, &old, false, &taken) {
            Swap::Failed { restored, .. } => assert!(!restored),
            other => panic!("debería haber fallado: {other:?}"),
        }
        assert!(!registry.has("Ctrl+Alt+N"));
        // Y si ahora el otro programa lo soltara, volver a elegir la misma combinación la registra.
        let free = Fake::default();
        assert_eq!(swap(&free, &old, false, &old), Swap::Changed);
        assert!(free.has("Ctrl+Alt+N"));
    }
}
