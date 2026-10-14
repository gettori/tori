use std::collections::HashMap;

use crate::accounts::DEFAULT_PROFILE_ID;
use crate::agents::{AgentAdapter, ChatTransport};
use crate::auth::SignIn;
use crate::chat::model::ContentBlock;
use crate::health::{AgentHealth, BinaryStatus};
use crate::settings::{AgentRow, Settings};

const MAX_ATTACHMENTS: usize = 10;

#[derive(Debug, Clone, PartialEq)]
pub struct Picked {
    pub agent: String,
    pub profile: String,
}

// The one crossing into the tab's spelling, where the default account is
// unset rather than named.
pub fn tab_profile(profile: &str) -> Option<String> {
    (profile != DEFAULT_PROFILE_ID).then(|| profile.to_string())
}

fn health_of<'a>(health: &'a [AgentHealth], id: &str) -> Option<&'a AgentHealth> {
    health.iter().find(|h| h.id == id)
}

fn no_accounts(health: &[AgentHealth], adapter: &AgentAdapter) -> bool {
    health_of(health, &adapter.id).is_some_and(|h| h.profiles.is_empty()) && adapter.accounts.is_some()
}

fn signed_out_everywhere(row: &AgentHealth) -> bool {
    match row.profiles.is_empty() {
        true => row.sign_in == SignIn::SignedOut,
        false => row.profiles.iter().all(|p| p.sign_in == SignIn::SignedOut),
    }
}

fn profile_signed_out(health: &[AgentHealth], id: &str, profile: &str) -> bool {
    let Some(row) = health_of(health, id) else { return false };
    let per = row
        .profiles
        .iter()
        .find(|p| p.id == profile && profile != DEFAULT_PROFILE_ID);
    per.map_or(&row.sign_in, |p| &p.sign_in) == &SignIn::SignedOut
}

fn enabled(settings: &Settings, health: &[AgentHealth], adapter: &AgentAdapter) -> bool {
    let chosen = settings.agent.enabled.get(&adapter.id).copied().unwrap_or(false);
    let ready = match health_of(health, &adapter.id) {
        None => true,
        Some(row) => {
            row.status != BinaryStatus::NotFound && !no_accounts(health, adapter) && !signed_out_everywhere(row)
        }
    };
    chosen && ready
}

fn is_under(folder: &str, path: &str) -> bool {
    let path = path.trim_end_matches('/');
    folder == path || folder.starts_with(&format!("{path}/"))
}

fn allowed_rows<'a>(project_agents: &'a HashMap<String, Vec<AgentRow>>, folder: &str) -> Option<&'a [AgentRow]> {
    project_agents
        .iter()
        .filter(|(path, rows)| !rows.is_empty() && is_under(folder, path))
        .max_by_key(|(path, _)| path.len())
        .map(|(_, rows)| rows.as_slice())
}

// An account a setting names, while it still exists.
fn known_profile(health: &[AgentHealth], id: &str, profile: Option<&str>) -> Option<String> {
    let profile = profile.filter(|p| !p.is_empty())?;
    match health_of(health, id) {
        Some(row) if !row.profiles.iter().any(|p| p.id == profile) => None,
        _ => Some(profile.to_string()),
    }
}

fn sole_profile(health: &[AgentHealth], id: &str) -> String {
    let listed = health_of(health, id).map(|h| h.profiles.as_slice()).unwrap_or_default();
    match listed.is_empty() || listed.iter().any(|p| p.id == DEFAULT_PROFILE_ID) {
        true => DEFAULT_PROFILE_ID.to_string(),
        false => listed[0].id.clone(),
    }
}

fn layered_profile(settings: &Settings, health: &[AgentHealth], id: &str, remembered: Option<&str>) -> String {
    let chosen = settings.agent.default_profiles.get(id).map(String::as_str);
    if let Some(known) = known_profile(health, id, remembered).or_else(|| known_profile(health, id, chosen)) {
        return known;
    }
    let sole = sole_profile(health, id);
    if !profile_signed_out(health, id, &sole) {
        return sole;
    }
    // Nobody chose this account, so moving off a signed-out one overrides nothing.
    let signed_in = health_of(health, id).and_then(|h| h.profiles.iter().find(|p| p.sign_in == SignIn::SignedIn));
    signed_in.map_or(sole, |p| p.id.clone())
}

fn draft_profile(
    settings: &Settings,
    health: &[AgentHealth],
    id: &str,
    remembered: Option<&str>,
    rows: Option<&[AgentRow]>,
) -> String {
    let picked = layered_profile(settings, health, id, remembered);
    let allowed: Vec<&AgentRow> = rows.into_iter().flatten().filter(|r| r.agent == id).collect();
    if allowed.is_empty() || allowed.iter().any(|r| r.profile == picked) {
        return picked;
    }
    // Rows whose accounts are all gone still name one, so the spawn refuses
    // with the project's reason instead of starting on a login it does not allow.
    let kept = allowed.iter().find_map(|r| known_profile(health, id, Some(&r.profile)));
    kept.unwrap_or_else(|| allowed[0].profile.clone())
}

