import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "../../test/harness";
import { TOAST, type ToastEvent } from "../../utils/events";
import CheckpointDiffView from "./CheckpointDiffView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invoked = vi.mocked(invoke);

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const patch = (line: string) =>
  ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,1 @@", "-old", `+${line}`, ""].join("\n");
const reads = () => invoked.mock.calls.filter(([command]) => command === "checkpoint_diff_file").length;

function hold() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}

function toasts() {
  const messages: string[] = [];
  const on = (e: Event) => messages.push((e as CustomEvent<ToastEvent>).detail.message);
  window.addEventListener(TOAST, on);
  return { messages, stop: () => window.removeEventListener(TOAST, on) };
}

describe("a checkpoint file's diff tab", () => {
  beforeEach(() => invoked.mockReset());

  it("says it is reading until the diff lands, then shows its lines", async () => {
    const read = hold();
    invoked.mockImplementation(async (command) => (command === "checkpoint_diff_file" ? read.promise : undefined));
    render(() => <CheckpointDiffView workspace="/repo" arg="turn:100:s1:src/a.ts" />);
    expect(await screen.findByText("Reading the diff...")).toBeTruthy();
    expect(screen.getByText("a.ts")).toBeTruthy();

    read.resolve(patch("first"));
    expect(await screen.findByText("first")).toBeTruthy();
    expect(screen.queryByText("Reading the diff...")).toBeNull();
  });

  it("reads the next file behind the placeholder, and has nothing to copy meanwhile", async () => {
    const next = hold();
    invoked.mockImplementation(async (command, args) => {
      if (command !== "checkpoint_diff_file") return undefined;
      return (args as { file: string }).file === "src/a.ts" ? patch("first") : next.promise;
    });
    const [arg, setArg] = createSignal("turn:100:s1:src/a.ts");
    render(() => <CheckpointDiffView workspace="/repo" arg={arg()} />);
    await screen.findByText("first");

    setArg("turn:100:s1:src/b.ts");
    await waitFor(() => expect(reads()).toBe(2));
    expect(await screen.findByText("Reading the diff...")).toBeTruthy();
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.getByText("b.ts")).toBeTruthy();

    const seen = toasts();
    fireEvent.click(screen.getByRole("button", { name: "Copy diff" }));
    seen.stop();
    expect(seen.messages).toEqual(["No diff to copy."]);

    next.resolve(patch("second"));
    expect(await screen.findByText("second")).toBeTruthy();
  });

  it("shows the reason a diff cannot be read in place of the lines, and tries again", async () => {
    invoked.mockImplementation(async (command) => {
      if (command === "checkpoint_diff_file") throw "checkpoint pruned";
    });
    render(() => <CheckpointDiffView workspace="/repo" arg="turn:100:s1:src/a.ts" />);
    expect(await screen.findByText(/checkpoint pruned/)).toBeTruthy();
    expect(screen.queryByText(/No line changes to show/)).toBeNull();

    invoked.mockImplementation(async (command) => (command === "checkpoint_diff_file" ? patch("back") : undefined));
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("back")).toBeTruthy();
  });
});
