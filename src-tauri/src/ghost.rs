//! El "fantasma" del cuaderno: un rectángulo translúcido, por encima de todo, que muestra
//! el tamaño que va a tomar el cuaderno mientras se lo estira a mano. La ventana de
//! verdad no cambia hasta que el usuario suelta: así no hay saltos ni redibujados a
//! medio camino.
//!
//! Es una ventana nativa mínima (sin motor web): moverla es instantáneo, no recibe clics
//! ni foco y no aparece en la barra de tareas.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicIsize, Ordering};

    type Hwnd = isize;
    type WndProc = unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize;

    #[repr(C)]
    struct WndClassW {
        style: u32,
        wnd_proc: Option<WndProc>,
        cls_extra: i32,
        wnd_extra: i32,
        instance: isize,
        icon: isize,
        cursor: isize,
        background: isize,
        menu_name: *const u16,
        class_name: *const u16,
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterClassW(class: *const WndClassW) -> u16;
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
        fn DefWindowProcW(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize;
        fn SetLayeredWindowAttributes(hwnd: Hwnd, color_key: u32, alpha: u8, flags: u32) -> i32;
        fn SetWindowPos(hwnd: Hwnd, after: Hwnd, x: i32, y: i32, width: i32, height: i32, flags: u32) -> i32;
        fn ShowWindow(hwnd: Hwnd, command: i32) -> i32;
        fn SetWindowRgn(hwnd: Hwnd, region: isize, redraw: i32) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateSolidBrush(color: u32) -> isize;
        fn CreateRoundRectRgn(left: i32, top: i32, right: i32, bottom: i32, width: i32, height: i32) -> isize;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> isize;
    }

    const WS_POPUP: u32 = 0x8000_0000;
    const WS_EX_TOPMOST: u32 = 0x0000_0008;
    const WS_EX_TRANSPARENT: u32 = 0x0000_0020; // los clics lo atraviesan
    const WS_EX_TOOLWINDOW: u32 = 0x0000_0080; // fuera de la barra de tareas y de Alt + Tab
    const WS_EX_LAYERED: u32 = 0x0008_0000;
    const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
    const LWA_ALPHA: u32 = 0x2;
    const HWND_TOPMOST: Hwnd = -1;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    const SW_HIDE: i32 = 0;
    /// Azul del sistema (#007AFF), en el orden de bytes que usa Windows (0x00BBGGRR).
    const COLOR: u32 = 0x00FF_7A00;
    /// De 0 (invisible) a 255 (opaco).
    const ALPHA: u8 = 72;

    static GHOST: AtomicIsize = AtomicIsize::new(0);

    unsafe extern "system" fn window_proc(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> isize {
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    /// Crea la ventana, oculta. Tiene que llamarse desde el hilo que atiende las ventanas
    /// de la aplicación (el principal), que es el que después la dibuja.
    pub fn create() {
        if GHOST.load(Ordering::SeqCst) != 0 {
            return;
        }
        let class: Vec<u16> = "BookGhost\0".encode_utf16().collect();
        // SAFETY: llamadas directas a la API de Windows con punteros válidos durante la
        // llamada; la clase y la ventana viven mientras viva el proceso.
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let definition = WndClassW {
                style: 0,
                wnd_proc: Some(window_proc),
                cls_extra: 0,
                wnd_extra: 0,
                instance,
                icon: 0,
                cursor: 0,
                background: CreateSolidBrush(COLOR),
                menu_name: std::ptr::null(),
                class_name: class.as_ptr(),
            };
            // Si la clase ya estaba registrada no pasa nada: se la usa igual.
            RegisterClassW(&definition);
            let hwnd = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class.as_ptr(),
                class.as_ptr(),
                WS_POPUP,
                0,
                0,
                16,
                16,
                0,
                0,
                instance,
                std::ptr::null_mut(),
            );
            if hwnd != 0 {
                SetLayeredWindowAttributes(hwnd, 0, ALPHA, LWA_ALPHA);
                GHOST.store(hwnd, Ordering::SeqCst);
            }
        }
    }

    /// Muestra el fantasma en ese rectángulo de la pantalla (píxeles físicos), con las
    /// esquinas redondeadas como las del cuaderno.
    pub fn show(x: i32, y: i32, width: i32, height: i32, radius: i32) {
        let hwnd = GHOST.load(Ordering::SeqCst);
        if hwnd == 0 || width <= 0 || height <= 0 {
            return;
        }
        // SAFETY: `hwnd` es la ventana creada en `create`. La región pasa a ser del sistema.
        unsafe {
            SetWindowRgn(hwnd, CreateRoundRectRgn(0, 0, width + 1, height + 1, radius, radius), 1);
            SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
    }

    pub fn hide() {
        let hwnd = GHOST.load(Ordering::SeqCst);
        if hwnd != 0 {
            // SAFETY: `hwnd` es la ventana creada en `create`.
            unsafe {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[repr(C)]
        #[derive(Default)]
        struct Rect {
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
        }

        #[link(name = "user32")]
        extern "system" {
            fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
            fn IsWindowVisible(hwnd: Hwnd) -> i32;
            fn GetWindowLongW(hwnd: Hwnd, index: i32) -> i32;
        }

        #[test]
        fn el_fantasma_se_muestra_donde_se_le_pide_y_se_esconde() {
            create();
            let hwnd = GHOST.load(Ordering::SeqCst);
            assert_ne!(hwnd, 0, "no se pudo crear la ventana del fantasma");
            // SAFETY: consultas de solo lectura sobre la ventana recién creada.
            unsafe {
                assert_eq!(IsWindowVisible(hwnd), 0, "nace oculto");
                // No recibe clics ni foco, y queda por encima de las demás ventanas.
                let style = GetWindowLongW(hwnd, -20) as u32;
                assert_ne!(style & WS_EX_TRANSPARENT, 0);
                assert_ne!(style & WS_EX_NOACTIVATE, 0);
                assert_ne!(style & WS_EX_LAYERED, 0);

                show(120, 90, 640, 480, 32);
                assert_ne!(IsWindowVisible(hwnd), 0);
                let mut rect = Rect::default();
                assert_ne!(GetWindowRect(hwnd, &mut rect), 0);
                assert_eq!((rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top), (120, 90, 640, 480));

                show(60, 40, 900, 620, 32);
                assert_ne!(GetWindowRect(hwnd, &mut rect), 0);
                assert_eq!((rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top), (60, 40, 900, 620));

                hide();
                assert_eq!(IsWindowVisible(hwnd), 0);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    // En otros sistemas todavía no hay fantasma: el tamaño se aplica al soltar, sin vista previa.
    pub fn create() {}
    pub fn show(_x: i32, _y: i32, _width: i32, _height: i32, _radius: i32) {}
    pub fn hide() {}
}

pub use imp::{create, hide, show};
