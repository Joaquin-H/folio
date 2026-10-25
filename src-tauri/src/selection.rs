//! Copiar lo que está seleccionado en el programa que está al frente, para el atajo
//! «Enviar lo seleccionado al Book».
//!
//! No hay una forma general de preguntarle a otro programa qué tiene seleccionado: lo que
//! funciona en todos es lo que haría una persona. Book espera a que se suelten las teclas del
//! atajo (si no, el Ctrl+C simulado llegaría como Ctrl+Alt+C), guarda lo que hay en el
//! portapapeles, aprieta Ctrl+C por el teclado del sistema (`SendInput`), espera a que el
//! portapapeles cambie, lee el texto y, si lo que había era solo texto, lo devuelve. Anota
//! también de dónde vino: el título de la ventana y el nombre del programa.
//!
//! La parte que no depende de Windows (la espera con un reloj que se puede inyectar, qué
//! teclas esperar, si conviene devolver el portapapeles, qué combinación usar en una
//! terminal, el nombre del programa y el título limpio) está aparte y se prueba; el resto es
//! FFI con Windows, declarada a mano.
#![cfg_attr(not(windows), allow(dead_code))]

use std::time::{Duration, Instant};

/// Cuánto se espera, como mucho, a que se suelten las teclas del atajo.
#[allow(dead_code)]
pub const RELEASE_LIMIT: Duration = Duration::from_millis(1500);
/// Cada cuánto se mira si ya se soltaron.
#[allow(dead_code)]
pub const RELEASE_STEP: Duration = Duration::from_millis(10);
/// Cuánto se espera, como mucho, a que el programa de al frente copie.
#[allow(dead_code)]
pub const COPY_LIMIT: Duration = Duration::from_millis(700);
/// Cada cuánto se mira si el portapapeles cambió.
#[allow(dead_code)]
pub const COPY_STEP: Duration = Duration::from_millis(15);

/// El reloj y las pausas de las esperas. Con uno de mentira, las pruebas no esperan de verdad.
pub trait Clock {
    /// Cuánto pasó desde un momento cualquiera (siempre el mismo).
    fn now(&self) -> Duration;
    fn pause(&self, how_long: Duration);
}

/// El reloj de verdad.
pub struct Wall(Instant);

impl Wall {
    pub fn start() -> Self {
        Self(Instant::now())
    }
}

impl Clock for Wall {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }

    fn pause(&self, how_long: Duration) {
        std::thread::sleep(how_long);
    }
}

/// Mira `done` cada `step` hasta que dé `true` o pasen `limit`. Devuelve si se cumplió. Se
/// mira una última vez justo al llegar al tope, y una sola vez si ya estaba cumplido.
pub fn wait_until(clock: &impl Clock, limit: Duration, step: Duration, mut done: impl FnMut() -> bool) -> bool {
    let start = clock.now();
    loop {
        if done() {
            return true;
        }
        if clock.now().saturating_sub(start) >= limit {
            return false;
        }
        clock.pause(step);
    }
}

const VK_SHIFT: i32 = 0x10;
const VK_CONTROL: i32 = 0x11;
const VK_MENU: i32 = 0x12;
const VK_LWIN: i32 = 0x5B;
const VK_RWIN: i32 = 0x5C;

/// Las teclas que tienen que estar sueltas antes de simular el Ctrl+C: la principal del
/// atajo y los cuatro modificadores, sean o no parte de la combinación (un Mayús que se
/// quedó apretado lo convertiría en Ctrl+Mayús+C, que en un navegador abre las herramientas
/// de desarrollo).
#[allow(dead_code)]
pub fn keys_to_release(main: i32) -> Vec<i32> {
    let mut keys = vec![VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN];
    if main != 0 && !keys.contains(&main) {
        keys.push(main);
    }
    keys
}

/// Lo que hay que hacer con el portapapeles original después de copiar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restore {
    /// Estaba vacío: se lo vuelve a vaciar.
    Empty,
    /// Era solo texto: se lo vuelve a dejar como estaba.
    Text,
    /// Tenía algo más que texto (una imagen, archivos, HTML, un formato de otro programa) o
    /// no se pudo leer. Devolver solo el texto lo pisaría con algo incompleto, así que se
    /// deja lo que se copió.
    Keep,
}

const CF_TEXT: u32 = 1;
const CF_OEMTEXT: u32 = 7;
const CF_UNICODETEXT: u32 = 13;
const CF_LOCALE: u32 = 16;

/// Decide qué hacer con el portapapeles original según los formatos que tenía. Cuando
/// alguien copia texto, Windows ofrece solo texto en sus tres variantes (CF_TEXT,
/// CF_OEMTEXT y CF_UNICODETEXT, que arma él a partir de una) y el idioma (CF_LOCALE): eso se
/// puede devolver entero con un único texto Unicode. Cualquier otro formato, no.
pub fn plan(formats: &[u32]) -> Restore {
    if formats.is_empty() {
        return Restore::Empty;
    }
    let only_text = formats.iter().all(|format| matches!(*format, CF_TEXT | CF_OEMTEXT | CF_UNICODETEXT | CF_LOCALE));
    if only_text && formats.contains(&CF_UNICODETEXT) {
        Restore::Text
    } else {
        Restore::Keep
    }
}

/// Qué combinación usar para copiar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chord {
    /// Ctrl+C, la de todos los programas.
    CtrlC,
    /// Ctrl+Insertar: la otra combinación de copiar de Windows. En una terminal, Ctrl+C
    /// interrumpe el programa que esté corriendo si no hay nada seleccionado.
    CtrlInsert,
}

/// Clases de ventana de terminales y consolas.
const TERMINAL_CLASSES: &[&str] = &[
    "ConsoleWindowClass",
    "CASCADIA_HOSTING_WINDOW_CLASS",
    "PseudoConsoleWindow",
    "VirtualConsoleClass",
    "mintty",
    "PuTTY",
];

