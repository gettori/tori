//! Ported from the panel's `chatStatus` (chatStore.ts). Replayed history is
//! never folded: what it held open is over, and a turn still running reopens
//! through live events.

use std::collections::{HashMap, HashSet};

use super::model::{ChatEvent, TurnOutcome};

const SUBAGENT_TASK: &str = "local_agent";

#[derive(Default, PartialEq)]
enum LaneKind {
    // Opened by an id alone: only a subagent asks anything.
    #[default]
    Unopened,
    Subagent,
    Task,
}

impl LaneKind {
    fn of(task_type: &str) -> Self {
        match task_type {
            SUBAGENT_TASK | "" => Self::Subagent,
            _ => Self::Task,
        }
    }
}

#[derive(Default)]
struct Lane {
    kind: LaneKind,
    parent: Option<String>,
    settled: bool,
}

#[derive(Default)]
pub struct Pulse {
    connected: bool,
    turn: Option<String>,
    completed: HashSet<String>,
    awaiting: bool,
    lanes: HashMap<String, Lane>,
    lane_of_call: HashMap<String, String>,
    done_at: u64,
}

fn turn_of(event: &ChatEvent) -> Option<&str> {
    match event {
        ChatEvent::TurnStarted { turn_id, .. }
        | ChatEvent::LocalCommand { turn_id, .. }
        | ChatEvent::TextDelta { turn_id, .. }
        | ChatEvent::ThinkingDelta { turn_id, .. }
        | ChatEvent::ToolCallStarted { turn_id, .. }
        | ChatEvent::ToolCallProgress { turn_id, .. }
        | ChatEvent::ToolCallCompleted { turn_id, .. }
        | ChatEvent::FileEdit { turn_id, .. }
        | ChatEvent::PlanUpdate { turn_id, .. }
        | ChatEvent::Usage { turn_id, .. } => Some(turn_id),
        _ => None,
    }
}

impl Pulse {
    pub fn sending(&mut self, sending: bool) {
        self.awaiting = sending;
    }

    fn open_turn(&mut self, turn: &str) {
        if self.completed.contains(turn) {
            return;
        }
        if self.turn.as_deref() != Some(turn) {
            self.awaiting = false;
        }
        self.turn = Some(turn.to_string());
    }

    pub fn fold(&mut self, event: &ChatEvent) {
        if let Some(turn) = turn_of(event).filter(|t| !t.is_empty()) {
            self.open_turn(turn);
        }
        match event {
            ChatEvent::SessionStarted { .. } | ChatEvent::SessionReady { .. } => self.connected = true,
            ChatEvent::TurnCompleted { turn_id, outcome, .. } => {
                self.completed.insert(turn_id.clone());
                if self.turn.as_deref() == Some(turn_id.as_str()) {
                    self.turn = None;
                }
                self.awaiting = false;
                match outcome {
                    TurnOutcome::Completed => self.done_at = crate::rpc::events::now_ms(),
                    // An interrupt kills the child and every subagent with it.
                    TurnOutcome::Cancelled => self.lanes.values_mut().for_each(|l| l.settled = true),
                    TurnOutcome::Errored => {}
                }
            }
            ChatEvent::PermissionRequest {
                tool_use_id,
                agent_id: Some(agent),
                ..
            }
            | ChatEvent::QuestionRequest {
                tool_use_id,
                agent_id: Some(agent),
                ..
            }
            | ChatEvent::SubagentCall {
                tool_use_id,
                agent_id: agent,
                ..
            } => self.note_lane(tool_use_id, agent),
            ChatEvent::SubagentStarted {
                agent_id,
                tool_use_id,
                task_type,
                ..
            } => {
                let parent = self.lane_of_call.get(tool_use_id).cloned();
                let lane = self.lanes.entry(agent_id.clone()).or_default();
                lane.kind = LaneKind::of(task_type);
                lane.parent = parent;
            }
            ChatEvent::SubagentUpdate {
                agent_id,
                status: Some(_),
                ..
            } => self.lanes.entry(agent_id.clone()).or_default().settled = true,
            _ => {}
        }
    }

    fn note_lane(&mut self, tool_use_id: &str, agent: &str) {
        self.lanes.entry(agent.to_string()).or_default();
        let root = self.root(agent);
        self.lane_of_call.insert(tool_use_id.to_string(), root);
    }

    fn root(&self, agent: &str) -> String {
        let mut seen = HashSet::from([agent.to_string()]);
        let mut id = agent.to_string();
        while let Some(parent) = self.lanes.get(&id).and_then(|l| l.parent.clone()) {
            if !seen.insert(parent.clone()) {
                break;
            }
            id = parent;
        }
        id
    }

    pub fn running(&self) -> bool {
        self.turn.is_some() || self.awaiting
    }

    pub fn background(&self) -> bool {
        self.lanes
            .values()
            .any(|l| !l.settled && (l.kind == LaneKind::Task || l.parent.is_none()))
    }

    pub fn is_connected(&self) -> bool {
        self.connected
    }

    pub fn done_at(&self) -> u64 {
        self.done_at
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Beat {
    pub session: String,
    pub cwd: String,
    pub approval: bool,
    pub question: bool,
    pub running: bool,
    pub background: bool,
    pub connected: bool,
    pub done_at: u64,
}

pub fn changes_status(event: &ChatEvent) -> bool {
    !matches!(
        event,
        ChatEvent::TextDelta { .. } | ChatEvent::ThinkingDelta { .. } | ChatEvent::ToolCallProgress { .. }
    )
}

#[derive(Default)]
pub struct Pulses(HashMap<String, Pulse>);

impl Pulses {
    pub fn get(&mut self, id: &str) -> &mut Pulse {
        self.0.entry(id.to_string()).or_default()
    }

    pub fn existing(&mut self, id: &str) -> Option<&mut Pulse> {
        self.0.get_mut(id)
    }

    pub fn peek(&self, id: &str) -> Option<&Pulse> {
        self.0.get(id)
    }

    pub fn forget(&mut self, id: &str) {
        self.0.remove(id);
    }
}
