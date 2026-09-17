// The record-only commands emit (#159 phase 1). `remove_member`,
// `reorder_members`, `rename_member` and `rename_topic` used to answer
// nothing and announce nothing, so every consumer of the shared tinted-members
// resource - the Toolbar's chips, the editor's tree, the Omnibox - kept showing
// the name and the order the Topic had when the window opened. The sidebar
// only looked right because it patched its own signal.
//
// What is asserted here is the *feed*, not the sidebar: an emitted
// `topics://changed` refetches (`createTopicMembers` is invalidation-based
// by design, one read per generation) and the chip row follows. The panels that
// take those members as a prop assert the prop drives them in their own files.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";

const A = "/w/api/.tori/worktrees/auth";
const B = "/w/web/.tori/worktrees/auth";

const member = (repoPath: string, displayName: string, worktreePath: string, order: number) => ({
  repoPath,
  displayName,
  worktreePath,
  state: { kind: "present" },
  order,
});

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  members: [] as Record<string, unknown>[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "list_topics")
      return Promise.resolve([
        { id: "f1", name: "Auth", branch: "feat/auth", createdAt: 1, members: bridge.members },
      ]);
    if (cmd === "get_config")
      return Promise.resolve({
        spaces: [{ name: "work", color: "Sky", projects: [{ path: "/w/api" }, { path: "/w/web" }] }],
      });
    return Promise.resolve(null);
  },
}));

const handlers = vi.hoisted(() => ({}) as Record<string, ((e: { payload: unknown }) => void)[]>);
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (handlers[name] ??= []).push(cb);
    return Promise.resolve(() => {});
  },
}));

const { default: Toolbar } = await import("./components/Toolbar/Toolbar");

const sel = {
  kind: "topic",
  topicId: "f1",
  topicName: "Auth",
  roots: [A, B],
  activeRoot: A,
  spaceName: "",
  projectName: "Auth",
  projectPath: A,
  folderPath: A,
  branch: "feat/auth",
  projectKind: "topic",
};

const changed = () => (handlers["topics://changed"] ?? []).slice().forEach((cb) => cb({ payload: null }));
const reads = () => bridge.calls.filter((c) => c.cmd === "list_topics").length;
const chips = () => Array.from(document.querySelectorAll<HTMLElement>("[data-member]"));
const names = () => chips().map((c) => c.getAttribute("aria-label"));
const sent = (cmd: string) => bridge.calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  bridge.calls.length = 0;
  bridge.members = [member("/w/api", "api", A, 0), member("/w/web", "web", B, 1)];
});

// The resource reads once per generation module-wide, so a second test in this
// file would be served the first one's record from the cache. One emit is what
// moves the generation on, which is the same mechanism under test.
async function mount(onActiveRoot?: (root: string) => void) {
  render(() => <Toolbar selected={sel as never} onActiveRoot={onActiveRoot} />);
  changed();
  await waitFor(() => expect(names()).toEqual(["api", "web"]));
}

describe("the Topic record feed", () => {
  it("refetches on the emit, so a renamed member reaches the Toolbar chip", async () => {
    await mount();
    const before = reads();

    bridge.members = [member("/w/api", "Payments API", A, 0), member("/w/web", "web", B, 1)];
    changed();

    await waitFor(() => expect(names()).toEqual(["Payments API", "web"]));
    expect(reads()).toBe(before + 1);
  });

  it("reorders the chip row on the emit a reorder produces", async () => {
    await mount();

    bridge.members = [member("/w/api", "api", A, 1), member("/w/web", "web", B, 0)];
    changed();

    await waitFor(() => expect(names()).toEqual(["web", "api"]));
  });

  it("drags a chip onto another and commits that order without switching the active root", async () => {
    const onActiveRoot = vi.fn();
    await mount(onActiveRoot);
    const [api, web] = chips();

    fireEvent.dragStart(web);
    fireEvent.dragOver(api);
    fireEvent.drop(api);
    // The click a drag ends with in the browsers that still send one.
    fireEvent.click(api);

    await waitFor(() => expect(sent("reorder_members").length).toBe(1));
    expect(sent("reorder_members")[0].args).toEqual({ topicId: "f1", repoPaths: ["/w/web", "/w/api"] });
    expect(onActiveRoot).not.toHaveBeenCalled();
  });
});
