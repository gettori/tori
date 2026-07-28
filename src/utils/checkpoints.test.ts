import { describe, it, expect } from "vitest";
import { stepCheckpointTrigger, type PromptTick } from "./checkpoints";

describe("stepCheckpointTrigger", () => {
  it("fires on a session's very first prompt", () => {
    const step = stepCheckpointTrigger({}, [
      { sessionId: "s1", repoPath: "/p", promptCount: 1, lastPromptTs: 100 },
    ]);
    expect(step.fired).toEqual([{ sessionId: "s1", repoPath: "/p", promptCount: 1, lastPromptTs: 100 }]);
  });

  it("does not re-fire while the prompt count stays the same", () => {
    const first = stepCheckpointTrigger({}, [{ sessionId: "s1", repoPath: "/p", promptCount: 1, lastPromptTs: 100 }]);
    const second = stepCheckpointTrigger(first.state, [
      { sessionId: "s1", repoPath: "/p", promptCount: 1, lastPromptTs: 100 },
    ]);
    expect(second.fired).toEqual([]);
  });

  it("fires again when the prompt count rises further", () => {
    const first = stepCheckpointTrigger({}, [{ sessionId: "s1", repoPath: "/p", promptCount: 1, lastPromptTs: 100 }]);
    const second = stepCheckpointTrigger(first.state, [
      { sessionId: "s1", repoPath: "/p", promptCount: 2, lastPromptTs: 200 },
    ]);
    expect(second.fired).toEqual([{ sessionId: "s1", repoPath: "/p", promptCount: 2, lastPromptTs: 200 }]);
  });

  it("a session with no prompts yet never fires", () => {
    const step = stepCheckpointTrigger({}, [{ sessionId: "s1", repoPath: "/p", promptCount: 0, lastPromptTs: 0 }]);
    expect(step.fired).toEqual([]);
  });

  it("tracks multiple sessions independently", () => {
    const first = stepCheckpointTrigger({}, [
      { sessionId: "a", repoPath: "/p", promptCount: 1, lastPromptTs: 100 },
      { sessionId: "b", repoPath: "/q", promptCount: 1, lastPromptTs: 100 },
    ]);
    expect(first.fired.map((f) => f.sessionId).sort()).toEqual(["a", "b"]);

    const second = stepCheckpointTrigger(first.state, [
      { sessionId: "a", repoPath: "/p", promptCount: 1, lastPromptTs: 100 }, // steady
      { sessionId: "b", repoPath: "/q", promptCount: 2, lastPromptTs: 200 }, // rose
    ]);
    expect(second.fired.map((f) => f.sessionId)).toEqual(["b"]);
  });
});

// Chat sessions report their own turn boundaries, so the poller must not also
// fire for them. Two drivers on one session would snapshot every turn twice
// under two timestamps, and the second capture would include the first turn's
// own edits.
describe("chat-driven sessions are excluded from the poller", () => {
  const tick = (sessionId: string, promptCount: number): PromptTick => ({
    sessionId,
    repoPath: "/repo",
    promptCount,
    lastPromptTs: 100,
  });

  it("does not fire for a session driven by its own turn events", () => {
    const { fired } = stepCheckpointTrigger({}, [tick("chat-1", 1)], new Set(["chat-1"]));
    expect(fired).toEqual([]);
  });

  it("still fires for a PTY session in the same tick", () => {
    const { fired } = stepCheckpointTrigger({}, [tick("chat-1", 1), tick("pty-1", 1)], new Set(["chat-1"]));
    expect(fired.map((f) => f.sessionId)).toEqual(["pty-1"]);
  });

  it("records the excluded session's count, so a handover does not fire a catch-up", () => {
    // Three chat turns happen while excluded. If the count were not recorded,
    // the first poll after the exclusion lifts would look like a rising edge and
    // snapshot a boundary that was already captured.
    const { state } = stepCheckpointTrigger({}, [tick("s1", 3)], new Set(["s1"]));
    expect(state.s1).toBe(3);
    const { fired } = stepCheckpointTrigger(state, [tick("s1", 3)], new Set());
    expect(fired).toEqual([]);
  });

  it("still fires once the count moves after a handover", () => {
    const { state } = stepCheckpointTrigger({}, [tick("s1", 3)], new Set(["s1"]));
    const { fired } = stepCheckpointTrigger(state, [tick("s1", 4)], new Set());
    expect(fired.map((f) => f.sessionId)).toEqual(["s1"]);
  });

  it("defaults to firing when no exclusion set is given", () => {
    // The PTY path calls this with one argument and must be unaffected.
    const { fired } = stepCheckpointTrigger({}, [tick("s1", 1)]);
    expect(fired.map((f) => f.sessionId)).toEqual(["s1"]);
  });
});
