import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIRE_GRACE_MS, arm, armedFor, cancel, register, resetResumeAtResetForTests, type Arm } from "./resumeAtReset";

const RESET = 1_788_779_400;
const at = (a: Partial<Arm> = {}): Arm => ({ sessionId: "s1", accountKey: "claude/work", turnId: "t1", resetsAt: RESET, ...a });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(RESET * 1000 - 60 * 60 * 1000);
});
afterEach(() => {
  resetResumeAtResetForTests();
  vi.useRealTimers();
});

describe("arming", () => {
  it("arms one reset once", () => {
    expect(arm(at())).toBe(true);
    expect(arm(at())).toBe(false);
    expect(armedFor("s1")).toMatchObject({ turnId: "t1", resetsAt: RESET });
  });

  it("does not let the setting re-arm a cancelled reset, but the button can", () => {
    arm(at());
    cancel("s1");
    expect(arm(at())).toBe(false);
    expect(arm(at({ byHand: true }))).toBe(true);
  });
});

describe("firing", () => {
  it("fires after the grace, not on the reset itself", async () => {
    const fire = vi.fn(async () => {});
    register("s1", fire);
    arm(at());
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + FIRE_GRACE_MS - 1);
    expect(fire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(armedFor("s1")).toBeNull();
  });

  it("sends one session per account at a time", async () => {
    let finish!: () => void;
    const first = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const second = vi.fn(async () => {});
    register("s1", first);
    register("s2", second);
    arm(at());
    arm(at({ sessionId: "s2" }));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + FIRE_GRACE_MS);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("moves on to the next session when a send is refused", async () => {
    const second = vi.fn(async () => {});
    register("s1", async () => {
      throw new Error("locked");
    });
    register("s2", second);
    arm(at());
    arm(at({ sessionId: "s2" }));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + FIRE_GRACE_MS);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("moves on when the first session closed before its turn", async () => {
    const second = vi.fn(async () => {});
    const unregister = register("s1", vi.fn(async () => {}));
    register("s2", second);
    arm(at());
    arm(at({ sessionId: "s2" }));
    unregister();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + FIRE_GRACE_MS);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("cancelling", () => {
  it("sends nothing at reset after a cancel", async () => {
    const fire = vi.fn(async () => {});
    register("s1", fire);
    arm(at());
    cancel("s1");
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(fire).not.toHaveBeenCalled();
    expect(armedFor("s1")).toBeNull();
  });

  it("sends nothing at reset after the session's view goes away", async () => {
    const fire = vi.fn(async () => {});
    const unregister = register("s1", fire);
    arm(at());
    unregister();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(fire).not.toHaveBeenCalled();
  });
});
