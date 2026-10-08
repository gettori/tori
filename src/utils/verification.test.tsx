import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createRoot, createSignal } from "solid-js";
import { render, screen, waitFor } from "@solidjs/testing-library";

const answers: Record<string, unknown[]> = {};
const listeners: Record<string, ((e: { payload: unknown }) => void)[]> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { sessionId: string }) => {
    if (cmd !== "session_verification") return Promise.resolve(null);
    return Promise.resolve(answers[args.sessionId] ?? []);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(fn);
    return Promise.resolve(() => {});
  },
}));

const { watchVerification, sessionVerdict, resetVerificationForTests } = await import("./verification");
const { default: TabMark } = await import("../panels/Terminal/TabMark");
const { default: HistoryRow } = await import("../panels/Terminal/HistoryRow");

const turn = (promptTs: number, verdict: string) => ({ promptTs, verdict, checks: [] });

describe("a live session's verification mark", () => {
  beforeEach(() => {
    resetVerificationForTests();
    for (const k of Object.keys(answers)) delete answers[k];
    for (const k of Object.keys(listeners)) delete listeners[k];
  });

  it("follows the latest turn that changed code, so a later fix clears it", async () => {
    answers["s"] = [turn(1, "unverified")];
    const [targets] = createSignal([{ id: "s", agent: "claude", cwd: "/repo", status: "idle" }]);
    createRoot(() => watchVerification(targets));
    await waitFor(() => expect(sessionVerdict("s")).toBe("unverified"));

    answers["s"] = [turn(1, "unverified"), turn(2, "verified")];
    listeners["sessions://changed"]?.forEach((f) => f({ payload: { folders: ["/repo"] } }));
    await waitFor(() => expect(sessionVerdict("s")).toBe("verified"));
  });

  it("says a failed or unverified session to a screen reader, and keeps verified quiet", () => {
    render(() => <TabMark agentId="claude" status="idle" verdict="unverified" />);
    expect(screen.getByLabelText(/Idle\s+Unverified/)).toBeTruthy();

    render(() => <TabMark agentId="claude" status="idle" verdict="verified" />);
    const quiet = screen.getByTitle(/Idle\s+Verified/);
    expect(quiet.getAttribute("aria-label")).toBeNull();
  });

  it("wears the same mark on the History row", () => {
    render(() => (
      <HistoryRow
        label="fix it"
        agentId="claude"
        status="idle"
        verdict="failed"
        when="3m"
        active={false}
        items={[]}
        onOpen={() => {}}
      />
    ));
    expect(screen.getByLabelText(/Checks failed/)).toBeTruthy();
  });
});
