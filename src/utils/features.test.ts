import { describe, expect, it } from "vitest";
import { featureSlug, memberInitials, memberState } from "./features";

// The slug is what every member's branch is named after, so the frontend and
// backend rules have to agree character for character: these cases mirror
// `features::tests::slug_lowercases_collapses_and_rejects_empty`.
describe("featureSlug", () => {
  it("matches the backend rule", () => {
    expect(featureSlug("Auth Flow")).toBe("auth-flow");
    expect(featureSlug("  Payments!!  v2 ")).toBe("payments-v2");
    expect(featureSlug("keep_dots.and-dashes")).toBe("keep_dots.and-dashes");
  });

  it("is empty when nothing usable remains", () => {
    expect(featureSlug("!!!")).toBe("");
    expect(featureSlug("")).toBe("");
  });
});

describe("memberInitials", () => {
  it("takes the first letters of the first two words", () => {
    expect(memberInitials({ displayName: "Backend API", repoPath: "/r/x" })).toBe("BA");
    expect(memberInitials({ displayName: "web", repoPath: "/r/x" })).toBe("W");
    expect(memberInitials({ displayName: "saga-frontend", repoPath: "/r/x" })).toBe("SF");
  });

  it("falls back to the repo basename", () => {
    expect(memberInitials({ displayName: "  ", repoPath: "/Users/a/Projects/net_check" })).toBe("NC");
    expect(memberInitials({ displayName: "", repoPath: "" })).toBe("");
  });
});

describe("memberState", () => {
  it("only a present member is usable", () => {
    expect(memberState({ kind: "present" })).toMatchObject({ usable: true, action: null });
    expect(memberState({ kind: "worktree-missing" })).toMatchObject({ usable: false, action: "recreate" });
    expect(memberState({ kind: "repo-missing" })).toMatchObject({ usable: false, action: "locate" });
  });

  it("distinguishes a pending creation from a real failure", () => {
    expect(memberState({ kind: "failed", reason: "pending" })).toMatchObject({ label: "Creating", action: null });
    expect(memberState({ kind: "failed", reason: "index.lock exists" })).toMatchObject({
      label: "Failed",
      action: "retry",
      reason: "index.lock exists",
    });
  });
});
