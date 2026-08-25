import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import type { Feature } from "../../utils/features";

type Probe = { local: boolean; remote: boolean; hasWorktree: boolean };
const CLEAR: Probe = { local: false, remote: false, hasWorktree: false };

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
    if (cmd === "probe_feature_branch") {
      const key = `${args.repoPath}@${args.slug}`;
      if (key in bridge.probes) return Promise.resolve(bridge.probes[key]);
      if (bridge.hold === null) return Promise.resolve(CLEAR);
      return new Promise<Probe>((resolve) => (bridge.hold = resolve));
    }
    if (cmd === "create_feature") {
      if (bridge.createError) return Promise.reject(bridge.createError);
      return Promise.resolve({
        id: "f-1",
        name: String(args.name),
        branch: "feat/x",
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

const { default: NewFeatureDialog } = await import("./NewFeatureDialog");

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
const EXISTING: Feature = {
  id: "auth-1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: [{ repoPath: "/w/api", displayName: "api", worktreePath: null, state: { kind: "present" }, order: 0 }],
};

const name = () => screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
const box = (label: string) => screen.getByRole("checkbox", { name: label }) as HTMLInputElement;
const done = () => screen.getByRole("button", { name: /Done|Working/ }) as HTMLButtonElement;
const probeCalls = () => bridge.calls.filter((c) => c.cmd === "probe_feature_branch");
// Kobalte's focus scope settles from a `setTimeout(0)`; a test that moved focus
// has to let that run before the render is torn down under it.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

function open(over: Partial<Parameters<typeof NewFeatureDialog>[0]> = {}) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <NewFeatureDialog spaces={SPACES} features={[EXISTING]} onDone={onDone} onCancel={onCancel} {...over} />
  ));
  return { onDone, onCancel };
}

describe("NewFeatureDialog", () => {
  beforeEach(() => {
    bridge.calls.length = 0;
    bridge.probes = {};
    bridge.hold = null;
    bridge.createError = null;
    vi.useRealTimers();
  });

  it("creates a Feature from a name and two repos", async () => {
    const { onDone } = open();
    expect(screen.getByRole("dialog", { name: "New Feature" })).toBeTruthy();
    expect(done().disabled).toBe(true);

    fireEvent.input(name(), { target: { value: "Search v2" } });
    expect(screen.getByText("feat/search-v2")).toBeTruthy();
    fireEvent.click(box("api"));
    fireEvent.click(box("web"));
    await waitFor(() => expect(done().disabled).toBe(false));
    await expectNoAxeViolations(document.body);

    fireEvent.click(done());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const call = bridge.calls.find((c) => c.cmd === "create_feature")!;
    expect(call.args).toEqual({ name: "Search v2", members: ["/w/api", "/w/web"] });
  });

  it("shows the collision row for a repo whose branch exists, and Adopt clears it", async () => {
    bridge.probes["/w/api@x"] = { local: true, remote: false, hasWorktree: false };
    open();
    fireEvent.input(name(), { target: { value: "x" } });
    box("api").focus();
    fireEvent.click(box("api"));

    expect(await screen.findByText("feat/x already exists")).toBeTruthy();
    expect(done().disabled).toBe(true);
    // The probe landing must not remount the row the keyboard is on.
    expect(document.activeElement).toBe(box("api"));

    fireEvent.click(screen.getByRole("button", { name: "Adopt in api" }));
    await screen.findByText("Adopting feat/x");
    expect(box("api").checked).toBe(true);
    await waitFor(() => expect(done().disabled).toBe(false));
  });

  it("Rename this Feature unchecks the repo and returns to the name", async () => {
    bridge.probes["/w/api@x"] = { local: false, remote: true, hasWorktree: false };
    open();
    fireEvent.input(name(), { target: { value: "x" } });
    fireEvent.click(box("api"));
    await screen.findByText("feat/x already exists");

    fireEvent.click(screen.getByRole("button", { name: /Rename this Feature/ }));
    expect(box("api").checked).toBe(false);
    expect(document.activeElement).toBe(name());
    expect(screen.queryByText("feat/x already exists")).toBeNull();
    await macrotask();
  });

  it("ignores a probe answer for a slug the name has moved past", async () => {
    open();
    fireEvent.click(box("api"));
    await waitFor(() => expect(probeCalls().length).toBe(0));

    // The first name's probe is held; the name moves on before it answers.
    bridge.hold = () => {};
    fireEvent.input(name(), { target: { value: "old" } });
    await waitFor(() => expect(probeCalls().some((c) => c.args.slug === "old")).toBe(true));
    const release = bridge.hold;
    bridge.hold = null;
    bridge.probes["/w/api@new"] = CLEAR;
    fireEvent.input(name(), { target: { value: "new" } });
    await waitFor(() => expect(probeCalls().some((c) => c.args.slug === "new")).toBe(true));

    release({ local: true, remote: true, hasWorktree: true });
    await waitFor(() => expect(done().disabled).toBe(false));
    expect(screen.queryByText(/already exists/)).toBeNull();
  });

  it("refuses a slug another Feature already uses", async () => {
    open();
    fireEvent.input(name(), { target: { value: "Auth" } });
    fireEvent.click(box("web"));
    expect(await screen.findByText("already used by Auth")).toBeTruthy();
    await waitFor(() => expect(probeCalls().length).toBeGreaterThan(0));
    expect(done().disabled).toBe(true);
  });

  it("stays open with the message when the backend refuses", async () => {
    bridge.createError = "refusing to overwrite /w/api/.sway";
    const { onDone } = open();
    fireEvent.input(name(), { target: { value: "x" } });
    fireEvent.click(box("api"));
    await waitFor(() => expect(done().disabled).toBe(false));
    fireEvent.click(done());

    expect((await screen.findByRole("alert")).textContent).toContain("refusing to overwrite /w/api/.sway");
    expect(screen.getByRole("dialog", { name: "New Feature" })).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(done().disabled).toBe(false);
  });

  it("adds repositories to an existing Feature one at a time, members excluded", async () => {
    const { onDone } = open({ feature: EXISTING });
    expect(screen.getByRole("dialog", { name: "Add repository to Auth" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "api" })).toBeNull();

    fireEvent.click(box("web"));
    await waitFor(() => expect(done().disabled).toBe(false));
    fireEvent.click(done());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(EXISTING));
    const adds = bridge.calls.filter((c) => c.cmd === "add_member");
    expect(adds.map((c) => c.args)).toEqual([{ featureId: "auth-1", repoPath: "/w/web" }]);
    expect(probeCalls()[0].args).toEqual({ repoPath: "/w/web", slug: "auth" });
  });
});
