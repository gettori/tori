import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent, within } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import type { Selection } from "./LeftSidebar";

const ROOT = "/cfg/chats";

const config = {
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      projects: [{ name: "repo", path: "/root/work/repo", branchUnits: [] }],
    },
  ],
  global: { projects: [] },
};

const NOW = Date.now();

const row = (id: string, chat: string, title: string, at: number) => ({
  id,
  path: `/t/${id}.jsonl`,
  cwd: `${ROOT}/${chat}`,
  branch: "",
  title,
  name: null,
  last_active: NOW - 100_000 + at,
  created_at: NOW - 100_000 + at,
  agent: "claude",
});

const bridge = vi.hoisted(() => ({
  rows: [] as unknown[],
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_topics") return Promise.resolve([]);
    if (cmd === "chats_root") return Promise.resolve(ROOT);
    if (cmd === "chat_new") return Promise.resolve({ id: "c9", folder: `${ROOT}/c9` });
    if (cmd === "list_sessions") return Promise.resolve(args?.folder === ROOT && args?.inclusive ? bridge.rows : []);
    if (cmd === "list_project_attempts" || cmd === "sessions_running") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
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
const { emit, onWith, NEW_CHAT, DRAFT_INTO_NEW, PURGE_WORKSPACE } = await import("../../utils/events");
const { COMMANDS } = await import("../../utils/commands");
const { forgetChat } = await import("../../utils/chats");

function mount(liveTabs: unknown[] = []) {
  const [sel, setSel] = createSignal<Selection | null>(null);
  render(() => <LeftSidebar selected={sel()} onSelect={setSel} liveTabs={liveTabs as never} />);
  return { sel };
}

const called = (cmd: string) => bridge.calls.filter((c) => c.cmd === cmd);
const chatRows = () => [...document.querySelectorAll<HTMLElement>("[data-chat]")];

describe("Global's chats", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.rows = [
      row("s1", "c1", "Plan a trip", 1_000),
      row("s2", "c2", "Draft a letter", 3_000),
      row("s3", "c1", "Plan a trip, rewound", 2_000),
    ];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "/global");
  });

  it("lists one row per chat folder, newest first, named by its newest session", async () => {
    mount();
    await waitFor(() => expect(chatRows()).toHaveLength(2));
    expect(chatRows().map((r) => r.dataset.chat)).toEqual(["c2", "c1"]);
    expect(chatRows()[1].textContent).toContain("Plan a trip, rewound");
    expect(screen.getByText("Chats").closest("[data-group-head]")?.textContent).toBe("Chats");
  });

  it("shows the working spinner on a chat whose session is running", async () => {
    mount([{ id: "tab-1", workspace: "chat:c2", kind: "agent", sessionId: "s2", agent: "claude", state: "live" }]);
    await waitFor(() => expect(chatRows()).toHaveLength(2));
    noteDots([{ id: "s2", dot: "working", certainty: "inferred", home: null }]);
    const c2 = chatRows()[0];
    await waitFor(() => expect(within(c2).getByTitle("Executing")).toBeTruthy());
    expect(c2.querySelector("time")).toBeNull();
    expect(chatRows()[1].querySelector("time")).toBeTruthy();
  });

  it("starts a chat on Cmd+N from a named space: Global, a selected New chat row, a draft in its folder", async () => {
    localStorage.setItem("tori.active-space.v1", "work");
    const { sel } = mount();
    await screen.findByText("repo");
    const drafts: unknown[] = [];
    const off = onWith(DRAFT_INTO_NEW, (d) => drafts.push(d));

    const key = { key: "n", code: "KeyN", metaKey: true, shiftKey: false, altKey: false, ctrlKey: false };
    expect(COMMANDS.find((c) => c.match?.(key as KeyboardEvent))?.id).toBe("chat-new");
    emit(NEW_CHAT);

    await waitFor(() => expect(sel()?.kind).toBe("chat"));
    off();
    expect(sel()).toMatchObject({ chatId: "c9", folderPath: `${ROOT}/c9`, spaceName: "/global" });
    expect(drafts).toEqual([{ workspace: "chat:c9", root: `${ROOT}/c9`, projectName: "New chat" }]);
    const fresh = await waitFor(() => chatRows().find((r) => r.dataset.chat === "c9")!);
    expect(fresh.getAttribute("aria-current")).toBe("true");
    expect(within(fresh).getByText("New chat")).toBeTruthy();
    forgetChat("c9");
  });

  it("lists the newest six and folds the rest, keeping a selected chat in place", async () => {
    bridge.rows = Array.from({ length: 9 }, (_, i) =>
      row(`r${i + 1}`, `n${i + 1}`, `Recent ${i + 1}`, 9_000 - i * 1_000),
    );
    const { sel } = mount();
    await waitFor(() => expect(chatRows()).toHaveLength(6));
    expect(chatRows().map((r) => r.dataset.chat)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6"]);

    fireEvent.click(screen.getByRole("button", { name: "3 more chats" }));
    await waitFor(() => expect(chatRows()).toHaveLength(9));
    fireEvent.click(chatRows()[7]);
    await waitFor(() => expect(sel()?.chatId).toBe("n8"));
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    await waitFor(() =>
      expect(chatRows().map((r) => r.dataset.chat)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n8"]),
    );
    expect(screen.getByRole("button", { name: "2 more chats" })).toBeTruthy();
  });

  it("lists every chat a filter matches, with no fold", async () => {
    bridge.rows = [
      ...Array.from({ length: 9 }, (_, i) => row(`r${i + 1}`, `n${i + 1}`, `Trip ${i + 1}`, 9_000 - i * 1_000)),
      row("x1", "other", "Groceries", 500),
    ];
    mount();
    await waitFor(() => expect(chatRows()).toHaveLength(6));
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.input(await screen.findByRole("textbox", { name: /^Filter/ }), { target: { value: "trip" } });
    await waitFor(() => expect(chatRows()).toHaveLength(9));
    expect(screen.queryByRole("button", { name: /more chats|Show less/ })).toBeNull();
  });

  it("deletes a chat whole: every session, then the folder, then its workspace", async () => {
    const { sel } = mount();
    await waitFor(() => expect(chatRows()).toHaveLength(2));
    fireEvent.click(chatRows()[1]);
    await waitFor(() => expect(sel()?.chatId).toBe("c1"));
    const purged: unknown[] = [];
    const off = onWith(PURGE_WORKSPACE, (p) => purged.push(p));

    fireEvent.contextMenu(chatRows()[1]);
    pointerClick(await screen.findByRole("menuitem", { name: "Delete chat" }));
    await screen.findByText("Delete Plan a trip, rewound?");
    expect(called("delete_session")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));

    await waitFor(() => expect(called("chat_delete")).toHaveLength(1));
    off();
    expect(called("delete_session").map((c) => c.args.path)).toEqual(["/t/s3.jsonl", "/t/s1.jsonl"]);
    expect(called("chat_delete")[0].args).toEqual({ chatId: "c1" });
    expect(purged).toEqual([{ workspace: "chat:c1", roots: [] }]);
    expect(sel()).toBeNull();
  });
});
