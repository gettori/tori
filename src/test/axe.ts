// The accessibility gate for the `dom` vitest project (see vitest.config.ts).
//
// axe-core wrapped directly rather than through `vitest-axe`, which has been
// abandoned since 2022 at 0.1.0.
//
// ## Why this fails on `incomplete` as well as on `violations`
//
// axe returns four arrays, and the interesting one here is `incomplete` (axe's
// own term is "review items"): nodes it could neither definitively pass nor
// definitively fail. jsdom is exactly the environment that produces them,
// because it has no paint and no layout, and because vitest stubs CSS Module
// imports to the empty string, so components render entirely unstyled and jsdom
// resolves no `var()` (the same reason the token layer is checked by
// scripts/check-tokens.mjs rather than by a test).
//
// A helper that asserted only on `violations` would therefore report green for
// every rule that silently *did not run*, which is the failure mode a jsdom a11y
// gate is most likely to have and the least likely to notice. So an unresolved
// result is a failure here: either the rule is genuinely unjudgeable under jsdom
// and belongs in the disabled list below with a reason, or the assertion needs
// to move somewhere that has a real browser. What is not allowed is a rule
// quietly not running while the suite reports success.
//
// With the tag filter and the disabled list below, `incomplete` is empty for
// real component markup, so this is a usable rule rather than constant noise.
//
// ## Scope: which element to pass
//
//   * **Inline components** - pass the `container` from `@solidjs/testing-library`'s
//     `render`.
//   * **Anything portalled** - pass `document.body`. A `<Portal>` mounts to the
//     body, which is a *sibling* of `container`, not a descendant, so a
//     container-scoped run would audit an empty div and pass. Dialogs, Popover,
//     Omnibox, Toasts and ShortcutSheet are all in this category, and they are
//     the components whose accessibility matters most. `src/test/domSetup.ts`
//     unmounts between tests, so a body-scoped run sees only the current test.
import axe, { type NodeResult, type Result, type RunOptions } from "axe-core";

/** What axe can be pointed at: a mounted element, or `document.body` for
 *  portalled content. */
export type AxeScope = Element | Document;

/** The standards this gate holds code to. `best-practice` is deliberately
 *  excluded, so a failure here is an accessibility defect rather than a style
 *  opinion; a caller that wants more can pass `runOnly` in its overrides. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

// Rules jsdom cannot answer, and what each one actually does here. All three are
// in the tag set above, so without this they would look like coverage while
// being incapable of producing a result. Measured against axe-core 4.13 under
// jsdom 30, not assumed:
//
//   * `color-contrast` - lands in `incomplete` ("element's background color
//     could not be determined"). There is no paint, and CSS Modules are stubbed
//     to the empty string, so there is no colour to measure. Contrast is gated
//     instead by src/theme/contrast.ts + admit(), which measures every role
//     against the surface it declares.
//   * `link-in-text-block` - never matches (`inapplicable`), even given a real
//     inline link inside a paragraph of text. It is a `cat.color` rule and
//     decides distinguishability from computed colours, which are absent.
//   * `scrollable-region-focusable` - never matches (`inapplicable`), even given
//     `overflow: auto` around overflowing content, because "is this scrollable"
//     is a question about layout and jsdom reports no scroll geometry.
//
// This is the *known* blind set, not a proof of completeness: any other rule
// jsdom cannot judge shows up as an `incomplete` failure, which is the point of
// failing on `incomplete` at all. When one does, add it here with its reason.
const JSDOM_BLIND_RULES: NonNullable<RunOptions["rules"]> = {
  "color-contrast": { enabled: false },
  "link-in-text-block": { enabled: false },
  "scrollable-region-focusable": { enabled: false },
};

// axe keeps global run state and rejects a second `run` while one is in flight,
// so concurrent callers (a `Promise.all` over several scopes, or
// `describe.concurrent`) would fail on axe's internals rather than on the
// markup. Runs are queued instead. The chain never rejects, so one failing run
// cannot wedge the ones behind it.
let queue: Promise<void> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Run axe over `scope` and return **both** halves of what it found:
 *  `violations` are definite failures, `incomplete` are rules that produced no
 *  answer. A caller that reads only `violations` has the same blind spot this
 *  module exists to close, so prefer `expectNoAxeViolations` unless the test is
 *  specifically about which rule fired. `overrides` are
 *  merged over the defaults, except that the jsdom-blind rules are re-applied
 *  last and cannot be turned back on (see `JSDOM_BLIND_RULES`). */
