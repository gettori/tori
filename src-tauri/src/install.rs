//! How an agent's binary gets onto the machine, given what its adapter
//! declares.
//!
//! The shape is [`crate::auth::login_route`]'s, deliberately: the routing
//! decision belongs to the backend, because only this side sees the adapter's
//! `[install]` table, and the frontend's half is what the rung *does* on
//! screen. Like a login, an install is a real PTY tab or it is nothing: the
//! vendor's installers stream output, prompt, and fail in ways the user has to
//! read, so Sway opens the door and never captures what happens behind it.
//!
//! (A previous module of this name downloaded and extracted archives itself,
//! with checksums and a platform matrix. This one runs the vendor's own
//! documented command in front of the user, which is a different trust
//! posture, not a rewrite of the same one.)

use serde::Serialize;

use crate::agents;

/// How this agent can be installed, given what its adapter declares.
///
/// Two rungs, degrading rather than failing, so every card resolves to one:
/// either the adapter carries the vendor's documented command, or the page
/// keeps saying "install `{program}` yourself", which was the only behaviour
/// before this table existed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum InstallRoute {
    /// Run this in a real PTY tab. No `home` here, unlike the login rung: an
    /// install lands a binary on `PATH`, which no profile variable relocates.
    Terminal { program: String, args: Vec<String> },
    /// The adapter declares no command, which is a fact about the adapter
    /// file: nothing has been verified end to end on a real machine, and an
    /// unverified one-liner would be a button that claims a measurement that
    /// never happened.
    Undeclared,
}

/// Pick the rung for one adapter.
pub fn install_route(adapter: &agents::AgentAdapter) -> InstallRoute {
    match &adapter.install {
        Some(spec) => {
            InstallRoute::Terminal { program: spec.program.clone(), args: spec.args.clone() }
        }
        None => InstallRoute::Undeclared,
    }
}

#[tauri::command]
pub fn agent_install_route(adapter_id: String) -> Result<InstallRoute, String> {
    let adapter =
        agents::find(&adapter_id).ok_or_else(|| format!("unknown agent `{adapter_id}`"))?;
    Ok(install_route(adapter))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundled(id: &str) -> agents::AgentAdapter {
        agents::find(id).unwrap_or_else(|| panic!("{id} ships bundled")).clone()
    }

    /// The one bundled adapter with a verified install path today. npm because
    /// it is the vendor's one documented command that covers every platform.
    #[test]
    fn copilot_installs_through_the_command_its_vendor_documents() {
        match install_route(&bundled("copilot")) {
            InstallRoute::Terminal { program, args } => {
                assert_eq!(program, "npm");
                assert_eq!(args, ["install", "-g", "@github/copilot"]);
            }
            other => panic!("copilot should open a terminal, got {other:?}"),
        }
    }

    /// No `[install]` means instructions, never a guessed package manager.
    #[test]
    fn an_adapter_without_the_table_stays_on_instructions() {
        assert!(bundled("claude").install.is_none(), "claude declares no [install] yet");
        assert_eq!(install_route(&bundled("claude")), InstallRoute::Undeclared);
    }

    /// Every bundled adapter reaches a rung, so no detail page dead-ends.
    #[test]
    fn every_bundled_adapter_resolves_to_a_rung() {
        for adapter in agents::registry() {
            let _ = install_route(adapter);
        }
    }
}
