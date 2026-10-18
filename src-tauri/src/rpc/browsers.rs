//! The browser extension's credential. Chrome starts `tori browser-host` with
//! no token of its own, so Settings > Browser mints one into `browser.json`,
//! where the host reads it. One at a time: minting again replaces it.

use std::path::PathBuf;
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
    revoke(store, hub)?;
    let (browser, token) = store.mint("browser")?;
    let text = json!({ "id": browser.id, "token": token }).to_string();
    if let Err(e) = crate::owned_state::write_private(&credential_path(), &text) {
        let _ = store.revoke(&browser.id);
        return Err(e);
    }
    Ok(browser.id)
}

// Revoked in the store before the connections close: a connection still being
// set up checks the store after registering, so it cannot slip between the two.
pub fn revoke(store: &Devices, hub: &Hub) -> Result<(), String> {
    for browser in store.list() {
        store.revoke(&browser.id)?;
        hub.close_browser(&browser.id);
    }
    match std::fs::remove_file(credential_path()) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

pub fn status(store: &Devices, hub: &Hub) -> Value {
    json!({ "installed": !store.list().is_empty(), "connected": hub.browser_connected() })
}
