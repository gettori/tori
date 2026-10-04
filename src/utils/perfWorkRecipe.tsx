/**
 * The main-thread work recipe, `TORI_RECIPE=work`: mounts the real chat and
 * preview components over generated fixtures and drives them, so each seam in
 * `perfTrace` gets frames to be read from. One pass per candidate, each closed
 * with its own control row of frames that ran no seam.
 *
 * Keep the window frontmost: an occluded window gets no frames, and every
 * frame line comes back as a gap of seconds.
 */

import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { applyEvent, initialChat, type ChatState, type ToolItem } from "../panels/Chat/chatStore";
import MessageList from "../panels/Chat/MessageList";
import Markdown from "../panels/Chat/Markdown";
import { ToolDiff } from "../panels/Chat/ToolBody";
import MarkdownPreview from "../panels/Editor/MarkdownPreview";
import { rank } from "./composerCompletion";
import { takeHighlightTimes } from "../panels/Chat/highlight";
import { dropLiveBuffer, publishBufferText } from "./liveBuffer";
import { bigEdit, bigMarkdown, diagrams, projectPaths, streamedAnswer } from "./perfFixtures";
import { holdFrames, traceFrameControl, traceNote, traceWork } from "./perfTrace";
import { quit } from "./perfRecipe";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const BOOT_SETTLE_MS = 6000;
const GAP_MS = 1500;
// Faster than a model types, so a pass stays short; the lex cost depends on
// how long the message has grown, not on how fast it grew.
const DELTA_CHARS = 100;
const DELTA_MS = 25;
const SESSION = "tori-perf";
const PREVIEW_MAX_MS = 30_000;

let started = false;

export async function startWorkRecipe(): Promise<void> {
  if (started) return;
  started = true;
  traceNote("recipe-start", { spec: "work" });
  await sleep(BOOT_SETTLE_MS);
  holdFrames(true);

  await pass("calibrate", async () => {
    for (let i = 0; i < 5; i++) {
      await frame();
      traceWork("calibrate", () => busy(30));
      await sleep(200);
    }
  });
  await pass("stream", stream);
  await pass("fuzzy", fuzzy);
  await pass("tool-diff", async () => {
    const unmount = mount(() => <ToolDiff cards={[editCard()]} onOpen={() => {}} />);
    await sleep(3000);
    unmount();
  });
  await pass("md-preview", async () => {
    const path = "/tori-perf/large.md";
    const END = "End of the large fixture.";
    publishBufferText(path, `${bigMarkdown()}\n\n${END}\n`);
    let host: HTMLElement | undefined;
    const unmount = mount(() => <div ref={(el) => (host = el)}><MarkdownPreview path={path} /></div>);
    // Until the last block is in, so a slow lex is measured rather than cut off.
    const began = performance.now();
    while (!host?.textContent?.includes(END) && performance.now() - began < PREVIEW_MAX_MS) await sleep(200);
    traceNote("md-preview", { done: !!host?.textContent?.includes(END), ms: Math.round(performance.now() - began) });
    await sleep(1000);
    unmount();
    dropLiveBuffer(path);
  });
  await pass("mermaid", async () => {
    const unmount = mount(() => <Markdown text={diagrams()} cwd="/" />);
    await sleep(8000);
    unmount();
  });
  await pass("invokes", invokes);

  holdFrames(false);
  traceNote("recipe-done", {});
  await quit();
}

async function pass(name: string, run: () => Promise<void>): Promise<void> {
  traceNote("pass", { name });
  await sleep(GAP_MS);
  traceFrameControl(`before-${name}`);
  await run();
  await sleep(GAP_MS);
  traceFrameControl(name);
}

function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end);
}

function mount(view: () => JSX.Element): () => void {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;inset:48px;z-index:2147483647;overflow:auto;background:var(--bg-default)";
  document.body.append(el);
  const dispose = render(view, el);
  return () => {
    dispose();
    el.remove();
  };
}

async function stream(): Promise<void> {
  const [state, setState] = createStore<ChatState>(initialChat(SESSION));
  const edit = (fn: (s: ChatState) => void) => setState(produce(fn));
  const turnId = "perf-turn";
  edit((s) =>
    applyEvent(s, { type: "turnStarted", sessionId: SESSION, turnId, model: "perf", permissionMode: "default", agentInitiated: false }),
  );
  const unmount = mount(() => (
    <MessageList
      items={state.items}
      streaming
      sessionId={SESSION}
      cwd="/"
      modelLabelFor={() => "perf"}
      onSetMode={() => {}}
      onRevertHunk={async () => false}
    />
  ));
  const text = streamedAnswer();
  let deltas = 0;
  for (let at = 0; at < text.length; at += DELTA_CHARS) {
    const chunk = text.slice(at, at + DELTA_CHARS);
    edit((s) => applyEvent(s, { type: "textDelta", sessionId: SESSION, turnId, text: chunk, agentId: null }));
    deltas++;
    await sleep(DELTA_MS);
  }
  traceNote("stream", { deltas, chars: text.length });
  await sleep(1000);
  traceNote("highlight-worker", takeHighlightTimes());
  unmount();
}

async function fuzzy(): Promise<void> {
  const paths = projectPaths();
  traceNote("fuzzy", { paths: paths.length });
  for (const query of ["pkg-17/area", "workertoken", "src/lexer.tsx"]) {
    for (let i = 1; i <= query.length; i++) {
      await frame();
      rank(paths, query.slice(0, i), (p) => p);
    }
  }
}

function editCard(): ToolItem {
  return {
    kind: "tool",
    id: "perf-edit",
    toolUseId: "perf-edit",
    agentId: null,
    turnId: "perf-turn",
    name: "Edit",
    title: null,
    toolKind: "edit",
    locations: [],
    input: bigEdit(),
    state: "ok",
    approval: null,
    output: null,
    outputTruncated: false,
    summary: null,
    patch: [],
    files: [],
    durationMs: null,
    edits: [],
  };
}

// The largest answers the app asks for in ordinary use, each once.
async function invokes(): Promise<void> {
  type Config = { spaces?: { projects?: { path: string }[] }[] };
  const cfg = await invoke<Config>("get_config").catch(() => null);
  const project = cfg?.spaces?.[0]?.projects?.[0]?.path;
  if (!project) return traceNote("invokes", { skipped: "no project" });
  await invoke("list_project_files", { projectPath: project }).catch((e) =>
    traceNote("invokes", { failed: "list_project_files", why: String(e) }),
  );
  await sleep(500);
}
