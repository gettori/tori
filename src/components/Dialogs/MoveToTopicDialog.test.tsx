import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
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
    if (cmd === "add_member") return Promise.resolve(bridge.answer);
    return Promise.resolve(null);
  },
}));

const { default: MoveToTopicDialog } = await import("./MoveToTopicDialog");

const REPO = "/w/web";
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
      topics={topics}
      onDone={onDone}
      onCancel={() => {}}
    />
  ));
  return onDone;
}
const moveButton = () => screen.getByRole("button", { name: "Move to Topic" }) as HTMLButtonElement;
async function pick(name: string) {
  pointerClick(screen.getByLabelText("Topic"));
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

  it("says up front why a worktree cannot be moved at all", async () => {
    bridge.refusal = "web-fix is on main, the repository's default branch";
    mount([AUTH]);

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "web-fix is on main, the repository's default branch",
    );
    expect(screen.queryByLabelText("Topic")).toBeNull();
    expect(moveButton().disabled).toBe(true);
  });
});
