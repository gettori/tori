import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";

// The History dropdown is the only way to reach a session once the sidebar's
// rows are gone, so what is asserted here is mostly *reach*: every session in
// the folder appears exactly once, nothing outside the folder appears at all,
// and each row can still do what its sidebar row could.
const REPO = "/root/work/repo";
const OTHER = "/root/work/other";

const HOUR = 3_600;
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

const session = (id: string, lastActive: number, over: Record<string, unknown> = {}) => ({
  id,
  path: `${REPO}/.t/${id}.jsonl`,
  cwd: REPO,
  branch: "main",
  title: id,
  last_active: lastActive,
  created_at: lastActive,
  name: null,
  agent: "claude",
  ...over,
});

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  listings: {} as Record<string, unknown[]>,
  historical: false,
  running: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "list_sessions") return Promise.resolve(bridge.listings[String(args.folder)] ?? []);
    if (cmd === "folder_historical") return Promise.resolve(bridge.historical);
    if (cmd === "sessions_running") return Promise.resolve(bridge.running);
    if (cmd === "session_tail_state") return Promise.resolve("done");
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));

const { default: HistoryPanel } = await import("./HistoryPanel");
const { expectNoAxeViolations } = await import("../../test/axe");
const { trackFolders, resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { noteLiveTabs, probeBatch, resetSessionActivityForTests } = await import(
  "../../utils/sessionActivity"
);
const { SESSION_ACTION } = await import("../../utils/events");
const { ago } = await import("../../utils/relativeTime");

// The panel portals itself to <body>, which the shared `cleanup` does not
// reach, so each mount is disposed by hand rather than left for the next test
// to count as its own rows.
let mounted: ReturnType<typeof render> | null = null;
/** The History button the panel hangs off, focused the way a click leaves it. */
let anchorBtn: HTMLButtonElement | null = null;
function unmountPanel() {
  mounted?.unmount();
  mounted = null;
  anchorBtn?.remove();
  anchorBtn = null;
}

/** How many times the panel asked to be dismissed. */
let closed = 0;

/** Mount the panel over a seeded store, the way the tab bar opens it. */
async function open(folder = REPO, openSessionIds: string[] = []) {
  await trackFolders([REPO, OTHER]);
  bridge.calls.length = 0;
  closed = 0;
  anchorBtn = document.createElement("button");
  anchorBtn.textContent = "History";
  document.body.append(anchorBtn);
  anchorBtn.focus();
  mounted = render(() => (
    <HistoryPanel
      folder={folder}
      breadcrumb={["work", "repo", "main"]}
      openSessionIds={openSessionIds}
      anchorEl={anchorBtn!}
      onClose={() => closed++}
    />
  ));
  return mounted;
}

/** The panel's rows, in render order, by the session name each carries. */
const rowLabels = () => screen.queryAllByRole("option").map((r) => r.getAttribute("title") ?? "");
/** The scrolling list, which is the listbox inside the dialog. */
const listEl = () => document.querySelector('[role="listbox"]')!;
/** Its section headings, which are the era names and the Historical disclosure. */
const sections = () =>
  Array.from(listEl().children)
    .filter((d) => d.getAttribute("role") !== "option")
    .map((d) => d.textContent ?? "");

const actions: { sessionId: string; action: string }[] = [];
const noteAction = (e: Event) => actions.push((e as CustomEvent).detail);

describe("what the History dropdown lists", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    actions.length = 0;
    bridge.calls.length = 0;
    bridge.historical = false;
    bridge.running = [];
    bridge.listings = { [REPO]: [], [OTHER]: [] };
    window.addEventListener(SESSION_ACTION, noteAction);
  });
  afterEach(() => {
    unmountPanel();
    window.removeEventListener(SESSION_ACTION, noteAction);
  });

  // The scale it has to survive: this machine has a 47-session folder, which is
  // where "one flat list" stops being readable and a session listed twice stops
  // being noticeable.
  it("shows every session in the folder exactly once, live ones above the eras", async () => {
    const many = Array.from({ length: 47 }, (_, i) =>
      // Spread across every era so no bucket is empty by accident.
      session(`s${i}`, now() - i * 18 * HOUR),
    );
    bridge.listings[REPO] = many;
    await open(REPO, ["s3", "s20"]);

    const labels = rowLabels();
    expect(labels).toHaveLength(47);
    expect(new Set(labels).size).toBe(47);
    // The two open ones lead, whatever their age - s20 is two weeks old.
    expect(labels.slice(0, 2)).toEqual(["s3", "s20"]);
    expect(sections()[0]).toBe("Open now");
  });

  it("renders no heading for an era nothing fell into", async () => {
    // `now()` rather than an hour ago: the eras break on local midnight, so a
    // fixture an hour old lands in "Yesterday" for any run between 00:00 and
    // 01:00. Only the current second is Today by construction.
    bridge.listings[REPO] = [session("today", now()), session("old", now() - 90 * DAY)];
    await open();
    expect(sections()).toEqual(["Today", "Older"]);
  });

  // The degenerate case, and the one a first-run user actually sees: a single
  // session they just started. Five era headings over one row would be noise.
  it("shows one row and no era headings for a lone live session", async () => {
    bridge.listings[REPO] = [session("only", now())];
    await open(REPO, ["only"]);
    expect(rowLabels()).toHaveLength(1);
    expect(sections()).toEqual(["Open now"]);
  });

  // Branch-scoped by construction: the panel hangs off the tab bar, which is
  // already showing one workspace's tabs.
  it("lists nothing from another folder", async () => {
    bridge.listings[REPO] = [session("mine", now())];
    bridge.listings[OTHER] = [session("theirs", now(), { cwd: OTHER })];
    await open();
    expect(rowLabels()).toEqual(["mine"]);
  });

  it("filters both sections by the search field", async () => {
    bridge.listings[REPO] = [
      session("alpha", now(), { name: "alpha" }),
      session("beta", now() - 3 * DAY, { name: "beta" }),
    ];
    await open(REPO, ["alpha"]);
    expect(rowLabels()).toHaveLength(2);

    fireEvent.input(screen.getByLabelText("Search sessions"), { target: { value: "bet" } });
    expect(rowLabels()).toEqual(["beta"]);
  });

  // The bar is overflow:hidden - it has to be, or a long tab strip would scroll
  // instead of collapsing into `+N` - so a panel rendered inside it is clipped
  // to one row's height (gotcha: overflow-hidden on a positioned bar clips its
  // own dropdown).
  it("renders outside the container it was mounted in", async () => {
    bridge.listings[REPO] = [session("s", now())];
    const { container } = await open();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe("what a History row can do", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    actions.length = 0;
    bridge.calls.length = 0;
    bridge.historical = false;
    bridge.running = [];
    bridge.listings = { [REPO]: [session("s1", now())], [OTHER]: [] };
    window.addEventListener(SESSION_ACTION, noteAction);
  });
  afterEach(() => {
    unmountPanel();
    window.removeEventListener(SESSION_ACTION, noteAction);
  });

  // The panel reaches none of what opening a session needs - the selection
  // chain, and with it `ensureBranch`'s plain-repo checkout guard - so it names
  // the session and the sidebar answers exactly as its own row would.
  it("asks for the session by id rather than selecting it itself", async () => {
    await open();
    fireEvent.click(screen.getAllByRole("option")[0]);
    expect(actions).toEqual([{ sessionId: "s1", action: "open" }]);
  });

  // `role="option"` is a claim about how the list works, so the arrows have to
  // make it true. Enter opens whichever row they landed on.
  it("walks the rows with the arrow keys and opens on Enter", async () => {
    bridge.listings[REPO] = [session("first", now()), session("second", now() - DAY)];
    await open();
    const selected = () =>
      screen.getAllByRole("option").find((r) => r.getAttribute("aria-selected") === "true");
    expect(selected()?.getAttribute("title")).toBe("first");

    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(selected()?.getAttribute("title")).toBe("second");

    fireEvent.keyDown(document, { key: "Enter" });
    expect(actions).toEqual([{ sessionId: "second", action: "open" }]);
  });

  // Narrowing the list must not leave the highlight past the end of it, or
  // Enter opens whatever happens to be at a stale index.
  it("pulls the highlight back when the search narrows the list under it", async () => {
    bridge.listings[REPO] = [session("alpha", now()), session("beta", now() - DAY)];
    await open();
    fireEvent.keyDown(document, { key: "ArrowDown" }); // on "beta"

    fireEvent.input(screen.getByLabelText("Search sessions"), { target: { value: "alph" } });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(actions).toEqual([{ sessionId: "alpha", action: "open" }]);
  });

  it("offers rename and delete, and nothing else", async () => {
    await open();
    fireEvent.contextMenu(screen.getAllByRole("option")[0]);
    const menu = await screen.findByRole("menu");
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'))
      .map((d) => d.textContent ?? "")
      .filter(Boolean);
    expect(items).toEqual(["Rename…", "Delete"]);

    pointerClick(screen.getByText("Delete"));
    expect(actions).toEqual([{ sessionId: "s1", action: "delete" }]);
  });

  // The row menu is portalled out of the panel, so every interaction with it is
  // an interaction *outside* the panel as far as the panel can tell. These two
  // pin what stops that from closing the thing the menu belongs to, and what
  // stops the panel's own keys from answering underneath it. Both are driven off
  // the wrapper's `onOpenChange`, which is the whole reason it is exposed.
  it("keeps the panel open while a row menu is being used", async () => {
    await open();
    fireEvent.contextMenu(screen.getAllByRole("option")[0]);
    const menu = await screen.findByRole("menu");
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.pointerDown(menu);
    fireEvent.mouseDown(menu);

    expect(screen.queryByRole("dialog", { name: "Session history" })).toBeTruthy();
    expect(closed).toBe(0);
  });

  it("gives the arrows and Enter to the row menu while one is open", async () => {
    bridge.listings[REPO] = [session("first", now()), session("second", now() - DAY)];
    await open();
    const selected = () =>
      screen.getAllByRole("option").find((r) => r.getAttribute("aria-selected") === "true");

    fireEvent.contextMenu(screen.getAllByRole("option")[0]);
    await screen.findByRole("menu");

    fireEvent.keyDown(document, { key: "ArrowDown" });
    // The list's own highlight has not moved: the menu's has.
    expect(selected()?.getAttribute("title")).toBe("first");

    fireEvent.keyDown(document, { key: "Enter" });
    expect(actions).toEqual([]);
  });

  // Kobalte does not report a close for a trigger that simply goes away, so the
  // row has to give the panel its keys back itself. Without that the panel is
  // left believing a menu is open forever: undismissable, arrows dead, and no
  // menu on screen to explain why.
  it("takes its keys back when the row holding the menu is filtered away", async () => {
    bridge.listings[REPO] = [session("alpha", now()), session("beta", now() - DAY)];
    await open();
    const selected = () =>
      screen.getAllByRole("option").find((r) => r.getAttribute("aria-selected") === "true");

    fireEvent.contextMenu(screen.getAllByRole("option")[0]);
    await screen.findByRole("menu");

    // "alpha" no longer matches, so its row unmounts with its menu still open.
    fireEvent.input(screen.getByLabelText("Search sessions"), { target: { value: "beta" } });
    await waitFor(() => expect(rowLabels()).toEqual(["beta"]));

    fireEvent.keyDown(document, { key: "Enter" });
    expect(actions).toEqual([{ sessionId: "beta", action: "open" }]);
    expect(selected()?.getAttribute("title")).toBe("beta");
  });

  // TabMark's rule, not the sidebar's four-glyph one: these rows are scanned,
  // and a row that changes shape when a session goes quiet pulls the eye to the
  // wrong one. Only the state that is a request gets a second element.
  it("keeps its shape between idle and executing, and badges only a request", async () => {
    bridge.running = ["s1"];
    noteLiveTabs([
      { id: "tab-1", workspace: REPO, kind: "agent", sessionId: "s1", agent: "claude" },
    ]);
    await probeBatch([{ id: "s1", agent: "claude" }]);
    await open();

    const glyph = () => screen.getAllByRole("option")[0].firstElementChild!;
    const idle = glyph().className;
    expect(glyph().childElementCount).toBe(1);

    const { notePtyActivity } = await import("../../utils/sessionActivity");
    notePtyActivity("tab-1", "active");
    await waitFor(() => expect(glyph().className).not.toBe(idle));
    expect(glyph().childElementCount).toBe(1); // still one glyph: no shape change
  });
});

