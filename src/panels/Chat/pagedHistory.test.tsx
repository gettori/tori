// "Load earlier" on a chat opened with only its tail: one page in flight, merged
// in front, the reader held in place. `ChatView` is mounted for real because the
// in-flight guard and the cursor live there.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import golden from "./__fixtures__/historyTail.golden.json";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

type Case = { name: string; start: number; pages: [number, number][]; cursor: unknown; summary: unknown; full: unknown[] };
const rich = (golden as Case[]).find((c) => c.name === "rich") as Case;

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
/** Pages asked for and not answered yet, so a test decides when each lands. */
const pending: (() => void)[] = [];
let served = 0;

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  Channel: class {
    onmessage?: (raw: unknown) => void;
  },
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    invokes.push({ cmd, args });
    switch (cmd) {
      case "chat_history":
        return Promise.resolve({ summary: rich.summary, events: rich.full.slice(rich.start), cursor: rich.cursor });
      case "chat_history_page":
        return new Promise((resolve) =>
          pending.push(() => {
            const [from, to] = rich.pages[served];
            served += 1;
            const next = served < rich.pages.length ? { promptTs: served, offset: 0 } : null;
            resolve({ events: rich.full.slice(from, to), cursor: next });
          }),
        );
      case "list_agents":
        return Promise.resolve([]);
      case "model_catalogs":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => Promise.resolve("/home/me") }));

// jsdom lays nothing out, so each element's scroll box is a stand-in the test sets.
const heights = new WeakMap<Element, number>();
const tops = new WeakMap<Element, number>();
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: Element) {
    return heights.get(this) ?? 0;
  },
});
Object.defineProperty(HTMLElement.prototype, "scrollTop", {
  configurable: true,
  get(this: Element) {
    return tops.get(this) ?? 0;
  },
  set(this: Element, v: number) {
    tops.set(this, v);
  },
});

const { default: ChatView } = await import("./ChatView");

const pageCalls = () => invokes.filter((i) => i.cmd === "chat_history_page");

function mount() {
  return render(() => (
    <ChatView
      sessionId="s"
      tabId="chat:paged"
      cwd="/work/repo"
      workspace="/work/repo"
      agentId="claude"
      profile={null}
      title="chat"
      active={true}
      resume={true}
      started={false}
      onStart={() => {}}
      onForkSession={() => "chat:fork"}
      onForkFrom={() => "chat:fork"}
      onRewindFrom={() => {}}
      onFirstSendFailed={() => {}}
      onProfileResolved={() => {}}
    />
  ));
}

/** Press "Load earlier" until a page is asked for, answering nothing. */
async function clickUntilAsked() {
  const asked = pageCalls().length;
  for (let i = 0; i < 50 && pageCalls().length === asked; i++) {
    fireEvent.click(await screen.findByText("Load earlier", undefined, { timeout: 500 }));
  }
  expect(pageCalls().length).toBe(asked + 1);
}

beforeEach(() => {
  invokes.length = 0;
  pending.length = 0;
  served = 0;
});

describe("load earlier on a chat opened with its tail", () => {
  it("pages back to the first prompt, one page at a time", async () => {
    mount();
    await screen.findByText("prompt 39");
    expect(screen.queryByText("prompt 0")).toBeNull();

    for (let i = 0; i < rich.pages.length; i++) {
      await clickUntilAsked();
      // A second press while the page is out asks for nothing more.
      fireEvent.click(screen.getByText("Load earlier"));
      expect(pageCalls()).toHaveLength(i + 1);
      pending.shift()?.();
      await waitFor(() => expect(served).toBe(i + 1));
    }
    for (let i = 0; i < 50 && screen.queryByText("Load earlier"); i++) fireEvent.click(screen.getByText("Load earlier"));

    await screen.findByText("prompt 0");
    expect(pageCalls()).toHaveLength(rich.pages.length);
    expect(pageCalls()[0].args).toMatchObject({ sessionId: "s", fromSessionId: null, agentId: "claude", cursor: rich.cursor });
  });

  it("holds the reader in place while a page lands above them", async () => {
    mount();
    await screen.findByText("prompt 39");
    const list = screen.getByText("prompt 39").closest("[class*='list']") as HTMLElement;
    heights.set(list, 4000);
    list.scrollTop = 300;

    await clickUntilAsked();
    heights.set(list, 9000);
    pending.shift()?.();

    // 3700 from the bottom before, 3700 from the bottom after.
    await waitFor(() => expect(list.scrollTop).toBe(5300));
  });
});
