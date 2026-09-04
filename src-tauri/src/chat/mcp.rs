//! Claude's own MCP configuration, read where Claude keeps it and written back
//! in Claude's own format.
//!
//! **No Sway format.** MCP servers are a property of the project and of the
//! user's Claude install, not of Sway: a server added here has to be the same
//! server `claude` sees from a terminal, and one added by `claude mcp add` has
//! to show up here. Inventing a fourth config file would give the user two
//! places to look and two answers to the same question.
//!
//! Three scopes, measured against claude 2.1.220 (`claude mcp add --scope`):
//!
//! | Scope | File | Key |
//! |---|---|---|
//! | project | `<repo>/.mcp.json` | `mcpServers` |
//! | user | `~/.claude.json` | `mcpServers` |
//! | local | `~/.claude.json` | `projects[<cwd>].mcpServers` |
//!
//! The two user-scope rows are **per account**. `.claude.json` relocates
//! asymmetrically under `CLAUDE_CONFIG_DIR`: by default it sits at
//! `~/.claude.json`, *outside* `~/.claude`, but under an isolated home it is
//! written *inside* that directory (see [[adr_credential_custody]]). So a
//! session on an added profile has its own user-scope servers, and reading the
//! default account's file for it would list servers it cannot use and hide the
//! ones it can.
//!
//! ## We read all three and write only the project file
//!
//! `~/.claude.json` is not a config file, it is Claude's live application
//! state: this machine's copy carries ~90 top-level keys (onboarding flags,
//! caches, per-project token totals, OAuth account) and every running `claude`
//! rewrites it. A read-modify-write from Sway would race those writers and
//! could drop unrelated state that no one asked us to touch. This is the same
//! boundary the project already draws at `~/.claude/settings.json`, for the
//! same reason.
//!
//! `.mcp.json` has none of those problems: it is a small, single-purpose,
//! checked-in file that `claude mcp add --scope project` writes and that exists
//! to be shared. So Sway writes there, and reports the other two read-only.
//!
//! ## Pending approval is reported, not bypassed
//!
//! A server in `.mcp.json` that the user has not approved is loaded by Claude
//! as **pending** and is not connected to. The approval lives in
//! `projects[<cwd>].enabledMcpjsonServers` inside `~/.claude.json`, which is
//! exactly the file we will not write. So a newly added server surfaces as
//! `Pending` with the one-line instruction for clearing it, rather than being
//! silently force-enabled behind the user's back.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// Where a server's definition came from. Ordered by the precedence Claude
/// applies, narrowest last.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum McpScope {
    User,
    Project,
    Local,
}

