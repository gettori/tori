// A Feature as the selection (#154 phase 1). The shell keys every store on
// `feature:<id>` rather than a folder, re-resolves a stored Feature against the
// live record, and backfills `kind` on a selection persisted before Features.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { installAnimationFrame } from "./test/frames";

const A = "/r/a/.sway/worktrees/auth";
const B = "/r/b/.sway/worktrees/auth";

const invoke = vi.fn();
const listeners = vi.hoisted(() => ({ handlers: {} as Record<string, () => void> }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, fn: () => void) => {
    listeners.handlers[name] = fn;
    return () => {};
  }),
  emit: vi.fn(async () => {}),
}));
vi.mock("./panels/LeftSidebar/LeftSidebar", () => ({ default: () => <div /> }));
vi.mock("./panels/Settings/Settings", () => ({ default: () => <div /> }));
vi.mock("./components/Toolbar/Toolbar", () => ({ default: () => <div /> }));
vi.mock("./components/UpdatePill/UpdatePill", () => ({ default: () => <div /> }));
vi.mock("./components/Omnibox/Omnibox", () => ({ default: () => <div /> }));
vi.mock("./panels/Terminal/Terminal", () => ({ default: () => null }));
vi.mock("./panels/Editor/Editor", () => ({ default: () => null }));

import { DEFAULT_SETTINGS } from "./panels/Settings/settingsStore";
const { default: App } = await import("./App");

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
installAnimationFrame();

const member = (repo: string, wt: string, order: number) => ({
  repoPath: repo,
  displayName: repo.split("/").pop(),
  worktreePath: wt,
  state: { kind: "present" },
  order,
});
const feature = (members: unknown[]) => ({
  id: "f1",
  name: "Auth",
  branch: "feat/auth",
  members,
  createdAt: 1,
});
const storedFeature = {
  kind: "feature",
  featureId: "f1",
  featureName: "Auth",
  roots: [A],
  activeRoot: A,
  spaceName: "",
  projectName: "Auth",
  projectPath: A,
  folderPath: A,
  branch: "feat/auth",
  projectKind: "feature",
};

let features: unknown[] = [feature([member("/r/a", A, 0)])];
const storedSelection = () => JSON.parse(localStorage.getItem("sway.selection.v1") ?? "null");

beforeEach(() => {
  localStorage.clear();
  features = [feature([member("/r/a", A, 0)])];
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_settings") return DEFAULT_SETTINGS;
    if (cmd === "onboarding_should_show") return false;
    if (cmd === "list_user_themes") return { themes: [], errors: [] };
    if (cmd === "list_features") return features;
    return null;
  });
});
afterEach(cleanup);

describe("a Feature as the selection", () => {
  it("keys the pane envelope on feature:<id>, not on the active member's folder", async () => {
    localStorage.setItem("sway.selection.v1", JSON.stringify(storedFeature));
    render(() => <App />);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("sway.panes.v1")!)).toHaveProperty("feature:f1"));
    expect(JSON.parse(localStorage.getItem("sway.panes.v1")!)).not.toHaveProperty(A);
  });

  it("re-resolves the stored snapshot against the record at startup and on config://changed", async () => {
    localStorage.setItem("sway.selection.v1", JSON.stringify(storedFeature));
    features = [feature([member("/r/a", A, 0), member("/r/b", B, 1)])];
    render(() => <App />);
    await waitFor(() => expect(storedSelection().roots).toEqual([A, B]));
    expect(storedSelection().activeRoot).toBe(A);

    features = [feature([member("/r/b", B, 1)])];
    listeners.handlers["config://changed"]();
    await waitFor(() => expect(storedSelection().roots).toEqual([B]));
    expect(storedSelection().activeRoot).toBe(B);
  });

  it("clears the selection when the Feature no longer exists", async () => {
    localStorage.setItem("sway.selection.v1", JSON.stringify(storedFeature));
    features = [];
    render(() => <App />);
    await waitFor(() => expect(storedSelection()).toBeNull());
  });

  it("loads a selection stored before Features as a unit", async () => {
    const { kind: _k, featureId: _f, ...unitish } = { ...storedFeature, folderPath: "/r/a", projectKind: "plain" };
    localStorage.setItem("sway.selection.v1", JSON.stringify(unitish));
    render(() => <App />);
    await waitFor(() => expect(storedSelection().kind).toBe("unit"));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("sway.panes.v1")!)).toHaveProperty("/r/a"));
    expect(invoke).not.toHaveBeenCalledWith("list_features");
  });
});

describe("a deleted Feature", () => {
  it("clears the selection and drops its pane tree and placements", async () => {
    const { PURGE_WORKSPACE, emitWith } = await import("./utils/events");
    localStorage.setItem("sway.selection.v1", JSON.stringify(storedFeature));
    render(() => <App />);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("sway.panes.v1")!)).toHaveProperty("feature:f1"));
    emitWith(PURGE_WORKSPACE, { workspace: "feature:f1" });
    await waitFor(() => expect(storedSelection()).toBeNull());
    const { flushEnvelopes } = await import("./layout/layoutStore");
    flushEnvelopes();
    expect(JSON.parse(localStorage.getItem("sway.panes.v1") ?? "{}")).not.toHaveProperty("feature:f1");
  });
});