export async function runAxe(
  scope: AxeScope,
  overrides: RunOptions = {},
): Promise<{ violations: Result[]; incomplete: Result[] }> {
  const options: RunOptions = {
    runOnly: { type: "tag", values: TAGS },
    ...overrides,
    // Per-key merge, and the blind set wins. A shallow `...overrides` would let
    // any caller overriding a single unrelated rule drop the whole disabled
    // list, and axe's `rules` option can enable rules outside `runOnly`, so
    // re-enabling `color-contrast` is otherwise one keystroke away.
    rules: { ...overrides.rules, ...JSDOM_BLIND_RULES },
  };

  const results = await serialized(() => axe.run(scope, options));
  return { violations: results.violations, incomplete: results.incomplete };
}

/** Assert `scope` has no accessibility violations, and that no rule failed to
 *  produce an answer. See the module comment for which element to pass. */
export async function expectNoAxeViolations(
  scope: AxeScope,
  overrides: RunOptions = {},
): Promise<void> {
  const { violations, incomplete } = await runAxe(scope, overrides);
  const message = formatAxeFailure(violations, incomplete);
  if (message === null) return;

  const error = new Error(message);
  // Point the failure at the assertion's own line. Without this, vitest reports
  // every failure at the `throw` below, so a test file with several assertions
  // names this helper instead of the one that failed.
  captureStackTrace(error, expectNoAxeViolations);
  throw error;
}

/** The failure text for a set of results, or `null` when there is nothing to
 *  report. Separated from the assertion so both branches are testable without
 *  having to find markup that makes a given axe rule indeterminate. */
export function formatAxeFailure(
  violations: Result[],
  incomplete: Result[],
): string | null {
  if (violations.length === 0 && incomplete.length === 0) return null;

  const parts: string[] = [];
  if (violations.length > 0) {
    parts.push(
      `axe found ${count(violations.length, "accessibility violation")}:\n` +
        violations.map(ruleReport).join("\n"),
    );
  }
  if (incomplete.length > 0) {
    parts.push(
      `axe could not judge ${count(incomplete.length, "rule")} under jsdom:\n` +
        incomplete.map(ruleReport).join("\n") +
        "\n\nA rule that cannot produce an answer is not coverage. Either disable " +
        "it in src/test/axe.ts with a reason, or assert it somewhere with a real " +
        "browser.",
    );
  }
  return parts.join("\n\n");
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function ruleReport(result: Result): string {
  const heading = `  [${result.id}] ${result.help} (impact: ${result.impact ?? "unknown"})`;
  return [heading, ...result.nodes.map(nodeReport)].join("\n");
}

// Deliberately not "at <selector>": that is stack-frame syntax, and a message
// body whose lines look like frames is misread by both eyes and tooling.
function nodeReport(n: NodeResult): string {
  return `    element: ${n.target.join(" ")}\n      ${n.html}`;
}

// `Error.captureStackTrace` is V8-only and this project does not depend on
// @types/node, so it is reached through a narrow local type rather than `any`.
function captureStackTrace(error: Error, from: (...args: never[]) => unknown) {
  const withCapture = Error as unknown as {
    captureStackTrace?: (target: object, constructorOpt?: unknown) => void;
  };
  withCapture.captureStackTrace?.(error, from);
}
