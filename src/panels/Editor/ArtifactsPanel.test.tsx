import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "../../test/harness";

const ROOT = "/cfg/chats/c1";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  answer: { made: [] as unknown[], added: [] as unknown[] },
  reply: null as (() => Promise<unknown>) | null,
  listeners: {} as Record<string, ((e: { payload: unknown }) => void)[]>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "chat_artifacts") return bridge.reply ? bridge.reply() : Promise.resolve(bridge.answer);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    (bridge.listeners[name] ??= []).push(fn);
    return Promise.resolve(() => {});
  },
}));

const { default: ArtifactsPanel } = await import("./ArtifactsPanel");
const { onWith, OPEN_IN_EDITOR } = await import("../../utils/events");

const file = (path: string, size: number) => ({ path, name: path.split("/").pop(), size, modified: 1 });
const lists = () => bridge.calls.filter((c) => c.cmd === "chat_artifacts").length;

beforeEach(() => {
  bridge.calls.length = 0;
  bridge.listeners = {};
  bridge.answer = { made: [], added: [] };
  bridge.reply = null;
});

function hold() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}

describe("ArtifactsPanel", () => {
  it("lists what the chat made and what was added, and opens a row as a file tab", async () => {
    bridge.answer = {
      made: [file(`${ROOT}/plan.md`, 1200), file(`${ROOT}/rows.csv`, 2_200_000)],
      added: [file("/cfg/attachments/h1/brief.pdf", 30)],
    };
    render(() => <ArtifactsPanel chatId="c1" root={ROOT} />);
    const made = await screen.findByRole("list", { name: "Made in this chat" });
    expect(made.textContent).toContain("plan.md");
    expect(made.textContent).toContain("Markdown · 1.2 KB");
    expect(made.textContent).toContain("CSV · 2.1 MB");
    expect(screen.getByRole("list", { name: "Added by you" }).textContent).toContain("brief.pdf");

    const opened: string[] = [];
    const off = onWith<{ path: string }>(OPEN_IN_EDITOR, ({ path }) => opened.push(path));
    fireEvent.click(screen.getByText("plan.md"));
    off();
    expect(opened).toEqual([`${ROOT}/plan.md`]);
  });

  it("re-lists when the chat's folder changes, and only then", async () => {
    render(() => <ArtifactsPanel chatId="c1" root={ROOT} />);
    await screen.findByText("Nothing here yet");
    await waitFor(() => expect(bridge.listeners["fs://changed"]?.length).toBe(1));
    const before = lists();

    const fire = (root: string) => bridge.listeners["fs://changed"][0]({ payload: { root, paths: [`${root}/x`] } });
    fire("/w/api");
    bridge.answer = { made: [file(`${ROOT}/notes.txt`, 5)], added: [] };
    fire(ROOT);
    await screen.findByText("notes.txt");
    expect(lists()).toBe(before + 1);
  });

  it("says nothing is here while the first list is read, then lists it", async () => {
    const first = hold();
    bridge.reply = () => first.promise;
    const { container } = render(() => <ArtifactsPanel chatId="c1" root={ROOT} />);
    expect(await screen.findByText("Nothing here yet")).toBeTruthy();
    expect(container.querySelector("[data-artifacts]")?.textContent).toContain("Artifacts0");

    first.resolve({ made: [file(`${ROOT}/plan.md`, 10)], added: [] });
    expect(await screen.findByText("plan.md")).toBeTruthy();
    expect(screen.queryByText("Nothing here yet")).toBeNull();
  });

  it("keeps the rows and the count while a folder change is listed again", async () => {
    bridge.answer = { made: [file(`${ROOT}/plan.md`, 10)], added: [] };
    const { container } = render(() => <ArtifactsPanel chatId="c1" root={ROOT} />);
    await screen.findByText("plan.md");
    await waitFor(() => expect(bridge.listeners["fs://changed"]?.length).toBe(1));
    const before = lists();

    const again = hold();
    bridge.reply = () => again.promise;
    bridge.listeners["fs://changed"][0]({ payload: { root: ROOT, paths: [`${ROOT}/x`] } });
    await waitFor(() => expect(lists()).toBe(before + 1));
    expect(screen.getByText("plan.md")).toBeTruthy();
    expect(container.querySelector("[data-artifacts]")?.textContent).toContain("Artifacts1");

    again.resolve({ made: [file(`${ROOT}/plan.md`, 10), file(`${ROOT}/notes.txt`, 5)], added: [] });
    expect(await screen.findByText("notes.txt")).toBeTruthy();
    expect(container.querySelector("[data-artifacts]")?.textContent).toContain("Artifacts2");
  });

  it("says the list could not be read instead of claiming nothing is here, and tries again", async () => {
    bridge.reply = () => Promise.reject("folder is gone");
    render(() => <ArtifactsPanel chatId="c1" root={ROOT} />);
    expect(await screen.findByText("The artifacts could not be listed")).toBeTruthy();
    expect(screen.getByText("folder is gone")).toBeTruthy();
    expect(screen.queryByText("Nothing here yet")).toBeNull();

    bridge.reply = null;
    bridge.answer = { made: [file(`${ROOT}/plan.md`, 10)], added: [] };
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("plan.md")).toBeTruthy();
  });
});
