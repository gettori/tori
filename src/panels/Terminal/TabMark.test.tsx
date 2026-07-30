import { describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import TabMark from "./TabMark";
import type { SessionStatus } from "../../utils/sessionStatus";

/** The mark's own element, which carries the state classes. */
function mark(status: SessionStatus | null) {
  const { container } = render(() => <TabMark agentId="claude" status={status} />);
  return container.firstElementChild as HTMLElement;
}

/** CSS modules hash class names, so the states are compared by *difference*
 *  rather than by literal name: what matters is that two states do not render
 *  identically, not what the generated string is. */
const classes = (status: SessionStatus | null) => mark(status).className;

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
