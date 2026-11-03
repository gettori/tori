import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent, within } from "@solidjs/testing-library";
import type { Member, Topic } from "../../utils/topics";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  refusal: null as string | null,
  answer: null as unknown,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args });
    if (cmd === "check_moved_worktree") return Promise.resolve(bridge.refusal);
    if (cmd === "add_member" || cmd === "create_topic") return Promise.resolve(bridge.answer);
    if (cmd === "probe_topic_branch")
      return Promise.resolve({ valid: true, local: false, remote: false, hasWorktree: false });
    return Promise.resolve(null);
  },
}));

const { default: MoveToTopicDialog } = await import("./MoveToTopicDialog");
import { allSpaces } from "../../utils/globalSpace";

const REPO = "/w/web";
const SPACES = [
  {
    name: "work",
    projects: [
      { name: "api", path: "/w/api" },
      { name: "web", path: REPO },
    ],
  },
  { name: "side", projects: [{ name: "lab", path: "/s/lab" }] },
];
const WT = "/w/web-fix";

const member = (repoPath: string, mode: "worktree" | "reference"): Member => ({
  repoPath,
  displayName: repoPath.split("/").pop()!,
  mode,
  worktreePath: mode === "worktree" ? `${repoPath}/.tori/worktrees/t` : null,
  state: { kind: "present" },
  order: 0,
});
const topic = (id: string, name: string, members: Member[], space?: string): Topic => ({
  id,
  name,
  branch: `feat/${id}`,
  members,
  createdAt: 0,
  ...(space ? { space } : {}),
});

const AUTH = topic("auth", "Auth", [member("/w/api", "worktree")]);
const PAY = topic("pay", "Payments", [member(REPO, "worktree")]);
const DOCS = topic("docs", "Docs", [member(REPO, "reference")]);
const CART = topic("cart", "Cart", [member("/w/api", "worktree")], "work");
const BENCH = topic("bench", "Bench", [member("/s/lab", "worktree")], "side");

function mount(topics: Topic[]) {
  const onDone = vi.fn();
  render(() => (
    <MoveToTopicDialog
      repoPath={REPO}
      worktreePath={WT}
      label="web-fix"
      branch="fix-x"
      space="work"
      topics={topics}
      spaces={SPACES}
      onDone={onDone}
      onCancel={() => {}}
    />
  ));
  return onDone;
}
const moveButton = () => screen.getByRole("button", { name: "Move" }) as HTMLButtonElement;
async function pick(name: string) {
  fireEvent.click(await screen.findByRole("radio", { name }));
}
const groupNames = () => screen.queryAllByRole("radiogroup").map((g) => g.getAttribute("aria-label"));
const choices = (group: string) =>
  within(screen.getByRole("radiogroup", { name: group }))
    .getAllByRole("radio")
    .map((r) => r.closest("label")!.textContent);
const openNew = async () => {
  await waitFor(() => expect(screen.getByRole("group", { name: "Move to" })).toBeTruthy());
  fireEvent.click(within(screen.getByRole("group", { name: "Move to" })).getByRole("button", { name: "New" }));
};

