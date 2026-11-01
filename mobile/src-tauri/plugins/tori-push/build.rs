const COMMANDS: &[&str] = &["enable", "disable", "state", "opened"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
