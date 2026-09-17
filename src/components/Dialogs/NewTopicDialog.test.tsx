import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import type { Topic } from "../../utils/topics";

type Probe = { valid: boolean; local: boolean; remote: boolean; hasWorktree: boolean };
const CLEAR: Probe = { valid: true, local: false, remote: false, hasWorktree: false };

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  probes: {} as Record<string, Probe>,
  // A probe answer is held here until the test releases it.
  hold: null as null | ((p: Probe) => void),
  createError: null as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "probe_topic_branch") {
      const key = `${args.repoPath}@${args.branch}`;
      if (key in bridge.probes) return Promise.resolve(bridge.probes[key]);
      if (bridge.hold === null) return Promise.resolve(CLEAR);
      return new Promise<Probe>((resolve) => (bridge.hold = resolve));
    }
    if (cmd === "create_topic") {
      if (bridge.createError) return Promise.reject(bridge.createError);
      return Promise.resolve({
        id: "f-1",
        name: String(args.name),
        branch: String(args.branch),
        createdAt: 1,
        members: (args.members as string[]).map((repoPath, order) => ({
          repoPath,
          displayName: repoPath.split("/").pop(),
          worktreePath: null,
          state: { kind: "present" },
          order,
        })),
      });
    }
    if (cmd === "add_member") return Promise.resolve(EXISTING);
    return Promise.resolve(null);
  },
}));

const { default: NewTopicDialog } = await import("./NewTopicDialog");

const SPACES = [
  {
    name: "work",
    external: false,
    projects: [
      { name: "api", path: "/w/api" },
      { name: "web", path: "/w/web" },
    ],
  },
];
const EXISTING: Topic = {
  id: "auth-1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: [{ repoPath: "/w/api", displayName: "api", worktreePath: null, state: { kind: "present" }, order: 0 }],
};

const name = () => screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
const branch = () => screen.getByRole("textbox", { name: "Branch" }) as HTMLInputElement;
const box = (label: string) => screen.getByRole("checkbox", { name: label }) as HTMLInputElement;
const done = () => screen.getByRole("button", { name: /Done|Working/ }) as HTMLButtonElement;
const probeCalls = () => bridge.calls.filter((c) => c.cmd === "probe_topic_branch");
// Kobalte's focus scope settles from a `setTimeout(0)`; a test that moved focus
// has to let that run before the render is torn down under it.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

function open(over: Partial<Parameters<typeof NewTopicDialog>[0]> = {}) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <NewTopicDialog spaces={SPACES} topics={[EXISTING]} onDone={onDone} onCancel={onCancel} {...over} />
  ));
  return { onDone, onCancel };
}

