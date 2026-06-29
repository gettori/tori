// A PATH that includes the user's common bin dirs. A GUI-launched process
// inherits a minimal PATH that often lacks ~/.local/bin, ~/.cargo/bin,
// ~/.volta/bin (where node/claude live), and Homebrew. Every subprocess Sway
// spawns (PTY, external editors, the language server) uses this so binaries
// resolve the same way they do in the user's shell.

pub fn augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts: Vec<String> = vec![
        format!("{home}/.local/bin"),
        format!("{home}/.cargo/bin"),
        format!("{home}/.volta/bin"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
    ];
    if let Ok(existing) = std::env::var("PATH") {
        parts.push(existing);
    }
    parts.join(":")
}