describe("MoveToTopicDialog", () => {
  beforeEach(() => {
    bridge.calls.length = 0;
    bridge.refusal = null;
    bridge.answer = null;
  });

  it("moves the worktree into the picked Topic as it is", async () => {
    bridge.answer = AUTH;
    const onDone = mount([AUTH, PAY]);
    await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "check_moved_worktree")).toBe(true));
    expect(moveButton().disabled).toBe(true);
    await pick("Auth");

    await waitFor(() => expect(moveButton().disabled).toBe(false));
    fireEvent.click(moveButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(AUTH));
    expect(bridge.calls.find((c) => c.cmd === "add_member")!.args).toEqual({
      topicId: "auth",
      repoPath: REPO,
      worktreePath: WT,
    });
  });

  it("refuses a Topic that already has the repo with a worktree, and says why", async () => {
    mount([AUTH, PAY]);
    await pick("Payments");

    expect(await screen.findByText("web is already in Payments with a worktree")).toBeTruthy();
    expect(moveButton().disabled).toBe(true);
  });

  it("takes a Topic that reads the repo as a reference, saying it replaces it", async () => {
    mount([DOCS]);
    await waitFor(() => expect(bridge.calls.some((c) => c.cmd === "check_moved_worktree")).toBe(true));
    await pick("Docs");

    expect(await screen.findByText("Replaces the reference to web")).toBeTruthy();
    await waitFor(() => expect(moveButton().disabled).toBe(false));
  });

  it("starts a new Topic with the worktree pinned on its own branch, plus one more repository", async () => {
    bridge.answer = AUTH;
    const onDone = mount([AUTH]);
    await waitFor(() => expect(screen.getByRole("group", { name: "Move to" })).toBeTruthy());
    fireEvent.click(within(screen.getByRole("group", { name: "Move to" })).getByRole("button", { name: "New" }));

    const dialog = await screen.findByRole("dialog", { name: "New Topic in work" });
    const branch = within(dialog).getByRole("textbox", { name: "Branch" }) as HTMLInputElement;
    expect(branch.value).toBe("fix-x");
    expect(within(dialog).queryByRole("checkbox", { name: "web" })).toBeNull();
    expect(dialog.textContent).toContain("This worktree, on fix-x");
    fireEvent.input(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Fix X" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "api" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create and move" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(AUTH));
    expect(bridge.calls.find((c) => c.cmd === "create_topic")!.args).toEqual({
      name: "Fix X",
      branch: "fix-x",
      members: [
        { repoPath: REPO, mode: "worktree", worktreePath: WT },
        { repoPath: "/w/api", mode: "reference" },
      ],
      space: "work",
    });
    expect(bridge.calls.some((c) => c.cmd === "probe_topic_branch" && c.args.repoPath === REPO)).toBe(false);
  });

  it("keeps what was typed on New across a switch to Existing and back", async () => {
    mount([AUTH]);
    const switchTo = async (tab: string) =>
      fireEvent.click(within(await screen.findByRole("group", { name: "Move to" })).getByRole("button", { name: tab }));
    await switchTo("New");
    const dialog = await screen.findByRole("dialog", { name: "New Topic in work" });
    fireEvent.input(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Fix X" } });
    await switchTo("Existing");
    await screen.findByRole("dialog", { name: "Move web-fix to a Topic" });
    await switchTo("New");

    const again = await screen.findByRole("dialog", { name: "New Topic in work" });
    expect((within(again).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Fix X");
  });

  it("opens on New when there is no Topic to move into", async () => {
    mount([]);
    expect(await screen.findByRole("dialog", { name: "New Topic in work" })).toBeTruthy();
  });

  it("says up front why a worktree cannot be moved at all", async () => {
    bridge.refusal = "web-fix is on main, the repository's default branch";
    mount([AUTH]);

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "web-fix is on main, the repository's default branch",
    );
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("group", { name: "Move to" })).toBeNull();
    expect(moveButton().disabled).toBe(true);
  });

  it("lists the space's Topics, then the global ones, and none from another space", async () => {
    mount([AUTH, BENCH, CART, PAY]);
    await screen.findByRole("radio", { name: "Cart" });
    expect(groupNames()).toEqual(["In work, 1", "Home, 2"]);
    expect(choices("In work, 1")).toEqual(["Cart"]);
    expect(choices("Home, 2")).toEqual(["Auth", "Payments"]);
    expect(screen.queryByRole("radio", { name: "Bench" })).toBeNull();
  });

  it("searches both groups and drops a group the search empties", async () => {
    mount([AUTH, CART]);
    fireEvent.input(await screen.findByRole("searchbox", { name: "Search Topics" }), { target: { value: "car" } });
    await waitFor(() => expect(groupNames()).toEqual(["In work, 1"]));
    fireEvent.input(screen.getByRole("searchbox", { name: "Search Topics" }), { target: { value: "zzz" } });
    await waitFor(() => expect(groupNames()).toEqual([]));
    expect(screen.getByText("No Topic matches.")).toBeTruthy();
  });

  it("hides the header of a group with no Topics", async () => {
    mount([CART]);
    await screen.findByRole("radio", { name: "Cart" });
    expect(groupNames()).toEqual(["In work, 1"]);
  });

  it("says there are no Topics when neither group has any", async () => {
    mount([BENCH]);
    await screen.findByRole("dialog", { name: "New Topic in work" });
    fireEvent.click(within(screen.getByRole("group", { name: "Move to" })).getByRole("button", { name: "Existing" }));
    expect(await screen.findByText("No Topics yet.")).toBeTruthy();
  });

  it("makes the new Topic in the worktree's space by default, or global when asked", async () => {
    bridge.answer = AUTH;
    const onDone = mount([AUTH]);
    await openNew();
    const where = () => within(screen.getByRole("group", { name: "Where" }));
    expect(where().getByRole("button", { name: "work" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Lives in work's tree. Can hold work's projects only.")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "lab" })).toBeNull();

    fireEvent.click(where().getByRole("button", { name: "Home" }));
    const dialog = await screen.findByRole("dialog", { name: "New Topic" });
    expect(screen.getByText("Listed in Home. Can hold projects from any space.")).toBeTruthy();
    fireEvent.input(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Wide" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "lab" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create and move" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(bridge.calls.find((c) => c.cmd === "create_topic")!.args).toEqual({
      name: "Wide",
      branch: "fix-x",
      members: [
        { repoPath: REPO, mode: "worktree", worktreePath: WT },
        { repoPath: "/s/lab", mode: "reference" },
      ],
    });
  });

  it("moves an attached folder's worktree into Global's Topics, with no space to pick", async () => {
    const acme = "/c/acme-site";
    render(() => (
      <MoveToTopicDialog
        repoPath={acme}
        worktreePath={`${acme}/.tori/worktrees/fix`}
        label="fix"
        branch="fix"
        topics={[AUTH, CART, PAY]}
        spaces={allSpaces({ spaces: SPACES, global: { projects: [{ name: "acme-site", path: acme }] } })}
        onDone={() => {}}
        onCancel={() => {}}
      />
    ));
    await screen.findByRole("radio", { name: "Auth" });
    expect(groupNames()).toEqual(["Home, 2"]);
    await openNew();
    expect(screen.queryByRole("group", { name: "Where" })).toBeNull();
  });
});
