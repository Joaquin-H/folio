// Evita que se abra una consola junto a la app en Windows (solo en release).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    folio_lib::run()
}