// The invariants of skarif2/sway#104: how the panel opens, closes, and hands
// focus around must survive the move onto Kobalte exactly as pinned here.
// Dismissal fires the pointerdown/mousedown pair a real pointer sends (see
// test/menuIdioms.test.ts) and yields a macrotask after mounting, because the
// migrated surface installs its outside listener from a `setTimeout(0)`.
describe("how the panel opens, closes, and hands focus", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    actions.length = 0;
    bridge.calls.length = 0;
    bridge.historical = false;
    bridge.running = [];
    bridge.listings = { [REPO]: [session("s1", now())], [OTHER]: [] };
  });
  afterEach(unmountPanel);

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("opens off the button with its search focused", async () => {
    await open();
    expect(screen.getByRole("dialog", { name: "Session history" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Search sessions"));
  });

  it("closes on Escape", async () => {
    await open();
    await settle();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closed).toBe(1);
  });

  it("closes on an outside pointer, but not on its own or the anchor's", async () => {
    await open();
    await settle();

    // Inside the panel: staying open is what makes it usable at all.
    const search = screen.getByLabelText("Search sessions");
    fireEvent.pointerDown(search);
    fireEvent.mouseDown(search);
    // The toggle that opened it: its press is the button's to interpret, or it
    // would fight its own open/close.
    fireEvent.pointerDown(anchorBtn!);
    fireEvent.mouseDown(anchorBtn!);
    expect(closed).toBe(0);

    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    expect(closed).toBe(1);
  });

  it("hands focus back to the button when it goes away", async () => {
    await open();
    expect(document.activeElement).not.toBe(anchorBtn);
    mounted?.unmount();
    mounted = null;
    expect(document.activeElement).toBe(anchorBtn);
  });

  it("scrolls the arrow-key highlight into view", async () => {
    bridge.listings[REPO] = [session("first", now()), session("second", now() - DAY)];
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    await open();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    spy.mockRestore();
  });

  // Body-scoped, because the panel portals out of its render container; see the
  // scope section of src/test/axe.ts.
  it("passes the axe gate while open", async () => {
    await open();
    await expectNoAxeViolations(document.body);
  });

  // The dismissal semantics of the move onto Kobalte (skarif2/sway#104), pinned
  // as measured rather than assumed. One changed, one did not.

  // Did NOT change: the old dismissable={!menuOpen()} behavior survives, now by
  // Kobalte's layer stack instead of a hand-wired prop. A press outside
  // everything dismisses only the topmost layer, so the menu goes, the panel
  // stays for that press, and the next one reaches the panel.
  it("gives up only the row menu to a press outside both, then itself", async () => {
    await open();
    fireEvent.contextMenu(screen.getAllByRole("option")[0]);
    await screen.findByRole("menu");
    await settle();

    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(closed).toBe(0);
    expect(screen.queryByRole("dialog", { name: "Session history" })).toBeTruthy();

    await settle();
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    expect(closed).toBe(1);
  });

  // DID change, and is adopted: the hand-rolled surface dismissed on pointer
  // and Escape only, so the panel stayed open when the keyboard left it.
  // Kobalte's interact-outside covers focus too, so focusing away closes it.
  it("closes when focus leaves it", async () => {
    await open();
    await settle();

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(closed).toBe(1);
    outside.remove();
  });
});

