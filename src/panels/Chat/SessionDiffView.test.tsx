import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, fireEvent, waitFor } from "../../test/harness";
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import SessionDiffView from "./SessionDiffView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invoked = vi.mocked(invoke);

const mine = [
  { path: "/repo/src/a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n", created: false, hunkToolUseIds: [null], toolUseIds: ["t1"] },
];

function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

function answer(replies: Record<string, () => Promise<unknown>>) {
  invoked.mockImplementation(async (command) => replies[command]?.());
}

function view() {
  return render(() => <SessionDiffView sessionId="s1" cwd="/repo" items={[]} live sinceTs={100} />);
}

describe("the session diff", () => {
  beforeEach(() => invoked.mockReset());

  it("says it is building until the diff lands, then draws it", async () => {
    const diff = held<unknown>();
    answer({ chat_session_diff: () => diff.promise, checkpoint_turn_files: async () => [] });
    const { container, findByText, queryByText } = view();
    expect(await findByText("Building the diff…")).toBeTruthy();
    expect(queryByText("Side by side")).toBeNull();

    diff.resolve(mine);
    await waitFor(() => expect(container.textContent).toContain("a.ts"));
    expect(queryByText("Building the diff…")).toBeNull();
    expect(container.textContent).toContain("1 edit");
  });

  it("says the diff could not be built rather than that nothing changed, and can ask again", async () => {
    let reply: () => Promise<unknown> = () => Promise.reject("session not found");
    answer({ chat_session_diff: () => reply(), checkpoint_turn_files: async () => [] });
    const { container, findByText, getByText } = view();
    expect(await findByText(/could not be built: session not found/)).toBeTruthy();
    expect(container.textContent).not.toContain("has not changed any files");

    reply = () => Promise.resolve(mine);
    fireEvent.click(getByText("Try again"));
    await waitFor(() => expect(container.textContent).toContain("a.ts"));
  });

  it("keeps this session's own diff when the worktree's account cannot be read", async () => {
    answer({ chat_session_diff: async () => mine, checkpoint_turn_files: () => Promise.reject("git exited 128") });
    const { container, findByText } = view();
    expect(await findByText(/Could not read what else changed in this worktree: git exited 128/)).toBeTruthy();
    expect(container.textContent).toContain("a.ts");
    expect(container.textContent).not.toContain("shared");
  });

  // A later first turn is the same view asked over a longer span, so what is
  // listed stays until the new account lands.
  it("keeps the files already listed while the worktree's account is read again", async () => {
    const [since, setSince] = createSignal<number | null>(100);
    let account: () => Promise<unknown> = async () => [{ path: "b.ts", status: "M", shared_with: ["other"] }];
    answer({ chat_session_diff: async () => mine, checkpoint_turn_files: () => account() });
    const { container } = render(() => (
      <SessionDiffView sessionId="s1" cwd="/repo" items={[]} live sinceTs={since()} />
    ));
    await waitFor(() => expect(container.textContent).toContain("b.ts"));

    const again = held<unknown>();
    account = () => again.promise;
    setSince(200);
    await waitFor(() => expect(invoked.mock.calls.filter((c) => c[0] === "checkpoint_turn_files")).toHaveLength(2));
    expect(container.textContent).toContain("a.ts");
    expect(container.textContent).toContain("b.ts");
    expect(container.textContent).not.toContain("Building the diff");

    again.resolve([{ path: "c.ts", status: "M", shared_with: [] }]);
    await waitFor(() => expect(container.textContent).toContain("c.ts"));
    expect(container.textContent).not.toContain("b.ts");
  });
});
