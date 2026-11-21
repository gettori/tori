import { afterEach, expect, it, vi } from "vite-plus/test";
import { createSignal } from "solid-js";
import { EditorView } from "@codemirror/view";
import { render, screen, waitFor } from "../../test/harness";
import { settled, takeRuns } from "../../test/perfCounters";

vi.mock("solid-js", async (original) => {
  const { countingSolid } = await import("../../test/perfCounters");
  return countingSolid(await original<typeof import("solid-js")>());
});

Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const STAGES = {
  base: "a\nb\nc\n",
  ours: "a\nO\nc\n",
  theirs: "a\nT\nc\n",
  binary: false,
};
const REFUSED = "that file has no merge conflict";
const bridge = vi.hoisted(() => ({ fails: false, op: "merge" }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "git_conflict_stages") return bridge.fails ? Promise.reject(REFUSED) : Promise.resolve({ ...STAGES });
    if (cmd === "git_conflict_op") return Promise.resolve(bridge.op);
    if (cmd === "list_sessions" || cmd === "sessions_running") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: ConflictView } = await import("./ConflictView");

async function mounted() {
  const [file, setFile] = createSignal("src/one.txt");
  render(() => <ConflictView workspace="/proj" file={file()} />);
  await waitFor(() => expect(screen.getByText("Conflict 1 of 1")).toBeTruthy());
  await settled();
  takeRuns();
  return setFile;
}

afterEach(() => {
  bridge.fails = false;
  bridge.op = "merge";
  vi.restoreAllMocks();
});

it("lands a read as one update, so the panes are rebuilt once", async () => {
  const setFile = await mounted();
  const destroy = vi.spyOn(EditorView.prototype, "destroy");

  bridge.op = "rebase";
  setFile("src/two.txt");
  await settled();

  expect(destroy).toHaveBeenCalledTimes(3);
});

it("shows the error in the same update that takes the panes away", async () => {
  const setFile = await mounted();
  const sawError: boolean[] = [];
  const destroy = EditorView.prototype.destroy;
  vi.spyOn(EditorView.prototype, "destroy").mockImplementation(function (this: EditorView) {
    sawError.push(!!screen.queryByText(REFUSED));
    destroy.call(this);
  });

  bridge.fails = true;
  setFile("src/two.txt");
  await waitFor(() => expect(screen.getByText(REFUSED)).toBeTruthy());
  await settled();

  expect(sawError.length).toBeGreaterThan(0);
  expect(sawError).not.toContain(false);
});
