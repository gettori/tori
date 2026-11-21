import { expect, it, vi } from "vite-plus/test";
import { render, screen, waitFor } from "../../test/harness";
import type { DiffHunk } from "../../utils/diffHunks";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const diffOf = (line: string) =>
  [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    `+${line}`,
    " three",
    "",
  ].join("\n");

const bridge = vi.hoisted(() => ({
  diff: "",
  lines: [] as string[],
  listeners: [] as ((e: { payload: unknown }) => void)[],
  drawn: [] as { text: string; hunks: string }[],
}));

vi.mock("./syntaxLines", () => ({ languageForPath: async () => null, tokenLines: () => [] }));
vi.mock("./DiffBufferView", async () => {
  const { createRenderEffect } = await import("solid-js");
  return {
    default: (props: { text: string; hunks: DiffHunk[] }) => {
      createRenderEffect(() => bridge.drawn.push({ text: props.text, hunks: JSON.stringify(props.hunks) }));
      return <div>buffer</div>;
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "git_diff_text") return Promise.resolve(bridge.diff);
    if (cmd === "git_file_slice") return Promise.resolve(bridge.lines);
    if (cmd === "git_status") {
      return Promise.resolve([{ status: " M", path: "src/a.ts", staged: false, unstaged: true }]);
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    if (name === "fs://changed") bridge.listeners.push(fn);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));

const { default: DiffView } = await import("./DiffView");
const { enterRoots } = await import("../../utils/gitActions");
const { writeDiffEditorLayout } = await import("../../utils/diffLayout");

it("never draws a reloaded diff over the old file text", async () => {
  enterRoots(["/proj"]);
  writeDiffEditorLayout(true);
  bridge.diff = diffOf("TWO");
  bridge.lines = ["one", "TWO", "three"];
  render(() => <DiffView workspace="/proj" arg="unstaged:src/a.ts" selected={null} />);
  await screen.findByText("buffer");
  await waitFor(() => expect(bridge.listeners.length).toBeGreaterThan(0));

  bridge.drawn.length = 0;
  bridge.diff = diffOf("THREE");
  bridge.lines = ["one", "THREE", "three"];
  for (const listener of bridge.listeners) listener({ payload: { root: "/proj", paths: ["/proj/src/a.ts"] } });
  await waitFor(() => expect(bridge.drawn.some((d) => d.text.includes("THREE"))).toBe(true));

  expect(bridge.drawn.length).toBeGreaterThan(0);
  for (const { text, hunks } of bridge.drawn) expect(text.includes("THREE")).toBe(hunks.includes("THREE"));
});
