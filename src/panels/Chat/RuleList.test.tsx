import { describe, it, expect, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import RuleList, { RULES_NEED_HOOKS, RULES_NEED_THE_GATE } from "./RuleList";
import type { ScopedRule } from "../../utils/chatRules";

// Rules only mean something while Sway's own gate is deciding this session's
// tool calls, which is now the exception rather than the rule: the harness asks
// for itself unless the legacy gate is turned back on. So the question this file
// answers is what the panel does when nothing would read what it writes -
// explain, or offer controls that go nowhere - and whether it explains the right
// one of the two reasons.

const RULES: ScopedRule[] = [
  { tool: "Write", kind: "allow", scope: "project", prefix: null, glob: null, origin: "manual" },
];

function list(over: { gated?: boolean; whyNot?: string; rules?: ScopedRule[] } = {}) {
  return (
    <RuleList
      rules={over.rules ?? RULES}
      gated={over.gated ?? true}
      whyNot={over.whyNot ?? RULES_NEED_THE_GATE}
      onRemove={vi.fn()}
      onRestrict={vi.fn()}
    />
  );
}

describe("RuleList when Sway is not the one gating", () => {
  it("explains itself instead of rendering controls that could not work", () => {
    const { container } = render(() => list({ gated: false }));
    expect(container.textContent).toContain(RULES_NEED_THE_GATE);
    // Not a dimmed form: a disabled Add button leaves the user to work out why
    // on their own, and "No rules for this chat" would be indistinguishable
    // from a gated session that simply has none yet.
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  // Two reasons, two sentences, because they have different remedies: one is a
  // setting the user can turn on, the other is a harness that cannot be gated at
  // all. Telling a Claude session it has no approval hook would send the user
  // looking for a capability rather than for a switch.
  it("names the reason it was given rather than one of its own", () => {
    const gate = render(() => list({ gated: false, whyNot: RULES_NEED_THE_GATE }));
    expect(gate.container.textContent).toContain("Settings");
    expect(gate.container.textContent).not.toContain(RULES_NEED_HOOKS);

    const noHook = render(() => list({ gated: false, whyNot: RULES_NEED_HOOKS }));
    expect(noHook.container.textContent).toContain(RULES_NEED_HOOKS);
    expect(noHook.container.textContent).not.toContain(RULES_NEED_THE_GATE);
  });

  it("says nothing about any of that while Sway is gating", () => {
    const { container } = render(() => list({ gated: true }));
    expect(container.textContent).not.toContain(RULES_NEED_THE_GATE);
    expect(container.textContent).not.toContain(RULES_NEED_HOOKS);
    expect(container.querySelector("button")).not.toBeNull();
  });

  // The explanation must not be reachable by having no rules yet: that is a
  // normal state of a fully gated session.
  it("keeps an empty gated list distinct from an ungated one", () => {
    const { container } = render(() => list({ gated: true, rules: [] }));
    expect(container.textContent).toContain("No rules for this chat");
    expect(container.textContent).not.toContain(RULES_NEED_THE_GATE);
  });

  // The tier is derived from the resolved adapter, which can arrive after this
  // panel mounts. Reading the prop in the component body would freeze whichever
  // branch was true first, leaving a gated session permanently told it is not -
  // a static render passes either way, so this drives the change.
  it("follows the tier when it resolves after mount", () => {
    const [gated, setGated] = createSignal(false);
    const { container } = render(() => (
      <RuleList
        rules={RULES}
        gated={gated()}
        whyNot={RULES_NEED_THE_GATE}
        onRemove={vi.fn()}
        onRestrict={vi.fn()}
      />
    ));
    expect(container.textContent).toContain(RULES_NEED_THE_GATE);

    setGated(true);
    expect(container.textContent).not.toContain(RULES_NEED_THE_GATE);
    expect(container.querySelector("button")).not.toBeNull();
  });
});
