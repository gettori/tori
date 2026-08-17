//! Native in-app chat: driving an agent agent as a long-lived stream-json
//! process and normalizing its output into one transport-neutral event model.
//!
//! The layering is deliberate and one-directional:
//!
//! | Module | Knows about |
//! |---|---|
//! | [`model`] | nothing (the normalized events and commands) |
//! | [`transport`] | the model (the agent-neutral seam) |
//! | [`claude`] | the model, plus Claude's wire format |
//! | [`claude_transport`] | the seam, plus `claude`'s process |
//! | [`acp`] | the model, plus the ACP schema |
//! | [`acp_sessions`] | session ids and one JSON file per ACP session |
//! | [`acp_transport`] | the seam, plus `acp`'s process and its locators |
//! | [`ownership`] | session ids and the process table |
//! | [`pacing`] | the model, plus the seam's sink |
//! | [`host`] | the seam, plus ownership and pacing |
//! | [`commands`] | all of it, plus Tauri |
//!
//! Nothing below `commands` mentions Tauri, which is what lets the whole session
//! lifecycle be tested headlessly.
//!
//! Phase 1's blanket `#![allow(dead_code)]` is gone as of Phase 3, as it said it
//! would be: the model and the Claude mapper are now reached from a live
//! session rather than from tests only.

pub mod acp;
pub mod acp_sessions;
pub mod acp_transport;
pub mod approval;
pub mod claude;
pub mod claude_transport;
pub mod commands;
pub mod history;
pub mod host;
pub mod mcp;
pub mod model;
pub mod ownership;
pub mod pacing;
pub mod retired;
pub mod snapshot;
pub mod transport;
pub mod usage;

#[cfg(test)]
mod neutrality_check;
