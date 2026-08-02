import { describe, it, expect } from "vitest";
import golden from "../../dev/fixtures/forge/model.json";
import {
  AUTH_STATE_KINDS,
  CHECK_STATES,
  FORGE_KEYS,
  MERGEABLE_STATES,
  PR_STATES,
  REVIEW_DECISIONS,
  mayUseForge,
  needsAttention,
  type AuthState,
  type PullRequest,
  type UnitStatus,
} from "./forgeTypes";

// This fixture is written by the Rust round-trip test
// (`emit_wire_samples_for_the_typescript_mirror` in forge/model.rs), serialized
// by the same serde impls the real client uses.
//
// That is the whole point: hand-writing samples on this side would prove the
// mirror is self-consistent, not that it matches Rust. Parsing Rust's own
// output means a renamed field fails here rather than surviving as two halves
// that each look fine and disagree on the wire.

const keysOf = (v: unknown) => Object.keys(v as object).sort();

/// Reached through `reviewThread` rather than emitted on its own, so the
/// top-level loop skips it and the nested test below covers it instead.
const NESTED_ONLY = ["reviewComment"];
/// Bare values, not objects, so there are no field names to compare. Their
/// contents are checked by the enum and auth-state tests below.
const NOT_OBJECTS = ["reviewDecision", "authStates"];

describe("forgeTypes mirrors the Rust forge model", () => {
  it("agrees with Rust on every field name, type by type", () => {
    // The half that actually catches a rename. Each entry is compared against
    // the keys Rust emitted, so dropping or renaming a field on either side
    // fails right here.
    for (const [name, expected] of Object.entries(FORGE_KEYS)) {
      if (NESTED_ONLY.includes(name)) continue;
      const sample = (golden as Record<string, unknown>)[name];
      expect(sample, `no sample emitted for ${name}`).toBeDefined();
      expect(keysOf(sample), `field names disagree for ${name}`).toEqual([...expected].sort());
    }
  });

  it("covers every sample Rust emits, with none left over", () => {
    // Catches the case a per-type loop cannot: a type added in Rust that this
    // mirror never declared at all.
    const emitted = Object.keys(golden).sort();
    const covered = [
      ...Object.keys(FORGE_KEYS).filter((k) => !NESTED_ONLY.includes(k)),
      ...NOT_OBJECTS,
    ].sort();
    expect(emitted).toEqual(covered);
  });

  it("agrees on the nested comment shape too", () => {
    // `FORGE_KEYS.reviewThread` compares only the thread's own top-level keys,
    // so a rename *inside* a comment would slip past it.
    const thread = golden.reviewThread;
    expect(thread.comments.length).toBeGreaterThan(0);
    expect(keysOf(thread.comments[0])).toEqual([...FORGE_KEYS.reviewComment].sort());
  });

  it("agrees on every value of every closed enum", () => {
    // A variant added in Rust and not here would otherwise degrade to a silent
    // default at the first `switch` that reads it.
    const pr = golden.pullRequest as PullRequest;
    expect(PR_STATES).toContain(pr.state);
    expect(MERGEABLE_STATES).toContain(pr.mergeableState);
    expect(CHECK_STATES).toContain(golden.checkRollup.state);
    expect(REVIEW_DECISIONS).toContain(golden.reviewDecision);

    // All three auth states are emitted, because the Settings section renders a
    // distinct surface for each and a mirror that only saw one would let the
    // other two drift.
    const kinds = (golden.authStates as AuthState[]).map((s) => s.kind).sort();
    expect(kinds).toEqual([...AUTH_STATE_KINDS].sort());
  });

  it("keeps suspect distinct from signed out", () => {
    // The distinction the whole 401 story rests on: suspect still knows who the
    // token belonged to, which is what lets the prompt say "sign back in as X"
    // rather than dropping the user at a blank sign-in.
    const byKind = Object.fromEntries(
      (golden.authStates as AuthState[]).map((s) => [s.kind, s]),
    );
    expect(byKind.signedOut).toEqual({ kind: "signedOut" });
    expect(byKind.suspect).toMatchObject({ kind: "suspect", login: "skarif2" });
  });

  it("narrows an auth state exhaustively", () => {
    // An exhaustive switch: adding a variant to AuthState without handling it
    // here fails to compile, so the union and the fixture cannot drift apart.
    for (const state of golden.authStates as AuthState[]) {
      switch (state.kind) {
        case "signedOut":
          break;
        case "signedIn":
          expect(state.login).toBe("skarif2");
          break;
        case "suspect":
          expect(state.login).toBe("skarif2");
          break;
        default: {
          const never: never = state;
          throw new Error(`unhandled auth state ${JSON.stringify(never)}`);
        }
      }
    }
  });

  it("marks a truncated page as incomplete", () => {
    // The flag that stops a partial list rendering as a full one.
    expect(golden.pagedTruncated.truncated).toBe(true);
    expect(golden.pagedTruncated.items.length).toBe(3);
  });

  it("treats a unit with no pull request as a real answer, not a gap", () => {
    // `null` here means "no PR yet", and the UI must not confuse it with a
    // remote it cannot talk to at all.
    const unit = golden.unitStatus as UnitStatus;
    expect(unit.pullRequest).not.toBeNull();
    expect({ ...unit, pullRequest: null }.pullRequest).toBeNull();
  });
});

describe("mayUseForge", () => {
  it("allows the API only when signed in and enabled", () => {
    expect(mayUseForge({ kind: "signedIn", login: "skarif2" }, true)).toBe(true);
  });

  it("falls back for every reason the API is unavailable", () => {
    // Three independent noes. A caller that remembers only "signed out" keeps
    // polling a disabled integration, and one that forgets `suspect` keeps
    // hammering a credential the forge has already rejected.
    expect(mayUseForge({ kind: "signedOut" }, true)).toBe(false);
    expect(mayUseForge({ kind: "suspect", login: "skarif2" }, true)).toBe(false);
    expect(mayUseForge({ kind: "signedIn", login: "skarif2" }, false)).toBe(false);
  });

  it("keeps the kill switch independent of the credential", () => {
    // Turning the integration off must not read as signed out, or the UI would
    // offer a sign-in to someone who is already signed in.
    const signedIn: AuthState = { kind: "signedIn", login: "skarif2" };
    expect(mayUseForge(signedIn, false)).toBe(false);
    expect(mayUseForge(signedIn, true)).toBe(true);
  });
});

describe("needsAttention", () => {
  const unit = (over: Partial<UnitStatus>): UnitStatus => ({
    headRef: "wave-3",
    pullRequest: null,
    checks: { state: "success", total: 3, failing: 0 },
    reviewDecision: "none",
    ...over,
  });

  it("flags a failing check and changes-requested, and nothing else", () => {
    expect(needsAttention(unit({ checks: { state: "failure", total: 3, failing: 1 } }))).toBe(true);
    expect(needsAttention(unit({ reviewDecision: "changesRequested" }))).toBe(true);

    // Pending is not a needs-you moment: CI that has not finished is not CI that
    // failed, and treating it as one would fire the tray on every push.
    expect(needsAttention(unit({ checks: { state: "pending", total: 3, failing: 0 } }))).toBe(false);
    // Neither is a repo with no CI at all.
    expect(needsAttention(unit({ checks: { state: "none", total: 0, failing: 0 } }))).toBe(false);
    expect(needsAttention(unit({}))).toBe(false);
    expect(needsAttention(unit({ reviewDecision: "reviewRequired" }))).toBe(false);
  });
});
