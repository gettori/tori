//! How an agent's binary gets onto the machine, given what its adapter
//! declares.
//!
//! The shape is [`crate::auth::login_route`]'s, deliberately: the routing
//! decision belongs to the backend, because only this side sees the adapter's
//! `[install]` table, and the frontend's half is what the rung *does* on
//! screen. Like a login, an install is a real PTY tab or it is nothing: the
//! vendor's installers stream output, prompt, and fail in ways the user has to
//! read, so Tori opens the door and never captures what happens behind it.
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
        Some(spec) => InstallRoute::Terminal {
            program: spec.program.clone(),
            args: spec.args.clone(),
        },
        None => InstallRoute::Undeclared,
    }
}

/// The other two verbs the `[install]` table can carry, on the same rungs.
/// An empty arg list is undeclared even when the table exists: nothing was
/// verified for that verb, so nothing is offered.
pub fn update_route(adapter: &agents::AgentAdapter) -> InstallRoute {
    verb_route(adapter, |spec| &spec.update_args)
}

pub fn uninstall_route(adapter: &agents::AgentAdapter) -> InstallRoute {
    verb_route(adapter, |spec| &spec.uninstall_args)
}

fn verb_route(adapter: &agents::AgentAdapter, args_of: fn(&agents::InstallSpec) -> &Vec<String>) -> InstallRoute {
    match &adapter.install {
        Some(spec) if !args_of(spec).is_empty() => InstallRoute::Terminal {
            program: spec.program.clone(),
            args: args_of(spec).clone(),
        },
        _ => InstallRoute::Undeclared,
    }
}

#[tauri::command(async)]
pub fn agent_install_route(adapter_id: String) -> Result<InstallRoute, String> {
    let adapter = agents::find(&adapter_id).ok_or_else(|| format!("unknown agent `{adapter_id}`"))?;
    Ok(install_route(adapter))
}

#[tauri::command(async)]
pub fn agent_update_route(adapter_id: String) -> Result<InstallRoute, String> {
    let adapter = agents::find(&adapter_id).ok_or_else(|| format!("unknown agent `{adapter_id}`"))?;
    Ok(update_route(adapter))
}

#[tauri::command(async)]
pub fn agent_uninstall_route(adapter_id: String) -> Result<InstallRoute, String> {
    let adapter = agents::find(&adapter_id).ok_or_else(|| format!("unknown agent `{adapter_id}`"))?;
    Ok(uninstall_route(adapter))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundled(id: &str) -> agents::AgentAdapter {
        agents::find(id).unwrap_or_else(|| panic!("{id} ships bundled")).clone()
    }

    /// npm because it is the vendor's one documented command that covers every
    /// platform.
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
        assert!(bundled("kimi").install.is_none(), "kimi declares no [install] yet");
        assert_eq!(install_route(&bundled("kimi")), InstallRoute::Undeclared);
    }

    /// `npm install -g` is also npm's documented update, and `npm uninstall -g`
    /// its removal: three verbs, one table, all through the vendor's binary.
    #[test]
    fn copilot_updates_and_uninstalls_through_the_same_vendor_binary() {
        match update_route(&bundled("copilot")) {
            InstallRoute::Terminal { program, args } => {
                assert_eq!(program, "npm");
                assert_eq!(args, ["install", "-g", "@github/copilot"]);
            }
            other => panic!("copilot should update in a terminal, got {other:?}"),
        }
        match uninstall_route(&bundled("copilot")) {
            InstallRoute::Terminal { program, args } => {
                assert_eq!(program, "npm");
                assert_eq!(args, ["uninstall", "-g", "@github/copilot"]);
            }
            other => panic!("copilot should uninstall in a terminal, got {other:?}"),
        }
    }

    /// A table can declare fewer than all three verbs; the missing ones stay on
    /// instructions rather than borrowing the install args.
    #[test]
    fn a_verb_the_table_does_not_declare_stays_undeclared() {
        let mut adapter = bundled("copilot");
        let spec = adapter.install.as_mut().expect("copilot declares [install]");
        spec.update_args.clear();
        spec.uninstall_args.clear();
        assert_eq!(update_route(&adapter), InstallRoute::Undeclared);
        assert_eq!(uninstall_route(&adapter), InstallRoute::Undeclared);
        // The install verb is untouched by the other two being absent.
        assert!(matches!(install_route(&adapter), InstallRoute::Terminal { .. }));
    }

    /// Every bundled adapter reaches a rung, so no detail page dead-ends.
    #[test]
    fn every_bundled_adapter_resolves_to_a_rung() {
        for adapter in agents::registry() {
            let _ = install_route(adapter);
        }
    }
}
