//! What plugins each account of an agent has installed, read off its home.
//!
//! Read from disk rather than asked of the agent: the `initialize` handshake
//! the catalogue probe runs carries no plugin list (measured on claude
//! 2.1.268, its keys are commands, agents, models, account and the like), and
//! the `system/init` frame that does carry one only arrives once a turn has
//! started. A settings page has no session to wait on, and the files are the
//! agent's own record of what it will load.
//!
//! One shape per adapter, declared as `accounts.plugins_kind`; the only one
//! measured so far is Claude's.

use std::path::Path;

use serde::Serialize;

use crate::agents::{AgentAdapter, PluginsKind};

/// One installed plugin of one account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    /// The agent's own id for it, `name@marketplace` for claude.
    pub id: String,
    pub name: String,
    pub marketplace: Option<String>,
    pub version: Option<String>,
    pub scope: Option<String>,
    pub install_path: Option<String>,
    /// Whether the home's settings turn it on. Installed and off is a real
    /// state (`claude plugin disable`), so it is reported rather than hidden.
    pub enabled: bool,
}

/// One account's plugins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePluginsView {
    pub profile_id: String,
    pub label: String,
    pub home: String,
    pub plugins: Vec<InstalledPlugin>,
}

/// Every account's plugins for one adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginsView {
    pub adapter_id: String,
    /// False for an adapter with no `plugins_kind`, which the page reads as
    /// "nothing to list" rather than as an agent with no plugins.
    pub declared: bool,
    pub profiles: Vec<ProfilePluginsView>,
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Claude's `plugins/installed_plugins.json` (version 2) joined with the
/// `enabledPlugins` map in `settings.json`. A missing or unreadable file reads
/// as no plugins, which is what it means for the agent too.
pub fn claude_installed(home: &Path) -> Vec<InstalledPlugin> {
    let enabled = read_json(&home.join("settings.json"))
        .and_then(|s| s.get("enabledPlugins").cloned())
        .unwrap_or_default();
    let Some(installed) = read_json(&home.join("plugins").join("installed_plugins.json")) else {
        return Vec::new();
    };
    let Some(plugins) = installed.get("plugins").and_then(|p| p.as_object()) else {
        return Vec::new();
    };
    let string = |v: &serde_json::Value, key: &str| v.get(key).and_then(|s| s.as_str()).map(str::to_string);
    let mut out: Vec<InstalledPlugin> = plugins
        .iter()
        .map(|(id, installs)| {
            // A plugin installed at two scopes is two entries in the file and one
            // plugin to the user; the first entry is the one the CLI lists.
            let first = installs.as_array().and_then(|a| a.first()).cloned().unwrap_or_default();
            let (name, marketplace) = match id.split_once('@') {
                Some((n, m)) => (n.to_string(), Some(m.to_string())),
                None => (id.clone(), None),
            };
            InstalledPlugin {
                id: id.clone(),
                name,
                marketplace,
                version: string(&first, "version"),
                scope: string(&first, "scope"),
                install_path: string(&first, "installPath"),
                enabled: enabled.get(id).and_then(|v| v.as_bool()).unwrap_or(false),
            }
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn installed_in(kind: PluginsKind, home: &Path) -> Vec<InstalledPlugin> {
    match kind {
        PluginsKind::ClaudeInstalledJson => claude_installed(home),
    }
}

/// The plugins each account of this adapter has installed.
#[tauri::command]
pub async fn agent_plugins(adapter_id: String) -> Result<PluginsView, String> {
    let adapter: AgentAdapter = crate::agents::find(&adapter_id)
        .cloned()
        .ok_or_else(|| format!("no agent adapter `{adapter_id}`"))?;
    let Some(kind) = adapter.accounts.as_ref().and_then(|a| a.plugins_kind) else {
        return Ok(PluginsView { adapter_id, declared: false, profiles: Vec::new() });
    };
    let homes = crate::agent_config::homes_for(&adapter);
    crate::exec::blocking("agent_plugins", move || {
        let profiles = homes
            .into_iter()
            .map(|(profile_id, label, home)| ProfilePluginsView {
                profile_id,
                label,
                home: home.to_string_lossy().into_owned(),
                plugins: installed_in(kind, &home),
            })
            .collect();
        Ok(PluginsView { adapter_id, declared: true, profiles })
    })
    .await
}
