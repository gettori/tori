const COMMANDS: &[&str] = &["enable", "disable", "state"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