// Two accounts of one agent put two sessions in one folder, and the only
// thing telling them apart is which account produced them. The backend sends a
// label only when there is a second account to be confused with, so the
// question here is whether the row shows what it was sent and nothing else.
describe("which account a row belongs to", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    actions.length = 0;
    bridge.calls.length = 0;
    bridge.historical = false;
    bridge.running = [];
    bridge.listings = { [REPO]: [], [OTHER]: [] };
  });
  afterEach(unmountPanel);

  it("names the account beside a row that came from one", async () => {
    bridge.listings[REPO] = [
      session("mine", now(), { profile: "default", profile_label: "Default" }),
      session("work", now(), { profile: "work", profile_label: "Work" }),
    ];
    await open();
    await waitFor(() => expect(rowLabels()).toHaveLength(2));
    expect(listEl().textContent).toContain("Work");
    expect(listEl().textContent).toContain("Default");
  });

  // The "renders exactly as today" case, which is every machine that never
  // added a second account: nothing extra appears on the row at all.
  it("adds nothing to a row on a machine with one account", async () => {
    bridge.listings[REPO] = [session("mine", now(), { profile: "default", profile_label: null })];
    await open();
    await waitFor(() => expect(rowLabels()).toEqual(["mine"]));
    // Just the title and the relative time, which is what the row held before.
    const row = screen.getAllByRole("option")[0];
    expect(row.textContent).toBe(`mine${ago(now())}`);
  });

  // An ACP row's locator records no account, so nothing is derived and nothing
  // is guessed. It must not borrow the account that happens to be first.
  it("says nothing about a session it cannot attribute", async () => {
    bridge.listings[REPO] = [
      session("acp", now(), { agent: "gemini", profile: null, profile_label: null }),
      session("mine", now() - HOUR, { profile: "default", profile_label: "Default" }),
    ];
    await open();
    await waitFor(() => expect(rowLabels()).toHaveLength(2));
    const acp = screen.getAllByRole("option").find((r) => r.getAttribute("title") === "acp")!;
    expect(acp.textContent).not.toContain("Default");
  });
});