/// Programas de terminal, por el nombre de su ejecutable (sin `.exe`, en minúsculas).
const TERMINAL_PROGRAMS: &[&str] = &[
    "windowsterminal",
    "wt",
    "cmd",
    "powershell",
    "powershell_ise",
    "pwsh",
    "conhost",
    "openconsole",
    "mintty",
    "putty",
    "kitty",
    "alacritty",
    "wezterm-gui",
    "hyper",
    "tabby",
    "conemu",
    "conemu64",
    "cmder",
];

/// Lo que se sabe de la ventana que está al frente.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Window {
    pub title: String,
    /// El nombre de su clase de ventana.
    pub class: String,
    /// La ruta del ejecutable del programa.
    pub image: String,
}

/// De dónde vino un recorte: el programa y el título de su ventana, ya limpios.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Source {
    pub program: String,
    pub title: String,
}

/// El nombre del ejecutable, sin carpeta ni `.exe`.
fn file_stem(image: &str) -> &str {
    let name = image.rsplit(['\\', '/']).next().unwrap_or("");
    match name.len().checked_sub(4) {
        Some(at) if name.is_char_boundary(at) && name[at..].eq_ignore_ascii_case(".exe") => &name[..at],
        _ => name,
    }
}

/// Lo mismo, en minúsculas: con lo que se comparan las listas.
fn stem_of(image: &str) -> String {
    file_stem(image).to_lowercase()
}

/// Cómo se llama, para una persona, el programa de los ejecutables más comunes. El resto se
/// muestra con el nombre del archivo y la inicial en mayúscula.
const KNOWN: &[(&str, &str)] = &[
    ("chrome", "Chrome"),
    ("msedge", "Edge"),
    ("firefox", "Firefox"),
    ("brave", "Brave"),
    ("opera", "Opera"),
    ("vivaldi", "Vivaldi"),
    ("winword", "Word"),
    ("excel", "Excel"),
    ("powerpnt", "PowerPoint"),
    ("outlook", "Outlook"),
    ("onenote", "OneNote"),
    ("notepad", "Bloc de notas"),
    ("wordpad", "WordPad"),
    ("code", "Visual Studio Code"),
    ("explorer", "Explorador de archivos"),
    ("windowsterminal", "Terminal"),
    ("acrobat", "Acrobat"),
    ("acrord32", "Acrobat Reader"),
    ("sumatrapdf", "SumatraPDF"),
    ("soffice", "LibreOffice"),
    ("ms-teams", "Teams"),
    ("teams", "Teams"),
];

/// El nombre del programa tal como se ve en el encabezado de un recorte.
fn friendly_program(image: &str) -> String {
    if let Some((_, name)) = KNOWN.iter().find(|(known, _)| *known == stem_of(image)) {
        return (*name).to_string();
    }
    let mut chars = file_stem(image).chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// Letras y números en minúscula, nada más: para comparar nombres sin importar espacios ni signos.
fn squashed(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Un solo renglón: los saltos y las tabulaciones pasan a espacios, sin repetidos ni en los bordes.
fn one_line(text: &str) -> String {
    text.split(|c: char| c.is_whitespace() || c.is_control()).filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ")
}

/// Cuántos caracteres de un título de ventana se conservan.
const TITLE_MAX: usize = 100;

/// El título de la ventana sin lo que agrega el programa al final. Los navegadores y los
/// editores terminan el título con su nombre («Una página - Google Chrome», «Sin título -
/// Bloc de notas»): el programa ya va aparte en el encabezado.
fn clean_title(title: &str, names: &[&str]) -> String {
    let title = one_line(title);
    let cut = [" - ", " – ", " — "].into_iter().filter_map(|sep| title.rfind(sep).map(|at| (at, sep.len()))).max();
    let kept = match cut {
        Some((at, len)) => {
            let tail = squashed(&title[at + len..]);
            let is_app = tail.chars().count() >= 3
                && names.iter().map(|name| squashed(name)).any(|name| name.chars().count() >= 3 && (tail.contains(&name) || name.contains(&tail)));
            if is_app { title[..at].trim_end().to_string() } else { title }
        }
        None => title,
    };
    if kept.chars().count() > TITLE_MAX {
        let head: String = kept.chars().take(TITLE_MAX).collect();
        format!("{}…", head.trim_end())
    } else {
        kept
    }
}

impl Window {
    pub fn source(&self) -> Source {
        let program = friendly_program(&self.image);
        let stem = stem_of(&self.image);
        Source { title: clean_title(&self.title, &[program.as_str(), stem.as_str()]), program }
    }

    /// Cómo copiar desde esta ventana: Ctrl+C, salvo en las terminales.
    pub fn chord(&self) -> Chord {
        let stem = stem_of(&self.image);
        let terminal = TERMINAL_CLASSES.iter().any(|class| class.eq_ignore_ascii_case(&self.class))
            || TERMINAL_PROGRAMS.contains(&stem.as_str());
        if terminal { Chord::CtrlInsert } else { Chord::CtrlC }
    }
}

/// Lo que se copió y de dónde.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clip {
    pub text: String,
    pub source: Source,
}

/// Por qué no se pudo copiar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fail {
    /// El programa de al frente no copió nada, o lo copiado no era texto.
    NoSelection,
    /// Siguen apretadas las teclas del atajo.
    #[allow(dead_code)]
    Held,
    /// El sistema no dejó mandar las teclas.
    Blocked,
    /// No se pudo abrir el portapapeles.
    #[allow(dead_code)]
    Clipboard,
    /// Este sistema no es Windows.
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
}

