//! Tori keeps no rule here: a group allow answers each prompt through its own
//! agent with that agent's "always", so what persists is the agent's own rule.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};

use crate::chat::host::WaitingPermission;
use crate::chat::model::{ChatEvent, PermissionSuggestion};

use super::events::project_of;

// The fields that say what a call acts on. Anything else in an input is the
// agent's own free text or context (claude's `description`, codex's `cwd`), and
// would split identical commands into groups of one.
const ACTION_FIELDS: [&str; 5] = ["command", "file_path", "path", "url", "pattern"];

pub const CHANGED_EVENT: &str = "permissions://changed";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub session: String,
    pub id: String,
    pub project: Option<String>,
    pub folder: String,
    pub agent: String,
    pub tool: String,
    pub action: Option<String>,
    pub group: String,
    pub auto_deny_at_ms: Option<u64>,
    pub rule: Option<String>,
}

#[tauri::command(async)]
pub fn permissions_pending() -> Result<Value, String> {
    super::office_call("permissions.pending", json!({}))
}

#[tauri::command(async)]
pub fn permissions_allow_group(ids: Value) -> Result<Value, String> {
    super::office_call("permissions.allow_group", json!({ "ids": ids }))
}

#[tauri::command(async)]
pub fn permissions_deny(session: String, id: String) -> Result<Value, String> {
    super::office_call("permissions.deny", json!({ "session": session, "id": id }))
}

pub fn rows(waiting: Vec<WaitingPermission>, projects: &[PathBuf]) -> Vec<Row> {
    waiting.into_iter().filter_map(|w| row(w, projects)).collect()
}

fn row(waiting: WaitingPermission, projects: &[PathBuf]) -> Option<Row> {
    let ChatEvent::PermissionRequest {
        tool_use_id,
        tool_name,
        input,
        auto_deny_at_ms,
        suggestions,
        ..
    } = waiting.event
    else {
        return None;
    };
    let project = project_of(&waiting.cwd, projects);
    let action = action_of(&input);
    let group = match &action {
        Some(action) => {
            let place = project.as_deref().unwrap_or(&waiting.cwd);
            json!([place, waiting.agent, tool_name, action.key]).to_string()
        }
        None => json!(["alone", waiting.session, tool_use_id]).to_string(),
    };
    Some(Row {
        session: waiting.session,
        id: tool_use_id,
        project,
        folder: waiting.cwd,
        agent: waiting.agent,
        tool: tool_name,
        action: action.map(|a| a.shown),
        group,
        auto_deny_at_ms,
        rule: kept_rule(&suggestions),
    })
}

struct Action {
    key: Value,
    shown: String,
}

fn action_of(input: &Value) -> Option<Action> {
    ACTION_FIELDS.iter().find_map(|field| {
        let shown = match &input[field] {
            Value::String(text) if !text.is_empty() => text.clone(),
            Value::Array(argv) if !argv.is_empty() && argv.iter().all(Value::is_string) => {
                argv.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")
            }
            _ => return None,
        };
        Some(Action {
            key: input[field].clone(),
            shown,
        })
    })
}

