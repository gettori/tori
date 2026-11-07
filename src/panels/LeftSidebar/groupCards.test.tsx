import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createEvent, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { rightClick, pointerClick } from "../../test/menus";
import type { PullRequest, StatusReport, UnitStatus } from "../../utils/forgeTypes";

const GH = "/root/work/gh";

const worktree = (branch: string) => ({
  label: branch,
  folderPath: `${GH}/${branch}`,
  branch,
  kind: "worktree",
  isCurrent: false,
});

const bridge = vi.hoisted(() => ({
  branches: [] as string[],
  calls: [] as string[],
  stacked: false,
  saved: {} as Record<string, unknown>,
  groups: [] as { name: string; colour?: string; branches: string[] }[],
  writes: [] as { name: string; branches: string[] }[][],
}));

const LAYERS: Record<string, number> = { schema: 1, api: 2, ui: 3 };

const status = (headRef: string): UnitStatus => {
  const position = bridge.stacked ? LAYERS[headRef] : undefined;
  const pullRequest: PullRequest | null = position
    ? {
        number: 470 + position,
        title: headRef,
        body: null,
        state: "open",
        isDraft: false,
        author: "skarif2",
        createdAt: "2026-10-01T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        comments: 0,
        headRef,
        baseRef: "main",
        headSha: "sha",
        headRepoIsOrigin: true,
        url: `https://github.com/skarif2/tori/pull/${470 + position}`,
        mergeableState: "clean",
        stack: { number: 470, size: 3, position, baseRef: "main" },
      }
    : null;
  return {
    headRef,
    pullRequest,
    checks: { state: "none", total: 0, failing: 0, skipped: 0, contexts: [] },
    reviewDecision: "none",
    reviews: [],
    requestedReviewers: [],
    viewerReview: null,
  };
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { project: string; order: unknown }) => {
    bridge.calls.push(cmd);
    if (cmd === "set_settings") return Promise.resolve((args as unknown as { settings: unknown }).settings);
    if (cmd === "set_project_groups") {
      const groups = (args as unknown as { groups: typeof bridge.groups }).groups;
      bridge.groups = structuredClone(groups);
      bridge.writes.push(structuredClone(groups));
      return Promise.resolve();
    }
    if (cmd === "sidebar_order_read") return Promise.resolve(structuredClone(bridge.saved));
    if (cmd === "sidebar_order_write") {
      bridge.saved[args!.project] = structuredClone(args!.order);
      return Promise.resolve();
    }
    if (cmd === "get_config")
      return Promise.resolve({
        path: "/cfg/tori.toml",
        roots: ["/root"],
        spaces: [
          {
            name: "work",
            path: "/root/work",
            projects: [
              {
                name: "gh",
                path: GH,
                branchUnits: bridge.branches.map(worktree),
                ...(bridge.groups.length ? { groups: structuredClone(bridge.groups) } : {}),
              },
            ],
          },
        ],
      });
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve("git@github.com:skarif2/tori.git");
    if (cmd === "forge_accounts")
      return Promise.resolve([
        {
          host: "github.com",
          accounts: [
            {
              id: "personal",
              provider: "github",
              baseUrl: "https://github.com",
              login: "skarif2",
              label: "skarif2",
              expiresAt: null,
              auth: { kind: "signedIn", login: "skarif2" },
            },
          ],
        },
      ]);
    if (cmd === "forge_repo_account")
      return Promise.resolve({
        kind: "account",
        accountId: "personal",
        host: "github.com",
        auth: { kind: "signedIn", login: "skarif2" },
      });
    if (cmd === "forge_unit_statuses")
      return Promise.resolve({
        statuses: bridge.branches.map(status),
        uncovered: 0,
        rate: { remaining: 4800, limit: 5000, resetAt: null },
      } satisfies StatusReport);
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
const { resetForgeStatusForTests } = await import("../../utils/forgeStatus");
const { emit, GROUP_BRANCHES } = await import("../../utils/events");
const { resetSidebarOrderForTests } = await import("../../utils/sidebarOrder");
const { setSidebar } = await import("../Settings/settingsStore");
const { GROUP_COLORS } = await import("../../utils/spaceTint");
const [FIRST, , , LAST] = GROUP_COLORS;

const labels = () =>
  [...document.querySelectorAll("[class*='label']")]
    .map((el) => el.textContent ?? "")
    .filter((l) => bridge.branches.includes(l) || l.startsWith("G") || l.startsWith("New group"));
const rowOf = (label: string) => screen.getByText(label).closest("[draggable]") as HTMLElement;
const headerOf = (name: string) => document.querySelector(`[data-group="${name}"] [draggable]`) as HTMLElement;

function drag(from: HTMLElement, onto: HTMLElement, zone: "top" | "middle" | "bottom" = "top") {
  const data: Record<string, string> = {};
  const dataTransfer = {
    effectAllowed: "none",
    dropEffect: "none",
    setData: (t: string, v: string) => (data[t] = v),
    getData: (t: string) => data[t] ?? "",
  };
  onto.getBoundingClientRect = () => ({ top: 0, height: 40 }) as DOMRect;
  const y = { top: 2, middle: 20, bottom: 38 }[zone];
  const send = (el: Element, type: "dragStart" | "dragOver" | "drop") => {
    const ev = createEvent[type](el, { clientY: y });
    Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
    // jsdom's DragEvent drops `clientY` from its init.
    Object.defineProperty(ev, "clientY", { value: y });
    fireEvent(el, ev);
  };
  send(from, "dragStart");
  send(onto, "dragOver");
  send(onto, "drop");
}

const mount = () => render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);
const nameInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Group name"]');
const lastWrite = () => bridge.writes[bridge.writes.length - 1];