impl Fail {
    pub fn message_for(self, en: bool) -> &'static str {
        if en {
            match self {
                Self::NoSelection => "No text was selected.",
                Self::Held => "Release the shortcut keys so Folio can copy what’s selected.",
                Self::Blocked => "That program won’t let Folio send keys to it (is it running as administrator?).",
                Self::Clipboard => "Couldn’t read the clipboard: another program is using it.",
                Self::Unsupported => "Send selection only works on Windows.",
            }
        } else {
            match self {
                Self::NoSelection => "No había texto seleccionado.",
                Self::Held => "Soltá las teclas del atajo para que Folio pueda copiar lo seleccionado.",
                Self::Blocked => "Ese programa no deja que Folio le mande teclas (¿está abierto como administrador?).",
                Self::Clipboard => "No se pudo leer el portapapeles: otro programa lo tiene ocupado.",
                Self::Unsupported => "Enviar lo seleccionado solo funciona en Windows.",
            }
        }
    }

    pub fn message(self) -> &'static str {
        self.message_for(false)
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::mem::size_of;

    #[allow(unused_imports)]
    use super::{
        plan, wait_until, Chord, Clip, Clock, Fail, Restore, Window, COPY_LIMIT, COPY_STEP, CF_UNICODETEXT, RELEASE_LIMIT,
        RELEASE_STEP,
    };

    type Hwnd = isize;

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> Hwnd;
        fn GetWindowTextW(hwnd: Hwnd, text: *mut u16, max: i32) -> i32;
        fn GetClassNameW(hwnd: Hwnd, name: *mut u16, max: i32) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, process: *mut u32) -> u32;
        fn GetAsyncKeyState(key: i32) -> i16;
        fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
        fn MapVirtualKeyW(code: u32, kind: u32) -> u32;
        fn OpenClipboard(owner: Hwnd) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn EnumClipboardFormats(format: u32) -> u32;
        fn GetClipboardData(format: u32) -> isize;
        fn SetClipboardData(format: u32, memory: isize) -> isize;
        fn GetClipboardSequenceNumber() -> u32;
        #[allow(clippy::too_many_arguments)]
        fn CreateWindowExW(
            ex_style: u32,
            class_name: *const u16,
            window_name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            parent: Hwnd,
            menu: isize,
            instance: isize,
            param: *mut c_void,
        ) -> Hwnd;
        #[allow(dead_code)]
        fn DestroyWindow(hwnd: Hwnd) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> isize;
        fn GlobalLock(memory: isize) -> *mut c_void;
        fn GlobalUnlock(memory: isize) -> i32;
        fn GlobalSize(memory: isize) -> usize;
        fn GlobalFree(memory: isize) -> isize;
        fn OpenProcess(access: u32, inherit: i32, process: u32) -> isize;
        fn QueryFullProcessImageNameW(process: isize, flags: u32, name: *mut u16, size: *mut u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
        fn GetModuleHandleW(name: *const u16) -> isize;
    }

    /// `KEYBDINPUT` en 64 bits: wVk, wScan, dwFlags, time y dwExtraInfo (24 bytes).
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub(super) struct KeyboardInput {
        vk: u16,
        scan: u16,
        flags: u32,
        time: u32,
        extra: usize,
    }

    /// `MOUSEINPUT`: no se usa, pero es el miembro más grande de la unión de `INPUT` y le
    /// da su tamaño (32 bytes en 64 bits). Sin él, `SendInput` rechazaría `cbSize`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub(super) struct MouseInput {
        dx: i32,
        dy: i32,
        data: u32,
        flags: u32,
        time: u32,
        extra: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub(super) union InputUnion {
        pub(super) keyboard: KeyboardInput,
        pub(super) mouse: MouseInput,
    }

    /// `INPUT`: el tipo (4 bytes, más 4 de relleno en 64 bits) y la unión. 40 bytes en 64 bits
    /// y 28 en 32.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub(super) struct Input {
        pub(super) kind: u32,
        pub(super) data: InputUnion,
    }

    const INPUT_KEYBOARD: u32 = 1;
    const KEYEVENTF_EXTENDEDKEY: u32 = 0x0001;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const VK_CONTROL: u16 = 0x11;
    const VK_C: u16 = 0x43;
    const VK_INSERT: u16 = 0x2D;
    const VK_LWIN: u16 = 0x5B;
    const VK_H: u16 = 0x48;
    const MAPVK_VK_TO_VSC: u32 = 0;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const GMEM_MOVEABLE: u32 = 0x0002;
    /// Ventana sin nada para ver, que solo sirve de dueña del portapapeles: `HWND_MESSAGE`.
    const HWND_MESSAGE: Hwnd = -3;
    /// Cuánto se insiste, como mucho, para abrir el portapapeles (otro programa puede tenerlo abierto).
    const OPEN_LIMIT: std::time::Duration = std::time::Duration::from_millis(250);
    const OPEN_STEP: std::time::Duration = std::time::Duration::from_millis(10);
    /// Lo que se espera a que el programa de al frente termine de dejar todo en el portapapeles.
    #[allow(dead_code)]
    const SETTLE_STEP: std::time::Duration = std::time::Duration::from_millis(25);
    #[allow(dead_code)]
    const SETTLE_TRIES: u32 = 6;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn key_event(vk: u16, up: bool, extended: bool) -> Input {
        // SAFETY: consulta pura de una tabla del sistema.
        let scan = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) } as u16;
        let flags = (if up { KEYEVENTF_KEYUP } else { 0 }) | (if extended { KEYEVENTF_EXTENDEDKEY } else { 0 });
        Input { kind: INPUT_KEYBOARD, data: InputUnion { keyboard: KeyboardInput { vk, scan, flags, time: 0, extra: 0 } } }
    }

    /// Aprieta la combinación de copiar por el teclado del sistema. `false` si Windows no la
    /// aceptó entera.
    fn press(chord: Chord) -> bool {
        let (key, extended) = match chord {
            Chord::CtrlC => (VK_C, false),
            Chord::CtrlInsert => (VK_INSERT, true),
        };

        // 1. Enviar [key_event(VK_CONTROL, false, false)] (Ctrl down).
        let ctrl_down = [key_event(VK_CONTROL, false, false)];
        let sent1 = unsafe { SendInput(ctrl_down.len() as u32, ctrl_down.as_ptr(), size_of::<Input>() as i32) };
        if sent1 as usize != ctrl_down.len() {
            let release = [key_event(VK_CONTROL, true, false)];
            unsafe { SendInput(release.len() as u32, release.as_ptr(), size_of::<Input>() as i32) };
            return false;
        }

        // 2. Dormir 15 ms.
        std::thread::sleep(std::time::Duration::from_millis(15));

        // 3. Enviar [key_event(key, false, extended), key_event(key, true, extended)] (C down + C up).
        let key_stroke = [key_event(key, false, extended), key_event(key, true, extended)];
        let sent2 = unsafe { SendInput(key_stroke.len() as u32, key_stroke.as_ptr(), size_of::<Input>() as i32) };

        // 4. Dormir 15 ms.
        std::thread::sleep(std::time::Duration::from_millis(15));

        // 5. Enviar [key_event(VK_CONTROL, true, false)] (Ctrl up).
        let ctrl_up = [key_event(VK_CONTROL, true, false)];
        let sent3 = unsafe { SendInput(ctrl_up.len() as u32, ctrl_up.as_ptr(), size_of::<Input>() as i32) };

        if sent2 as usize != key_stroke.len() || sent3 as usize != ctrl_up.len() {
            // A medias (por ejemplo, otro programa mandó teclas en el mismo instante): se sueltan las
            // dos teclas para que Ctrl no quede apretada.
            let release = [key_event(key, true, extended), key_event(VK_CONTROL, true, false)];
            unsafe { SendInput(release.len() as u32, release.as_ptr(), size_of::<Input>() as i32) };
            return false;
        }
        true
    }

    fn is_down(vk: i32) -> bool {
        // SAFETY: consulta del estado de una tecla; cualquier número es válido.
        unsafe { GetAsyncKeyState(vk) < 0 }
    }

    fn sequence() -> u32 {
        // SAFETY: sin argumentos ni efectos.
        unsafe { GetClipboardSequenceNumber() }
    }

    /// La ventana que está al frente: título, clase y ejecutable.
    fn foreground() -> Window {
        // SAFETY: llamadas de consulta con punteros a buffers propios y del tamaño que se dice.
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd == 0 {
                return Window::default();
            }
            let mut title = [0u16; 512];
            let length = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32).clamp(0, title.len() as i32);
            let mut class = [0u16; 256];
            let class_length = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32).clamp(0, class.len() as i32);
            Window {
                title: String::from_utf16_lossy(&title[..length as usize]),
                class: String::from_utf16_lossy(&class[..class_length as usize]),
                image: image_of(hwnd),
            }
        }
    }

    /// La ruta del ejecutable dueño de esa ventana, o vacía si Windows no la da.
    ///
    /// # Safety
    /// `hwnd` puede ser cualquier número: si no es una ventana, Windows responde con 0.
    unsafe fn image_of(hwnd: Hwnd) -> String {
        let mut process = 0u32;
        GetWindowThreadProcessId(hwnd, &mut process);
        if process == 0 {
            return String::new();
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process);
        if handle == 0 {
            return String::new();
        }
        let mut name = [0u16; 1024];
        let mut size = name.len() as u32;
        let found = QueryFullProcessImageNameW(handle, 0, name.as_mut_ptr(), &mut size) != 0;
        CloseHandle(handle);
        if found {
            String::from_utf16_lossy(&name[..(size as usize).min(name.len())])
        } else {
            String::new()
        }
    }

    /// El portapapeles abierto por este hilo; se cierra solo.
    struct Open;

    impl Open {
        /// Lo abre, insistiendo un rato: mientras otro programa lo tiene abierto, no se puede.
        fn acquire(owner: Hwnd, clock: &impl Clock) -> Option<Self> {
            // SAFETY: `OpenClipboard` acepta 0 (sin dueño) o una ventana de este hilo.
            wait_until(clock, OPEN_LIMIT, OPEN_STEP, || unsafe { OpenClipboard(owner) } != 0).then_some(Self)
        }

        /// Los formatos que ofrece ahora, en el orden del portapapeles.
        fn formats(&self) -> Vec<u32> {
            let mut formats = Vec::new();
            let mut format = 0;
            loop {
                // SAFETY: el portapapeles está abierto por este hilo (`Open` existe).
                format = unsafe { EnumClipboardFormats(format) };
                // 0 es el final de la lista (o un error); el tope evita un bucle sin fin.
                if format == 0 || formats.len() >= 1024 {
                    return formats;
                }
                formats.push(format);
            }
        }

        /// El texto Unicode, si lo hay. El portapapeles es el dueño de esa memoria: se la
        /// bloquea para leerla y se la suelta, pero no se libera.
        fn text(&self) -> Option<String> {
            // SAFETY: el portapapeles está abierto. `handle` es una memoria global del
            // sistema; se lee solo dentro de lo que dice `GlobalSize`, y se desbloquea.
            unsafe {
                let handle = GetClipboardData(CF_UNICODETEXT);
                if handle == 0 {
                    return None;
                }
                let bytes = GlobalSize(handle);
                let pointer = GlobalLock(handle) as *const u16;
                if pointer.is_null() {
                    return None;
                }
                // Un texto Unicode termina en 0; si por algo no lo trae, termina donde la memoria.
                let units = std::slice::from_raw_parts(pointer, bytes / 2);
                let end = units.iter().position(|&unit| unit == 0).unwrap_or(units.len());
                let text = String::from_utf16_lossy(&units[..end]);
                GlobalUnlock(handle);
                Some(text)
            }
        }

        fn clear(&self) -> bool {
            // SAFETY: el portapapeles está abierto por este hilo.
            unsafe { EmptyClipboard() != 0 }
        }

        /// Deja ese texto, y solo ese, en el portapapeles. Hace falta que se haya abierto con
        /// una ventana dueña (`Owner`): con 0, `SetClipboardData` falla después de vaciar.
        fn put_text(&self, text: &str) -> bool {
            let units = wide(text);
            let bytes = units.len() * 2;
            // SAFETY: la memoria se pide movible, se bloquea para escribirla y se desbloquea. Si
            // `SetClipboardData` la acepta, pasa a ser del sistema y no se toca más; si no, se
            // libera acá.
            unsafe {
                let memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
                if memory == 0 {
                    return false;
                }
                let pointer = GlobalLock(memory) as *mut u16;
                if pointer.is_null() {
                    GlobalFree(memory);
                    return false;
                }
                std::ptr::copy_nonoverlapping(units.as_ptr(), pointer, units.len());
                GlobalUnlock(memory);
                if EmptyClipboard() == 0 || SetClipboardData(CF_UNICODETEXT, memory) == 0 {
                    GlobalFree(memory);
                    return false;
                }
                true
            }
        }
    }

    impl Drop for Open {
        fn drop(&mut self) {
            // SAFETY: este hilo abrió el portapapeles.
            unsafe { CloseClipboard() };
        }
    }

    /// Una ventana invisible que hace de dueña del portapapeles mientras se lo restaura.
    #[allow(dead_code)]
    struct Owner(Hwnd);

    #[allow(dead_code)]
    impl Owner {
        fn create() -> Option<Self> {
            let class = wide("STATIC");
            // SAFETY: crea una ventana de mensajes con una clase que ya existe en el sistema.
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    std::ptr::null(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    0,
                    GetModuleHandleW(std::ptr::null()),
                    std::ptr::null_mut(),
                )
            };
            (hwnd != 0).then_some(Self(hwnd))
        }
    }

    impl Drop for Owner {
        fn drop(&mut self) {
            // SAFETY: la ventana es de este hilo, que es quien la destruye.
            unsafe { DestroyWindow(self.0) };
        }
    }

    /// Lo que había en el portapapeles antes de copiar.
    #[allow(dead_code)]
    struct Before {
        plan: Restore,
        text: Option<String>,
    }

    #[allow(dead_code)]
    impl Before {
        fn take(clock: &impl Clock) -> Self {
            let (plan_now, text) = match Open::acquire(0, clock) {
                Some(clipboard) => {
                    let plan_now = plan(&clipboard.formats());
                    let text = if plan_now == Restore::Text { clipboard.text() } else { None };
                    // Era texto pero no se pudo leer: no hay nada que devolver.
                    let plan_now = if plan_now == Restore::Text && text.is_none() { Restore::Keep } else { plan_now };
                    (plan_now, text)
                }
                None => (Restore::Keep, None),
            };
            Self { plan: plan_now, text }
        }

        /// Deja el portapapeles como estaba, si se puede y si nadie lo tocó mientras tanto.
        /// `copied` es el número de secuencia que dejó la copia.
        fn put_back(&self, copied: u32, clock: &impl Clock) {
            if sequence() != copied {
                return;
            }
            match (self.plan, &self.text) {
                (Restore::Keep, _) | (Restore::Text, None) => {}
                (Restore::Empty, _) => {
                    let owner = Owner::create();
                    if let Some(clipboard) = Open::acquire(owner.as_ref().map_or(0, |owner| owner.0), clock) {
                        clipboard.clear();
                    }
                }
                (Restore::Text, Some(text)) => {
                    let owner = Owner::create();
                    if let Some(clipboard) = Open::acquire(owner.as_ref().map_or(0, |owner| owner.0), clock) {
                        clipboard.put_text(text);
                    }
                }
            }
        }
    }

    pub fn copy_selection(main_key: i32, alt: bool, shift: bool, win: bool, clock: &impl Clock) -> Result<Clip, Fail> {
        // De dónde viene, antes que nada: la ventana de al frente puede cambiar mientras se opera.
        let window = foreground();

        // Guarda el texto actual del portapapeles y el número de secuencia antes de simular teclas.
        let fallback_text = Open::acquire(0, clock)
            .and_then(|cb| cb.text())
            .filter(|t| !t.trim().is_empty());
        let initial_seq = sequence();

        // Cuando el usuario presiona físicamente el atajo de recorte (por defecto Ctrl+Alt+X, o cualquier combinación
        // personalizada como Ctrl+Shift+C, Alt+C, etc.), liberamos los modificadores que no formen parte del copiado
        // (Alt, Shift, Win) y la tecla principal para evitar que la aplicación activa reciba combinaciones espurias.
        let mut release_keys = Vec::new();
        if alt {
            release_keys.push(key_event(0x12, true, false)); // VK_MENU
            release_keys.push(key_event(0xA4, true, false)); // VK_LMENU
            release_keys.push(key_event(0xA5, true, false)); // VK_RMENU
        }
        if shift {
            release_keys.push(key_event(0x10, true, false)); // VK_SHIFT
            release_keys.push(key_event(0xA0, true, false)); // VK_LSHIFT
            release_keys.push(key_event(0xA1, true, false)); // VK_RSHIFT
        }
        if win {
            release_keys.push(key_event(0x5B, true, false)); // VK_LWIN
            release_keys.push(key_event(0x5C, true, false)); // VK_RWIN
        }
        if main_key != 0 {
            release_keys.push(key_event(main_key as u16, true, false));
        }
        if !release_keys.is_empty() {
            unsafe {
                SendInput(
                    release_keys.len() as u32,
                    release_keys.as_ptr(),
                    size_of::<Input>() as i32,
                )
            };
        }
        clock.pause(std::time::Duration::from_millis(15));

        // Enviar Ctrl+C limpio (o Ctrl+Insert para terminales).
        let pressed_ok = press(window.chord());

        // Esperar en un pequeño loop (hasta ~150ms en pasos de 15ms) a que cambie el sequence number
        // o contenido del portapapeles.
        const WAIT_LIMIT: std::time::Duration = std::time::Duration::from_millis(150);
        const WAIT_STEP: std::time::Duration = std::time::Duration::from_millis(15);

        let mut changed = false;
        let start = clock.now();
        while clock.now().saturating_sub(start) < WAIT_LIMIT {
            clock.pause(WAIT_STEP);
            if sequence() != initial_seq {
                changed = true;
                break;
            }
        }

        // Si cambió la secuencia, esperamos una pausa breve de estabilización y leemos el texto nuevo copiado.
        let captured_text = if changed {
            clock.pause(std::time::Duration::from_millis(15));
            Open::acquire(0, clock)
                .and_then(|cb| cb.text())
                .filter(|t| !t.trim().is_empty())
        } else {
            let current = Open::acquire(0, clock)
                .and_then(|cb| cb.text())
                .filter(|t| !t.trim().is_empty());
            if current != fallback_text && current.is_some() {
                current
            } else {
                None
            }
        };

        // Si no cambió (ej. el usuario ya había copiado texto antes y no tenía selección nueva),
        // usa como fallback el texto que ya estaba en el portapapeles para que nunca falle en silencio.
        let final_text = captured_text.or(fallback_text);

        match final_text {
            Some(text) => Ok(Clip {
                text,
                source: window.source(),
            }),
            None => {
                if !pressed_ok {
                    Err(Fail::Blocked)
                } else {
                    Err(Fail::NoSelection)
                }
            }
        }
    }

    /// Secuencia de teclas para activar el dictado por voz de Windows (Win + H).
    pub(super) fn dictation_chord() -> [Input; 4] {
        [
            key_event(VK_LWIN, false, false),
            key_event(VK_H, false, false),
            key_event(VK_H, true, false),
            key_event(VK_LWIN, true, false),
        ]
    }

    /// Suelta los modificadores del teclado si estuvieran apretados.
    fn release_modifiers() {
        let modifiers = [super::VK_SHIFT, super::VK_CONTROL, super::VK_MENU, super::VK_LWIN, super::VK_RWIN];
        let to_release: Vec<Input> = modifiers
            .into_iter()
            .filter(|&vk| is_down(vk))
            .map(|vk| key_event(vk as u16, true, false))
            .collect();
        if !to_release.is_empty() {
            unsafe {
                SendInput(to_release.len() as u32, to_release.as_ptr(), size_of::<Input>() as i32);
            }
        }
    }

    /// Activa el dictado de Windows simulando Win + H.
    pub fn start_windows_dictation() -> Result<(), String> {
        release_modifiers();
        let chord = dictation_chord();
        let sent = unsafe { SendInput(chord.len() as u32, chord.as_ptr(), size_of::<Input>() as i32) };
        if sent as usize != chord.len() {
            let release = [key_event(VK_H, true, false), key_event(VK_LWIN, true, false)];
            unsafe { SendInput(release.len() as u32, release.as_ptr(), size_of::<Input>() as i32) };
            return Err("No se pudo iniciar el dictado por voz de Windows.".into());
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::mem::offset_of;

        #[test]
        fn input_tiene_el_tamano_y_la_disposicion_que_espera_sendinput() {
            // INPUT: type (DWORD) y la unión, alineada a 8 en 64 bits. MOUSEINPUT (el miembro más
            // grande) mide 32 bytes en 64 bits y 24 en 32; KEYBDINPUT, 24 y 16.
            let wide = size_of::<usize>() == 8;
            assert_eq!(size_of::<KeyboardInput>(), if wide { 24 } else { 16 });
            assert_eq!(size_of::<MouseInput>(), if wide { 32 } else { 24 });
            assert_eq!(size_of::<Input>(), if wide { 40 } else { 28 });
            assert_eq!(offset_of!(Input, kind), 0);
            assert_eq!(offset_of!(Input, data), if wide { 8 } else { 4 });
            assert_eq!(offset_of!(KeyboardInput, vk), 0);
            assert_eq!(offset_of!(KeyboardInput, scan), 2);
            assert_eq!(offset_of!(KeyboardInput, flags), 4);
            assert_eq!(offset_of!(KeyboardInput, time), 8);
            assert_eq!(offset_of!(KeyboardInput, extra), if wide { 16 } else { 12 });
        }

        #[test]
        fn los_eventos_de_teclado_llevan_las_banderas_que_corresponden() {
            // Sin tocar el teclado: solo se arman las estructuras.
            let down = key_event(VK_C, false, false);
            let up = key_event(VK_C, true, false);
            let insert = key_event(VK_INSERT, false, true);
            let insert_up = key_event(VK_INSERT, true, true);
            // SAFETY: todas se armaron con el miembro `keyboard`.
            unsafe {
                assert_eq!((down.kind, down.data.keyboard.vk, down.data.keyboard.flags), (INPUT_KEYBOARD, VK_C, 0));
                assert_eq!(up.data.keyboard.flags, KEYEVENTF_KEYUP);
                assert_eq!(insert.data.keyboard.flags, KEYEVENTF_EXTENDEDKEY);
                assert_eq!(insert_up.data.keyboard.flags, KEYEVENTF_KEYUP | KEYEVENTF_EXTENDEDKEY);
                // Lleva también el código de hardware de la tecla, el que da la distribución activa.
                assert_ne!(down.data.keyboard.scan, 0);
            }
        }

        #[test]
        fn la_secuencia_de_dictado_aprieta_y_suelta_win_y_h() {
            let chord = dictation_chord();
            assert_eq!(chord.len(), 4);
            unsafe {
                assert_eq!((chord[0].data.keyboard.vk, chord[0].data.keyboard.flags), (VK_LWIN, 0));
                assert_eq!((chord[1].data.keyboard.vk, chord[1].data.keyboard.flags), (VK_H, 0));
                assert_eq!((chord[2].data.keyboard.vk, chord[2].data.keyboard.flags), (VK_H, KEYEVENTF_KEYUP));
                assert_eq!((chord[3].data.keyboard.vk, chord[3].data.keyboard.flags), (VK_LWIN, KEYEVENTF_KEYUP));
            }
        }
    }
}

