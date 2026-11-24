import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "../../test/harness";
import { TOAST, type ToastEvent } from "../../utils/events";
import CommitDiffView from "./CommitDiffView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invoked = vi.mocked(invoke);

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const SHA = "abcdef1234567890";
const DETAIL = {
  short: "abcdef1",
  files: [
    { path: "src/a.ts", old_path: null, status: "M" },
    { path: "src/b.ts", old_path: "src/old.ts", status: "R" },
  ],
};
const patch = (line: string) => ["--- a/x", "+++ b/x", "@@ -1,1 +1,1 @@", "-old", `+${line}`, ""].join("\n");
const diffReads = () => invoked.mock.calls.filter(([command]) => command === "git_commit_file_diff");
const status = (container: HTMLElement) => container.querySelector("[data-status]")?.textContent;

function hold() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}

describe("a commit file's diff tab", () => {
  beforeEach(() => invoked.mockReset());

  it("says it is reading until the patch lands, then shows the status, the sha and the lines", async () => {
    const read = hold();
    invoked.mockImplementation(async (command) => {
      if (command === "git_commit_detail") return DETAIL;
      if (command === "git_commit_file_diff") return read.promise;
    });
    const { container } = render(() => <CommitDiffView workspace="/repo" arg={`${SHA}:src/a.ts`} />);
    expect(await screen.findByText("Reading the diff...")).toBeTruthy();
    expect(screen.getByText("abcdef1")).toBeTruthy();

    read.resolve(patch("first"));
    expect(await screen.findByText("first")).toBeTruthy();
    expect(status(container)).toBe("M");
    expect(screen.queryByText("Reading the diff...")).toBeNull();
  });

  it("asks for a renamed file's patch by its old path too", async () => {
    invoked.mockImplementation(async (command) => {
      if (command === "git_commit_detail") return DETAIL;
      if (command === "git_commit_file_diff") return "";
    });
    render(() => <CommitDiffView workspace="/repo" arg={`${SHA}:src/b.ts`} />);
    expect(await screen.findByText("Moved, with no change to its contents.")).toBeTruthy();
    expect(diffReads()[0][1]).toMatchObject({ file: "src/b.ts", oldPath: "src/old.ts" });
  });

  it("reads the next file behind the placeholder, and has nothing to copy meanwhile", async () => {
    const next = hold();
    invoked.mockImplementation(async (command, args) => {
      if (command === "git_commit_detail") return DETAIL;
      if (command !== "git_commit_file_diff") return undefined;
      return (args as { file: string }).file === "src/a.ts" ? patch("first") : next.promise;
    });
    const [arg, setArg] = createSignal(`${SHA}:src/a.ts`);
    const { container } = render(() => <CommitDiffView workspace="/repo" arg={arg()} />);
    await screen.findByText("first");

    setArg(`${SHA}:src/b.ts`);
    await waitFor(() => expect(diffReads()).toHaveLength(2));
    expect(await screen.findByText("Reading the diff...")).toBeTruthy();
    expect(screen.queryByText("first")).toBeNull();
    expect(status(container)).toBe("R");

    const messages: string[] = [];
    const on = (e: Event) => messages.push((e as CustomEvent<ToastEvent>).detail.message);
    window.addEventListener(TOAST, on);
    fireEvent.click(screen.getByRole("button", { name: "Copy diff" }));
    window.removeEventListener(TOAST, on);
    expect(messages).toEqual(["No diff to copy."]);

    next.resolve(patch("second"));
    expect(await screen.findByText("second")).toBeTruthy();
  });

  it("shows why the commit cannot be read in place of the lines, and tries again", async () => {
    invoked.mockImplementation(async (command) => {
      if (command === "git_commit_detail") throw "bad object abcdef1";
    });
    const { container } = render(() => <CommitDiffView workspace="/repo" arg={`${SHA}:src/a.ts`} />);
    expect(await screen.findByText(/bad object abcdef1/)).toBeTruthy();
    expect(status(container)).toBe("?");
    expect(screen.getByText("abcdef1")).toBeTruthy();
    expect(diffReads()).toHaveLength(0);

    invoked.mockImplementation(async (command) => {
      if (command === "git_commit_detail") return DETAIL;
      if (command === "git_commit_file_diff") return patch("back");
    });
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("back")).toBeTruthy();
    expect(status(container)).toBe("M");
  });
});
