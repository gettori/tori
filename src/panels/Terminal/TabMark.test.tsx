import { describe, expect, it } from "vite-plus/test";
import { render } from "@solidjs/testing-library";
import TabMark from "./TabMark";
import type { SessionStatus } from "../../utils/sessionStatus";

/** The mark's own element, which carries the state classes. */
function mark(status: SessionStatus | null, certainty?: "exact" | "inferred") {
  const { container } = render(() => (
    <TabMark agentId="claude" status={status} certainty={certainty} />
  ));
  return container.firstElementChild as HTMLElement;
}

/** CSS modules hash class names, so the states are compared by *difference*
 *  rather than by literal name: what matters is that two states do not render
 *  identically, not what the generated string is. */
const classes = (status: SessionStatus | null, certainty?: "exact" | "inferred") =>
  mark(status, certainty).className;

describe("a chat tab's provider mark", () => {
  it("keeps one glyph across idle and working, and changes only its treatment", () => {
    // The shape does not move: a tab going quiet must not look like a tab that
    // changed into something else.
    expect(mark("idle").querySelector("svg")).not.toBeNull();
    expect(mark("executing").querySelector("svg")).not.toBeNull();
    expect(classes("executing")).not.toBe(classes("idle"));
  });

  it("gives waiting-for-approval a shape, not just a colour", () => {
    // Two elements (the glyph and the badge) rather than one: the state that
    // asks something of the user has to survive a greyscale screenshot.
    expect(mark("waitingForApproval").childElementCount).toBe(2);
    expect(mark("executing").childElementCount).toBe(1);
    expect(mark("idle").childElementCount).toBe(1);
  });

  // A budget stop is not a question with a yes, but it blocks the same way and
  // needs a person, so it reads the same in the strip.
  it("reads a budget stop the same way as an approval", () => {
    expect(classes("budgetStopped")).toBe(classes("waitingForApproval"));
  });

  // The tint is the vendor's, so the strip says whose turn is running without
  // reading a label. Keyed on the mark that was actually resolved rather than
  // on the adapter id: a session wearing the fallback brain has no brand to
  // borrow, and a wrong logo's colour is a wrong claim.
  it("names the brand it is tinted with, and only for a mark it resolved", () => {
    const at = (agentId: string) => {
      const { container } = render(() => <TabMark agentId={agentId} status="executing" />);
      return (container.firstElementChild as HTMLElement).getAttribute("data-mark");
    };
    expect(at("claude")).toBe("claude");
    expect(at("gemini")).toBe("gemini");
    expect(at("some-adapter-with-no-logo")).toBeNull();
  });

  // The rest tone and the tint must never both be on the element: the tint is
  // layered and the rest tone is not, so the rest tone would win the cascade
  // and the mark would breathe in grey. That is what the strip did for two days
  // after the tint moved into `agentMarks`.
  it("takes off the rest tone while working, so the tint has nothing to lose to", () => {
    const rest = (status: SessionStatus) =>
      Array.from(mark(status).classList).filter((c) => c.includes("rest"));
    expect(rest("idle").length).toBe(1);
    expect(rest("executing").length).toBe(0);
    expect(rest("waitingForApproval").length).toBe(0);
  });

  it("names only the states worth interrupting a screen reader for", () => {
    expect(mark("executing").getAttribute("aria-label")).toBe("Executing");
    expect(mark("waitingForApproval").getAttribute("aria-label")).toBe("Waiting for approval");
    // Idle is the absence of news; every tab announcing it would bury the one
    // that is asking for something. Still tooltipped, just not announced.
    expect(mark("idle").getAttribute("aria-label")).toBeNull();
    expect(mark("idle").getAttribute("title")).toBe("Idle");
  });

  // A chat tab exists before its panel registers a status. Rendering nothing
  // then would make the strip twitch as every session starts.
  it("renders the resting mark for a tab with no status yet", () => {
    expect(mark(null).querySelector("svg")).not.toBeNull();
    expect(classes(null)).toBe(classes("idle"));
  });
});

// The mark is worn by chat tabs, PTY agent tabs and History's rows now, and
// only one of those knows its status rather than guessing it. The tier is a
// word in the tooltip and nothing more: it used to draw a hairline under a
// measured mark, which read as a rendering fault in a strip of tabs rather than
// as a claim about where the status came from.
describe("the certainty tier a mark claims", () => {
  it("says which side it is in words, and draws nothing either way", () => {
    expect(mark("executing", "exact").getAttribute("title")).toBe("Executing (measured)");
    expect(mark("executing", "inferred").getAttribute("title")).toBe("Executing");
    expect(classes("executing", "exact")).toBe(classes("executing", "inferred"));
  });

  // A caller that forgets is claiming nothing, which is both the safer answer
  // and the rendering every non-chat surface already had.
  it("infers by default rather than claiming a measurement", () => {
    expect(classes("idle")).toBe(classes("idle", "inferred"));
  });

  // The tier is orthogonal to the state: a measured session that is waiting
  // still gets the badge, and an inferred one that is waiting still gets it.
  it("keeps the needs-you badge on both tiers", () => {
    expect(mark("waitingForApproval", "exact").childElementCount).toBe(2);
    expect(mark("waitingForApproval", "inferred").childElementCount).toBe(2);
  });
});
