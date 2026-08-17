import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import FastModeStatus from "./FastModeStatus";

describe("FastModeStatus", () => {
  it("shows the agent's reason rather than a toggle that cannot move", () => {
    // The measured state on this transport, by both routes a toggle could take
    // (claude 2.1.220): `set_fast_mode` comes back as an unsupported subtype,
    // and the `/fast` slash command - which *is* in the catalogue - answers
    // "not available in the Agent SDK". See the component's docstring and
    // `dev/fixtures/claude/fast-mode.jsonl`.
    const { container } = render(() => <FastModeStatus state="off" reason="sdk_opt_in_required" />);
    expect(container.textContent).toBe("Fast mode off: not available to this kind of session");
    // The thing this component exists to not be.
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("passes through a reason it does not have wording for", () => {
    const { container } = render(() => <FastModeStatus state="off" reason="some_new_reason" />);
    expect(container.textContent).toContain("some_new_reason");
  });

  it("says off without a colon when no reason is given", () => {
    const { container } = render(() => <FastModeStatus state="off" reason={null} />);
    expect(container.textContent).toBe("Fast mode off");
  });

  it("reports fast mode on if a later CLI ever enables it here", () => {
    const { container } = render(() => <FastModeStatus state="on" reason={null} />);
    expect(container.textContent).toBe("Fast mode on");
  });

  it("renders nothing for a session that never reported a state", () => {
    const { container } = render(() => <FastModeStatus state={null} reason={null} />);
    expect(container.textContent).toBe("");
  });
});
