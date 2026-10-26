// Release builds on Windows start without an extra console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fxm_desktop_lib::run();
}
