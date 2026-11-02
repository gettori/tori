import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent, within } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import type { Selection } from "./LeftSidebar";

const REPO = "/root/work/repo";
const LAB = "/root/side/lab";

const unit = (label: string, folderPath: string) => ({
  label,
  folderPath,
  branch: label,
  kind: "worktree",
  isCurrent: label === "main",
});

const config = {
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      projects: [{ name: "repo", path: REPO, branchUnits: [unit("main", `${REPO}/main`)] }],
    },
    {
      name: "side",
      path: "/root/side",
      projects: [{ name: "lab", path: LAB, branchUnits: [unit("main", `${LAB}/main`)] }],
    },
  ],
};

const member = (repoPath: string, displayName: string, worktreePath: string | null = null) => ({
  repoPath,
  displayName,
  worktreePath,
  state: { kind: "present" },
  order: 0,
});
const topic = (id: string, name: string, space: string | undefined, members: ReturnType<typeof member>[]) => ({
  id,
  name,
  branch: `feat/${id}`,
  createdAt: 1,
  members,
  ...(space ? { space } : {}),
});

const PAY = topic("pay", "Pay", "work", [member(REPO, "repo", `${REPO}/.tori/worktrees/pay`)]);
const CART = topic("cart", "Cart", "work", [member(REPO, "repo")]);
const AUTH = topic("auth", "Auth", undefined, [member(REPO, "repo")]);
const BENCH = topic("bench", "Bench", "side", [member(LAB, "lab")]);