describe("a folder recreated over old sessions", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.historical = true;
    bridge.running = [];
    bridge.listings = { [REPO]: [session("ghost", now() - 40 * DAY)], [OTHER]: [] };
  });
  afterEach(unmountPanel);

  it("collapses its ghosts behind one line, and adopts them on request", async () => {
    await open();
    await waitFor(() => expect(screen.getByText("Historical (1)")).toBeTruthy());
    expect(rowLabels()).toHaveLength(0); // collapsed: the header, not the rows

    fireEvent.click(screen.getByText("Historical (1)"));
    expect(rowLabels()).toHaveLength(1);

    fireEvent.click(screen.getByText("Adopt"));
    await waitFor(() =>
      expect(bridge.calls.some((c) => c.cmd === "adopt_path" && c.args.path === REPO)).toBe(true),
    );
    // Adopted: the section is gone and the sessions are ordinary history now.
    await waitFor(() => expect(screen.queryByText("Historical (1)")).toBeNull());
    expect(sections()).toEqual(["Older"]);
  });

  // The verdict auto-adopts and writes adopted.json, so asking it about the
  // wrong folder permanently disables that folder's ghost protection. The panel
  // may ask about exactly the one it is showing.
  it("asks the verdict for its own folder and for no other", async () => {
    await open(REPO);
    await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "folder_historical")).toBe(true));
    const asked = bridge.calls
      .filter((c) => c.cmd === "folder_historical")
      .map((c) => String(c.args.folder));
    expect(new Set(asked)).toEqual(new Set([REPO]));
  });
});
