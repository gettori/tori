import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent, within } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
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

const REPO = "/w/web";
const SPACES = [
  {
    name: "work",
    projects: [
      { name: "api", path: "/w/api" },
      { name: "web", path: REPO },
    ],
  },
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
const topic = (id: string, name: string, members: Member[]): Topic => ({
  id,
  name,
  branch: `feat/${id}`,
  members,
  createdAt: 0,
});

const AUTH = topic("auth", "Auth", [member("/w/api", "worktree")]);
const PAY = topic("pay", "Payments", [member(REPO, "worktree")]);
const DOCS = topic("docs", "Docs", [member(REPO, "reference")]);

function mount(topics: Topic[]) {
  const onDone = vi.fn();
  render(() => (
    <MoveToTopicDialog
      repoPath={REPO}
      worktreePath={WT}
      label="web-fix"
      branch="fix-x"
      topics={topics}
      spaces={SPACES}
      onDone={onDone}
      onCancel={() => {}}
    />
  ));
  return onDone;
}
const moveButton = () => screen.getByRole("button", { name: "Move to Topic" }) as HTMLButtonElement;
async function pick(name: string) {
  pointerClick(await screen.findByLabelText("Topic"));
  pointerClick(await screen.findByRole("option", { name }));
}

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

    const dialog = await screen.findByRole("dialog", { name: "New Topic" });
    const branch = within(dialog).getByRole("textbox", { name: "Branch" }) as HTMLInputElement;
    expect(branch.value).toBe("fix-x");
    expect(within(dialog).queryByRole("checkbox", { name: "web" })).toBeNull();
    expect(dialog.textContent).toContain("This worktree, on fix-x");
    fireEvent.input(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Fix X" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "api" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Topic" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(AUTH));
    expect(bridge.calls.find((c) => c.cmd === "create_topic")!.args).toEqual({
      name: "Fix X",
      branch: "fix-x",
      members: [
        { repoPath: REPO, mode: "worktree", worktreePath: WT },
        { repoPath: "/w/api", mode: "reference" },
      ],
    });
    expect(bridge.calls.some((c) => c.cmd === "probe_topic_branch" && c.args.repoPath === REPO)).toBe(false);
  });

  it("keeps what was typed on New across a switch to Existing and back", async () => {
    mount([AUTH]);
    const switchTo = async (tab: string) =>
      fireEvent.click(within(await screen.findByRole("group", { name: "Move to" })).getByRole("button", { name: tab }));
    await switchTo("New");
    const dialog = await screen.findByRole("dialog", { name: "New Topic" });
    fireEvent.input(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Fix X" } });
    await switchTo("Existing");
    await screen.findByRole("dialog", { name: "Move web-fix to a Topic" });
    await switchTo("New");

    const again = await screen.findByRole("dialog", { name: "New Topic" });
    expect((within(again).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Fix X");
  });

  it("opens on New when there is no Topic to move into", async () => {
    mount([]);
    expect(await screen.findByRole("dialog", { name: "New Topic" })).toBeTruthy();
  });

  it("says up front why a worktree cannot be moved at all", async () => {
    bridge.refusal = "web-fix is on main, the repository's default branch";
    mount([AUTH]);

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "web-fix is on main, the repository's default branch",
    );
    expect(screen.queryByLabelText("Topic")).toBeNull();
    expect(screen.queryByRole("group", { name: "Move to" })).toBeNull();
    expect(moveButton().disabled).toBe(true);
  });
});