describe("custom groups", () => {
  beforeEach(async () => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    resetForgeStatusForTests();
    resetSidebarOrderForTests();
    bridge.calls.length = 0;
    bridge.saved = {};
    bridge.groups = [];
    bridge.writes = [];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/gh"]));
    await setSidebar({ cardColours: "subtle" });
  });

  it("draws a three-member group as a card that stays collapsed across a reload", async () => {
    bridge.branches = ["main", "a", "b", "c", "d"];
    bridge.groups = [{ name: "G1", branches: ["a", "b", "c"] }];
    const view = mount();
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-group="G1"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(card).getByText("3")).toBeTruthy();
    expect(within(card).getByText("b")).toBeTruthy();

    fireEvent.click(headerOf("G1"));
    await waitFor(() => expect(screen.queryByText("b")).toBeNull());
    view.unmount();
    mount();
    await waitFor(() => expect(document.querySelector('[data-group="G1"]')).toBeTruthy());
    expect(screen.queryByText("b")).toBeNull();
  });

  it("groups a row dropped on another's middle, opening the name editor through a reload", async () => {
    bridge.branches = ["main", "a", "b"];
    mount();
    await screen.findByText("b");
    drag(rowOf("b"), rowOf("a"), "middle");
    await waitFor(() => expect(lastWrite()).toEqual([{ name: "New group", branches: ["a", "b"] }]));
    await waitFor(() => expect(bridge.calls.filter((c) => c === "get_config").length).toBeGreaterThan(1));
    await waitFor(() => expect(document.activeElement).toBe(nameInput()));
    expect(nameInput()!.value).toBe("New group");
    expect([nameInput()!.selectionStart, nameInput()!.selectionEnd]).toEqual([0, 9]);

    fireEvent.input(nameInput()!, { target: { value: "Billing" } });
    fireEvent.keyDown(nameInput()!, { key: "Enter" });
    await waitFor(() => expect(lastWrite()).toEqual([{ name: "Billing", branches: ["a", "b"] }]));
  });

  it("keeps New group when the editor is escaped", async () => {
    bridge.branches = ["main", "a", "b"];
    mount();
    await screen.findByText("b");
    drag(rowOf("b"), rowOf("a"), "middle");
    await waitFor(() => expect(nameInput()).toBeTruthy());
    fireEvent.keyDown(nameInput()!, { key: "Escape" });
    await waitFor(() => expect(nameInput()).toBeNull());
    expect(lastWrite()).toEqual([{ name: "New group", branches: ["a", "b"] }]);
  });

  it("groups ⌘-clicked rows with ⌘G in the topmost one's place, and a plain click or Escape clears them", async () => {
    bridge.branches = ["main", "a", "b", "c"];
    mount();
    await screen.findByText("c");
    fireEvent.click(rowOf("a"), { metaKey: true });
    fireEvent.click(rowOf("a"));
    expect(document.querySelector("[class*='picked']")).toBeNull();

    fireEvent.click(rowOf("c"), { metaKey: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector("[class*='picked']")).toBeNull();

    fireEvent.click(rowOf("c"), { metaKey: true });
    fireEvent.click(rowOf("a"), { metaKey: true });
    expect(document.querySelectorAll("[class*='picked']").length).toBe(2);
    emit(GROUP_BRANCHES);
    await waitFor(() => expect(lastWrite()).toEqual([{ name: "New group", branches: ["a", "c"] }]));
    fireEvent.keyDown(nameInput()!, { key: "Enter" });
    await waitFor(() => expect(labels()).toEqual(["main", "New group", "a", "c", "b"]));
  });

  it("offers Group N branches on a picked row's menu, and ⇧-click picks the range", async () => {
    bridge.branches = ["main", "a", "b", "c"];
    mount();
    await screen.findByText("c");
    fireEvent.click(rowOf("a"), { metaKey: true });
    fireEvent.click(rowOf("c"), { shiftKey: true });
    expect(document.querySelectorAll("[class*='picked']").length).toBe(3);
    rightClick(rowOf("b"));
    pointerClick(await screen.findByRole("menuitem", { name: "Group 3 branches" }));
    await waitFor(() => expect(lastWrite()).toEqual([{ name: "New group", branches: ["a", "b", "c"] }]));
  });

  it("drags a row into a group and back out", async () => {
    bridge.branches = ["main", "a", "b", "c"];
    bridge.groups = [{ name: "G1", branches: ["a"] }];
    mount();
    await screen.findByText("c");
    drag(rowOf("c"), headerOf("G1"), "middle");
    await waitFor(() => expect(lastWrite()).toEqual([{ name: "G1", branches: ["a", "c"] }]));
    drag(rowOf("c"), rowOf("a"), "top");
    await waitFor(() => expect(lastWrite()).toEqual([{ name: "G1", branches: ["c", "a"] }]));
    drag(rowOf("a"), rowOf("b"), "bottom");
    await waitFor(() => expect(lastWrite()).toEqual([{ name: "G1", branches: ["c"] }]));
    await waitFor(() => expect(labels()).toEqual(["main", "b", "a", "G1", "c"]));
  });

  it("reorders one group past another", async () => {
    bridge.branches = ["main", "a", "b"];
    bridge.groups = [
      { name: "G1", branches: ["a"] },
      { name: "G2", branches: ["b"] },
    ];
    mount();
    await waitFor(() => expect(labels()).toEqual(["main", "G1", "a", "G2", "b"]));
    drag(headerOf("G2"), headerOf("G1"), "top");
    await waitFor(() => expect(labels()).toEqual(["main", "G2", "b", "G1", "a"]));
  });

  it("renames from the header menu, and ungroups leaving the rows in place", async () => {
    bridge.branches = ["main", "a", "b", "c"];
    bridge.groups = [{ name: "G1", branches: ["a", "b"] }];
    mount();
    await screen.findByText("c");
    rightClick(headerOf("G1"));
    pointerClick(await screen.findByRole("menuitem", { name: "Rename" }));
    await waitFor(() => expect(nameInput()?.value).toBe("G1"));
    const loads = () => bridge.calls.filter((c) => c === "get_config").length;
    const before = loads();
    fireEvent.input(nameInput()!, { target: { value: "Gx" } });
    fireEvent.keyDown(nameInput()!, { key: "Enter" });
    await waitFor(() => expect(lastWrite()).toEqual([{ name: "Gx", branches: ["a", "b"] }]));
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
    await waitFor(() => expect(headerOf("Gx")).toBeTruthy());

    rightClick(headerOf("Gx"));
    pointerClick(await screen.findByRole("menuitem", { name: "Ungroup" }));
    await waitFor(() => expect(lastWrite()).toEqual([]));
    await waitFor(() => expect(labels()).toEqual(["main", "a", "b", "c"]));
  });

  it("shows a group's colour only in Colourful, where its menu sets it and a new group takes a free hue", async () => {
    bridge.branches = ["main", "a", "b", "c"];
    bridge.groups = [{ name: "G1", colour: LAST.name, branches: ["a"] }];
    mount();
    const card = () => document.querySelector<HTMLElement>('[data-group="G1"]');
    await waitFor(() => expect(card()).toBeTruthy());
    expect(card()!.dataset.hue).toBeUndefined();
    rightClick(headerOf("G1"));
    await screen.findByRole("menuitem", { name: "Rename" });
    expect(screen.queryByRole("menuitem", { name: FIRST.name })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await setSidebar({ cardColours: "colourful" });
    await waitFor(() => expect(card()!.style.getPropertyValue("--card-icon")).toBe(LAST.hex));
    rightClick(headerOf("G1"));
    pointerClick(await screen.findByRole("menuitem", { name: FIRST.name }));
    await waitFor(() => expect(lastWrite()).toEqual([{ name: "G1", colour: FIRST.name, branches: ["a"] }]));
    await waitFor(() => expect(card()?.style.getPropertyValue("--card-icon")).toBe(FIRST.hex));

    drag(rowOf("c"), rowOf("b"), "middle");
    await waitFor(() => expect(lastWrite()).toHaveLength(2));
    expect(GROUP_COLORS.slice(1).map((c) => c.name)).toContain((lastWrite()[1] as { colour?: string }).colour);
  });
});
