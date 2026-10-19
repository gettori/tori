//! The browser extension's credential. Chrome starts `tori browser-host` with
//! no token of its own, so Settings > Browser mints one into `browser.json`,
//! where the host reads it. One at a time: minting again replaces it.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde_json::{json, Value};

use super::devices::Devices;
use super::hub::Hub;

pub fn store() -> Arc<Devices> {
    static STORE: OnceLock<Arc<Devices>> = OnceLock::new();
    STORE
        .get_or_init(|| Arc::new(Devices::open(super::browsers_path())))
        .clone()
}

pub fn credential_path() -> PathBuf {
    crate::owned_state::config_dir().join("browser.json")
}

pub fn read_token() -> Option<String> {
    let text = std::fs::read_to_string(credential_path()).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value["token"].as_str().map(str::to_string)
}

pub fn mint(store: &Devices, hub: &Hub) -> Result<String, String> {
    mint_at(store, hub, &credential_path())
}

pub fn revoke(store: &Devices, hub: &Hub) -> Result<(), String> {
    revoke_at(store, hub, &credential_path())
}

fn mint_at(store: &Devices, hub: &Hub, credential: &Path) -> Result<String, String> {
    revoke_at(store, hub, credential)?;
    let (browser, token) = store.mint("browser")?;
    let text = json!({ "id": browser.id, "token": token }).to_string();
    if let Err(e) = crate::owned_state::write_private(credential, &text) {
        let _ = store.revoke(&browser.id);
        return Err(e);
    }
    Ok(browser.id)
}

// Revoked in the store before the connections close: a connection still being
// set up checks the store after registering, so it cannot slip between the two.
fn revoke_at(store: &Devices, hub: &Hub, credential: &Path) -> Result<(), String> {
    for browser in store.list() {
        store.revoke(&browser.id)?;
        hub.close_browser(&browser.id);
    }
    hub.forget_last_refusal();
    match std::fs::remove_file(credential) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

pub fn status(store: &Devices, hub: &Hub) -> Value {
    json!({
        "installed": !store.list().is_empty(),
        "connected": hub.browser_connected(),
        "update": hub.last_refusal().map(|u| u.name()),
    })
}

// The store item's id, which the `key` in the extension's manifest pins the
// unpacked build to as well.
const EXTENSION_ID: &str = "miahchgjdkmlidcpclfknpffbbipnono";

const HOST_NAME: &str = if cfg!(debug_assertions) {
    "app.gettori.tori_dev"
} else {
    "app.gettori.tori"
};

const NATIVE_HOST_DIRS: &[(&str, &str)] = &[
    ("Chrome", "Google/Chrome"),
    ("Chromium", "Chromium"),
    ("Brave", "BraveSoftware/Brave-Browser"),
    ("Edge", "Microsoft Edge"),
    ("Arc", "Arc/User Data"),
];

fn support_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join("Library/Application Support")
}

fn found() -> Vec<(&'static str, PathBuf)> {
    let support = support_dir();
    NATIVE_HOST_DIRS
        .iter()
        .map(|(name, dir)| (*name, support.join(dir)))
        .filter(|(_, dir)| dir.is_dir())
        .map(|(name, dir)| (name, dir.join("NativeMessagingHosts").join(format!("{HOST_NAME}.json"))))
        .collect()
}

fn host_manifest() -> Value {
    json!({
        "name": HOST_NAME,
        "description": "Tori",
        "path": super::daemon::paths().cli_link_dir.join("tori"),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    })
}

fn is_current(path: &std::path::Path, want: &Value) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|have| &have == want)
}

pub fn manifests() -> Value {
    let want = host_manifest();
    found()
        .into_iter()
        .map(|(name, path)| json!({ "name": name, "installed": is_current(&path, &want) }))
        .collect()
}

pub fn install_manifests() -> Result<(), String> {
    let text = serde_json::to_string_pretty(&host_manifest()).map_err(|e| e.to_string())?;
    for (name, path) in found() {
        crate::owned_state::write_atomically(&path, &text).map_err(|e| format!("{name}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::hub::Update;

    #[test]
    fn minting_again_forgets_the_hosts_last_refusal() {
        let dir = std::env::temp_dir().join(format!("tori-browsers-mint-{}", std::process::id()));
        let store = Devices::open(dir.join("browsers.json"));
        let hub = Hub::default();
        hub.refuse_browser(Update::Extension);
        mint_at(&store, &hub, &dir.join("browser.json")).unwrap();
        assert_eq!(hub.last_refusal(), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
