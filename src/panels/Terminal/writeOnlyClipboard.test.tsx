import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Terminal } from "@xterm/xterm";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WriteOnlyClipboard } from "./writeOnlyClipboard";

const readText = vi.fn(async () => "hunter2");
const writeText = vi.fn(async () => {});

beforeEach(() => {
  readText.mockClear();
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText, writeText } });
});

function terminal(provider?: WriteOnlyClipboard) {
  const term = new Terminal({ allowProposedApi: true });
  term.loadAddon(new ClipboardAddon(undefined, provider));
  const replies: string[] = [];
  term.onData((d) => replies.push(d));
  const send = (data: string) => new Promise<void>((done) => term.write(data, done));
  return { send, replies };
}

const settle = () => new Promise((done) => setTimeout(done, 20));

describe("OSC 52 in a terminal tab", () => {
  it("answers a clipboard query with nothing", async () => {
    const { send, replies } = terminal(new WriteOnlyClipboard());
    await send("\x1b]52;c;?\x07");
    await settle();
    expect(readText).not.toHaveBeenCalled();
    expect(replies.join("")).not.toContain(btoa("hunter2"));
  });

  it("would hand the clipboard over with the addon's own provider", async () => {
    const { send, replies } = terminal();
    await send("\x1b]52;c;?\x07");
    await settle();
    expect(replies.join("")).toContain(btoa("hunter2"));
  });

  it("still lets a program set the clipboard", async () => {
    const { send } = terminal(new WriteOnlyClipboard());
    await send(`\x1b]52;c;${btoa("copied over ssh")}\x07`);
    await settle();
    expect(writeText).toHaveBeenCalledWith("copied over ssh");
  });
});