/// Whether a `.mcp.json` server has been approved for this project.
///
/// Only project-scoped servers can be pending: a user- or local-scoped server
/// was added by the user directly and needs no second consent.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum McpApproval {
    Approved,
    Pending,
    Disabled,
    /// Not a `.mcp.json` server, so approval does not apply.
    NotApplicable,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpEntry {
    pub name: String,
    pub scope: McpScope,
    pub approval: McpApproval,
    /// The raw definition as Claude stores it (`command`/`args`/`env`, or
    /// `type`/`url`/`headers`). Passed through rather than parsed into a Sway
    /// shape so a transport we do not know about still round-trips intact.
    pub config: Value,
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn servers_in(v: Option<&Value>) -> Vec<(String, Value)> {
    v.and_then(|v| v.get("mcpServers"))
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

fn string_list(v: Option<&Value>, key: &str) -> Vec<String> {
    v.and_then(|v| v.get(key))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

pub fn project_config_path(cwd: &Path) -> PathBuf {
    cwd.join(".mcp.json")
}

/// Where this account's `.claude.json` is.
///
/// `None` for `profile_home` is the default account, whose file sits *beside*
/// `~/.claude` rather than inside it. An isolated home inverts that: the file
/// is written within the directory `CLAUDE_CONFIG_DIR` names. Getting this
/// backwards is not a missing-file error, it is the wrong account's servers
/// listed under the right account's name.
fn user_config_path(profile_home: Option<&str>) -> Option<PathBuf> {
    match profile_home {
        Some(home) => Some(Path::new(home).join(".claude.json")),
        None => dirs::home_dir().map(|h| h.join(".claude.json")),
    }
}

/// Every MCP server configured for `cwd`, across all three scopes.
///
/// Pure over the two file contents so the precedence and approval rules are
/// unit-testable without a home directory. A name defined in more than one
/// scope appears once, at the narrowest scope that defines it, which is the
/// one Claude will actually use.
pub fn merge_scopes(project: Option<&Value>, user_state: Option<&Value>, cwd: &str) -> Vec<McpEntry> {
    let project_entry = user_state
        .and_then(|v| v.get("projects"))
        .and_then(|p| p.get(cwd));
    let enabled = string_list(project_entry, "enabledMcpjsonServers");
    let disabled = string_list(project_entry, "disabledMcpjsonServers");
    // "*" enables every .mcp.json server for the project in one go.
    let all_enabled = enabled.iter().any(|e| e == "*");

    let mut out: Vec<McpEntry> = Vec::new();
    let mut push = |name: String, scope: McpScope, approval: McpApproval, config: Value| {
        // Narrowest wins: a later scope replaces an earlier definition of the
        // same name rather than showing the user two rows for one server.
        if let Some(existing) = out.iter_mut().find(|e| e.name == name) {
            *existing = McpEntry { name, scope, approval, config };
        } else {
            out.push(McpEntry { name, scope, approval, config });
        }
    };

    for (name, config) in servers_in(user_state) {
        push(name, McpScope::User, McpApproval::NotApplicable, config);
    }
    for (name, config) in servers_in(project) {
        let approval = if disabled.contains(&name) {
            McpApproval::Disabled
        } else if all_enabled || enabled.contains(&name) {
            McpApproval::Approved
        } else {
            McpApproval::Pending
        };
        push(name, McpScope::Project, approval, config);
    }
    for (name, config) in servers_in(project_entry) {
        push(name, McpScope::Local, McpApproval::NotApplicable, config);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Add or replace one server in a project `.mcp.json` document.
///
/// Takes and returns the whole document so any sibling keys the user or a
/// future Claude version put there survive the write untouched.
pub fn upsert_server(doc: Option<Value>, name: &str, config: Value) -> Value {
    let mut doc = match doc {
        Some(Value::Object(o)) => Value::Object(o),
        // A missing or corrupt file becomes a fresh document rather than an
        // error: the user asked to add a server, and there is nothing here
        // worth preserving.
        _ => Value::Object(Map::new()),
    };
    let servers = doc
        .as_object_mut()
        .expect("object by construction")
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    if !servers.is_object() {
        *servers = Value::Object(Map::new());
    }
    servers
        .as_object_mut()
        .expect("object by construction")
        .insert(name.to_string(), config);
    doc
}

/// Remove one server from a project `.mcp.json` document. Returns `None` when
/// the name was not there, so the caller can skip a pointless write.
pub fn remove_server(doc: Option<Value>, name: &str) -> Option<Value> {
    let mut doc = doc?;
    let servers = doc.as_object_mut()?.get_mut("mcpServers")?.as_object_mut()?;
    servers.remove(name)?;
    Some(doc)
}

// --- thin wrappers over the real paths ---

pub fn list_for(cwd: &str, profile_home: Option<&str>) -> Vec<McpEntry> {
    let project = read_json(&project_config_path(Path::new(cwd)));
    let user_state = user_config_path(profile_home).and_then(|p| read_json(&p));
    merge_scopes(project.as_ref(), user_state.as_ref(), cwd)
}

fn write_project(cwd: &str, doc: &Value) -> Result<(), String> {
    let path = project_config_path(Path::new(cwd));
    // Pretty-printed with a trailing newline: this file is meant to be read and
    // committed, and a one-line blob would show up as an unreviewable diff.
    let mut json = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    json.push('\n');
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// The project file is shared by every account, so the write is not
/// profile-scoped; `profile_home` is only for the listing this returns, which
/// has to come back in the same terms the caller asked in.
pub fn add_to_project(
    cwd: &str,
    name: &str,
    config: Value,
    profile_home: Option<&str>,
) -> Result<Vec<McpEntry>, String> {
    if name.trim().is_empty() {
        return Err("A server needs a name.".into());
    }
    let path = project_config_path(Path::new(cwd));
    let doc = upsert_server(read_json(&path), name, config);
    write_project(cwd, &doc)?;
    Ok(list_for(cwd, profile_home))
}

pub fn remove_from_project(
    cwd: &str,
    name: &str,
    profile_home: Option<&str>,
) -> Result<Vec<McpEntry>, String> {
    let path = project_config_path(Path::new(cwd));
    match remove_server(read_json(&path), name) {
        Some(doc) => {
            write_project(cwd, &doc)?;
            Ok(list_for(cwd, profile_home))
        }
        // Not in the project file: either it was never there, or it is a
        // user/local server we deliberately do not write.
        None => Err("That server is not in this project's .mcp.json, so Sway cannot remove it.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stdio(cmd: &str) -> Value {
        json!({ "command": cmd, "args": [] })
    }

    /// The asymmetry measured in [[adr_credential_custody]], as a test rather
    /// than a comment: `.claude.json` sits *beside* the default home and
    /// *inside* an isolated one. Getting it backwards is not a missing file, it
    /// is one account's servers listed under another account's name.
    #[test]
    fn an_isolated_home_keeps_its_claude_json_inside_it() {
        let isolated = user_config_path(Some("/homes/fonn")).expect("an explicit home always resolves");
        assert_eq!(isolated, Path::new("/homes/fonn/.claude.json"));

        // And the default account's is a sibling of `~/.claude`, not a child.
        let default = user_config_path(None).expect("this machine has a home directory");
        assert!(default.ends_with(".claude.json"));
        assert!(!default.to_string_lossy().contains("/.claude/"));
    }

    #[test]
    fn reads_all_three_scopes() {
        let project = json!({ "mcpServers": { "p": stdio("p") } });
        let user = json!({
            "mcpServers": { "u": stdio("u") },
            "projects": { "/w": { "mcpServers": { "l": stdio("l") } } }
        });
        let got = merge_scopes(Some(&project), Some(&user), "/w");
        let names: Vec<_> = got.iter().map(|e| (e.name.as_str(), e.scope)).collect();
        assert_eq!(
            names,
            vec![("l", McpScope::Local), ("p", McpScope::Project), ("u", McpScope::User)]
        );
    }

    #[test]
    fn narrowest_scope_wins_for_a_duplicated_name() {
        // One row, not three: the user sees the definition Claude will use.
        let project = json!({ "mcpServers": { "dup": stdio("project") } });
        let user = json!({
            "mcpServers": { "dup": stdio("user") },
            "projects": { "/w": { "mcpServers": { "dup": stdio("local") } } }
        });
        let got = merge_scopes(Some(&project), Some(&user), "/w");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].scope, McpScope::Local);
        assert_eq!(got[0].config["command"], "local");
    }

    #[test]
    fn an_unapproved_mcpjson_server_is_pending() {
        let project = json!({ "mcpServers": { "p": stdio("p") } });
        let got = merge_scopes(Some(&project), None, "/w");
        assert_eq!(got[0].approval, McpApproval::Pending);
    }

    #[test]
    fn approval_reads_the_projects_enabled_and_disabled_lists() {
        let project = json!({ "mcpServers": { "yes": stdio("a"), "no": stdio("b") } });
        let user = json!({ "projects": { "/w": {
            "enabledMcpjsonServers": ["yes"],
            "disabledMcpjsonServers": ["no"]
        }}});
        let got = merge_scopes(Some(&project), Some(&user), "/w");
        let by = |n: &str| got.iter().find(|e| e.name == n).unwrap().approval;
        assert_eq!(by("yes"), McpApproval::Approved);
        assert_eq!(by("no"), McpApproval::Disabled);
    }

    #[test]
    fn a_star_enables_every_mcpjson_server() {
        let project = json!({ "mcpServers": { "a": stdio("a"), "b": stdio("b") } });
        let user = json!({ "projects": { "/w": { "enabledMcpjsonServers": ["*"] }}});
        let got = merge_scopes(Some(&project), Some(&user), "/w");
        assert!(got.iter().all(|e| e.approval == McpApproval::Approved));
    }

    #[test]
    fn approval_is_scoped_to_this_project_only() {
        // An approval recorded against a different cwd must not leak.
        let project = json!({ "mcpServers": { "p": stdio("p") } });
        let user = json!({ "projects": { "/other": { "enabledMcpjsonServers": ["p"] }}});
        assert_eq!(merge_scopes(Some(&project), Some(&user), "/w")[0].approval, McpApproval::Pending);
    }

    #[test]
    fn user_and_local_servers_need_no_approval() {
        let user = json!({
            "mcpServers": { "u": stdio("u") },
            "projects": { "/w": { "mcpServers": { "l": stdio("l") } } }
        });
        let got = merge_scopes(None, Some(&user), "/w");
        assert!(got.iter().all(|e| e.approval == McpApproval::NotApplicable));
    }

    #[test]
    fn upsert_preserves_sibling_keys_and_other_servers() {
        let doc = json!({
            "$schema": "https://example/schema.json",
            "mcpServers": { "keep": stdio("keep") }
        });
        let out = upsert_server(Some(doc), "added", stdio("new"));
        assert_eq!(out["$schema"], "https://example/schema.json");
        assert_eq!(out["mcpServers"]["keep"]["command"], "keep");
        assert_eq!(out["mcpServers"]["added"]["command"], "new");
    }

    #[test]
    fn upsert_replaces_a_server_of_the_same_name() {
        let doc = json!({ "mcpServers": { "s": stdio("old") } });
        let out = upsert_server(Some(doc), "s", stdio("new"));
        assert_eq!(out["mcpServers"].as_object().unwrap().len(), 1);
        assert_eq!(out["mcpServers"]["s"]["command"], "new");
    }

    #[test]
    fn upsert_builds_a_document_from_nothing_or_from_junk() {
        for start in [None, Some(json!("not an object"))] {
            let out = upsert_server(start, "s", stdio("c"));
            assert_eq!(out["mcpServers"]["s"]["command"], "c");
        }
    }

    #[test]
    fn remove_reports_a_name_that_was_not_there() {
        let doc = json!({ "mcpServers": { "s": stdio("c") } });
        assert!(remove_server(Some(doc.clone()), "absent").is_none());
        let out = remove_server(Some(doc), "s").unwrap();
        assert!(out["mcpServers"].as_object().unwrap().is_empty());
    }

    #[test]
    fn an_unknown_transport_round_trips_intact() {
        // A shape we do not model (headers, a future transport) must survive
        // being read and written back, not be flattened into what we know.
        let exotic = json!({
            "type": "http",
            "url": "https://example/mcp",
            "headers": { "Authorization": "Bearer x" },
            "somethingNew": { "nested": [1, 2] }
        });
        let doc = upsert_server(None, "s", exotic.clone());
        let got = merge_scopes(Some(&doc), None, "/w");
        assert_eq!(got[0].config, exotic);
    }
}
