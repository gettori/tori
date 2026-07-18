import { describe, it, expect } from "vitest";
import { stepCheckpointTrigger } from "./checkpoints";

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
