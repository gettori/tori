import { describe, it, expect, vi } from "vitest";
import { render } from "@solidjs/testing-library";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

const { default: AutopilotPopup } = await import("./AutopilotPopup");
const { default: Markdown } = await import("../../panels/Chat/Markdown");

const n = (x: number) => `#${x}`;

describe("the popup's thread", () => {
  it("draws a reference the autopilot pasted as two links, not raw brackets", () => {
    const text = `Started [${n(212)}](https://github.com/o/tori/issues/212) ([personal -> tori -> y-test](tori://open?folder=/r/personal/tori/wt)).`;
    const { container } = render(() => (
      <AutopilotPopup
        state="idle"
        stateLine="Idle"
        decisions={[]}
        inFlight={[]}
        messages={[{ from: "autopilot", text }]}
        renderReply={(t) => <Markdown text={t} cwd="" />}
      />
    ));
    const links = [...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      [n(212), "https://github.com/o/tori/issues/212"],
      ["personal -> tori -> y-test", "tori://open?folder=/r/personal/tori/wt"],
    ]);
    expect(container.textContent).not.toContain("](");
  });
});
