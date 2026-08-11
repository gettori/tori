// Tests for the accessibility gate itself (src/test/axe.ts).
//
// The helper is the thing every component test will lean on, so it needs its own
// proof that it can fail. A harness that reports "no violations" because it
// never really looked is worse than no harness, since it reads as coverage.
import { describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import axe, { type Result } from "axe-core";
import {
  runAxe,
  expectNoAxeViolations,
  formatAxeFailure,
} from "./axe";

/** A button with a real accessible name: nothing for the gate to find. */
function labeled() {
  const { container } = render(() => (
    <button type="button">Save changes</button>
  ));
  return container;
}

/** An icon-only button with no accessible name. Raw markup on purpose: the
 *  `Button` and `IconButton` components backfill a name from `title` and warn in
 *  DEV, so neither can produce this defect. */
function unlabeledIconButton() {
  const { container } = render(() => (
    <button type="button">
      <svg width="16" height="16" viewBox="0 0 16 16">
        <path d="M0 0h16v16H0z" />
      </svg>
    </button>
  ));
  return container;
}

describe("the axe gate", () => {
  it("passes a control that has an accessible name", async () => {
    await expectNoAxeViolations(labeled());
  });

  it("finds a control that has none", async () => {
    const { violations } = await runAxe(unlabeledIconButton());
    expect(violations.map((v) => v.id)).toContain("button-name");
  });

  it("fails the assertion, naming the rule and the element", async () => {
    const error = await expectNoAxeViolations(unlabeledIconButton()).then(
      () => null,
      (e: Error) => e,
    );
    expect(error).not.toBeNull();
    expect(error?.message).toContain("button-name");
    expect(error?.message).toContain("<button");
    expect(error?.message).toContain("accessibility violation");
  });

  // The reason this helper exists in the shape it does. `aria-hidden-focus` is a
  // real WCAG A rule that jsdom cannot resolve, so axe files it under
  // `incomplete` rather than either passing or failing it. Reading only
  // `violations` would call this markup clean.
  it("fails on a rule it could not resolve, rather than calling it a pass", async () => {
    const { container } = render(() => (
      <div aria-hidden="true">
        <button type="button">reachable inside aria-hidden</button>
      </div>
    ));

    const { violations, incomplete } = await runAxe(container);
    expect(violations).toHaveLength(0);
    expect(incomplete.map((v) => v.id)).toContain("aria-hidden-focus");

    const error = await expectNoAxeViolations(container).then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toContain("could not judge");
    expect(error?.message).toContain("aria-hidden-focus");
  });

  it("says nothing when there is nothing to say", () => {
    expect(formatAxeFailure([], [])).toBeNull();
  });

  // Both halves of the override contract in one fixture, which is why it carries
  // two rule keys: with a single key, a shallow merge and a per-key merge are
  // indistinguishable.
  it("lets an override add a rule but not re-enable a jsdom-blind one", async () => {
    const { container } = render(() => (
      <div>
        <p>Body copy for colour-contrast to be pointed at.</p>
        <h2 />
      </div>
    ));

    const { violations, incomplete } = await runAxe(container, {
      rules: {
        // Outside the WCAG tag set (best-practice), so this proves the override
        // reached axe at all.
        "empty-heading": { enabled: true },
        // And this proves it cannot undo the disabled list.
        "color-contrast": { enabled: true },
      },
    });

    expect(violations.map((v) => v.id)).toContain("empty-heading");
    const seen = [...violations, ...incomplete].map((v) => v.id);
    expect(seen).not.toContain("color-contrast");
  });

  // axe rejects a second `run` while one is in flight, so the helper queues.
  // Without that, this is how a test file discovers axe's internals.
  it("queues concurrent runs instead of colliding", async () => {
    const scopes = [labeled(), labeled(), labeled()];
    await Promise.all(scopes.map((s) => expectNoAxeViolations(s)));
  });

  it("blames the failing assertion, not the helper", async () => {
    const error = await expectNoAxeViolations(unlabeledIconButton()).then(
      () => null,
      (e: Error) => e,
    );
    // The message is multi-line, so the frames start after it rather than at a
    // fixed offset.
    const stack = error?.stack ?? "";
    const frames = stack
      .slice(stack.indexOf(error?.message ?? "") + (error?.message.length ?? 0))
      .split("\n")
      .filter((line) => /^\s*at /.test(line));
    // A stack whose top frame is inside the helper makes every assertion in a
    // file report the same line, which is the ergonomic problem a custom vitest
    // matcher would otherwise have solved.
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).not.toContain("test/axe.ts");
    expect(frames[0]).toContain("axe.test.tsx");
  });

  // Guards the module comment's claim about *why* color-contrast is disabled:
  // if a future jsdom could resolve it, the rationale would need rewriting.
  //
  // The only call that reaches axe directly rather than through the helper,
  // because the helper cannot be made to run a rule the disabled list bans. It
  // therefore skips the serialization queue, which is safe only because vitest
  // runs a file's tests one at a time; do not make this file concurrent.
  it("documents a real gap: axe cannot resolve contrast here", async () => {
    const { container } = render(() => (
      <div>
        <p>Body copy whose contrast axe is asked to judge.</p>
      </div>
    ));
    const raw = await axe.run(container, {
      runOnly: { type: "rule", values: ["color-contrast"] },
    });
    expect(raw.incomplete.map((v: Result) => v.id)).toContain("color-contrast");
    expect(raw.violations).toHaveLength(0);
  });
});
