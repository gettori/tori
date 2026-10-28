import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render } from "@solidjs/testing-library";

const speak = vi.hoisted(() => vi.fn(async (_o: { text: string }) => ({ success: true, utteranceId: "u1" })));
vi.mock("tauri-plugin-tts-api", () => ({
  MAX_TEXT_LENGTH: 10_000,
  isTtsError: () => false,
  onSpeechEvent: async () => () => {},
  getVoices: async () => [],
  speak,
  stop: async () => {},
}));
vi.mock("../panels/Settings/settingsStore", () => ({
  settings: { speech: { rate: 1, voice: null } },
  saveSettings: async () => {},
}));

const { emit, READ_LAST_REPLY, READ_SELECTION } = await import("./events");
const { heldSelection, holdSelection } = await import("../components/SelectionToolbar/SelectionToolbar");
const { offerLastReply } = await import("./speech");
const { watchReadAloud } = await import("./readAloud");

function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
}

const page = () =>
  render(() => (
    <div>
      <p>a transcript line</p>
      <textarea aria-label="Composer">a draft</textarea>
    </div>
  ));

beforeEach(() => {
  speak.mockClear();
  watchReadAloud();
});
afterEach(() => document.getSelection()?.removeAllRanges());

describe("read aloud from the palette", () => {
  it("reads the selection held when the palette opened, after focus took it", async () => {
    const { getByText } = page();
    select(getByText("a transcript line"));
    holdSelection();
    document.getSelection()!.removeAllRanges();

    emit(READ_SELECTION);
    await vi.waitFor(() => expect(speak).toHaveBeenCalled());
    expect(speak.mock.calls[0][0].text).toBe("a transcript line");
  });

  it("holds nothing for a selection in the composer", () => {
    const { getByLabelText } = page();
    select(getByLabelText("Composer"));
    holdSelection();
    expect(heldSelection()).toBe("");
  });

  it("hands Read Last Reply to the chat that offered it", () => {
    const readLast = vi.fn();
    const withdraw = offerLastReply(readLast);
    emit(READ_LAST_REPLY);
    expect(readLast).toHaveBeenCalledTimes(1);
    withdraw();
  });
});
