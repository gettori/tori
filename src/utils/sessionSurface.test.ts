import { describe, it, expect } from "vitest";
import { routeSelection, restoreRoute } from "./sessionSurface";

const inputs = (over: Partial<Parameters<typeof routeSelection>[0]> = {}) => ({
  preference: "chat" as const,
  hostedHere: false,
  runningElsewhere: false,
  ...over,
});

describe("routeSelection", () => {
  it("opens chat by default", () => {
    expect(routeSelection(inputs())).toBe("chat");
  });

  it("opens the PTY agent tab when the fallback setting is on", () => {
    expect(routeSelection(inputs({ preference: "agent" }))).toBe("agent");
  });

  it("focuses an already-hosted session rather than opening a second driver", () => {
    // Both ways round: a second driver on one session id corrupts its
    // transcript, so the preference must not be able to override this.
    expect(routeSelection(inputs({ hostedHere: true }))).toBe("focus");
    expect(routeSelection(inputs({ preference: "agent", hostedHere: true }))).toBe("focus");
  });

  it("falls back to the PTY route for a session running outside Sway", () => {
    // Chat drives a session by resuming it, and resuming one that is already
    // running is the operation measured to corrupt the transcript.
    expect(routeSelection(inputs({ runningElsewhere: true }))).toBe("agent");
  });

  it("prefers focus over the external-run fallback", () => {
    // Our own tab hosting it is the stronger fact: a stale pgrep hit must not
    // spawn a second tab for a session already on screen.
    expect(routeSelection(inputs({ hostedHere: true, runningElsewhere: true }))).toBe("focus");
  });
});

describe("restoreRoute", () => {
  it("restores each stored kind on its own surface", () => {
    expect(restoreRoute("agent")).toBe("agent");
    expect(restoreRoute("chat")).toBe("chat");
    // A shell respawns as a shell; the restore loop narrows agent-vs-shell
    // itself, and only needs "not chat" from here.
    expect(restoreRoute("shell")).toBe("agent");
  });

  it("takes no preference input at all, so the flip cannot convert saved tabs", () => {
    // The regression this guards: routing restore through `routeSelection`
    // would silently reopen every saved agent tab as a chat, moving live
    // sessions onto a surface that drives them a different way, for every
    // workspace at once and before the user has looked at anything.
    expect(restoreRoute.length).toBe(1);
    // Three saved agent tabs restore as three agent tabs, not as chats.
    const saved = ["agent", "agent", "agent"] as const;
    expect(saved.map(restoreRoute)).toEqual(["agent", "agent", "agent"]);
  });
});
