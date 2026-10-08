import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createRoot, createSignal } from "solid-js";
import { render, screen, waitFor } from "@solidjs/testing-library";

const calls: { sessionId: string }[] = [];
const answers: Record<string, unknown[]> = {};
const listeners: Record<string, ((e: { payload: unknown }) => void)[]> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { sessionId: string }) => {
    if (cmd !== "session_secrets") return Promise.resolve(null);
    calls.push(args);
    return Promise.resolve(answers[args.sessionId] ?? []);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(fn);
    return Promise.resolve(() => {});
  },
}));

const { watchSecrets, sessionSecret, resetSecretReadsForTests } = await import("./secretReads");
const { default: TabMark } = await import("../panels/Terminal/TabMark");
type Target = import("./secretReads").SecretTarget;

const read = { promptTs: 1, paths: ["/repo/.env"], strength: "read" };
const named = { promptTs: 2, paths: [".env"], strength: "named" };

function watch(initial: Target[]) {
  const [targets, setTargets] = createSignal(initial);
  const dispose = createRoot((d) => {
    watchSecrets(targets);
    return d;
  });
  return { setTargets, dispose };
}

describe("a live session's secret mark", () => {
  beforeEach(() => {
    resetSecretReadsForTests();
    calls.length = 0;
    for (const k of Object.keys(answers)) delete answers[k];
    for (const k of Object.keys(listeners)) delete listeners[k];
  });

  it("marks a chat, a terminal agent and an ACP chat once each has a hit", async () => {
    answers["chat"] = [read];
    answers["pty"] = [named];
    answers["acp"] = [{ ...read, promptTs: null }];
    watch([
      { id: "chat", agent: "claude", cwd: "/repo", status: "idle" },
      { id: "pty", agent: "claude", cwd: "/repo", status: "executing" },
      { id: "acp", agent: "codex", cwd: "/repo", status: "idle" },
    ]);
    await waitFor(() => expect(sessionSecret("acp")).toBe("read"));
    expect(sessionSecret("chat")).toBe("read");
    expect(sessionSecret("pty")).toBe("named");

    render(() => <TabMark agentId="claude" status="idle" secret={sessionSecret("pty")} />);
    expect(screen.getByLabelText(/Idle\s+A command named a secret file/)).toBeTruthy();
  });

  it("asks again when the status moves or a transcript changes, and not otherwise", async () => {
    const { setTargets } = watch([{ id: "s", agent: "claude", cwd: "/repo", status: "executing" }]);
    await waitFor(() => expect(calls).toHaveLength(1));
    setTargets([{ id: "s", agent: "claude", cwd: "/repo", status: "executing" }]);
    expect(calls).toHaveLength(1);

    answers["s"] = [read];
    setTargets([{ id: "s", agent: "claude", cwd: "/repo", status: "idle" }]);
    await waitFor(() => expect(sessionSecret("s")).toBe("read"));

    listeners["sessions://changed"]?.forEach((f) => f({ payload: { folders: null } }));
    listeners["settings://changed"]?.forEach((f) => f({ payload: null }));
    await waitFor(() => expect(calls).toHaveLength(4));
  });

  it("asks only about the sessions in the folders whose transcripts moved", async () => {
    watch([
      { id: "here", agent: "claude", cwd: "/repo/sub", status: "idle" },
      { id: "there", agent: "claude", cwd: "/other", status: "idle" },
    ]);
    await waitFor(() => expect(calls).toHaveLength(2));
    listeners["sessions://changed"]?.forEach((f) => f({ payload: { folders: ["/repo"] } }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2].sessionId).toBe("here");
  });

  it("drops the mark when the session stops being live", async () => {
    answers["s"] = [read];
    const { setTargets } = watch([{ id: "s", agent: "claude", cwd: "/repo", status: "idle" }]);
    await waitFor(() => expect(sessionSecret("s")).toBe("read"));
    setTargets([]);
    expect(sessionSecret("s")).toBeNull();
  });

  it("never asks about a session that is not live", () => {
    watch([]);
    expect(calls).toHaveLength(0);
  });
});