pub fn pick(folder: &str, agent: Option<&str>, account: Option<&str>) -> Result<Picked, String> {
    let settings = crate::settings::get_settings();
    let health = crate::health::now();
    pick_from(&settings, &health, &crate::agents::registry(), folder, agent, account)
}

fn pick_from(
    settings: &Settings,
    health: &[AgentHealth],
    registry: &[AgentAdapter],
    folder: &str,
    agent: Option<&str>,
    account: Option<&str>,
) -> Result<Picked, String> {
    let prefs = settings.chat.get(folder).cloned().unwrap_or_default();
    let rows = allowed_rows(&settings.project_agents, folder);
    let agent = match agent {
        Some(agent) => agent.to_string(),
        None => {
            let offered: Vec<&AgentAdapter> = registry
                .iter()
                .filter(|a| a.chat.is_some() && enabled(settings, health, a))
                .collect();
            let fits = |id: &str| {
                offered.iter().any(|a| a.id == id) && rows.is_none_or(|rows| rows.iter().any(|r| r.agent == id))
            };
            let remembered = prefs.agent.as_deref().filter(|id| fits(id));
            remembered
                .map(str::to_string)
                .or_else(|| offered.iter().find(|a| fits(&a.id)).map(|a| a.id.clone()))
                .or_else(|| offered.first().map(|a| a.id.clone()))
                .ok_or("no agent enabled: turn one on in Settings")?
        }
    };
    if !registry.iter().any(|a| a.id == agent && a.chat.is_some()) {
        return Err(format!("{agent} has no chat surface"));
    }
    let profile = match account {
        Some(account) => account.to_string(),
        None => draft_profile(settings, health, &agent, prefs.profile.as_deref(), rows),
    };
    Ok(Picked { agent, profile })
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Image,
    Pdf,
    File,
}

const IMAGE: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
const OPAQUE: [&str; 23] = [
    "mp4", "mov", "webm", "mkv", "avi", "m4v", "mp3", "wav", "m4a", "ogg", "flac", "aac", "zip", "gz", "tgz", "tar",
    "bz2", "xz", "7z", "rar", "dmg", "iso", "exe",
];

fn kind_of(path: &str) -> Option<Kind> {
    let base = path.rsplit('/').next().unwrap_or(path);
    let ext = match base.rfind('.') {
        Some(dot) if dot > 0 => base[dot + 1..].to_lowercase(),
        _ => String::new(),
    };
    if IMAGE.contains(&ext.as_str()) {
        Some(Kind::Image)
    } else if ext == "pdf" {
        Some(Kind::Pdf)
    } else if OPAQUE.contains(&ext.as_str()) {
        None
    } else {
        Some(Kind::File)
    }
}

pub fn first_message(agent: &str, prompt: Option<&str>, attach: &[String]) -> Result<Vec<ContentBlock>, String> {
    if attach.len() > MAX_ATTACHMENTS {
        return Err(format!(
            "That is more than {MAX_ATTACHMENTS} attachments. Send some first."
        ));
    }
    let transport = crate::agents::find(agent).and_then(|a| a.chat).map(|c| c.transport);
    let opens: &[Kind] = match transport {
        Some(ChatTransport::ClaudeStreamJson) => &[Kind::Image, Kind::Pdf, Kind::File],
        _ => &[Kind::File],
    };
    let mut counts = [0u32; 3];
    let mut labels = Vec::new();
    let mut refs = Vec::new();
    for path in attach {
        let name = path.rsplit('/').next().unwrap_or(path);
        let kind = kind_of(path)
            .filter(|k| opens.contains(k))
            .ok_or_else(|| format!("{name} is a kind of file {agent} cannot open"))?;
        let (slot, word) = match kind {
            Kind::Image => (0, "Image"),
            Kind::Pdf => (1, "PDF"),
            Kind::File => (2, "File"),
        };
        counts[slot] += 1;
        let label = format!("[{word} {}]", counts[slot]);
        labels.push(label.clone());
        refs.push(ContentBlock::FileRef {
            path: path.clone(),
            start_line: None,
            end_line: None,
            text: None,
            label: Some(label),
        });
    }
    let text: Vec<&str> = prompt
        .into_iter()
        .filter(|p| !p.is_empty())
        .chain(labels.iter().map(String::as_str))
        .collect();
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(ContentBlock::Text { text: text.join(" ") });
    }
    blocks.extend(refs);
    Ok(blocks)
}
