//! Native in-app chat: driving an agent harness as a long-lived stream-json
//! process and normalizing its output into one transport-neutral event model.
//!
//! The layering is deliberate and one-directional:
//!
//! | Module | Knows about |
//! |---|---|
//! | [`model`] | nothing (the normalized events and commands) |
//! | [`transport`] | the model (the harness-neutral seam) |
//! | [`claude`] | the model, plus Claude's wire format |
//! | [`claude_transport`] | the seam, plus `claude`'s process |
//! | [`ownership`] | session ids and the process table |
//! | [`host`] | the seam, plus ownership |
//! | [`commands`] | all of it, plus Tauri |
//!
//! Nothing below `commands` mentions Tauri, which is what lets the whole session
//! lifecycle be tested headlessly.
//!
//! Phase 1's blanket `#![allow(dead_code)]` is gone as of Phase 3, as it said it
//! would be: the model and the Claude mapper are now reached from a live
//! session rather than from tests only.

pub mod approval;
pub mod claude;
pub mod claude_transport;
pub mod commands;
pub mod history;
pub mod host;
pub mod mcp;
pub mod model;
pub mod ownership;
pub mod rules;
/// The version-1 rule parser, kept only so tests can prove a Sway that predates
/// a format change refuses to act on a file written after it. Test-only: it must
/// never be reachable from the shipping decision path.
#[cfg(test)]
pub mod rules_v1_frozen;
pub mod snapshot;
pub mod transport;

#[cfg(test)]
mod neutrality_check;