describe("NewTopicDialog", () => {
  beforeEach(() => {
    bridge.calls.length = 0;
    bridge.probes = {};
    bridge.hold = null;
    bridge.createError = null;
    vi.useRealTimers();
  });

  it("creates a Topic from a name and two repos", async () => {
    const { onDone } = open();
    expect(screen.getByRole("dialog", { name: "New Topic" })).toBeTruthy();
    expect(done().disabled).toBe(true);

    fireEvent.input(name(), { target: { value: "Search v2" } });
    expect(branch().value).toBe("search-v2");
    fireEvent.click(box("api"));
    fireEvent.click(box("web"));
    await waitFor(() => expect(done().disabled).toBe(false));
    await expectNoAxeViolations(document.body);

    fireEvent.click(done());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const call = bridge.calls.find((c) => c.cmd === "create_topic")!;
    expect(call.args).toEqual({ name: "Search v2", branch: "search-v2", members: ["/w/api", "/w/web"] });
  });

  it("fills Branch from the name until Branch is edited, then creates on the typed branch", async () => {
    const { onDone } = open();
    fireEvent.input(name(), { target: { value: "Login bug" } });
    expect(branch().value).toBe("login-bug");

    fireEvent.input(branch(), { target: { value: "bug/login" } });
    fireEvent.input(name(), { target: { value: "Login crash" } });
    expect(branch().value).toBe("bug/login");

    fireEvent.click(box("api"));
    await waitFor(() => expect(done().disabled).toBe(false));
    expect(probeCalls()[probeCalls().length - 1].args).toEqual({ repoPath: "/w/api", branch: "bug/login" });
    fireEvent.click(done());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const call = bridge.calls.find((c) => c.cmd === "create_topic")!;
    expect(call.args).toEqual({ name: "Login crash", branch: "bug/login", members: ["/w/api"] });
  });

  it("shows the collision row for a repo whose branch exists, and Adopt clears it", async () => {
    bridge.probes["/w/api@x"] = { valid: true, local: true, remote: false, hasWorktree: false };
    open();
    fireEvent.input(name(), { target: { value: "x" } });
    box("api").focus();
    fireEvent.click(box("api"));

    expect(await screen.findByText("x already exists")).toBeTruthy();
    expect(done().disabled).toBe(true);
    // The probe landing must not remount the row the keyboard is on.
    expect(document.activeElement).toBe(box("api"));

    fireEvent.click(screen.getByRole("button", { name: "Adopt in api" }));
    await screen.findByText("Adopting x");
    expect(box("api").checked).toBe(true);
    await waitFor(() => expect(done().disabled).toBe(false));
  });

  it("Rename this Topic unchecks the repo and returns to the name", async () => {
    bridge.probes["/w/api@x"] = { valid: true, local: false, remote: true, hasWorktree: false };
    open();
    fireEvent.input(name(), { target: { value: "x" } });
    fireEvent.click(box("api"));
    await screen.findByText("x already exists");

    fireEvent.click(screen.getByRole("button", { name: /Rename this Topic/ }));
    expect(box("api").checked).toBe(false);
    expect(document.activeElement).toBe(name());
    expect(screen.queryByText("x already exists")).toBeNull();
    await macrotask();
  });

  it("ignores a probe answer for a branch the name has moved past", async () => {
    open();
    fireEvent.click(box("api"));
    await waitFor(() => expect(probeCalls().length).toBe(0));

    // The first name's probe is held; the name moves on before it answers.
    bridge.hold = () => {};
    fireEvent.input(name(), { target: { value: "old" } });
    await waitFor(() => expect(probeCalls().some((c) => c.args.branch === "old")).toBe(true));
    const release = bridge.hold;
    bridge.hold = null;
    bridge.probes["/w/api@new"] = CLEAR;
    fireEvent.input(name(), { target: { value: "new" } });
    await waitFor(() => expect(probeCalls().some((c) => c.args.branch === "new")).toBe(true));

    release({ valid: true, local: true, remote: true, hasWorktree: true });
    await waitFor(() => expect(done().disabled).toBe(false));
    expect(screen.queryByText(/already exists/)).toBeNull();
  });

  it("refuses a branch another Topic already uses", async () => {
    open();
    fireEvent.input(name(), { target: { value: "Auth again" } });
    fireEvent.input(branch(), { target: { value: "feat/auth" } });
    fireEvent.click(box("web"));
    expect(await screen.findByText("already used by Auth")).toBeTruthy();
    await waitFor(() => expect(probeCalls().length).toBeGreaterThan(0));
    expect(done().disabled).toBe(true);
  });

  it("stays open with the message when the backend refuses", async () => {
    bridge.createError = "refusing to overwrite /w/api/.tori";
    const { onDone } = open();
    fireEvent.input(name(), { target: { value: "x" } });
    fireEvent.click(box("api"));
    await waitFor(() => expect(done().disabled).toBe(false));
    fireEvent.click(done());

    expect((await screen.findByRole("alert")).textContent).toContain("refusing to overwrite /w/api/.tori");
    expect(screen.getByRole("dialog", { name: "New Topic" })).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(done().disabled).toBe(false);
  });

  it("adds repositories to an existing Topic one at a time, members excluded", async () => {
    const { onDone } = open({ topic: EXISTING });
    expect(screen.getByRole("dialog", { name: "Add repository to Auth" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "api" })).toBeNull();

    fireEvent.click(box("web"));
    await waitFor(() => expect(done().disabled).toBe(false));
    fireEvent.click(done());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(EXISTING));
    const adds = bridge.calls.filter((c) => c.cmd === "add_member");
    expect(adds.map((c) => c.args)).toEqual([{ topicId: "auth-1", repoPath: "/w/web" }]);
    expect(probeCalls()[0].args).toEqual({ repoPath: "/w/web", branch: "feat/auth" });
  });

  // The same collision machinery in add mode, where the escape hatch differs:
  // the Topic's branch was frozen at creation, so the offer is to leave this
  // repo out rather than to change the branch.
  it("offers Leave out rather than a rename when an added repo already has the branch", async () => {
    bridge.probes["/w/web@feat/auth"] = { valid: true, local: true, remote: false, hasWorktree: false };
    open({ topic: EXISTING });
    fireEvent.click(box("web"));

    expect(await screen.findByText("feat/auth already exists")).toBeTruthy();
    expect(done().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Rename this Topic/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Leave out, web" }));
    await waitFor(() => expect(screen.queryByText("feat/auth already exists")).toBeNull());
    expect(box("web").checked).toBe(false);
    expect(bridge.calls.some((c) => c.cmd === "add_member")).toBe(false);
  });
});
