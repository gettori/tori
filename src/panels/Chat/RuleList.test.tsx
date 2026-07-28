import { describe, it, expect, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import RuleList, { RULES_NEED_HOOKS } from "./RuleList";
import type { ScopedRule } from "../../utils/chatRules";

// Rules ride the `PreToolUse` approval bridge. A harness without that hook has
// no rules and no way to gain any, so the question this file answers is what
// the panel does about it: explain, or offer controls that write a file nothing
// reads.

const RULES: ScopedRule[] = [
  { tool: "Write", kind: "allow", scope: "project", prefix: null, glob: null, origin: "manual" },
];

function list(over: { hooks?: boolean; rules?: ScopedRule[] } = {}) {
  return (
    <RuleList
      rules={over.rules ?? RULES}
      hooks={over.hooks ?? true}
      onRemove={vi.fn()}
      onRestrict={vi.fn()}
    />
  );
}

describe("RuleList without hook support", () => {
  it("explains itself instead of rendering controls that could not work", () => {
    const { container } = render(() => list({ hooks: false }));
    expect(container.textContent).toContain(RULES_NEED_HOOKS);
    // Not a dimmed form: a disabled Add button leaves the user to work out why
    // on their own, and "No rules for this chat" would be indistinguishable
    // from a supported session that simply has none yet.
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("says nothing about hooks when the harness has them", () => {
    const { container } = render(() => list({ hooks: true }));
    expect(container.textContent).not.toContain(RULES_NEED_HOOKS);
    expect(container.querySelector("button")).not.toBeNull();
  });

  // The explanation must not be reachable by having no rules yet: that is a
  // normal state of a fully supported session.
  it("keeps an empty supported list distinct from an unsupported one", () => {
    const { container } = render(() => list({ hooks: true, rules: [] }));
    expect(container.textContent).toContain("No rules for this chat");
    expect(container.textContent).not.toContain(RULES_NEED_HOOKS);
  });

  // The tier is derived from the resolved adapter, which can arrive after this
  // panel mounts. Reading the prop in the component body would freeze whichever
  // branch was true first, leaving a hook-capable session permanently told it
  // has no hook - a static render passes either way, so this drives the change.
  it("follows the tier when it resolves after mount", () => {
    const [hooks, setHooks] = createSignal(false);
    const { container } = render(() => (
      <RuleList rules={RULES} hooks={hooks()} onRemove={vi.fn()} onRestrict={vi.fn()} />
    ));
    expect(container.textContent).toContain(RULES_NEED_HOOKS);

    setHooks(true);
    expect(container.textContent).not.toContain(RULES_NEED_HOOKS);
    expect(container.querySelector("button")).not.toBeNull();
  });
});
