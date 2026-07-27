//! Native in-app chat: driving an agent harness as a long-lived stream-json
//! process and normalizing its output into one transport-neutral event model.
//!
//! Phase 1 lands the model and the Claude mappers only. The session host, the
//! ownership registry and the Tauri commands arrive in Phase 3, and the
//! approval/snapshot bridge in Phase 4.
//!
//! Until Phase 3 wires the mapper into a live session, everything here is
//! reachable only from tests, so the whole module would otherwise emit a dozen
//! dead-code warnings on an already warning-heavy build and bury real ones.
//! **Phase 3 removes this allow**; if it is still here once `chat_spawn` exists,
//! something genuinely is unused.
#![allow(dead_code)]

pub mod claude;
pub mod model;

#[cfg(test)]
mod neutrality_check;
