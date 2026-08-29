// The Spaces/Features switch is how you browse, not which work is open, so it
// restores that mode's last selection and otherwise leaves it alone. A space
// switch clears instead, because it is a different context, not a different list.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import type { Selection } from "./LeftSidebar";

const WORK = "/root/work/proj";
const MAIN = `${WORK}/main`;
const WAVE = `${WORK}/wave-3`;

const bridge = vi.hoisted(() => ({ features: [] as unknown[] }));

const unit = (label: string, folderPath: string) => ({
  label,
  folderPath,
  branch: label,
  kind: "worktree",
  isCurrent: false,
});

const config = {
  path: "/cfg/sway.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      external: false,
      projects: [
        { name: "proj", path: WORK, external: false, branchUnits: [unit("main", MAIN), unit("wave-3", WAVE)] },
      ],
    },
  ],
};

const AUTH = {
  id: "f1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: [{ repoPath: WORK, displayName: "proj", worktreePath: WAVE, state: { kind: "present" }, order: 0 }],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_features") return Promise.resolve(bridge.features);
    if (cmd === "list_sessions" || cmd === "list_project_attempts" || cmd === "sessions_running")
      return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: () => Promise.resolve(() => {}),
    isFocused: () => Promise.resolve(true),
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: () => Promise.resolve() }));

const { default: LeftSidebar } = await import("./LeftSidebar");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");

function mount() {
  const [sel, setSel] = createSignal<Selection | null>(null);
  const onSelect = vi.fn((s: Selection | null) => setSel(s));
  render(() => <LeftSidebar selected={sel()} onSelect={onSelect} liveTabs={[]} />);
  return { sel, onSelect };
}

const click = (name: string) => fireEvent.click(screen.getByText(name));
const segment = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("switching between Spaces and Features", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.features = [AUTH];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
    localStorage.setItem("sway.sidebar-mode.v1", "spaces");
    localStorage.setItem("sway.expanded.v1", JSON.stringify(["p:work/proj"]));
  });

  it("comes back to what each mode was last on", async () => {
    const { sel } = mount();
    await waitFor(() => expect(screen.getByText("wave-3")).toBeTruthy());
    click("wave-3");
    await waitFor(() => expect(sel()?.folderPath).toBe(WAVE));

    segment("Features");
    await waitFor(() => expect(screen.getByText("Auth")).toBeTruthy());
    click("Auth");
    await waitFor(() => expect(sel()?.kind).toBe("feature"));

    segment("Spaces");
    await waitFor(() => expect(sel()?.folderPath).toBe(WAVE));
    expect(sel()?.kind).toBe("unit");

    segment("Features");
    await waitFor(() => expect(sel()?.featureId).toBe("f1"));
  });

  it("leaves the selection alone when the other mode has nothing remembered", async () => {
    const { sel, onSelect } = mount();
    await waitFor(() => expect(screen.getByText("wave-3")).toBeTruthy());
    click("wave-3");
    await waitFor(() => expect(sel()?.folderPath).toBe(WAVE));
    onSelect.mockClear();

    segment("Features");
    await waitFor(() => expect(screen.getByText("Auth")).toBeTruthy());
    expect(onSelect).not.toHaveBeenCalled();
    expect(sel()?.folderPath).toBe(WAVE);
  });

  it("leaves the selection alone when the remembered Feature is gone", async () => {
    localStorage.setItem(
      "sway.selection-memory.v1",
      JSON.stringify({ spaces: {}, feature: { kind: "feature", featureId: "deleted", folderPath: WAVE } }),
    );
    const { sel, onSelect } = mount();
    await waitFor(() => expect(screen.getByText("wave-3")).toBeTruthy());
    click("wave-3");
    await waitFor(() => expect(sel()?.folderPath).toBe(WAVE));
    onSelect.mockClear();

    segment("Features");
    await waitFor(() => expect(screen.getByText("Auth")).toBeTruthy());
    expect(onSelect).not.toHaveBeenCalled();
  });
});