// ACP options carry no rules, so this is claude's alone today.
fn kept_rule(suggestions: &[PermissionSuggestion]) -> Option<String> {
    suggestions.iter().find_map(|s| match s {
        PermissionSuggestion::AddRules { rules, behavior, .. } if behavior == "allow" && !rules.is_empty() => Some(
            rules
                .iter()
                .map(|r| match &r.rule_content {
                    Some(content) => format!("{}({content})", r.tool_name),
                    None => r.tool_name.clone(),
                })
                .collect::<Vec<_>>()
                .join(", "),
        ),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::model::SuggestedRule;

    fn asked(session: &str, cwd: &str, agent: &str, tool: &str, input: Value) -> WaitingPermission {
        WaitingPermission {
            session: session.into(),
            cwd: cwd.into(),
            agent: agent.into(),
            event: ChatEvent::PermissionRequest {
                session_id: session.into(),
                tool_use_id: format!("{session}-call"),
                tool_name: tool.into(),
                input,
                request_id: format!("{session}-req"),
                auto_deny_at_ms: Some(1),
                agent_id: None,
                suggestions: Vec::new(),
            },
        }
    }

    fn projects() -> Vec<PathBuf> {
        vec![PathBuf::from("/code/tori")]
    }

    #[test]
    fn the_same_command_with_different_descriptions_is_one_group() {
        let rows = rows(
            vec![
                asked(
                    "a",
                    "/code/tori/one",
                    "claude",
                    "Bash",
                    json!({"command": "pnpm test", "description": "Run tests"}),
                ),
                asked(
                    "b",
                    "/code/tori/two",
                    "claude",
                    "Bash",
                    json!({"command": "pnpm test", "description": "Run the suite"}),
                ),
                asked("c", "/code/tori/two", "claude", "Bash", json!({"command": "pnpm lint"})),
            ],
            &projects(),
        );
        assert_eq!(rows[0].group, rows[1].group);
        assert_ne!(rows[0].group, rows[2].group);
        assert_eq!(rows[0].project.as_deref(), Some("/code/tori"));
        assert_eq!(rows[0].action.as_deref(), Some("pnpm test"));
    }

    #[test]
    fn a_prompt_with_no_action_field_is_never_grouped() {
        let rows = rows(
            vec![
                asked("a", "/code/tori", "codex", "Edit files", Value::Null),
                asked("b", "/code/tori", "codex", "Edit files", Value::Null),
            ],
            &projects(),
        );
        assert_ne!(rows[0].group, rows[1].group);
        assert_eq!(rows[0].action, None);
    }

    #[test]
    fn a_prompt_outside_every_project_groups_only_within_its_folder() {
        let rows = rows(
            vec![
                asked("a", "/elsewhere/x", "claude", "Bash", json!({"command": "ls"})),
                asked("b", "/elsewhere/x", "claude", "Bash", json!({"command": "ls"})),
                asked("c", "/elsewhere/y", "claude", "Bash", json!({"command": "ls"})),
            ],
            &projects(),
        );
        assert_eq!(rows[0].project, None);
        assert_eq!(rows[0].group, rows[1].group);
        assert_ne!(rows[0].group, rows[2].group);
    }

    #[test]
    fn agents_of_different_kinds_never_share_a_group() {
        let rows = rows(
            vec![
                asked("a", "/code/tori", "claude", "Bash", json!({"command": "ls"})),
                asked("b", "/code/tori", "opencode", "Bash", json!({"command": "ls"})),
            ],
            &projects(),
        );
        assert_ne!(rows[0].group, rows[1].group);
    }

    /// Measured on codex-acp 1.12.0: a command approval's raw input is
    /// `{command, cwd}`, so the same command in two worktrees differs only in
    /// `cwd`, which is not an action field.
    #[test]
    fn codex_commands_from_two_worktrees_share_a_group() {
        let title = "Run command";
        let rows = rows(
            vec![
                asked(
                    "a",
                    "/code/tori/one",
                    "codex",
                    title,
                    json!({"command": "pnpm test", "cwd": "/code/tori/one"}),
                ),
                asked(
                    "b",
                    "/code/tori/two",
                    "codex",
                    title,
                    json!({"command": "pnpm test", "cwd": "/code/tori/two"}),
                ),
            ],
            &projects(),
        );
        assert_eq!(rows[0].group, rows[1].group);
    }

    #[test]
    fn an_argv_command_is_shown_joined_and_grouped_as_the_array() {
        let rows = rows(
            vec![
                asked(
                    "a",
                    "/code/tori",
                    "codex",
                    "Run command",
                    json!({"command": ["pnpm", "test"]}),
                ),
                asked(
                    "b",
                    "/code/tori",
                    "codex",
                    "Run command",
                    json!({"command": "pnpm test"}),
                ),
            ],
            &projects(),
        );
        assert_eq!(rows[0].action.as_deref(), Some("pnpm test"));
        assert_ne!(rows[0].group, rows[1].group);
    }

    #[test]
    fn the_rule_claude_would_keep_is_named() {
        let mut waiting = asked("a", "/code/tori", "claude", "Bash", json!({"command": "pnpm test"}));
        if let ChatEvent::PermissionRequest { suggestions, .. } = &mut waiting.event {
            suggestions.push(PermissionSuggestion::AddRules {
                rules: vec![SuggestedRule {
                    tool_name: "Bash".into(),
                    rule_content: Some("pnpm test:*".into()),
                }],
                behavior: "allow".into(),
                destination: "localSettings".into(),
            });
        }
        assert_eq!(
            rows(vec![waiting], &projects())[0].rule.as_deref(),
            Some("Bash(pnpm test:*)")
        );
    }
}