const bridge = vi.hoisted(() => ({
  topics: [] as unknown[],
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_topics") return Promise.resolve(bridge.topics);
    if (cmd === "create_topic")
      return Promise.resolve({
        ...topic("new", String(args.name), args.space as string | undefined, [member(REPO, "repo")]),
        branch: String(args.branch),
        home: "/home/new",
      });
    if (cmd === "add_member") {
      const t = (bridge.topics as ReturnType<typeof topic>[]).find((t) => t.id === args.topicId)!;
      return Promise.resolve({ ...t, members: [...t.members, member(LAB, "lab", String(args.worktreePath))] });
    }
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
const { noteDots, resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { DRAFT_INTO_NEW, onWith } = await import("../../utils/events");

const PAY_TAB = {
  id: "tab-1",
  workspace: "topic:pay",
  kind: "agent" as const,
  sessionId: "s-pay",
  state: "live" as const,
};
const payIdle = () =>
  noteDots([
    {
      id: "s-pay",
      dot: "solid",
      certainty: "inferred",
      home: { project: REPO, folder: "/h", branch: null, topic: "pay" },
    },
  ]);

function mount(liveTabs: (typeof PAY_TAB)[] = []) {
  const [sel, setSel] = createSignal<Selection | null>(null);
  render(() => <LeftSidebar selected={sel()} onSelect={setSel} liveTabs={liveTabs} />);
  return { sel };
}

const head = (label: string) => document.querySelector<HTMLElement>(`[data-group-head="${label}"]`);
// Topics mode's list stays mounted, hidden, beside the Spaces tree.
const spacesTree = () => within(document.querySelector<HTMLElement>("[data-spaces-tree]")!);
const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const filter = async (text: string) => {
  const toggle = screen.queryByRole("button", { name: "Filter" });
  if (toggle) fireEvent.click(toggle);
  fireEvent.input(await screen.findByRole("textbox", { name: "Filter projects" }), { target: { value: text } });
};

describe("Topics in a space's tree", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.topics = [PAY, CART, AUTH, BENCH];
    bridge.calls.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.sidebar-mode.v1", "spaces");
  });

  it("lists the space's own Topics above its projects, each group headed", async () => {
    mount();
    const pay = await screen.findByText("Pay");
    expect(spacesTree().getByText("Cart")).toBeTruthy();
    expect(spacesTree().queryByText("Auth")).toBeNull();
    expect(screen.queryByText("Bench")).toBeNull();

    const topics = head("Topics")!;
    const projects = head("Projects")!;
    expect(topics.textContent).toContain("2");
    expect(projects.textContent).toContain("1");
    expect(before(topics, pay)).toBe(true);
    expect(before(pay, projects)).toBe(true);
    expect(before(projects, screen.getByText("repo", { selector: "[class*=label]" }))).toBe(true);
  });

  it("draws no group, and no projects heading, for a space without Topics", async () => {
    bridge.topics = [AUTH];
    mount();
    await screen.findByText("repo");
    expect(head("Topics")).toBeNull();
    expect(head("Projects")).toBeNull();
  });

  it("keeps a space's Topics out of Topics mode and a global one in it", async () => {
    mount();
    await screen.findByText("Pay");
    fireEvent.click(screen.getByRole("button", { name: "Topics" }));
    await screen.findByText("Auth");
    expect(screen.queryByText("Pay")).toBeNull();
    expect(screen.queryByText("Bench")).toBeNull();
  });

  it("counts what the filter leaves and hides a group it empties", async () => {
    mount();
    await screen.findByText("Pay");
    await filter("pay");
    await waitFor(() => expect(head("Topics")!.textContent).toContain("1 of 2"));
    expect(screen.queryByText("Cart")).toBeNull();
    expect(head("Projects")).toBeNull();
    expect(screen.queryByText("no matches in this space")).toBeNull();

    await filter("nothing-matches");
    await waitFor(() => expect(head("Topics")).toBeNull());
    expect(screen.getByText("no matches in this space")).toBeTruthy();
  });

  it("remembers a collapsed group per space", async () => {
    mount();
    await screen.findByText("Pay");
    const toggle = () => head("Topics")!.querySelector("button[aria-expanded]") as HTMLButtonElement;
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.queryByText("Pay")).toBeNull());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "side" }));
    expect(await screen.findByText("Bench")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "work" }));
    await waitFor(() => expect(head("Topics")).toBeTruthy());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Pay")).toBeNull();
  });

  it("shows what its Topics are doing on the header while collapsed", async () => {
    mount([PAY_TAB]);
    await screen.findByText("Pay");
    payIdle();
    expect(head("Topics")!.querySelector('[title="Idle"]')).toBeNull();

    fireEvent.click(head("Topics")!.querySelector("button[aria-expanded]")!);
    await waitFor(() => expect(head("Topics")!.querySelector('[title="Idle"]')).toBeTruthy());
  });

  it("bubbles a Topic chat to its space's tile only while its row is off screen", async () => {
    mount([PAY_TAB]);
    await screen.findByText("Pay");
    payIdle();
    const workTile = () => screen.getByRole("button", { name: "work" }).parentElement!;
    await waitFor(() => expect(screen.getByText("Pay").closest("li")?.querySelector('[title="Idle"]')).toBeTruthy());
    expect(workTile().querySelector('[title="1 idle"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Topics" }));
    await waitFor(() => expect(workTile().querySelector('[title="1 idle"]')).toBeTruthy());
  });

  it("makes a Topic from the space menu and stays in the space to open its draft", async () => {
    const drafts: unknown[] = [];
    const off = onWith(DRAFT_INTO_NEW, (d) => drafts.push(d));
    const { sel } = mount();
    await screen.findByText("Pay");
    pointerClick(screen.getByRole("button", { name: "Actions for work" }));
    pointerClick(await screen.findByRole("menuitem", { name: /New Topic/ }));
    await screen.findByRole("dialog", { name: "New Topic in work" });
    fireEvent.input(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Ship" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "repo" }));
    const create = screen.getByRole("button", { name: "Create Topic" }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);

    await waitFor(() => expect(sel()?.topicId).toBe("new"));
    expect(bridge.calls.find((c) => c.cmd === "create_topic")!.args.space).toBe("work");
    expect(drafts).toEqual([{ workspace: "topic:new", root: "/home/new", projectName: "Ship" }]);
    expect(head("Topics")).toBeTruthy();
    expect(screen.getByText("Ship")).toBeTruthy();
    expect(localStorage.getItem("tori.sidebar-mode.v1")).toBe("spaces");
    off();
  });

  describe("moving a worktree into a Topic", () => {
    const asReference = (t: ReturnType<typeof topic>) => ({
      ...t,
      members: [{ ...member(REPO, "repo"), mode: "reference" }],
    });
    beforeEach(() => {
      bridge.topics = [asReference(PAY), asReference(AUTH)];
    });

    const moveMain = async (into: string) => {
      localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/repo"]));
      const { sel } = mount();
      fireEvent.contextMenu(await screen.findByText("main"));
      pointerClick(await screen.findByText("Move to topic…"));
      fireEvent.click(await screen.findByRole("radio", { name: into }));
      fireEvent.click(screen.getByRole("button", { name: "Move" }));
      return sel;
    };

    it("lands on a space Topic in its space's tree", async () => {
      const sel = await moveMain("Pay");
      await waitFor(() => expect(sel()?.topicId).toBe("pay"));
      expect(localStorage.getItem("tori.sidebar-mode.v1")).toBe("spaces");
      expect(localStorage.getItem("tori.active-space.v1")).toBe("work");
      expect(spacesTree().getByText("Pay")).toBeTruthy();
    });
  });
});