#[cfg(windows)]
pub use imp::{copy_selection, start_windows_dictation};

/// Inicia el dictado de Windows (Win + H). Fuera de Windows no hace nada.
#[cfg(not(windows))]
pub fn start_windows_dictation() -> Result<(), String> {
    Ok(())
}

/// Copia lo seleccionado en el programa de al frente. `main_key` es el virtual-key de la tecla
/// principal del atajo, que también tiene que estar suelta.
#[cfg(not(windows))]
pub fn copy_selection(_main_key: i32, _alt: bool, _shift: bool, _win: bool, _clock: &impl Clock) -> Result<Clip, Fail> {
    Err(Fail::Unsupported)
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;

    /// Un reloj de mentira: el tiempo solo pasa cuando alguien hace una pausa.
    #[derive(Default)]
    struct Fake {
        now: Cell<Duration>,
        pauses: RefCell<Vec<Duration>>,
    }

    impl Clock for Fake {
        fn now(&self) -> Duration {
            self.now.get()
        }

        fn pause(&self, how_long: Duration) {
            self.now.set(self.now.get() + how_long);
            self.pauses.borrow_mut().push(how_long);
        }
    }

    #[test]
    fn si_las_teclas_ya_estan_sueltas_no_se_espera_nada() {
        let clock = Fake::default();
        let asked = Cell::new(0);
        let released = wait_until(&clock, RELEASE_LIMIT, RELEASE_STEP, || {
            asked.set(asked.get() + 1);
            true
        });
        assert!(released);
        assert_eq!(asked.get(), 1);
        assert!(clock.pauses.borrow().is_empty());
        assert_eq!(clock.now(), Duration::ZERO);
    }

    #[test]
    fn se_espera_a_que_se_suelten_mirando_cada_diez_milisegundos() {
        let clock = Fake::default();
        // Se suelta a los 120 ms (la doceava mirada).
        let released = wait_until(&clock, RELEASE_LIMIT, RELEASE_STEP, || clock.now() >= Duration::from_millis(120));
        assert!(released);
        assert_eq!(clock.now(), Duration::from_millis(120));
        assert_eq!(clock.pauses.borrow().len(), 12);
        assert!(clock.pauses.borrow().iter().all(|pause| *pause == RELEASE_STEP));
    }

    #[test]
    fn si_siguen_apretadas_se_da_por_vencido_al_tope() {
        let clock = Fake::default();
        let looks = Cell::new(0);
        let released = wait_until(&clock, RELEASE_LIMIT, RELEASE_STEP, || {
            looks.set(looks.get() + 1);
            false
        });
        assert!(!released);
        // Ni un milisegundo más del tope, y se miró hasta el último momento: 0, 10, ..., 1500 ms.
        assert_eq!(clock.now(), Duration::from_millis(1500));
        assert_eq!(looks.get(), 151);
    }

    #[test]
    fn soltar_justo_en_el_ultimo_instante_cuenta() {
        let clock = Fake::default();
        assert!(wait_until(&clock, RELEASE_LIMIT, RELEASE_STEP, || clock.now() >= RELEASE_LIMIT));
        let clock = Fake::default();
        assert!(!wait_until(&clock, RELEASE_LIMIT, RELEASE_STEP, || clock.now() > RELEASE_LIMIT));
    }

    #[test]
    fn la_espera_de_la_copia_tiene_su_propio_tope() {
        // El portapapeles cambia a los 90 ms.
        let clock = Fake::default();
        assert!(wait_until(&clock, COPY_LIMIT, COPY_STEP, || clock.now() >= Duration::from_millis(90)));
        assert_eq!(clock.now(), Duration::from_millis(90));
        // Si nunca cambia, se corta a los 700 ms (en saltos de 15: el primero que pasa el tope).
        let clock = Fake::default();
        assert!(!wait_until(&clock, COPY_LIMIT, COPY_STEP, || false));
        assert_eq!(clock.now(), Duration::from_millis(705));
        assert!(clock.now() >= COPY_LIMIT && clock.now() < COPY_LIMIT + COPY_STEP);
    }

    #[test]
    fn hay_que_esperar_a_los_cuatro_modificadores_y_a_la_tecla_del_atajo() {
        let keys = keys_to_release(0x58); // la X de Ctrl+Alt+X
        for modifier in [0x10, 0x11, 0x12, 0x5B, 0x5C] {
            assert!(keys.contains(&modifier), "{modifier:#x}");
        }
        assert!(keys.contains(&0x58));
        assert_eq!(keys.len(), 6);
        // Si la tecla principal fuera uno de los modificadores o no se supiera, no se repite ni se agrega un 0.
        assert_eq!(keys_to_release(0x11).len(), 5);
        assert_eq!(keys_to_release(0).len(), 5);
    }

    #[test]
    fn el_portapapeles_se_devuelve_solo_si_era_texto_o_estaba_vacio() {
        // Vacío: se vuelve a vaciar.
        assert_eq!(plan(&[]), Restore::Empty);
        // Texto que copió cualquier programa: las tres variantes que arma Windows y el idioma.
        assert_eq!(plan(&[CF_UNICODETEXT]), Restore::Text);
        assert_eq!(plan(&[CF_TEXT, CF_OEMTEXT, CF_UNICODETEXT, CF_LOCALE]), Restore::Text);
        assert_eq!(plan(&[CF_LOCALE, CF_UNICODETEXT]), Restore::Text);
        // Una imagen (CF_BITMAP, CF_DIB, CF_DIBV5), archivos (CF_HDROP) o un metarchivo.
        for other in [2u32, 8, 17, 15, 14, 3] {
            assert_eq!(plan(&[other]), Restore::Keep, "{other}");
            assert_eq!(plan(&[CF_UNICODETEXT, other]), Restore::Keep, "texto + {other}");
        }
        // Texto con formato (HTML, RTF) o con marcas de otros programas: formatos registrados (desde 0xC000).
        assert_eq!(plan(&[CF_UNICODETEXT, 0xC0A5]), Restore::Keep);
        assert_eq!(plan(&[CF_TEXT, CF_UNICODETEXT, 0xC13B, 0xC13C]), Restore::Keep);
        // Sin texto Unicode no hay con qué devolverlo.
        assert_eq!(plan(&[CF_LOCALE]), Restore::Keep);
    }

    fn window(title: &str, class: &str, image: &str) -> Window {
        Window { title: title.into(), class: class.into(), image: image.into() }
    }

    #[test]
    fn en_una_terminal_se_copia_con_ctrl_insertar_y_en_el_resto_con_ctrl_c() {
        let chord = |class: &str, image: &str| window("", class, image).chord();
        // Por la clase de la ventana...
        assert_eq!(chord("ConsoleWindowClass", ""), Chord::CtrlInsert);
        assert_eq!(chord("CASCADIA_HOSTING_WINDOW_CLASS", ""), Chord::CtrlInsert);
        assert_eq!(chord("consolewindowclass", ""), Chord::CtrlInsert);
        // ...o por el programa, con ruta de Windows y cualquier mayúscula.
        assert_eq!(chord("", r"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.21\WindowsTerminal.exe"), Chord::CtrlInsert);
        assert_eq!(chord("", r"C:\Windows\System32\cmd.exe"), Chord::CtrlInsert);
        assert_eq!(chord("", r"C:\Program Files\PowerShell\7\pwsh.exe"), Chord::CtrlInsert);
        assert_eq!(chord("", r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"), Chord::CtrlInsert);
        assert_eq!(chord("", "/usr/bin/alacritty"), Chord::CtrlInsert);
        // Un navegador, Word, el Bloc de notas, un lector de PDF: Ctrl+C.
        for image in [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE",
            r"C:\Windows\System32\notepad.exe",
            r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
            "",
        ] {
            assert_eq!(chord("Chrome_WidgetWin_1", image), Chord::CtrlC, "{image}");
        }
        // Una aplicación con «cmd» en el nombre no es una terminal.
        assert_eq!(chord("", r"C:\Tools\cmdtool.exe"), Chord::CtrlC);
    }

    #[test]
    fn el_programa_se_muestra_con_un_nombre_de_persona() {
        let program = |image: &str| window("", "", image).source().program;
        assert_eq!(program(r"C:\Program Files\Google\Chrome\Application\chrome.exe"), "Chrome");
        assert_eq!(program(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"), "Edge");
        assert_eq!(program(r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE"), "Word");
        assert_eq!(program(r"C:\Windows\System32\notepad.exe"), "Bloc de notas");
        assert_eq!(program(r"C:\Users\ana\AppData\Local\Programs\Microsoft VS Code\Code.exe"), "Visual Studio Code");
        // Los que no están en la lista, con el nombre del archivo y la inicial en mayúscula.
        assert_eq!(program(r"C:\Program Files\Obsidian\obsidian.exe"), "Obsidian");
        assert_eq!(program(r"C:\Program Files\Foo\FooBar.exe"), "FooBar");
        assert_eq!(program("/home/ana/bin/zathura"), "Zathura");
        // Sin ruta no se inventa nada.
        assert_eq!(program(""), "");
    }

    #[test]
    fn el_titulo_pierde_el_nombre_del_programa_del_final_y_queda_en_un_renglon() {
        let title = |title: &str, image: &str| window(title, "", image).source().title;
        let chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
        assert_eq!(title("Una página de prueba - Google Chrome", chrome), "Una página de prueba");
        assert_eq!(title("Cuaderno - Wikipedia - Google Chrome", chrome), "Cuaderno - Wikipedia");
        assert_eq!(title("Nueva pestaña – Personal – Microsoft\u{200b} Edge", r"C:\Edge\msedge.exe"), "Nueva pestaña – Personal");
        assert_eq!(title("Sin título - Bloc de notas", r"C:\Windows\System32\notepad.exe"), "Sin título");
        assert_eq!(title("*Sin título - Notepad", r"C:\Windows\System32\notepad.exe"), "*Sin título");
        assert_eq!(title("Informe.docx - Word", r"C:\Office\WINWORD.EXE"), "Informe.docx");
        assert_eq!(title("manual.pdf - Adobe Acrobat Reader (64-bit)", r"C:\Adobe\AcroRd32.exe"), "manual.pdf");
        assert_eq!(title("main.rs - Book - Visual Studio Code", r"C:\VS\Code.exe"), "main.rs - Book");
        // Lo que no es el nombre del programa se queda: el guion es parte del título.
        assert_eq!(title("Ana - Reunión del lunes", chrome), "Ana - Reunión del lunes");
        assert_eq!(title("Windows PowerShell", r"C:\Windows\System32\cmd.exe"), "Windows PowerShell");
        // Sin guion, o con un título corto que se parece de casualidad, no se corta nada.
        assert_eq!(title("Chrome", chrome), "Chrome");
        assert_eq!(title("A - B", chrome), "A - B");
        // Un solo renglón, sin espacios de más ni caracteres de control.
        assert_eq!(title("  Dos \t renglones\r\ny  más\u{7} ", ""), "Dos renglones y más");
        assert_eq!(title("", chrome), "");
        // Largo: se corta con puntos suspensivos.
        let long = "palabra ".repeat(40);
        let cut = title(&long, "");
        assert!(cut.chars().count() <= TITLE_MAX + 1 && cut.ends_with('…'), "{cut}");
    }

    #[test]
    fn el_origen_junta_programa_y_titulo() {
        let source = window("Una página - Google Chrome", "Chrome_WidgetWin_1", r"C:\Program Files\Google\Chrome\Application\chrome.exe").source();
        assert_eq!(source, Source { program: "Chrome".into(), title: "Una página".into() });
    }

    #[test]
    fn los_motivos_de_falla_estan_en_castellano_y_terminan_en_punto() {
        for fail in [Fail::NoSelection, Fail::Held, Fail::Blocked, Fail::Clipboard, Fail::Unsupported] {
            assert!(fail.message().ends_with('.'), "{fail:?}");
            assert!(fail.message_for(true).ends_with('.'), "{fail:?}");
        }
        assert_eq!(Fail::NoSelection.message(), "No había texto seleccionado.");
        assert_eq!(Fail::NoSelection.message_for(true), "No text was selected.");
    }
}
